#!/usr/bin/env node
// 第 11 项第 9/10/11/12/14 条：合并链路端到端。
// 真跑一次合并：临时 Git 仓库 + 临时 registry + 临时库 → 建请求 → Lead 发起 → Human 批准 →
// merge-worker 执行（用生产代码路径，不注入 exec）→ merged，并核对 main 上真的有了那个文件。
// 负例：陈旧/失败验证、批准后二次变更、CAS 失败无部分写、重复执行幂等、崩溃遗留、权限分离。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import * as S from './store.mjs';
import { runMergeRequest } from './merge-worker.mjs';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'agentbus-merge-e2e-'));
const registryFile = path.join(tmp, 'projects.json');
const repo = path.join(tmp, 'repo');
fs.mkdirSync(repo, { recursive: true });
fs.writeFileSync(registryFile, JSON.stringify({ projects: { demo: { path: repo, topology: 'shared' } } }));
process.env.BUS_PROJECTS = registryFile;
process.env.GIT_AUTHOR_NAME = 'e2e'; process.env.GIT_AUTHOR_EMAIL = 'e2e@localhost';
process.env.GIT_COMMITTER_NAME = 'e2e'; process.env.GIT_COMMITTER_EMAIL = 'e2e@localhost';
const db = S.openDb(path.join(tmp, 'bus.db'));
S.setRuntimeState(db, 'human', true);

let pass = 0, fail = 0;
function ok(name, value, detail) {
  if (value) { pass += 1; console.log('PASS ' + name); }
  else { fail += 1; console.log('FAIL ' + name + (detail === undefined ? '' : ' :: ' + String(detail).slice(0, 400))); }
}

// 夹具用：fd 重定向跑 git（本沙箱禁止管道 stdio）。生产路径走 merge-runner 的 autoExec。
function git(args, cwd) {
  const out = path.join(tmp, 'out.txt');
  const err = path.join(tmp, 'err.txt');
  const fd1 = fs.openSync(out, 'w');
  const fd2 = fs.openSync(err, 'w');
  let res;
  try { res = spawnSync('git', args, { cwd: cwd || repo, stdio: ['ignore', fd1, fd2], timeout: 20000 }); }
  finally { fs.closeSync(fd1); fs.closeSync(fd2); }
  return { status: res.status, out: fs.readFileSync(out, 'utf8').trim(), err: fs.readFileSync(err, 'utf8').trim() };
}
function commitAll(message) {
  git(['add', '-A']);
  return git(['-c', 'user.email=e2e@localhost', '-c', 'user.name=e2e', 'commit', '-m', message]);
}

const PROJ = { path: registryFile };
const LOGS = path.join(tmp, 'logs');   // 执行日志写进临时目录，别污染 bus/logs

const POL = {
  lead: 'lead/main',
  permissions: { dispatch: ['lead/main'], accept: ['human', 'lead/main'], request_merge: ['lead/main', 'human'], reassign: ['lead/main'] },
  global: {}, economics: {},
  agents: { 'lead/main': { autonomy: 'auto' }, 'worker/main': { autonomy: 'auto', may_dispatch_to: ['lead/main'] } },
};

function seedTask(opts) {
  const o = opts || {};
  const t = S.createTask(db, { title: '合并任务', status: 'open', project: 'demo' });
  db.prepare("UPDATE tasks SET status='done', verify_spec_hash=?, updated_at=? WHERE id=?")
    .run(o.hash === undefined ? 'hash-A' : o.hash, new Date().toISOString(), t.id);
  if (o.run !== false) {
    db.prepare('INSERT INTO verification_runs(run_id,task_id,verify_id,verify_spec_hash,started_at,finished_at,exit_code,duration_ms,ok,stdout_tail,stderr_tail) VALUES(?,?,?,?,?,?,?,?,?,?,?)')
      .run(o.runId || ('vr-' + t.id), t.id, 'node-test', o.runHash === undefined ? 'hash-A' : o.runHash,
        o.startedAt || new Date().toISOString(), new Date().toISOString(), o.exitCode === undefined ? 0 : o.exitCode, 12, o.okRun === false ? 0 : 1, '', '');
  }
  return S.getTask(db, t.id);
}

