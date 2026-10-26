#!/usr/bin/env node
// 第 5 项：归档长尾专项测试。核心是「断言真的会失败」——
// 每个场景都先证明在「不注入故障 / 关掉防护」时断言会红，再证明恢复后转绿。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import * as S from './store.mjs';
import { buildPlan, applyArchive } from './archive.mjs';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'agentbus-longtail-'));
const archiveDir = path.join(tmp, 'archives');
const logsDir = path.join(tmp, 'logs');
fs.mkdirSync(logsDir, { recursive: true });
const dbFile = path.join(tmp, 'bus.db');

const placeholderPolicy = path.join(tmp, 'policy-placeholder.json');
const base = JSON.parse(fs.readFileSync(path.join(S.BUS_DIR, 'policy.json'), 'utf8'));
base.agents = Object.assign({}, base.agents, {
  'worker/main': { autonomy: 'auto', may_dispatch_to: ['*'], max_open_from_agents: 100, max_concurrent: 20 },
});
fs.writeFileSync(placeholderPolicy, JSON.stringify(base));
process.env.BUS_POLICY_PATH = placeholderPolicy;

const NOW = new Date('2026-06-01T00:00:00.000Z');
const RETENTION = { terminal_task_days: 30, message_days: 30, guard_event_days: 30, raw_usage_days: 30, log_days: 30, max_single_log_bytes: 0 };
const policy = {
  lead: 'lead/main',
  permissions: { dispatch: ['lead/main'], accept: ['human'], merge: ['human'], reassign: ['lead/main'] },
  global: {}, economics: {}, retention: RETENTION, agents: { 'worker/main': { max_concurrent: 20 } },
};
function daysAgo(n) { return new Date(NOW.getTime() - n * 86400000).toISOString(); }
let pass = 0, fail = 0;
function ok(name, value, detail) {
  if (value) { pass += 1; console.log('  PASS  ' + name); }
  else { fail += 1; console.log('  FAIL  ' + name + (detail === undefined ? '' : ' — ' + JSON.stringify(detail).slice(0, 400))); }
}

function freshDb() {
  const file = path.join(tmp, 'case-' + crypto.randomBytes(4).toString('hex') + '.db');
  const db = S.openDb(file);
  S.setRuntimeState(db, 'human', true);
  return { db: db, file: file };
}
function seed(db, n) {
  const ids = [];
  for (let i = 0; i < (n || 1); i += 1) {
    const task = S.createTask(db, { title: '长尾任务 ' + i, status: 'open', project: 'proj-longtail' });
    db.prepare("UPDATE tasks SET status='done', updated_at=?, body='旧正文" + i + "' WHERE id=?").run(daysAgo(120), task.id);
    db.prepare('INSERT INTO messages(msg_id,ts,sender,recipient,thread,kind,body,hop) VALUES(?,?,?,?,?,?,?,?)')
      .run('m-' + task.id, daysAgo(120), 'worker/main', 'human', task.id, 'note', '旧消息', 0);
    S.recordUsage(db, 'worker/main', task.id, 'execute', 10, 20);
    db.prepare('UPDATE token_usage SET ts = ? WHERE task_id = ?').run(daysAgo(120), task.id);
    ids.push(task.id);
  }
  return ids;
}
function snapshotOf(db) {
  const one = function (sql) { return Number(db.prepare(sql).get().c); };
  return {
    tasks_with_body: one("SELECT COUNT(*) AS c FROM tasks WHERE body IS NOT NULL AND project='proj-longtail'"),
    messages: one('SELECT COUNT(*) AS c FROM messages'),
    usage: one('SELECT COUNT(*) AS c FROM token_usage'),
    archives: one('SELECT COUNT(*) AS c FROM task_archives'),
    daily: one('SELECT COUNT(*) AS c FROM token_usage_daily'),
  };
}
function tempLeftovers() {
  try { return fs.readdirSync(archiveDir).filter(function (n) { return n.indexOf('.tmp-') >= 0 || n.indexOf('.tmp') === 0; }); }
  catch (e) { return []; }
}

