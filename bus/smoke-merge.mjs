#!/usr/bin/env node
// 第 11 项：合并请求数据层。临时库 + 临时 registry + 临时 Git 仓库。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import * as S from './store.mjs';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'agentbus-merge-'));
const registryFile = path.join(tmp, 'projects.json');
const repo = path.join(tmp, 'repo');
fs.mkdirSync(repo, { recursive: true });
fs.writeFileSync(registryFile, JSON.stringify({ projects: { demo: { path: repo, topology: 'shared' }, legacy: { path: repo, lead: 'codex/main' } } }));
process.env.BUS_PROJECTS = registryFile;
const db = S.openDb(path.join(tmp, 'bus.db'));
S.setRuntimeState(db, 'human', true);

const POL = {
  lead: 'lead/main',
  permissions: { dispatch: ['lead/main'], accept: ['human', 'lead/main'], merge: ['human', 'lead/main'], reassign: ['lead/main'] },
  global: {}, economics: {}, agents: { 'lead/main': { autonomy: 'auto' }, 'worker/main': { autonomy: 'auto' } },
};

let pass = 0, fail = 0;
function ok(name, value, detail) {
  if (value) { pass += 1; console.log('  PASS  ' + name); }
  else { fail += 1; console.log('  FAIL  ' + name + (detail ? ' — ' + JSON.stringify(detail) : '')); }
}
// 用 fd 重定向跑 git：本沙箱禁止带管道 stdio 的 spawn
function git(args, cwd) {
  const out = path.join(tmp, 'out.txt');
  const err = path.join(tmp, 'err.txt');
  const fd1 = fs.openSync(out, 'w');
  const fd2 = fs.openSync(err, 'w');
  let res;
  try {
    res = spawnSync('git', args, { cwd: cwd || repo, stdio: ['ignore', fd1, fd2], timeout: 20000 });
  } finally { fs.closeSync(fd1); fs.closeSync(fd2); }
  return { status: res.status, out: fs.readFileSync(out, 'utf8').trim(), err: fs.readFileSync(err, 'utf8').trim() };
}
function commitAll(message) {
  git(['add', '-A']);
  return git(['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-m', message]);
}
function doneTask(project) {
  const t = S.createTask(db, { title: '合并任务', status: 'open', project: project || 'demo' });
  db.prepare("UPDATE tasks SET status='done', updated_at=? WHERE id=?").run(S.nowIso(), t.id);
  return t;
}
function dirtyTree() { return git(['status', '--porcelain']).out.length > 0; }