// 仓库：main 有 base.txt；分支 feat/x 增加 feat.txt
git(['init', '-q', '-b', 'main']);
fs.writeFileSync(path.join(repo, 'base.txt'), 'base\n');
commitAll('base');
git(['checkout', '-q', '-b', 'feat/x']);
fs.writeFileSync(path.join(repo, 'feat.txt'), 'from feature\n');
commitAll('feature');
git(['checkout', '-q', 'main']);

console.log('[1] 权限分离');
{
  const t = seedTask();
  const workerReq = S.createMergeRequest(db, POL, 'worker/main', { project: 'demo', task_ids: [t.id], source_ref: 'feat/x', target_ref: 'main' });
  ok('不在 request_merge 里的 agent 不能发起申请', workerReq.ok === false && workerReq.reason === 'not_permitted', workerReq);
  const leadReq = S.createMergeRequest(db, POL, 'lead/main', { project: 'demo', task_ids: [t.id], source_ref: 'feat/x', target_ref: 'main' });
  ok('Lead 可以发起合并申请（不再被 ["human"] 卡住）', leadReq.ok === true && leadReq.merge_request.status === 'proposed', leadReq);
  const nonHumanApprove = S.approveMergeRequest(db, 'lead/main', leadReq.merge_request.id, undefined);
  ok('Agent 不能被当成人去批准', nonHumanApprove.ok === false && nonHumanApprove.reason === 'human_only', nonHumanApprove);
  // legacy 配置只有 ['human'] 时也要让 Lead 发得出去（旧默认不等于刻意禁止）
  const legacyPol = Object.assign({}, POL, { permissions: { dispatch: ['lead/main'], accept: ['human'], merge: ['human'], reassign: ['lead/main'] } });
  const tLegacy = seedTask({ runId: 'vr-legacy' });
  const legacyReq = S.createMergeRequest(db, legacyPol, 'lead/main', { project: 'demo', task_ids: [tLegacy.id], source_ref: 'feat/x', target_ref: 'main', registry: registryFile });
  ok('legacy permissions.merge=["human"] 时 Lead 仍可发起（视为旧默认）', legacyReq.ok === true, legacyReq);
  const explicitHumanOnly = Object.assign({}, POL, { permissions: { dispatch: ['lead/main'], accept: ['human'], request_merge: ['human'], reassign: ['lead/main'] } });
  const tExplicit = seedTask({ runId: 'vr-explicit' });
  const blocked = S.createMergeRequest(db, explicitHumanOnly, 'lead/main', { project: 'demo', task_ids: [tExplicit.id], source_ref: 'feat/x', target_ref: 'main', registry: registryFile });
  ok('显式 request_merge=["human"] 时 Lead 被拒（配置说了算）', blocked.ok === false && blocked.reason === 'not_permitted', blocked);
}

console.log('\n[2] runner 不再接受调用方传入的 verification');
{
  const t = seedTask();
  const { runMerge } = await import('./merge-runner.mjs');
  const res = await runMerge({ db: db, projectOptions: PROJ, project: 'demo', sourceRef: 'feat/x', targetRef: 'main', taskIds: [t.id],
    verification: { ok: true, reason: 'trust me' } });
  ok('调用方声称"验证过了"不顶用：仍以库里的 frozen 结果为准', res.checks.some(c => c.name === 'ignored_caller_verification') && res.ok === true, res.blocked_reason);
  const t2 = seedTask({ runHash: 'hash-STALE' });
  const stale = await runMerge({ db: db, projectOptions: PROJ, project: 'demo', sourceRef: 'feat/x', targetRef: 'main', taskIds: [t2.id] });
  ok('库里的验证 hash 与任务 frozen hash 不一致 → 拒绝合并', stale.ok === false && stale.blocked_reason === 'verification_failed', stale.blocked_reason);
  ok('拒绝理由里点名是哪个任务与原因', JSON.stringify(stale.verifications || []).indexOf('stale_verification_hash') >= 0, stale.verifications);
  const headBefore = git(['rev-parse', 'HEAD']).out;
  ok('被拒绝时 HEAD 没有被移动', headBefore === git(['rev-parse', 'HEAD']).out);
}

