#!/usr/bin/env node
// 第 2 项：项目范围归档。核心不变量——项目计划里**不得**出现别的项目的任何 row 或日志，
// 无 task_id 的历史用量也不得进入项目计划（否则一次项目归档会折叠/删除别的项目的用量）。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import * as S from './store.mjs';
import { buildPlan, applyArchive, archiveReadiness } from './archive.mjs';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'agentbus-scope-'));
const archiveDir = path.join(tmp, 'archives');
const logsDir = path.join(tmp, 'logs');
fs.mkdirSync(logsDir, { recursive: true });
const dbFile = path.join(tmp, 'bus.db');
const db = S.openDb(dbFile);
S.setRuntimeState(db, 'human', true);

const placeholderPolicy = path.join(tmp, 'policy-placeholder.json');
const base = JSON.parse(fs.readFileSync(path.join(S.BUS_DIR, 'policy.json'), 'utf8'));
base.agents = Object.assign({}, base.agents, {
  'worker/main': { autonomy: 'auto', may_dispatch_to: ['*'], max_open_from_agents: 100, max_concurrent: 5 },
});
fs.writeFileSync(placeholderPolicy, JSON.stringify(base));
process.env.BUS_POLICY_PATH = placeholderPolicy;

const NOW = new Date('2026-06-01T00:00:00.000Z');
const RETENTION = { terminal_task_days: 30, message_days: 30, guard_event_days: 30, raw_usage_days: 30, log_days: 30, max_single_log_bytes: 0 };
const policy = {
  lead: 'lead/main',
  permissions: { dispatch: ['lead/main'], accept: ['human'], merge: ['human'], reassign: ['lead/main'] },
  global: {}, economics: {}, retention: RETENTION, agents: { 'worker/main': { max_concurrent: 5 } },
};
const MSG_INSERT = 'INSERT INTO messages(msg_id,ts,sender,recipient,thread,kind,body,hop) VALUES(?,?,?,?,?,?,?,?)';
function daysAgo(n) { return new Date(NOW.getTime() - n * 86400000).toISOString(); }
function sha256(buf) { return crypto.createHash('sha256').update(buf).digest('hex'); }

let pass = 0, fail = 0;
function ok(name, value, detail) {
  if (value) { pass += 1; console.log('  PASS  ' + name); }
  else { fail += 1; console.log('  FAIL  ' + name + (detail === undefined ? '' : ' — ' + JSON.stringify(detail).slice(0, 300))); }
}

function seedTask(project, title) {
  const task = S.createTask(db, { title: title, status: 'open', project: project });
  db.prepare("UPDATE tasks SET status='done', updated_at=?, body='旧正文' WHERE id=?").run(daysAgo(120), task.id);
  return task;
}
function seedMessage(msgId, thread) {
  db.prepare(MSG_INSERT).run(msgId, daysAgo(120), 'worker/main', 'human', thread, 'note', '旧消息', 0);
  return db.prepare('SELECT seq FROM messages WHERE msg_id = ?').get(msgId).seq;
}
function seedUsage(taskId, tokensIn, tokensOut) {
  S.recordUsage(db, 'worker/main', taskId, 'execute', tokensIn, tokensOut);
  db.prepare('UPDATE token_usage SET ts = ? WHERE task_id = ? AND ts IS NOT NULL').run(daysAgo(120), taskId);
  return db.prepare('SELECT id FROM token_usage WHERE task_id = ?').get(taskId).id;
}
function seedArchivedLog(taskId, name) {
  const rel = name + '.log';
  const full = path.join(logsDir, rel);
  fs.writeFileSync(full, name + ' log\n');
  const old = new Date(daysAgo(120));
  fs.utimesSync(full, old, old);
  const digest = sha256(fs.readFileSync(full));
  db.prepare('INSERT OR REPLACE INTO task_archives(task_id, archive_path, archived_at, sha256, bytes) VALUES(?,?,?,?,?)')
    .run(taskId, path.join(archiveDir, taskId + '.jsonl.gz'), daysAgo(120), 'x', 1);
  db.prepare('INSERT INTO artifact_refs(task_id, kind, relative_path, sha256, size) VALUES(?,?,?,?,?)')
    .run(taskId, 'log', rel, digest, fs.statSync(full).size);
}

