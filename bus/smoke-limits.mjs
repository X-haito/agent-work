#!/usr/bin/env node
// 第 7 项：轮次、消息链与重试上限。全程只用临时库 + 临时策略（BUS_POLICY_PATH），不碰真实 bus.db / policy.json。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as S from './store.mjs';
import { migrateDb } from './migrations.mjs';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'agentbus-limits-'));
const POLICY = path.join(tmp, 'policy.json');
const oldPolicyEnv = process.env.BUS_POLICY_PATH;

function policyObject(extra) {
  const base = {
    lead: 'lead/main',
    redline: { human_only: ['dep:install', 'fs:delete', 'git:risky', 'cfg:edit', 'net:egress'] },
    permissions: { dispatch: ['lead/main', 'rate/main'], accept: ['human', 'lead/main'], merge: ['human'], reassign: ['lead/main'] },
    global: { dispatch_enabled: true, max_dispatch_depth: 3, max_chain_len: 3, rate_per_agent_per_hour: 20, require_credentials: false },
    economics: {
      lead_may_read_files: false, lead_may_write_code: false, lead_wake_on: [], report_max_lines: 40, report_no_raw_diff: true,
      auto_accept: [], peer_review: [], lead_review: [], max_rounds_per_task: 2, max_changed_files: 20, max_subagents: 0,
      review_timeout_min: 30, require_verify_cmd: false, daily_token_budget: null,
    },
    agents: {
      'lead/main': { autonomy: 'auto', may_dispatch_to: ['worker/main', 'cap/main', 'scoped/main'], max_open_from_agents: 50, max_concurrent: 5 },
      'worker/main': { autonomy: 'auto', may_dispatch_to: [], max_open_from_agents: 50, max_concurrent: 5 },
      'cap/main': { autonomy: 'auto', may_dispatch_to: [], max_open_from_agents: 50, max_concurrent: 1 },
      'scoped/main': { autonomy: 'auto', may_dispatch_to: ['lead/main'], max_open_from_agents: 50, max_concurrent: 2, scope_allowlist: ['src/**', 'tests/*.js'] },
      'rate/main': { autonomy: 'auto', may_dispatch_to: ['worker/main'], max_open_from_agents: 50, max_concurrent: 5 },
    },
  };
  return Object.assign(base, extra || {});
}
function writePolicy(extra) { fs.writeFileSync(POLICY, JSON.stringify(policyObject(extra), null, 2)); }

writePolicy();
process.env.BUS_POLICY_PATH = POLICY;
const dbFile = path.join(tmp, 'bus.db');
const db = S.openDb(dbFile);
S.setRuntimeState(db, 'human', true);
const policy = S.loadPolicy();

let pass = 0;
let fail = 0;
function ok(name, value, detail) {
  if (value) { pass += 1; console.log('  PASS  ' + name); }
  else { fail += 1; console.log('  FAIL  ' + name + (detail ? ' — ' + JSON.stringify(detail) : '')); }
}
function task(extra) { return S.createHumanTask(db, S.loadPolicy(), 'human', Object.assign({ title: '轮次测试任务', project: 'proj-limits' }, extra || {})).task; }
function failIt(id, agent) {
  S.claim(db, agent || 'worker/main', id, 15);
  S.updateTask(db, agent || 'worker/main', id, 'in_progress');
  return S.updateTask(db, agent || 'worker/main', id, 'failed', '执行失败');
}
function escalationCount(taskId, kind) {
  return Number(db.prepare('SELECT COUNT(*) AS c FROM task_escalations WHERE task_id = ? AND kind = ?').get(taskId, kind).c);
}