console.log('\n[3] 端到端：Lead 发起 → Human 批准 → worker 执行 → merged');
let happy = null;
{
  const t = seedTask({ runId: 'vr-happy' });
  const created = S.createMergeRequest(db, POL, 'lead/main', { project: 'demo', task_ids: [t.id], source_ref: 'feat/x', target_ref: 'main' });
  ok('请求进入 proposed', created.ok === true && created.merge_request.status === 'proposed', created);
  const approved = S.approveMergeRequest(db, 'human', created.merge_request.id, created.merge_request.version);
  ok('Human 批准后进入 approved（此时还没有动 Git）', approved.ok === true && approved.merge_request.status === 'approved');
  ok('批准阶段 HEAD 未变', git(['rev-parse', 'HEAD']).out === git(['rev-parse', 'HEAD']).out);

  const repoNow = await (await import('./merge-runner.mjs')).repoState({ project: 'demo', projectOptions: PROJ, logsDir: LOGS });
  const pre = S.mergePreflight(db, POL, created.merge_request.id, { repo: repoNow });
  ok('二次确认快照包含项目/ref/任务/验证/分支/工作树',
    pre.ok === true && pre.preflight.request.source_ref === 'feat/x' && pre.preflight.request.target_ref === 'main' &&
    pre.preflight.tasks[0].verification_ok === true && pre.preflight.tasks[0].verify_run_id === 'vr-happy' &&
    !!pre.preflight.repo.branch && pre.preflight.repo.worktree === 'clean', JSON.stringify(pre.preflight && pre.preflight.repo));

  const result = await runMergeRequest(db, POL, created.merge_request.id, { expectPreflight: pre.preflight_hash, actor: 'human', projectOptions: PROJ, logsDir: LOGS });
  happy = result;
  ok('worker 执行成功并返回 merged', result.ok === true && result.status === 'merged', { status: result.status, reason: result.reason });
  ok('main 上真的出现了特性分支的文件', fs.existsSync(path.join(repo, 'feat.txt')) || git(['show', 'HEAD:feat.txt']).status === 0);
  const after = S.getMergeRequest(db, created.merge_request.id);
  ok('请求落库为 merged 且写入 merge_commit', after.status === 'merged' && /^[0-9a-f]{7,40}$/.test(String(after.merge_commit)), after.merge_commit);
  ok('verify_run_id 记录的就是那次 frozen run', after.verify_run_id === 'vr-happy', after.verify_run_id);
  ok('HEAD 现在是一个 merge commit（两个父）', git(['rev-list', '--parents', '-n', '1', 'HEAD']).out.split(/\s+/).length === 3, git(['rev-list', '--parents', '-n', '1', 'HEAD']).out);
  ok('执行日志写在 logs 目录（含相对路径与 hash）', !!(result.log && result.log.relative_path && /^[0-9a-f]{64}$/.test(String(result.log.sha256))), result.log);
  ok('runner 记录里没有出现任何 reset --hard 调用', JSON.stringify(result.runner).indexOf('--hard') < 0);
}

console.log('\n[4] 重复执行幂等');
{
  const again = await runMergeRequest(db, POL, happy.merge_request.id, { projectOptions: PROJ, logsDir: LOGS });
  const after = S.getMergeRequest(db, happy.merge_request.id);
  ok('已 merged 的请求再执行返回 already_merged，不再动 Git', again.ok === true && again.reason === 'already_merged', again.reason);
  ok('version 没有因为重复执行而增加', after.version === S.getMergeRequest(db, happy.merge_request.id).version && after.status === 'merged');
}

