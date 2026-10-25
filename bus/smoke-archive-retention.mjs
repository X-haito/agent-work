// 第 10 项第 12/13 条：二级保留（快照 + 任务归档包）与旧日志 inventory。
// 铁律验证点：dry-run/plan hash/confirm、min_* 硬下限、被 task_archives 引用的文件不可删、
// unmanaged 日志只上报绝不删除、路径逃逸与符号链接一律拒绝。
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as S from './store.mjs';
import * as Retention from './archive-retention.mjs';
import * as Logs from './log-inventory.mjs';

let pass = 0, fail = 0;
function ok(name, cond, detail) {
  if (cond) { pass++; console.log('PASS ' + name); return true; }
  fail++; console.log('FAIL ' + name + (detail === undefined ? '' : ' :: ' + String(detail).slice(0, 400)));
  return false;
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'agentbus-retention2-'));
const archiveDir = path.join(tmp, 'archives');
const bundleDir = path.join(archiveDir, 'tasks');
const logsDir = path.join(tmp, 'logs');
fs.mkdirSync(bundleDir, { recursive: true });
fs.mkdirSync(logsDir, { recursive: true });
const db = S.openDb(path.join(tmp, 'bus.db'));
S.setRuntimeState(db, 'human', true);

const NOW = new Date('2026-06-01T00:00:00.000Z');
function daysAgo(n) { return new Date(NOW.getTime() - n * 86400000); }
function writeFile(file, content, ageDays) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
  const when = daysAgo(ageDays);
  fs.utimesSync(file, when, when);
  return file;
}
function policyWith(retention) {
  return { lead: 'lead/main', permissions: { dispatch: ['lead/main'], accept: ['human'] }, global: {}, economics: {},
    agents: { 'lead/main': { autonomy: 'auto', may_dispatch_to: ['*'], max_open_from_agents: 10, max_concurrent: 5 } },
    retention: Object.assign({}, retention) };
}

// 快照：10 天 / 5 天 / 1 天；策略 snapshot_days=3 → 前两个候选
const snapOld = writeFile(path.join(archiveDir, 'bus-20260522.db'), 'snapshot-old', 10);
const snapMid = writeFile(path.join(archiveDir, 'bus-20260527.db'), 'snapshot-mid', 5);
const snapNew = writeFile(path.join(archiveDir, 'bus-20260531.db'), 'snapshot-new', 1);
// 归档包：20 天 / 15 天 / 1 天；其中 20 天那个被 task_archives 引用
const bundleOldest = writeFile(path.join(bundleDir, 't-0001.jsonl.gz'), 'bundle-1', 20);
const bundleMid = writeFile(path.join(bundleDir, 't-0002.jsonl.gz'), 'bundle-2', 15);
const bundleNew = writeFile(path.join(bundleDir, 't-0003.jsonl.gz'), 'bundle-3', 1);
// 非本模块管辖的文件（命名不符）：绝不能被当成候选
const stray = writeFile(path.join(archiveDir, 'notes.txt'), 'not mine', 300);
// 符号链接：绝不跟随、绝不删除
let symlinkMade = false;
try { fs.symlinkSync(snapOld, path.join(archiveDir, 'bus-link.db')); symlinkMade = true; } catch (e) { symlinkMade = false; }

const policy = policyWith({ snapshot_days: 3, archive_bundle_days: 10, min_snapshots: 0, min_archive_bundles: 0 });
const built = Retention.buildPlan(db, policy, { archiveDir: archiveDir, now: NOW.toISOString() });
ok('dry-run 返回计划与 plan_hash', built.ok === true && typeof built.plan_hash === 'string' && built.plan_hash.length === 64, built.plan_hash);
ok('快照候选按 snapshot_days 判定（10 天与 5 天的进候选，1 天的太新）',
  built.plan.snapshots.candidates.length === 2 &&
  built.plan.snapshots.candidates.some(f => f.relative_path === 'bus-20260522.db') &&
  built.plan.snapshots.candidates.some(f => f.relative_path === 'bus-20260527.db') &&
  !built.plan.snapshots.candidates.some(f => f.relative_path === 'bus-20260531.db'),
  built.plan.snapshots.candidates.map(f => f.relative_path));
ok('非本模块命名的文件不进候选', !built.plan.snapshots.candidates.some(f => f.relative_path === 'notes.txt'));

const again = Retention.buildPlan(db, policy, { archiveDir: archiveDir, now: NOW.toISOString() });
ok('同一份数据 + 同一份策略 → plan_hash 稳定', again.plan_hash === built.plan_hash);
const otherPolicy = Retention.buildPlan(db, policyWith({ snapshot_days: 30, archive_bundle_days: 10 }), { archiveDir: archiveDir, now: NOW.toISOString() });
ok('策略不同 → plan_hash 不同', otherPolicy.plan_hash !== built.plan_hash);