try {
  console.log('[1] schema 与迁移幂等');
  const taskColumns = db.prepare('PRAGMA table_info(tasks)').all().map(function (c) { return c.name; });
  ok('tasks 有 round_count/retry_limit/parent_task_id', ['round_count', 'retry_limit', 'parent_task_id'].every(function (n) { return taskColumns.indexOf(n) >= 0; }), taskColumns);
  const messageColumns = db.prepare('PRAGMA table_info(messages)').all().map(function (c) { return c.name; });
  ok('messages 有 chain_root', messageColumns.indexOf('chain_root') >= 0);
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(function (r) { return r.name; });
  ok('task_escalations 表存在', tables.indexOf('task_escalations') >= 0);
  const indexes = db.prepare("SELECT name,sql FROM sqlite_master WHERE type='index' AND tbl_name='task_escalations'").all();
  ok('task_escalations 有 (task_id,kind) 唯一索引', indexes.some(function (i) { return /UNIQUE\s*\(\s*task_id\s*,\s*kind\s*\)/i.test(String(i.sql || '')) || /^sqlite_autoindex_task_escalations/.test(String(i.name)); }), indexes);
  migrateDb(db); migrateDb(db);
  ok('migrateDb 连跑两次幂等', db.prepare('PRAGMA table_info(tasks)').all().filter(function (c) { return c.name === 'round_count'; }).length === 1);
  const dupFirst = db.prepare('INSERT OR IGNORE INTO task_escalations(task_id,kind,created_at) VALUES(?,?,?)').run('t-dup', 'retry_exceeded', S.nowIso());
  const dupSecond = db.prepare('INSERT OR IGNORE INTO task_escalations(task_id,kind,created_at) VALUES(?,?,?)').run('t-dup', 'retry_exceeded', S.nowIso());
  ok('唯一约束让重复升级无副作用', Number(dupFirst.changes) === 1 && Number(dupSecond.changes) === 0);

  console.log('\n[2] retryTask：唯一入口与 CAS');
  const r1 = task();
  ok('创建时固化 retry_limit', Number(r1.retry_limit) === policy.economics.max_rounds_per_task, r1.retry_limit);
  const failed = failIt(r1.id);
  ok('任务进入 failed', failed.ok === true && failed.task.status === 'failed');
  ok('updateTask 不接受迁回 open（只能走 retryTask）', S.updateTask(db, 'worker/main', r1.id, 'open').reason === 'bad_status');
  const first = S.retryTask(db, 'worker/main', r1.id, '第 2 轮', S.getTask(db, r1.id).version);
  ok('failed 可进入下一轮', first.ok === true && first.task.status === 'open' && Number(first.task.round_count) === 1, first);
  ok('重试清空 owner 与 lease', first.task.owner === null && first.task.lease_until === null);
  ok('重试推进 version', first.task.version > r1.version);
  ok('重试发出 task.retry 消息', Number(db.prepare("SELECT COUNT(*) AS c FROM messages WHERE thread = ? AND kind = 'task.retry'").get(r1.id).c) === 1);
  ok('过期 version 被拒', S.retryTask(db, 'worker/main', r1.id, 'x', r1.version).reason === 'version_mismatch');
  const reviewTask = task();
  S.claim(db, 'worker/main', reviewTask.id, 15);
  S.updateTask(db, 'worker/main', reviewTask.id, 'in_progress');
  S.updateTask(db, 'worker/main', reviewTask.id, 'review');
  const fromReview = S.retryTask(db, 'lead/main', reviewTask.id, '评审退回');
  ok('评审退回（review）可进入下一轮', fromReview.ok === true && fromReview.task.status === 'open' && Number(fromReview.task.round_count) === 1, fromReview);
  const openTask = task();
  ok('open 任务不可重试', S.retryTask(db, 'worker/main', openTask.id, 'x').reason === 'not_retryable');
  const doneTask = task();
  S.claim(db, 'worker/main', doneTask.id, 15);
  S.updateTask(db, 'worker/main', doneTask.id, 'in_progress');
  S.updateTask(db, 'worker/main', doneTask.id, 'review');
  S.updateTask(db, 'human', doneTask.id, 'done', '验收', undefined, policy.permissions.accept);
  ok('done 任务不可重试', S.retryTask(db, 'worker/main', doneTask.id, 'x').reason === 'not_retryable');
  ok('不存在的任务给出 not_found', S.retryTask(db, 'worker/main', 't-9999', 'x').reason === 'not_found');

  console.log('\n[3] 轮次上限：只升级一次');
  failIt(r1.id);
  const second = S.retryTask(db, 'worker/main', r1.id, '第 2 轮', S.getTask(db, r1.id).version);
  ok('第二次重试成功（2/2 轮）', second.ok === true && Number(second.task.round_count) === 2, second);
  failIt(r1.id);
  const over = S.retryTask(db, 'worker/main', r1.id, '第 3 轮');
  ok('超过 retry_limit 返回 retry_exceeded', over.ok === false && over.reason === 'retry_exceeded', over);
  ok('超额写入 retry_exceeded 升级', escalationCount(r1.id, 'retry_exceeded') === 1);
  const over2 = S.retryTask(db, 'worker/main', r1.id, '第 3 轮');
  ok('再试一次仍然拒绝但不再升级', over2.ok === false && over2.reason === 'retry_exceeded' && over2.escalation_created === false && escalationCount(r1.id, 'retry_exceeded') === 1);
  const againBut = S.retryTask(db, 'worker/main', r1.id, 'x');
  ok('升级后任务状态没被改动', S.getTask(db, r1.id).status === 'failed' && Number(S.getTask(db, r1.id).round_count) === 2, S.getTask(db, r1.id).status);

  console.log('\n[4] 两路并发 CAS：只有一路成功');
  const raceTask = task();
  failIt(raceTask.id);
  const version = S.getTask(db, raceTask.id).version;
  const a = S.retryTask(db, 'worker/main', raceTask.id, '并发 A', version);
  const b = S.retryTask(db, 'worker/main', raceTask.id, '并发 B', version);
  const winners = [a, b].filter(function (r) { return r.ok; });
  const losers = [a, b].filter(function (r) { return !r.ok; });
  ok('同一 version 只有一路重试成功', winners.length === 1 && losers.length === 1, { a: a.reason, b: b.reason });
  ok('失败的一路给出 race_lost 或 version_mismatch', ['race_lost', 'version_mismatch'].indexOf(losers[0].reason) >= 0, losers[0]);
  ok('并发后 round_count 只加 1', Number(S.getTask(db, raceTask.id).round_count) === 1);
  ok('落库的 version 与胜者一致', S.getTask(db, raceTask.id).version === winners[0].task.version);

  console.log('\n[5] retry_limit 在创建时冻结');
  const frozenTask = task();
  writePolicy({ economics: Object.assign({}, policyObject().economics, { max_rounds_per_task: 5 }) });
  ok('改策略前创建的任务保留旧上限', Number(frozenTask.retry_limit) === 2, frozenTask.retry_limit);
  ok('改策略后创建的任务用新上限', Number(task().retry_limit) === 5);
  writePolicy();

  console.log('\n[6] 消息链：hop / chain_root / chain_limit');
  const root = S.send(db, { sender: 'worker/main', to: 'lead/main', kind: 'question', body: '根消息' });
  const rootRow = db.prepare('SELECT hop,chain_root,msg_id FROM messages WHERE msg_id = ?').get(root.msg_id);
  ok('无父消息 hop=0 且自成链根', rootRow.hop === 0 && rootRow.chain_root === root.msg_id, rootRow);
  const hop1 = S.send(db, { sender: 'lead/main', to: 'worker/main', kind: 'answer', body: '一级回复', reply_to: root.msg_id });
  const hop1Row = db.prepare('SELECT hop,chain_root FROM messages WHERE msg_id = ?').get(hop1.msg_id);
  ok('回复 hop=父+1 且继承 chain_root', hop1Row.hop === 1 && hop1Row.chain_root === root.msg_id, hop1Row);
  const hop2 = S.send(db, { sender: 'worker/main', to: 'lead/main', kind: 'question', body: '二级', reply_to: hop1.msg_id, thread: 'loop-thread' });
  const hop3 = S.send(db, { sender: 'lead/main', to: 'worker/main', kind: 'answer', body: '三级', reply_to: hop2.msg_id, thread: 'loop-thread' });
  ok('到上限（hop=3）仍正常投递', db.prepare('SELECT hop FROM messages WHERE msg_id = ?').get(hop3.msg_id).hop === 3);
  const hop4 = S.send(db, { sender: 'worker/main', to: 'lead/main', kind: 'question', body: '四级', reply_to: hop3.msg_id, thread: 'loop-thread' });
  ok('超过 max_chain_len 时不插入原消息', hop4.chain_limited === true && hop4.dropped === true && hop4.msg_id === null, hop4);
  ok('原消息确实没有落库', !db.prepare("SELECT 1 FROM messages WHERE body = '四级'").get());
  const limitEvent = db.prepare("SELECT recipient,kind,thread FROM messages WHERE kind = 'chain_limit'").all();
  ok('改写为 chain_limit 事件且只发给 Lead', limitEvent.length === 1 && limitEvent[0].recipient === 'lead/main' && limitEvent[0].thread === 'loop-thread', limitEvent);
  ok('chain_limit 写入升级记录', escalationCount('loop-thread', 'chain_limit') === 1);
  const hop5 = S.send(db, { sender: 'worker/main', to: 'lead/main', kind: 'question', body: '五级', reply_to: hop3.msg_id, thread: 'loop-thread' });
  ok('同一条链的超限只升级一次', hop5.chain_limited === true && hop5.escalation_created === false && escalationCount('loop-thread', 'chain_limit') === 1);
  ok('仍然只有一条 chain_limit 事件', Number(db.prepare("SELECT COUNT(*) AS c FROM messages WHERE kind = 'chain_limit'").get().c) === 1);
  const newRoot = S.send(db, { sender: 'worker/main', to: 'lead/main', kind: 'note', body: '另一条链' });
  ok('新消息自成另一条链', db.prepare('SELECT chain_root FROM messages WHERE msg_id = ?').get(newRoot.msg_id).chain_root === newRoot.msg_id);

  console.log('\n[7] 每小时派发率与子代理总限额');
  writePolicy({ global: Object.assign({}, policyObject().global, { rate_per_agent_per_hour: 2 }) });
  const r1d = S.dispatch(db, S.loadPolicy(), 'rate/main', { to: 'worker/main', title: '配额 1' });
  const r2d = S.dispatch(db, S.loadPolicy(), 'rate/main', { to: 'worker/main', title: '配额 2' });
  ok('未超速率时派发成功', r1d.ok === true && r2d.ok === true, { r1: r1d.reason, r2: r2d.reason });
  const r3d = S.dispatch(db, S.loadPolicy(), 'rate/main', { to: 'worker/main', title: '配额 3' });
  ok('超过 rate_per_agent_per_hour 被拒', r3d.ok === false && r3d.reason === 'rate_limited', r3d);
  ok('被拒的派发没有落库', !db.prepare("SELECT 1 FROM tasks WHERE title = '配额 3'").get());
  writePolicy();
  ok('换掉策略后同一 agent 又能派发', S.dispatch(db, S.loadPolicy(), 'rate/main', { to: 'worker/main', title: '配额 4' }).ok === true);
  const sub0 = S.dispatch(db, S.loadPolicy(), 'lead/main', { to: 'worker/main', title: '要子代理', max_subagents: 1 });
  ok('max_subagents 超过 economics 上限被拒', sub0.ok === false && sub0.reason === 'max_subagents_exceeded', sub0);
  writePolicy({ economics: Object.assign({}, policyObject().economics, { max_subagents: 2 }) });
  ok('上限放开后允许 2 个子代理', S.dispatch(db, S.loadPolicy(), 'lead/main', { to: 'worker/main', title: '要 2 个子代理', max_subagents: 2 }).ok === true);
  const sub3 = S.dispatch(db, S.loadPolicy(), 'lead/main', { to: 'worker/main', title: '要 3 个子代理', max_subagents: 3 });
  ok('仍拒绝超过新上限的请求', sub3.ok === false && sub3.reason === 'max_subagents_exceeded');
  writePolicy();

  console.log('\n[8] 并发 claim：max_concurrent');
  const capTask = task();
  S.claim(db, 'cap/main', capTask.id, 15);
  S.updateTask(db, 'cap/main', capTask.id, 'in_progress');
  const blocked = S.claim(db, 'cap/main', task().id, 15);
  ok('执行中的任务占满配额后拒绝新认领', blocked.ok === false && blocked.reason === 'max_concurrent', blocked);
  S.updateTask(db, 'cap/main', capTask.id, 'review');
  const afterRelease = S.claim(db, 'cap/main', task().id, 15);
  ok('任务离开执行态后可以继续认领', afterRelease.ok === true, afterRelease);
  // 本轮修正：以前"查不到配置就不限额"等于任意自报身份都能绕过 max_concurrent。
  const ghostClaim = S.claim(db, 'ghost/main', task().id, 15);
  ok('未在策略登记的 agent 被拒绝而不是绕过配额', ghostClaim.ok === false && ghostClaim.reason === 'unknown_agent', ghostClaim);
  const ghostDispatch = S.dispatch(db, S.loadPolicy(), 'ghost/main', { to: 'worker/main', title: '未知身份派活', write_scope: ['docs/whatever.md'] });
  ok('未知 agent 派活被拒（拿不到"空 allowlist"待遇）', ghostDispatch.ok === false && ghostDispatch.reason === 'unknown_agent', ghostDispatch);
  const humanDispatch = S.dispatch(db, S.loadPolicy(), 'human', { to: 'worker/main', title: 'Human 派活' });
  ok('human 不属于 agents 列表但仍是合法来源', humanDispatch.ok === true || humanDispatch.reason !== 'unknown_agent', humanDispatch);

  console.log('\n[9] scope_allowlist（path.matchesGlob）');
  const allowedScope = S.dispatch(db, S.loadPolicy(), 'scoped/main', { to: 'lead/main', title: '允许的范围', write_scope: ['src/auth/login.js'] });
  ok('命中 allowlist 的 scope 放行', allowedScope.ok === true && allowedScope.task, allowedScope);
  const globScope = S.dispatch(db, S.loadPolicy(), 'scoped/main', { to: 'lead/main', title: 'glob 命中的范围', write_scope: ['tests/a.test.js'] });
  ok('glob 模式命中放行', globScope.ok === true, globScope);
  const deniedScope = S.dispatch(db, S.loadPolicy(), 'scoped/main', { to: 'lead/main', title: '越界的范围', write_scope: ['docs/readme.md'] });
  ok('不在 allowlist 的 scope 被拒', deniedScope.ok === false && deniedScope.reason === 'scope_not_allowed' && String(deniedScope.message).indexOf('docs/readme.md') >= 0, deniedScope);
  const mixedScope = S.dispatch(db, S.loadPolicy(), 'scoped/main', { to: 'lead/main', title: '混合范围', write_scope: ['src/ok.js', 'docs/bad.md'] });
  ok('混合范围只要有一项越界就拒绝', mixedScope.ok === false && String(mixedScope.message).indexOf('docs/bad.md') >= 0, mixedScope);
  const backslashScope = S.dispatch(db, S.loadPolicy(), 'scoped/main', { to: 'lead/main', title: '反斜杠范围', write_scope: ['src\\auth\\x.js'] });
  ok('反斜杠 scope 规范化后仍匹配', backslashScope.ok === true, backslashScope);
  const freeScope = S.dispatch(db, S.loadPolicy(), 'lead/main', { to: 'worker/main', title: '空 allowlist 不限制', write_scope: ['anywhere/ok.md'] });
  ok('空 allowlist 表示不额外限制', freeScope.ok === true, freeScope);

  console.log('\n[9b] 并发 claim 必须一胜一败（CAS）');
  const claimRaceTask = task();
  const claimBaseVersion = S.getTask(db, claimRaceTask.id).version;
  const claimFirst = S.claim(db, 'worker/main', claimRaceTask.id, 15);
  const claimSecond = S.claim(db, 'cap/main', claimRaceTask.id, 15);
  const claimWinner = S.getTask(db, claimRaceTask.id);
  ok('同一张卡只能被一个 agent 认领', claimFirst.ok === true && claimSecond.ok === false, { claimFirst, claimSecond });
  ok('第二个人被拒（race_lost 或已被抢走）且 owner 不被覆盖',
    ['race_lost', 'not_open'].indexOf(String(claimSecond.reason)) >= 0 && claimWinner.owner === 'worker/main' && claimWinner.status === 'claimed',
    claimWinner && { owner: claimWinner.owner, status: claimWinner.status, reason: claimSecond.reason });
  // 单线程 SQLite 造不出真并发，所以直接验证 CAS 本身：拿陈旧 version 走同一条 UPDATE，必须 0 行受影响。
  const staleClaim = db.prepare("UPDATE tasks SET owner=?, status='claimed', version=version+1 WHERE id=? AND status='open' AND version=?")
    .run('ghost/main', claimRaceTask.id, claimBaseVersion);
  ok('认领走 CAS：陈旧 version 的更新 0 行受影响，owner 不变',
    Number(staleClaim.changes) === 0 && S.getTask(db, claimRaceTask.id).owner === 'worker/main');
  ok('失败时不会留下第二次认领的痕迹', db.prepare("SELECT COUNT(*) AS c FROM messages WHERE thread=? AND kind='task.claim'").get(claimRaceTask.id).c === 1);

  console.log('\n[9c] 升级解除（releaseEscalation）');
  const escTask = S.createTask(db, { title: '卡在升级里的任务', project: 'limits', status: 'open', target: 'worker/main' });
  S.escalate(db, escTask.id, 'retry_exceeded');
  const notPermitted = S.releaseEscalation(db, S.loadPolicy(), { taskId: escTask.id, actor: 'worker/main', note: '自作主张' });
  ok('非 Lead/Human 不能解除升级', notPermitted.ok === false && notPermitted.reason === 'not_permitted', notPermitted);
  const nothing = S.releaseEscalation(db, S.loadPolicy(), { taskId: task().id, actor: 'human' });
  ok('没有升级时解除返回 not_escalated', nothing.ok === false && nothing.reason === 'not_escalated', nothing);
  const released = S.releaseEscalation(db, S.loadPolicy(), { taskId: escTask.id, actor: 'human', note: '确认无关，放行' });
  ok('Human 解除升级成功并回传解除的 kind', released.ok === true && released.released.indexOf('retry_exceeded') >= 0 && escalationCount(escTask.id, 'retry_exceeded') === 0, released);
  ok('解除动作写进 guard_events', db.prepare("SELECT COUNT(*) AS c FROM guard_events WHERE task_id=? AND kind='escalation_release'").get(escTask.id).c >= 1);
  ok('解除动作写进 audit_log（同事务）', db.prepare("SELECT COUNT(*) AS c FROM audit_log WHERE action='task.escalation_release'").get().c >= 1);
  const reclaim = S.claim(db, 'worker/main', escTask.id, 15);
  ok('解除后任务可以重新被认领', reclaim.ok === true && S.getTask(db, escTask.id).owner === 'worker/main', reclaim);

  console.log('\n[10] 只升级一次（并发入口）');
  const esc = S.escalate(db, 't-concurrent', 'retry_exceeded');
  const esc2 = S.escalate(db, 't-concurrent', 'retry_exceeded');
  ok('同一 task+kind 只创建一次升级', esc.created === true && esc2.created === false && escalationCount('t-concurrent', 'retry_exceeded') === 1);
  const otherKind = S.escalate(db, 't-concurrent', 'chain_limit');
  ok('不同 kind 的升级互不影响', otherKind.created === true && escalationCount('t-concurrent', 'chain_limit') === 1);

  console.log('\n[11] 停用时重试也被挡住');
  S.setRuntimeState(db, 'human', false);
  ok('停用后 retryTask 返回 disabled', S.retryTask(db, 'worker/main', r1.id, 'x').reason === 'disabled');
  S.setRuntimeState(db, 'human', true);
} finally {
  db.close();
  if (oldPolicyEnv === undefined) delete process.env.BUS_POLICY_PATH; else process.env.BUS_POLICY_PATH = oldPolicyEnv;
  fs.rmSync(tmp, { recursive: true, force: true });
}

console.log('\n==================================');
console.log('PASS ' + pass + '   FAIL ' + fail);
process.exitCode = fail ? 1 : 0;
