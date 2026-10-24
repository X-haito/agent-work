// 工作区守卫：改动前后快照 + diff + 红线判定。
import fs from 'node:fs';
import path from 'node:path';
import { classifyPaths, mergeKinds } from './redline.mjs';

export const DEP_MANIFESTS = ['package.json', 'package-lock.json', 'pnpm-lock.yaml', 'yarn.lock',
  'requirements.txt', 'pyproject.toml', 'Cargo.toml', 'go.mod'];

const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', '.next']);
const MAX_FILES = 20000;
const DEFAULT_MAX_CHANGED = 20;

function relOf(root, full) {
  return path.relative(root, full).split(path.sep).join('/');
}

export function snapshot(dir) {
  const files = {};
  if (!dir) return { files: files, truncated: false, scanned: 0 };
  const root = path.resolve(dir);
  let exists = true;
  try { exists = fs.statSync(root).isDirectory(); } catch (e) { exists = false; }
  if (!exists) return { files: files, truncated: false, scanned: 0 };

  let scanned = 0;
  let truncated = false;
  const stack = [root];
  while (stack.length && !truncated) {
    const cur = stack.pop();
    let ents = null;
    try { ents = fs.readdirSync(cur, { withFileTypes: true }); } catch (e) { continue; }
    for (const e of ents) {
      const full = path.join(cur, e.name);
      if (e.isDirectory()) {
        if (!SKIP_DIRS.has(e.name)) stack.push(full);
        continue;
      }
      if (!e.isFile()) continue;
      if (scanned >= MAX_FILES) { truncated = true; break; }
      let st = null;
      try { st = fs.statSync(full); } catch (e) { continue; }
      scanned += 1;
      files[relOf(root, full)] = { size: st.size, mtimeMs: st.mtimeMs };
    }
  }
  return { files: files, truncated: truncated, scanned: scanned };
}

export function diff(before, after) {
  const b = (before && before.files) || {};
  const a = (after && after.files) || {};
  const added = [];
  const modified = [];
  const deleted = [];
  for (const k of Object.keys(a)) {
    const old = b[k];
    if (!old) { added.push(k); continue; }
    if (old.size !== a[k].size || old.mtimeMs !== a[k].mtimeMs) modified.push(k);
  }
  for (const k of Object.keys(b)) { if (!a[k]) deleted.push(k); }
  added.sort(); modified.sort(); deleted.sort();
  return { added: added, modified: modified, deleted: deleted, count: added.length + modified.length + deleted.length };
}

function baseName(p) {
  const s = String(p).replace(/\\/g, '/');
  const i = s.lastIndexOf('/');
  return i < 0 ? s : s.slice(i + 1);
}

function listOf(v) {
  if (v == null) return [];
  if (Array.isArray(v)) return v.filter(Boolean).map(String);
  try {
    const parsed = JSON.parse(String(v));
    return Array.isArray(parsed) ? parsed.filter(Boolean).map(String) : [];
  } catch (e) { return []; }
}

function norm(p) {
  const s = path.resolve(p).replace(/\\/g, '/').replace(/\/+$/, '');
  return process.platform === 'win32' ? s.toLowerCase() : s;
}

function isInside(abs, root) {
  const a = norm(abs);
  const r = norm(root);
  if (!r) return false;
  return a === r || a.indexOf(r + '/') === 0;
}

// 相对路径按基准目录解析；基准目录缺失时一律视为越界（fail-closed）
function insideAny(rel, base, extra) {
  const abs = path.isAbsolute(rel) ? rel : path.resolve(base, rel);
  if (isInside(abs, base)) return true;
  return extra.some(function (d) { return isInside(abs, path.isAbsolute(d) ? d : path.resolve(base, d)); });
}

function head(list) {
  return list.slice(0, 3).join(', ') + (list.length > 3 ? ' …共 ' + list.length + ' 个' : '');
}

function maxChanged(policy) {
  const raw = policy && policy.economics ? policy.economics.max_changed_files : null;
  if (raw == null || raw === '') return DEFAULT_MAX_CHANGED;
  const n = Number(raw);
  return Number.isFinite(n) ? n : DEFAULT_MAX_CHANGED;
}

export function audit(ctx) {
  const task = (ctx && ctx.task) || {};
  const ws = (ctx && ctx.ws) || {};
  const policy = (ctx && ctx.policy) || {};
  const d = diff(ctx && ctx.before, ctx && ctx.after);
  const changed = d.added.concat(d.modified, d.deleted);
  const grants = mergeKinds(task.grants);
  const base = ws.cwd || ws.root || '';
  const extra = ctx && ctx.grant ? ctx.grant.roots.slice(1) : listOf(task.extra_dirs);
  const hard = [];
  const soft = [];
  const touched = d.added.concat(d.modified);

  if (d.deleted.length && grants.indexOf('fs:delete') < 0) {
    hard.push({ kind: 'fs:delete', detail: '删除了 ' + d.deleted.length + ' 个文件: ' + head(d.deleted) });
  }

  const depTouched = touched.filter(function (p) { return DEP_MANIFESTS.indexOf(baseName(p)) >= 0; });
  if (depTouched.length && grants.indexOf('dep:install') < 0) {
    hard.push({ kind: 'dep:install', detail: '依赖清单被改/新增: ' + head(depTouched) });
  }

  const cfgTouched = touched.filter(function (p) { return classifyPaths([p]).length > 0; });
  if (cfgTouched.length && grants.indexOf('cfg:edit') < 0) {
    hard.push({ kind: 'cfg:edit', detail: '受保护文件被改/新增: ' + head(cfgTouched) });
  }

  if (!base) {
    if (changed.length) hard.push({ kind: 'fs:outside', detail: '无法确定工作目录，改动一律视为越界: ' + head(changed) });
  } else {
    const outside = changed.filter(function (p) { return !insideAny(p, base, extra); });
    if (outside.length) hard.push({ kind: 'fs:outside', detail: '改动不在 ' + base + ' 或 extra_dirs 内: ' + head(outside) });
  }

  const limit = maxChanged(policy);
  if (d.count > limit && grants.indexOf('wide:change') < 0) {
    soft.push({ kind: 'wide:change', detail: '改动 ' + d.count + ' 个文件，超过上限 ' + limit });
  }

  return { ok: hard.length === 0, hard: hard, soft: soft, changed_files: d.count, changed: changed };
}

export function snapshotGrant(grant) {
  if (!grant || !Array.isArray(grant.roots) || !grant.roots.length) throw new Error('execution_grant_invalid: 快照缺少授权根');
  const files = {};
  let truncated = false, scanned = 0;
  for (const root of grant.roots) {
    const current = snapshot(root);
    truncated ||= current.truncated;
    scanned += current.scanned;
    for (const [relative, value] of Object.entries(current.files)) files[path.resolve(root, relative)] = value;
  }
  return { files, truncated, scanned, grant_id: grant.grant_id, task_version: grant.task_version };
}

export function recordGrantAudit(db, task, owner, grant, before, after) {
  const detail = { grant_id: grant.grant_id, task_version: grant.task_version, truncated: Boolean(before?.truncated || after?.truncated) };
  db.prepare('INSERT INTO guard_events(task_id,agent,kind,detail,action,actor,ts) VALUES(?,?,?,?,?,?,?)').run(task.id, owner, 'execution:snapshot', JSON.stringify(detail), detail.truncated ? 'needs_human' : 'audit', owner, new Date().toISOString());
  return detail;
}
