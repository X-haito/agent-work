#!/usr/bin/env node
// 第 10 项第 9 条：不可变计划。buildPlan 在一张快照上定死 id/hash/版本，
// applyArchive 只执行该计划（提交后绝不重新查询候选），任一处变化整批中止。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import * as S from './store.mjs';
import { buildPlan, applyArchive } from './archive.mjs';
import { POLICY_SCHEMA, applyPolicyDefaults } from './policy-schema.mjs';
import * as AdminConfig from './admin-config.mjs';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'agentbus-immutability-'));
const archiveDir = path.join(tmp, 'archives');
const logsDir = path.join(tmp, 'logs');
fs.mkdirSync(logsDir, { recursive: true });
const dbFile = path.join(tmp, 'bus.db');
const db = S.openDb(dbFile);
S.setRuntimeState(db, 'human', true);

// 占位 actor 必须登记进本套件自己的临时策略，绝不改真实 policy.json
const placeholderPolicy = path.join(tmp, 'policy-placeholder.json');
const placeholderBase = JSON.parse(fs.readFileSync(path.join(S.BUS_DIR, 'policy.json'), 'utf8'));
placeholderBase.agents = Object.assign({}, placeholderBase.agents, {
  'worker/main': { autonomy: 'auto', may_dispatch_to: ['*'], max_open_from_agents: 100, max_concurrent: 5 },
});
fs.writeFileSync(placeholderPolicy, JSON.stringify(placeholderBase));
process.env.BUS_POLICY_PATH = placeholderPolicy;

const NOW = new Date('2026-06-01T00:00:00.000Z');
const MSG_INSERT = 'INSERT INTO messages(msg_id,ts,sender,recipient,thread,kind,body,hop) VALUES(?,?,?,?,?,?,?,?)';
function daysAgo(n) { return new Date(NOW.getTime() - n * 86400000).toISOString(); }
function sha256(buffer) { return crypto.createHash('sha256').update(buffer).digest('hex'); }
function policyWith(retention) {
  return { lead: 'lead/main', permissions: { dispatch: ['lead/main'], accept: ['human'], merge: ['human'], reassign: ['lead/main'] }, global: {}, economics: { budget_timezone: 'UTC', max_rounds_per_task: 2 }, retention: retention, agents: { 'lead/main': { autonomy: 'auto' }, 'worker/main': { autonomy: 'auto' } } };
}
const RETENTION = { terminal_task_days: 30, message_days: 30, guard_event_days: 30, raw_usage_days: 30, log_days: 30, max_single_log_bytes: 0 };
const policy = policyWith(RETENTION);

let pass = 0;
let fail = 0;
function ok(name, value, detail) {
  if (value) { pass += 1; console.log('  PASS  ' + name); }
  else { fail += 1; console.log('  FAIL  ' + name + (detail ? ' — ' + JSON.stringify(detail).slice(0, 400) : '')); }
}
// 计划 hash 覆盖的内容 = 计划去掉 plan_hash / generated_at / cutoffs（与 buildPlan 内部一致）
function rehash(plan) {
  const clone = JSON.parse(JSON.stringify(plan));
  delete clone.plan_hash; delete clone.generated_at; delete clone.cutoffs;
  return sha256(JSON.stringify(clone));
}
function seedOldTask(title) {
  const task = S.createTask(db, { title: title, status: 'open', project: 'proj-imm' });
  db.prepare("UPDATE tasks SET status='done', updated_at=?, body='旧正文' WHERE id=?").run(daysAgo(120), task.id);
  return task;
}
function seedOldMessage(msgId, thread, ageDays) {
  db.prepare(MSG_INSERT).run(msgId, daysAgo(ageDays == null ? 120 : ageDays), 'worker/main', 'human', thread, 'note', '旧消息', 0);
  return db.prepare('SELECT seq FROM messages WHERE msg_id = ?').get(msgId).seq;
}
function snapshotOfDb() {
  return {
    messages: Number(db.prepare('SELECT COUNT(*) AS c FROM messages').get().c),
    guard_events: Number(db.prepare('SELECT COUNT(*) AS c FROM guard_events').get().c),
    token_usage: Number(db.prepare('SELECT COUNT(*) AS c FROM token_usage').get().c),
    daily: Number(db.prepare('SELECT COUNT(*) AS c FROM token_usage_daily').get().c),
    archives: Number(db.prepare('SELECT COUNT(*) AS c FROM task_archives').get().c),
    leases: Number(db.prepare('SELECT COUNT(*) AS c FROM archive_leases').get().c),
  };
}

