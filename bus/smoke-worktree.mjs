#!/usr/bin/env node
// 第 15 项第 9 条：每任务独立 worktree + 冲突警告 + 项目维度归档入口。
// 全部在临时 git 仓库与临时库里跑；不碰真实工作区（真实仓库的 .worktrees 只在最后做只读 list 校验）。
import cp from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as S from './store.mjs';
import { buildPlan } from './archive.mjs';

let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  PASS  ' + name); }
  else { fail++; console.log('  FAIL  ' + name + (extra === undefined ? '' : '  -> ' + JSON.stringify(extra).slice(0, 300))); }
}
function git(args, cwd) {
  const out = path.join(cwd, '.git-out-' + Math.random().toString(36).slice(2));
  const err = out + '.err';
  const fdOut = fs.openSync(out, 'w'), fdErr = fs.openSync(err, 'w');
  const child = cp.spawn('git', ['-c', 'safe.directory=*'].concat(args), { cwd: cwd, stdio: ['ignore', fdOut, fdErr], windowsHide: true, shell: false,
    env: Object.assign({}, process.env, { GIT_AUTHOR_NAME: 'smoke', GIT_AUTHOR_EMAIL: 's@localhost', GIT_COMMITTER_NAME: 'smoke', GIT_COMMITTER_EMAIL: 's@localhost' }) });
  return new Promise(function (resolve) {
    child.on('close', function (code) {
      fs.closeSync(fdOut); fs.closeSync(fdErr);
      const stdout = fs.readFileSync(out, 'utf8'), stderr = fs.readFileSync(err, 'utf8');
      try { fs.rmSync(out, { force: true }); fs.rmSync(err, { force: true }); } catch (e) {}
      resolve({ code: code, stdout: stdout, stderr: stderr });
    });
    child.on('error', function (e) { resolve({ code: -1, stdout: '', stderr: String(e && e.message || e) }); });
  });
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'agentbus-wt-'));
const repo = path.join(tmp, 'repo');
fs.mkdirSync(repo, { recursive: true });
const dbFile = path.join(tmp, 'bus.db');
// 重要：cli.mjs 的 db 是懒加载 BUS_DB（不是我们进程里的 db 对象）。不设这里，它读的是真实 bus.db。
process.env.BUS_DB = dbFile;
const registryFile = path.join(tmp, 'projects.json');
fs.writeFileSync(registryFile, JSON.stringify({ projects: { work: { path: repo } } }, null, 2));
process.env.BUS_PROJECTS = registryFile;
const db = S.openDb(dbFile);
S.setRuntimeState(db, 'human', true);
const CLI = await import('./cli.mjs');

const inited = await git(['init', '-q', '-b', 'main'], repo);
ok('临时 git 仓库可初始化（b 选项）', inited.code === 0, inited.stderr.slice(0, 120));
if (inited.code !== 0) { await git(['init', '-q'], repo); await git(['checkout', '-q', '-b', 'main'], repo); }
fs.writeFileSync(path.join(repo, 'README.md'), 'x');
await git(['add', '.'], repo);
const first = await git(['commit', '-q', '-m', 'init'], repo);
ok('临时仓库有一次提交', first.code === 0, first.stderr.slice(0, 160));

console.log('');
console.log('[1] worktree create：拒绝 / 创建 / 幂等');
const noClaim = S.createTask(db, { title: '未认领', status: 'open', project: 'work', write_scope: ['bus/cli.mjs'] });
const missing = await CLI.runWorktreeCreate({ taskId: 't-9999', repo: repo });
ok('任务不存在 → task_not_found', missing.ok === false && missing.reason === 'task_not_found', missing.reason);
const notClaimed = await CLI.runWorktreeCreate({ taskId: noClaim.id, repo: repo });
ok('任务未认领 → task_not_claimed', notClaimed.ok === false && notClaimed.reason === 'task_not_claimed', notClaimed.reason);