// 被 task_archives 引用的归档包：即使超龄也必须 kept
db.prepare('INSERT OR REPLACE INTO task_archives(task_id,archive_path,archived_at,sha256,bytes) VALUES(?,?,?,?,?)')
  .run('t-0001', 'tasks/t-0001.jsonl.gz', NOW.toISOString(), 'deadbeef', 8);
const withRef = Retention.buildPlan(db, policy, { archiveDir: archiveDir, now: NOW.toISOString() });
ok('被 task_archives 引用的归档包不在候选里', !withRef.plan.archive_bundles.candidates.some(f => f.relative_path === 't-0001.jsonl.gz'),
  withRef.plan.archive_bundles.candidates.map(f => f.relative_path));
ok('被引用的文件记在 kept 且原因是 referenced_by_task_archive',
  withRef.plan.archive_bundles.kept.some(f => f.relative_path === 't-0001.jsonl.gz' && f.reason === 'referenced_by_task_archive'));

// min_* 硬下限：min_snapshots=2 → 只剩最老那个是候选
const minPolicy = policyWith({ snapshot_days: 3, archive_bundle_days: 10, min_snapshots: 2, min_archive_bundles: 0 });
const minPlan = Retention.buildPlan(db, minPolicy, { archiveDir: archiveDir, now: NOW.toISOString() });
ok('min_snapshots=2 时只保留最新 2 个，候选只剩最老的 1 个',
  minPlan.plan.snapshots.candidates.length === 1 && minPlan.plan.snapshots.candidates[0].relative_path === 'bus-20260522.db',
  minPlan.plan.snapshots.candidates.map(f => f.relative_path));
ok('min 保护记在 kept 且原因可读', minPlan.plan.snapshots.kept.some(f => f.reason === 'min_snapshots_not_met'));

// confirm 与 policy 变更：都必须拒绝
const noConfirm = Retention.applyPlan(db, policy, withRef.plan, { archiveDir: archiveDir });
ok('没有 confirm 拒绝执行', noConfirm.ok === false && noConfirm.reason === 'confirm_mismatch', noConfirm);
const badConfirm = Retention.applyPlan(db, policy, withRef.plan, { confirm: 'f'.repeat(64), archiveDir: archiveDir });
ok('confirm hash 不对拒绝执行', badConfirm.ok === false && badConfirm.reason === 'confirm_mismatch', badConfirm);
const changed = Retention.applyPlan(db, policyWith({ snapshot_days: 1, archive_bundle_days: 1 }), withRef.plan, { confirm: withRef.plan_hash, archiveDir: archiveDir });
ok('计划生成后策略变过 → 整批中止', changed.ok === false && changed.reason === 'policy_changed', changed);
ok('被拒绝时一个文件都没删', fs.existsSync(snapOld) && fs.existsSync(snapMid) && fs.existsSync(bundleMid));

// 正常执行
const applied = Retention.applyPlan(db, policy, withRef.plan, { confirm: withRef.plan_hash, archiveDir: archiveDir, actor: 'human' });
ok('confirm 正确时执行成功', applied.ok === true, applied);
ok('候选快照被删除', !fs.existsSync(snapOld) && !fs.existsSync(snapMid));
ok('太新的快照留下', fs.existsSync(snapNew));
ok('被引用的归档包没有被删（红线）', fs.existsSync(bundleOldest), applied.deleted);
ok('其它超龄归档包被删（15 天 > 10 天阈值）', !fs.existsSync(bundleMid));
ok('未超龄的归档包留下（1 天 < 10 天阈值）', fs.existsSync(bundleNew));
ok('非管辖文件不受影响', fs.existsSync(stray));
ok('删除统计与审计落库', applied.totals.deleted === 3 &&
  db.prepare("SELECT COUNT(*) AS c FROM audit_log WHERE action='archive_retention.applied'").get().c === 1, applied.totals);
if (symlinkMade) ok('符号链接没有被当成候选', !applied.deleted.some(f => /bus-link\.db$/.test(f.path)) && fs.existsSync(path.join(archiveDir, 'bus-link.db')));

// 路径逃逸：计划里塞一个 root 外的路径，apply 必须拒绝
const outside = writeFile(path.join(tmp, 'outside.db'), 'outside', 400);
const escapePlan = JSON.parse(JSON.stringify(withRef.plan));
escapePlan.snapshots.candidates.push({ kind: 'snapshots', path: outside, relative_path: 'outside.db', bytes: 7, mtime: daysAgo(400).toISOString() });
escapePlan.plan_hash = 'x';
const escaped = Retention.applyPlan(db, policy, escapePlan, { confirm: 'x', archiveDir: archiveDir });
ok('计划里出现 root 外路径 → 拒绝删除并记 path_escape',
  escaped.ok === true && escaped.refused.some(r => r.reason === 'path_escape') && fs.existsSync(outside), escaped.refused);

