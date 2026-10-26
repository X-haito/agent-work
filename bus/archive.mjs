
// 归档引擎（第 10 项）：不可变计划 → drain 写屏障 → 单例租约 → 快照校验 → 单事务执行。
//
// 铁律（第 10 项第 9/10/11 条）：
// 1. buildPlan 在一致性读事务里产出精确的 row id / task id / artifact path+hash / policy+schema hash；
//    applyArchive 只执行该计划，提交后绝不重新查询候选。任一 id、hash 或版本变化 → 整批中止并要求重新 dry-run。
// 2. 顺序：先按计划物化任务完整 payload（含即将被删除的 messages / guard / verification / review）→
//    临时文件 + fsync + atomic rename → 校验落盘 hash → 才在事务里写 task_archives、聚合 usage、删原始行。
// 3. 只有 BEGIN EXCLUSIVE 才是"暂停新写入"（BEGIN IMMEDIATE 只排队，不阻止并发写）。
// 4. 清理原始 token_usage 前必须先折叠进 token_usage_daily 并核对总和；查询层合并 daily + 未归档 raw。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import zlib from 'node:zlib';
import { DatabaseSync } from 'node:sqlite';
import { BUS_DIR, dayKeyOf, nowIso } from './store.mjs';
import { logAudit } from './auth.mjs';

const ACTIVE = "('open','proposed','claimed','in_progress','review')";
const TERMINAL = "('done','failed','declined','cancelled')";
const TERMINAL_LIST = ['done', 'failed', 'declined', 'cancelled'];
const LEASE_ID = 'archive';
const PLAN_VERSION = 2;
const DEFAULT_LEASE_TTL_MIN = 30;

function sha256(buffer) { return crypto.createHash('sha256').update(buffer).digest('hex'); }

function retentionOf(policy) {
  const r = (policy && policy.retention) || {};
  // 第 10 项第 13 条：max_log_bytes 的实际语义是"单个日志文件阈值"，正名为 max_single_log_bytes。
  // policy-schema 里改名由 Lead 串行安排，在此之前两个名字都读（新名优先）。
  const declared = r.max_single_log_bytes != null ? r.max_single_log_bytes : r.max_log_bytes;
  const maxSingle = Number(declared);
  return {
    terminal_task_days: Number(r.terminal_task_days) || 0,
    message_days: Number(r.message_days) || 0,
    guard_event_days: Number(r.guard_event_days) || 0,
    raw_usage_days: Number(r.raw_usage_days) || 0,
    log_days: Number(r.log_days) || 0,
    max_single_log_bytes: Number.isFinite(maxSingle) && maxSingle > 0 ? Math.floor(maxSingle) : 0,
    // 兼容旧字段名（读旧策略时仍能工作，计划里两个名字同值）
    max_log_bytes: Number.isFinite(maxSingle) && maxSingle > 0 ? Math.floor(maxSingle) : 0,
    // 第 48 项：孤儿行（不属于任何任务的过期消息/守卫事件）默认永不删除
    prune_unmanaged: pruneUnmanagedOf(policy) ? 1 : 0,
  };
}

// retention.archive_lease_ttl_min 尚未在 policy-schema 里声明（该文件归另一条轨道独占），
// 这里带防御性默认值读取；等 schema 声明落地后无需再改本文件。
function leaseTtlMinutes(policy) {
  const raw = policy && policy.retention ? policy.retention.archive_lease_ttl_min : undefined;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : DEFAULT_LEASE_TTL_MIN;
}

function cutoffOf(days, now) {
  return days > 0 ? new Date(now.getTime() - days * 86400000).toISOString() : null;
}

function pruneUnmanagedOf(policy) {
  const raw = policy && policy.retention ? policy.retention.prune_unmanaged : undefined;
  return Number(raw) === 1;
}

const ACTIVE_STATUSES = new Set(['open', 'proposed', 'claimed', 'in_progress', 'review']);

// 过期行分三类，只有"有归档凭据"的那一类才允许删：
//   managed   = 所属任务本轮会被归档，或该任务早已归档且这一行早于归档时刻（必然已进归档包）
//   deferred  = 所属任务已终结但还没归档（现在删就永久丢历史）→ 留着，等任务归档后再清
//   unmanaged = 不属于任何任务（thread/task_id 为空、或指向不存在的任务）→ 没有凭据可查，
//               默认永不删除，只有 retention.prune_unmanaged=1 时才删
function classifyExpiredRows(db, input) {
  const taskStatus = new Map();
  for (const row of db.prepare('SELECT id, status FROM tasks').all()) taskStatus.set(String(row.id), row.status);
  const archivedAt = new Map();
  for (const row of db.prepare('SELECT task_id, archived_at FROM task_archives').all()) archivedAt.set(String(row.task_id), String(row.archived_at));
  const pending = input.pendingTaskIds || new Set();

  function bucket(rows, ownerKey) {
    const out = { managed: [], deferred: [], unmanaged: [], skipped_active: [], out_of_scope: [] };
    for (const row of rows) {
      const owner = row[ownerKey] == null ? null : String(row[ownerKey]);
      const status = owner == null ? undefined : taskStatus.get(owner);
      // 项目计划只处理"属于该项目任务"的行：无 task_id 的历史用量/消息一律 out_of_scope（不删、不算孤儿）
      if (input.scopeTaskIds && (owner == null || !input.scopeTaskIds.has(owner))) { out.out_of_scope.push(row); continue; }
      if (status === undefined) { out.unmanaged.push(row); continue; }
      if (ACTIVE_STATUSES.has(status)) { out.skipped_active.push(row); continue; }
      if (pending.has(owner)) { out.managed.push(row); continue; }
      const stamp = archivedAt.get(owner);
      if (stamp && String(row.ts) < stamp) { out.managed.push(row); continue; }
      out.deferred.push(row);
    }
    return out;
  }

  const messageRows = input.msgCut ? db.prepare('SELECT seq, ts, thread FROM messages WHERE ts < ? ORDER BY seq').all(input.msgCut) : [];
  const guardRows = input.guardCut ? db.prepare('SELECT id, ts, task_id FROM guard_events WHERE ts < ? ORDER BY id').all(input.guardCut) : [];
  return { messages: bucket(messageRows, 'thread'), guard_events: bucket(guardRows, 'task_id') };
}

function idList(rows, key) { return rows.map(function (row) { return row[key]; }); }
function rangeList(rows) { return minMax(rows, function (row) { return row.ts; }); }

function logsDirOf(options) { return (options && options.logsDir) || path.join(BUS_DIR, 'logs'); }
function archiveDirOf(options) { return (options && options.archiveDir) || path.join(BUS_DIR, 'archives'); }

// 稳定序规范化：同一份策略无论字段顺序如何都得到同一个 hash
function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') {
    const out = {};
    for (const key of Object.keys(value).sort()) out[key] = canonical(value[key]);
    return out;
  }
  return value === undefined ? null : value;
}

function policyHash(policy) { return sha256(JSON.stringify(canonical(policy || {}))); }

function schemaHash() {
  try { return sha256(fs.readFileSync(new URL('./schema.sql', import.meta.url))); }
  catch (error) { return 'schema_unreadable'; }
}