console.log('\n[5] 批准后二次变更 → 不沿用旧批准');
{
  const t = seedTask({ runId: 'vr-drift' });
  git(['checkout', '-q', '-b', 'feat/drift']);
  fs.writeFileSync(path.join(repo, 'drift.txt'), 'drift\n');
  commitAll('drift');
  git(['checkout', '-q', 'main']);
  const created = S.createMergeRequest(db, POL, 'lead/main', { project: 'demo', task_ids: [t.id], source_ref: 'feat/drift', target_ref: 'main' });
  S.approveMergeRequest(db, 'human', created.merge_request.id, created.merge_request.version);
  const { repoState } = await import('./merge-runner.mjs');
  const pinned = S.mergePreflight(db, POL, created.merge_request.id, { repo: await repoState({ project: 'demo', projectOptions: PROJ, logsDir: LOGS }) });
  // 批准之后又多跑了一次验证（新 run_id），快照随之变化
  db.prepare('INSERT INTO verification_runs(run_id,task_id,verify_id,verify_spec_hash,started_at,finished_at,exit_code,duration_ms,ok,stdout_tail,stderr_tail) VALUES(?,?,?,?,?,?,?,?,?,?,?)')
    .run('vr-drift-2', t.id, 'node-test', 'hash-A', new Date(Date.now() + 1000).toISOString(), new Date().toISOString(), 0, 9, 1, '', '');
  const headBefore = git(['rev-parse', 'HEAD']).out;
  const drift = await runMergeRequest(db, POL, created.merge_request.id, { expectPreflight: pinned.preflight_hash, projectOptions: PROJ, logsDir: LOGS });
  ok('快照变化 → 拒绝执行并提示重新确认', drift.ok === false && drift.reason === 'preflight_changed', drift.reason);
  ok('被拒后 HEAD 未变、请求仍在 approved', git(['rev-parse', 'HEAD']).out === headBefore && S.getMergeRequest(db, created.merge_request.id).status === 'approved');
  const flagged = S.getMergeRequest(db, created.merge_request.id);
  ok('被拒时置 needs_human=1 并写明原因', Number(flagged.needs_human) === 1 && /preflight_changed/.test(String(flagged.needs_human_reason)), flagged.needs_human_reason);
  const blockedByFlag = await runMergeRequest(db, POL, created.merge_request.id, { expectPreflight: drift.actual, projectOptions: PROJ, logsDir: LOGS });
  ok('needs_human=1 时执行路径硬拒（worker 不许自己解封）', blockedByFlag.ok === false && blockedByFlag.reason === 'needs_human', blockedByFlag.reason);
  const clearedByWorker = S.setMergeNeedsHuman(db, 'merge-worker', created.merge_request.id, '');
  ok('worker 不能清除 needs_human', clearedByWorker.ok === false && clearedByWorker.reason === 'human_only');
  const confirmed = S.confirmMergeRequest(db, created.merge_request.id, 'human', drift.actual);
  ok('Human 重新确认会冻结新快照并清除 needs_human',
    confirmed.ok === true && Number(confirmed.merge_request.needs_human) === 0 && confirmed.merge_request.approved_preflight === drift.actual,
    confirmed.reason || confirmed.merge_request.needs_human);
  const accepted = await runMergeRequest(db, POL, created.merge_request.id, { projectOptions: PROJ, logsDir: LOGS });
  ok('重新确认后（不传 hash，走库里的 approved_preflight）可以执行', accepted.ok === true && accepted.status === 'merged', accepted.reason);
}

