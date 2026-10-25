#!/usr/bin/env node
// 第 8 项：Token 预算硬守卫（预留、提交、过期释放、准入）。全程临时库 + 临时策略。
// 说明：reserveTokens/budgetStatus 接受 now，所以可以精确复现时区边界；token_usage 的 ts 由测试
// 直接改写成同一时刻，模拟"当天已经花掉的钱"。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as S from './store.mjs';
import { migrateDb } from './migrations.mjs';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'agentbus-budget-'));
const POLICY = path.join(tmp, 'policy.json');
const oldPolicyEnv = process.env.BUS_POLICY_PATH;

const ECONOMICS = {
  lead_may_read_files: false, lead_may_write_code: false, lead_wake_on: [], report_max_lines: 40, report_no_raw_diff: true,
  auto_accept: [], peer_review: [], lead_review: [], max_rounds_per_task: 2, max_changed_files: 20, max_subagents: 0,
  review_timeout_min: 30, require_verify_cmd: false,
  daily_token_budget: null, budget_timezone: 'Asia/Shanghai', default_turn_reserve: 50,
};
function policyObject(economics, agents) {
  return {
    lead: 'lead/main',
    redline: { human_only: ['dep:install', 'fs:delete', 'git:risky', 'cfg:edit', 'net:egress'] },
    permissions: { dispatch: ['lead/main'], accept: ['human', 'lead/main'], merge: ['human'], reassign: ['lead/main'] },
    global: { dispatch_enabled: true, max_dispatch_depth: 2, max_chain_len: 3, rate_per_agent_per_hour: 50, require_credentials: false },
    economics: Object.assign({}, ECONOMICS, economics || {}),
    agents: agents || {
      'lead/main': { autonomy: 'auto', may_dispatch_to: ['worker/main'], max_open_from_agents: 50, max_concurrent: 5 },
      'worker/main': { autonomy: 'auto', may_dispatch_to: [], max_open_from_agents: 50, max_concurrent: 5 },
    },
  };
}
function writePolicy(economics, agents) { fs.writeFileSync(POLICY, JSON.stringify(policyObject(economics, agents), null, 2)); }
function policyNow() { return S.loadPolicy(); }

writePolicy();
process.env.BUS_POLICY_PATH = POLICY;
const dbFile = path.join(tmp, 'bus.db');
const db = S.openDb(dbFile);
S.setRuntimeState(db, 'human', true);

// 上海时区 2026-01-01 自然日内（UTC 2025-12-31T16:00 ~ 2026-01-01T16:00）
const INSIDE = '2026-01-01T02:00:00.000Z';

let pass = 0;
let fail = 0;
function ok(name, value, detail) {
  if (value) { pass += 1; console.log('  PASS  ' + name); }
  else { fail += 1; console.log('  FAIL  ' + name + (detail ? ' — ' + JSON.stringify(detail) : '')); }
}
function task(extra) { return S.createTask(db, Object.assign({ title: '预算样本任务', status: 'open', project: 'proj-budget', cost_class: 'tests' }, extra || {})); }
function spend(agent, taskId, tokens, reservationId, ts) {
  const result = S.recordUsage(db, agent, taskId, 'execute', Math.ceil(tokens / 2), Math.floor(tokens / 2), reservationId);
  if (ts) db.prepare('UPDATE token_usage SET ts=? WHERE id=(SELECT MAX(id) FROM token_usage)').run(ts);
  return result;
}
function clearReservations(after) { return S.releaseExpiredReservations(db, after || '2026-01-01T23:00:00.000Z'); }