// 一致性读快照：计划必须在一张快照上算出来，否则各表候选来自不同时刻。
// 调用方已开事务时退化为直接执行（不做嵌套 BEGIN）。
function inReadSnapshot(db, action) {
  let started = false;
  try { db.exec('BEGIN'); started = true; } catch (error) { started = false; }
  try {
    const out = action();
    if (started) db.exec('COMMIT');
    return out;
  } catch (error) {
    if (started) { try { db.exec('ROLLBACK'); } catch (inner) { /* ignore */ } }
    throw error;
  }
}

function minMax(rows, pick) {
  if (!rows.length) return { earliest: null, latest: null };
  let earliest = null; let latest = null;
  for (const row of rows) {
    const value = pick(row);
    if (value == null) continue;
    if (earliest === null || String(value) < String(earliest)) earliest = value;
    if (latest === null || String(value) > String(latest)) latest = value;
  }
  return { earliest: earliest, latest: latest };
}

// 只有"引用任务已归档 + 文件 hash 与 artifact_refs 一致 + 路径在 bus/logs 内"的日志才是候选
function logCandidates(db, retention, cutoff, options) {
  // 项目范围：只考虑属于该项目任务的 artifact 引用。
  const scopeTaskIds = options && options.scopeTaskIds ? options.scopeTaskIds : null;
  const dir = logsDirOf(options);
  const entries = [];
  const skipped = [];
  let refs = [];
  try {
    refs = db.prepare('SELECT r.task_id, r.kind, r.relative_path, r.sha256, r.size FROM artifact_refs r JOIN task_archives a ON a.task_id = r.task_id').all();
  } catch (error) { refs = []; }
  for (const ref of refs) {
    if (scopeTaskIds && !scopeTaskIds.has(String(ref.task_id))) continue;
    const rel = String(ref.relative_path || '');
    if (!rel || path.isAbsolute(rel) || rel.split(/[\\/]/).indexOf('..') >= 0) { skipped.push({ task_id: ref.task_id, relative_path: rel, reason: 'path_escape' }); continue; }
    const full = path.join(dir, rel);
    if (path.resolve(full) !== path.join(path.resolve(dir), rel.split(/[\\/]/).join(path.sep))) { skipped.push({ task_id: ref.task_id, relative_path: rel, reason: 'path_escape' }); continue; }
    let st = null;
    try { st = fs.lstatSync(full); } catch (error) { skipped.push({ task_id: ref.task_id, relative_path: rel, reason: 'missing' }); continue; }
    if (st.isSymbolicLink() || !st.isFile()) { skipped.push({ task_id: ref.task_id, relative_path: rel, reason: 'symlink_or_not_file' }); continue; }
    if (retention.log_days > 0 && cutoff && new Date(st.mtimeMs).toISOString() >= cutoff) continue;
    if (retention.log_days === 0 && !(retention.max_single_log_bytes > 0 && st.size > retention.max_single_log_bytes)) continue;
    const digest = sha256(fs.readFileSync(full));
    if (ref.sha256 && digest !== ref.sha256) { skipped.push({ task_id: ref.task_id, relative_path: rel, reason: 'hash_mismatch' }); continue; }
    entries.push({ task_id: ref.task_id, kind: ref.kind, relative_path: rel, sha256: digest, size: st.size });
  }
  return { entries: entries, skipped: skipped };
}

// 计划内容 hash：与 buildPlan 里参与 hash 的字段集合必须完全一致
// （plan_hash / generated_at / cutoffs 是 hash 之后才加的，不参与）
function planBodyHash(plan) {
  const clone = {};
  for (const key of Object.keys(plan)) {
    if (key === 'plan_hash' || key === 'generated_at' || key === 'cutoffs') continue;
    clone[key] = plan[key];
  }
  return sha256(JSON.stringify(clone));
}

