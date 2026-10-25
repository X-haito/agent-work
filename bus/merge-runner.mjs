// 合并 runner：本机唯一的 merge 执行者。
// 红线写在代码里，不靠调用方自觉：
//   · 只用 execFile + 参数数组（shell:false），绝不用 shell 字符串；
//   · git 子命令走白名单，push / reset / rebase / revert / pull / checkout 直接抛错；
//   · --hard / --force / -f / --rebase 这类参数同样直接抛错；
//   · 失败只做 git merge --abort（先确认 MERGE_HEAD 存在），绝不 reset --hard。
// 前置校验全部 fail-closed：项目必须登记、仓库必须是工作树、工作树必须干净、
// 两端必须是本地 ref、当前分支必须就是 target（不偷偷切分支）、关联任务必须全 done、
// 项目验证器必须成功。任何一条不过就不碰 git merge。
import { execFile, spawn as cpSpawn } from 'node:child_process';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import * as S from './store.mjs';
import * as A from './admin-config.mjs';

export const MERGE_ALLOWED_SUBCOMMANDS = ['rev-parse', 'status', 'merge', 'symbolic-ref', 'log', 'diff'];
const FORBIDDEN_FLAGS = ['--hard', '--force', '-f', '--force-with-lease', '--rebase', '--no-verify', '--mirror'];

// 唯一允许的 git 入口：子命令白名单 + 危险参数黑名单。写在这里而不是散在调用点。
export function guardGitArgs(args) {
  const list = (args || []).map(String);
  const sub = list[0] || '';
  if (MERGE_ALLOWED_SUBCOMMANDS.indexOf(sub) < 0) throw new Error('merge_forbidden_subcommand: ' + (sub || '(empty)'));
  for (const item of list) {
    if (FORBIDDEN_FLAGS.indexOf(item) >= 0) throw new Error('merge_forbidden_flag: ' + item);
  }
  return list;
}

// 受限环境（沙箱禁止管道 stdio）里 execFile 会拿到 spawn EPERM。
// 这时改用「输出重定向到临时文件」的方式跑同一条命令：不经管道、不会死锁，结果同样可得。
// 生产路径仍然先走普通 execFile —— 这不是替换，只是失败后的等价退路。
export function fdExec(cmd, args, options) {
  return new Promise(function (resolve) {
    let safe = null;
    try { safe = guardGitArgs(args); } catch (error) { resolve({ code: 1, stdout: '', stderr: String(error.message || error), error: String(error.message || error) }); return; }
    let scratch = null, fdOut = null, fdErr = null;
    try {
      scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'merge-exec-'));
      const outFile = path.join(scratch, 'out.txt');
      const errFile = path.join(scratch, 'err.txt');
      fdOut = fs.openSync(outFile, 'w');
      fdErr = fs.openSync(errFile, 'w');
      const child = cpSpawn(cmd, safe, { cwd: options && options.cwd, stdio: ['ignore', fdOut, fdErr], windowsHide: true, shell: false });
      child.on('error', function (error) {
        try { fs.closeSync(fdOut); fs.closeSync(fdErr); } catch (e) {}
        resolve({ code: 1, stdout: '', stderr: '', error: String((error && error.message) || error) });
      });
      child.on('close', function (code) {
        try { fs.closeSync(fdOut); } catch (e) {}
        try { fs.closeSync(fdErr); } catch (e) {}
        let stdout = '', stderr = '';
        try { stdout = fs.readFileSync(outFile, 'utf8'); } catch (e) {}
        try { stderr = fs.readFileSync(errFile, 'utf8'); } catch (e) {}
        try { fs.rmSync(scratch, { recursive: true, force: true }); } catch (e) {}
        resolve({ code: typeof code === 'number' ? code : 1, stdout: stdout, stderr: stderr, error: null });
      });
    } catch (error) {
      resolve({ code: 1, stdout: '', stderr: String((error && error.message) || error), error: String((error && error.message) || error) });
    }
  });
}

// 默认执行器：先试普通 execFile；只有遇到 EPERM（受限沙箱）才退回 fd 重定向。
export async function autoExec(cmd, args, options) {
  const first = await defaultExec(cmd, args, options);
  if (first && first.error && /EPERM/.test(String(first.error))) return fdExec(cmd, args, options);
  return first;
}

export function defaultExec(cmd, args, options) {
  return new Promise(function (resolve) {
    const safe = guardGitArgs(args);
    try {
      execFile(cmd, safe, {
        cwd: options && options.cwd, shell: false, windowsHide: true, maxBuffer: 4 * 1024 * 1024, timeout: 120000,
      }, function (error, stdout, stderr) {
        const code = error ? (typeof error.code === 'number' ? error.code : 1) : 0;
        resolve({ code: code, stdout: String(stdout || ''), stderr: String(stderr || ''), error: error ? String(error.message || error) : null });
      });
    } catch (error) {
      // 受限沙箱里 execFile 会**同步**抛 spawn EPERM：转成普通结果，交给 autoExec 退到 fdExec。
      resolve({ code: 1, stdout: '', stderr: String((error && error.message) || error), error: String((error && error.message) || error) });
    }
  });
}