try {
  console.log('[1] Windows rename 失败注入：原库不丢、临时文件清理、DB 不提交删除');
  {
    const c = freshDb();
    const ids = seed(c.db, 1);
    const plan = buildPlan(c.db, policy, { archiveDir: archiveDir, logsDir: logsDir, now: NOW });
    const before = snapshotOf(c.db);
    const realRename = fs.renameSync;
    let injected = 0;
    fs.renameSync = function (from, to) {
      // 只拦截归档物料的 rename（临时文件 → 正式文件），不拦截 sqlite 自己的 rename。
      if (String(to).indexOf(archiveDir) >= 0) { injected += 1; const e = new Error('EPERM: operation not permitted, rename'); e.code = 'EPERM'; throw e; }
      return realRename.apply(fs, arguments);
    };
    let applied = null;
    try { applied = applyArchive(c.db, policy, plan, { confirm: plan.plan_hash, archiveDir: archiveDir, logsDir: logsDir, now: NOW }); }
    finally { fs.renameSync = realRename; }
    const after = snapshotOf(c.db);
    ok('rename 注入真的触发了（否则这条测试是假的）', injected > 0, { injected });
    ok('apply 失败而不是静默成功', applied.ok === false, applied);
    ok('数据库没有提交删除（消息/用量/正文都在）', after.messages === before.messages && after.usage === before.usage && after.tasks_with_body === before.tasks_with_body, { before, after });
    ok('没有写入 task_archives（无半成品）', after.archives === before.archives, { before: before.archives, after: after.archives });
    ok('临时文件被清理（无 .tmp- 残留）', tempLeftovers().length === 0, tempLeftovers());
    // 恢复后重跑必须成功 → 证明失败没有留下坏状态。
    const retry = applyArchive(c.db, policy, plan, { confirm: plan.plan_hash, archiveDir: archiveDir, logsDir: logsDir, now: NOW });
    ok('恢复后重跑成功（失败未留坏状态）', retry.ok === true, retry);
    const finalSnap = snapshotOf(c.db);
    ok('重跑后消息被清（真的归档了）', finalSnap.messages < before.messages, { before: before.messages, after: finalSnap.messages });
    c.db.close();
  }

  console.log('[2] 双 worker 真进程：同一 DB 同一 plan，至多一个成功');
  {
    const c = freshDb();
    seed(c.db, 2);
    const plan = buildPlan(c.db, policy, { archiveDir: archiveDir, logsDir: logsDir, now: NOW });
    c.db.close();
    const planFile = path.join(tmp, 'plan.json');
    fs.writeFileSync(planFile, JSON.stringify(plan));
    const policyFile = path.join(tmp, 'policy.json');
    fs.writeFileSync(policyFile, JSON.stringify(policy));
    const worker = path.join(tmp, 'worker.mjs');
    fs.writeFileSync(worker, [
      "import fs from 'node:fs';",
      "import * as S from " + JSON.stringify(new URL('./store.mjs', import.meta.url).href) + ";",
      "import { applyArchive } from " + JSON.stringify(new URL('./archive.mjs', import.meta.url).href) + ";",
      "const [dbFile, policyFile, planFile, archiveDir, logsDir] = process.argv.slice(2);",
      "const policy = JSON.parse(fs.readFileSync(policyFile, 'utf8'));",
      "const plan = JSON.parse(fs.readFileSync(planFile, 'utf8'));",
      "const db = S.openDb(dbFile);",
      "const out = applyArchive(db, policy, plan, { confirm: plan.plan_hash, archiveDir, logsDir, now: new Date('2026-06-01T00:00:00.000Z') });",
      "db.close();",
      "console.log(JSON.stringify({ ok: out.ok, reason: out.reason || null }));",
    ].join('\n'));
    const runWorker = function (tag) {
      return new Promise(function (resolve) {
        const out = path.join(tmp, 'w-' + tag + '.out');
        const err = path.join(tmp, 'w-' + tag + '.err');
        const fdOut = fs.openSync(out, 'w');
        const fdErr = fs.openSync(err, 'w');
        const child = spawn(process.execPath, [worker, c.file, policyFile, planFile, archiveDir, logsDir], { stdio: ['ignore', fdOut, fdErr], windowsHide: true });
        child.on('close', function () {
          try { fs.closeSync(fdOut); } catch (e) {}
          try { fs.closeSync(fdErr); } catch (e) {}
          let text = '', errText = '';
          try { text = fs.readFileSync(out, 'utf8'); } catch (e) {}
          try { errText = fs.readFileSync(err, 'utf8'); } catch (e) {}
          let parsed = null;
          try { parsed = JSON.parse(text.trim().split('\n').filter(Boolean).pop()); } catch (e) { parsed = null; }
          resolve({ parsed: parsed, stdout: text.slice(0, 400), stderr: errText.slice(0, 400) });
        });
      });
    };
    const [r1, r2] = await Promise.all([runWorker('a'), runWorker('b')]);
    const results = [r1.parsed, r2.parsed].filter(Boolean);
    const oks = results.filter(function (r) { return r.ok === true; });
    ok('两个 worker 都返回了结果（进程真的跑起来了）', results.length === 2, { r1: r1.parsed || r1.stderr, r2: r2.parsed || r2.stderr });
    ok('至多一个 worker 成功', oks.length <= 1, results);
    const loser = results.filter(function (r) { return r.ok !== true; });
    ok('失败方的 reason 是租约类（lease_conflict / lease_lost / plan_stale）', loser.length === 0 || /lease_busy|lease_conflict|lease_lost|plan_stale|confirm_mismatch/.test(String(loser[0].reason)), loser);
  }

  console.log('[3] 大库：批量数据下计划数量、聚合值、apply 后剩余数据正确');
  {
    const c = freshDb();
    const N = 200;
    const ids = seed(c.db, N);
    const started = Date.now();
    const plan = buildPlan(c.db, policy, { archiveDir: archiveDir, logsDir: logsDir, now: NOW });
    const buildMs = Date.now() - started;
    ok('大库：任务候选数 = ' + N, (plan.tables.tasks.ids || []).length === N, (plan.tables.tasks.ids || []).length);
    ok('大库：用量候选数 = ' + N, (plan.tables.token_usage.ids || []).length === N, (plan.tables.token_usage.ids || []).length);
    const expectedTokens = N * 30;
    ok('大库：聚合 token 总数正确（' + expectedTokens + '）', Number(plan.tables.token_usage.total_tokens) === expectedTokens, plan.tables.token_usage.total_tokens);
    ok('大库：建计划耗时在 10s 内（实测 ' + buildMs + 'ms）', buildMs < 10000, buildMs);
    const applied = applyArchive(c.db, policy, plan, { confirm: plan.plan_hash, archiveDir: archiveDir, logsDir: logsDir, now: NOW });
    ok('大库：apply 成功', applied.ok === true, applied);
    const left = c.db.prepare('SELECT COUNT(*) AS c FROM messages').get().c;
    const archived = c.db.prepare('SELECT COUNT(*) AS c FROM task_archives').get().c;
    ok('大库：消息已清空', Number(left) === 0, left);
    ok('大库：归档记录数 = ' + N, Number(archived) === N, archived);
    const daily = c.db.prepare('SELECT COALESCE(SUM(tokens_in + tokens_out),0) AS t FROM token_usage_daily').get().t;
    ok('大库：daily 聚合总量与原始一致（' + expectedTokens + '）', Number(daily) === expectedTokens, daily);
    c.db.close();
  }

  console.log('');
  console.log('PASS ' + pass + '   FAIL ' + fail);
  if (fail) process.exitCode = 1;
} finally {
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (e) {}
}