export function buildPlan(db, policy, options) {
  const o = options || {};
  const now = o.now ? new Date(o.now) : new Date();
  const retention = retentionOf(policy);
  const timezone = (policy && policy.economics && policy.economics.budget_timezone) || 'UTC';

  const body = inReadSnapshot(db, function () {
    const tables = {};

    // 第 2 项：项目范围。计划一旦生成就定死在这个项目上，apply 阶段不得再扩展为全局候选。
    const scopeProject = o.project ? String(o.project) : null;
    const scopeTaskIds = scopeProject ? new Set(db.prepare('SELECT id FROM tasks WHERE project = ?').all(scopeProject).map(function (row) { return String(row.id); })) : null;
    // 已终结任务先算出来：消息/守卫事件的归类要知道"本轮会归档哪些任务"
    const taskCut = cutoffOf(retention.terminal_task_days, now);
    const taskSelect = 'SELECT id, status, version, updated_at FROM tasks WHERE ';
    const taskRows = taskCut
      ? (scopeProject
        ? db.prepare(taskSelect + 'project = ? AND status IN ' + TERMINAL + ' AND updated_at < ? AND id NOT IN (SELECT task_id FROM task_archives) ORDER BY id').all(scopeProject, taskCut)
        : db.prepare(taskSelect + 'status IN ' + TERMINAL + ' AND updated_at < ? AND id NOT IN (SELECT task_id FROM task_archives) ORDER BY id').all(taskCut))
      : [];
    const taskRange = minMax(taskRows, function (row) { return row.updated_at; });
    tables.tasks = {
      candidates: taskRows.length, earliest: taskRange.earliest, latest: taskRange.latest,
      ids: taskRows.map(function (row) { return row.id; }), entries: taskRows,
    };

    const msgCut = cutoffOf(retention.message_days, now);
    const guardCut = cutoffOf(retention.guard_event_days, now);
    const expired = classifyExpiredRows(db, {
      msgCut: msgCut,
      guardCut: guardCut,
      pendingTaskIds: new Set(tables.tasks.ids),
      scopeTaskIds: scopeTaskIds,
    });
    const msgRange = rangeList(expired.messages.managed);
    tables.messages = { candidates: expired.messages.managed.length, earliest: msgRange.earliest, latest: msgRange.latest, ids: idList(expired.messages.managed, 'seq'), rows: expired.messages.managed };
    const guardRange = rangeList(expired.guard_events.managed);
    tables.guard_events = { candidates: expired.guard_events.managed.length, earliest: guardRange.earliest, latest: guardRange.latest, ids: idList(expired.guard_events.managed, 'id'), rows: expired.guard_events.managed };
    // 孤儿行：没有归档凭据，默认不删（只有 prune_unmanaged=1 才进删除名单）
    tables.unmanaged_messages = { candidates: expired.messages.unmanaged.length, ids: idList(expired.messages.unmanaged, 'seq'), rows: expired.messages.unmanaged };
    tables.unmanaged_guard_events = { candidates: expired.guard_events.unmanaged.length, ids: idList(expired.guard_events.unmanaged, 'id'), rows: expired.guard_events.unmanaged };
    // 等任务归档：所属任务已终结但还没归档，现在删就等于丢历史
    tables.deferred_messages = { candidates: expired.messages.deferred.length, ids: idList(expired.messages.deferred, 'seq'), rows: expired.messages.deferred };
    tables.deferred_guard_events = { candidates: expired.guard_events.deferred.length, ids: idList(expired.guard_events.deferred, 'id'), rows: expired.guard_events.deferred };

    // 原始用量：计划里就带上 id + 折叠所需的全部字段（含 day_key），执行阶段不再查询
    const usageCut = cutoffOf(retention.raw_usage_days, now);
    // 项目范围：只处理**该项目任务**的用量。无 task_id 的历史用量不进项目归档——
    // 否则一次「项目归档」会把别的项目的过期用量一起折叠/删除（跨项目污染）。
    const usageScopeSql = scopeProject ? ' AND u.task_id IS NOT NULL AND u.task_id IN (SELECT id FROM tasks WHERE project = ?)' : '';
    const usageParams = scopeProject ? [usageCut, scopeProject] : [usageCut];
    const usageRows = usageCut
      ? db.prepare("SELECT u.id, u.agent, COALESCE(t.project,'') AS project, COALESCE(u.task_id,'') AS task_id, u.tokens_in, u.tokens_out, u.ts " +
        'FROM token_usage u LEFT JOIN tasks t ON t.id = u.task_id WHERE u.ts < ? AND (u.task_id IS NULL OR u.task_id NOT IN (SELECT id FROM tasks WHERE status IN ' + ACTIVE + '))' + usageScopeSql + ' ORDER BY u.id').all(...usageParams)
      : [];
    const groups = new Map();
    let usageTotal = 0;
    for (const row of usageRows) {
      const key = { day_key: dayKeyOf(row.ts, timezone), agent: row.agent, project: row.project, task_id: row.task_id };
      const id = JSON.stringify([key.day_key, key.agent, key.project, key.task_id]);
      const entry = groups.get(id) || { key: key, ids: [], tokens_in: 0, tokens_out: 0 };
      entry.ids.push(row.id);
      entry.tokens_in += Number(row.tokens_in) || 0;
      entry.tokens_out += Number(row.tokens_out) || 0;
      groups.set(id, entry);
      usageTotal += (Number(row.tokens_in) || 0) + (Number(row.tokens_out) || 0);
    }
    const usageRange = minMax(usageRows, function (row) { return row.ts; });
    tables.token_usage = {
      candidates: usageRows.length, earliest: usageRange.earliest, latest: usageRange.latest,
      ids: usageRows.map(function (row) { return row.id; }),
      total_tokens: usageTotal, groups: Array.from(groups.values()),
    };

    const logs = logCandidates(db, retention, cutoffOf(retention.log_days, now), Object.assign({}, o, { scopeTaskIds: scopeTaskIds }));
    tables.artifact_refs = {
      candidates: logs.entries.length, earliest: null, latest: null,
      entries: logs.entries, skipped: logs.skipped,
    };

    const skippedActive = Number(db.prepare('SELECT COUNT(*) AS c FROM tasks WHERE status IN ' + ACTIVE).get().c);
    const taskBytes = taskRows.reduce(function (n, row) {
      const bodyLength = db.prepare('SELECT COALESCE(LENGTH(body),0) AS b FROM tasks WHERE id = ?').get(row.id);
      return n + (Number(bodyLength && bodyLength.b) || 0);
    }, 0);
    const planBody = {
      schema: 2,
      plan_version: PLAN_VERSION,
      retention: retention,
      timezone: timezone,
      policy_hash: policyHash(policy),
      schema_hash: schemaHash(),
      tables: tables,
      referenced_logs: logs.entries.map(function (x) { return x.relative_path; }),
      skipped_active: skippedActive,
      est_bytes: taskBytes + logs.entries.reduce(function (n, x) { return n + (Number(x.size) || 0); }, 0),
      scope: scopeProject ? { type: 'project', project_id: scopeProject } : { type: 'global' },
      prune_unmanaged: retention.prune_unmanaged,
      // 孤儿行与"等任务归档"的行单列上报：这两类默认都不删
      unmanaged: {
        messages: tables.unmanaged_messages.candidates,
        guard_events: tables.unmanaged_guard_events.candidates,
        deferred_messages: tables.deferred_messages.candidates,
        deferred_guard_events: tables.deferred_guard_events.candidates,
      },
      counts: {
        messages: tables.messages.candidates, guard_events: tables.guard_events.candidates,
        token_usage: tables.token_usage.candidates, tasks: tables.tasks.candidates, logs: tables.artifact_refs.candidates,
        unmanaged_messages: tables.unmanaged_messages.candidates, unmanaged_guard_events: tables.unmanaged_guard_events.candidates,
      },
    };
    // plan_hash 不含时间戳：同一份数据 + 同一份策略 = 同一个 hash，dry-run 拿到的值可以直接 --confirm
    planBody.plan_hash = sha256(JSON.stringify(planBody));
    // 时间相关信息不进 plan_hash：同一份数据 + 同一份策略必须是同一个 hash
    planBody.generated_at = now.toISOString();
    planBody.cutoffs = { messages: msgCut, guard_events: guardCut, token_usage: usageCut, tasks: taskCut, logs: cutoffOf(retention.log_days, now) };
    return planBody;
  });

  return body;
}

// 第 4 项阶段 A：预算基线（只度量，不改配置、不回填）
// 归属率 = 有 task_id 的用量行 / 全部用量行；历史未归属单列 legacy_unattributed，绝不伪造回填。
export function budgetReadiness(db, policy) {
  const raw = db.prepare("SELECT COUNT(*) AS total, SUM(CASE WHEN task_id IS NULL OR task_id = '' THEN 1 ELSE 0 END) AS unattributed FROM token_usage").get();
  const daily = db.prepare("SELECT COUNT(*) AS total, SUM(CASE WHEN task_id IS NULL OR task_id = '' THEN 1 ELSE 0 END) AS unattributed FROM token_usage_daily").get();
  const total = Number(raw.total) || 0;
  const unattributed = Number(raw.unattributed) || 0;
  const tokenTotals = db.prepare("SELECT COALESCE(SUM(tokens_in + tokens_out),0) AS tokens, COALESCE(SUM(CASE WHEN task_id IS NULL OR task_id = '' THEN tokens_in + tokens_out ELSE 0 END),0) AS unattributed_tokens FROM token_usage").get();
  const tokens = Number(tokenTotals.tokens) || 0;
  const unattributedTokens = Number(tokenTotals.unattributed_tokens) || 0;
  const e = (policy && policy.economics) || {};
  return {
    switches: {
      daily_token_budget: e.daily_token_budget == null ? null : Number(e.daily_token_budget),
      default_turn_reserve: e.default_turn_reserve == null ? null : Number(e.default_turn_reserve),
      task_budget_tasks: Number(db.prepare('SELECT COUNT(*) AS c FROM tasks WHERE token_budget IS NOT NULL').get().c) || 0,
    },
    raw_usage: { rows: total, attributed: total - unattributed, unattributed: unattributed },
    daily_usage: { rows: Number(daily.total) || 0, unattributed: Number(daily.unattributed) || 0 },
    // 两种口径都给，并各自写清分母：单看 0.5 无法判断是 1/2 还是 5000/10000
    attribution_rate_tokens: tokens > 0 ? Number(((tokens - unattributedTokens) / tokens).toFixed(4)) : null,
    attribution_rate_rows: total > 0 ? Number(((total - unattributed) / total).toFixed(4)) : null,
    denominators: { tokens: tokens, rows: total },
    rate_basis: 'attribution_rate_tokens 是主口径（历史 75.2% 即按量加权）；attribution_rate_rows 是辅助口径',
    legacy_unattributed: {
      rows: unattributed,
      note: '历史未归属用量（task_id 为空）只单列，不回填 task_id，也不计入任何项目的预算基线',
    },
    verdict: total === 0
      ? '还没有任何用量记录：先把总线跑起来才有基线'
      : (unattributed > 0 ? '存在历史未归属用量：定额前要先决定这些行的归属口径（不回填）' : '全部用量都带 task_id：可以直接按任务定额'),
  };
}