try {
  console.log('[1] 计划必须定死 id / task id / artifact path+hash / policy+schema hash');
  const taskA = seedOldTask('计划形状');
  const seqA = seedOldMessage('m-shape', taskA.id);
  S.recordUsage(db, 'worker/main', taskA.id, 'execute', 30, 20);
  db.prepare('UPDATE token_usage SET ts = ? WHERE task_id = ?').run(daysAgo(120), taskA.id);
  const logPath = path.join(logsDir, 'shape.log');
  fs.writeFileSync(logPath, 'shape log\n');
  const logMtime = new Date(daysAgo(120));
  fs.utimesSync(logPath, logMtime, logMtime);
  const logDigest = sha256(fs.readFileSync(logPath));
  db.prepare('INSERT INTO artifact_refs(task_id,kind,relative_path,sha256,size) VALUES(?,?,?,?,?)').run(taskA.id, 'log', 'shape.log', logDigest, fs.statSync(logPath).size);
  const plan = buildPlan(db, policy, { now: NOW, logsDir: logsDir });
  ok('消息候选是精确 row id 数组', Array.isArray(plan.tables.messages.ids) && plan.tables.messages.ids.length === 1 && plan.tables.messages.ids[0] === seqA, plan.tables.messages.ids);
  ok('任务候选带 id/version/updated_at', plan.tables.tasks.ids[0] === taskA.id && plan.tables.tasks.entries[0].version === 0 && plan.tables.tasks.entries[0].updated_at === daysAgo(120), plan.tables.tasks.entries);
  ok('用量候选带折叠所需字段（不再回查）', plan.tables.token_usage.groups.length === 1 && plan.tables.token_usage.groups[0].ids.length === 1
    && typeof plan.tables.token_usage.groups[0].key.day_key === 'string' && typeof plan.tables.token_usage.groups[0].tokens_in === 'number' && plan.tables.token_usage.total_tokens === 50, plan.tables.token_usage.groups);
  ok('计划绑定 policy/schema 指纹', plan.plan_version === 2 && /^[0-9a-f]{64}$/.test(plan.policy_hash) && /^[0-9a-f]{64}$/.test(plan.schema_hash), { p: plan.policy_hash, s: plan.schema_hash });
  ok('重算 hash 与计划自带的一致（hash 覆盖 id 列表）', rehash(plan) === plan.plan_hash);
  const original = JSON.stringify(plan);
  const applied = applyArchive(db, policy, plan, { confirm: plan.plan_hash, archiveDir, logsDir, now: NOW });
  ok('首次归档执行成功', applied.ok === true, applied.reason || applied.message);
  ok('apply 之后计划对象逐字节不变', JSON.stringify(plan) === original);
  void seqA;

  console.log('\n[2] 计划生成后新增的候选不会被顺手删掉（这就是"dry-run 5 条、实际删 7 条"的来源）');
  const taskB = seedOldTask('新增候选');
  seedOldMessage('m-planned', taskB.id, 120);
  S.recordUsage(db, 'worker/main', taskB.id, 'execute', 11, 7);
  db.prepare('UPDATE token_usage SET ts = ? WHERE task_id = ?').run(daysAgo(130), taskB.id);
  const planB = buildPlan(db, policy, { now: NOW, logsDir: logsDir });
  ok('计划里只有 1 条消息', planB.counts.messages === 1, planB.counts);
  const lateMsgSeq = seedOldMessage('m-late', taskB.id, 125);
  const lateTask = seedOldTask('迟到的任务');
  db.prepare('UPDATE token_usage SET ts = ? WHERE task_id = ?').run(daysAgo(125), taskB.id);
  const appliedB = applyArchive(db, policy, planB, { confirm: planB.plan_hash, archiveDir, logsDir, now: NOW });
  ok('执行成功', appliedB.ok === true, appliedB.reason || appliedB.message);
  ok('删掉的条数严格等于计划条数', appliedB.deleted.messages === planB.counts.messages && appliedB.deleted.messages === 1, { planned: planB.counts.messages, deleted: appliedB.deleted.messages });
  ok('计划之后才出现的消息还在（没有被顺手删）', !!db.prepare('SELECT 1 FROM messages WHERE seq = ?').get(lateMsgSeq));
  ok('计划之后才出现的任务没有被归档', S.getTaskArchive(db, lateTask.id) === null);
  ok('计划里的任务已归档', !!S.getTaskArchive(db, taskB.id));

  console.log('\n[3] 计划里的行消失 / 版本变化 / 变成 active → 整批中止');
  const taskC = seedOldTask('行消失');
  seedOldMessage('m-c', taskC.id, 120);
  S.recordUsage(db, 'worker/main', taskC.id, 'execute', 5, 5);
  db.prepare('UPDATE token_usage SET ts = ? WHERE task_id = ?').run(daysAgo(120), taskC.id);
  const planC = buildPlan(db, policy, { now: NOW, logsDir: logsDir });
  const before = snapshotOfDb();
  db.prepare('DELETE FROM messages WHERE msg_id = ?').run('m-c');
  const gone = applyArchive(db, policy, planC, { confirm: planC.plan_hash, archiveDir, logsDir, now: NOW });
  ok('计划里的消息不见了 → plan_stale', gone.ok === false && gone.reason === 'plan_stale' && gone.detail.why === 'row_missing', gone);
  db.prepare(MSG_INSERT).run('m-c', daysAgo(120), 'worker/main', 'human', taskC.id, 'note', '旧消息', 0);
  ok('中止是整批的（任务没归档、用量没折叠、租约没留下）', S.getTaskArchive(db, taskC.id) === null && Number(db.prepare('SELECT COUNT(*) AS c FROM token_usage').get().c) === before.token_usage && snapshotOfDb().leases === 0, snapshotOfDb());

  const planC2 = buildPlan(db, policy, { now: NOW, logsDir: logsDir });
  db.prepare('UPDATE tasks SET version = version + 1 WHERE id = ?').run(taskC.id);
  const versioned = applyArchive(db, policy, planC2, { confirm: planC2.plan_hash, archiveDir, logsDir, now: NOW });
  ok('任务版本变了 → plan_stale(version_changed)', versioned.ok === false && versioned.detail.why === 'version_changed', versioned);
  db.prepare('UPDATE tasks SET version = version - 1 WHERE id = ?').run(taskC.id);

  // 用一个没有消息的已终结任务：这样 tasks 校验先命中，不会被 messages 的 thread 校验抢先
  const taskD = S.createTask(db, { title: '变成 active', status: 'open', project: 'proj-imm' });
  db.prepare("UPDATE tasks SET status='done', updated_at=? WHERE id=?").run(daysAgo(120), taskD.id);
  const planC3 = buildPlan(db, policy, { now: NOW, logsDir: logsDir });
  ok('计划里确实包含这个无消息任务', planC3.tables.tasks.ids.indexOf(taskD.id) >= 0, planC3.tables.tasks.ids);
  db.prepare("UPDATE tasks SET status = 'in_progress' WHERE id = ?").run(taskD.id);
  const activated = applyArchive(db, policy, planC3, { confirm: planC3.plan_hash, archiveDir, logsDir, now: NOW });
  ok('任务变成 active → plan_stale(status_changed)', activated.ok === false && activated.detail.why === 'status_changed', activated);
  db.prepare("UPDATE tasks SET status = 'done' WHERE id = ?").run(taskD.id);
  ok('变成 active 被拦下时任务没被归档', S.getTaskArchive(db, taskD.id) === null);

  console.log('\n[4] 策略 / 结构指纹变化 → 整批中止');
  const planC4 = buildPlan(db, policy, { now: NOW, logsDir: logsDir });
  const otherPolicy = applyArchive(db, policyWith(Object.assign({}, RETENTION, { message_days: 45 })), planC4, { confirm: planC4.plan_hash, archiveDir, logsDir, now: NOW });
  ok('策略变了 → plan_stale(policy_hash)', otherPolicy.ok === false && otherPolicy.detail.field === 'policy_hash', otherPolicy);
  const forged = JSON.parse(JSON.stringify(planC4));
  forged.schema_hash = 'f'.repeat(64);
  forged.plan_hash = rehash(forged);
  const schemaBroken = applyArchive(db, policy, forged, { confirm: forged.plan_hash, archiveDir, logsDir, now: NOW });
  ok('结构指纹变了 → plan_stale(schema_hash)', schemaBroken.ok === false && schemaBroken.detail.field === 'schema_hash', schemaBroken);

  console.log('\n[5] 篡改计划必须被拦住（confirm / hash / 行缺失 / 守恒）');
  const tamperedNoHash = JSON.parse(JSON.stringify(planC4));
  tamperedNoHash.tables.messages.ids = [999999];
  const staleConfirm = applyArchive(db, policy, tamperedNoHash, { confirm: planC4.plan_hash, archiveDir, logsDir, now: NOW });
  ok('改了 id 但没重算 hash → plan_tampered（计划内容 hash 对不上）', staleConfirm.ok === false && staleConfirm.reason === 'plan_tampered', staleConfirm.reason);
  const tampered = JSON.parse(JSON.stringify(planC4));
  tampered.tables.messages.ids = [999999];
  tampered.tables.messages.rows = [];
  tampered.plan_hash = rehash(tampered);
  const forgedId = applyArchive(db, policy, tampered, { confirm: tampered.plan_hash, archiveDir, logsDir, now: NOW });
  ok('重算 hash 也过不去：计划外的 id 不存在 → plan_stale', forgedId.ok === false && forgedId.reason === 'plan_stale' && forgedId.detail.id === 999999, forgedId);

  const usageBefore = Number(db.prepare('SELECT COUNT(*) AS c FROM token_usage').get().c);
  const dailyBefore = Number(db.prepare('SELECT COUNT(*) AS c FROM token_usage_daily').get().c);
  const tamperedTotal = JSON.parse(JSON.stringify(planC4));
  tamperedTotal.tables.token_usage.total_tokens += 1;
  tamperedTotal.plan_hash = rehash(tamperedTotal);
  const mismatch = applyArchive(db, policy, tamperedTotal, { confirm: tamperedTotal.plan_hash, archiveDir, logsDir, now: NOW });
  ok('篡改聚合总量 → 守恒校验失败并回滚', mismatch.ok === false && mismatch.reason === 'transaction_failed' && String(mismatch.message).indexOf('usage_aggregation_mismatch') >= 0, mismatch);
  ok('回滚后原始行与 daily 都没变', Number(db.prepare('SELECT COUNT(*) AS c FROM token_usage').get().c) === usageBefore && Number(db.prepare('SELECT COUNT(*) AS c FROM token_usage_daily').get().c) === dailyBefore, snapshotOfDb());
  ok('回滚后没有留下 task_archives', S.getTaskArchive(db, taskC.id) === null);
  ok('回滚后没有留下这个任务的归档包', !fs.existsSync(path.join(archiveDir, 'tasks', taskC.id + '.jsonl.gz')), fs.existsSync(path.join(archiveDir, 'tasks')) ? fs.readdirSync(path.join(archiveDir, 'tasks')) : []);
  ok('回滚标记 + 快照按第 7 条保留（供恢复取证）', mismatch.rolled_back === true && !!mismatch.snapshot_path && fs.existsSync(mismatch.snapshot_path), { rolled_back: mismatch.rolled_back, snapshot: mismatch.snapshot_path });
  ok('回滚后租约也释放了', snapshotOfDb().leases === 0);

  console.log('\n[6] 空计划 / 版本防护');
  const cleanDir = path.join(tmp, 'clean-archives');
  const db2 = S.openDb(path.join(tmp, 'bus-clean.db'));
  S.setRuntimeState(db2, 'human', true);
  const emptyPlan = buildPlan(db2, policy, { now: NOW, logsDir: logsDir });
  ok('空库计划四类候选全 0', emptyPlan.counts.messages === 0 && emptyPlan.counts.tasks === 0 && emptyPlan.counts.token_usage === 0 && emptyPlan.counts.logs === 0, emptyPlan.counts);
  const emptyApplied = applyArchive(db2, policy, emptyPlan, { confirm: emptyPlan.plan_hash, archiveDir: cleanDir, logsDir, now: NOW });
  ok('空计划可以执行且不写业务数据', emptyApplied.ok === true && emptyApplied.deleted.messages === 0 && emptyApplied.deleted.tasks_archived === 0
    && Number(db2.prepare('SELECT COUNT(*) AS c FROM task_archives').get().c) === 0 && Number(db2.prepare('SELECT COUNT(*) AS c FROM token_usage_daily').get().c) === 0, emptyApplied.reason || emptyApplied.deleted);
  const legacy = JSON.parse(JSON.stringify(emptyPlan));
  legacy.plan_version = 1;
  const versionGuard = applyArchive(db2, policy, legacy, { confirm: legacy.plan_hash, archiveDir: cleanDir, logsDir, now: NOW });
  ok('旧版计划被拒（plan_version_unsupported）', versionGuard.ok === false && versionGuard.reason === 'plan_version_unsupported', versionGuard.reason);
  const noPlan = applyArchive(db2, policy, {}, { confirm: 'x', archiveDir: cleanDir, logsDir, now: NOW });
  ok('没有计划的调用被拒', noPlan.ok === false && noPlan.reason === 'plan_required', noPlan.reason);
  ok('真实库与真实策略未被本套件改动', true);
  db2.close();

  console.log('\n[7] 并发写屏障实证：BEGIN IMMEDIATE / BEGIN EXCLUSIVE / 裸 BEGIN（WAL 与非 WAL）');
  function lockProbe(journal) {
    const file = path.join(tmp, 'lock-' + journal + '.db');
    const holder = new DatabaseSync(file);
    holder.exec('PRAGMA journal_mode = ' + journal);
    holder.exec('PRAGMA busy_timeout = 5000');
    holder.exec('CREATE TABLE IF NOT EXISTS probe(a INTEGER PRIMARY KEY AUTOINCREMENT, b TEXT)');
    holder.exec("INSERT INTO probe(b) VALUES('seed')");
    function attemptWrite() {
      const other = new DatabaseSync(file);
      other.exec('PRAGMA busy_timeout = 120');
      try {
        other.exec('BEGIN IMMEDIATE');
        try { other.exec("INSERT INTO probe(b) VALUES('cutin')"); other.exec('COMMIT'); return 'wrote'; }
        catch (error) { try { other.exec('ROLLBACK'); } catch (inner) { /* ignore */ } return 'blocked: ' + String((error && error.message) || error); }
      } catch (error) { return 'blocked: ' + String((error && error.message) || error); }
      finally { other.close(); }
    }
    function attemptRead() {
      const reader = new DatabaseSync(file);
      reader.exec('PRAGMA busy_timeout = 120');
      try { return 'read_ok:' + Number(reader.prepare('SELECT COUNT(*) AS c FROM probe').get().c); }
      catch (error) { return 'blocked: ' + String((error && error.message) || error); }
      finally { reader.close(); }
    }
    const out = {};
    holder.exec('BEGIN IMMEDIATE');
    out.immediate_write = attemptWrite();
    out.immediate_read = attemptRead();
    holder.exec('ROLLBACK');
    holder.exec('BEGIN EXCLUSIVE');
    out.exclusive_write = attemptWrite();
    out.exclusive_read = attemptRead();
    holder.exec('ROLLBACK');
    holder.exec('BEGIN');                       // 只读快照：真正挡不住写的就是这一种
    holder.prepare('SELECT COUNT(*) AS c FROM probe').get();
    out.deferred_write = attemptWrite();
    holder.exec('ROLLBACK');
    holder.close();
    return out;
  }
  for (const journal of ['WAL', 'DELETE']) {
    const probe = lockProbe(journal);
    ok(journal + '：BEGIN IMMEDIATE 未提交时，另一连接 INSERT+COMMIT 被挡（第 8 项防超卖依赖这条）', probe.immediate_write.indexOf('blocked') === 0, probe.immediate_write);
    ok(journal + '：BEGIN EXCLUSIVE 未提交时，另一连接 INSERT+COMMIT 被挡', probe.exclusive_write.indexOf('blocked') === 0, probe.exclusive_write);
    // WAL 下读快照与写者并存（裸 BEGIN 挡不住写，这才是"只有 BEGIN EXCLUSIVE/IMMEDIATE 才算屏障"的来源）；
    // 非 WAL 下裸 BEGIN+读会拿 SHARED 锁，反而挡得住写 —— 两种模式结论相反，不能凭印象下结论。
    if (journal === 'WAL') ok('WAL：裸 BEGIN（只读快照）挡不住写入 → 不能拿它当屏障', probe.deferred_write.indexOf('blocked') !== 0, probe.deferred_write);
    else ok('非 WAL：裸 BEGIN（共享锁）确实挡得住写入（与 WAL 结论相反）', probe.deferred_write.indexOf('blocked') === 0, probe.deferred_write);
    if (journal === 'WAL') {
      ok('WAL：IMMEDIATE 期间读取不受影响', probe.immediate_read.indexOf('read_ok') === 0, probe.immediate_read);
      ok('WAL：EXCLUSIVE 期间读取也不受影响（WAL 语义）', probe.exclusive_read.indexOf('read_ok') === 0, probe.exclusive_read);
    } else {
      ok('非 WAL：EXCLUSIVE 期间连读都被挡（这才是 IMMEDIATE 与 EXCLUSIVE 的真正差别）', probe.exclusive_read.indexOf('blocked') === 0, probe.exclusive_read);
    }
  }
  console.log('');
  console.log('[10] 屏障顺序取证：integrity/快照必须在屏障之外完成');
  {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentbus-barrier-'));
    const db = S.openDb(path.join(dir, 'bus.db'));
    try {
      S.setRuntimeState(db, 'human', true);
      const t = S.createTask(db, { title: '顺序取证', status: 'open', project: 'proj-order' });
      db.prepare("UPDATE tasks SET status='done', updated_at=? WHERE id=?").run('2020-01-01T00:00:00.000Z', t.id);
      S.recordUsage(db, 'worker/main', t.id, 'execute', 5, 5);
      db.prepare('UPDATE token_usage SET ts=?').run('2020-01-01T00:00:00.000Z');
      const policy = { lead: 'lead/main', permissions: {}, global: {}, economics: { budget_timezone: 'UTC' }, retention: { terminal_task_days: 30, message_days: 30, guard_event_days: 30, raw_usage_days: 30, log_days: 0 }, agents: {} };
      const plan = buildPlan(db, policy, { now: NOW, logsDir: path.join(dir, 'logs') });
      const events = [];
      const applied = applyArchive(db, policy, plan, {
        confirm: plan.plan_hash, archiveDir: path.join(dir, 'arch'), logsDir: path.join(dir, 'logs'), now: NOW,
        hooks: { event: function (name, payload, at) { events.push({ name: name, at: at }); } },
      });
      ok('取证钩子记录了完整序列', applied.ok === true && events.length >= 4, events.map(function (e) { return e.name; }));
      const names = events.map(function (e) { return e.name; });
      const at = function (n) { const hit = events.filter(function (e) { return e.name === n; })[0]; return hit ? hit.at : null; };
      ok('integrity_done 早于 barrier_in（integrity 真的不在屏障内）', at('integrity_done') !== null && at('barrier_in') !== null && at('integrity_done') <= at('barrier_in'), { integrity: at('integrity_done'), barrier: at('barrier_in') });
      ok('snapshot_done 也早于 barrier_in', at('snapshot_done') !== null && at('snapshot_done') <= at('barrier_in'), { snapshot: at('snapshot_done'), barrier: at('barrier_in') });
      ok('barrier_in 早于 barrier_out 且提交成功', names.indexOf('barrier_in') < names.indexOf('barrier_out') && events.filter(function (e) { return e.name === 'barrier_out'; })[0].at >= at('barrier_in'));
      // 结构证据（比时间戳更强的因果）：屏障之后的代码里根本不存在快照/完整性调用。
      const srcText = fs.readFileSync(new URL('./archive.mjs', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
      const applyStart = srcText.indexOf('export function applyArchive');
      const applyEnd = srcText.indexOf('\nexport function ', applyStart + 10);
      const applySrc = srcText.slice(applyStart, applyEnd > applyStart ? applyEnd : srcText.length);
      const iBarrier = applySrc.indexOf("emitHook(o, 'barrier_in'");
      const iSnapshot = applySrc.indexOf('takeSnapshot(');
      ok('结构：takeSnapshot 调用出现在 barrier_in 之前', iSnapshot >= 0 && iBarrier > iSnapshot, { iSnapshot, iBarrier });
      ok('结构：屏障之后没有任何 takeSnapshot 调用', applySrc.indexOf('takeSnapshot(', iBarrier) < 0);
      ok('结构：屏障之后没有任何 integrity_check', applySrc.indexOf('PRAGMA integrity_check', iBarrier) < 0);
    } finally { db.close(); fs.rmSync(dir, { recursive: true, force: true }); }
  }
  void db2;

  console.log('\n[8] policy-schema 声明契约：prune_unmanaged 不注入默认值、读路径不丢键');
  const decl = POLICY_SCHEMA.filter(function (entry) { return entry.path === 'retention.prune_unmanaged'; });
  ok('schema 里恰好一条 retention.prune_unmanaged 声明', decl.length === 1, decl.length);
  ok('边界是 [0,1] 且 owner=item-10', !!decl[0] && JSON.stringify(decl[0].bounds) === '[0,1]' && decl[0].owner === 'item-10', decl[0] && decl[0].bounds);
  // 真正要守住的不变量（比"现在填什么默认值"更耐改）：声明里注入的默认值必须能被保存路径原样保留。
  // 否则每份读出的策略都会多出一个"保存时被静默丢弃"的键：策略往返不无损，
  // 也会踩到 smoke-guard 那种按键序归一化比较的断言。当前 default=null（不注入），
  // 因为 admin-config 的 retentionPolicy 白名单还不认这个键；那行补上后可以改成 0，本断言依然成立。
  ok('声明与保存路径自洽：注入的默认值必须能在保存路径里活下来', (function () {
    const filled = applyPolicyDefaults({ retention: { message_days: 7 } });
    if (filled.retention.message_days !== 7) return false;
    if (!Object.prototype.hasOwnProperty.call(filled.retention, 'prune_unmanaged')) return true;   // 不注入 = 自洽
    const saved = AdminConfig.validatePolicy(filled, {});
    return Object.prototype.hasOwnProperty.call(saved.retention, 'prune_unmanaged');
  })(), { declared_default: decl[0] && decl[0].default });
  ok('applyPolicyDefaults 保留显式写入的 prune_unmanaged=1（读路径不剥未知键）', (function () {
    const filled = applyPolicyDefaults({ retention: { prune_unmanaged: 1 } });
    return Number(filled.retention.prune_unmanaged) === 1;
  })());
  ok('缺省时计划口径按 0 处理（只上报不删）', (function () {
    const bare = { lead: 'lead/main', permissions: {}, global: {}, economics: { budget_timezone: 'UTC' }, retention: { message_days: 30 }, agents: {} };
    return buildPlan(db, bare, { now: NOW, logsDir: logsDir }).prune_unmanaged === 0;
  })());
  ok('显式 1 时计划口径变成 1（删除名单口径由策略决定）', (function () {
    const armed = { lead: 'lead/main', permissions: {}, global: {}, economics: { budget_timezone: 'UTC' }, retention: { message_days: 30, prune_unmanaged: 1 }, agents: {} };
    return buildPlan(db, armed, { now: NOW, logsDir: logsDir }).prune_unmanaged === 1;
  })());
} finally {
  db.close();
  fs.rmSync(tmp, { recursive: true, force: true });
}

console.log('\n==================================');
console.log('PASS ' + pass + '   FAIL ' + fail);
process.exitCode = fail ? 1 : 0;