function registryOf(options) {
  try {
    if (typeof A.readProjectsRegistry === 'function') return A.readProjectsRegistry(options).projects || {};
    const file = path.join(S.BUS_DIR, 'projects.json');
    return JSON.parse(fs.readFileSync(file, 'utf8')).projects || {};
  } catch (e) { return {}; }
}

// runMerge({ db, project, sourceRef, targetRef, taskIds, projectOptions, getTask, exec, message })
//   **验证结论只能从库里读**：对每个关联任务调用 store.latestFrozenVerification()（最新一次运行必须
//   成功且 verify_spec_hash 与任务当前 frozen hash 一致）。调用方传任何 verification 对象都不采信，
//   只记一条 ignored_verification 检查项 —— 否则等于允许调用方自己声明"验证过了"。
//   exec: 仅测试注入；生产走 defaultExec（execFile + 参数数组 + shell:false）。
// 二次确认用：只读探测仓库状态（分支、HEAD、工作树是否干净、是否正处在 merge 中）。
// 不做任何写操作，也不切分支。
export async function repoState(opts) {
  const o = opts || {};
  const project = String(o.project || '');
  const entry = registryOf(o.projectOptions)[project];
  const repoRoot = typeof entry === 'string' ? entry : (entry && entry.path) || null;
  if (!repoRoot) return { ok: false, reason: 'project_not_registered', project: project, root: null };
  const cwd = path.resolve(repoRoot);
  const exec = typeof o.exec === 'function' ? o.exec : autoExec;
  async function git() {
    const args = guardGitArgs(Array.prototype.slice.call(arguments));
    try { return await exec('git', args, { cwd: cwd }); }
    catch (error) { return { code: -1, stdout: '', stderr: String((error && error.message) || error) }; }
  }
  const inside = await git('rev-parse', '--is-inside-work-tree');
  const branch = await git('symbolic-ref', '--short', 'HEAD');
  const head = await git('rev-parse', 'HEAD');
  const status = await git('status', '--porcelain');
  const mergeHead = await git('rev-parse', '-q', '--verify', 'MERGE_HEAD');
  return {
    ok: inside.code === 0 && /\btrue\b/.test(inside.stdout),
    project: project,
    root: cwd,
    branch: branch.code === 0 ? branch.stdout.trim() : null,
    head: head.code === 0 ? head.stdout.trim() : null,
    worktree: status.code === 0 ? (status.stdout.trim() === '' ? 'clean' : 'dirty') : 'unknown',
    worktree_detail: status.code === 0 ? status.stdout.trim().split('\n').slice(0, 20).join(' | ') : null,
    in_merge: mergeHead.code === 0,
  };
}