// 第 4 项阶段 C：归档准备（快照 → integrity_check → dry-run）。只报告，不 apply、不改 retention。
export function archiveReadiness(db, policy, options) {
  const o = options || {};
  const now = o.now ? new Date(o.now) : new Date();
  const steps = [];
  // 一个承诺 applies_nothing 的命令**不得**往仓库里写东西：未指定目录时落临时目录。
  // （曾经默认写进真实 bus/archives/，演练时被实际踩到。）
  const readinessOptions = Object.assign({}, o);
  if (!readinessOptions.archiveDir) {
    readinessOptions.archiveDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentbus-readiness-'));
  }
  const snapshot = takeSnapshot(db, readinessOptions, now);
  steps.push({ step: 'snapshot', ok: snapshot.ok === true, detail: snapshot.ok ? { path: snapshot.path } : { reason: snapshot.reason, message: snapshot.message }, note: '只读快照，失败不阻塞' });
  const integrity = snapshot.ok ? verifySnapshotFile(snapshot.path) : { ok: false, detail: 'no_snapshot' };
  steps.push({ step: 'integrity_check', ok: integrity.ok === true, detail: integrity.detail || null });
  const plan = buildPlan(db, policy, readinessOptions);
  steps.push({ step: 'dry_run', ok: true, detail: { plan_hash: plan.plan_hash, counts: plan.counts, unmanaged: plan.unmanaged, scope: plan.scope } });
  return {
    steps: steps,
    snapshot_dir: readinessOptions.archiveDir,
    applies_nothing: true,
    retention_unchanged: JSON.stringify(retentionOf(policy)),
    plan_hash: plan.plan_hash,
    ready: steps.every(function (s) { return s.ok === true; }),
    next_step: '确认无误后再走 archive --confirm <plan_hash>（本项目要求 Human 亲手确认，never auto-apply）',
  };
}

// 看板用轻量汇总：只做过期行的归类计数（不扫日志、不哈希、不写库）
export function unmanagedSummary(db, policy, options) {
  const o = options || {};
  const now = o.now ? new Date(o.now) : new Date();
  const retention = retentionOf(policy);
  try {
    return inReadSnapshot(db, function () {
      const expired = classifyExpiredRows(db, {
        msgCut: cutoffOf(retention.message_days, now),
        guardCut: cutoffOf(retention.guard_event_days, now),
        pendingTaskIds: new Set(),
      });
      return {
        messages: expired.messages.unmanaged.length,
        guard_events: expired.guard_events.unmanaged.length,
        deferred_messages: expired.messages.deferred.length,
        deferred_guard_events: expired.guard_events.deferred.length,
        prune_unmanaged: retention.prune_unmanaged === 1,
      };
    });
  } catch (error) { return null; }
}

// ---------------------------------------------------------------- 租约

export function readArchiveLease(db) {
  try { return db.prepare('SELECT holder, acquired_at, expires_at, note, fence_token FROM archive_leases WHERE id = ?').get(LEASE_ID) || null; }
  catch (error) { return null; }
}

// 单例租约：id 固定为 'archive'，靠主键 + 未过期判定。
// 在 BEGIN EXCLUSIVE 屏障内调用时不会再嵌套事务（已在事务里就直接写）。
export function acquireArchiveLease(db, holder, policy, options) {
  const o = options || {};
  const now = o.now ? new Date(o.now) : new Date();
  const nowText = now.toISOString();
  const ttl = leaseTtlMinutes(policy);
  const expiresAt = new Date(now.getTime() + ttl * 60000).toISOString();
  let started = false;
  try { db.exec('BEGIN IMMEDIATE'); started = true; } catch (error) { started = false; }
  try {
    const row = readArchiveLease(db);
    if (row && String(row.holder) !== String(holder) && String(row.expires_at) > nowText) {
      if (started) db.exec('ROLLBACK');
      return { ok: false, reason: 'lease_busy', holder: row.holder, expires_at: row.expires_at };
    }
    // 每次获取/接管都换新 fence_token：旧 worker 恢复后 token 必然不匹配，无法提交。
    db.prepare('INSERT INTO archive_leases(id,holder,acquired_at,expires_at,note,fence_token) VALUES(?,?,?,?,?,1) ' +
      'ON CONFLICT(id) DO UPDATE SET holder = excluded.holder, acquired_at = excluded.acquired_at, expires_at = excluded.expires_at, note = excluded.note, ' +
      'fence_token = COALESCE(archive_leases.fence_token, 0) + 1')
      .run(LEASE_ID, holder, nowText, expiresAt, o.note == null ? null : String(o.note).slice(0, 200));
    const fresh = readArchiveLease(db);
    const fence = fresh ? Number(fresh.fence_token) || 0 : 0;
    if (started) db.exec('COMMIT');
    return { ok: true, holder: holder, acquired_at: nowText, expires_at: expiresAt, ttl_min: ttl, fence_token: fence };
  } catch (error) {
    if (started) { try { db.exec('ROLLBACK'); } catch (inner) { /* ignore */ } }
    return { ok: false, reason: 'lease_error', message: String((error && error.message) || error) };
  }
}

// 提交前复核：租约必须仍由本人持有、token 未变、且未过期。
// 这是「超时或失去租约的 worker 不能继续 apply」的唯一保证。
export function verifyArchiveLeaseFence(db, holder, fenceToken, options) {
  const o = options || {};
  const nowText = (o.now ? new Date(o.now) : new Date()).toISOString();
  const row = readArchiveLease(db);
  if (!row) return { ok: false, reason: 'lease_lost', detail: '租约已不存在（可能被释放或接管）' };
  if (String(row.holder) !== String(holder)) return { ok: false, reason: 'lease_lost', detail: '租约已被 ' + row.holder + ' 接管' };
  if (Number(row.fence_token) !== Number(fenceToken)) return { ok: false, reason: 'lease_lost', detail: 'fence_token 已变（' + row.fence_token + ' ≠ ' + fenceToken + '），旧 worker 不得提交' };
  if (String(row.expires_at) <= nowText) return { ok: false, reason: 'lease_expired', detail: '租约已过期: ' + row.expires_at };
  return { ok: true, fence_token: Number(row.fence_token) };
}