// summarize：看板用的轻量概况
const summary = Retention.summarize(policy, { archiveDir: archiveDir });
ok('summarize 给出真实计数（不编 0）', summary.snapshots.count === 1 && summary.archive_bundles.count === 2 &&
  summary.config.snapshot_days === 3, JSON.stringify(summary));

// ---------- 旧日志 inventory ----------
const taskA = S.createTask(db, { title: '日志归属任务', project: tmp, status: 'open' });
const logByPath = writeFile(path.join(logsDir, taskA.id + '-build.log'), 'trace ' + taskA.id + '\n', 30);
const logByContent = writeFile(path.join(logsDir, 'compile-output.log'), 'only ' + taskA.id + ' here\n', 30);
const logAmbiguous = writeFile(path.join(logsDir, 'mixed.log'), taskA.id + ' and t-9999\n', 30);
const logBinary = writeFile(path.join(logsDir, 'blob.bin'), Buffer.from([0, 1, 2, 3]), 30);
const logNoLink = writeFile(path.join(logsDir, 'orphan.log'), 'no task id at all\n', 30);
const registered = writeFile(path.join(logsDir, taskA.id + '-covered.log'), 'covered\n', 30);
const registeredHash = require_hash(registered);
db.prepare('INSERT OR REPLACE INTO artifact_refs(task_id,kind,relative_path,sha256,size) VALUES(?,?,?,?,?)')
  .run(taskA.id, 'log', taskA.id + '-covered.log', registeredHash, fs.statSync(registered).size);

const inv = Logs.buildInventory(db, { logsDir: logsDir });
ok('inventory 扫到全部文件', inv.totals.files === 6, inv.totals);
ok('已登记且 hash 一致 → verified',
  inv.managed.some(r => r.relative_path === taskA.id + '-covered.log' && r.verified === true && r.reason === 'artifact_refs'));
ok('路径里带 task id 的旧日志能可靠归属', inv.managed.some(r => r.relative_path === taskA.id + '-build.log' && r.task_id === taskA.id && r.reason === 'path'));
ok('内容里只有唯一 task id 也能归属', inv.managed.some(r => r.relative_path === 'compile-output.log' && r.task_id === taskA.id && r.reason === 'content'));
const unmanagedNames = inv.unmanaged.map(r => r.relative_path);
ok('内容里有多个 task id → 不猜，标 unmanaged', unmanagedNames.indexOf('mixed.log') >= 0, unmanagedNames);
ok('二进制文件不猜归属', unmanagedNames.indexOf('blob.bin') >= 0, unmanagedNames);
ok('完全没有 task id 的 → unmanaged', unmanagedNames.indexOf('orphan.log') >= 0, unmanagedNames);
ok('unmanaged 计数与字节数如实给出', inv.totals.unmanaged === 3 && inv.totals.unmanaged_bytes === inv.unmanaged.reduce((n, r) => n + r.bytes, 0), inv.totals);

// import：只写引用表，不删文件
const imported = Logs.importInventory(db, { logsDir: logsDir });
ok('import 把可靠归属的旧日志写成 artifact_refs', imported.ok === true && imported.totals.imported === 2, imported.totals);
ok('import 不给 unmanaged 写引用', imported.totals.unmanaged === 3 && imported.unmanaged.length === 3, imported.unmanaged);
ok('import 不删除任何文件（红线）', fs.existsSync(logByPath) && fs.existsSync(logByContent) && fs.existsSync(logNoLink) && fs.existsSync(logBinary));
const after = Logs.buildInventory(db, { logsDir: logsDir });
ok('import 后这些文件变成 verified 归属',
  after.managed.filter(r => r.verified === true).length === 3, after.managed.map(r => [r.relative_path, r.verified]));
ok('unmanaged 数量不受 import 影响', after.totals.unmanaged === 3);

// hash 被改 → 不能算 verified（也不再是可删候选）
fs.writeFileSync(registered, 'tampered\n');
const tampered = Logs.buildInventory(db, { logsDir: logsDir });
ok('文件被改动后 hash 不一致 → verified=false 且原因 hash_mismatch',
  tampered.managed.some(r => r.relative_path === taskA.id + '-covered.log' && r.verified === false && r.reason === 'hash_mismatch'));

