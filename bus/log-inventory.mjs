// 旧日志 inventory（第 10 项第 13 条）：扫描 bus/logs，判定每个文件归属。
// 铁律：
//   1) 能**可靠**关联 task 的（artifact_refs 已有记录且 sha256 对得上，或路径/内容里只有一个可验证的 task id）
//      才允许 import 成 artifact_refs；
//   2) 关联不可靠的一律标 unmanaged —— **只上报，绝不删除**，本模块没有任何 unlink 调用；
//   3) 符号链接、目录、越界路径不参与（记 skipped）。
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { BUS_DIR, nowIso } from './store.mjs';

const TASK_ID_RE = /\bt-[a-z0-9]{4,}\b/g;
const CONTENT_SCAN_BYTES = 64 * 1024;

function sha256Buffer(buf) { return crypto.createHash('sha256').update(buf).digest('hex'); }

function logsRootOf(options) {
  return path.resolve((options && options.logsDir) || path.join(BUS_DIR, 'logs'));
}

function listFiles(root, limit) {
  const out = [];
  const skipped = [];
  function walk(dir, depth) {
    if (out.length >= limit) return;
    let entries = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (error) {
      skipped.push({ path: dir, reason: 'unreadable', detail: String((error && error.message) || error) });
      return;
    }
    for (const entry of entries) {
      if (out.length >= limit) return;
      const full = path.join(dir, entry.name);
      const resolved = path.resolve(full);
      if (resolved.indexOf(root + path.sep) !== 0) { skipped.push({ path: resolved, reason: 'path_escape' }); continue; }
      if (entry.isSymbolicLink()) { skipped.push({ path: resolved, reason: 'symlink' }); continue; }
      if (entry.isDirectory()) { if (depth < 8) walk(resolved, depth + 1); continue; }
      if (!entry.isFile()) { skipped.push({ path: resolved, reason: 'not_a_file' }); continue; }
      const rel = path.relative(root, resolved).split(path.sep).join('/');
      let st = null;
      try { st = fs.lstatSync(resolved); } catch (error) { skipped.push({ path: resolved, reason: 'stat_failed' }); continue; }
      out.push({ path: resolved, relative_path: rel, bytes: st.size, mtime: new Date(st.mtimeMs).toISOString() });
    }
  }
  walk(root, 0);
  out.sort(function (a, b) { return a.relative_path < b.relative_path ? -1 : 1; });
  return { files: out, skipped: skipped };
}

function taskExists(db, taskId) {
  try { return !!db.prepare('SELECT 1 AS ok FROM tasks WHERE id=?').get(taskId); } catch (error) { return false; }
}

// 内容里出现的 task id：只在"前 64KB、非二进制、且去重后恰好一个"时才认为是可靠关联
function taskIdsInContent(file) {
  let fd = null;
  try {
    fd = fs.openSync(file, 'r');
    const length = Math.min(CONTENT_SCAN_BYTES, fs.fstatSync(fd).size);
    const buf = Buffer.alloc(length);
    fs.readSync(fd, buf, 0, length, 0);
    if (buf.indexOf(0) >= 0) return { ok: false, reason: 'binary' };
    const found = new Set();
    const text = buf.toString('utf8');
    let m;
    TASK_ID_RE.lastIndex = 0;
    while ((m = TASK_ID_RE.exec(text)) !== null) found.add(m[0]);
    return { ok: true, ids: Array.from(found) };
  } catch (error) {
    return { ok: false, reason: 'read_failed' };
  } finally {
    if (fd != null) { try { fs.closeSync(fd); } catch (error) {} }
  }
}

function refsByPath(db) {
  const map = new Map();
  let rows = [];
  try { rows = db.prepare('SELECT task_id, kind, relative_path, sha256, size FROM artifact_refs').all(); } catch (error) { rows = []; }
  for (const row of rows) map.set(String(row.relative_path || ''), row);
  return map;
}