export function releaseArchiveLease(db, holder) {
  try {
    const changes = Number(db.prepare('DELETE FROM archive_leases WHERE id = ? AND holder = ?').run(LEASE_ID, holder).changes) || 0;
    return { ok: true, released: changes };
  } catch (error) {
    return { ok: false, reason: 'lease_error', message: String((error && error.message) || error) };
  }
}

// ---------------------------------------------------------------- drain / 写屏障

// drain = 拿到写锁并等当前写事务结束。BEGIN EXCLUSIVE 会等到现有写事务提交（busy_timeout 内），
// 之后任何连接的新写入都会被拒（WAL 下读不受影响）。BEGIN IMMEDIATE 不会阻止并发写，不能拿来当屏障。
const DRAIN_STATE = new WeakMap();

function readBusyTimeout(db) {
  try { return Number(Object.values(db.prepare('PRAGMA busy_timeout').get())[0]) || 0; }
  catch (error) { return 0; }
}

function restoreBusyTimeout(db) {
  if (!DRAIN_STATE.has(db)) return;
  const previous = DRAIN_STATE.get(db);
  DRAIN_STATE.delete(db);
  try { db.exec('PRAGMA busy_timeout = ' + previous); } catch (error) { /* ignore */ }
}

export function acquireDrain(db, options) {
  const o = options || {};
  const waitMs = Number.isSafeInteger(o.drainTimeoutMs) && o.drainTimeoutMs > 0 ? o.drainTimeoutMs : 15000;
  const startedAt = Date.now();
  DRAIN_STATE.set(db, readBusyTimeout(db));
  try { db.exec('PRAGMA busy_timeout = ' + waitMs); } catch (error) { /* ignore */ }
  try {
    // BEGIN EXCLUSIVE 会阻塞直到当前写事务结束：这就是 drain 的"等"
    db.exec('BEGIN EXCLUSIVE');
    return { ok: true, barrier: 'exclusive', waited_ms: Date.now() - startedAt };
  } catch (error) {
    restoreBusyTimeout(db);
    return { ok: false, reason: 'drain_failed', message: String((error && error.message) || error), waited_ms: Date.now() - startedAt };
  }
}

export function releaseDrain(db, commit) {
  let result = { ok: true };
  try { db.exec(commit ? 'COMMIT' : 'ROLLBACK'); }
  catch (error) { result = { ok: false, reason: 'release_failed', message: String((error && error.message) || error) }; }
  restoreBusyTimeout(db);
  return result;
}

// ---------------------------------------------------------------- 快照

function databasePathOf(db, options) {
  if (options && options.dbPath) return String(options.dbPath);
  try {
    const location = typeof db.location === 'function' ? db.location() : null;
    if (location && String(location).length) return String(location);
  } catch (error) { /* ignore */ }
  return null;
}

// 真实损坏的库必须被这里拦下来：抛错 / 返回错误行都不算 ok
export function verifySnapshotFile(snapshotPath) {
  let conn = null;
  try {
    conn = new DatabaseSync(String(snapshotPath));
    const row = conn.prepare('PRAGMA integrity_check').get();
    const detail = String(Object.values(row)[0] == null ? '' : Object.values(row)[0]);
    if (detail.toLowerCase() !== 'ok') return { ok: false, detail: detail };
    const tables = Number(conn.prepare("SELECT COUNT(*) AS c FROM sqlite_master WHERE type = 'table'").get().c) || 0;
    if (tables < 1) return { ok: false, detail: 'no_tables' };
    return { ok: true, detail: 'ok', tables: tables };
  } catch (error) {
    return { ok: false, detail: 'error:' + String((error && error.message) || error) };
  } finally {
    try { if (conn) conn.close(); } catch (error) { /* ignore */ }
  }
}

// 屏障内取快照：VACUUM INTO 用独立连接（同连接在事务里禁止 VACUUM），得到的是一致性副本。
function takeSnapshot(db, options, now) {
  const dir = archiveDirOf(options);
  const stamp = now.toISOString().replace(/[:.]/g, '-');
  const finalPath = (options && options.snapshotPath) ? String(options.snapshotPath) : path.join(dir, 'bus-' + stamp + '.db');
  const tmpPath = finalPath + '.tmp';
  let helper = null;
  try {
    fs.mkdirSync(path.dirname(finalPath), { recursive: true });
    const dbPath = databasePathOf(db, options);
    if (!dbPath) return { ok: false, reason: 'snapshot_path_unknown' };
    helper = new DatabaseSync(dbPath);
    try { helper.exec('PRAGMA busy_timeout = ' + (Number.isSafeInteger(options && options.drainTimeoutMs) && options.drainTimeoutMs > 0 ? options.drainTimeoutMs : 15000)); } catch (error) { /* ignore */ }
    for (const stale of [tmpPath, finalPath]) { try { fs.rmSync(stale, { force: true }); } catch (error) { /* ignore */ } }
    helper.prepare('VACUUM INTO ?').run(tmpPath);
    const verified = verifySnapshotFile(tmpPath);
    if (!verified.ok) {
      // 半成品的临时快照是垃圾，删掉；已有快照不动
      try { fs.rmSync(tmpPath, { force: true }); } catch (error) { /* ignore */ }
      return { ok: false, reason: 'snapshot_integrity', integrity: verified.detail, snapshot_path: tmpPath };
    }
    fs.renameSync(tmpPath, finalPath);
    return { ok: true, path: finalPath, bytes: fs.statSync(finalPath).size };
  } catch (error) {
    try { fs.rmSync(tmpPath, { force: true }); } catch (inner) { /* ignore */ }
    return { ok: false, reason: 'snapshot_failed', message: String((error && error.message) || error) };
  } finally {
    try { if (helper) helper.close(); } catch (error) { /* ignore */ }
  }
}

// ---------------------------------------------------------------- 原子物化

function fsyncFile(full, buffer) {
  const fd = fs.openSync(full, 'w', 0o600);
  try { fs.writeFileSync(fd, buffer); fs.fsyncSync(fd); }
  finally { fs.closeSync(fd); }
}

function readTaskPayload(db, taskId) {
  const task = db.prepare('SELECT * FROM tasks WHERE id = ?').get(taskId);
  if (!task) return null;
  return {
    task: task,
    messages: db.prepare('SELECT seq,msg_id,ts,sender,recipient,thread,kind,body,refs,reply_to,hop,chain_root,claimed_by FROM messages WHERE thread = ? ORDER BY seq').all(taskId),
    guard_events: db.prepare('SELECT id,task_id,agent,kind,detail,action,actor,ts FROM guard_events WHERE task_id = ? ORDER BY id').all(taskId),
    verification_runs: db.prepare('SELECT run_id,task_id,verify_id,verify_spec_hash,started_at,finished_at,exit_code,duration_ms,ok,stdout_tail,stderr_tail,log_path,reason FROM verification_runs WHERE task_id = ? ORDER BY started_at').all(taskId),
    reviews: db.prepare('SELECT id,task_id,reviewer,route,status,task_version,verdict,summary,lease_until,created_at,updated_at FROM reviews WHERE task_id = ? ORDER BY created_at').all(taskId),
    token_usage: db.prepare('SELECT id,agent,phase,tokens_in,tokens_out,ts FROM token_usage WHERE task_id = ? ORDER BY id').all(taskId),
    artifact_refs: db.prepare('SELECT kind,relative_path,sha256,size FROM artifact_refs WHERE task_id = ? ORDER BY relative_path').all(taskId),
  };
}

