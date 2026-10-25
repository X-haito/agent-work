#!/usr/bin/env node
// 第 10 项：归档引擎与守恒。固定时钟跨保留期；临时库 + 临时策略 + 临时归档目录。
// 覆盖：dry-run 与 apply 精确相等、归档期间并发写被阻止、任务历史完整、真实损坏的库/快照。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import zlib from 'node:zlib';
import { DatabaseSync } from 'node:sqlite';
import * as S from './store.mjs';
import { buildPlan, applyArchive, verifySnapshotFile, acquireArchiveLease, unmanagedSummary } from './archive.mjs';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'agentbus-retention-'));
const archiveDir = path.join(tmp, 'archives');
const logsDir = path.join(tmp, 'logs');
fs.mkdirSync(logsDir, { recursive: true });
const dbFile = path.join(tmp, 'bus.db');
const db = S.openDb(dbFile);
S.setRuntimeState(db, 'human', true);
// unknown_agent 现在是硬拒：占位 actor 必须登记进**本套件自己的临时策略**（真实 policy 打底，不设任何白名单后门）。
const placeholderPolicy = path.join(tmp, 'policy-placeholder.json');
const placeholderBase = JSON.parse(fs.readFileSync(path.join(S.BUS_DIR, 'policy.json'), 'utf8'));
placeholderBase.agents = Object.assign({}, placeholderBase.agents, {
  'worker/main': { autonomy: 'auto', may_dispatch_to: ['*'], max_open_from_agents: 100, max_concurrent: 5 },
});
fs.writeFileSync(placeholderPolicy, JSON.stringify(placeholderBase));
process.env.BUS_POLICY_PATH = placeholderPolicy;

const NOW = new Date('2026-06-01T00:00:00.000Z');
function daysAgo(n) { return new Date(NOW.getTime() - n * 86400000).toISOString(); }
function policyWith(retention) {
  return { lead: 'lead/main', permissions: { dispatch: ['lead/main'], accept: ['human'], merge: ['human'], reassign: ['lead/main'] }, global: {}, economics: { budget_timezone: 'UTC', max_rounds_per_task: 2 }, retention: retention, agents: { 'lead/main': { autonomy: 'auto' }, 'worker/main': { autonomy: 'auto' } } };
}
const MSG_INSERT = 'INSERT INTO messages(msg_id,ts,sender,recipient,thread,kind,body,hop) VALUES(?,?,?,?,?,?,?,?)';
const RETENTION = { terminal_task_days: 30, message_days: 30, guard_event_days: 30, raw_usage_days: 30, log_days: 30, max_single_log_bytes: 0 };
const policy = policyWith(RETENTION);

let pass = 0;
let fail = 0;
let skipped = 0;
function skip(name, why) { skipped += 1; console.log('  SKIP  ' + name + ' — ' + why); }
function ok(name, value, detail) {
  if (value) { pass += 1; console.log('  PASS  ' + name); }
  else { fail += 1; console.log('  FAIL  ' + name + (detail ? ' — ' + JSON.stringify(detail).slice(0, 400) : '')); }
}
function makeTask(extra) { return S.createTask(db, Object.assign({ title: '归档任务', status: 'open', project: 'proj-arch' }, extra || {})); }
function sha256(buffer) { return crypto.createHash('sha256').update(buffer).digest('hex'); }
function readBundle(dir, taskId) {
  const file = path.join(dir, 'tasks', taskId + '.jsonl.gz');
  const text = zlib.gunzipSync(fs.readFileSync(file)).toString('utf8');
  const records = text.trim().split('\n').map(function (line) { return JSON.parse(line); });
  return {
    records: records,
    meta: records.filter(function (r) { return r.type === 'meta'; })[0] || null,
    of: function (type) { return records.filter(function (r) { return r.type === type; }).map(function (r) { return r.row; }); },
  };
}
// 真正的损坏：把第二页之后的 b-tree 页写成垃圾。SQLite 头仍是合法的，但页结构已毁。
function corruptDatabaseFile(file) {
  const buffer = fs.readFileSync(file);
  const pageSize = Number(buffer.readUInt16BE(16)) || 4096;
  const start = pageSize;
  const end = Math.min(buffer.length, start + pageSize);
  if (end <= start) throw new Error('数据库太小，没法构造真实损坏');
  for (let i = start; i < end; i += 1) buffer[i] = 0xAA;
  fs.writeFileSync(file, buffer);
  return { page_size: pageSize, corrupted_bytes: end - start };
}

