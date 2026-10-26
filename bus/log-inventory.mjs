// 旧日志 inventory（第 3 项）：扫描 bus/logs，逐个文件给出**可审计**的归属推断。
// 三条铁律：
//   1) 每个文件都输出 inferred_task_id + basis（依据）+ confidence，让人能复核，而不是吃一个 id；
//   2) 只有 confidence=high/verified 的才允许 --import 写 artifact_refs；其余标 unmanaged_unknown，
//      保持原文件、不进 retention、**本模块没有任何 unlink 调用，也没有批量删除入口**；
//   3) 符号链接、目录、越界路径一律 skipped。
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { BUS_DIR, nowIso } from './store.mjs';

const TASK_ID_RE = /\bt-[a-z0-9]{4,}\b/g;
const CONTENT_SCAN_BYTES = 64 * 1024;

// 置信度语义（写进输出，也写进文档）：
//   verified —— artifact_refs 里有记录且 sha256 一致（唯一可信来源：数据库记录 + 内容哈希）
//   high     —— 路径/文件名里只有一个 task id，且该 task 存在，且内容里没有出现别的 task id（两个来源不冲突）
//   medium   —— 只有一个来源（仅路径、或仅内容），或路径与内容给出的 id 不一致 → 只上报，不自动 import
//   none     —— 认不出、认出多个、或 task 根本不存在
const CONFIDENCE_ORDER = { verified: 4, high: 3, medium: 2, low: 1, none: 0 };

function sha256Buffer(buf) { return crypto.createHash('sha256').update(buf).digest('hex'); }
function logsRootOf(options) { return path.resolve((options && options.logsDir) || path.join(BUS_DIR, 'logs')); }

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
      out.push({ path: resolved, relative_path: rel, size: st.size, mtime: new Date(st.mtimeMs).toISOString() });
    }
  }
  walk(root, 0);
  out.sort(function (a, b) { return a.relative_path < b.relative_path ? -1 : 1; });
  return { files: out, skipped: skipped };
}

function taskExists(db, taskId) {
  try { return !!db.prepare('SELECT 1 AS ok FROM tasks WHERE id=?').get(taskId); } catch (error) { return false; }
}

