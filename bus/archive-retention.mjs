// 二级保留（第 10 项第 12 条）：清理"更老的一层"文件——数据库快照与任务 JSONL 归档包。
// 铁律：
//   1) 同样 dry-run + plan hash + Human confirm，apply 只执行计划里点名的路径，不重新挑候选；
//   2) 仍被 task_archives 引用的文件**永不删除**（计划阶段排除，apply 阶段再核一次）；
//   3) min_snapshots / min_archive_bundles 是硬下限：无论多老都要留够最新的 N 个；
//   4) 只动本模块负责的两个目录里的普通文件：符号链接、目录、越界路径一律跳过并如实上报。
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { BUS_DIR, nowIso } from './store.mjs';
import { logAudit } from './auth.mjs';

function sha256(text) { return crypto.createHash('sha256').update(text).digest('hex'); }

export const SNAPSHOT_PREFIX = 'bus-';
export const BUNDLE_SUBDIR = 'tasks';

export function retentionLayersOf(policy) {
  const r = (policy && policy.retention) || {};
  const int = function (value) { const n = Number(value); return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0; };
  return {
    snapshot_days: int(r.snapshot_days),
    archive_bundle_days: int(r.archive_bundle_days),
    min_snapshots: int(r.min_snapshots),
    min_archive_bundles: int(r.min_archive_bundles),
  };
}

function dirsOf(options) {
  const o = options || {};
  const archiveDir = path.resolve(o.archiveDir || path.join(BUS_DIR, 'archives'));
  return {
    archive_dir: archiveDir,
    snapshot_dir: path.resolve(o.snapshotDir || archiveDir),
    bundle_dir: path.resolve(o.bundleDir || path.join(archiveDir, BUNDLE_SUBDIR)),
    logs_dir: path.resolve(o.logsDir || path.join(BUS_DIR, 'logs')),
  };
}