// 临时文件 + fsync + atomic rename + 回读校验 hash：文件没落地就不能动数据库
function materializeBundle(archiveDir, payload, meta, created) {
  const taskId = payload.task.id;
  const lines = [];
  lines.push(JSON.stringify({
    type: 'meta', bundle_version: 2, task_id: taskId, archived_at: meta.archived_at,
    plan_hash: meta.plan_hash, policy_hash: meta.policy_hash, schema_hash: meta.schema_hash,
    task_status: payload.task.status, task_version: payload.task.version,
  }));
  lines.push(JSON.stringify({ type: 'task', row: payload.task }));
  for (const row of payload.messages) lines.push(JSON.stringify({ type: 'message', row: row }));
  for (const row of payload.guard_events) lines.push(JSON.stringify({ type: 'guard_event', row: row }));
  for (const row of payload.verification_runs) lines.push(JSON.stringify({ type: 'verification_run', row: row }));
  for (const row of payload.reviews) lines.push(JSON.stringify({ type: 'review', row: row }));
  for (const row of payload.token_usage) lines.push(JSON.stringify({ type: 'token_usage', row: row }));
  for (const row of payload.artifact_refs) lines.push(JSON.stringify({ type: 'artifact_ref', row: row }));
  const jsonl = lines.join('\n') + '\n';
  const gz = zlib.gzipSync(Buffer.from(jsonl, 'utf8'));
  const rel = 'tasks/' + taskId + '.jsonl.gz';
  const full = path.join(archiveDir, 'tasks', taskId + '.jsonl.gz');
  fs.mkdirSync(path.dirname(full), { recursive: true });
  const tmp = full + '.tmp-' + crypto.randomBytes(6).toString('hex');
  created.push(tmp);
  created.push(full);
  fsyncFile(tmp, gz);
  fs.renameSync(tmp, full);
  const readback = fs.readFileSync(full);
  const digest = sha256(readback);
  if (digest !== sha256(gz)) throw new Error('bundle_hash_mismatch:' + taskId);
  const inflated = zlib.gunzipSync(readback).toString('utf8');
  if (inflated !== jsonl) throw new Error('bundle_roundtrip_mismatch:' + taskId);
  return { task_id: taskId, relative_path: rel, sha256: digest, bytes: readback.length, records: lines.length - 1 };
}

// ---------------------------------------------------------------- 执行

function dailySum(db, keys) {
  if (!keys.length) return 0;
  const stmt = db.prepare('SELECT COALESCE(SUM(tokens_in + tokens_out),0) AS t FROM token_usage_daily WHERE day_key = ? AND agent = ? AND project = ? AND task_id = ?');
  return keys.reduce(function (n, key) { return n + (Number(stmt.get(key.day_key, key.agent, key.project, key.task_id).t) || 0); }, 0);
}

// 屏障内校验：计划里的每一条都必须仍在原位（id / 版本 / 状态未变），否则整批中止
function validatePlanLocked(db, plan) {
  let integrity = '';
  try { integrity = String(db.prepare('PRAGMA integrity_check').get().integrity_check || ''); }
  catch (error) { return { ok: false, reason: 'source_integrity', integrity: 'error:' + String((error && error.message) || error) }; }
  if (integrity.toLowerCase() !== 'ok') return { ok: false, reason: 'source_integrity', integrity: integrity };
  const tables = plan.tables || {};
  const checkMessage = db.prepare('SELECT seq, thread FROM messages WHERE seq = ?');
  for (const id of ((tables.messages && tables.messages.ids) || [])) {
    const row = checkMessage.get(id);
    if (!row) return { ok: false, reason: 'plan_stale', detail: { table: 'messages', id: id, why: 'row_missing' } };
    if (row.thread) {
      const active = db.prepare('SELECT 1 AS x FROM tasks WHERE id = ? AND status IN ' + ACTIVE).get(row.thread);
      if (active) return { ok: false, reason: 'plan_stale', detail: { table: 'messages', id: id, why: 'thread_became_active' } };
    }
  }
  const checkGuard = db.prepare('SELECT id FROM guard_events WHERE id = ?');
  for (const id of ((tables.guard_events && tables.guard_events.ids) || [])) {
    if (!checkGuard.get(id)) return { ok: false, reason: 'plan_stale', detail: { table: 'guard_events', id: id, why: 'row_missing' } };
  }
  if (Number(plan.prune_unmanaged) === 1) {
    for (const id of ((tables.unmanaged_messages && tables.unmanaged_messages.ids) || [])) {
      if (!checkMessage.get(id)) return { ok: false, reason: 'plan_stale', detail: { table: 'unmanaged_messages', id: id, why: 'row_missing' } };
    }
    for (const id of ((tables.unmanaged_guard_events && tables.unmanaged_guard_events.ids) || [])) {
      if (!checkGuard.get(id)) return { ok: false, reason: 'plan_stale', detail: { table: 'unmanaged_guard_events', id: id, why: 'row_missing' } };
    }
  }
  const checkUsage = db.prepare('SELECT id, tokens_in, tokens_out FROM token_usage WHERE id = ?');
  for (const id of ((tables.token_usage && tables.token_usage.ids) || [])) {
    const row = checkUsage.get(id);
    if (!row) return { ok: false, reason: 'plan_stale', detail: { table: 'token_usage', id: id, why: 'row_missing' } };
  }
  const checkTask = db.prepare('SELECT id, status, version, updated_at FROM tasks WHERE id = ?');
  for (const entry of ((tables.tasks && tables.tasks.entries) || [])) {
    const row = checkTask.get(entry.id);
    if (!row) return { ok: false, reason: 'plan_stale', detail: { table: 'tasks', id: entry.id, why: 'row_missing' } };
    if (TERMINAL_LIST.indexOf(row.status) < 0) return { ok: false, reason: 'plan_stale', detail: { table: 'tasks', id: entry.id, why: 'status_changed', status: row.status } };
    if (Number(row.version) !== Number(entry.version)) return { ok: false, reason: 'plan_stale', detail: { table: 'tasks', id: entry.id, why: 'version_changed', planned: entry.version, current: row.version } };
    if (String(row.updated_at) !== String(entry.updated_at)) return { ok: false, reason: 'plan_stale', detail: { table: 'tasks', id: entry.id, why: 'updated_at_changed', planned: entry.updated_at, current: row.updated_at } };
    const archived = db.prepare('SELECT 1 AS x FROM task_archives WHERE task_id = ?').get(entry.id);
    if (archived) return { ok: false, reason: 'plan_stale', detail: { table: 'tasks', id: entry.id, why: 'already_archived' } };
  }
  return { ok: true };
}