// 内容前 64KB 里的 task id 集合：二进制一律不猜（返回 ok:false）。
function taskIdsInContent(file) {
  let fd = null;
  try {
    fd = fs.openSync(file, 'r');
    const length = Math.min(CONTENT_SCAN_BYTES, fs.fstatSync(fd).size);
    const buf = Buffer.alloc(length);
    fs.readSync(fd, buf, 0, length, 0);
    if (buf.indexOf(0) >= 0) return { ok: false, reason: 'binary', ids: [] };
    const found = new Set();
    const text = buf.toString('utf8');
    let m;
    TASK_ID_RE.lastIndex = 0;
    while ((m = TASK_ID_RE.exec(text)) !== null) found.add(m[0]);
    return { ok: true, reason: null, ids: Array.from(found), scanned_bytes: length };
  } catch (error) {
    return { ok: false, reason: 'read_failed', ids: [] };
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

function classify(db, file, ref, digest, hashFiles) {
  const inPath = (file.relative_path.match(TASK_ID_RE) || []).filter(function (id, i, arr) { return arr.indexOf(id) === i; });
  const scan = taskIdsInContent(file.path);

  // 1) 数据库里有记录：唯一可信来源（哈希一致才算 verified）
  if (ref) {
    const verified = hashFiles ? !!(ref.sha256 && digest && String(ref.sha256) === digest) : null;
    return {
      status: 'managed',
      inferred_task_id: ref.task_id || null,
      confidence: verified === true ? 'verified' : (verified === null ? 'low' : 'low'),
      basis: {
        source: 'artifact_refs',
        detail: verified === true ? 'artifact_refs 记录 + sha256 一致'
          : (verified === null ? 'artifact_refs 记录（本次未哈希）' : 'artifact_refs 记录，但 sha256 与当前文件不一致'),
        signals: { artifact_refs: { task_id: ref.task_id || null, sha256: ref.sha256 || null, size: ref.size == null ? null : Number(ref.size) },
          current: { sha256: digest, size: file.size } },
        matched_ids: ref.task_id ? [String(ref.task_id)] : [],
        task_exists: ref.task_id ? taskExists(db, ref.task_id) : false,
      },
      importable: false,
      retention_eligible: verified !== false,
      reason: verified === false ? 'hash_mismatch' : 'artifact_refs',
      kind: ref.kind || 'log',
      verified: verified,
    };
  }

  // 2) 没有登记：靠路径/内容推断，并如实标注依据与置信度
  const pathIds = inPath.filter(function (id) { return taskExists(db, id); });
  const contentIds = (scan.ids || []).filter(function (id) { return taskExists(db, id); });
  const signals = {
    path: { ids: inPath, existing: pathIds },
    content: { ok: scan.ok, reason: scan.reason, ids: scan.ids || [], existing: contentIds, scanned_bytes: scan.scanned_bytes || 0 },
  };
  const base = { status: 'unmanaged_unknown', inferred_task_id: null, importable: false, retention_eligible: false };

  // 认出的 id 超过一个（任一侧）→ 绝不猜
  if (inPath.length > 1 || (scan.ids || []).length > 1) {
    return Object.assign(base, {
      confidence: 'none', reason: 'ambiguous_task_ids',
      basis: { source: 'none', detail: '路径或内容里出现多个 task id，无法唯一确认', signals: signals, matched_ids: [], task_exists: false },
    });
  }
  if (!scan.ok && inPath.length === 0) {
    return Object.assign(base, {
      confidence: 'none', reason: scan.reason === 'binary' ? 'binary_no_link' : 'unreadable_no_link',
      basis: { source: 'none', detail: '内容不可扫描（' + scan.reason + '），路径里也没有 task id', signals: signals, matched_ids: [], task_exists: false },
    });
  }
  const pathId = pathIds[0] || null;
  const contentId = contentIds[0] || null;
  const rawPathId = inPath[0] || null;
  const rawContentId = (scan.ids || [])[0] || null;

  // 路径与内容都指向不同 id → 冲突，不猜
  if (pathId && contentId && pathId !== contentId) {
    return Object.assign(base, {
      confidence: 'medium', reason: 'conflicting_signals', inferred_task_id: null,
      basis: { source: 'path+content', detail: '路径指向 ' + pathId + '，内容指向 ' + contentId + '：冲突，不自动归户', signals: signals, matched_ids: [pathId, contentId], task_exists: true },
    });
  }
  // 两个来源一致 → high（可 import）
  if (pathId && (contentId === pathId || (!contentId && scan.ok))) {
    return Object.assign(base, {
      status: 'managed', inferred_task_id: pathId, confidence: 'high', importable: true, retention_eligible: true,
      reason: 'path_and_content_agree',
      basis: { source: 'path+content', detail: '路径里唯一 task id ' + pathId + '，内容无冲突' + (contentId === pathId ? '且同指该任务' : ''), signals: signals, matched_ids: [pathId], task_exists: true },
      kind: 'log', verified: false, unregistered: true,
    });
  }
  // 只有路径一份证据 → medium（只上报，不自动 import：可能是别人把文件复制进来）
  if (pathId && !contentId) {
    return Object.assign(base, {
      confidence: 'medium', reason: 'path_only', inferred_task_id: pathId,
      basis: { source: 'path', detail: '仅路径里有唯一 task id ' + pathId + '（内容里没有可确认的 id）', signals: signals, matched_ids: [pathId], task_exists: true },
    });
  }
  // 只有内容一份证据 → medium（可能是"引用了别的任务"的日志，不能归给那个任务）
  if (contentId && !pathId) {
    return Object.assign(base, {
      confidence: 'medium', reason: 'content_only', inferred_task_id: contentId,
      basis: { source: 'content', detail: '仅内容里出现 ' + contentId + '（文件名无关；可能是引用，不自动归户）', signals: signals, matched_ids: [contentId], task_exists: true },
    });
  }
  // 认出了 id 但 task 根本不存在
  if (rawPathId || rawContentId) {
    return Object.assign(base, {
      confidence: 'none', reason: 'task_missing', inferred_task_id: null,
      basis: { source: 'path+content', detail: '认出的 id 在 tasks 表里不存在，不能据此归户', signals: signals, matched_ids: [rawPathId, rawContentId].filter(Boolean), task_exists: false },
    });
  }
  return Object.assign(base, {
    confidence: 'none', reason: 'no_reliable_link',
    basis: { source: 'none', detail: '路径与内容都没有可确认的 task id', signals: signals, matched_ids: [], task_exists: false },
  });
}

export function buildInventory(db, options) {
  const o = options || {};
  const root = logsRootOf(o);
  const now = typeof o.now === 'string' && o.now ? o.now : nowIso();
  const limit = Number.isSafeInteger(o.limit) && o.limit > 0 ? o.limit : 5000;
  const listing = listFiles(root, limit);
  const refs = refsByPath(db);
  const hashFiles = o.hashFiles !== false;
  const files = [];
  for (const file of listing.files) {
    let digest = null;
    if (hashFiles) { try { digest = sha256Buffer(fs.readFileSync(file.path)); } catch (error) { digest = null; } }
    const decided = classify(db, file, refs.get(file.relative_path), digest, hashFiles);
    files.push(Object.assign({}, file, {
      sha256: digest,
      status: decided.status,
      inferred_task_id: decided.inferred_task_id,
      confidence: decided.confidence,
      basis: decided.basis,
      importable: decided.importable === true,
      retention_eligible: decided.retention_eligible === true,
      reason: decided.reason,
      kind: decided.kind,
      verified: decided.verified,
      unregistered: decided.unregistered === true,
      needs_review: decided.confidence === 'medium',
    }));
  }
  const managed = files.filter(function (f) { return f.status === 'managed'; });
  const unmanaged = files.filter(function (f) { return f.status !== 'managed'; });
  return {
    ok: true,
    root: root,
    scanned_at: now,
    files: files.length,
    entries: files,
    managed: managed,
    unmanaged: unmanaged,
    unmanaged_unknown: unmanaged,
    skipped: listing.skipped,
    import_suggestions: files.filter(function (f) { return f.importable === true; })
      .map(function (f) { return { relative_path: f.relative_path, task_id: f.inferred_task_id, confidence: f.confidence, basis: f.basis }; }),
    review_suggestions: files.filter(function (f) { return f.needs_review === true; })
      .map(function (f) { return { relative_path: f.relative_path, inferred_task_id: f.inferred_task_id, reason: f.reason, basis: f.basis }; }),
    totals: {
      files: files.length,
      bytes: files.reduce(function (n, f) { return n + f.size; }, 0),
      managed: managed.length,
      verified: files.filter(function (f) { return f.confidence === 'verified'; }).length,
      importable: files.filter(function (f) { return f.importable === true; }).length,
      needs_review: files.filter(function (f) { return f.needs_review === true; }).length,
      unmanaged: unmanaged.length,
      unmanaged_bytes: unmanaged.reduce(function (n, f) { return n + f.size; }, 0),
    },
    notes: [
      'unmanaged_unknown 只上报：本模块不删除任何文件，也没有批量删除入口（本阶段不实现 prune-unmanaged）',
      '只有 confidence=verified（artifact_refs + 哈希一致）或 high（路径唯一 + 内容不冲突）才允许 --import',
      'medium（单一来源）只建议人工复核，不自动归户：日志里"提到"某个 task 不等于"属于"该 task',
    ],
  };
}

// 一次性 import：只写 artifact_refs，不动文件；写之前**重新校验大小与 sha256**，防止盘点后文件被人改过。
export function importInventory(db, options) {
  const o = options || {};
  // 允许调用方传入已经盘点好的结果（CLI/看板一次盘点多次使用）；若传入，写入前仍会重新校验大小与哈希。
  const inventory = o.inventory && o.inventory.entries ? o.inventory : buildInventory(db, o);
  const imported = [];
  const skipped = [];
  const failed = [];
  const candidates = inventory.entries.filter(function (row) { return row.importable === true && row.inferred_task_id && row.sha256; });
  const existingRefs = refsByPath(db);
  const accepted = [];
  for (const row of candidates) {
    const known = existingRefs.get(row.relative_path);
    if (known && String(known.sha256 || '') === String(row.sha256)) { skipped.push({ relative_path: row.relative_path, reason: 'already_imported' }); continue; }
    // 盘点之后文件被改动过 → 拒绝（否则会把过期哈希写进引用表，后面 retention 可能误删"变了的那份"）
    let fresh = null;
    try { fresh = { size: fs.statSync(row.path).size, sha256: sha256Buffer(fs.readFileSync(row.path)) }; }
    catch (error) { failed.push({ relative_path: row.relative_path, reason: 'read_failed_after_scan' }); continue; }
    if (fresh.size !== row.size || fresh.sha256 !== row.sha256) {
      failed.push({ relative_path: row.relative_path, reason: 'changed_since_scan', scanned: { size: row.size, sha256: row.sha256 }, current: fresh });
      continue;
    }
    accepted.push({ row: row, sha256: fresh.sha256, size: fresh.size });
  }
  let tx = false;
  try {
    db.exec('BEGIN IMMEDIATE');
    tx = true;
    for (const item of accepted) {
      const row = item.row;
      try {
        db.prepare('INSERT OR REPLACE INTO artifact_refs(task_id,kind,relative_path,sha256,size) VALUES(?,?,?,?,?)')
          .run(row.inferred_task_id, row.kind || 'log', row.relative_path, item.sha256, item.size);
        imported.push({ task_id: row.inferred_task_id, relative_path: row.relative_path, sha256: item.sha256, size: item.size,
          confidence: row.confidence, basis: row.basis });
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
  return {
    ok: true,
    dry_run: o.dryRun !== false,
    imported: imported,
    skipped: skipped,
    failed: failed,
    unmanaged: inventory.unmanaged.map(function (row) {
      return { relative_path: row.relative_path, size: row.size, confidence: row.confidence, reason: row.reason, inferred_task_id: row.inferred_task_id, basis: row.basis };
    }),
    needs_review: inventory.review_suggestions,
    totals: { imported: imported.length, skipped: skipped.length, failed: failed.length, unmanaged: inventory.unmanaged.length },
    notes: ['只写 artifact_refs，不动任何文件', 'unmanaged_unknown 永不进入自动 retention，也没有批量删除入口'],
  };
}

export { TASK_ID_RE as LOG_TASK_ID_PATTERN, CONFIDENCE_ORDER };