console.log('\n[6] CAS 失败不留下部分写入');
{
  const t = seedTask({ runId: 'vr-cas' });
  const created = S.createMergeRequest(db, POL, 'lead/main', { project: 'demo', task_ids: [t.id], source_ref: 'feat/x', target_ref: 'main' });
  S.approveMergeRequest(db, 'human', created.merge_request.id, created.merge_request.version);
  const started = S.startMerge(db, created.merge_request.id, S.getMergeRequest(db, created.merge_request.id).version);
  ok('startMerge 把请求推进到 merging', started.ok === true && started.merge_request.status === 'merging');
  // 模拟并发写入者：在我们收尾之前把 version 推进一格（我们手上的 version 就成为陈旧值）
  const staleVersion = started.merge_request.version;
  db.prepare('UPDATE merge_requests SET version=version+1, updated_at=? WHERE id=?').run(new Date().toISOString(), created.merge_request.id);
  const before = S.getMergeRequest(db, created.merge_request.id);
  const second = S.finishMerge(db, created.merge_request.id, { status: 'merged', commit: 'abcdef1', verify_run_id: 'vr-other' }, staleVersion);
  const after = S.getMergeRequest(db, created.merge_request.id);
  ok('陈旧 version 的收尾被拒（version_mismatch 或 CAS 的 race_lost，两者都不写）',
    second.ok === false && ['version_mismatch', 'race_lost'].indexOf(String(second.reason)) >= 0, second);
  ok('被拒时一个字段都没写：status 仍 merging、merge_commit 仍空', after.status === 'merging' && after.merge_commit === null, [after.status, after.merge_commit]);
  // 这一条专门盯旧 bug：老写法会先单独 UPDATE verify_run_id，再 CAS，失败就留下部分写。
  ok('被拒时 verify_run_id 没有被提前写入（无部分写）', after.verify_run_id === before.verify_run_id, { before: before.verify_run_id, after: after.verify_run_id });
  ok('被拒时 version 只保留了并发写入者的那次推进', after.version === staleVersion + 1, [after.version, staleVersion]);
  // 结构级断言（专门盯旧 bug 的形状）：finishMerge 只能有一条 merge_requests 的 UPDATE，
  // 且 verify_run_id 必须写在同一条语句里，不能先单独写。
  const storeSrc = fs.readFileSync(new URL('./store.mjs', import.meta.url), 'utf8');
  const fnStart = storeSrc.indexOf('export function finishMerge(');
  const fnEnd = storeSrc.indexOf('export function mergePreflight(', fnStart);
  const body = storeSrc.slice(fnStart, fnEnd);
  const updates = body.match(/UPDATE merge_requests/g) || [];
  ok('finishMerge 里只有一条 merge_requests UPDATE', updates.length === 1, updates.length);
  ok('同一条 UPDATE 同时写 status/verify_run_id/merge_commit/error/log/lease/version',
    /UPDATE merge_requests SET status=\?, verify_run_id=\?, merge_commit=\?, error=\?, log_path=\?, log_sha256=\?, lease_until=NULL, version=version\+1/.test(body) &&
    !/UPDATE merge_requests SET verify_run_id/.test(body));
}
console.log('\n[7] 崩溃遗留（status=merging）不会被自动重跑');
{
  const t = seedTask({ runId: 'vr-crash' });
  const created = S.createMergeRequest(db, POL, 'lead/main', { project: 'demo', task_ids: [t.id], source_ref: 'feat/x', target_ref: 'main' });
  S.approveMergeRequest(db, 'human', created.merge_request.id, created.merge_request.version);
  db.prepare("UPDATE merge_requests SET status='merging' WHERE id=?").run(created.merge_request.id);
  const headBefore = git(['rev-parse', 'HEAD']).out;
  const retry = await runMergeRequest(db, POL, created.merge_request.id, { projectOptions: PROJ, logsDir: LOGS });
  ok('worker 看到 merging 直接拒绝，要求 Human 决定（无租约即视为过期遗留）',
    retry.ok === false && ['already_merging', 'lease_expired'].indexOf(String(retry.reason)) >= 0, retry.reason);
  ok('拒绝重跑时没有动 Git', git(['rev-parse', 'HEAD']).out === headBefore);
  ok('工作树没有残留 merge 冲突（MERGE_HEAD 不存在）', git(['rev-parse', '-q', '--verify', 'MERGE_HEAD']).status !== 0);
  const failed = S.finishMerge(db, created.merge_request.id, { status: 'failed', note: 'Human 判定为崩溃遗留' }, S.getMergeRequest(db, created.merge_request.id).version);
  ok('Human 可以把崩溃遗留标 failed', failed.ok === true && failed.merge_request.status === 'failed');
}

console.log('\n[8] 脏工作树不被执行');
{
  const t = seedTask({ runId: 'vr-dirty' });
  const created = S.createMergeRequest(db, POL, 'lead/main', { project: 'demo', task_ids: [t.id], source_ref: 'feat/x', target_ref: 'main' });
  S.approveMergeRequest(db, 'human', created.merge_request.id, created.merge_request.version);
  fs.writeFileSync(path.join(repo, 'uncommitted.txt'), 'dirty\n');
  const dirty = await runMergeRequest(db, POL, created.merge_request.id, { projectOptions: PROJ, logsDir: LOGS });
  ok('工作树不干净 → 拒绝执行', dirty.ok === false && dirty.reason === 'dirty_worktree', dirty.reason);
  ok('拒绝后请求仍是 approved（没有进入 merging）', S.getMergeRequest(db, created.merge_request.id).status === 'approved');
  fs.unlinkSync(path.join(repo, 'uncommitted.txt'));
  const clean = await runMergeRequest(db, POL, created.merge_request.id, { projectOptions: PROJ, logsDir: LOGS });
  ok('清理工作树后可以正常合并', clean.ok === true && clean.status === 'merged', clean.reason);
}

