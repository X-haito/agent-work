// 合并 worker（第 11 项第 9/13 条）：唯一真正执行 git merge 的生产入口。
// 分工：approveMergeRequest 只把状态改成 approved（不动 Git）；本模块由 Human 显式触发才执行。
// 铁律：
//   · 验证结论只能来自库里（store.latestFrozenVerification），不接受任何调用方声明；
//   · startMerge 是原子 CAS（approved → merging），抢不到就直接返回，不碰 git；
//   · finishMerge 是单条 UPDATE（id + status=merging + version），失败不留下部分写入；
//   · 失败只做 git merge --abort（runner 内），绝不 reset --hard；
//   · 执行前重算二次确认快照，与批准时不一致 → 拒绝执行（needs_human 列到位后同时置标志）。
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { BUS_DIR } from './store.mjs';
import * as S from './store.mjs';
import { runMerge, repoState } from './merge-runner.mjs';

function sha256(text) { return crypto.createHash('sha256').update(text).digest('hex'); }

function logsDirOf(options) {
  return path.resolve((options && options.logsDir) || path.join(BUS_DIR, 'logs'));
}

export function mergeLogPath(requestId, when) {
  const stamp = String(when || new Date().toISOString()).replace(/[:.]/g, '-');
  return 'merge-' + String(requestId).replace(/[^A-Za-z0-9_-]/g, '_') + '-' + stamp + '.log';
}

function writeMergeLog(dir, requestId, result) {
  try {
    fs.mkdirSync(dir, { recursive: true });
    const name = mergeLogPath(requestId, new Date().toISOString());
    const body = JSON.stringify(result, null, 2) + '\n';
    fs.writeFileSync(path.join(dir, name), body, { mode: 0o600 });
    return { relative_path: name, sha256: sha256(body), bytes: Buffer.byteLength(body) };
  } catch (error) {
    return { relative_path: null, sha256: null, bytes: 0, error: String((error && error.message) || error) };
  }
}