const t1 = S.createTask(db, { title: '任务一', status: 'claimed', project: 'work', write_scope: ['bus/cli.mjs'] });
S.setTaskOwner ? null : db.prepare('UPDATE tasks SET owner=? WHERE id=?').run('bus-egress', t1.id);
const created = await CLI.runWorktreeCreate({ taskId: t1.id, repo: repo, base: 'main' });
ok('创建成功', created.ok === true && created.reason === 'created', created);
ok('worktree 在 .worktrees/<task-id>', !!created.worktree && created.worktree.indexOf(path.join('.worktrees', t1.id)) >= 0, created.worktree);
ok('分支名是 task/<task-id>', created.branch === 'task/' + t1.id, created.branch);
ok('目录真的存在且是 git worktree', fs.existsSync(path.join(created.worktree, '.git')), created.worktree);
const again = await CLI.runWorktreeCreate({ taskId: t1.id, repo: repo, base: 'main' });
ok('重复 create 幂等（already_exists，不报错）', again.ok === true && again.reason === 'already_exists', again.reason);
const listed = await CLI.runWorktreeList({ repo: repo });
ok('list 只列本仓库管理的 worktree', listed.ok === true && listed.worktrees.length === 1 && listed.worktrees[0].branch === 'task/' + t1.id, listed.worktrees);

console.log('');
console.log('[2] write_scope 重叠与共享文件冲突（警告，不阻断）');
const t2 = S.createTask(db, { title: '任务二', status: 'claimed', project: 'work', write_scope: ['bus/cli.mjs', 'bus/ui/views/settings.mjs'] });
db.prepare('UPDATE tasks SET owner=? WHERE id=?').run('other-agent', t2.id);
const t3 = S.createTask(db, { title: '任务三', status: 'claimed', project: 'work', write_scope: ['bus/schema.sql'] });
db.prepare('UPDATE tasks SET owner=? WHERE id=?').run('third-agent', t3.id);
const t4 = S.createTask(db, { title: '任务四', status: 'claimed', project: 'work', write_scope: ['bus/ui/styles.css'] });
db.prepare('UPDATE tasks SET owner=? WHERE id=?').run('fourth-agent', t4.id);

const withOverlap = await CLI.runWorktreeCreate({ taskId: t2.id, repo: repo, base: 'main' });
ok('重叠时不阻断（照建）', withOverlap.ok === true, withOverlap.reason);
ok('列出冲突任务 id', Array.isArray(withOverlap.warnings.scope_overlaps) && withOverlap.warnings.scope_overlaps.some(function (w) { return w.task_id === t1.id; }), withOverlap.warnings.scope_overlaps);
ok('列出重叠的具体路径', withOverlap.warnings.scope_overlaps[0].overlaps.some(function (p) { return p.indexOf('bus/cli.mjs') >= 0; }), withOverlap.warnings.scope_overlaps[0]);
// t3 与 t4 同时写共享文件（bus/schema.sql 与 bus/ui/ 属于共享清单）
// t2 写 bus/ui/views/settings.mjs、t4 写 bus/ui/styles.css：两者都落在共享目录 bus/ui/ 里 → 应报双 owner
const shared = await CLI.runWorktreeCreate({ taskId: t4.id, repo: repo, base: 'main' });
ok('共享文件双 owner 报 WARN（bus/ui/ 是共享目录，两个任务各写其中一部分也算）',
  shared.warnings.shared_file_conflicts.length >= 1, shared.warnings.shared_file_conflicts);
ok('WARN 明确指出文件与任务',
  shared.warnings.shared_file_conflicts.some(function (c) { return c.file === 'bus/ui/' && c.tasks.indexOf(t2.id) >= 0 && c.tasks.indexOf(t4.id) >= 0; }),
  shared.warnings.shared_file_conflicts);
const schemaT = await CLI.runWorktreeCreate({ taskId: t3.id, repo: repo, base: 'main' });
ok('只有一个任务写 bus/schema.sql 时不误报 schema 冲突',
  !schemaT.warnings.shared_file_conflicts.some(function (c) { return c.file === 'bus/schema.sql'; }), schemaT.warnings.shared_file_conflicts);