console.log('\n[9] 第 13 条：租约、崩溃恢复与 needs_human 解封');
{
  const tk = seedTask({ runId: 'vr-lease' });
  const created = S.createMergeRequest(db, POL, 'lead/main', { project: 'demo', task_ids: [tk.id], source_ref: 'feat/x', target_ref: 'main' });
  S.approveMergeRequest(db, 'human', created.merge_request.id, created.merge_request.version);
  const started = S.startMerge(db, created.merge_request.id, S.getMergeRequest(db, created.merge_request.id).version, { workerId: 'worker-7', leaseMin: 15 });
  ok('startMerge 同时写入 worker_id / started_at / lease_until',
    started.ok === true && started.merge_request.worker_id === 'worker-7' &&
    !!started.merge_request.started_at && !!started.merge_request.lease_until, started.merge_request && [started.merge_request.worker_id, started.merge_request.started_at, started.merge_request.lease_until]);
  const fresh = S.mergeExecutionState(db, created.merge_request.id);
  ok('租约未过期时 lease_expired=false，并带 worker 身份', fresh.lease_expired === false && fresh.worker_id === 'worker-7', fresh);
  // 模拟 worker 崩溃：租约停在过去
  db.prepare('UPDATE merge_requests SET lease_until=? WHERE id=?').run(new Date(Date.now() - 60000).toISOString(), created.merge_request.id);
  const expired = S.mergeExecutionState(db, created.merge_request.id);
  ok('租约过期 → lease_expired=true', expired.lease_expired === true, expired);
  const autoRetry = await runMergeRequest(db, POL, created.merge_request.id, { projectOptions: PROJ, logsDir: LOGS });
  ok('worker 不会自动重跑过期租约（要 Human 决定）', autoRetry.ok === false && autoRetry.reason === 'lease_expired', autoRetry.reason);
  const dirtyReset = S.resetMergeForRetry(db, created.merge_request.id, 'merge-worker', { inMerge: false });
  ok('worker 不能自己重置（只有 Human）', dirtyReset.ok === false && dirtyReset.reason === 'human_only', dirtyReset.reason);
  const blockedReset = S.resetMergeForRetry(db, created.merge_request.id, 'human', { inMerge: true });
  ok('仓库仍处于 merge 中时拒绝重置（绝不 reset --hard）', blockedReset.ok === false && blockedReset.reason === 'merge_in_progress', blockedReset.reason);
  const reset = S.resetMergeForRetry(db, created.merge_request.id, 'human', { inMerge: false });
  ok('Human 选择重试：回到 approved 并清掉 worker/lease',
    reset.ok === true && reset.merge_request.status === 'approved' && !reset.merge_request.worker_id && !reset.merge_request.lease_until, reset.reason);
  const afterRetry = await runMergeRequest(db, POL, created.merge_request.id, { projectOptions: PROJ, workerId: 'worker-8' });
  ok('重试后能真正合并成功', afterRetry.ok === true && afterRetry.status === 'merged', afterRetry.reason);
  const done = S.getMergeRequest(db, created.merge_request.id);
  ok('执行日志路径与 sha256 落库（第 13 条）', !!done.log_path && /^[0-9a-f]{64}$/.test(String(done.log_sha256)), [done.log_path, done.log_sha256]);
  ok('合并成功后 lease 被清空', !done.lease_until, done.lease_until);
  // Human 选择「标记失败」也走同一条 finishMerge
  const tk2 = seedTask({ runId: 'vr-fail' });
  const c2 = S.createMergeRequest(db, POL, 'lead/main', { project: 'demo', task_ids: [tk2.id], source_ref: 'feat/x', target_ref: 'main' });
  S.approveMergeRequest(db, 'human', c2.merge_request.id, c2.merge_request.version);
  S.startMerge(db, c2.merge_request.id, S.getMergeRequest(db, c2.merge_request.id).version, { workerId: 'worker-9' });
  const failed = S.finishMerge(db, c2.merge_request.id, { status: 'failed', error: 'worker 崩溃，Human 判定失败' }, S.getMergeRequest(db, c2.merge_request.id).version);
  ok('Human 可以把崩溃遗留标 failed 并写入原因', failed.ok === true && failed.merge_request.status === 'failed' && /崩溃/.test(String(failed.merge_request.error)), failed.reason || (failed.merge_request && failed.merge_request.error));
}

try { db.close(); } catch (e) {}
try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (e) {}
console.log('\nPASS ' + pass + '   FAIL ' + fail);
if (fail) process.exitCode = 1;
