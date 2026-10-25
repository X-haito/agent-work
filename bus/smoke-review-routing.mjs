#!/usr/bin/env node
// 第 9 项：评审路由（auto / peer / lead / human）、verdict 与 done 硬门。全程临时库 + 临时策略。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as S from './store.mjs';
import { routeFor } from './review-routing.mjs';
import { migrateDb } from './migrations.mjs';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'agentbus-review-'));
const POLICY = path.join(tmp, 'policy.json');
const oldPolicyEnv = process.env.BUS_POLICY_PATH;

const ECONOMICS = {
  lead_may_read_files: false, lead_may_write_code: false, lead_wake_on: [], report_max_lines: 40, report_no_raw_diff: true,
  auto_accept: [], peer_review: ['standard'], lead_review: ['architectural'], max_rounds_per_task: 3, max_changed_files: 20,
  max_subagents: 0, review_timeout_min: 1, require_verify_cmd: false,
  daily_token_budget: null, budget_timezone: 'UTC', default_turn_reserve: 100,
};
fs.writeFileSync(POLICY, JSON.stringify({
  lead: 'lead/main',
  redline: { human_only: ['dep:install', 'fs:delete', 'git:risky', 'cfg:edit', 'net:egress'] },
  permissions: { dispatch: ['lead/main'], accept: ['human', 'lead/main'], merge: ['human'], reassign: ['lead/main'] },
  global: { dispatch_enabled: true, max_dispatch_depth: 2, max_chain_len: 5, rate_per_agent_per_hour: 200, require_credentials: false },
  economics: ECONOMICS,
  agents: {
    'lead/main': { autonomy: 'auto', may_dispatch_to: ['worker/main', 'peer/main'], max_open_from_agents: 50, max_concurrent: 9 },
    'worker/main': { autonomy: 'auto', may_dispatch_to: [], max_open_from_agents: 50, max_concurrent: 9 },
    'peer/main': { autonomy: 'auto', may_dispatch_to: [], max_open_from_agents: 50, max_concurrent: 9 },
  },
}, null, 2));
process.env.BUS_POLICY_PATH = POLICY;

const db = S.openDb(path.join(tmp, 'bus.db'));
S.setRuntimeState(db, 'human', true);
const policy = S.loadPolicy();