export async function runMerge(input) {
  const opts = input || {};
  const exec = typeof opts.exec === 'function' ? opts.exec : autoExec;
  const checks = [];
  const finishedAt = () => (typeof opts.now === 'string' && opts.now ? opts.now : new Date().toISOString());
  function record(name, okFlag, detail) {
    checks.push({ name: name, ok: okFlag === true, detail: detail == null ? null : String(detail).replace(/\s+/g, ' ').trim().slice(0, 400) });
    return okFlag === true;
  }
  function stop(reason, detail) {
    return { ok: false, status: 'blocked', merged: false, aborted: false, commit: null, blocked_reason: reason,
      detail: detail == null ? null : String(detail).slice(0, 800), checks: checks, finished_at: finishedAt() };
  }

  const project = String(opts.project == null ? '' : opts.project);
  const sourceRef = String(opts.sourceRef == null ? '' : opts.sourceRef);
  const targetRef = String(opts.targetRef == null ? '' : opts.targetRef);
  const taskIds = Array.isArray(opts.taskIds) ? opts.taskIds.map(String).filter(Boolean) : [];

  // 1) 项目必须在 registry 登记：绝不拿调用方随便给的目录当仓库。
  const entry = registryOf(opts.projectOptions)[project];
  const repoRoot = typeof entry === 'string' ? entry : (entry && entry.path) || null;
  if (!record('project_registered', !!repoRoot, project)) return stop('project_not_registered', project);
  if (!fs.existsSync(repoRoot)) { record('repo_exists', false, repoRoot); return stop('repo_missing', repoRoot); }
  record('repo_exists', true, repoRoot);

  const cwd = path.resolve(repoRoot);
  async function git() {
    const args = guardGitArgs(Array.prototype.slice.call(arguments));
    try { return await exec('git', args, { cwd: cwd }); }
    catch (error) { return { code: -1, stdout: '', stderr: String((error && error.message) || error) }; }
  }

  if (!taskIds.length) { record('tasks_provided', false, '没有任何关联任务'); return stop('tasks_required'); }

  const inside = await git('rev-parse', '--is-inside-work-tree');
  if (!record('git_worktree', inside.code === 0 && /\btrue\b/.test(inside.stdout), inside.stderr || inside.stdout)) return stop('not_a_git_worktree');
  const status = await git('status', '--porcelain');
  if (!record('clean_worktree', status.code === 0 && status.stdout.trim() === '', status.stdout.trim() || status.stderr)) return stop('dirty_worktree', status.stdout);
  const src = await git('rev-parse', '--verify', sourceRef + '^{commit}');
  if (!record('source_ref_local', src.code === 0, src.stderr)) return stop('source_ref_invalid', sourceRef);
  const tgt = await git('rev-parse', '--verify', targetRef + '^{commit}');
  if (!record('target_ref_local', tgt.code === 0, tgt.stderr)) return stop('target_ref_invalid', targetRef);
  // 当前分支必须就是 target：runner 不替人切分支、不移动 HEAD。
  const head = await git('symbolic-ref', '--short', 'HEAD');
  if (!record('head_is_target', head.code === 0 && head.stdout.trim() === targetRef, head.stdout.trim() || head.stderr)) return stop('head_not_target', head.stdout.trim());

  const getTask = typeof opts.getTask === 'function' ? opts.getTask : function (id) { return S.getTask(opts.db, id); };
  const notDone = [];
  for (const id of taskIds) {
    let task = null;
    try { task = getTask(id); } catch (error) { task = null; }
    if (!task || task.status !== 'done') notDone.push(id + ':' + ((task && task.status) || 'missing'));
  }
  if (!record('tasks_done', notDone.length === 0, notDone.join(','))) return stop('tasks_not_done', notDone.join(','));

  // 验证结论只认库里的事实。
  if (opts.verification !== undefined) record('ignored_caller_verification', true, '调用方传入的 verification 已被忽略，改为从库读取');
  const verifications = [];
  for (const id of taskIds) {
    let result = null;
    try { result = S.latestFrozenVerification(opts.db, id); }
    catch (error) { result = { ok: false, reason: 'verification_lookup_failed: ' + String((error && error.message) || error) }; }
    verifications.push({ task_id: id, ok: !!(result && result.ok), reason: (result && result.reason) || null,
      run_id: (result && result.run && result.run.run_id) || null,
      verify_spec_hash: (result && result.run && result.run.verify_spec_hash) || null });
  }
  const failedVerify = verifications.filter(function (v) { return v.ok !== true; });
  if (!record('verification_passed', failedVerify.length === 0,
    failedVerify.map(function (v) { return v.task_id + ':' + v.reason; }).join(',') || verifications.map(function (v) { return v.run_id; }).join(','))) {
    return Object.assign(stop('verification_failed', failedVerify.map(function (v) { return v.task_id + ':' + v.reason; }).join(',')), { verifications: verifications });
  }

  // 2) 真合并：--no-ff + 参数数组。
  const message = String(opts.message || ('merge ' + sourceRef + ' into ' + targetRef + ' (tasks ' + taskIds.join(',') + ')'));
  const merged = await git('merge', '--no-ff', sourceRef, '-m', message);
  if (merged.code !== 0) {
    const output = (merged.stderr || merged.stdout || merged.error || '').slice(0, 800);
    const inMerge = await git('rev-parse', '-q', '--verify', 'MERGE_HEAD');
    let aborted = false, abortOutput = '';
    if (inMerge.code === 0) {
      const abort = await git('merge', '--abort');
      aborted = abort.code === 0;
      abortOutput = (abort.stderr || abort.stdout || '').replace(/\s+/g, ' ').trim().slice(0, 400);
    }
    record('merge', false, output);
    return { ok: false, status: aborted ? 'aborted' : 'failed', merged: false, aborted: aborted, commit: null,
      blocked_reason: 'merge_failed', detail: output, abort_output: abortOutput, checks: checks, finished_at: finishedAt() };
  }
  const head2 = await git('rev-parse', 'HEAD');
  record('merge', true, (merged.stdout || '').trim());
  return { ok: true, status: 'merged', merged: true, aborted: false, commit: head2.code === 0 ? head2.stdout.trim() : null,
    blocked_reason: null, detail: (merged.stdout || '').replace(/\s+/g, ' ').trim().slice(0, 800), checks: checks, finished_at: finishedAt() };
}