// 路径逃逸与符号链接检查：只接受"落在 root 之内、非符号链接、普通文件"
function safeEntries(root, options) {
  const o = options || {};
  const out = [];
  const skipped = [];
  let names = [];
  try { names = fs.readdirSync(root); } catch (error) { return { files: out, skipped: [{ path: root, reason: 'unreadable', detail: String((error && error.message) || error) }] }; }
  for (const name of names) {
    const full = path.join(root, name);
    const resolved = path.resolve(full);
    if (resolved !== path.join(root, name.replace(/\//g, path.sep)) || resolved.indexOf(root + path.sep) !== 0) {
      skipped.push({ path: full, reason: 'path_escape' });
      continue;
    }
    let st = null;
    try { st = fs.lstatSync(resolved); } catch (error) { skipped.push({ path: resolved, reason: 'stat_failed' }); continue; }
    if (st.isSymbolicLink()) { skipped.push({ path: resolved, reason: 'symlink' }); continue; }
    if (!st.isFile()) { skipped.push({ path: resolved, reason: 'not_a_file' }); continue; }
    const allow = o.filter ? o.filter(name) : true;
    if (!allow) continue;
    out.push({ path: resolved, relative_path: name.split(path.sep).join('/'), bytes: st.size, mtime: new Date(st.mtimeMs).toISOString(), mtimeMs: st.mtimeMs });
  }
  out.sort(function (a, b) { return b.mtimeMs - a.mtimeMs; });
  return { files: out, skipped: skipped };
}

// task_archives.archive_path 是相对 archiveDir 的路径；任何被引用的真实路径都不许删
function referencedPaths(db, dirs) {
  const set = new Set();
  let rows = [];
  try { rows = db.prepare('SELECT task_id, archive_path FROM task_archives').all(); } catch (error) { rows = []; }
  for (const row of rows) {
    const rel = String(row.archive_path || '');
    if (!rel) continue;
    set.add(path.resolve(dirs.archive_dir, rel));
    set.add(path.resolve(dirs.bundle_dir, path.basename(rel)));
  }
  return set;
}

function cutoffOf(days, now) {
  return days > 0 ? now.getTime() - days * 86400000 : null;
}

export function buildPlan(db, policy, options) {
  const o = options || {};
  const now = o.now ? new Date(o.now) : new Date();
  const layers = retentionLayersOf(policy);
  const dirs = dirsOf(o);
  const referenced = referencedPaths(db, dirs);
  const snapshots = safeEntries(dirs.snapshot_dir, { filter: function (name) { return /^bus-.*\.db$/.test(name); } });
  const bundles = safeEntries(dirs.bundle_dir, { filter: function (name) { return /\.jsonl(\.gz)?$/.test(name); } });

  function classify(entries, days, minKeep, kind) {
    const cutoff = cutoffOf(days, now);
    const candidates = [];
    const kept = [];
    entries.files.forEach(function (file, index) {
      const base = { path: file.path, relative_path: file.relative_path, bytes: file.bytes, mtime: file.mtime };
      if (referenced.has(path.resolve(file.path))) { kept.push(Object.assign(base, { reason: 'referenced_by_task_archive' })); return; }
      if (index < minKeep) { kept.push(Object.assign(base, { reason: 'min_' + kind + '_not_met' })); return; }
      if (days === 0 || cutoff === null) { kept.push(Object.assign(base, { reason: 'policy_disabled' })); return; }
      if (file.mtimeMs >= cutoff) { kept.push(Object.assign(base, { reason: 'too_new' })); return; }
      candidates.push(Object.assign(base, { kind: kind }));
    });
    return { candidates: candidates, kept: kept, skipped: entries.skipped };
  }

  const snap = classify(snapshots, layers.snapshot_days, layers.min_snapshots, 'snapshots');
  const bun = classify(bundles, layers.archive_bundle_days, layers.min_archive_bundles, 'archive_bundles');

  const body = {
    engine: 'archive-retention',
    engine_version: 1,
    policy: layers,
    dirs: { archive_dir: dirs.archive_dir, snapshot_dir: dirs.snapshot_dir, bundle_dir: dirs.bundle_dir },
    snapshots: snap,
    archive_bundles: bun,
    totals: {
      candidates: snap.candidates.length + bun.candidates.length,
      bytes: snap.candidates.concat(bun.candidates).reduce(function (n, f) { return n + f.bytes; }, 0),
    },
    notes: [
      '仍然被 task_archives 引用的文件不会被删除（计划里列在 kept，reason=referenced_by_task_archive）',
      'min_snapshots / min_archive_bundles 是最新 N 个的硬下限，无论多老都保留',
    ],
  };
  // plan_hash 不含 generated_at：同一份数据 + 同一份策略 = 同一个 hash，dry-run 的值可以直接 --confirm
  body.plan_hash = sha256(JSON.stringify(body));
  body.generated_at = nowIso();
  return { ok: true, plan: body, plan_hash: body.plan_hash };
}

export function applyPlan(db, policy, plan, options) {
  const o = options || {};
  if (!plan || !plan.plan_hash) return { ok: false, reason: 'plan_required', message: '必须先用 buildPlan 生成计划' };
  if (o.confirm == null || String(o.confirm) !== String(plan.plan_hash)) {
    return { ok: false, reason: 'confirm_mismatch', message: '确认 hash 与计划不一致，请重新 dry-run', plan_hash: plan.plan_hash };
  }
  const layers = retentionLayersOf(policy);
  const dirs = dirsOf(o);
  // 计划里写的策略与当前策略不一致 → 整批中止（计划是"不可变"的）
  if (JSON.stringify(layers) !== JSON.stringify(plan.policy)) {
    return { ok: false, reason: 'policy_changed', message: '策略在计划生成后变过，请重新 dry-run', plan_hash: plan.plan_hash };
  }
  const referenced = referencedPaths(db, dirs);
  const deleted = [];
  const refused = [];
  const queue = []
    .concat((plan.snapshots && plan.snapshots.candidates) || [])
    .concat((plan.archive_bundles && plan.archive_bundles.candidates) || []);
  for (const item of queue) {
    const resolved = path.resolve(item.path);
    const inSnapshots = resolved.indexOf(dirs.snapshot_dir + path.sep) === 0;
    const inBundles = resolved.indexOf(dirs.bundle_dir + path.sep) === 0;
    if (!inSnapshots && !inBundles) { refused.push({ path: resolved, reason: 'path_escape' }); continue; }
    if (referenced.has(resolved)) { refused.push({ path: resolved, reason: 'referenced_by_task_archive' }); continue; }
    let st = null;
    try { st = fs.lstatSync(resolved); } catch (error) { refused.push({ path: resolved, reason: 'missing' }); continue; }
    if (st.isSymbolicLink() || !st.isFile()) { refused.push({ path: resolved, reason: 'not_a_regular_file' }); continue; }
    try {
      fs.unlinkSync(resolved);
      deleted.push({ path: resolved, relative_path: item.relative_path, bytes: st.size, kind: item.kind });
    } catch (error) {
      refused.push({ path: resolved, reason: 'unlink_failed', detail: String((error && error.message) || error) });
    }
  }
  const bytes = deleted.reduce(function (n, f) { return n + f.bytes; }, 0);
  try {
    logAudit(db, { actor: o.actor || 'human', auth_method: o.auth_method || 'local-cli', action: 'archive_retention.applied',
      resource: { plan_hash: plan.plan_hash, deleted: deleted.length, bytes: bytes, refused: refused.length }, result: 'ok' });
  } catch (error) { /* 审计写不进去不该让已经删除的文件复活；如实返回 */ }
  return { ok: true, plan_hash: plan.plan_hash, deleted: deleted, refused: refused, totals: { deleted: deleted.length, bytes: bytes } };
}

// 看板用的轻量概况：不计算 hash、不生成计划，只数文件和字节
export function summarize(policy, options) {
  const o = options || {};
  const dirs = dirsOf(o);
  const layers = retentionLayersOf(policy);
  function stat(dir, filter) {
    const scanned = safeEntries(dir, { filter: filter });
    const files = scanned.files;
    return {
      count: files.length,
      bytes: files.reduce(function (n, f) { return n + f.bytes; }, 0),
      newest: files.length ? files[0].mtime : null,
      oldest: files.length ? files[files.length - 1].mtime : null,
      skipped: scanned.skipped.length,
    };
  }
  return {
    config: layers,
    snapshots: stat(dirs.snapshot_dir, function (name) { return /^bus-.*\.db$/.test(name); }),
    archive_bundles: stat(dirs.bundle_dir, function (name) { return /\.jsonl(\.gz)?$/.test(name); }),
  };
}