let pass = 0;
let fail = 0;
function ok(name, value, detail) {
  if (value) { pass += 1; console.log('  PASS  ' + name); }
  else { fail += 1; console.log('  FAIL  ' + name + (detail ? ' — ' + JSON.stringify(detail) : '')); }
}
function reviewCount(taskId) { return Number(db.prepare('SELECT COUNT(*) AS c FROM reviews WHERE task_id = ?').get(taskId).c); }
function makeTask(extra) { return S.createTask(db, Object.assign({ title: '评审任务', status: 'open', project: 'proj-review', cost_class: 'standard' }, extra || {})); }
function cleanGuard(taskId) { S.setGuard(db, taskId, { guard: { ok: true, hard: [], soft: [] }, changed_files: 1 }); }
function verificationRow(taskId, opts) {
  const o = opts || {};
  db.prepare('INSERT INTO verification_runs(run_id,task_id,verify_id,verify_spec_hash,started_at,finished_at,exit_code,duration_ms,ok,stdout_tail,stderr_tail) VALUES(?,?,?,?,?,?,?,?,?,?,?)')
    .run('run-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8), taskId, 'smoke', o.spec_hash || 'hash-smoke', S.nowIso(), S.nowIso(), o.exit == null ? 0 : o.exit, 12, o.ok === false ? 0 : 1, '', '');
}
function frozenTask(extra) {
  const task = S.createTask(db, Object.assign({ title: '冻结验证器任务', status: 'open', project: 'proj-review', cost_class: 'docs', verify_id: 'smoke', verify_spec_json: JSON.stringify({ command: 'node', args: ['x'], cwd: '.', timeout_ms: 1000 }), verify_spec_hash: 'hash-smoke' }, extra || {}));
  return task;
}

try {
  console.log('[1] schema：reviews 与部分唯一索引');
  const indexes = db.prepare("SELECT name,sql FROM sqlite_master WHERE type='index' AND tbl_name='reviews'").all();
  ok('reviews 表与索引存在', indexes.some(function (i) { return i.name === 'i_reviews_active'; }), indexes.map(function (i) { return i.name; }));
  ok('active 用部分唯一索引（WHERE status=', indexes.some(function (i) { return /WHERE\s+status\s*=\s*'active'/i.test(String(i.sql || '')); }));
  db.prepare("INSERT INTO reviews(id,task_id,route,status,created_at,updated_at) VALUES(?,?,?,?,?,?)").run('rv-dup-1', 't-dup', 'peer', 'active', S.nowIso(), S.nowIso());
  let blocked = false;
  try { db.prepare("INSERT INTO reviews(id,task_id,route,status,created_at,updated_at) VALUES(?,?,?,?,?,?)").run('rv-dup-2', 't-dup', 'peer', 'active', S.nowIso(), S.nowIso()); }
  catch (error) { blocked = /UNIQUE/i.test(String(error.message)); }
  ok('同一任务不允许两个 active 评审', blocked);
  db.prepare('DELETE FROM reviews WHERE task_id = ?').run('t-dup');
  migrateDb(db); migrateDb(db);
  ok('迁移幂等', db.prepare('PRAGMA table_info(reviews)').all().length >= 11);

  console.log('\n[2] routeFor 四条路由');
  ok('Human：红线命中', routeFor({ cost_class: 'docs', redline: ['cfg:edit'] }, null, null, policy).route === 'human');
  ok('Human：needs_human', routeFor({ cost_class: 'docs', needs_human: 1 }, null, null, policy).route === 'human');
  ok('Human：guard.hard 阻塞', routeFor({ cost_class: 'docs' }, { ok: false, hard: ['fs:delete'], soft: [] }, null, policy).route === 'human');
  ok('Human：guard.soft 阻塞', routeFor({ cost_class: 'docs' }, { ok: true, hard: [], soft: ['changed_files=30'] }, null, policy).route === 'human');
  ok('Lead：architectural 命中 lead_review', routeFor({ cost_class: 'architectural' }, { ok: true, hard: [], soft: [] }, null, policy).route === 'lead');
  ok('Peer：standard 命中 peer_review', routeFor({ cost_class: 'standard' }, { ok: true, hard: [], soft: [] }, null, policy).route === 'peer');
  ok('Auto：guard 干净 + 冻结验证器通过', routeFor({ cost_class: 'docs', verify_id: 'smoke', verify_spec_hash: 'h' }, { ok: true, hard: [], soft: [] }, { ok: true, verify_spec_hash: 'h' }, policy).route === 'auto');
  ok('Auto 降级：guard 缺失不得自动通过', routeFor({ cost_class: 'docs', verify_id: 'smoke' }, null, { ok: true }, policy).route === 'human');
  ok('Auto 降级：没有冻结验证器', routeFor({ cost_class: 'docs' }, { ok: true, hard: [], soft: [] }, { ok: true }, policy).route === 'human');
  ok('Auto 降级：验证器未通过', routeFor({ cost_class: 'docs', verify_id: 'smoke' }, { ok: true, hard: [], soft: [] }, { ok: false, exit_code: 3 }, policy).route === 'human');
  ok('Auto 降级：验证器规格与冻结值不一致', routeFor({ cost_class: 'docs', verify_id: 'smoke', verify_spec_hash: 'a' }, { ok: true, hard: [], soft: [] }, { ok: true, verify_spec_hash: 'b' }, policy).route === 'human');
  ok('Auto 降级：没有验证运行记录', routeFor({ cost_class: 'docs', verify_id: 'smoke' }, { ok: true, hard: [], soft: [] }, null, policy).route === 'human');

  console.log('\n[3] 类别重叠：按固定优先级 + 记录 conflict');
  const overlapPolicy = JSON.parse(JSON.stringify(policy));
  overlapPolicy.economics.lead_review = ['standard'];
  overlapPolicy.economics.peer_review = ['standard'];
  const overlap = routeFor({ cost_class: 'standard' }, { ok: true, hard: [], soft: [] }, null, overlapPolicy);
  ok('重叠时走 Lead（优先级固定）', overlap.route === 'lead', overlap);
  ok('重叠时把冲突如实写进 conflicts', overlap.conflicts.length === 1 && /lead_review 与 peer_review/.test(overlap.conflicts[0]), overlap.conflicts);

  console.log('\n[4] 推进到 review 时在同一事务里建 assignment');
  const peerTask = makeTask();
  S.claim(db, 'worker/main', peerTask.id, 15);
  S.updateTask(db, 'worker/main', peerTask.id, 'in_progress');
  const entered = S.updateTask(db, 'worker/main', peerTask.id, 'review', '做完待评审');
  ok('review 迁移返回 assignment', entered.ok === true && !!entered.review && entered.review.route === 'peer', entered.review);
  ok('没有在线 peer 时保留 pending 且不算认领', entered.review.status === 'pending' && entered.review.reviewer === null, entered.review);
  ok('无人可评时只发一次 review_unassigned', (function () {
    const first = Number(db.prepare("SELECT COUNT(*) AS c FROM messages WHERE thread = ? AND kind = 'review_unassigned'").get(peerTask.id).c);
    S.createReviewAssignment(db, policy, peerTask.id, {});
    const second = Number(db.prepare("SELECT COUNT(*) AS c FROM messages WHERE thread = ? AND kind = 'review_unassigned'").get(peerTask.id).c);
    return first === 1 && second === 1;
  })());
  ok('同版本重复指派返回同一条（幂等）', (function () {
    const again = S.createReviewAssignment(db, policy, peerTask.id, {});
    return again.ok === true && again.existing === true && reviewCount(peerTask.id) === 1;
  })());

  console.log('\n[5] Peer：认领、双重认领、owner 自审');
  S.heartbeat(db, 'peer/main', 'idle');
  S.heartbeat(db, 'leaf/main', 'idle');
  const peerTask2 = makeTask();
  S.claim(db, 'worker/main', peerTask2.id, 15);
  S.updateTask(db, 'worker/main', peerTask2.id, 'in_progress');
  const assigned = S.updateTask(db, 'worker/main', peerTask2.id, 'review');
  ok('有人在线的 peer 时直接指派 reviewer', assigned.review.route === 'peer' && assigned.review.reviewer === 'peer/main', assigned.review);
  const wrongReviewer = S.claimReview(db, 'lead/main', assigned.review.id, assigned.review.task_version);
  ok('非指派 reviewer 不能认领', wrongReviewer.ok === false && wrongReviewer.reason === 'not_reviewer', wrongReviewer);
  const ownerClaim = S.claimReview(db, 'worker/main', assigned.review.id, assigned.review.task_version);
  ok('owner 不能认领自己任务的评审', ownerClaim.ok === false && ownerClaim.reason === 'self_review', ownerClaim);
  const claimed = S.claimReview(db, 'peer/main', assigned.review.id, assigned.review.task_version);
  ok('指派 reviewer 可以认领', claimed.ok === true && claimed.review.status === 'active' && !!claimed.review.lease_until, claimed.review);
  const doubleClaim = S.claimReview(db, 'peer/main', assigned.review.id, assigned.review.task_version);
  ok('双重认领被拒', doubleClaim.ok === false && doubleClaim.reason === 'already_claimed', doubleClaim);
  const staleClaim = S.claimReview(db, 'peer/main', assigned.review.id, Number(assigned.review.task_version) - 1);
  ok('陈旧 task version 认领被拒', staleClaim.ok === false && staleClaim.reason === 'version_mismatch', staleClaim);

  console.log('\n[6] done 必须由 verdict 放行');
  const blockedDone = S.updateTask(db, 'lead/main', peerTask2.id, 'done', '我直接收尾', undefined, policy.permissions.accept);
  ok('active 评审未 verdict 时不许 done', blockedDone.ok === false && blockedDone.reason === 'review_pending', blockedDone);
  const ownerSubmit = S.submitReview(db, 'worker/main', assigned.review.id, { verdict: 'approved', summary: '自审通过', version: assigned.review.task_version });
  ok('owner 不能提交 verdict', ownerSubmit.ok === false && ownerSubmit.reason === 'self_review', ownerSubmit);
  const staleSubmit = S.submitReview(db, 'peer/main', assigned.review.id, { verdict: 'approved', summary: 'x', version: Number(assigned.review.task_version) + 1 });
  ok('陈旧 task version 提交被拒', staleSubmit.ok === false && staleSubmit.reason === 'version_mismatch', staleSubmit);
  const badVerdict = S.submitReview(db, 'peer/main', assigned.review.id, { verdict: 'lgtm', summary: 'x', version: assigned.review.task_version });
  ok('非法 verdict 被拒', badVerdict.ok === false && badVerdict.reason === 'invalid_verdict', badVerdict);
  const approved = S.submitReview(db, 'peer/main', assigned.review.id, { verdict: 'approved', summary: '18 tests pass', version: assigned.review.task_version });
  ok('approved 才把任务推进到 done', approved.ok === true && approved.task.status === 'done' && approved.review.status === 'completed' && approved.review.verdict === 'approved', approved);
  const afterDone = S.updateTask(db, 'lead/main', peerTask2.id, 'done', '重复收尾', undefined, policy.permissions.accept);
  ok('已完成的任务不能再收尾', afterDone.ok === false);
  const resubmit = S.submitReview(db, 'peer/main', assigned.review.id, { verdict: 'approved', summary: 'again', version: assigned.review.task_version });
  ok('同一条评审只能提交一次', resubmit.ok === false && resubmit.reason === 'already_submitted', resubmit);

  console.log('\n[7] changes_requested：进入下一轮');
  const changesTask = makeTask();
  S.claim(db, 'worker/main', changesTask.id, 15);
  S.updateTask(db, 'worker/main', changesTask.id, 'in_progress');
  const changesReview = S.updateTask(db, 'worker/main', changesTask.id, 'review').review;
  S.claimReview(db, changesReview.reviewer, changesReview.id, changesReview.task_version);
  const changes = S.submitReview(db, changesReview.reviewer, changesReview.id, { verdict: 'changes_requested', summary: '缺少边界测试', version: changesReview.task_version });
  ok('changes_requested 必须调用 retryTask 进入下一轮', changes.ok === true && changes.retried === true && changes.task.status === 'open' && Number(changes.task.round_count) === 1, changes);
  ok('评审状态记为 changes_requested', changes.review.status === 'changes_requested' && changes.review.verdict === 'changes_requested');
  ok('下一轮会重新建评审（旧那条不再 active）', (function () {
    const again = S.createReviewAssignment(db, policy, changesTask.id, {});
    return again.ok === true && reviewCount(changesTask.id) === 2 && again.review.status === 'pending';
  })());

  console.log('\n[8] Auto：只有 guard 干净 + 冻结验证器成功才自动通过');
  const autoTask = frozenTask();
  cleanGuard(autoTask.id);
  verificationRow(autoTask.id, { ok: true, spec_hash: 'hash-smoke' });
  S.claim(db, 'worker/main', autoTask.id, 15);
  S.updateTask(db, 'worker/main', autoTask.id, 'in_progress');
  const autoReview = S.updateTask(db, 'worker/main', autoTask.id, 'review');
  ok('满足条件时自动完成', autoReview.ok === true && autoReview.auto_completed === true && autoReview.review.verdict === 'approved' && autoReview.task.status === 'done', autoReview.review);
  ok('自动验收留下 guard 事件', !!db.prepare("SELECT 1 FROM guard_events WHERE task_id = ? AND action = 'auto_approved'").get(autoTask.id));

  const dirtyTask = frozenTask();
  S.setGuard(db, dirtyTask.id, { guard: { ok: false, hard: ['fs:delete'], soft: [] }, changed_files: 2 });
  verificationRow(dirtyTask.id, { ok: true, spec_hash: 'hash-smoke' });
  S.claim(db, 'worker/main', dirtyTask.id, 15);
  S.updateTask(db, 'worker/main', dirtyTask.id, 'in_progress');
  const dirtyReview = S.updateTask(db, 'worker/main', dirtyTask.id, 'review');
  ok('guard 有 hard 阻塞时降级 human，不自动通过', dirtyReview.auto_completed === false && dirtyReview.review.route === 'human' && dirtyReview.review.reviewer === 'human' && dirtyReview.task.status === 'review', dirtyReview.review);

  const failedVerificationTask = frozenTask();
  cleanGuard(failedVerificationTask.id);
  verificationRow(failedVerificationTask.id, { ok: false, exit: 7 });
  S.claim(db, 'worker/main', failedVerificationTask.id, 15);
  S.updateTask(db, 'worker/main', failedVerificationTask.id, 'in_progress');
  const failedVerificationReview = S.updateTask(db, 'worker/main', failedVerificationTask.id, 'review');
  ok('验证器失败时降级 human', failedVerificationReview.auto_completed === false && failedVerificationReview.review.route === 'human', failedVerificationReview.review);

  const noVerifierTask = makeTask({ cost_class: 'docs' });
  cleanGuard(noVerifierTask.id);
  S.claim(db, 'worker/main', noVerifierTask.id, 15);
  S.updateTask(db, 'worker/main', noVerifierTask.id, 'in_progress');
  const noVerifierReview = S.updateTask(db, 'worker/main', noVerifierTask.id, 'review');
  ok('没有冻结验证器时降级 human', noVerifierReview.auto_completed === false && noVerifierReview.review.route === 'human' && noVerifierReview.task.status === 'review', noVerifierReview.review);

  console.log('\n[9] Lead 与 Human 路由的权限边界');
  const leadTask = makeTask({ cost_class: 'architectural' });
  cleanGuard(leadTask.id);
  S.claim(db, 'worker/main', leadTask.id, 15);
  S.updateTask(db, 'worker/main', leadTask.id, 'in_progress');
  const leadReview = S.updateTask(db, 'worker/main', leadTask.id, 'review').review;
  ok('architectural 路由给 Lead', leadReview.route === 'lead' && leadReview.reviewer === 'lead/main', leadReview);
  ok('非 Lead 不能提交 Lead 评审', S.submitReview(db, 'peer/main', leadReview.id, { verdict: 'approved', version: leadReview.task_version }).reason === 'not_reviewer');
  const leadApproved = S.submitReview(db, 'lead/main', leadReview.id, { verdict: 'approved', summary: '接口边界已确认', version: leadReview.task_version });
  ok('Lead 提交 approved 后进入 done', leadApproved.ok === true && leadApproved.task.status === 'done', leadApproved.task && leadApproved.task.status);

  const humanTask = makeTask({ cost_class: 'docs' });
  S.setGuard(db, humanTask.id, { guard: { ok: false, hard: ['cfg:edit'], soft: [] }, changed_files: 1, needs_human: 1 });
  S.claim(db, 'worker/main', humanTask.id, 15);
  S.updateTask(db, 'worker/main', humanTask.id, 'in_progress');
  const humanReview = S.updateTask(db, 'worker/main', humanTask.id, 'review').review;
  ok('needs_human 路由给 human', humanReview.route === 'human' && humanReview.reviewer === 'human', humanReview);
  ok('普通 agent 不能认领 Human 评审', S.claimReview(db, 'peer/main', humanReview.id, humanReview.task_version).reason === 'human_route');
  ok('普通 agent 不能提交 Human 评审', S.submitReview(db, 'peer/main', humanReview.id, { verdict: 'approved', version: humanReview.task_version }).reason === 'not_reviewer');
  const humanApproved = S.submitReview(db, 'human', humanReview.id, { verdict: 'approved', summary: '人类放行', version: humanReview.task_version });
  ok('human 提交 approved 才收尾', humanApproved.ok === true && humanApproved.task.status === 'done', humanApproved.task && humanApproved.task.status);

  console.log('\n[10] 评审超时：只升级当前 assignment');
  const staleTask = makeTask();
  cleanGuard(staleTask.id);
  S.claim(db, 'worker/main', staleTask.id, 15);
  S.updateTask(db, 'worker/main', staleTask.id, 'in_progress');
  const staleReview = S.updateTask(db, 'worker/main', staleTask.id, 'review').review;
  db.prepare('UPDATE tasks SET updated_at = ? WHERE id = ?').run(new Date(Date.now() - 120 * 60000).toISOString(), staleTask.id);
  const swept = S.sweepReviews(db, policy);
  ok('超时被升级', swept.escalated.indexOf(staleTask.id) >= 0, swept);
  ok('当前 assignment 被标记 escalated', S.getReview(db, staleReview.id).status === 'escalated');
  const countAfter = reviewCount(staleTask.id);
  S.sweepReviews(db, policy);
  ok('再扫一次不会新建评审', reviewCount(staleTask.id) === countAfter);

  console.log('\n[11] listReviews');
  const byTask = S.listReviews(db, { task_id: peerTask2.id });
  ok('按任务过滤并带出任务快照', byTask.length === 1 && byTask[0].task_title === '评审任务' && byTask[0].verdict === 'approved', byTask[0]);
  const byReviewer = S.listReviews(db, { reviewer: 'peer/main' });
  ok('按 reviewer 过滤', byReviewer.length >= 1 && byReviewer.every(function (r) { return r.reviewer === 'peer/main'; }));
  const humanOnly = S.listReviews(db, { route: 'human' });
  ok('按 route 过滤', humanOnly.length >= 2 && humanOnly.every(function (r) { return r.route === 'human'; }));
  ok('open 只看 pending/active', S.listReviews(db, { open: true }).every(function (r) { return ['pending', 'active'].indexOf(r.status) >= 0; }));
  ok('按项目过滤', S.listReviews(db, { project: 'proj-review' }).length >= 3);
} finally {
  db.close();
  if (oldPolicyEnv === undefined) delete process.env.BUS_POLICY_PATH; else process.env.BUS_POLICY_PATH = oldPolicyEnv;
  fs.rmSync(tmp, { recursive: true, force: true });
}

console.log('\n==================================');
console.log('PASS ' + pass + '   FAIL ' + fail);
process.exitCode = fail ? 1 : 0;