// 模块里不允许出现删除调用（红线自检）
const source = fs.readFileSync(new URL('./log-inventory.mjs', import.meta.url), 'utf8');
ok('log-inventory.mjs 里没有任何 unlink/rm 调用', !/unlinkSync|rmSync|rmdirSync|fs\.unlink\(/.test(source));

function require_hash(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

// ---------- 看板与 HTTP 接线 ----------
console.log('\n[console + board-ui]');
{
  const vm = await import('node:vm');
  // 客户端渲染代码已拆到 bus/ui/app.js（也可能还在 board-ui.mjs）：按"谁真的含有这个函数"定位。
  // 两处都找不到时 SKIP（明确不是 PASS），而不是随便找个地方断言出一片假绿/假红。
  function locateUiSource(symbol) {
    for (const file of [new URL('./ui/app.js', import.meta.url), new URL('./board-ui.mjs', import.meta.url)]) {
      try { const text = fs.readFileSync(file, 'utf8'); if (text.indexOf(symbol) >= 0) return text; } catch (error) { /* 继续找 */ }
    }
    return null;
  }
  const uiSource = locateUiSource('function renderRetentionLayers(){');
  let src = null;
  if (uiSource) {
    const start = uiSource.indexOf('function renderRetentionLayers(){');
    const end = uiSource.indexOf('\n    // 归档概况只显示', start);
    if (start >= 0 && end > start) src = uiSource.slice(start, end);
  }
  if (!src) {
    console.log('SKIP 看板"保留层"面板渲染断言（bus/ui/app.js 与 board-ui.mjs 都定位不到 renderRetentionLayers）—— 这不是 PASS');
  } else {
  const boxes = {};
  const ctx = { state: { archive_retention: null, logs_inventory: null },
    q: function (sel) { boxes[sel] = boxes[sel] || { hidden: false, innerHTML: '' }; return boxes[sel]; },
    esc: function (v) { return String(v); }, num: function (v) { return String(v); }, fmt: function (v) { return String(v); },
    dash: function (v) { return v == null ? '—' : String(v); } };
  const render = vm.runInNewContext('(' + src.trim() + ')', ctx);
  render();
  ok('两个数据源都缺时面板隐藏', boxes['#retention-layers'].hidden === true && boxes['#retention-layers'].innerHTML === '');
  ctx.state.archive_retention = { config: { snapshot_days: 30, min_snapshots: 2, archive_bundle_days: 7, min_archive_bundles: 1 },
    snapshots: null, archive_bundles: null };
  ctx.state.logs_inventory = { scanned: 5, managed: 2, unmanaged: 3, unmanaged_bytes: 2048, truncated: false,
    unmanaged_sample: [{ relative_path: 'orphan.log', bytes: 100, reason: 'no_reliable_link' }] };
  render();
  const html = boxes['#retention-layers'].innerHTML;
  ok('面板渲染出策略与日志归属', html.indexOf('快照保留天数 30') >= 0 && html.indexOf('不可归属 3 个') >= 0, html.slice(0, 300));
  ok('缺失字段显示「—」而不是编 0', html.indexOf('数据库快照 — 个') >= 0, html.slice(0, 300));
  ok('unmanaged 明细列在面板里', html.indexOf('orphan.log') >= 0 && html.indexOf('no_reliable_link') >= 0);
  }

  const { createBoardServer } = await import('./console-server.mjs');
  const server = createBoardServer({ db: db, actor: 'human', csrf: 'smoke-token' });
  await new Promise(function (resolve) { server.listen(0, '127.0.0.1', resolve); });
  const base = 'http://127.0.0.1:' + server.address().port;
  try {
    // 看板要求会话：用一次性 bootstrap token 换 HttpOnly cookie（与浏览器同一条路径）。
    const login = await fetch(base + '/?token=' + encodeURIComponent(server.agentBus.bootstrap.token), { redirect: 'manual' });
    const cookie = String(login.headers.get('set-cookie') || '').split(';')[0];
    ok('bootstrap token 能换到会话 cookie', login.status === 303 && cookie.length > 0, login.status);
    const state = await (await fetch(base + '/api/state', { headers: { cookie: cookie } })).json();
    ok('/api/state 暴露 archive_retention 与 logs_inventory', !!state.archive_retention && !!state.logs_inventory,
      Object.keys(state).filter(function (k) { return /retention|logs/.test(k); }));
    ok('state 的 archive_retention 带策略与计数', !!state.archive_retention.config && typeof state.archive_retention.snapshots.count === 'number',
      state.archive_retention);
    const invRes = await (await fetch(base + '/api/logs/inventory', { headers: { cookie: cookie } })).json();
    ok('/api/logs/inventory 可用且返回 unmanaged 列表',
      invRes.available === true && !!invRes.inventory && Array.isArray(invRes.inventory.unmanaged), invRes && invRes.available);
  } finally {
    await new Promise(function (resolve) { server.close(resolve); });
  }
}

try { db.close(); } catch (e) {}
try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (e) {}
console.log('\nPASS ' + pass + '   FAIL ' + fail);
if (fail) process.exitCode = 1;