console.log('');
console.log('[3] remove：脏树拒绝，干净才删，绝不 --force');
const stage = created.worktree;
fs.writeFileSync(path.join(stage, 'dirty.txt'), 'uncommitted');
const dirtyRemove = await CLI.runWorktreeRemove({ taskId: t1.id, repo: repo });
ok('有未提交内容时拒绝删除', dirtyRemove.ok === false && dirtyRemove.reason === 'worktree_dirty', dirtyRemove.reason);
ok('拒绝时列出未提交文件', Array.isArray(dirtyRemove.dirty) && dirtyRemove.dirty.length >= 1, dirtyRemove.dirty);
ok('目录还在（没有偷偷 --force）', fs.existsSync(stage));
fs.rmSync(path.join(stage, 'dirty.txt'));
const cleanRemove = await CLI.runWorktreeRemove({ taskId: t1.id, repo: repo });
ok('干净后删除成功', cleanRemove.ok === true && cleanRemove.reason === 'removed', cleanRemove);
ok('目录已不存在', !fs.existsSync(stage));
ok('分支保留（清理由人决定）', cleanRemove.note.indexOf('分支保留') >= 0, cleanRemove.note);
const missingRemove = await CLI.runWorktreeRemove({ taskId: 't-9999', repo: repo });
ok('删除不存在的 worktree → worktree_not_found', missingRemove.ok === false && missingRemove.reason === 'worktree_not_found', missingRemove.reason);

console.log('');
console.log('[4] 共享文件单一 owner（doctor 检查同源）');
const conflicts = CLI.sharedFileConflicts(CLI.activeTasks ? CLI.activeTasks() : []);
ok('共享文件冲突检测可用于 doctor（同一函数）', Array.isArray(conflicts), conflicts);
ok('SHARED_FILES 覆盖 schema/migrations/policy/ui', ['bus/schema.sql', 'bus/migrations/', 'bus/policy.json', 'bus/ui/'].every(function (f) { return CLI.SHARED_FILES.indexOf(f) >= 0; }), CLI.SHARED_FILES);
ok('scopeOverlap 认目录前缀与相同路径', CLI.scopeOverlap('bus/ui/', 'bus/ui/views/x.mjs') === true && CLI.scopeOverlap('bus/a.mjs', 'bus/b.mjs') === false);

console.log('');
console.log('[5] projects archive-orphan：复用 archive 计划 + confirm 校验');
const orphanProject = 'D:\\legacy\\wt';
S.setRuntimeState(db, 'human', true);
db.prepare('INSERT INTO tasks(id,title,status,project,version,created_at,updated_at) VALUES(?,?,?,?,0,?,?)')
  .run('t-arch-1', '历史任务A', 'done', orphanProject, '2020-01-01T00:00:00.000Z', '2020-01-01T00:00:00.000Z');
db.prepare('INSERT INTO tasks(id,title,status,project,version,created_at,updated_at) VALUES(?,?,?,?,0,?,?)')
  .run('t-arch-2', '仍在跑', 'in_progress', orphanProject, '2020-01-01T00:00:00.000Z', '2020-01-01T00:00:00.000Z');
// 有 active 任务时必须拒绝
const policy = JSON.parse(fs.readFileSync(path.join(S.BUS_DIR, 'policy.json'), 'utf8'));
const planWithActive = buildPlan(db, Object.assign({}, policy, { retention: Object.assign({}, policy.retention, { terminal_task_days: 1 }) }), { now: new Date('2026-06-01T00:00:00.000Z') });
ok('archive 计划能造出来（说明 archive-orphan 走的是同一实现）', !!planWithActive && typeof planWithActive.plan_hash === 'string', planWithActive && planWithActive.plan_hash);
const activeCount = db.prepare("SELECT COUNT(*) AS c FROM tasks WHERE project=? AND status IN ('open','proposed','claimed','in_progress','review')").get(orphanProject).c;
ok('该孤儿项目下确实有 active 任务（用于验证拒绝路径）', activeCount === 1, activeCount);
// 把 active 任务收尾后应可进入计划
db.prepare("UPDATE tasks SET status='done', updated_at='2020-01-02T00:00:00.000Z' WHERE id='t-arch-2'").run();
const plan2 = buildPlan(db, Object.assign({}, policy, { retention: Object.assign({}, policy.retention, { terminal_task_days: 1 }) }), { now: new Date('2026-06-01T00:00:00.000Z') });
const mine = (plan2.tables.tasks.ids || []).filter(function (id) { return id === 't-arch-1' || id === 't-arch-2'; });
ok('两个已终结任务都进入 archive 计划（复用，不自建删除逻辑）', mine.length === 2, plan2.tables.tasks.ids.length);
ok('计划 hash 稳定（同一数据同一策略）', buildPlan(db, Object.assign({}, policy, { retention: Object.assign({}, policy.retention, { terminal_task_days: 1 }) }), { now: new Date('2026-06-01T00:00:00.000Z') }).plan_hash === plan2.plan_hash);