export function buildInventory(db, options) {
  const o = options || {};
  const root = logsRootOf(o);
  const now = typeof o.now === 'string' && o.now ? o.now : nowIso();
  const limit = Number.isSafeInteger(o.limit) && o.limit > 0 ? o.limit : 5000;
  const listing = listFiles(root, limit);
  const refs = refsByPath(db);
  const managed = [];
  const unmanaged = [];
  const hashFiles = o.hashFiles !== false;
  for (const file of listing.files) {
    let digest = null;
    // 看板轮询路径可以跳过哈希：分类仍然真实（靠引用表 + 路径/内容关联），只是 verified 变成 null。
    if (hashFiles) { try { digest = sha256Buffer(fs.readFileSync(file.path)); } catch (error) { digest = null; } }
    const ref = refs.get(file.relative_path);
    if (ref) {
      const verified = hashFiles ? !!(ref.sha256 && digest && String(ref.sha256) === digest) : null;
      managed.push(Object.assign({}, file, { task_id: ref.task_id, kind: ref.kind, sha256: digest,
        verified: verified,
        reason: hashFiles ? (verified ? 'artifact_refs' : (digest ? 'hash_mismatch' : 'hash_unreadable')) : 'artifact_refs_unhashed' }));
      continue;
    }
    // 没登记：先看能不能可靠关联（路径命中，其次内容里唯一的 task id）
    let taskId = null;
    let reason = 'no_reliable_link';
    const inPath = (file.relative_path.match(TASK_ID_RE) || []).filter(function (id, i, arr) { return arr.indexOf(id) === i; });
    if (inPath.length === 1 && taskExists(db, inPath[0])) { taskId = inPath[0]; reason = 'path'; }
    if (!taskId) {
      const scan = taskIdsInContent(file.path);
      if (scan.ok && scan.ids.length === 1 && taskExists(db, scan.ids[0])) { taskId = scan.ids[0]; reason = 'content'; }
      else if (scan.ok && scan.ids.length > 1) reason = 'ambiguous_task_ids';
    }
    const entry = Object.assign({}, file, { sha256: digest, task_id: taskId, reason: reason });
    if (taskId) managed.push(Object.assign(entry, { kind: 'log', verified: false, unregistered: true }));
    else unmanaged.push(entry);
  }
  return {
    ok: true,
    root: root,
    scanned_at: now,
    files: listing.files.length,
    managed: managed,
    unmanaged: unmanaged,
    skipped: listing.skipped,
    totals: {
      files: listing.files.length,
      bytes: listing.files.reduce(function (n, f) { return n + f.bytes; }, 0),
      managed: managed.length,
      unverified: managed.filter(function (f) { return f.verified !== true; }).length,
      unmanaged: unmanaged.length,
      unmanaged_bytes: unmanaged.reduce(function (n, f) { return n + f.bytes; }, 0),
    },
    notes: ['unmanaged 只上报，本模块不删除任何文件', 'imported 条件：路径或内容能唯一确定已存在的 task id，且 sha256 可计算'],
  };
}

// 一次性 import：把"可靠关联但未登记"的文件写进 artifact_refs。只写引用表，不动文件。
export function importInventory(db, options) {
  const o = options || {};
  const inventory = buildInventory(db, o);
  const imported = [];
  const failed = [];
  const candidates = inventory.managed.filter(function (row) { return row.unregistered === true && row.task_id && row.sha256; });
  let tx = false;
  try {
    db.exec('BEGIN IMMEDIATE');
    tx = true;
    for (const row of candidates) {
      try {
        db.prepare('INSERT OR REPLACE INTO artifact_refs(task_id,kind,relative_path,sha256,size) VALUES(?,?,?,?,?)')
          .run(row.task_id, row.kind || 'log', row.relative_path, row.sha256, row.bytes);
        imported.push({ task_id: row.task_id, relative_path: row.relative_path, sha256: row.sha256, bytes: row.bytes });
      } catch (error) {
        failed.push({ relative_path: row.relative_path, reason: String((error && error.message) || error) });
      }
    }
    db.exec('COMMIT');
    tx = false;
  } catch (error) {
    if (tx) { try { db.exec('ROLLBACK'); } catch (e) {} }
    return { ok: false, reason: 'transaction_failed', message: String((error && error.message) || error) };
  }
  return { ok: true, dry_run: o.dryRun === true, imported: imported, failed: failed,
    unmanaged: inventory.unmanaged.map(function (row) { return { relative_path: row.relative_path, bytes: row.bytes, reason: row.reason }; }),
    totals: { imported: imported.length, failed: failed.length, unmanaged: inventory.unmanaged.length } };
}

export { TASK_ID_RE as LOG_TASK_ID_PATTERN };