// 执行一次合并请求。options:
//   exec / projectOptions / logsDir / expectPreflight / actor / now
export async function runMergeRequest(db, policy, requestId, options) {
  const o = options || {};
  const mr = S.getMergeRequest(db, requestId);
  if (!mr) return { ok: false, status: 'missing', reason: 'not_found', message: '没有这个合并请求: ' + requestId };
  if (mr.status === 'merged') return { ok: true, status: 'merged', already: true, merge_request: mr, reason: 'already_merged' };
  if (mr.status === 'merging') {
    // 崩溃遗留：把租约状态一并回给调用方，由 Human 决定重试（resetMergeForRetry）还是标 failed。
    const state = S.mergeExecutionState(db, requestId, {});
    return { ok: false, status: 'merging',
      reason: state.lease_expired === true ? 'lease_expired' : 'already_merging',
      message: state.lease_expired === true
        ? '这次合并的租约已过期（worker ' + (state.worker_id || '?') + ' 起始于 ' + (state.started_at || '?') + '），请由 Human 决定重试或标记失败'
        : '这个请求正在合并中，请由 Human 决定重试或标记失败',
      execution: state };
  }
  if (mr.status !== 'approved') {
    return { ok: false, status: mr.status, reason: 'not_approved', message: '只有已批准（approved）的请求才能执行，当前 ' + mr.status };
  }
  // needs_human 标志（新列到位后生效）：worker 看到就必须硬拒，自己绝不清理它。
  let needsHuman = 0, needsHumanReason = null;
  try {
    const row = db.prepare('SELECT needs_human, needs_human_reason FROM merge_requests WHERE id=?').get(requestId);
    needsHuman = Number(row && row.needs_human) || 0;
    needsHumanReason = (row && row.needs_human_reason) || null;
  } catch (error) { needsHuman = 0; }
  if (needsHuman === 1) {
    return { ok: false, status: 'approved', reason: 'needs_human', message: '这个请求被标记为需要人工重新确认' + (needsHumanReason ? '：' + needsHumanReason : '') };
  }

  // 1) 二次确认快照：执行前重算，和批准时冻结的 hash 比对
  const repo = await repoState({ project: mr.project, projectOptions: o.projectOptions, exec: o.exec });
  const preflight = S.mergePreflight(db, policy, requestId, { repo: repo });
  if (!preflight.ok) return { ok: false, status: mr.status, reason: preflight.reason, message: preflight.message };
  if (preflight.verification_ok !== true) {
    return { ok: false, status: mr.status, reason: 'verification_failed', message: '存在没有可通过固化验证的任务',
      tasks: preflight.preflight.tasks };
  }
  if (repo.worktree === 'dirty') {
    return { ok: false, status: mr.status, reason: 'dirty_worktree', message: '工作树不干净: ' + String(repo.worktree_detail || '').slice(0, 300) };
  }
  // 仓库里已经有一次未完成的 merge（MERGE_HEAD 存在）：绝不叠加第二次，也绝不 reset --hard。
  if (repo.in_merge === true) {
    return { ok: false, status: mr.status, reason: 'merge_in_progress',
      message: '仓库仍处于 merge 冲突状态，请先由人确认并执行 git merge --abort 后再重试' };
  }
  // 批准时冻结的 preflight（approved_preflight）或调用方显式给的 hash：执行时重算必须一致。
  const pinned = o.expectPreflight || mr.approved_preflight || null;
  if (pinned && String(pinned) !== String(preflight.preflight_hash)) {
    // worker 只负责置位 needs_human；清除只能由 Human 重新确认（confirmMergeRequest）。
    const flagged = S.setMergeNeedsHuman(db, 'merge-worker', requestId,
      'preflight_changed: ' + String(pinned).slice(0, 12) + ' → ' + String(preflight.preflight_hash).slice(0, 12));
    return { ok: false, status: mr.status, reason: 'preflight_changed',
      message: '二次确认内容在批准后发生变化，已置 needs_human=1，需 Human 重新确认',
      flagged: flagged.ok === true, preflight: preflight.preflight, expect: pinned, actual: preflight.preflight_hash };
  }

  // 2) 原子开始：approved → merging（CAS）。抢不到就结束，不碰 git。
  const started = S.startMerge(db, requestId, mr.version, { workerId: o.workerId || 'merge-worker', leaseMin: o.leaseMin || 30 });
  if (!started.ok) return { ok: false, status: mr.status, reason: started.reason, message: started.message };

  // 3) 真合并：runner 自己从库里读验证结论（这里不传 verification）
  let result = null;
  try {
    result = await runMerge({
      db: db, project: mr.project, sourceRef: mr.source_ref, targetRef: mr.target_ref,
      taskIds: mr.task_ids, projectOptions: o.projectOptions, exec: o.exec, now: o.now,
      message: 'merge ' + mr.source_ref + ' into ' + mr.target_ref + ' (' + requestId + ', tasks ' + mr.task_ids.join(',') + ')',
    });
  } catch (error) {
    result = { ok: false, status: 'failed', merged: false, blocked_reason: 'runner_threw',
      detail: String((error && error.message) || error) };
  }
  const log = writeMergeLog(logsDirOf(o), requestId, result);

  // 4) 原子收尾：一条 UPDATE 同时写 status / verify_run_id / merge_commit / version
  const verifyIds = (preflight.preflight.tasks || []).map(function (t) { return t.verify_run_id; }).filter(Boolean);
  const finished = S.finishMerge(db, requestId, {
    status: result.ok === true ? 'merged' : 'failed',
    verify_run_id: verifyIds.length ? verifyIds.join(',') : null,
    commit: result.ok === true ? result.commit : null,
    error: result.ok === true ? null : ((result.blocked_reason || result.reason || 'failed') + (result.detail ? ': ' + String(result.detail).slice(0, 300) : '')),
    log_path: log.relative_path,
    log_sha256: log.sha256,
    note: result.ok === true ? null : (result.blocked_reason || result.reason || 'failed'),
  }, started.merge_request.version);
  return {
    ok: result.ok === true && finished.ok === true,
    status: finished.ok ? finished.merge_request.status : 'finish_failed',
    reason: result.ok === true ? null : (result.blocked_reason || result.reason || 'merge_failed'),
    runner: result, log: log, preflight_hash: preflight.preflight_hash,
    finish: finished.ok ? { version: finished.merge_request.version } : { reason: finished.reason, message: finished.message },
    merge_request: finished.ok ? finished.merge_request : S.getMergeRequest(db, requestId),
  };
}