try {
  console.log('[1] schema 与迁移');
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(function (r) { return r.name; });
  ok('token_reservations 表存在', tables.indexOf('token_reservations') >= 0);
  const columns = db.prepare('PRAGMA table_info(token_reservations)').all().map(function (c) { return c.name; });
  ok('列与契约一致', ['id', 'agent', 'task_id', 'day_key', 'reserved_tokens', 'expires_at', 'committed_at'].every(function (n) { return columns.indexOf(n) >= 0; }), columns);
  const taskColumns = db.prepare('PRAGMA table_info(tasks)').all().map(function (c) { return c.name; });
  ok('tasks.token_budget 存在', taskColumns.indexOf('token_budget') >= 0);
  migrateDb(db); migrateDb(db);
  ok('迁移幂等', db.prepare('PRAGMA table_info(tasks)').all().filter(function (c) { return c.name === 'token_budget'; }).length === 1);
  let checkRejected = false;
  try { db.prepare('INSERT INTO token_reservations(id,agent,task_id,day_key,reserved_tokens,expires_at) VALUES(?,?,?,?,?,?)').run('res-zero', 'a', null, '2026-01-01', 0, '2026-01-02T00:00:00.000Z'); }
  catch (error) { checkRejected = /CHECK/i.test(String(error.message)); }
  ok('reserved_tokens 不允许 0（CHECK 约束）', checkRejected);

  console.log('\n[2] 自然日与预算时区');
  ok('上海时区：跨 UTC 日界仍算同一天', S.dayKeyOf('2025-12-31T16:30:00.000Z', 'Asia/Shanghai') === '2026-01-01', S.dayKeyOf('2025-12-31T16:30:00.000Z', 'Asia/Shanghai'));
  ok('UTC 时区按 UTC 日界', S.dayKeyOf('2025-12-31T16:30:00.000Z', 'UTC') === '2025-12-31');
  const shBounds = S.budgetDayBounds('2026-01-01', 'Asia/Shanghai');
  ok('上海自然日起止为 UTC 16:00 边界', shBounds.start === '2025-12-31T16:00:00.000Z' && shBounds.end === '2026-01-01T16:00:00.000Z', shBounds);
  const utcBounds = S.budgetDayBounds('2026-01-01', 'UTC');
  ok('UTC 自然日起止为 0 点边界', utcBounds.start === '2026-01-01T00:00:00.000Z' && utcBounds.end === '2026-01-02T00:00:00.000Z', utcBounds);
  const dst = S.budgetDayBounds('2026-03-08', 'America/New_York');
  ok('夏令时当天只有 23 小时', (Date.parse(dst.end) - Date.parse(dst.start)) === 23 * 3600 * 1000, { start: dst.start, end: dst.end });
  const edgeTask = task();
  spend('worker/main', edgeTask.id, 100, null, '2025-12-31T15:59:00.000Z');
  const beforeDay = S.budgetStatus(db, policyNow(), { now: INSIDE });
  const edgeTask2 = task();
  spend('worker/main', edgeTask2.id, 40, null, '2025-12-31T16:01:00.000Z');
  const afterDay = S.budgetStatus(db, policyNow(), { now: INSIDE });
  ok('本地日界之前的用量不计入当天', beforeDay.used === 0, beforeDay.used);
  ok('本地日界之后的用量计入当天', afterDay.used === 40, afterDay.used);

  console.log('\n[3] 日预算：预留、提交与余额');
  writePolicy({ daily_token_budget: 1000, default_turn_reserve: 300 });
  const dayTask = task();
  const first = S.reserveTokens(db, policyNow(), { agent: 'worker/main', taskId: dayTask.id, phase: 'execute', costClass: 'fresh-class', now: INSIDE });
  ok('无历史样本时按 default_turn_reserve 预留', first.ok === true && first.reserved_tokens === 300 && first.day_key === '2026-01-01', first);
  let status = S.budgetStatus(db, policyNow(), { now: INSIDE });
  ok('budgetStatus 反映已预留', status.limit === 1000 && status.used === 40 && status.reserved === 300 && status.remaining === 660, status);
  const committed = spend('worker/main', dayTask.id, 300, first.reservation_id, INSIDE);
  ok('记录实际用量并提交预留', committed.ok === true && committed.overrun === false && committed.reserved_tokens === 300, committed);
  status = S.budgetStatus(db, policyNow(), { now: INSIDE });
  ok('提交后用量计入 used、预留释放', status.used === 340 && status.reserved === 0 && status.remaining === 660, status);
  const second = S.reserveTokens(db, policyNow(), { agent: 'worker/main', taskId: dayTask.id, phase: 'execute', costClass: 'fresh-class', now: INSIDE });
  const third = S.reserveTokens(db, policyNow(), { agent: 'worker/main', phase: 'execute', costClass: 'fresh-class', now: INSIDE });
  ok('后续预留按默认额度继续占位', second.ok === true && second.reserved_tokens === 300 && third.ok === true && third.reserved_tokens === 300, { second: second.reserved_tokens, third: third.reserved_tokens });
  const clamped = S.reserveTokens(db, policyNow(), { agent: 'worker/main', phase: 'execute', costClass: 'fresh-class', now: INSIDE });
  ok('余额不足一次预留时按剩余额度预留（不超卖）', clamped.ok === true && clamped.clamped === true && clamped.reserved_tokens === 60, clamped);
  const overflow = S.reserveTokens(db, policyNow(), { agent: 'worker/main', phase: 'execute', costClass: 'fresh-class', now: INSIDE });
  ok('余额为 0 时拒绝预留', overflow.ok === false && overflow.reason === 'budget_exceeded' && overflow.detail.scope === 'day', overflow);
  clearReservations('2026-01-01T03:00:00.000Z');

  console.log('\n[4] 并发预留不超卖');
  writePolicy({ daily_token_budget: 900, default_turn_reserve: 300 });
  const other = S.openDb(dbFile);
  const attempts = [];
  attempts.push(S.reserveTokens(db, policyNow(), { agent: 'worker/main', phase: 'execute', costClass: 'fresh-class', now: INSIDE }));
  attempts.push(S.reserveTokens(other, policyNow(), { agent: 'worker/main', phase: 'execute', costClass: 'fresh-class', now: INSIDE }));
  attempts.push(S.reserveTokens(db, policyNow(), { agent: 'worker/main', phase: 'execute', costClass: 'fresh-class', now: INSIDE }));
  attempts.push(S.reserveTokens(other, policyNow(), { agent: 'worker/main', phase: 'execute', costClass: 'fresh-class', now: INSIDE }));
  const granted = attempts.filter(function (r) { return r.ok; });
  const reservedTotal = granted.reduce(function (n, r) { return n + r.reserved_tokens; }, 0);
  const concurrentStatus = S.budgetStatus(db, policyNow(), { now: INSIDE });
  ok('多条连接交替预留也不会超过上限', concurrentStatus.used + reservedTotal <= 900 && concurrentStatus.reserved === reservedTotal, { used: concurrentStatus.used, reservedTotal: reservedTotal, status: concurrentStatus });
  ok('上限用尽后所有连接都失败', attempts[attempts.length - 1].ok === false && attempts[attempts.length - 1].reason === 'budget_exceeded', attempts[attempts.length - 1]);
  ok('每条连接看到同一份预留账本', S.budgetStatus(other, policyNow(), { now: INSIDE }).reserved === concurrentStatus.reserved, { other: S.budgetStatus(other, policyNow(), { now: INSIDE }).reserved, db: concurrentStatus.reserved });
  const grantedIds = granted.map(function (r) { return r.reservation_id; });
  const releasedBatch = S.releaseExpiredReservations(other, '2026-01-01T04:00:00.000Z');
  const afterRelease = S.budgetStatus(db, policyNow(), { now: INSIDE });
  ok('释放后额度归还到可用余额', releasedBatch.released === granted.length && afterRelease.reserved === 0 && afterRelease.remaining === afterRelease.limit - afterRelease.used, { released: releasedBatch.released, status: afterRelease });
  ok('被释放的预留行确实已从库里移除', grantedIds.every(function (id) { return !db.prepare('SELECT 1 FROM token_reservations WHERE id = ?').get(id); }) && S.releaseExpiredReservations(db, '2026-01-01T04:00:00.000Z').released === 0);
  const reused = S.reserveTokens(db, policyNow(), { agent: 'worker/main', phase: 'execute', costClass: 'fresh-class', now: INSIDE });
  ok('释放出来的额度可以再次被预留', reused.ok === true && reused.reserved_tokens === 300, reused);
  other.close();
  clearReservations('2026-01-01T04:00:00.000Z');

  console.log('\n[5] 过期释放');
  writePolicy({ daily_token_budget: 1000, default_turn_reserve: 200 });
  const leaseTask = task();
  const shortLived = S.reserveTokens(db, policyNow(), { agent: 'lease/main', taskId: leaseTask.id, phase: 'execute', costClass: 'docs', now: INSIDE, ttlMs: 60000 });
  ok('创建短 TTL 预留（无样本时用 default_turn_reserve）', shortLived.ok === true && shortLived.reserved_tokens === 200, shortLived);
  ok('未过期前占用额度', S.budgetStatus(db, policyNow(), { now: INSIDE }).reserved === 200);
  ok('过期后立刻不再占用额度', S.budgetStatus(db, policyNow(), { now: '2026-01-01T02:05:00.000Z' }).reserved === 0);
  const released = S.releaseExpiredReservations(db, '2026-01-01T02:05:00.000Z');
  ok('releaseExpiredReservations 清理过期的未提交预留', released.released >= 1 && !db.prepare('SELECT 1 FROM token_reservations WHERE id = ?').get(shortLived.reservation_id), released);
  const keep = S.reserveTokens(db, policyNow(), { agent: 'lease/main', taskId: leaseTask.id, phase: 'execute', costClass: 'docs', now: INSIDE, ttlMs: 60000 });
  S.recordUsage(db, 'lease/main', leaseTask.id, 'execute', 10, 10, keep.reservation_id);
  const releasedAgain = S.releaseExpiredReservations(db, '2026-01-01T03:00:00.000Z');
  ok('已提交的预留不会被释放', !!db.prepare('SELECT committed_at FROM token_reservations WHERE id = ?').get(keep.reservation_id).committed_at && releasedAgain.released === 0, releasedAgain);

  console.log('\n[6] 实际用量超过预留');
  writePolicy({ daily_token_budget: 100000, default_turn_reserve: 100 });
  const overTask = S.createTask(db, { title: '超预留任务', status: 'open', project: 'proj-budget', cost_class: 'tests' });
  S.claim(db, 'worker/main', overTask.id, 15);
  const small = S.reserveTokens(db, policyNow(), { agent: 'over/main', taskId: overTask.id, phase: 'execute', costClass: 'fresh-class', now: INSIDE });
  ok('预留额度小于实际消耗', small.ok === true && small.reserved_tokens === 100, small);
  const over = S.recordUsage(db, 'worker/main', overTask.id, 'execute', 900, 600, small.reservation_id);
  ok('超预留仍然完整记账', over.ok === true && over.overrun === true && over.reserved_tokens === 100, over);
  const usageRow = db.prepare('SELECT SUM(tokens_in+tokens_out) AS t FROM token_usage WHERE task_id = ?').get(overTask.id);
  ok('实际用量一分不少地入库', Number(usageRow.t) === 1500, usageRow);
  const flagged = S.getTask(db, overTask.id);
  const guard = JSON.parse(flagged.guard || '{}');
  ok('任务标记 budget_overrun 并挂起待人审', !!guard.budget_overrun && Number(flagged.needs_human) === 1 && !!flagged.escalated_at, { guard: guard, needs_human: flagged.needs_human });
  ok('写入 budget_overrun 事件与升级', !!db.prepare("SELECT 1 FROM guard_events WHERE task_id = ? AND kind = 'budget_overrun'").get(overTask.id) && !!db.prepare("SELECT 1 FROM task_escalations WHERE task_id = ? AND kind = 'budget_overrun'").get(overTask.id));
  const again = S.recordUsage(db, 'worker/main', overTask.id, 'execute', 10, 10, small.reservation_id);
  ok('同一预留不能重复提交', again.ok === true && again.reservation_reason === 'already_committed', again);

  console.log('\n[7] 任务预算与 Human 调额');
  writePolicy({ daily_token_budget: null, default_turn_reserve: null });
  const budgetTask = S.createTask(db, { title: '任务预算', status: 'open', project: 'proj-budget', cost_class: 'tests', token_budget: 500 });
  ok('任务预算落库', Number(budgetTask.token_budget) === 500, budgetTask.token_budget);
  const taskReserve = S.reserveTokens(db, policyNow(), { agent: 'worker/main', taskId: budgetTask.id, phase: 'execute', costClass: 'tests', now: INSIDE });
  ok('任务剩余额度优先于估算', taskReserve.ok === true && taskReserve.reserved_tokens === 500, taskReserve);
  S.recordUsage(db, 'worker/main', budgetTask.id, 'execute', 300, 100, taskReserve.reservation_id);
  const secondTaskReserve = S.reserveTokens(db, policyNow(), { agent: 'worker/main', taskId: budgetTask.id, phase: 'execute', costClass: 'tests', now: INSIDE });
  ok('第二轮按剩余额度预留', secondTaskReserve.ok === true && secondTaskReserve.reserved_tokens === 100, secondTaskReserve);
  S.recordUsage(db, 'worker/main', budgetTask.id, 'execute', 100, 0, secondTaskReserve.reservation_id);
  const exhausted = S.reserveTokens(db, policyNow(), { agent: 'worker/main', taskId: budgetTask.id, phase: 'execute', costClass: 'tests', now: INSIDE });
  ok('任务额度用尽后拒绝预留', exhausted.ok === false && exhausted.reason === 'budget_exceeded' && exhausted.detail.scope === 'task', exhausted);
  const raised = S.editTask(db, policyNow(), 'human', budgetTask.id, { token_budget: 1000 }, S.getTask(db, budgetTask.id).version);
  ok('Human 调高任务额度成功', raised.ok === true && Number(raised.task.token_budget) === 1000, raised.ok ? raised.task.token_budget : raised);
  const afterRaise = S.reserveTokens(db, policyNow(), { agent: 'worker/main', taskId: budgetTask.id, phase: 'execute', costClass: 'tests', now: INSIDE });
  ok('调额后可以继续预留', afterRaise.ok === true && afterRaise.reserved_tokens === 500, afterRaise);
  const badBudget = S.editTask(db, policyNow(), 'human', budgetTask.id, { token_budget: 0 }, S.getTask(db, budgetTask.id).version);
  ok('非法任务额度被拒', badBudget.ok === false && badBudget.reason === 'invalid_token_budget', badBudget);
  const workerRaise = S.editTask(db, policyNow(), 'worker/main', budgetTask.id, { token_budget: 99999 }, S.getTask(db, budgetTask.id).version);
  ok('无验收权的人不能自行调额', workerRaise.ok === false && workerRaise.reason === 'not_permitted', workerRaise);
  clearReservations('2026-01-01T05:00:00.000Z');

  console.log('\n[7b] 日预算为空时任务预算仍然生效（第 8 项收口）');
  // default_turn_reserve 给准入估算兜底：任务只剩 1 token 时估算 400 > 余量 → 必须降级
  writePolicy({ daily_token_budget: null, default_turn_reserve: 400 });
  const soloBudget = S.createTask(db, { title: '仅任务预算', status: 'open', project: 'proj-budget', cost_class: 'tests', token_budget: 500 });
  const solo1 = S.reserveTokens(db, policyNow(), { agent: 'worker/main', taskId: soloBudget.id, phase: 'execute', costClass: 'tests', now: INSIDE });
  ok('日预算为 null 时任务预算照样预留', solo1.ok === true && solo1.reserved_tokens === 500 && solo1.limit === null, solo1);
  S.recordUsage(db, 'worker/main', soloBudget.id, 'execute', 300, 100, solo1.reservation_id);
  const solo2 = S.reserveTokens(db, policyNow(), { agent: 'worker/main', taskId: soloBudget.id, phase: 'execute', costClass: 'tests', now: INSIDE });
  ok('第二笔按剩余额度预留', solo2.ok === true && solo2.reserved_tokens === 100, solo2);
  S.recordUsage(db, 'worker/main', soloBudget.id, 'execute', 100, 0, solo2.reservation_id);
  const solo3 = S.reserveTokens(db, policyNow(), { agent: 'worker/main', taskId: soloBudget.id, phase: 'execute', costClass: 'tests', now: INSIDE });
  ok('第三笔超额被拒且 scope=task（不被日预算为 null 绕过）', solo3.ok === false && solo3.reason === 'budget_exceeded' && solo3.detail.scope === 'task', solo3);
  const soloAdmit = S.createHumanTask(db, policyNow(), 'human', { title: '仅任务预算的人工作业', project: 'proj-budget', cost_class: 'tests', token_budget: 1 });
  ok('准入检查同样看任务预算（日预算为 null 也拦）', soloAdmit.ok === true && soloAdmit.task.status === 'proposed', { status: soloAdmit.task && soloAdmit.task.status, gated_by: soloAdmit.gated_by });
  console.log('\n[7c] 日预算与任务预算同时存在时取剩余更小者');
  writePolicy({ daily_token_budget: 1000, default_turn_reserve: null });
  const dualTask = S.createTask(db, { title: '双预算任务', status: 'open', project: 'proj-budget', cost_class: 'tests', token_budget: 200 });
  const dual = S.reserveTokens(db, policyNow(), { agent: 'worker/main', taskId: dualTask.id, phase: 'execute', costClass: 'tests', now: INSIDE });
  ok('任务额度更小时按任务额度预留', dual.ok === true && dual.reserved_tokens === 200 && dual.limit === 1000, dual);
  S.recordUsage(db, 'worker/main', dualTask.id, 'execute', 150, 50, dual.reservation_id);
  const dual2 = S.reserveTokens(db, policyNow(), { agent: 'worker/main', taskId: dualTask.id, phase: 'execute', costClass: 'tests', now: INSIDE });
  ok('任务额度用尽即拒绝（即便日预算还剩很多）', dual2.ok === false && dual2.reason === 'budget_exceeded' && dual2.detail.scope === 'task', dual2);
  const tinyTask = S.createTask(db, { title: '大任务预算小日预算', status: 'open', project: 'proj-budget', cost_class: 'tests', token_budget: 100000 });
  const tiny = S.reserveTokens(db, policyNow(), { agent: 'worker/main', taskId: tinyTask.id, phase: 'execute', costClass: 'tests', now: INSIDE });
  ok('日预算更小时按日剩余预留并标记 clamped', tiny.ok === true && tiny.clamped === true && tiny.reserved_tokens <= 1000, tiny);
  console.log('\n[7d] 超预留判定对任务预算同样生效');
  writePolicy({ daily_token_budget: null, default_turn_reserve: null });
  const overTask2 = S.createTask(db, { title: '任务预算超支', status: 'open', project: 'proj-budget', cost_class: 'tests', token_budget: 300 });
  S.claim(db, 'worker/main', overTask2.id, 30);
  const overRes = S.reserveTokens(db, policyNow(), { agent: 'worker/main', taskId: overTask2.id, phase: 'execute', costClass: 'tests', now: INSIDE });
  const overRun = S.recordUsage(db, 'worker/main', overTask2.id, 'execute', 250, 250, overRes.reservation_id);
  ok('实际超过任务预算预留时标 overrun 并完整记账', overRes.ok === true && overRun.ok === true && overRun.overrun === true, overRun);
  ok('任务被标记 budget_overrun', !!JSON.parse(S.getTask(db, overTask2.id).guard || '{}').budget_overrun);

  console.log('\n[8] 未返回 usage 的 fail-closed');
  clearReservations('2026-01-01T06:00:00.000Z');
  writePolicy({ daily_token_budget: 1000000, default_turn_reserve: null }, {
    'lead/main': { autonomy: 'auto', may_dispatch_to: ['worker/main'], max_open_from_agents: 50, max_concurrent: 5 },
    'worker/main': { autonomy: 'auto', may_dispatch_to: [], max_open_from_agents: 50, max_concurrent: 5 },
    'fresh/main': { autonomy: 'auto', may_dispatch_to: [], max_open_from_agents: 50, max_concurrent: 5 },
  });
  const fresh = S.reserveTokens(db, policyNow(), { agent: 'fresh/main', phase: 'execute', costClass: 'architectural', now: INSIDE });
  ok('既无样本也无 default_turn_reserve 时拒绝启动', fresh.ok === false && fresh.reason === 'no_budget_config', fresh);
  const sampleTask = S.createTask(db, { title: '估算样本', status: 'open', project: 'proj-budget', cost_class: 'mechanical' });
  S.recordUsage(db, 'fresh/main', sampleTask.id, 'execute', 60, 40);
  const estimated = S.reserveTokens(db, policyNow(), { agent: 'fresh/main', phase: 'execute', costClass: 'mechanical', now: INSIDE });
  ok('有样本后用 P90 估算即可预留', estimated.ok === true && estimated.reserved_tokens === 100, estimated);

  console.log('\n[9] P90 估算顺序');
  writePolicy({ daily_token_budget: 1000000, default_turn_reserve: 50 });
  for (const tokens of [100, 200, 1000]) {
    const sample = S.createTask(db, { title: 'P90 样本', status: 'open', project: 'proj-budget', cost_class: 'docs' });
    S.recordUsage(db, 'cap/main', sample.id, 'execute', tokens - 5, 5);
  }
  const p90Reserve = S.reserveTokens(db, policyNow(), { agent: 'cap/main', phase: 'execute', costClass: 'docs', now: INSIDE });
  ok('按 agent+cost_class+phase 最近样本的 P90 预留', p90Reserve.ok === true && p90Reserve.reserved_tokens === 1000, p90Reserve);
  // 契约第 3 条：样本不足时使用 default_turn_reserve —— 显式正值是正确行为，不是 bug
  const fallbackClass = S.reserveTokens(db, policyNow(), { agent: 'cap/main', phase: 'execute', costClass: 'standard', now: INSIDE });
  ok('样本不足时回退到 default_turn_reserve（契约要求的行为）', fallbackClass.ok === true && fallbackClass.reserved_tokens === 50, fallbackClass);
  // 只有 default_turn_reserve 缺失/为 0 时才是 fail-closed
  writePolicy({ daily_token_budget: 1000000, default_turn_reserve: null });
  const otherClass = S.reserveTokens(db, policyNow(), { agent: 'cap/main', phase: 'execute', costClass: 'standard', now: INSIDE });
  ok('没有对应 cost_class 的样本时退回 fail-closed', otherClass.ok === false && otherClass.reason === 'no_budget_config', otherClass);
  writePolicy({ daily_token_budget: 1000000, default_turn_reserve: 50 });

  console.log('\n[10] 没有预算配置时行为不变');
  writePolicy({ daily_token_budget: null, default_turn_reserve: null });
  const noBudget = S.reserveTokens(db, policyNow(), { agent: 'worker/main', phase: 'execute', costClass: 'tests', now: INSIDE });
  ok('无预算时不占用额度也不拦截', noBudget.ok === true && noBudget.reservation_id === null && noBudget.reserved === false, noBudget);
  const noBudgetStatus = S.budgetStatus(db, policyNow(), { now: INSIDE });
  ok('budgetStatus 明确 limit 为空', noBudgetStatus.limit === null && noBudgetStatus.remaining === null, noBudgetStatus);

  console.log('\n[11] 派发与创建任务的准入检查');
  writePolicy({ daily_token_budget: 500, default_turn_reserve: 400 });
  const gated = S.dispatch(db, policyNow(), 'lead/main', { to: 'worker/main', title: '预算不足的派活', cost_class: 'tests' });
  ok('预计余额不足时创建为 proposed', gated.ok === true && gated.task.status === 'proposed' && gated.gated_by === 'budget_exceeded', gated);
  const humanGated = S.createHumanTask(db, policyNow(), 'human', { title: '预算不足的人工任务', project: 'proj-budget', cost_class: 'tests' });
  ok('人工创建同样只降级不拒绝', humanGated.ok === true && humanGated.task.status === 'proposed' && humanGated.gated_by === 'budget_exceeded', humanGated);
  writePolicy({ daily_token_budget: 1000000, default_turn_reserve: 400 });
  const normal = S.dispatch(db, policyNow(), 'lead/main', { to: 'worker/main', title: '余额充足的派活', cost_class: 'tests' });
  ok('余额充足时行为不变（直接 open）', normal.ok === true && normal.task.status === 'open' && normal.gated === false, normal);

  console.log('\n[12] budgetStatus 汇总');
  writePolicy({ daily_token_budget: 1000000, default_turn_reserve: 100 });
  const summary = S.budgetStatus(db, policyNow(), { now: INSIDE });
  ok('按 agent 汇总 used 与 reserved', summary.by_agent.some(function (a) { return a.agent === 'worker/main' && a.used > 0; }), summary.by_agent);
  ok('按项目汇总 used', summary.by_project.some(function (p) { return p.project === 'proj-budget' && p.used > 0; }), summary.by_project);
  const byAgent = S.budgetStatus(db, policyNow(), { now: INSIDE, agent: 'worker/main' });
  ok('可只统计某个 agent', byAgent.used > 0 && byAgent.used <= summary.used, { agent: byAgent.used, all: summary.used });
  ok('day_key 与时区随策略走', byAgent.day_key === '2026-01-01' && byAgent.timezone === 'Asia/Shanghai', byAgent.day_key);
} finally {
  db.close();
  if (oldPolicyEnv === undefined) delete process.env.BUS_POLICY_PATH; else process.env.BUS_POLICY_PATH = oldPolicyEnv;
  fs.rmSync(tmp, { recursive: true, force: true });
}

console.log('\n==================================');
console.log('PASS ' + pass + '   FAIL ' + fail);
process.exitCode = fail ? 1 : 0;