function applyLocked(db, plan, bundles, now, deleted) {
  const tables = plan.tables || {};
  const archivedAt = now.toISOString();

  // 1) task_archives：文件已落地且 hash 已核对
  const insertArchive = db.prepare('INSERT INTO task_archives(task_id,archive_path,archived_at,sha256,bytes) VALUES(?,?,?,?,?)');
  for (const bundle of bundles) insertArchive.run(bundle.task_id, bundle.relative_path, archivedAt, bundle.sha256, bundle.bytes);
  deleted.tasks_archived = bundles.length;

  // 2) token_usage：先折叠 + 核对总和，再按计划里的精确 id 删除（同一事务）
  const usage = tables.token_usage || { groups: [], ids: [], total_tokens: 0 };
  const groups = usage.groups || [];
  if (groups.length) {
    const keys = groups.map(function (group) { return group.key; });
    const before = dailySum(db, keys);
    const upsert = db.prepare(
      'INSERT INTO token_usage_daily(day_key,agent,project,task_id,tokens_in,tokens_out) VALUES(?,?,?,?,?,?) ' +
      'ON CONFLICT(day_key,agent,project,task_id) DO UPDATE SET tokens_in = tokens_in + excluded.tokens_in, tokens_out = tokens_out + excluded.tokens_out'
    );
    for (const group of groups) upsert.run(group.key.day_key, group.key.agent, group.key.project, group.key.task_id, group.tokens_in, group.tokens_out);
    const after = dailySum(db, keys);
    const planned = Number(usage.total_tokens) || 0;
    if (after - before !== planned) throw new Error('usage_aggregation_mismatch: daily +' + (after - before) + ' != plan ' + planned);
  }
  const deleteUsage = db.prepare('DELETE FROM token_usage WHERE id = ?');
  let usageDeleted = 0;
  for (const id of (usage.ids || [])) {
    if (Number(deleteUsage.run(id).changes) !== 1) throw new Error('plan_divergence:token_usage:' + id);
    usageDeleted += 1;
  }
  deleted.token_usage = usageDeleted;
  deleted.usage_rows_folded = usageDeleted;

  // 3) messages / guard_events：只按计划里的精确 id 删，删少了删多了都整批回滚
  const deleteMessage = db.prepare('DELETE FROM messages WHERE seq = ?');
  let messagesDeleted = 0;
  for (const id of ((tables.messages && tables.messages.ids) || [])) {
    if (Number(deleteMessage.run(id).changes) !== 1) throw new Error('plan_divergence:messages:' + id);
    messagesDeleted += 1;
  }
  deleted.messages = messagesDeleted;

  const deleteGuard = db.prepare('DELETE FROM guard_events WHERE id = ?');
  let guardDeleted = 0;
  for (const id of ((tables.guard_events && tables.guard_events.ids) || [])) {
    if (Number(deleteGuard.run(id).changes) !== 1) throw new Error('plan_divergence:guard_events:' + id);
    guardDeleted += 1;
  }
  deleted.guard_events = guardDeleted;

  // 3b) 孤儿行：默认一行都不动；只有 retention.prune_unmanaged=1 才删（且同样按精确 id 核对）
  if (Number(plan.prune_unmanaged) === 1) {
    for (const id of ((tables.unmanaged_messages && tables.unmanaged_messages.ids) || [])) {
      if (Number(deleteMessage.run(id).changes) !== 1) throw new Error('plan_divergence:unmanaged_messages:' + id);
      deleted.unmanaged_messages += 1;
    }
    for (const id of ((tables.unmanaged_guard_events && tables.unmanaged_guard_events.ids) || [])) {
      if (Number(deleteGuard.run(id).changes) !== 1) throw new Error('plan_divergence:unmanaged_guard_events:' + id);
      deleted.unmanaged_guard_events += 1;
    }
  }

  // 4) 任务主体保留，只把大字段搬走
  const strip = db.prepare('UPDATE tasks SET body = NULL, verify_spec_json = NULL, updated_at = ? WHERE id = ?');
  for (const bundle of bundles) {
    if (Number(strip.run(archivedAt, bundle.task_id).changes) !== 1) throw new Error('plan_divergence:tasks:' + bundle.task_id);
  }
}

function deletePlannedLogs(plan, options) {
  const dir = logsDirOf(options);
  const base = path.resolve(dir);
  const out = { deleted: 0, skipped: [] };
  const entries = (plan.tables && plan.tables.artifact_refs && plan.tables.artifact_refs.entries) || [];
  for (const entry of entries) {
    const rel = String(entry.relative_path || '');
    const full = path.resolve(base, rel.split(/[\\/]/).join(path.sep));
    if (!rel || path.isAbsolute(rel) || rel.split(/[\\/]/).indexOf('..') >= 0
      || full !== path.join(base, rel.split(/[\\/]/).join(path.sep))) { out.skipped.push({ relative_path: rel, reason: 'path_escape' }); continue; }
    let st = null;
    try { st = fs.lstatSync(full); } catch (error) { out.skipped.push({ relative_path: rel, reason: 'missing' }); continue; }
    if (st.isSymbolicLink() || !st.isFile()) { out.skipped.push({ relative_path: rel, reason: 'symlink_or_not_file' }); continue; }
    if (entry.sha256) {
      const digest = sha256(fs.readFileSync(full));
      if (digest !== entry.sha256) { out.skipped.push({ relative_path: rel, reason: 'hash_mismatch' }); continue; }
    }
    try { fs.rmSync(full, { force: true }); out.deleted += 1; }
    catch (error) { out.skipped.push({ relative_path: rel, reason: 'unlink_failed' }); }
  }
  return out;
}

function cleanupFiles(list) {
  for (const full of list) { try { fs.rmSync(full, { force: true }); } catch (error) { /* ignore */ } }
}

function defaultHolder() { return 'archive:' + process.pid; }

// 审计在损坏的库上会抛错；失败路径不能因为写不了审计而丢掉真正的原因
function auditQuiet(db, entry) {
  try { return logAudit(db, entry); } catch (error) { return { ok: false }; }
}

function zeroDeleted() { return { messages: 0, guard_events: 0, token_usage: 0, tasks_archived: 0, logs: 0, usage_rows_folded: 0, unmanaged_messages: 0, unmanaged_guard_events: 0 }; }