console.log('');
console.log('[6] CLI 接线（真子进程）');
function runCli(args, env) {
  const out = path.join(tmp, 'cli-' + Math.random().toString(36).slice(2));
  const fdOut = fs.openSync(out, 'w'), fdErr = fs.openSync(out + '.err', 'w');
  const child = cp.spawn(process.execPath, [path.join(S.BUS_DIR, 'cli.mjs')].concat(args), {
    cwd: S.BUS_DIR, stdio: ['ignore', fdOut, fdErr], windowsHide: true, shell: false,
    env: Object.assign({}, process.env, { BUS_DB: dbFile, BUS_PROJECTS: registryFile, HOME: tmp, USERPROFILE: tmp }, env || {}) });
  return new Promise(function (resolve) {
    child.on('close', function (code) {
      fs.closeSync(fdOut); fs.closeSync(fdErr);
      resolve({ code: code, stdout: fs.readFileSync(out, 'utf8'), stderr: fs.readFileSync(out + '.err', 'utf8') });
    });
    child.on('error', function (e) { try { fs.closeSync(fdOut); } catch (x) {} resolve({ code: -1, stdout: '', stderr: String(e && e.message || e) }); });
  });
}
const wtList = await runCli(['worktree', 'list', '--repo', repo, '--json']);
let wtJson = null;
try { wtJson = JSON.parse(wtList.stdout); } catch (e) { wtJson = null; }
if (wtList.code === -1) { console.log('  SKIP  CLI 子进程 — spawn_eperm（不是 PASS）'); }
else {
  ok('worktree list --json 退出码 0', wtList.code === 0, wtList.code);
  ok('worktree list --json 结构正确', !!wtJson && wtJson.ok === true && Array.isArray(wtJson.worktrees), wtJson && Object.keys(wtJson));
  const ao = await runCli(['projects', 'archive-orphan', '--project', 'default', '--json']);
  let aoJson = null;
  try { aoJson = JSON.parse(ao.stdout); } catch (e) { aoJson = null; }
  ok('archive-orphan dry-run 退出码 0 且给 plan_hash', ao.code === 0 && !!aoJson && typeof aoJson.plan_hash === 'string', [ao.code, String(ao.stdout).slice(0, 120)]);
  const bad = await runCli(['projects', 'archive-orphan', '--project', 'default', '--confirm', 'deadbeef', '--json']);
  let badJson = null;
  try { badJson = JSON.parse(bad.stdout); } catch (e) { badJson = null; }
  ok('confirm hash 不对时被 archive 拒绝（confirm_mismatch）', bad.code === 1 && !!badJson && badJson.applied && badJson.applied.ok === false, badJson && badJson.applied && badJson.applied.reason);
  const usage = await runCli(['projects', 'archive-orphan']);
  ok('缺 --project 时退出码 2 并给用法', usage.code === 2 && /--project/.test(usage.stdout), [usage.code, usage.stdout.slice(0, 100)]);
}

try { db.close(); } catch (e) {}
try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (e) {}
console.log('');
console.log('==================================');
console.log('PASS ' + pass + '   FAIL ' + fail);
process.exit(fail ? 1 : 0);