try {
  console.log('[1] 夹具：两个项目各一套过期数据 + 一条无 task_id 的历史用量');
  const taskA = seedTask('proj-a', 'A 的旧任务');
  const taskB = seedTask('proj-b', 'B 的旧任务');
  seedMessage('m-a', taskA.id);
  seedMessage('m-b', taskB.id);
  const usageA = seedUsage(taskA.id, 10, 20);
  const usageB = seedUsage(taskB.id, 30, 40);
  db.prepare('INSERT INTO token_usage(agent, task_id, phase, tokens_in, tokens_out, ts) VALUES(?,?,?,?,?,?)')
    .run('worker/main', null, 'execute', 99, 99, daysAgo(120));
  const orphanUsageId = db.prepare('SELECT id FROM token_usage WHERE task_id IS NULL').get().id;
  // 已归档任务（只为给 logCandidates 提供 artifact_refs 的 join 来源）：
  // 注意不能把 taskA/taskB 塞进 task_archives —— 任务候选查询会排除已归档任务。
  const archivedA = seedTask('proj-a', 'A 的已归档任务');
  const archivedB = seedTask('proj-b', 'B 的已归档任务');
  seedArchivedLog(archivedA.id, 'a');
  seedArchivedLog(archivedB.id, 'b');
  ok('夹具就绪（2 项目 + 1 条孤儿用量 + 2 条已归档日志）', true);

  console.log('[2] 项目计划只含本项目');
  const planA = buildPlan(db, policy, { project: 'proj-a', archiveDir, logsDir, now: NOW });
  const planB = buildPlan(db, policy, { project: 'proj-b', archiveDir, logsDir, now: NOW });
  ok('scope 写明项目', planA.scope && planA.scope.type === 'project' && planA.scope.project_id === 'proj-a', planA.scope);
  ok('任务候选只有 A 的任务', JSON.stringify(planA.tables.tasks.ids || []) === JSON.stringify([taskA.id]), planA.tables.tasks.ids);
  ok('B 的任务不在 A 的计划里', (planA.tables.tasks.ids || []).indexOf(taskB.id) < 0);

  console.log('[3] 用量：只含本项目任务，孤儿用量不进项目计划');
  ok('用量候选只有 A 的用量', JSON.stringify(planA.tables.token_usage.ids || []) === JSON.stringify([usageA]), planA.tables.token_usage.ids);
  ok('B 的用量不在 A 的计划里', (planA.tables.token_usage.ids || []).indexOf(usageB) < 0);
  ok('无 task_id 的历史用量不进项目计划（跨项目污染）', (planA.tables.token_usage.ids || []).indexOf(orphanUsageId) < 0, planA.tables.token_usage.ids);

  console.log('[4] 日志/artifact 只含本项目');
  const refTasksA = (planA.tables.artifact_refs.entries || []).map(function (e) { return e.task_id; });
  ok('artifact 候选只属于 A 项目', refTasksA.length === 1 && refTasksA[0] === archivedA.id, refTasksA);
  ok('B 项目的 artifact 不在 A 的计划里', refTasksA.indexOf(archivedB.id) < 0);

  console.log('[5] scope 参与 plan_hash，确认必须带同一个 project');
  ok('两个项目的 plan_hash 不同', planA.plan_hash !== planB.plan_hash);
  const wrongScope = applyArchive(db, policy, planA, { confirm: planA.plan_hash, project: 'proj-b', archiveDir, logsDir, now: NOW });
  ok('拿 A 的确认去跑 B → scope_mismatch', wrongScope.ok === false && wrongScope.reason === 'scope_mismatch', wrongScope);
  const noScope = applyArchive(db, policy, planA, { confirm: planA.plan_hash, archiveDir, logsDir, now: NOW });
  ok('项目计划不能当全库计划执行（scope_mismatch）', noScope.ok === false && noScope.reason === 'scope_mismatch', noScope);

  console.log('[6] 执行只删本项目，别项目与孤儿用量原样保留');
  const applied = applyArchive(db, policy, planA, { confirm: planA.plan_hash, project: 'proj-a', archiveDir, logsDir, now: NOW });
  ok('A 的计划执行成功', applied.ok === true, applied);
  const bTaskStill = db.prepare('SELECT COUNT(*) AS c FROM tasks WHERE id = ?').get(taskB.id).c;
  const bUsageStill = db.prepare('SELECT COUNT(*) AS c FROM token_usage WHERE id = ?').get(usageB).c;
  const orphanStill = db.prepare('SELECT COUNT(*) AS c FROM token_usage WHERE id = ?').get(orphanUsageId).c;
  ok('B 的任务仍在', bTaskStill === 1);
  ok('B 的用量仍在（没被 A 的归档折叠掉）', bUsageStill === 1);
  ok('孤儿用量仍在', orphanStill === 1);
  // 设计是「任务主体保留、只清大字段」：断言 body 已清空且写进了 task_archives。
  const keptTask = db.prepare('SELECT body FROM tasks WHERE id = ?').get(taskA.id);
  const archivedRow = db.prepare('SELECT COUNT(*) AS c FROM task_archives WHERE task_id = ?').get(taskA.id).c;
  ok('A 的任务主体保留但正文已清空，且写入 task_archives', !!keptTask && keptTask.body == null && archivedRow === 1, { body: keptTask && keptTask.body, archivedRow });

  console.log('[7] 重复执行幂等');
  const again = applyArchive(db, policy, planA, { confirm: planA.plan_hash, project: 'proj-a', archiveDir, logsDir, now: NOW });
  ok('同一计划重复执行不会二次删除', (again.ok === true || again.reason === 'plan_stale' || again.reason === 'nothing_to_do'), again);
  ok('B 的用量仍为 1（重复执行没有波及）', db.prepare('SELECT COUNT(*) AS c FROM token_usage WHERE id = ?').get(usageB).c === 1);

  console.log('[8b] readiness 自建临时目录必须清理，显式目录必须保留');
  const tmpDirs = function () {
    try { return fs.readdirSync(os.tmpdir()).filter(function (n) { return n.indexOf('agentbus-readiness-') === 0; }).length; } catch (e) { return -1; }
  };
  const before = tmpDirs();
  const readyOk = archiveReadiness(db, policy, { now: NOW });
  ok('成功路径：snapshot_ephemeral=true 且 snapshot_dir 为 null（不返回已删路径）', readyOk.snapshot_ephemeral === true && readyOk.snapshot_dir === null && readyOk.snapshot_retained === false, { e: readyOk.snapshot_ephemeral, d: readyOk.snapshot_dir });
  ok('成功路径：临时目录没有残留', tmpDirs() === before, { before, after: tmpDirs() });
  const explicitDir = path.join(tmp, 'explicit-readiness');
  fs.mkdirSync(explicitDir, { recursive: true });
  const readyKept = archiveReadiness(db, policy, { now: NOW, archiveDir: explicitDir });
  ok('显式 archiveDir：snapshot_retained=true 且目录仍在', readyKept.snapshot_retained === true && readyKept.snapshot_ephemeral === false && fs.existsSync(explicitDir), { k: readyKept.snapshot_retained });
  ok('显式 archiveDir 里有快照文件（不是空壳）', fs.readdirSync(explicitDir).length > 0, fs.readdirSync(explicitDir));
  // 失败路径：archiveDir 指向一个普通文件 → takeSnapshot 必然失败，仍不得泄漏临时目录。
  const badDir = path.join(tmp, 'not-a-dir');
  fs.writeFileSync(badDir, 'x');
  const beforeBad = tmpDirs();
  const readyBad = archiveReadiness(db, policy, { now: NOW, archiveDir: badDir });
  ok('snapshot 失败路径：ready=false 且不泄漏临时目录', readyBad.ready === false && tmpDirs() === beforeBad, { ready: readyBad.ready, before: beforeBad, after: tmpDirs() });
  // 异常路径：now 的 valueOf 抛错 → 走 finally。
  const beforeThrow = tmpDirs();
  let threw = false;
  try { archiveReadiness(db, policy, { now: { valueOf: function () { throw new Error('boom'); } } }); } catch (e) { threw = true; }
  ok('异常路径：抛错后临时目录仍被清理', threw === true && tmpDirs() === beforeThrow, { threw, before: beforeThrow, after: tmpDirs() });

  console.log('[9] fence：屏障内被接管后旧 worker 不得提交');
  const taskC = seedTask('proj-a', 'C 的旧任务');
  const planC = buildPlan(db, policy, { project: 'proj-a', archiveDir, logsDir, now: NOW });
  let bumped = null;
  const takenOver = applyArchive(db, policy, planC, {
    confirm: planC.plan_hash, project: 'proj-a', archiveDir, logsDir, now: NOW,
    hooks: { duringBarrier: function () {
      // 模拟另一个 worker 在这期间接管了租约：换 holder 并递增 fence_token
      db.prepare("INSERT INTO archive_leases(id,holder,acquired_at,expires_at,note,fence_token) VALUES('archive','other-worker',?,?,NULL,99) " +
        'ON CONFLICT(id) DO UPDATE SET holder=excluded.holder, fence_token=excluded.fence_token').run(NOW.toISOString(), new Date(NOW.getTime() + 3600000).toISOString());
      bumped = db.prepare("SELECT fence_token FROM archive_leases WHERE id='archive'").get().fence_token;
    } },
  });
  ok('被接管后 apply 失败且 reason=lease_lost', takenOver.ok === false && takenOver.reason === 'lease_lost', takenOver);
  ok('旧 worker 没有删掉任何任务（C 仍在库里）', db.prepare('SELECT COUNT(*) AS c FROM tasks WHERE id = ?').get(taskC.id).c === 1, { fence: bumped });

  console.log('[8] 全库计划仍然包含孤儿用量（对照）');
  const globalPlan = buildPlan(db, policy, { archiveDir, logsDir, now: NOW });
  ok('全库计划的 scope 是 global', globalPlan.scope && globalPlan.scope.type === 'global', globalPlan.scope);
  ok('全库计划包含孤儿用量', (globalPlan.tables.token_usage.ids || []).indexOf(orphanStill ? orphanUsageId : -1) >= 0, globalPlan.tables.token_usage.ids);

  console.log('');
  console.log('PASS ' + pass + '   FAIL ' + fail);
  if (fail) process.exitCode = 1;
} finally {
  try { db.close(); } catch (e) {}
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (e) {}
}