try {
  console.log('[1] 单一全局 Lead');
  ok('effectiveLead 直接取 policy.lead', S.effectiveLead(POL) === 'lead/main');
  ok('Lead 为 human 时返回 human', S.effectiveLead({ lead: 'human' }) === 'human');
  ok('策略缺 Lead 时回落到 human', S.effectiveLead({}) === 'human' && S.effectiveLead(null) === 'human');

  console.log('\n[2] 创建合并请求：权限与前置条件');
  const taskA = doneTask();
  ok('无 permissions.merge 的人不能创建', S.createMergeRequest(db, POL, 'worker/main', { project: 'demo', task_ids: [taskA.id], source_ref: 'feat' }).reason === 'not_permitted');
  ok('未登记项目被拒', S.createMergeRequest(db, POL, 'lead/main', { project: 'nope', task_ids: [taskA.id], source_ref: 'feat' }).reason === 'project_not_registered');
  const openTask = S.createTask(db, { title: '未完成任务', status: 'open', project: 'demo' });
  ok('关联任务必须 done', S.createMergeRequest(db, POL, 'lead/main', { project: 'demo', task_ids: [openTask.id], source_ref: 'feat' }).reason === 'task_not_done');
  ok('ref 不能是远端写法/危险串', S.createMergeRequest(db, POL, 'lead/main', { project: 'demo', task_ids: [taskA.id], source_ref: '-f' }).reason === 'invalid_source_ref');
  const created = S.createMergeRequest(db, POL, 'lead/main', { project: 'demo', task_ids: [taskA.id], source_ref: 'feat/x', target_ref: 'main' });
  ok('授权人创建成功且初始 proposed', created.ok === true && created.merge_request.status === 'proposed' && created.merge_request.version === 0, created.merge_request);
  const dup = S.createMergeRequest(db, POL, 'lead/main', { project: 'demo', task_ids: [taskA.id], source_ref: 'feat/x', target_ref: 'main' });
  ok('重复提交被拒', dup.ok === false && dup.reason === 'duplicate', dup);

  console.log('\n[3] 批准只允许 Human（accept / merge 权限都不算）');
  const mrId = created.merge_request.id;
  ok('持 merge 权限的 Lead 也不能批准', S.approveMergeRequest(db, 'lead/main', mrId, 0).reason === 'human_only');
  ok('持 accept 权限的 agent 更不能批准', S.approveMergeRequest(db, 'lead/main', mrId, 0).reason === 'human_only');
  ok('陈旧 version 的批准被拒', S.approveMergeRequest(db, 'human', mrId, 9).reason === 'version_mismatch');
  const approved = S.approveMergeRequest(db, 'human', mrId, 0);
  ok('human 批准成功且 version 推进', approved.ok === true && approved.merge_request.status === 'approved' && approved.merge_request.approved_by === 'human' && approved.merge_request.version === 1, approved.merge_request);
  ok('二次批准被拒（状态已变）', S.approveMergeRequest(db, 'human', mrId, 1).reason === 'not_proposed');

  console.log('\n[4] 状态机与 CAS');
  ok('未批准的请求不能开始合并', (function () {
    const t2 = doneTask();
    const mr2 = S.createMergeRequest(db, POL, 'lead/main', { project: 'demo', task_ids: [t2.id], source_ref: 'b2' }).merge_request;
    return S.startMerge(db, mr2.id, mr2.version).reason === 'not_approved';
  })());
  const started = S.startMerge(db, mrId, 1);
  ok('approved → merging', started.ok === true && started.merge_request.status === 'merging' && started.merge_request.version === 2, started.merge_request);
  ok('并发开始合并只有一路成功', S.startMerge(db, mrId, 1).ok === false);
  ok('非法终态被拒', S.finishMerge(db, mrId, { status: 'bogus' }, 2).reason === 'invalid_status');
  ok('merged 必须带合法 commit', S.finishMerge(db, mrId, { status: 'merged' }, 2).reason === 'invalid_commit');
  ok('陈旧 version 收尾被拒', S.finishMerge(db, mrId, { status: 'merged', commit: 'abcdef1' }, 1).reason === 'version_mismatch');

  console.log('\n[5] 临时 Git 仓库：干净/脏工作树与 abort');
  git(['init', '-q', '-b', 'main']);
  fs.writeFileSync(path.join(repo, 'a.txt'), 'base\n');
  commitAll('base');
  git(['checkout', '-q', '-b', 'feat/x']);
  fs.writeFileSync(path.join(repo, 'a.txt'), 'base\nfeat\n');
  commitAll('feat');
  git(['checkout', '-q', 'main']);
  ok('干净工作树可合并', dirtyTree() === false);
  const merged = git(['merge', '--no-ff', '-q', '-m', 'merge feat', 'feat/x']);
  const mergeCommit = git(['rev-parse', 'HEAD']).out;
  ok('git merge --no-ff 成功并产生 merge commit', merged.status === 0 && /^[0-9a-f]{7,64}$/.test(mergeCommit), { merged: merged.status, err: merged.err });
  const finished = S.finishMerge(db, mrId, { status: 'merged', commit: mergeCommit, note: 'squash-free merge' }, 2);
  ok('finishMerge 记录 commit 并落 merged', finished.ok === true && finished.merge_request.status === 'merged' && finished.merge_request.merge_commit === mergeCommit, finished.merge_request);
  ok('已结束的合并请求不能再收尾', S.finishMerge(db, mrId, { status: 'failed' }, 3).ok === false);

  // 冲突 → merge --abort 恢复，绝不用 reset --hard
  git(['checkout', '-q', '-b', 'clash']);
  fs.writeFileSync(path.join(repo, 'a.txt'), 'clash\n');
  commitAll('clash');
  git(['checkout', '-q', 'main']);
  fs.writeFileSync(path.join(repo, 'a.txt'), 'main-side\n');
  commitAll('main side');
  const headBefore = git(['rev-parse', 'HEAD']).out;
  const conflict = git(['merge', '--no-ff', '-m', 'conflict', 'clash']);
  ok('冲突合并返回非 0', conflict.status !== 0);
  const aborted = git(['merge', '--abort']);
  ok('git merge --abort 成功且 HEAD 未变（没有 reset --hard）', aborted.status === 0 && git(['rev-parse', 'HEAD']).out === headBefore);
  ok('abort 后工作树恢复干净', dirtyTree() === false);

  fs.writeFileSync(path.join(repo, 'a.txt'), 'dirty\n');
  ok('脏工作树能被检出', dirtyTree() === true);
  commitAll('cleanup');
  ok('提交后又变干净', dirtyTree() === false);

  console.log('\n[6] 没有远端：流程不含 push');
  ok('仓库没有任何 remote', git(['remote']).out === '');

  console.log('\n[7] 队列与项目级 Lead');
  const list = S.listMergeRequests(db, { project: 'demo' });
  ok('listMergeRequests 可过滤项目', list.length >= 1 && list.every(function (mr) { return mr.project === 'demo'; }));
  ok('open 过滤只看未结束请求', S.listMergeRequests(db, { open: true }).every(function (mr) { return ['proposed', 'approved', 'merging'].indexOf(mr.status) >= 0; }));
  const A = await import('./admin-config.mjs');
  let leadRejected = false;
  try { A.createProject({ id: 'nolead', path: repo, lead: 'codex/main' }); } catch (error) { leadRejected = error.statusCode === 400 && /lead/.test(error.message); }
  ok('createProject 拒绝 project.lead', leadRejected);
  const registry = A.readProjectsRegistry({ path: registryFile });
  ok('旧配置里的 project.lead 只产生 warning', Array.isArray(registry.warnings) && registry.warnings.some(function (w) { return w.indexOf('legacy') >= 0; }), registry.warnings);
} finally {
  db.close();
  delete process.env.BUS_PROJECTS;
  fs.rmSync(tmp, { recursive: true, force: true });
}

console.log('\n==================================');
console.log('PASS ' + pass + '   FAIL ' + fail);
process.exitCode = fail ? 1 : 0;