export function applyArchive(db, policy, plan, options) {
  const o = options || {};
  if (!plan || !plan.plan_hash || !plan.tables) return { ok: false, reason: 'plan_required' };
  if (o.confirm == null || String(o.confirm) !== String(plan.plan_hash)) return { ok: false, reason: 'confirm_mismatch', plan_hash: plan.plan_hash };
  if (Number(plan.plan_version) !== PLAN_VERSION) return { ok: false, reason: 'plan_version_unsupported', plan_version: plan.plan_version, need: PLAN_VERSION };
  // 第 2 项：scope 必须与调用方声称的一致——A 项目的确认不能拿去跑 B 项目（也不能拿去跑全库）
  const planScope = plan.scope && plan.scope.type === 'project' ? String(plan.scope.project_id) : null;
  const callScope = o.project == null || o.project === '' ? null : String(o.project);
  if (planScope !== callScope) return { ok: false, reason: 'scope_mismatch', plan_project: planScope, confirm_project: callScope, message: '项目范围不符：确认必须同时带上同一个 project_id，不能把 A 项目的 confirmation 用在 B 项目或全库上' };
  // 计划本身不可变：内容 hash 必须与计划自带的 plan_hash 一致（防止 dry-run 之后有人改计划文件）
  const recomputed = planBodyHash(plan);
  if (recomputed !== String(plan.plan_hash)) return { ok: false, reason: 'plan_tampered', plan_hash: plan.plan_hash, recomputed: recomputed };
  // 计划生成时的策略与结构指纹必须仍然一致，否则整批中止并要求重新 dry-run
  const currentPolicyHash = policyHash(policy);
  if (plan.policy_hash !== currentPolicyHash) return { ok: false, reason: 'plan_stale', detail: { field: 'policy_hash', planned: plan.policy_hash, current: currentPolicyHash } };
  const currentSchemaHash = schemaHash();
  if (plan.schema_hash !== currentSchemaHash) return { ok: false, reason: 'plan_stale', detail: { field: 'schema_hash', planned: plan.schema_hash, current: currentSchemaHash } };

  const now = o.now ? new Date(o.now) : new Date();
  const holder = o.holder ? String(o.holder) : defaultHolder();
  const archiveDir = archiveDirOf(o);
  const deleted = zeroDeleted();
  const created = [];
  let inBarrier = false;
  let leaseHeld = false;
  let fenceToken = null;
  let committed = false;
  let snapshotPath = null;

  try {
    fs.mkdirSync(archiveDir, { recursive: true });

    // 1) drain：等当前写事务结束，并把之后的写入挡在门外
    const drain = acquireDrain(db, o);
    if (!drain.ok) return { ok: false, reason: drain.reason, message: drain.message };
    inBarrier = true;

    // 2) 单例租约（在屏障内判定并占用，天然串行）
    const lease = acquireArchiveLease(db, holder, policy, { now: now, note: 'plan ' + plan.plan_hash.slice(0, 12) });
    if (!lease.ok) {
      releaseDrain(db, false); inBarrier = false;
      return { ok: false, reason: 'lease_busy', holder: lease.holder, expires_at: lease.expires_at };
    }
    leaseHeld = true;
    fenceToken = lease.fence_token;

    // 3) 屏障内校验计划（id / 版本 / 源库完整性），任何偏差整批中止
    const check = validatePlanLocked(db, plan);
    if (!check.ok) {
      releaseDrain(db, false); inBarrier = false;
      auditQuiet(db, { actor: 'system', auth_method: 'archive', action: 'archive.failed', resource: { reason: check.reason, detail: check.detail || null, integrity: check.integrity || null, plan_hash: plan.plan_hash }, result: 'failed' });
      return check;
    }

    // 4) 一致性快照 + 完整性校验（不通过绝不动数据库）
    const snapshot = takeSnapshot(db, o, now);
    if (!snapshot.ok) {
      releaseDrain(db, false); inBarrier = false;
      auditQuiet(db, { actor: 'system', auth_method: 'archive', action: 'archive.failed', resource: { reason: snapshot.reason, integrity: snapshot.integrity || null, detail: snapshot.message || null, snapshot: snapshot.snapshot_path ? path.basename(snapshot.snapshot_path) : null }, result: 'failed' });
      return snapshot;
    }
    snapshotPath = snapshot.path;
    if (o.hooks && typeof o.hooks.duringBarrier === 'function') o.hooks.duringBarrier({ holder: holder, plan_hash: plan.plan_hash, snapshot_path: snapshot.path });

    // 5) 先物化任务完整 payload（含即将被删的 messages/guard/verification/review），再动数据库
    const bundles = [];
    for (const entry of ((plan.tables.tasks && plan.tables.tasks.entries) || [])) {
      const payload = readTaskPayload(db, entry.id);
      if (!payload) throw new Error('plan_divergence:tasks_missing:' + entry.id);
      bundles.push(materializeBundle(archiveDir, payload, { archived_at: now.toISOString(), plan_hash: plan.plan_hash, policy_hash: plan.policy_hash, schema_hash: plan.schema_hash }, created));
    }

    // 6) 提交前复核 fence：租约若已过期被接管、或 token 变了，旧 worker 一律不得提交。
    const fenceCheck = verifyArchiveLeaseFence(db, holder, fenceToken, { now: now });
    if (!fenceCheck.ok) {
      releaseDrain(db, false); inBarrier = false;
      auditQuiet(db, { actor: 'system', auth_method: 'archive', action: 'archive.failed', resource: { reason: fenceCheck.reason, detail: fenceCheck.detail } });
      return { ok: false, reason: fenceCheck.reason, message: fenceCheck.detail, plan_hash: plan.plan_hash };
    }

    // 7) 事务内：写 task_archives → 聚合 usage → 按精确 id 删原始行
    applyLocked(db, plan, bundles, now, deleted);
    const finish = releaseDrain(db, true);
    if (!finish.ok) throw new Error('commit_failed: ' + (finish.message || finish.reason));
    inBarrier = false; committed = true;

    // 7) 提交成功后才删日志（引用已归档 + hash 匹配 + 路径在 logs 内），二次核对 hash
    const logs = deletePlannedLogs(plan, o);
    deleted.logs = logs.deleted;

    logAudit(db, { actor: 'system', auth_method: 'archive', action: 'archive.applied', resource: { plan_hash: plan.plan_hash, deleted: deleted, holder: holder, snapshot: path.basename(snapshot.path), logs_skipped: logs.skipped.length }, result: 'ok' });
    const unmanagedInfo = {
      messages: Number(plan.unmanaged && plan.unmanaged.messages) || 0,
      guard_events: Number(plan.unmanaged && plan.unmanaged.guard_events) || 0,
      deferred_messages: Number(plan.unmanaged && plan.unmanaged.deferred_messages) || 0,
      deferred_guard_events: Number(plan.unmanaged && plan.unmanaged.deferred_guard_events) || 0,
      pruned: Number(plan.prune_unmanaged) === 1,
    };
    return { ok: true, deleted: deleted, snapshot_path: snapshot.path, plan_hash: plan.plan_hash, lease: { holder: holder, ttl_min: lease.ttl_min }, bundles: bundles.map(function (x) { return { task_id: x.task_id, relative_path: x.relative_path, sha256: x.sha256, bytes: x.bytes, records: x.records }; }), logs_skipped: logs.skipped, unmanaged: unmanagedInfo };
  } catch (error) {
    if (inBarrier) releaseDrain(db, false);
    // 归档失败：数据库事务已回滚，临时归档文件清掉，快照保留（第 10 项第 7 条）
    if (!committed) cleanupFiles(created);
    const detail = String((error && error.message) || error).slice(0, 200);
    auditQuiet(db, { actor: 'system', auth_method: 'archive', action: 'archive.failed', resource: { reason: 'transaction', detail: detail }, result: 'failed' });
    return { ok: false, reason: 'transaction_failed', message: detail, rolled_back: !committed, snapshot_path: snapshotPath || null };
  } finally {
    // 只有真正占用过租约才释放；提交后的释放是独立写入（屏障已放开）
    if (leaseHeld) { try { releaseArchiveLease(db, holder); } catch (error) { /* ignore */ } }
    if (inBarrier) { try { releaseDrain(db, false); } catch (error) { /* ignore */ } }
  }
}