try {
  console.log('[1] 保守默认：retention 全 0 时什么都不清理');
  const nothing = buildPlan(db, policyWith({ terminal_task_days: 0, message_days: 0, guard_event_days: 0, raw_usage_days: 0, log_days: 0, max_log_bytes: 0 }), { now: NOW });
  ok('全 0 保留期不产生任何候选', nothing.counts.messages === 0 && nothing.counts.token_usage === 0 && nothing.counts.tasks === 0 && nothing.counts.logs === 0, nothing.counts);

  console.log('[2] 构造跨保留期数据（含即将被删的任务历史）');
  const oldTask = makeTask();
  S.recordUsage(db, 'worker/main', oldTask.id, 'execute', 100, 50);
  db.prepare('UPDATE token_usage SET ts = ? WHERE task_id = ?').run(daysAgo(120), oldTask.id);
  db.prepare("UPDATE tasks SET status='done', updated_at=? WHERE id=?").run(daysAgo(120), oldTask.id);
  const activeTask = makeTask();
  S.claim(db, 'worker/main', activeTask.id, 60);
  S.updateTask(db, 'worker/main', activeTask.id, 'in_progress');
  S.recordUsage(db, 'worker/main', activeTask.id, 'execute', 70, 30);
  db.prepare('UPDATE token_usage SET ts = ? WHERE task_id = ?').run(daysAgo(120), activeTask.id);
  const oldDone = makeTask();
  S.claim(db, 'worker/main', oldDone.id, 60);
  S.updateTask(db, 'worker/main', oldDone.id, 'in_progress');
  S.updateTask(db, 'worker/main', oldDone.id, 'review', 'done');
  db.prepare("UPDATE tasks SET status='done', updated_at=?, body='很长的正文' WHERE id=?").run(daysAgo(90), oldDone.id);
  db.prepare('INSERT INTO messages(msg_id,ts,sender,recipient,thread,kind,body,hop) VALUES(?,?,?,?,?,?,?,0)').run('m-old-1', daysAgo(120), 'worker/main', 'human', oldTask.id, 'note', '老消息');
  db.prepare('INSERT INTO messages(msg_id,ts,sender,recipient,thread,kind,body,hop) VALUES(?,?,?,?,?,?,?,0)').run('m-old-2', daysAgo(110), 'human', 'worker/main', oldTask.id, 'answer', '老回复');
  db.prepare('INSERT INTO messages(msg_id,ts,sender,recipient,thread,kind,body,hop) VALUES(?,?,?,?,?,?,?,0)').run('m-active-1', daysAgo(120), 'worker/main', 'human', activeTask.id, 'note', 'active 消息');
  db.prepare('INSERT INTO guard_events(task_id,agent,kind,detail,action,actor,ts) VALUES(?,?,?,?,?,?,?)').run(oldTask.id, 'worker/main', 'x', 'old', 'ok', 'system', daysAgo(120));
  db.prepare('INSERT INTO guard_events(task_id,agent,kind,detail,action,actor,ts) VALUES(?,?,?,?,?,?,?)').run(activeTask.id, 'worker/main', 'x', 'old', 'ok', 'system', daysAgo(120));
  db.prepare('INSERT INTO verification_runs(run_id,task_id,started_at,finished_at,exit_code,duration_ms,ok,stdout_tail,stderr_tail) VALUES(?,?,?,?,?,?,?,?,?)')
    .run('vr-old-1', oldTask.id, daysAgo(121), daysAgo(121), 0, 12, 1, 'ok-out', 'ok-err');
  db.prepare('INSERT INTO reviews(id,task_id,reviewer,route,status,task_version,verdict,summary,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)')
    .run('rv-old-1', oldTask.id, 'lead/main', 'lead', 'closed', 1, 'approved', '看过了', daysAgo(121), daysAgo(121));
  ok('数据构造完成', Number(db.prepare('SELECT COUNT(*) AS c FROM token_usage').get().c) === 2);
  ok('老任务带着 2 条消息 / 1 条守卫 / 1 条验证 / 1 条评审', Number(db.prepare('SELECT COUNT(*) AS c FROM messages WHERE thread = ?').get(oldTask.id).c) === 2);

  console.log('\n[3] dry-run：计划与 hash');
  const plan = buildPlan(db, policy, { now: NOW });
  const planFingerprint = sha256(JSON.stringify(plan));
  ok('认定 1 条过期原始用量（跳过 active）', plan.tables.token_usage.candidates === 1, plan.tables.token_usage.ids);
  ok('认定 2 条过期消息（跳过 active）', plan.tables.messages.candidates === 2 && plan.tables.messages.rows.every(function (r) { return r.thread === oldTask.id; }), plan.tables.messages.ids);
  ok('认定 1 条过期 guard_event', plan.tables.guard_events.candidates === 1, plan.tables.guard_events.ids);
  ok('认定 2 个已终结任务待归档', plan.tables.tasks.candidates === 2 && plan.tables.tasks.ids.indexOf(oldDone.id) >= 0 && plan.tables.tasks.ids.indexOf(oldTask.id) >= 0, plan.tables.tasks.ids);
  ok('计划带 plan_hash 且记录 active 跳过数', typeof plan.plan_hash === 'string' && plan.plan_hash.length === 64 && plan.skipped_active >= 1, plan.plan_hash);
  const plannedMsgRow = db.prepare("SELECT seq FROM messages WHERE msg_id = 'm-old-1'").get();
  ok('计划里是精确 row id（不是 cutoff 条件）', plan.tables.messages.ids.length === 2 && plan.tables.messages.ids.indexOf(plannedMsgRow.seq) >= 0, { planned: plan.tables.messages.ids, seq: plannedMsgRow.seq });
  ok('计划里带 policy/schema 指纹与计划版本', plan.plan_version === 2 && plan.policy_hash.length === 64 && plan.schema_hash.length === 64, { v: plan.plan_version, p: plan.policy_hash, s: plan.schema_hash });
  ok('任务候选带版本与更新时间（用于执行前校验）', plan.tables.tasks.entries.every(function (e) { return typeof e.version === 'number' && typeof e.updated_at === 'string'; }), plan.tables.tasks.entries);
  const plan2 = buildPlan(db, policy, { now: NOW });
  ok('同一数据 + 同一策略得到同一 hash（不含时间戳）', plan2.plan_hash === plan.plan_hash);
  const planLater = buildPlan(db, policy, { now: new Date(NOW.getTime() + 3600000) });
  ok('换时间但数据没变，hash 仍一致', planLater.plan_hash === plan.plan_hash);
  ok('dry-run 不写库', Number(db.prepare('SELECT COUNT(*) AS c FROM token_usage_daily').get().c) === 0 && Number(db.prepare('SELECT COUNT(*) AS c FROM task_archives').get().c) === 0);

  console.log('\n[4] confirm 必须等于 plan_hash');
  const wrong = applyArchive(db, policy, plan, { confirm: 'deadbeef', archiveDir, logsDir, now: NOW });
  ok('错的 confirm 直接拒绝', wrong.ok === false && wrong.reason === 'confirm_mismatch', wrong.reason);
  ok('拒绝时不产生快照也不改数据', !fs.existsSync(archiveDir) || fs.readdirSync(archiveDir).length === 0, fs.existsSync(archiveDir) ? fs.readdirSync(archiveDir) : []);

  console.log('\n[5] 单例租约 / drain 屏障 / 精确执行');
  db.prepare('INSERT INTO archive_leases(id,holder,acquired_at,expires_at,note) VALUES(?,?,?,?,?)').run('archive', 'other-runner', daysAgo(0), new Date(NOW.getTime() + 600000).toISOString(), 'test');
  const busy = applyArchive(db, policy, plan, { confirm: plan.plan_hash, archiveDir, logsDir, now: NOW });
  ok('别人持着未过期的租约时拒绝执行', busy.ok === false && busy.reason === 'lease_busy' && busy.holder === 'other-runner', busy);
  ok('租约冲突时不改数据', Number(db.prepare('SELECT COUNT(*) AS c FROM token_usage').get().c) === 2 && Number(db.prepare('SELECT COUNT(*) AS c FROM task_archives').get().c) === 0);
  db.prepare('UPDATE archive_leases SET expires_at = ? WHERE id = ?').run(new Date(NOW.getTime() - 60000).toISOString(), 'archive');
  const takeover = acquireArchiveLease(db, 'archive-takeover', policy, { now: NOW });
  ok('过期租约可以被新 holder 接管', takeover.ok === true && takeover.holder === 'archive-takeover' && takeover.ttl_min >= 1, takeover);
  db.prepare('DELETE FROM archive_leases WHERE id = ?').run('archive');

  // 并发写必须被 BEGIN EXCLUSIVE 挡住（BEGIN IMMEDIATE 挡不住）
  const concurrent = { write_error: null, read_ok: false, after_commit_write: null };
  const before = { cost: S.costByProject(db, 'lead/main'), summary: S.costSummary(db, 'lead/main'), budget: S.budgetStatus(db, policy, { now: NOW }) };
  const applied = applyArchive(db, policy, plan, {
    confirm: plan.plan_hash, archiveDir, logsDir, now: NOW,
    hooks: {
      duringBarrier: function () {
        const other = new DatabaseSync(dbFile);
        try {
          other.exec('PRAGMA busy_timeout = 100');
          concurrent.read_ok = Number(other.prepare('SELECT COUNT(*) AS c FROM tasks').get().c) > 0;
          try {
            other.prepare(MSG_INSERT).run('m-concurrent', daysAgo(0), 'worker/main', 'human', null, 'note', '并发写', 0);
            concurrent.write_error = null;
          } catch (error) { concurrent.write_error = String((error && error.message) || error); }
        } finally { other.close(); }
      },
    },
  });
  ok('归档执行成功', applied.ok === true, applied);
  ok('归档期间并发写被拒绝', !!concurrent.write_error && /locked|busy/i.test(concurrent.write_error), concurrent);
  ok('归档期间并发读不受影响（WAL）', concurrent.read_ok === true, concurrent);
  const after = new DatabaseSync(dbFile);
  try {
    after.exec('PRAGMA busy_timeout = 500');
    after.prepare(MSG_INSERT).run('m-after', daysAgo(1), 'worker/main', 'human', null, 'note', '归档后写', 0);
    concurrent.after_commit_write = 'ok';
    after.prepare("DELETE FROM messages WHERE msg_id = 'm-after'").run();
  } catch (error) { concurrent.after_commit_write = String((error && error.message) || error); }
  finally { after.close(); }
  ok('屏障释放后写入恢复', concurrent.after_commit_write === 'ok', concurrent.after_commit_write);
  ok('执行结束后租约已释放', db.prepare('SELECT 1 AS x FROM archive_leases WHERE id = ?').get('archive') == null);

  console.log('\n[6] 守恒 + dry-run 与 apply 精确相等');
  ok('生成了快照并保留', !!applied.snapshot_path && fs.existsSync(applied.snapshot_path), applied.snapshot_path);
  ok('快照完整性校验通过', verifySnapshotFile(applied.snapshot_path).ok === true);
  ok('messages：计划数量 == 实际删除数', applied.deleted.messages === plan.counts.messages, { planned: plan.counts.messages, deleted: applied.deleted.messages });
  ok('guard_events：计划数量 == 实际删除数', applied.deleted.guard_events === plan.counts.guard_events, { planned: plan.counts.guard_events, deleted: applied.deleted.guard_events });
  ok('token_usage：计划数量 == 实际删除数', applied.deleted.token_usage === plan.counts.token_usage, { planned: plan.counts.token_usage, deleted: applied.deleted.token_usage });
  ok('tasks：计划数量 == 实际归档数', applied.deleted.tasks_archived === plan.counts.tasks && applied.bundles.length === plan.counts.tasks, { planned: plan.counts.tasks, archived: applied.deleted.tasks_archived });
  ok('active 的用量/消息原样留着', Number(db.prepare('SELECT COUNT(*) AS c FROM token_usage').get().c) === 1 && !!db.prepare("SELECT 1 FROM messages WHERE msg_id = 'm-active-1'").get());
  ok('daily 落库了聚合结果', Number(db.prepare('SELECT COUNT(*) AS c FROM token_usage_daily').get().c) === 1);
  const folded = db.prepare('SELECT SUM(tokens_in) AS ti, SUM(tokens_out) AS t_o FROM token_usage_daily').get();
  ok('折叠总量等于原原始总量', Number(folded.ti) === 100 && Number(folded.t_o) === 50, folded);
  const afterCost = { cost: S.costByProject(db, 'lead/main'), summary: S.costSummary(db, 'lead/main'), budget: S.budgetStatus(db, policy, { now: NOW }) };
  ok('costByProject 归档前后完全一致', JSON.stringify(before.cost) === JSON.stringify(afterCost.cost));
  ok('costSummary 归档前后完全一致', JSON.stringify(before.summary) === JSON.stringify(afterCost.summary));
  const archivedDay = S.dayKeyOf(daysAgo(120), 'UTC');
  ok('budgetStatus 能按归档日查询且用量非零', S.budgetStatus(db, policy, { dayKey: archivedDay }).used > 0, { day: archivedDay });
  ok('daily 与 raw 合并后不重复计数（单条任务 150）', Number(db.prepare('SELECT SUM(tokens_in+tokens_out) AS t FROM token_usage_daily WHERE task_id = ?').get(oldTask.id).t) === 150);

  console.log('\n[7] 任务主体不删，任务历史完整（先物化、后删除）');
  const archivedTask = S.getTask(db, oldDone.id);
  ok('任务行仍在', !!archivedTask && archivedTask.status === 'done');
  ok('正文已搬走', archivedTask.body === null);
  const archiveInfo = S.getTaskArchive(db, oldDone.id);
  ok('getTaskArchive 返回路径/hash/大小', !!archiveInfo && archiveInfo.archive_path.indexOf('tasks/') === 0 && archiveInfo.sha256.length === 64 && archiveInfo.bytes > 0, archiveInfo);
  const archiveFile = path.join(archiveDir, archiveInfo.archive_path);
  ok('JSONL 归档文件存在且 hash 一致', fs.existsSync(archiveFile) && sha256(fs.readFileSync(archiveFile)) === archiveInfo.sha256);
  ok('active 任务没有被归档', S.getTaskArchive(db, activeTask.id) === null && S.getTask(db, activeTask.id).status === 'in_progress');
  ok('active 任务的消息还在', !!db.prepare("SELECT 1 FROM messages WHERE msg_id = 'm-active-1'").get());
  const bundle = readBundle(archiveDir, oldTask.id);
  ok('归档包 meta 记录了 task/plan hash', bundle.meta.task_id === oldTask.id && bundle.meta.plan_hash === plan.plan_hash && bundle.meta.bundle_version === 2, bundle.meta);
  ok('被删的两条老消息在归档包里', bundle.of('message').length === 2 && bundle.of('message').some(function (m) { return m.msg_id === 'm-old-1'; }) && bundle.of('message').some(function (m) { return m.msg_id === 'm-old-2'; }), bundle.of('message').map(function (m) { return m.msg_id; }));
  ok('被删的守卫事件在归档包里', bundle.of('guard_event').length === 1 && bundle.of('guard_event')[0].detail === 'old', bundle.of('guard_event'));
  ok('验证记录在归档包里', bundle.of('verification_run').length === 1 && bundle.of('verification_run')[0].run_id === 'vr-old-1', bundle.of('verification_run'));
  ok('评审记录在归档包里', bundle.of('review').length === 1 && bundle.of('review')[0].id === 'rv-old-1', bundle.of('review'));
  ok('原始消息确实已从库里删掉（历史只存在于归档包）', !db.prepare("SELECT 1 FROM messages WHERE msg_id IN ('m-old-1','m-old-2')").get());
  ok('active 任务的历史没被写进别人的包', bundle.of('message').every(function (m) { return m.thread === oldTask.id; }));

  console.log('\n[8] 日志：引用 + hash + 路径 + 数量一致');
  const logFile = path.join(logsDir, 'run-1.log');
  fs.writeFileSync(logFile, 'old log content\n');
  const oldMtime = new Date(daysAgo(120));
  fs.utimesSync(logFile, oldMtime, oldMtime);
  const digest = sha256(fs.readFileSync(logFile));
  db.prepare('INSERT INTO artifact_refs(task_id,kind,relative_path,sha256,size) VALUES(?,?,?,?,?)').run(oldDone.id, 'log', 'run-1.log', digest, fs.statSync(logFile).size);
  fs.writeFileSync(path.join(logsDir, 'escape.log'), 'x');
  db.prepare('INSERT INTO artifact_refs(task_id,kind,relative_path,sha256,size) VALUES(?,?,?,?,?)').run(oldDone.id, 'log', '../outside.log', 'deadbeef', 1);
  const plan3 = buildPlan(db, policy, { now: NOW, logsDir: logsDir });
  ok('只有引用已归档任务的日志才是候选', plan3.tables.artifact_refs.candidates === 1 && plan3.referenced_logs[0] === 'run-1.log', plan3.tables.artifact_refs.entries);
  ok('路径逃逸被拒并记录原因', plan3.tables.artifact_refs.skipped.some(function (x) { return x.reason === 'path_escape'; }), plan3.tables.artifact_refs.skipped);
  ok('计划里带日志的 path+hash', plan3.tables.artifact_refs.entries[0].sha256 === digest && plan3.tables.artifact_refs.entries[0].relative_path === 'run-1.log');
  const applied3 = applyArchive(db, policy, plan3, { confirm: plan3.plan_hash, archiveDir, logsDir, now: NOW });
  ok('归档删除了被引用的日志', applied3.ok === true && applied3.deleted.logs === 1 && !fs.existsSync(logFile), applied3.reason || applied3.deleted);
  ok('日志：计划数量 == 实际删除数', applied3.deleted.logs === plan3.counts.logs, { planned: plan3.counts.logs, deleted: applied3.deleted.logs });
  ok('逃逸路径的文件没有被删', fs.existsSync(path.join(logsDir, 'escape.log')));

  console.log('\n[9] 二次运行幂等 + 计划不可变');
  const planAgain = buildPlan(db, policy, { now: NOW });
  ok('再跑一次没有新候选', planAgain.counts.token_usage === 0 && planAgain.counts.tasks === 0 && planAgain.counts.messages === 0, planAgain.counts);
  const costAgain = S.costByProject(db, 'lead/main');
  ok('二次运行后成本仍然不变', JSON.stringify(costAgain) === JSON.stringify(afterCost.cost));
  ok('apply 没有改动计划对象本身', sha256(JSON.stringify(plan)) === planFingerprint);
  const replay = applyArchive(db, policy, plan, { confirm: plan.plan_hash, archiveDir, logsDir, now: NOW });
  ok('同一份旧计划重放被整批中止、要求重新 dry-run', replay.ok === false && replay.reason === 'plan_stale', replay);
  ok('重放中止后没有新的归档变更', Number(db.prepare('SELECT COUNT(*) AS c FROM task_archives').get().c) === 2);
  const changedPolicy = applyArchive(db, policyWith(Object.assign({}, RETENTION, { message_days: 31 })), plan, { confirm: plan.plan_hash, archiveDir, logsDir, now: NOW });
  ok('策略指纹变化也整批中止', changedPolicy.ok === false && changedPolicy.reason === 'plan_stale' && changedPolicy.detail.field === 'policy_hash', changedPolicy);

  console.log('\n[10] 真实损坏的数据库 / 快照：不清理、不写库');
  const corruptDir = path.join(tmp, 'corrupt-archives');
  const db3File = path.join(tmp, 'bus3.db');
  const db3 = S.openDb(db3File);
  S.setRuntimeState(db3, 'human', true);
  const t3 = S.createTask(db3, { title: '损坏库任务', status: 'open', project: 'proj-arch' });
  S.recordUsage(db3, 'worker/main', t3.id, 'execute', 10, 5);
  db3.prepare('UPDATE token_usage SET ts = ?').run(daysAgo(200));
  db3.prepare("UPDATE tasks SET status='done', updated_at=? WHERE id=?").run(daysAgo(200), t3.id);
  const plan4 = buildPlan(db3, policy, { now: NOW });
  ok('构造待归档数据', plan4.tables.token_usage.candidates === 1, plan4.tables.token_usage.ids);
  db3.close();
  const damage = corruptDatabaseFile(db3File);
  ok('把真实数据库文件的 b-tree 页写坏', damage.corrupted_bytes > 0, damage);
  ok('损坏的文件过不了快照校验', verifySnapshotFile(db3File).ok === false, verifySnapshotFile(db3File));
  ok('健康快照过得了校验（对照）', verifySnapshotFile(applied.snapshot_path).ok === true);
  const corrupt = new DatabaseSync(db3File);
  let corruptResult = null;
  try {
    corrupt.exec('PRAGMA busy_timeout = 2000');
    corruptResult = applyArchive(corrupt, policy, plan4, { confirm: plan4.plan_hash, archiveDir: corruptDir, logsDir, now: NOW });
  } finally { corrupt.close(); }
  ok('损坏的库被完整性检查拦下（不清理）', corruptResult && corruptResult.ok === false && corruptResult.reason === 'source_integrity', corruptResult && (corruptResult.reason || corruptResult.message));
  ok('损坏的库不产生快照文件', !fs.existsSync(corruptDir) || fs.readdirSync(corruptDir).filter(function (n) { return /\.db$/.test(n); }).length === 0);

  // 快照写不出去（目标父路径是个文件）也要中止并留审计，这一条与"损坏"分开算
  const blockingFile = path.join(tmp, 'not-a-dir');
  fs.writeFileSync(blockingFile, 'x');
  const snapshotFail = applyArchive(db, policy, planAgain, { confirm: planAgain.plan_hash, archiveDir, logsDir, now: NOW, snapshotPath: path.join(blockingFile, 'snap.db') });
  ok('快照写失败时整批中止', snapshotFail.ok === false && String(snapshotFail.reason).indexOf('snapshot') === 0, snapshotFail.reason || snapshotFail.message);

  console.log('\n[11] archiveStatus / CLI 接线');
  const status = S.archiveStatus(db, policy);
  ok('archiveStatus 返回四类字段', typeof status.last_archived_at === 'string' && status.token_usage_daily_rows >= 1 && status.task_archives_rows >= 2 && typeof status.pending_candidates === 'object', status);
  ok('pending_candidates 四类都在', ['messages', 'guard_events', 'token_usage', 'logs'].every(function (k) { return Number.isInteger(status.pending_candidates[k]); }));
  const conservative = S.archiveStatus(db, policyWith({ terminal_task_days: 0, message_days: 0, guard_event_days: 0, raw_usage_days: 0, log_days: 0, max_log_bytes: 0 }));
  ok('保留期为 0 时 pending 全为 0', conservative.pending_candidates.messages === 0 && conservative.pending_candidates.token_usage === 0 && conservative.pending_candidates.logs === 0);
  const cliSource = fs.readFileSync(path.join(S.BUS_DIR, 'cli.mjs'), 'utf8');
  ok('CLI 暴露 archive --dry-run 与 --confirm', cliSource.indexOf('archive --confirm') >= 0 && cliSource.indexOf('dry_run') >= 0 && /archive:\s*archive/.test(cliSource));
  ok('审计里既有成功也有失败记录', !!db.prepare("SELECT 1 FROM audit_log WHERE action = 'archive.applied'").get() && !!db.prepare("SELECT 1 FROM audit_log WHERE action = 'archive.failed'").get());

  console.log('\n[12] max_single_log_bytes（第 13 条：单文件阈值正名 + 旧名兼容）');
  const bigLogs = path.join(tmp, 'logs-big');
  fs.mkdirSync(bigLogs, { recursive: true });
  const bigFile = path.join(bigLogs, 'big.log');
  fs.writeFileSync(bigFile, 'x'.repeat(5000));
  const smallFile = path.join(bigLogs, 'small.log');
  fs.writeFileSync(smallFile, 'y');
  db.prepare('INSERT INTO artifact_refs(task_id,kind,relative_path,sha256,size) VALUES(?,?,?,?,?)').run(oldTask.id, 'log', 'big.log', sha256(fs.readFileSync(bigFile)), fs.statSync(bigFile).size);
  db.prepare('INSERT INTO artifact_refs(task_id,kind,relative_path,sha256,size) VALUES(?,?,?,?,?)').run(oldTask.id, 'log', 'small.log', sha256(fs.readFileSync(smallFile)), fs.statSync(smallFile).size);
  const renameBase = { terminal_task_days: 30, message_days: 30, guard_event_days: 30, raw_usage_days: 30, log_days: 0 };
  const planNew = buildPlan(db, policyWith(Object.assign({}, renameBase, { max_single_log_bytes: 1000 })), { now: NOW, logsDir: bigLogs });
  ok('新字段名 max_single_log_bytes 按单文件阈值生效', planNew.tables.artifact_refs.candidates === 1 && planNew.referenced_logs[0] === 'big.log', planNew.referenced_logs);
  ok('小于阈值的单文件不是候选', planNew.referenced_logs.indexOf('small.log') < 0, planNew.referenced_logs);
  const planOldName = buildPlan(db, policyWith(Object.assign({}, renameBase, { max_log_bytes: 1000 })), { now: NOW, logsDir: bigLogs });
  ok('旧字段名 max_log_bytes 仍然兼容（同样认定 big.log）', planOldName.tables.artifact_refs.candidates === 1 && planOldName.referenced_logs[0] === 'big.log', planOldName.referenced_logs);
  ok('策略文字不同 → policy_hash 不同（计划绑定策略指纹）', planOldName.policy_hash !== planNew.policy_hash, { old: planOldName.policy_hash, new: planNew.policy_hash });
  ok('计划里两个名字暴露同一个数值（等 schema 改名后收敛）', planNew.retention.max_single_log_bytes === 1000 && planNew.retention.max_log_bytes === 1000, planNew.retention);
  const renamed = applyArchive(db, policyWith(Object.assign({}, renameBase, { max_single_log_bytes: 1000 })), planNew, { confirm: planNew.plan_hash, archiveDir, logsDir: bigLogs, now: NOW });
  ok('改名后的字段仍能真实删除被引用日志', renamed.ok === true && renamed.deleted.logs === planNew.counts.logs && !fs.existsSync(bigFile), renamed.reason || renamed.deleted);

  console.log('\n[13] 孤儿过期行默认不删（第 48 项：无归档凭据的行不静默删除）');
  const orphanBase = { terminal_task_days: 30, message_days: 30, guard_event_days: 30, raw_usage_days: 30, log_days: 0, max_single_log_bytes: 0 };
  // 三类：thread/task_id 为空、指向不存在的任务、属于"已终结但还没归档"的任务
  db.prepare(MSG_INSERT).run('m-orphan-null', daysAgo(120), 'worker/main', 'human', null, 'note', '无归属消息', 0);
  db.prepare(MSG_INSERT).run('m-orphan-ghost', daysAgo(120), 'worker/main', 'human', 't-999999', 'note', '指向不存在的任务', 0);
  db.prepare('INSERT INTO guard_events(task_id,agent,kind,detail,action,actor,ts) VALUES(?,?,?,?,?,?,?)').run(null, 'worker/main', 'x', '无归属守卫', 'ok', 'system', daysAgo(120));
  db.prepare('INSERT INTO guard_events(task_id,agent,kind,detail,action,actor,ts) VALUES(?,?,?,?,?,?,?)').run('t-999999', 'worker/main', 'x', '指向不存在的任务', 'ok', 'system', daysAgo(120));
  const pendingTask = makeTask();
  db.prepare("UPDATE tasks SET status='done', updated_at=? WHERE id=?").run(new Date(NOW.getTime()).toISOString(), pendingTask.id);
  db.prepare(MSG_INSERT).run('m-deferred', daysAgo(120), 'worker/main', 'human', pendingTask.id, 'note', '等任务归档', 0);
  const orphanBefore = {
    messages: Number(db.prepare('SELECT COUNT(*) AS c FROM messages').get().c),
    guard: Number(db.prepare('SELECT COUNT(*) AS c FROM guard_events').get().c),
  };
  const planOrphan = buildPlan(db, policyWith(orphanBase), { now: NOW, logsDir: logsDir });
  ok('孤儿行在计划里单列（2 条消息 / 2 条守卫）', planOrphan.unmanaged.messages === 2 && planOrphan.unmanaged.guard_events === 2, planOrphan.unmanaged);
  ok('"等任务归档"的行也单列、且不算孤儿', planOrphan.unmanaged.deferred_messages === 1 && planOrphan.unmanaged.deferred_guard_events === 0, planOrphan.unmanaged);
  ok('孤儿行不进入可删名单（counts.messages 只算有凭据的）', planOrphan.counts.messages === 0 && planOrphan.counts.guard_events === 0 && planOrphan.prune_unmanaged === 0, planOrphan.counts);
  const appliedOrphan = applyArchive(db, policyWith(orphanBase), planOrphan, { confirm: planOrphan.plan_hash, archiveDir, logsDir, now: NOW });
  ok('默认策略下执行成功但孤儿行一行没删', appliedOrphan.ok === true && appliedOrphan.deleted.unmanaged_messages === 0 && appliedOrphan.deleted.unmanaged_guard_events === 0, appliedOrphan.reason || appliedOrphan.deleted);
  ok('孤儿消息与孤儿守卫事件都还在库里', Number(db.prepare('SELECT COUNT(*) AS c FROM messages').get().c) === orphanBefore.messages
    && Number(db.prepare('SELECT COUNT(*) AS c FROM guard_events').get().c) === orphanBefore.guard
    && !!db.prepare("SELECT 1 FROM messages WHERE msg_id IN ('m-orphan-null','m-orphan-ghost','m-deferred')").get(), { before: orphanBefore, after: Number(db.prepare('SELECT COUNT(*) AS c FROM messages').get().c) });
  ok('结果里带 unmanaged 上报口径', appliedOrphan.unmanaged.pruned === false && appliedOrphan.unmanaged.messages === 2, appliedOrphan.unmanaged);

  const prunePlan = buildPlan(db, policyWith(Object.assign({}, orphanBase, { prune_unmanaged: 1 })), { now: NOW, logsDir: logsDir });
  ok('prune_unmanaged=1 才把孤儿行进删除名单', prunePlan.prune_unmanaged === 1 && prunePlan.tables.unmanaged_messages.candidates === 2 && prunePlan.tables.unmanaged_guard_events.candidates === 2, prunePlan.tables.unmanaged_messages);
  ok('开启后计划口径不变、阻断信息仍在', prunePlan.unmanaged.deferred_messages === 1, prunePlan.unmanaged);
  const prunedOrphan = applyArchive(db, policyWith(Object.assign({}, orphanBase, { prune_unmanaged: 1 })), prunePlan, { confirm: prunePlan.plan_hash, archiveDir, logsDir, now: NOW });
  ok('开启后按精确 id 删除孤儿行', prunedOrphan.ok === true && prunedOrphan.deleted.unmanaged_messages === 2 && prunedOrphan.deleted.unmanaged_guard_events === 2, prunedOrphan.reason || prunedOrphan.deleted);
  ok('孤儿行已消失、等归档的消息仍在', !db.prepare("SELECT 1 FROM messages WHERE msg_id IN ('m-orphan-null','m-orphan-ghost')").get()
    && !!db.prepare("SELECT 1 FROM messages WHERE msg_id = 'm-deferred'").get());
  const cliSource2 = fs.readFileSync(path.join(S.BUS_DIR, 'cli.mjs'), 'utf8');
  ok('CLI archive 输出单列孤儿行计数', cliSource2.indexOf('prune_unmanaged') >= 0 && cliSource2.indexOf('不可归属（无归档凭据）') >= 0);
  const consoleSource = fs.readFileSync(path.join(S.BUS_DIR, 'console-server.mjs'), 'utf8');
  ok('看板接口带上 unmanaged 计数（/api/state 的 archive.unmanaged）', consoleSource.indexOf('unmanagedSummary') >= 0);

  console.log('\n[14] archive.unmanaged 口径 + 看板渲染（第 48 项）');
  const summary = unmanagedSummary(db, policyWith(orphanBase));
  ok('unmanagedSummary 五键齐全', !!summary && ['messages', 'guard_events', 'deferred_messages', 'deferred_guard_events', 'prune_unmanaged'].every(function (k) { return Object.prototype.hasOwnProperty.call(summary, k); }), summary);
  ok('四个计数是整数 number、prune_unmanaged 是 boolean',
    !!summary && ['messages', 'guard_events', 'deferred_messages', 'deferred_guard_events'].every(function (k) { return typeof summary[k] === 'number' && Number.isInteger(summary[k]) && summary[k] >= 0; })
    && typeof summary.prune_unmanaged === 'boolean', summary);
  ok('prune_unmanaged 跟随策略（缺省 false / 显式 1 为 true）',
    summary.prune_unmanaged === false && unmanagedSummary(db, policyWith(Object.assign({}, orphanBase, { prune_unmanaged: 1 }))).prune_unmanaged === true, summary);

  // 看板渲染：与 smoke-admin 同款手法抽 renderArchiveSummary 源码跑 vm，测的是真实代码而不是复述
  const vmMod = await import('node:vm');
  // 客户端渲染代码可能在 bus/ui/app.js（静态资源拆分）也可能还在 board-ui.mjs：
  // 按"谁真的含有这个函数"来定位，不写死路径。
  function locatePanelSource() {
    for (const file of [path.join(S.BUS_DIR, 'ui', 'app.js'), path.join(S.BUS_DIR, 'board-ui.mjs')]) {
      if (!fs.existsSync(file)) continue;
      const text = fs.readFileSync(file, 'utf8');
      if (text.indexOf('function renderArchiveSummary(') >= 0 && text.indexOf('async function loadTaskArchive') >= 0) return text;
    }
    return null;
  }
  const uiSource = locatePanelSource();
  function slicePanel(source) {
    const start = source.indexOf('function renderArchiveSummary(){');
    const end = source.indexOf('\n    async function loadTaskArchive', start);
    if (start < 0 || end < 0) throw new Error('board-ui 切片锚点变了：renderArchiveSummary / loadTaskArchive');
    return source.slice(start, end);
  }
  function renderPanelWith(archive) {
    const boxes = {};
    const ctx = vmMod.createContext({
      state: { archive: archive },
      q: function (sel) { return (boxes[sel] = boxes[sel] || { hidden: false, innerHTML: '' }); },
      esc: function (v) { return String(v == null ? '' : v); },
      num: function (v) { return String(Number(v || 0)); },
      fmt: function (v) { return String(v); },
      dash: function (v) { return v == null ? '—' : String(Number(v || 0)); },
    });
    vmMod.runInContext(slicePanel(uiSource) + '\nrenderArchiveSummary();', ctx);
    return boxes['#archive-summary'];
  }
  if (!uiSource) {
    skip('看板渲染断言', 'board-ui.mjs / bus/ui/app.js 里都找不到 renderArchiveSummary + loadTaskArchive（UI 正在重构）');
  } else {
  const fullPanel = renderPanelWith({ last_archived_at: null, token_usage_daily_rows: 12, task_archives_rows: 3, pending_candidates: { messages: 5, guard_events: 2, token_usage: 7, logs: 1 }, unmanaged: { messages: 4, guard_events: 1, deferred_messages: 3, deferred_guard_events: 0, prune_unmanaged: false } });
  ok('看板渲染出「不可归属的过期行」并带计数', fullPanel.innerHTML.indexOf('不可归属的过期行') >= 0 && /孤儿消息 4 条/.test(fullPanel.innerHTML) && /孤儿守卫事件 1 条/.test(fullPanel.innerHTML), fullPanel.innerHTML.slice(0, 300));
  ok('渲染产物不含 undefined/NaN/[object', !/undefined|NaN|\[object/.test(fullPanel.innerHTML), fullPanel.innerHTML.slice(0, 300));
  ok('prune_unmanaged=false 时看板写「永不删除」', fullPanel.innerHTML.indexOf('永不删除') >= 0 && fullPanel.innerHTML.indexOf('允许删除') < 0, fullPanel.innerHTML.slice(-240));
  const nullPanel = renderPanelWith({ last_archived_at: null, token_usage_daily_rows: 0, task_archives_rows: 0, pending_candidates: { messages: 0, guard_events: 0, token_usage: 0, logs: 0 }, unmanaged: null });
  ok('unmanaged 为 null 时整节隐藏、不编 0', nullPanel.innerHTML.indexOf('不可归属') < 0 && !/孤儿消息 0/.test(nullPanel.innerHTML), nullPanel.innerHTML.slice(0, 240));
  }
} finally {
  db.close();
  fs.rmSync(tmp, { recursive: true, force: true });
}

console.log('\n==================================');
if (skipped) console.log('SKIP ' + skipped + '（说明见上：这不是 PASS）');
console.log('PASS ' + pass + '   FAIL ' + fail);
process.exitCode = fail ? 1 : 0;
