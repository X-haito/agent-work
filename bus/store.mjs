// Agent Bus 数据层：所有写操作都经过这里，守卫在此强制执行。
import { DatabaseSync } from 'node:sqlite';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import * as ProjectRegistry from './project-registry.mjs';
import fs from 'node:fs';
import { migrateDb } from './migrations.mjs';
import { normalizeRoots } from './execution-grant.mjs';
import { resolveValidator } from './verifier.mjs';
import { classifyText, classifyPaths, mergeKinds, KINDS } from './redline.mjs';
import { routeFor } from './review-routing.mjs';
import { applyPolicyDefaults } from './policy-schema.mjs';
import * as Isolation from './isolation/provider.mjs';
import * as Auth from './auth.mjs';

export const BUS_DIR = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(BUS_DIR, '..');
export const DEFAULT_DB = path.join(BUS_DIR, 'bus.db');
// 第 11 项隔离合同：生产代码里只 import 一个纯函数，不做任何 IO。
import { assertIsolated } from './smoke-support/isolation-guard.mjs';
export const POLICY_PATH = path.join(BUS_DIR, 'policy.json');

export const TERMINAL = ['done', 'failed', 'declined', 'cancelled'];
export const ACTIVE = ['open', 'proposed', 'claimed', 'in_progress', 'review'];

export function nowIso() { return new Date().toISOString(); }

// 有没有「当前还能用」的凭据：state 列存在时只认 active；老库没有 state 列时退回
// revoked_at/expires_at 判定。pending 一律不算（staged 轮换期间新 token 还不该能用）。
function hasActiveCredential(db, agent, nowIsoStr) {
  const now = Date.parse(nowIsoStr);
  let rows;
  try {
    rows = db.prepare('SELECT state, revoked_at, expires_at FROM agent_credentials WHERE agent_id=?').all(agent);
  } catch (error) {
    rows = db.prepare('SELECT revoked_at, expires_at FROM agent_credentials WHERE agent_id=?').all(agent);
  }
  return (rows || []).some(function (row) {
    if (row.state != null && row.state !== 'active') return false;
    if (row.revoked_at) return false;
    if (row.expires_at && Date.parse(row.expires_at) <= now) return false;
    return true;
  });
}

// 认证就绪检查：只有「每个已启用客户端都有 active 凭据 + 配置文件 ACL 合格」才算 ready。
// profiles / verify 由调用方注入（store 不依赖 admin-config 与平台权限模块，避免环形依赖）。
export function authReadiness(db, options) {
  const opts = options || {};
  const profiles = Array.isArray(opts.profiles) ? opts.profiles : [];
  const verify = typeof opts.verify === 'function' ? opts.verify : null;
  const checkedAt = typeof opts.now === 'string' && opts.now ? opts.now : nowIso();
  const blockers = [];
  const clients = [];
  const enabled = profiles.filter(function (profile) { return profile && profile.enabled === true; });
  for (const profile of enabled) {
    const agent = String(profile.agent || '');
    let hasActiveToken = false;
    try { hasActiveToken = agent ? hasActiveCredential(db, agent, checkedAt) : false; }
    catch (error) { hasActiveToken = false; }
    let permissionOk = false;
    let detail = '';
    if (!profile.path) detail = '找不到客户端配置文件路径';
    else if (!verify) detail = '没有提供 ACL 校验函数';
    else {
      let verdict = null;
      try { verdict = verify(profile.path) || null; } catch (error) { verdict = { ok: false, detail: String((error && error.message) || error) }; }
      permissionOk = !!(verdict && verdict.ok === true);
      detail = (verdict && (verdict.detail || verdict.method)) || '';
    }
    clients.push({ id: profile.id || null, agent: agent || null, path: profile.path || null, hasActiveToken: hasActiveToken, permissionOk: permissionOk, detail: detail });
    if (!hasActiveToken) blockers.push(String(profile.id || agent) + ': 没有 active 凭据（先 credentials rotate ' + (profile.id || agent) + '）');
    if (!permissionOk) blockers.push(String(profile.id || agent) + ': 配置文件权限不合格（' + detail + '）');
  }
  if (!enabled.length) blockers.push('没有已启用的 MCP 客户端');
  return { ready: blockers.length === 0, require_credentials: opts.requireCredentials === true,
    checked_at: checkedAt, clients: clients, blockers: blockers };
}
export function plusMinutes(m) { return new Date(Date.now() + m * 60000).toISOString(); }
export function newId() { return Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10); }

// 第 7 项：轮次/消息链上限。策略读不到时用保守缺省，绝不让守卫因为配置缺失而放开。
export function roundLimitOf(policy) {
  const n = policy && policy.economics && policy.economics.max_rounds_per_task;
  return Number.isSafeInteger(n) && n > 0 ? n : 2;
}

export function chainLimitOf(policy) {
  const n = policy && policy.global && policy.global.max_chain_len;
  return Number.isSafeInteger(n) && n > 0 ? n : 3;
}

function policyOrDefault() {
  try { return loadPolicy(); } catch (e) { return {}; }
}

// 解除升级：只有 Lead 或 Human 可以放行。删掉 task_escalations 行（supervisor 的
// escalationBlocks 读的就是这张表，删掉即重新可用），并同时写 guard_events 与 audit_log。
// 默认不动 round_count：想让被 retry_exceeded 卡住的卡能真正重试，需要显式 resetRounds。
export function releaseEscalation(db, policy, options) {
  const opts = options || {};
  const taskId = String(opts.taskId || '');
  const actor = String(opts.actor || '');
  const lead = effectiveLead(policy);
  if (actor !== 'human' && actor !== lead) {
    return { ok: false, reason: 'not_permitted', message: '只有 Lead（' + lead + '）或 human 可以解除升级，当前是 ' + (actor || '(空)') };
  }
  if (!taskId) return { ok: false, reason: 'task_required', message: '必须指定任务 id' };
  const task = getTask(db, taskId);
  if (!task) return { ok: false, reason: 'not_found', message: '没有这个任务: ' + taskId };
  const kind = opts.kind == null || opts.kind === '' ? null : String(opts.kind);
  return auditMutation(db, { actor: actor, auth_method: opts.auth_method || 'unknown', remote_addr: opts.remote_addr || null },
    'task.escalation_release', { task: taskId, kind: kind }, function () {
      const rows = kind
        ? db.prepare('SELECT kind FROM task_escalations WHERE task_id=? AND kind=?').all(taskId, kind)
        : db.prepare('SELECT kind FROM task_escalations WHERE task_id=?').all(taskId);
      if (!rows.length) return { ok: false, reason: 'not_escalated', message: '这个任务没有待解除的升级' + (kind ? '（' + kind + '）' : '') };
      if (kind) db.prepare('DELETE FROM task_escalations WHERE task_id=? AND kind=?').run(taskId, kind);
      else db.prepare('DELETE FROM task_escalations WHERE task_id=?').run(taskId);
      const kinds = rows.map(function (row) { return row.kind; });
      let roundsReset = false;
      if (opts.resetRounds === true && Number(task.round_count || 0) > 0) {
        db.prepare('UPDATE tasks SET round_count=0, version=version+1, updated_at=? WHERE id=?').run(nowIso(), taskId);
        roundsReset = true;
      }
      const detail = '解除升级 ' + kinds.join(',') + (opts.note ? '：' + String(opts.note).slice(0, 200) : '');
      logGuardEvent(db, { task_id: taskId, agent: actor, kind: 'escalation_release', detail: detail, action: 'released', actor: actor });
      send(db, { sender: actor, to: 'human', thread: taskId, kind: 'task.escalation_released', body: detail, refs: { task: taskId, released: kinds } });
      return { ok: true, task: getTask(db, taskId), released: kinds, rounds_reset: roundsReset };
    });
}

// 升级记录：UNIQUE(task_id,kind) 保证并发 supervisor 只升级一次。
export function escalate(db, taskId, kind) {
  const r = db.prepare('INSERT OR IGNORE INTO task_escalations(task_id,kind,created_at) VALUES(?,?,?)')
    .run(String(taskId), String(kind), nowIso());
  return { ok: true, created: Number(r.changes) === 1 };
}

function escalateWithEvent(db, policy, taskId, kind, detail) {
  const escalation = escalate(db, taskId, kind);
  if (escalation.created) {
    const lead = policy && policy.lead && policy.lead !== 'human' ? policy.lead : 'human';
    send(db, { sender: 'system', to: lead, thread: taskId, kind: kind, body: detail, refs: { task: taskId, escalation: kind }, policy: policy });
  }
  return escalation;
}

function normalizeScopeText(scope) {
  return String(scope == null ? '' : scope).split('\\').join('/').replace(/^\.\//, '');
}

// 空 allowlist = 不额外限制；配置了 allowlist 后每个 scope 至少匹配一项（path.matchesGlob）。
function scopeAllowlistViolations(policy, agent, scopes) {
  const allow = (agentCfg(policy, agent).scope_allowlist || []).filter(function (x) { return typeof x === 'string' && x.trim(); });
  if (!allow.length) return null;
  const list = Array.isArray(scopes) ? scopes : [];
  const bad = list.filter(function (scope) {
    const normalized = normalizeScopeText(scope);
    return !allow.some(function (pattern) { return path.posix.matchesGlob(normalized, normalizeScopeText(pattern)); });
  });
  return bad.length ? bad : null;
}

function pragma(db, s) {
  try { db.exec(s); } catch (e) { try { db.prepare(s).get(); } catch (e2) {} }
}


// 老库的缺列读出来是 undefined，统一当空数组
function jsonArray(v) {
  const list = Array.isArray(v) ? v.filter(function (x) { return !!x; }) : [];
  return list.length ? JSON.stringify(list) : null;
}

function parseArray(text) {
  if (!text) return [];
  try {
    const v = JSON.parse(text);
    return Array.isArray(v) ? v.filter(function (x) { return !!x; }) : [];
  } catch (e) { return []; }
}

export function openDb(dbPath) {
  // BUS_DB 是测试/多实例的标准入口（smoke-all 就是靠它注入临时库）；以前这里只认参数，
  // 于是 openDb() 永远打到真实库 —— 第 11 项把这条也纳入合同。
  const p = dbPath || process.env.BUS_DB || DEFAULT_DB;
  // AGENTBUS_TEST_GUARD=1 时，指向真实 bus/bus.db 一律立即抛错（这正是我们踩过的第一次事故）。
  assertIsolated('db', p, 'openDb() 默认路径就是真实库；测试请显式传临时路径或设 BUS_DB。');
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const db = new DatabaseSync(p);
  pragma(db, 'PRAGMA journal_mode = WAL');
  pragma(db, 'PRAGMA busy_timeout = 3000');
  migrateDb(db);
  return db;
}


// 事务可重入：已经在事务里就直接执行，由最外层统一提交/回滚。
// （审计下沉后，状态变更函数会互相嵌套，plain BEGIN 会报 "within a transaction"。）
let TX_DEPTH = 0;
function grantTransaction(db, action) {
  if (TX_DEPTH > 0) return action();
  db.exec('BEGIN IMMEDIATE');
  TX_DEPTH += 1;
  try { const result = action(); db.exec('COMMIT'); return result; }
  catch (error) { db.exec('ROLLBACK'); throw error; }
  finally { TX_DEPTH -= 1; }
}

// ---------- 审计下沉 ----------
// 状态变更与审计写在同一个事务里：审计写不进去，状态变更也必须回滚（宁可失败，不留无审计的变更）。
// authContext 缺省时 actor 记 'unknown' —— 绝不拿调用方传的 agent 参数冒充请求者身份。
function auditFields(authContext) {
  const ctx = authContext && typeof authContext === 'object' ? authContext : {};
  const actor = typeof ctx.actor === 'string' && ctx.actor.trim() ? ctx.actor.trim() : 'unknown';
  const method = typeof ctx.auth_method === 'string' && ctx.auth_method.trim() ? ctx.auth_method.trim() : 'unknown';
  const remote = ctx.remote_addr == null ? null : String(ctx.remote_addr);
  return { actor: actor, auth_method: method, remote_addr: remote };
}

function writeAudit(db, authContext, action, resource, result) {
  const fields = auditFields(authContext);
  return Auth.logAudit(db, { actor: fields.actor, auth_method: fields.auth_method, action: action,
    resource: resource, result: result || 'ok', remote_addr: fields.remote_addr });
}

// 把「状态变更 + 审计」包进同一个事务；拒绝也要留痕（谁在什么时候试图做什么）。
function auditMutation(db, authContext, action, resource, mutate) {
  return grantTransaction(db, function () {
    const out = mutate();
    const result = out && out.ok === true ? 'ok' : ('denied:' + ((out && out.reason) || 'error'));
    writeAudit(db, authContext, action, resource, result);
    return out;
  });
}

function executionTaskError(task, owner, version) {
  if (!task) return { ok: false, reason: 'not_found', message: '任务不存在' };
  if (!['claimed', 'in_progress'].includes(task.status)) return { ok: false, reason: 'not_claimed', message: '任务必须处于 claimed 或 in_progress' };
  if (task.owner !== owner) return { ok: false, reason: 'not_owner', message: '执行授权 owner 与任务不匹配' };
  if (!task.lease_until || !Number.isFinite(Date.parse(task.lease_until)) || Date.parse(task.lease_until) <= Date.now()) return { ok: false, reason: 'lease_expired', message: '任务租约已过期' };
  if (version !== undefined && version !== task.version) return { ok: false, reason: 'version_mismatch', message: '执行授权任务版本不匹配' };
  return null;
}

function grantJson(row) {
  return { grant_id: row.grant_id, task_id: row.task_id, owner: row.owner, task_version: row.task_version,
    roots: JSON.parse(row.roots_json), redline: JSON.parse(row.redline_json), issued_at: row.issued_at, expires_at: row.expires_at };
}

// 强隔离类 grant（多根 / extra_dirs / 删除 / 配置授权）必须有**有效 probe** 才发（第 3 项第 10 条）。
// 三种拒绝分开报：probe_missing（没证据）/ probe_not_verified（证据说没有隔离）/ probe_stale（证据过期）。
function strongIsolationRequired(normalized, task) {
  const extra = parseArray(task && task.extra_dirs);
  const kinds = mergeKinds(parseArray(task && task.redline), parseArray(task && task.grants));
  return (normalized.roots.length > 1) || extra.length > 0 || kinds.some(function (kind) { return /^(fs:delete|cfg:edit)$/.test(kind); });
}

function probeGate(probe, opts) {
  const nextStep = Isolation.nextStepFor;
  if (!probe) {
    return { ok: false, reason: 'probe_missing', message: '强隔离类任务需要隔离证据（probe），但这次没有提供', next_step: nextStep('probe_missing') };
  }
  if (probe.verified !== true) {
    return { ok: false, reason: 'probe_not_verified', message: '隔离未验证（probe.verified != true，probe.reason=' + String(probe.reason || 'unknown') + '）', probe_reason: probe.reason, next_step: nextStep('probe_not_verified') };
  }
  const freshness = Isolation.probeFreshness(probe, { now: opts && opts.now });
  if (!freshness.ok) {
    return { ok: false, reason: 'probe_stale', message: '隔离证据已过期（' + JSON.stringify(freshness.detail || {}) + '），需要重新探测', next_step: nextStep('probe_stale') };
  }
  return null;
}

export function issueExecutionGrant(db, taskId, owner, opts = {}) {
  return grantTransaction(db, function () {
    const task = getTask(db, taskId);
    const failure = executionTaskError(task, owner, opts.task_version);
    if (failure) return failure;
    const workspace = workspaceFor(db, task.project, owner, taskId);
    const normalized = normalizeRoots({ projectRoot: workspace.root, cwd: workspace.cwd, extraDirs: parseArray(task.extra_dirs) });
    if (!normalized.ok) return normalized;
    if (strongIsolationRequired(normalized, task)) {
      const gate = probeGate(opts.probe, opts);
      if (gate) return gate;
    }
    const existing = getExecutionGrant(db, taskId, owner);
    if (existing) return { ok: true, grant: existing };
    revokeExecutionGrant(db, taskId, 'reissued');
    const grant = { grant_id: newId(), task_id: taskId, owner, task_version: task.version,
      roots: normalized.roots, redline: mergeKinds(parseArray(task.redline), parseArray(task.grants)),
      issued_at: nowIso(), expires_at: task.lease_until };
    db.prepare('INSERT INTO execution_grants(grant_id,task_id,owner,task_version,roots_json,redline_json,issued_at,expires_at) VALUES(?,?,?,?,?,?,?,?)')
      .run(grant.grant_id, taskId, owner, grant.task_version, JSON.stringify(grant.roots), JSON.stringify(grant.redline), grant.issued_at, grant.expires_at);
    return { ok: true, grant };
  });
}

export function getExecutionGrant(db, taskId, owner) {
  const row = db.prepare("SELECT g.* FROM execution_grants g JOIN tasks t ON t.id=g.task_id WHERE g.task_id=? AND g.owner=? AND g.revoked_at IS NULL AND g.task_version=t.version AND t.owner=g.owner AND t.status IN ('claimed','in_progress') AND g.expires_at>? AND t.lease_until>? LIMIT 1").get(taskId, owner, nowIso(), nowIso());
  return row ? grantJson(row) : null;
}

export function revokeExecutionGrant(db, taskId, reason) {
  db.prepare('UPDATE execution_grants SET revoked_at=?,revoke_reason=? WHERE task_id=? AND revoked_at IS NULL').run(nowIso(), reason || 'revoked', taskId);
  return { ok: true };
}

export function extendExecutionGrant(db, taskId, owner, ms) {
  if (!Number.isSafeInteger(ms) || ms <= 0) return { ok: false, reason: 'invalid_duration', message: '续期毫秒数必须为正整数' };
  return grantTransaction(db, function () {
    const task = getTask(db, taskId);
    const failure = executionTaskError(task, owner);
    if (failure) return failure;
    const grant = getExecutionGrant(db, taskId, owner);
    if (!grant) return { ok: false, reason: 'grant_invalid', message: '执行授权不存在或已失效' };
    const expires = new Date(Math.min(Date.parse(task.lease_until), Date.now() + ms)).toISOString();
    db.prepare('UPDATE execution_grants SET expires_at=? WHERE grant_id=? AND revoked_at IS NULL').run(expires, grant.grant_id);
    return { ok: true };
  });
}

// options: { reason, nextStep, provider, verified, probeReason, detail }
// 把"为什么被拒 + 下一步该做什么"结构化成 guard.isolation，看板直接渲染，而不是只留一句话。
export function deferExecutionTask(db, taskId, owner, message, options = {}) {
  return grantTransaction(db, function () {
    const task = getTask(db, taskId);
    const failure = executionTaskError(task, owner);
    if (failure) return failure;
    const note = '执行端不支持强隔离' + (message ? ': ' + message : '');
    const reason = options.reason || null;
    let guard = null;
    try { guard = task.guard == null ? null : (typeof task.guard === 'string' ? JSON.parse(task.guard) : task.guard); } catch (error) { guard = null; }
    const merged = Object.assign({}, guard || {});
    merged.isolation = {
      reason: reason,
      message: message || null,
      next_step: options.nextStep || (reason ? Isolation.nextStepFor(reason) : null),
      provider: options.provider || null,
      verified: options.verified === true,
      probe_reason: options.probeReason || null,
      detail: options.detail || null,
      at: nowIso(),
    };
    db.prepare("UPDATE tasks SET status='proposed',needs_human=1,owner=NULL,lease_until=NULL,version=version+1,decline_reason=?,guard=?,updated_at=? WHERE id=? AND version=?").run(note, JSON.stringify(merged), nowIso(), taskId, task.version);
    revokeExecutionGrant(db, taskId, 'isolation_unsupported');
    logGuardEvent(db, { task_id: taskId, agent: owner, kind: 'execution_isolation', detail: note, action: 'needs_human', actor: owner });
    send(db, { sender: owner, to: 'human', thread: taskId, kind: 'task.proposed', body: note, refs: { task: taskId } });
    return { ok: true, task: getTask(db, taskId) };
  });
}

export function getRuntimeState(db) {
  const row = db.prepare('SELECT enabled,updated_at,updated_by,version FROM agentbus_runtime_state WHERE singleton=1').get();
  const active = Number(db.prepare("SELECT COUNT(*) AS n FROM tasks WHERE status IN ('claimed','in_progress','review')").get().n);
  const enabled = !!row && row.enabled === 1;
  return { enabled, mode: enabled ? 'enabled' : (active ? 'draining' : 'disabled'),
    active_tasks: active, updated_at: row ? row.updated_at : null,
    updated_by: row ? row.updated_by : null, version: row ? row.version : 0 };
}

export function setRuntimeState(db, actor, enabled, expectVersion, authContext) {
  const ctx = authContext || { actor: actor === 'human' ? 'human' : 'unknown', auth_method: actor === 'human' ? 'human' : 'unknown', remote_addr: null };
  return auditMutation(db, ctx, 'runtime.toggle', { enabled: enabled === true }, function () {
    if (actor !== 'human') return { ok: false, reason: 'not_permitted', message: '只有 Human 可在本地控制台启停 AgentBus' };
    if (typeof enabled !== 'boolean' || (expectVersion !== undefined && (!Number.isSafeInteger(expectVersion) || expectVersion < 0))) {
      return { ok: false, reason: 'invalid_runtime_state', message: 'enabled 必须为 boolean，version 必须为非负整数' };
    }
    const result = db.prepare('UPDATE agentbus_runtime_state SET enabled=?,updated_at=?,updated_by=?,version=version+1 WHERE singleton=1' +
      (expectVersion === undefined ? '' : ' AND version=?')).run(...[enabled ? 1 : 0, nowIso(), actor].concat(expectVersion === undefined ? [] : [expectVersion]));
    if (Number(result.changes) !== 1) return { ok: false, reason: 'version_mismatch', message: '运行状态已变更，请刷新后重试', ...getRuntimeState(db) };
    return { ok: true, ...getRuntimeState(db) };
  });
}

export function runtimeDisabled() {
  return { ok: false, reason: 'disabled', message: 'AgentBus 已关闭；请由 Human 在本地控制台启用' };
}

export function loadPolicy(p) {
  // BUS_POLICY_PATH 让测试能用临时策略，不污染真实配置
  const file = p || process.env.BUS_POLICY_PATH || POLICY_PATH;
  assertIsolated('policy', file, 'loadPolicy() 读到了真实 policy.json；测试请设 BUS_POLICY_PATH。');
  // 读写两条路径共用同一份 schema（policy-schema.mjs）：读的时候也补默认值，
  // 否则"删掉某字段"在运行时就等于"没有默认值"，和保存路径的语义对不上。
  const policy = applyPolicyDefaults(JSON.parse(fs.readFileSync(file, 'utf8')));
  // 过渡别名（第 10 项第 13 条）：策略文件里只写 max_single_log_bytes，但 archive.mjs 目前仍读
  // 旧名 max_log_bytes。在内存里补一份旧名，避免正名瞬间把已有阈值变成"不清理"。
  // bus-archive 把 archive.mjs 改成读新名后，这三行可以删。
  if (policy.retention && policy.retention.max_log_bytes == null && policy.retention.max_single_log_bytes != null) {
    policy.retention.max_log_bytes = policy.retention.max_single_log_bytes;
  }
  policy.agents = policy.agents || {};
  policy.global = policy.global || {};
  policy.permissions = policy.permissions || {};
  policy.economics = policy.economics || {};
  // 策略里没有 redline 段时按最严处理：删配置不能等于取消红线
  if (!policy.redline || !Array.isArray(policy.redline.human_only)) policy.redline = { human_only: KINDS.slice() };
  return policy;
}

export function agentCfg(policy, agent) {
  return policy.agents[agent] || { autonomy: 'off', may_dispatch_to: [], max_open_from_agents: 0, max_concurrent: 1 };
}

// ---------- presence ----------
export function heartbeat(db, agent, status) {
  db.prepare(
    'INSERT INTO presence(agent_id,status,pid,last_seen) VALUES(?,?,?,?) ' +
    'ON CONFLICT(agent_id) DO UPDATE SET status=excluded.status, pid=excluded.pid, last_seen=excluded.last_seen'
  ).run(agent, status || 'idle', process.pid, nowIso());
}

export function listAgents(db) {
  const stmt = db.prepare(
    'SELECT p.agent_id, p.status, p.last_seen, ' +
    '(SELECT COUNT(*) FROM tasks t WHERE t.owner = p.agent_id AND t.status IN (' +
    ACTIVE.map(function () { return '?'; }).join(',') + ')) AS active_tasks ' +
    'FROM presence p ORDER BY p.agent_id'
  );
  return stmt.all(...ACTIVE);
}

// ---------- messages ----------
function insertMessage(db, row) {
  db.prepare(
    'INSERT OR IGNORE INTO messages(msg_id,ts,sender,recipient,thread,kind,body,refs,reply_to,hop,chain_root) VALUES(?,?,?,?,?,?,?,?,?,?,?)'
  ).run(row.msg_id, row.ts, row.sender, row.recipient, row.thread, row.kind, row.body, row.refs, row.reply_to, row.hop, row.chain_root);
  const got = db.prepare('SELECT seq FROM messages WHERE msg_id = ?').get(row.msg_id);
  return { msg_id: row.msg_id, seq: got ? got.seq : null };
}

// 消息链：有父消息时 hop=父 hop+1 并继承 chain_root；没有父消息时是一条新链的根。
// 超过 global.max_chain_len 时不插入原消息，改写一条只发给 Lead/Human 的 chain_limit 事件。
export function send(db, m) {
  const policy = m.policy || policyOrDefault();
  const limit = chainLimitOf(policy);
  const parent = m.reply_to ? db.prepare('SELECT msg_id,thread,hop,chain_root FROM messages WHERE msg_id = ?').get(m.reply_to) : null;
  const hop = parent ? Number(parent.hop || 0) + 1 : (Number.isSafeInteger(m.hop) ? m.hop : 0);
  const msgId = m.msg_id || newId();
  const chainRoot = parent ? (parent.chain_root || parent.msg_id) : msgId;
  const thread = m.thread || (parent && parent.thread) || null;
  const row = {
    msg_id: msgId, ts: nowIso(), sender: m.sender, recipient: m.to, thread: thread, kind: m.kind,
    body: m.body || '', refs: m.refs ? JSON.stringify(m.refs) : null, reply_to: m.reply_to || null,
    hop: hop, chain_root: chainRoot,
  };
  if (hop > limit) {
    // 原消息不入库；升级事件交给 escalateWithEvent（同一条链只会发一次，UNIQUE(task_id,kind) 保证）。
    const escalation = escalateWithEvent(db, policy, thread || chainRoot, 'chain_limit',
      '消息链已达上限 hop=' + hop + ' > ' + limit + '，已阻断 ' + m.sender + ' → ' + (m.to || '?') + '（原 kind=' + m.kind + '）');
    return { msg_id: null, seq: null, chain_limited: true, dropped: true, hop: hop, chain_root: chainRoot, limit: limit, escalation_created: escalation.created };
  }
  return Object.assign(insertMessage(db, row), { hop: hop, chain_root: chainRoot });
}

export function cursorOf(db, agent) {
  const r = db.prepare('SELECT last_seq FROM cursor WHERE agent_id = ?').get(agent);
  return r ? r.last_seq : 0;
}

export function setCursor(db, agent, seq) {
  db.prepare('INSERT INTO cursor(agent_id,last_seq) VALUES(?,?) ON CONFLICT(agent_id) DO UPDATE SET last_seq=excluded.last_seq')
    .run(agent, seq);
}

export function messagesSince(db, seq, agent) {
  return db.prepare(
    'SELECT seq,msg_id,ts,sender,recipient,thread,kind,body,refs,reply_to,hop FROM messages ' +
    "WHERE seq > ? AND sender <> ? AND (recipient = ? OR recipient = 'broadcast' OR recipient LIKE 'thread:%' OR recipient = '*') " +
    'ORDER BY seq LIMIT 200'
  ).all(seq, agent, agent);
}

// cursorKey 允许同一个 agent 身份有多个互不抢占的收件箱：
// 交互式会话和常驻守护进程共用一个身份，但各自维护自己的游标，
// 否则谁先读到消息，另一个就再也看不到了。
export async function waitFor(db, agent, sinceSeq, timeoutMs, cursorKey) {
  const key = cursorKey || agent;
  const deadline = Date.now() + Math.max(0, Math.min(timeoutMs || 0, 55000));
  let since = typeof sinceSeq === 'number' ? sinceSeq : cursorOf(db, key);
  let lastBeat = 0;
  for (;;) {
    if (!getRuntimeState(db).enabled) return { ...runtimeDisabled(), messages: [], next_seq: since, timed_out: false };
    if (Date.now() - lastBeat > 5000) { heartbeat(db, agent, 'idle'); lastBeat = Date.now(); }
    const rows = messagesSince(db, since, agent);
    if (rows.length) {
      const last = rows[rows.length - 1].seq;
      setCursor(db, key, last);
      return { messages: rows, next_seq: last, timed_out: false };
    }
    if (Date.now() >= deadline) return { messages: [], next_seq: since, timed_out: true };
    await new Promise(function (r) { setTimeout(r, 200); });
  }
}

// ---------- tasks ----------
function nextTaskId(db) {
  const r = db.prepare("SELECT COALESCE(MAX(CAST(SUBSTR(id,3) AS INTEGER)),0)+1 AS n FROM tasks WHERE id LIKE 't-%'").get();
  return 't-' + String(r.n).padStart(4, '0');
}

export function getTask(db, id) {
  return db.prepare('SELECT * FROM tasks WHERE id = ?').get(id);
}

export function listTasks(db, f) {
  const where = [];
  const args = [];
  if (f && f.status) { where.push('status = ?'); args.push(f.status); }
  else { where.push("status NOT IN ('done','failed','declined','cancelled')"); }
  if (f && f.owner) { where.push('owner = ?'); args.push(f.owner); }
  if (f && f.project) { where.push('project = ?'); args.push(f.project); }
  const sql = 'SELECT id,title,body,project,status,owner,origin,dispatched_by,target,depth,cost_class,' +
    'write_scope,max_subagents,verify_cmd,verify_id,verify_spec_json,verify_spec_hash,extra_dirs,network_grants,redline,grants,guard,changed_files,needs_human,escalated_at,' +
    'round_count,retry_limit,parent_task_id,' +
    'version,lease_until,decline_reason,created_at,updated_at FROM tasks WHERE ' +
    where.join(' AND ') + ' ORDER BY id LIMIT 200';
  return db.prepare(sql).all(...args);
}

export function createTask(db, t) {
  const id = nextTaskId(db);
  const ts = nowIso();
  db.prepare(
    'INSERT INTO tasks(id,title,body,project,status,owner,origin,dispatched_by,target,depth,cost_class,' +
    'write_scope,max_subagents,verify_cmd,verify_id,verify_spec_json,verify_spec_hash,extra_dirs,network_grants,redline,grants,' +
    'round_count,retry_limit,parent_task_id,token_budget,version,created_at,updated_at) ' +
    'VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)'
  ).run(id, t.title, t.body || null, t.project || 'default', t.status, null, t.origin || 'human',
    t.dispatched_by || null, t.target || null, t.depth || 0, t.cost_class || 'standard',
    t.write_scope ? JSON.stringify(t.write_scope) : null, t.max_subagents || 0,
    t.verify_cmd || null, t.verify_id || null, t.verify_spec_json || null, t.verify_spec_hash || null, t.extra_dirs ? JSON.stringify(t.extra_dirs) : null, jsonArray(t.network_grants),
    jsonArray(t.redline), jsonArray(t.grants),
    Number.isSafeInteger(t.round_count) ? t.round_count : 0,
    Number.isSafeInteger(t.retry_limit) ? t.retry_limit : null,
    t.parent_task_id || null,
    Number.isSafeInteger(t.token_budget) && t.token_budget > 0 ? t.token_budget : null, 0, ts, ts);
  return getTask(db, id);
}

export function createHumanTask(db, policy, actor, t) {
  if (!getRuntimeState(db).enabled) return runtimeDisabled();
  try { return createHumanTaskEnabled(db, policy, actor, t); } catch (e) {
    if (e && e.message === 'agentbus_disabled') return runtimeDisabled();
    throw e;
  }
}

function verifyCommandRequired(policy, task) {
  const economics = policy.economics || {};
  const automatic = Array.isArray(economics.auto_accept) ? economics.auto_accept : [];
  if (economics.require_verify_cmd === true && automatic.indexOf(task.cost_class || 'standard') >= 0 &&
      (typeof task.verify_id !== 'string' || !task.verify_id.trim())) {
    return { ok: false, reason: 'verify_cmd_required', message: '自动验收类别 ' + (task.cost_class || 'standard') + ' 必须提供非空 verify_id 项目验证器' };
  }
  return null;
}

function freezeTaskVerifier(input, actor) {
  if (input.verify_cmd !== undefined && input.verify_cmd !== null && input.verify_cmd !== '') {
    if (actor !== 'human') return { ok:false,reason:'legacy_verify_cmd_forbidden',message:'Agent 禁止提交自由 verify_cmd，请选择项目 verify_id' };
    if (typeof input.verify_cmd !== 'string') return { ok:false,reason:'invalid_validator',message:'verify_cmd 必须是字符串' };
    if (input.verify_id) return { ok:false,reason:'legacy_verify_cmd_forbidden',message:'verify_id 不能与旧 verify_cmd 同时使用' };
    return { ok:true,fields:{verify_id:null,verify_spec_json:null,verify_spec_hash:null},legacy:true };
  }
  if (!input.verify_id) return { ok:true,fields:{verify_id:null,verify_spec_json:null,verify_spec_hash:null},legacy:false };
  const resolved=resolveValidator(resolveProjectDir(input.project),input.verify_id);
  if (!resolved.ok) return resolved;
  return { ok:true,fields:{verify_id:input.verify_id,verify_spec_json:JSON.stringify(resolved.spec),verify_spec_hash:resolved.hash},legacy:false };
}

function createHumanTaskEnabled(db, policy, actor, t) {
  const who = actor || 'human';
  const canCreate = who === 'human' || (policy.permissions.dispatch || []).indexOf(who) >= 0;
  if (!canCreate) return { ok: false, reason: 'not_permitted', message: who + ' 没有创建/派发任务的权限' };
  const frozen = freezeTaskVerifier(t, who);
  if (!frozen.ok) return frozen;
  const verification = frozen.legacy ? null : verifyCommandRequired(policy, t);
  if (verification) return verification;
  const kinds = mergeKinds(
    classifyText([t.title, t.body, t.verify_cmd].filter(function (x) { return !!x; }).join('\n')),
    classifyPaths(t.write_scope),
    t.grants
  );
  const budget = budgetAdmission(db, policy, { agent: t.target || who, costClass: t.cost_class, tokenBudget: t.token_budget });
  const status = (t.status === 'proposed' || frozen.legacy || kinds.length || (t.extra_dirs && t.extra_dirs.length) || (t.network_grants && t.network_grants.length) || !budget.ok) ? 'proposed' : 'open';
  const task = createTask(db, {
    title: t.title,
    body: t.body,
    project: t.project,
    status: status,
    origin: 'human',
    dispatched_by: t.target ? who : null,
    target: t.target || null,
    depth: 0,
    cost_class: t.cost_class,
    write_scope: t.write_scope,
    max_subagents: t.max_subagents,
    verify_cmd: t.verify_cmd,
    ...frozen.fields,
    extra_dirs: t.extra_dirs,
    network_grants: t.network_grants,
    redline: kinds,
    grants: t.grants || [],
    retry_limit: roundLimitOf(policy),
    token_budget: Number.isSafeInteger(t.token_budget) && t.token_budget > 0 ? t.token_budget : null,
  });
  send(db, {
    policy: policy,
    sender: who,
    to: task.target || 'broadcast',
    thread: task.id,
    kind: 'task.new',
    body: task.title,
    refs: { task: task.id, project: task.project },
  });
  return { ok: true, task: task, gated: status === 'proposed', gated_by: budget.ok ? null : 'budget_exceeded' };
}

export function editTask(db, policy, actor, taskId, patch, expectVersion) {
  const who = actor || 'human';
  const t = getTask(db, taskId);
  if (!t) return { ok: false, reason: 'not_found', message: '没有这个任务: ' + taskId };
  const canEdit = who === 'human' || (policy.permissions.reassign || []).indexOf(who) >= 0 ||
    (policy.permissions.dispatch || []).indexOf(who) >= 0;
  if (!canEdit) return { ok: false, reason: 'not_permitted', message: who + ' 没有编辑任务的权限' };
  if (TERMINAL.indexOf(t.status) >= 0) return { ok: false, reason: 'terminal', message: '任务已结束: ' + t.status };
  if (typeof expectVersion === 'number' && expectVersion !== t.version) {
    return { ok: false, reason: 'version_mismatch', message: '任务已被他人修改，当前 version=' + t.version };
  }

  // 预算调额：只有 Human 或有验收权的人能改，且不受"开始后锁定"限制（第 8 项明确要求人工临时调额）。
  if (Object.prototype.hasOwnProperty.call(patch, 'token_budget')) {
    const accepters = (policy.permissions && policy.permissions.accept) || [];
    if (who !== 'human' && accepters.indexOf(who) < 0) {
      return { ok: false, reason: 'not_permitted', message: '只有 Human 或有验收权的人可以调整任务预算' };
    }
    const raw = patch.token_budget;
    if (raw == null || raw === '') {
      patch = Object.assign({}, patch, { token_budget: null });
    } else if (!Number.isSafeInteger(Number(raw)) || Number(raw) <= 0) {
      return { ok: false, reason: 'invalid_token_budget', message: 'token_budget 必须是正整数，留空表示只受日预算限制' };
    } else {
      patch = Object.assign({}, patch, { token_budget: Number(raw) });
    }
  }

  const structural = ['project', 'target', 'write_scope', 'verify_id', 'verify_cmd', 'extra_dirs', 'grants', 'network_grants'];
  if (t.status !== 'open' && t.status !== 'proposed' && structural.some(function (k) { return Object.prototype.hasOwnProperty.call(patch, k); })) {
    return { ok: false, reason: 'task_started', message: '任务开始后不能修改项目、目标 Agent 或写作用域；请先改派任务' };
  }

  const verifierChange = ['verify_id','verify_cmd','project'].some(key => Object.prototype.hasOwnProperty.call(patch,key));
  let frozen = null;
  if (verifierChange) {
    const merged = { ...t,...patch };
    if (Object.prototype.hasOwnProperty.call(patch,'verify_id') && !patch.verify_cmd) merged.verify_cmd = '';
    frozen = freezeTaskVerifier(merged, who);
    if (!frozen.ok) return frozen;
    const required = frozen.legacy ? null : verifyCommandRequired(policy, merged);
    if (required) return required;
  }
  const sets = [];
  const args = [];
  if (frozen) {
    for (const [key,value] of Object.entries(frozen.fields)) { sets.push(key+'=?');args.push(value); }
    if (Object.prototype.hasOwnProperty.call(patch,'verify_id')) { sets.push('verify_cmd=?');args.push(null); }
  }
  const allowed = ['title', 'body', 'project', 'target', 'cost_class', 'max_subagents', 'verify_cmd', 'token_budget'];
  for (const key of allowed) {
    if (!Object.prototype.hasOwnProperty.call(patch, key)) continue;
    sets.push(key + '=?');
    args.push(patch[key] === '' ? null : patch[key]);
  }
  if (Object.prototype.hasOwnProperty.call(patch, 'write_scope')) {
    sets.push('write_scope=?');
    args.push(patch.write_scope && patch.write_scope.length ? JSON.stringify(patch.write_scope) : null);
  }
  for (const key of ['extra_dirs', 'grants', 'network_grants']) {
    if (!Object.prototype.hasOwnProperty.call(patch, key)) continue;
    sets.push(key + '=?');
    args.push(JSON.stringify(patch[key] || []));
  }
  if (!sets.length) return { ok: false, reason: 'empty_patch', message: '没有可更新的字段' };
  const kinds = mergeKinds(classifyText([patch.title ?? t.title, patch.body ?? t.body, patch.verify_cmd ?? t.verify_cmd].filter(Boolean).join(String.fromCharCode(10))), classifyPaths(patch.write_scope ?? parseArray(t.write_scope)), patch.grants ?? parseArray(t.grants));
  const dirs = patch.extra_dirs ?? parseArray(t.extra_dirs);
  if (t.status === 'open' || t.status === 'proposed') {
    sets.push('redline=?'); args.push(JSON.stringify(kinds));
    if (kinds.length || dirs.length || (frozen && frozen.legacy)) { sets.push('status=?'); args.push('proposed'); }
  }
  sets.push('version=version+1', 'updated_at=?');
  args.push(nowIso(), taskId, t.version);
  const r = db.prepare('UPDATE tasks SET ' + sets.join(',') + ' WHERE id=? AND version=?').run(...args);
  if (Number(r.changes) !== 1) {
    const cur = getTask(db, taskId);
    return { ok: false, reason: 'race_lost', message: '任务已被他人修改，当前 version=' + (cur ? cur.version : '?') };
  }
  const next = getTask(db, taskId);
  send(db, { sender: who, to: 'thread:' + taskId, thread: taskId, kind: 'task.progress',
    body: '已更新任务信息', refs: { task: taskId, edited: Object.keys(patch) } });
  if (patch.target && patch.target !== t.target) {
    send(db, { sender: who, to: patch.target, thread: taskId, kind: 'task.new', body: next.title, refs: { task: taskId } });
  }
  return { ok: true, task: next };
}

export function reassignTask(db, policy, actor, taskId, target, expectVersion, authContext) {
  if (!getRuntimeState(db).enabled) return runtimeDisabled();
  const ctx = authContext || { actor: 'unknown', auth_method: 'unknown', remote_addr: null };
  try {
    return auditMutation(db, ctx, 'task.reassign', { task: taskId, target: target || null }, function () {
      return reassignTaskEnabled(db, policy, actor, taskId, target, expectVersion);
    });
  } catch (e) {
    if (e && e.message === 'agentbus_disabled') return runtimeDisabled();
    throw e;
  }
}

function reassignTaskEnabled(db, policy, actor, taskId, target, expectVersion) {
  const who = actor || 'human';
  const t = getTask(db, taskId);
  if (!t) return { ok: false, reason: 'not_found', message: '没有这个任务: ' + taskId };
  const canReassign = who === 'human' || (policy.permissions.reassign || []).indexOf(who) >= 0;
  if (!canReassign) return { ok: false, reason: 'not_permitted', message: who + ' 没有改派权限' };
  if (TERMINAL.indexOf(t.status) >= 0) return { ok: false, reason: 'terminal', message: '任务已结束: ' + t.status };
  if (typeof expectVersion === 'number' && expectVersion !== t.version) {
    return { ok: false, reason: 'version_mismatch', message: '任务已被他人修改，当前 version=' + t.version };
  }
  const r = db.prepare(
    "UPDATE tasks SET target=?, owner=NULL, status='open', lease_until=NULL, dispatched_by=?, version=version+1, updated_at=? WHERE id=? AND version=?"
  ).run(target || null, who, nowIso(), taskId, t.version);
  if (Number(r.changes) !== 1) return { ok: false, reason: 'race_lost', message: '任务已被他人修改，请刷新后重试' };
  const next = getTask(db, taskId);
  send(db, { sender: who, to: target || 'broadcast', thread: taskId, kind: 'task.new',
    body: '任务改派: ' + next.title, refs: { task: taskId, previous_owner: t.owner, previous_target: t.target } });
  return { ok: true, task: next };
}

export function cancelTask(db, policy, actor, taskId, note, expectVersion, authContext) {
  const ctx = authContext || { actor: 'unknown', auth_method: 'unknown', remote_addr: null };
  return auditMutation(db, ctx, 'task.cancel', { task: taskId }, function () {
    return cancelTaskEnabled(db, policy, actor, taskId, note, expectVersion);
  });
}

function cancelTaskEnabled(db, policy, actor, taskId, note, expectVersion) {
  const who = actor || 'human';
  const t = getTask(db, taskId);
  if (!t) return { ok: false, reason: 'not_found', message: '没有这个任务: ' + taskId };
  const canCancel = who === 'human' || (policy.permissions.accept || []).indexOf(who) >= 0;
  if (!canCancel) return { ok: false, reason: 'not_permitted', message: who + ' 没有取消权限' };
  if (TERMINAL.indexOf(t.status) >= 0) return { ok: false, reason: 'terminal', message: '任务已结束: ' + t.status };
  if (typeof expectVersion === 'number' && expectVersion !== t.version) {
    return { ok: false, reason: 'version_mismatch', message: '任务已被他人修改，当前 version=' + t.version };
  }
  const r = db.prepare(
    "UPDATE tasks SET status='cancelled', lease_until=NULL, version=version+1, updated_at=? WHERE id=? AND version=?"
  ).run(nowIso(), taskId, t.version);
  if (Number(r.changes) !== 1) return { ok: false, reason: 'race_lost', message: '任务已被他人修改，请刷新后重试' };
  send(db, { sender: who, to: 'thread:' + taskId, thread: taskId, kind: 'task.cancelled',
    body: note || '任务已取消', refs: { task: taskId } });
  return { ok: true, task: getTask(db, taskId) };
}

export function claim(db, agent, taskId, leaseMin) {
  if (!getRuntimeState(db).enabled) return runtimeDisabled();
  try { return claimEnabled(db, agent, taskId, leaseMin); } catch (e) {
    if (e && e.message === 'agentbus_disabled') return runtimeDisabled();
    throw e;
  }
}

function claimEnabled(db, agent, taskId, leaseMin) {
  // 整个认领（写作用域判定 + CAS UPDATE）在同一事务里：判定与写入之间不能被别人插进来，
  // 并发情况下由 UPDATE ... WHERE status='open' AND version=? 保一胜一败。
  return grantTransaction(db, function () { return claimLocked(db, agent, taskId, leaseMin); });
}

function claimLocked(db, agent, taskId, leaseMin) {
  const t = getTask(db, taskId);
  if (!t) return { ok: false, reason: 'not_found', message: '没有这个任务: ' + taskId };
  if (t.status === 'proposed') return { ok: false, reason: 'needs_approval', message: '任务在待批状态，需先 accept' };
  if (t.status !== 'open') return { ok: false, reason: 'not_open', message: '任务当前状态是 ' + t.status + '，owner=' + (t.owner || 'none') };
  if (t.target && t.target !== agent) return { ok: false, reason: 'not_target', message: '这个任务是定向派给 ' + t.target + ' 的，你不能认领' };

  // 未知 agent 一律拒绝：以前"查不到配置就不限额"，等于任意自报身份都能绕过 max_concurrent。
  const policy = policyOrDefault();
  const registered = Object.prototype.hasOwnProperty.call(policy.agents || {}, agent);
  if (!registered && agent !== 'human') {
    return { ok: false, reason: 'unknown_agent', message: agent + ' 不在策略的 agents 列表中，不能认领任务（先登记并按 max_concurrent 配置）' };
  }
  // max_concurrent（第 9 项）：口径是 claimed + in_progress —— 已认领但还没开始也算占槽，
  // 否则"先 claim 十张再慢慢做"可以绕过配额；review 不占执行槽（不在下面的 IN 列表里）。
  if (registered) {
    // 先回收自己名下已过期的 lease：过期占用不该把配额锁死（同一个事务里做，避免竞态）。
    db.prepare("UPDATE tasks SET owner=NULL, status='open', lease_until=NULL, version=version+1, updated_at=? WHERE owner=? AND status='claimed' AND lease_until IS NOT NULL AND lease_until < ?")
      .run(nowIso(), agent, nowIso());
    const cfg = policy.agents[agent] || {};
    const cap = Number.isSafeInteger(cfg.max_concurrent) && cfg.max_concurrent > 0 ? cfg.max_concurrent : 1;
    const running = Number(db.prepare("SELECT COUNT(*) AS c FROM tasks WHERE owner = ? AND status IN ('claimed','in_progress')").get(agent).c);
    if (running >= cap) {
      return { ok: false, reason: 'max_concurrent', message: agent + ' 已有 ' + running + ' 个已认领/执行中的任务，达到上限 ' + cap };
    }
  }

  const mine = t.write_scope ? JSON.parse(t.write_scope) : [];
  if (mine.length) {
    const others = db.prepare('SELECT id,owner,write_scope FROM tasks WHERE status IN (?,?) AND project = ? AND id <> ?')
      .all('claimed', 'in_progress', t.project, taskId);
    for (const o of others) {
      const sc = o.write_scope ? JSON.parse(o.write_scope) : [];
      const hit = sc.filter(function (x) { return mine.indexOf(x) >= 0; });
      if (hit.length) {
        return { ok: false, reason: 'scope_conflict', message: '与 ' + o.id + '(' + (o.owner || '?') + ') 的写作用域重叠: ' + hit.join(', ') };
      }
    }
  }

  const lease = plusMinutes(leaseMin || 15);
  const r = db.prepare(
    "UPDATE tasks SET owner=?, status='claimed', lease_until=?, version=version+1, updated_at=? WHERE id=? AND status='open' AND version=?"
  ).run(agent, lease, nowIso(), taskId, t.version);
  if (Number(r.changes) !== 1) {
    const cur = getTask(db, taskId);
    return { ok: false, reason: 'race_lost', message: '被抢先认领，当前 owner=' + (cur.owner || 'none') };
  }
  send(db, { sender: agent, to: 'thread:' + taskId, thread: taskId, kind: 'task.claim', body: '认领 ' + taskId, refs: { task: taskId } });
  return { ok: true, task: getTask(db, taskId), workspace: workspaceFor(db, t.project, agent, taskId) };
}

// ---------- 项目位置 ----------
export function resolveProjectDir(project) {
  if (!project) return path.join(ROOT, 'workspaces', 'default');
  if (/^[a-zA-Z]:[\\/]/.test(project) || project.slice(0, 2) === '\\\\' || project.charAt(0) === '/') return project;
  try {
    const reg = JSON.parse(fs.readFileSync(path.join(BUS_DIR, 'projects.json'), 'utf8'));
    const hit = reg[project] || (reg.projects || {})[project];
    if (hit && hit.path) return hit.path;
  } catch (e) {}
  return path.join(ROOT, 'workspaces', project);
}

export function workspaceFor(db, project, agent, taskId) {
  const dir = resolveProjectDir(project);
  let cfg = { topology: 'clone-per-agent' };
  try { cfg = JSON.parse(fs.readFileSync(path.join(dir, 'project.json'), 'utf8')); } catch (e) {}
  const base = cfg.root ? cfg.root : dir;
  const slug = String(agent).replace(/[^a-z0-9]+/gi, '-');
  const topo = cfg.topology || 'clone-per-agent';
  const cwd = (topo === 'clone-per-agent' || topo === 'isolated') ? path.join(base, slug) : base;
  return {
    project: project || 'default',
    topology: topo,
    root: path.normalize(base),
    cwd: path.normalize(cwd),
    branch: 'agent/' + slug + '/' + taskId,
    lock_required: topo === 'shared',
  };
}

export function updateTask(db, agent, taskId, status, note, expectVersion, accepters, authContext) {
  const t = getTask(db, taskId);
  if (!t) return { ok: false, reason: 'not_found', message: '没有这个任务: ' + taskId };
  if (typeof expectVersion === 'number' && expectVersion !== t.version) {
    return { ok: false, reason: 'version_mismatch', message: '任务已被他人修改，当前 version=' + t.version };
  }
  // 守卫判过 needs_human 的卡，只能人类自己判 done
  if (status === 'done' && Number(t.needs_human) === 1 && agent !== 'human') {
    return { ok: false, reason: 'needs_human', message: '这张任务被守卫标记为需要人类确认，' + agent + ' 不能直接判 done' };
  }
  const allowed = {
    in_progress: ['claimed'],
    review: ['in_progress'],
    done: ['review'],
    failed: ['claimed', 'in_progress', 'review'],
    cancelled: ['open', 'proposed'],
  };
  const canAccept = (accepters || []).indexOf(agent) >= 0;
  // 误判 failed 时有验收权的人可以退回 review
  const overrideReview = status === 'review' && t.status === 'failed' && canAccept;
  const froms = allowed[status];
  if (!froms) return { ok: false, reason: 'bad_status', message: '不允许迁移到 ' + status };
  if (froms.indexOf(t.status) < 0 && !overrideReview) {
    return { ok: false, reason: 'bad_transition', message: '不能从 ' + t.status + ' 迁到 ' + status + '（允许来源: ' + froms.join(',') + '）' };
  }
  const accepterOnly = canAccept && ((status === 'done' && t.status === 'review') || status === 'cancelled' || overrideReview);
  if (t.owner !== agent && !accepterOnly) {
    return { ok: false, reason: 'not_owner', message: 'owner 是 ' + (t.owner || '(无)') + '，不是你；且你不具备此操作所需权限' };
  }
  // done 的硬门：已认领的评审没有 verdict、或本轮被判 changes_requested，都不能直接收尾
  if (status === 'done') {
    const gate = reviewGate(db, taskId);
    if (gate) return gate;
  }

  // 进入 review：状态迁移与评审指派在同一个写事务里，避免"有 review 没 assignment"
  if (status === 'review') {
    return grantTransaction(db, function () {
      const updated = db.prepare("UPDATE tasks SET status='review', version=version+1, updated_at=?, lease_until=NULL WHERE id=? AND version=?")
        .run(nowIso(), taskId, t.version);
      if (Number(updated.changes) !== 1) return { ok: false, reason: 'race_lost', message: '任务已被他人修改，请刷新后重试' };
      send(db, { policy: policyOrDefault(), sender: agent, to: 'thread:' + taskId, thread: taskId, kind: 'task.review',
        body: note || (taskId + ' -> review'), refs: { task: taskId } });
      const assignment = assignReviewLocked(db, policyOrDefault(), taskId, {});
      return {
        ok: true, task: getTask(db, taskId),
        review: assignment.ok ? assignment.review : null,
        routing: assignment.ok ? assignment.routing : null,
        auto_completed: !!(assignment.ok && assignment.auto_completed),
        review_error: assignment.ok ? null : assignment.reason,
      };
    });
  }

  // 收尾（complete / cancel）与审计同事务：审计写不进去，状态就不许变。
  return grantTransaction(db, function () {
    db.prepare("UPDATE tasks SET status=?, version=version+1, updated_at=?, lease_until=CASE WHEN ?='in_progress' THEN lease_until ELSE NULL END WHERE id=?")
      .run(status, nowIso(), status, taskId);
    if (status === 'done') writeAudit(db, authContext, 'task.complete', { task: taskId }, 'ok');
    else if (status === 'cancelled') writeAudit(db, authContext, 'task.cancel', { task: taskId }, 'ok');
    send(db, { sender: agent, to: 'thread:' + taskId, thread: taskId, kind: 'task.' + status, body: note || (taskId + ' -> ' + status), refs: { task: taskId } });
    return { ok: true, task: getTask(db, taskId) };
  });
}

// ---------- 唯一的重试入口 ----------
// 只有 failed / 评审退回（review）能进入下一轮；状态、计数、lease/owner 清理、版本推进在一次
// CAS UPDATE 里完成，Supervisor 不能自己拼状态迁移来重试（updateTask 根本不接受迁到 open）。
const RETRY_SOURCES = ['failed', 'review'];

export function retryTask(db, agent, taskId, note, expectVersion) {
  if (!getRuntimeState(db).enabled) return runtimeDisabled();
  const t = getTask(db, taskId);
  if (!t) return { ok: false, reason: 'not_found', message: '没有这个任务: ' + taskId };
  const who = agent || 'unknown';
  const policy = policyOrDefault();
  const fallbackLimit = roundLimitOf(policy);
  const limit = Number.isSafeInteger(t.retry_limit) && t.retry_limit > 0 ? t.retry_limit : fallbackLimit;
  if (Number.isSafeInteger(expectVersion) && expectVersion !== t.version) {
    return { ok: false, reason: 'version_mismatch', message: '任务已被他人修改，当前 version=' + t.version };
  }
  if (RETRY_SOURCES.indexOf(t.status) < 0) {
    return { ok: false, reason: 'not_retryable', message: '只有 failed 或评审退回（review）的任务可以进入下一轮，当前是 ' + t.status };
  }
  if (Number(t.round_count || 0) >= limit) {
    const escalation = escalateWithEvent(db, policy, taskId, 'retry_exceeded',
      '任务 ' + taskId + ' 已用满 ' + Number(t.round_count || 0) + '/' + limit + ' 轮，不再启动下一轮');
    return { ok: false, reason: 'retry_exceeded', message: '已达到重试上限 ' + Number(t.round_count || 0) + '/' + limit, escalation_created: escalation.created };
  }

  // 一次 CAS：状态回 open、轮次 +1、清 owner/lease/失败原因、推进版本；上限同时由 WHERE 兜住。
  const r = db.prepare(
    "UPDATE tasks SET status='open', owner=NULL, lease_until=NULL, decline_reason=NULL, round_count=round_count+1, version=version+1, updated_at=? " +
    "WHERE id=? AND version=? AND status IN ('failed','review') AND round_count < COALESCE(retry_limit, ?)"
  ).run(nowIso(), taskId, Number.isSafeInteger(expectVersion) ? expectVersion : t.version, fallbackLimit);
  if (Number(r.changes) !== 1) {
    const cur = getTask(db, taskId);
    if (!cur) return { ok: false, reason: 'not_found', message: '没有这个任务: ' + taskId };
    if (RETRY_SOURCES.indexOf(cur.status) < 0) {
      return { ok: false, reason: 'not_retryable', message: '并发变更后状态是 ' + cur.status + '，不能重试' };
    }
    if (Number(cur.round_count || 0) >= limit) {
      const escalation = escalateWithEvent(db, policy, taskId, 'retry_exceeded', '任务 ' + taskId + ' 并发重试时已达上限 ' + limit + ' 轮');
      return { ok: false, reason: 'retry_exceeded', message: '已达到重试上限 ' + limit, escalation_created: escalation.created };
    }
    return { ok: false, reason: 'race_lost', message: '并发重试没有抢到，当前 version=' + cur.version + '，状态=' + cur.status };
  }

  const task = getTask(db, taskId);
  send(db, {
    policy: policy, sender: who, to: task.target || 'thread:' + taskId, thread: taskId, kind: 'task.retry',
    body: (note || '进入下一轮') + '（第 ' + task.round_count + '/' + limit + ' 轮）',
    refs: { task: taskId, round: task.round_count, retry_limit: limit },
  });
  return { ok: true, task: task, round: task.round_count, retry_limit: limit };
}

// ---------- 评审指派与 verdict（第 9 项） ----------
const REVIEW_LEASE_MIN = 30;
const REVIEW_OPEN = "('pending','active')";

function parseGuardJson(value) {
  if (value == null || value === '') return null;
  if (typeof value === 'object') return value;
  try { const parsed = JSON.parse(String(value)); return parsed && typeof parsed === 'object' ? parsed : null; } catch (error) { return null; }
}

function latestVerification(db, taskId) {
  try {
    return db.prepare('SELECT run_id,verify_id,verify_spec_hash,exit_code,ok,started_at,finished_at FROM verification_runs WHERE task_id = ? ORDER BY started_at DESC LIMIT 1').get(taskId) || null;
  } catch (error) { return null; }
}

// Peer reviewer（第 8 项）：pool = policy agents ∩ project agents ∩ online − owner − lead。
// 项目资格由 project-registry（只读、无 store 依赖）解析；项目未登记/没声明 agent/没人在线一律不补人。
function peerCandidateReport(db, policy, task) {
  let online = [];
  try {
    online = listAgents(db).filter(function (a) { return a.status && a.status !== 'offline'; }).map(function (a) { return a.agent_id; });
  } catch (error) { online = []; }
  const registry = ProjectRegistry.readRegistry(mergeRegistryFile({}));
  return ProjectRegistry.eligibleAgents({ policy: policy, registry: registry, task: task, online: online });
}

function onlinePeerCandidates(db, policy, task) {
  const candidates = peerCandidateReport(db, policy, task).eligible.slice();
  return candidates.sort(function (a, b) {
    const ca = Number(db.prepare("SELECT COUNT(*) AS c FROM reviews WHERE reviewer = ? AND status = 'active'").get(a).c) || 0;
    const cb = Number(db.prepare("SELECT COUNT(*) AS c FROM reviews WHERE reviewer = ? AND status = 'active'").get(b).c) || 0;
    return ca - cb || String(a).localeCompare(String(b));
  });
}

export function getReview(db, reviewId) {
  return db.prepare('SELECT * FROM reviews WHERE id = ?').get(reviewId) || null;
}

// 内部版本：调用方必须已经在写事务里（updateTask 的 review 迁移用它保证"同一事务"）。
function assignReviewLocked(db, policy, taskId, options) {
  const o = options || {};
  const task = getTask(db, taskId);
  if (!task) return { ok: false, reason: 'not_found', message: '没有这个任务: ' + taskId };
  const existing = db.prepare('SELECT * FROM reviews WHERE task_id = ? AND status IN ' + REVIEW_OPEN + ' ORDER BY created_at DESC LIMIT 1').get(taskId);
  if (existing && Number(existing.task_version) === Number(task.version)) return { ok: true, review: existing, existing: true };
  if (existing) db.prepare("UPDATE reviews SET status='superseded', updated_at=? WHERE id=? AND status IN ('pending','active')").run(nowIso(), existing.id);

  const guard = o.guard === undefined ? parseGuardJson(task.guard) : parseGuardJson(o.guard);
  const verification = o.verification === undefined ? latestVerification(db, taskId) : o.verification;
  const routing = routeFor(task, guard, verification, policy);
  let reviewer = null;
  if (routing.route === 'auto') reviewer = 'auto';
  else if (routing.route === 'lead') reviewer = (policy && policy.lead) || null;
  else if (routing.route === 'human') reviewer = 'human';
  else reviewer = onlinePeerCandidates(db, policy, task)[0] || null;

  // peer 路由但没有合格候选：保持 pending，一次性升级给 Human（UNIQUE(task_id,kind) 保证只升一次），绝不从全局池补人。
  let unassigned = null;
  if (routing.route === 'peer' && !reviewer) {
    const report = peerCandidateReport(db, policy, task);
    unassigned = { reason: report.reason, detail: report.detail || null, project: report.project || null, excluded: report.excluded || [] };
    escalateWithEvent(db, policy, taskId, 'review_unassigned',
      '任务 ' + taskId + ' 需要 Peer 评审但没有合格候选（' + (report.reason || 'unknown') + '）：' + (report.detail || '') + '；已保留 pending，等人处理');
  }
  const id = 'rv-' + newId();
  const ts = nowIso();
  db.prepare('INSERT INTO reviews(id,task_id,reviewer,route,status,task_version,verdict,summary,lease_until,created_at,updated_at) VALUES(?,?,?,?,?,?,NULL,NULL,NULL,?,?)')
    .run(id, taskId, reviewer, routing.route, 'pending', task.version, ts, ts);

  if (!reviewer) {
    // 无人可评：保留 pending，只给 Lead/Human 发一次 review_unassigned
    const escalation = escalate(db, taskId, 'review_unassigned');
    if (escalation.created) {
      const lead = (policy && policy.lead) || null;
      send(db, { policy: policy, sender: 'system', to: lead && lead !== 'human' ? lead : 'human', thread: taskId, kind: 'review_unassigned',
        body: '任务 ' + taskId + ' 进入评审，但没有可用的 Peer reviewer，请 Lead/Human 处理', refs: { task: taskId, route: routing.route } });
    }
  } else if (routing.route !== 'auto') {
    send(db, { policy: policy, sender: 'system', to: reviewer, thread: taskId, kind: 'task.review',
      body: '任务 ' + taskId + ' 待评审（route=' + routing.route + '，' + routing.reason + '）',
      refs: { task: taskId, route: routing.route, review: id } });
  }

  if (routing.route === 'auto') {
    // Auto 只在 guard 干净 + 固化验证器成功时直接完成，且与指派在同一事务里
    db.prepare("UPDATE reviews SET status='completed', verdict='approved', summary=?, updated_at=? WHERE id=?").run('auto: ' + routing.reason, nowIso(), id);
    const done = db.prepare("UPDATE tasks SET status='done', version=version+1, updated_at=?, lease_until=NULL WHERE id=? AND version=?").run(nowIso(), taskId, task.version);
    if (Number(done.changes) !== 1) return { ok: false, reason: 'race_lost', message: '自动验收时任务已被他人修改' };
    logGuardEvent(db, { task_id: taskId, agent: task.owner, kind: 'review', detail: 'auto approved: ' + routing.reason, action: 'auto_approved', actor: 'auto' });
    send(db, { policy: policy, sender: 'auto', to: task.target || 'thread:' + taskId, thread: taskId, kind: 'task.done',
      body: '自动验收通过：' + routing.reason, refs: { task: taskId, review: id, route: 'auto' } });
    return { ok: true, review: getReview(db, id), routing: routing, auto_completed: true, task: getTask(db, taskId) };
  }
  return { ok: true, review: getReview(db, id), routing: routing, auto_completed: false, unassigned: !reviewer };
}

export function createReviewAssignment(db, policy, taskId, options) {
  return grantTransaction(db, function () { return assignReviewLocked(db, policy, taskId, options); });
}

export function claimReview(db, reviewer, reviewId, expectVersion) {
  const policy = policyOrDefault();
  return grantTransaction(db, function () {
    const review = getReview(db, reviewId);
    if (!review) return { ok: false, reason: 'not_found', message: '没有这个评审: ' + reviewId };
    const who = reviewer || '';
    const task = getTask(db, review.task_id);
    if (!task) return { ok: false, reason: 'not_found', message: '任务不存在: ' + review.task_id };
    if (Number.isSafeInteger(expectVersion) && Number(expectVersion) !== Number(review.task_version)) {
      return { ok: false, reason: 'version_mismatch', message: '这条评审对应任务 version ' + review.task_version + '，不是 ' + expectVersion };
    }
    if (Number(task.version) !== Number(review.task_version)) {
      return { ok: false, reason: 'stale_review', message: '任务已推进到 version ' + task.version + '，这条评审已过期' };
    }
    if (review.route === 'auto') return { ok: false, reason: 'auto_route', message: '自动验收不需要认领' };
    if (review.route === 'human') return { ok: false, reason: 'human_route', message: '人工验收只在看板进行，不能认领' };
    if (review.route === 'lead' && who !== ((policy && policy.lead) || '')) {
      return { ok: false, reason: 'not_reviewer', message: '这条评审只允许 Lead 处理' };
    }
    if (task.owner === who) return { ok: false, reason: 'self_review', message: 'owner 不能评审自己的任务' };
    if (review.reviewer && review.reviewer !== who) return { ok: false, reason: 'not_reviewer', message: '这条评审指派给了 ' + review.reviewer };
    if (review.status === 'active') return { ok: false, reason: 'already_claimed', message: '这条评审已被 ' + (review.reviewer || '他人') + ' 认领' };
    if (review.status !== 'pending') return { ok: false, reason: 'not_pending', message: '评审当前状态是 ' + review.status };
    const lease = plusMinutes(REVIEW_LEASE_MIN);
    const updated = db.prepare("UPDATE reviews SET status='active', reviewer=?, lease_until=?, updated_at=? WHERE id=? AND status='pending'").run(who, lease, nowIso(), reviewId);
    if (Number(updated.changes) !== 1) return { ok: false, reason: 'race_lost', message: '评审被抢先认领' };
    send(db, { policy: policy, sender: who, to: 'thread:' + review.task_id, thread: review.task_id, kind: 'review.claim',
      body: who + ' 认领了评审（任务 v' + review.task_version + '）', refs: { task: review.task_id, review: reviewId } });
    return { ok: true, review: getReview(db, reviewId) };
  });
}

export function submitReview(db, reviewer, reviewId, payload) {
  const p = payload || {};
  const policy = policyOrDefault();
  return grantTransaction(db, function () {
    const review = getReview(db, reviewId);
    if (!review) return { ok: false, reason: 'not_found', message: '没有这个评审: ' + reviewId };
    const who = reviewer || '';
    const verdict = String(p.verdict || '');
    if (['approved', 'changes_requested'].indexOf(verdict) < 0) return { ok: false, reason: 'invalid_verdict', message: 'verdict 只能是 approved 或 changes_requested' };
    const task = getTask(db, review.task_id);
    if (!task) return { ok: false, reason: 'not_found', message: '任务不存在: ' + review.task_id };
    const version = Number.isSafeInteger(p.version) ? p.version : (Number.isSafeInteger(p.taskVersion) ? p.taskVersion : null);
    if (review.verdict) return { ok: false, reason: 'already_submitted', message: '这条评审已经给出过 verdict: ' + review.verdict };
    if (task.owner === who) return { ok: false, reason: 'self_review', message: 'owner 不能评审自己的任务' };
    if (version != null && version !== Number(review.task_version)) {
      return { ok: false, reason: 'version_mismatch', message: '这条评审对应任务 version ' + review.task_version + '，不是 ' + version };
    }
    if (Number(task.version) !== Number(review.task_version)) {
      return { ok: false, reason: 'stale_review', message: '任务已推进到 version ' + task.version + '，这条评审已过期' };
    }
    if (review.route === 'human' && who !== 'human') return { ok: false, reason: 'not_reviewer', message: '人工评审只能由 human 提交' };
    if (review.route === 'lead' && who !== ((policy && policy.lead) || '')) return { ok: false, reason: 'not_reviewer', message: '这条评审只允许 Lead 提交' };
    if (review.route === 'peer') {
      if (review.status !== 'active') return { ok: false, reason: 'not_claimed', message: 'Peer 评审需要先 claimReview 再提交' };
      if (review.reviewer !== who) return { ok: false, reason: 'not_reviewer', message: '这条评审由 ' + review.reviewer + ' 认领' };
      if (review.lease_until && Date.parse(review.lease_until) <= Date.now()) return { ok: false, reason: 'lease_expired', message: '评审租约已过期，请重新认领' };
    }

    if (verdict === 'approved') {
      if (Number(task.needs_human) === 1 && who !== 'human') {
        return { ok: false, reason: 'needs_human', message: '这张卡被守卫标记为需人工确认，只有 human 能批准' };
      }
      if (task.status !== 'review') return { ok: false, reason: 'not_in_review', message: '任务当前状态是 ' + task.status + '，不在评审中' };
      db.prepare("UPDATE reviews SET status='completed', verdict='approved', summary=?, lease_until=NULL, updated_at=? WHERE id=?").run(p.summary || null, nowIso(), reviewId);
      const updated = db.prepare("UPDATE tasks SET status='done', version=version+1, updated_at=?, lease_until=NULL WHERE id=? AND version=? AND status='review'")
        .run(nowIso(), review.task_id, review.task_version);
      if (Number(updated.changes) !== 1) return { ok: false, reason: 'race_lost', message: '任务版本已变化，verdict 未生效' };
      logGuardEvent(db, { task_id: review.task_id, agent: who, kind: 'review', detail: (p.summary || 'approved'), action: 'approved', actor: who });
      send(db, { policy: policy, sender: who, to: task.target || 'thread:' + review.task_id, thread: review.task_id, kind: 'task.done',
        body: '评审通过：' + (p.summary || 'approved'), refs: { task: review.task_id, review: reviewId, route: review.route } });
      return { ok: true, verdict: verdict, review: getReview(db, reviewId), task: getTask(db, review.task_id) };
    }

    // changes_requested：必须走第 7 项的唯一重试入口
    db.prepare("UPDATE reviews SET status='changes_requested', verdict='changes_requested', summary=?, lease_until=NULL, updated_at=? WHERE id=?").run(p.summary || null, nowIso(), reviewId);
    const retried = retryTask(db, who, review.task_id, p.summary || '评审要求修改', review.task_version);
    return {
      ok: true, verdict: verdict, review: getReview(db, reviewId), retried: retried.ok === true,
      retry_reason: retried.ok ? null : retried.reason, task: getTask(db, review.task_id),
    };
  });
}

export function listReviews(db, filter) {
  const f = filter || {};
  const where = [];
  const args = [];
  if (f.task_id) { where.push('r.task_id = ?'); args.push(f.task_id); }
  if (f.reviewer) { where.push('r.reviewer = ?'); args.push(f.reviewer); }
  if (f.status) { where.push('r.status = ?'); args.push(f.status); }
  if (f.route) { where.push('r.route = ?'); args.push(f.route); }
  if (f.project) { where.push('t.project = ?'); args.push(f.project); }
  if (f.open) where.push("r.status IN ('pending','active')");
  const limit = Number.isSafeInteger(f.limit) && f.limit > 0 ? Math.min(f.limit, 200) : 100;
  const sql = 'SELECT r.*, t.title AS task_title, t.status AS task_status, t.project AS project, t.owner AS task_owner ' +
    'FROM reviews r LEFT JOIN tasks t ON t.id = r.task_id' +
    (where.length ? ' WHERE ' + where.join(' AND ') : '') +
    ' ORDER BY r.created_at DESC, r.id DESC LIMIT ' + limit;
  return db.prepare(sql).all(...args);
}

// done 的硬门：已认领的评审没 verdict、或本轮被判 changest_requested，都不许收尾。
function reviewGate(db, taskId) {
  const task = getTask(db, taskId);
  if (!task) return null;
  const active = db.prepare("SELECT * FROM reviews WHERE task_id = ? AND status = 'active'").get(taskId);
  if (active) {
    return { ok: false, reason: 'review_pending', message: '评审 ' + active.id + ' 已被 ' + (active.reviewer || '他人') + ' 认领但还没有 verdict，不能直接判 done' };
  }
  const changes = db.prepare("SELECT * FROM reviews WHERE task_id = ? AND verdict = 'changes_requested' AND task_version = ? LIMIT 1").get(taskId, task.version);
  if (changes) {
    return { ok: false, reason: 'review_changes_requested', message: '评审要求修改，请用 retryTask 进入下一轮' };
  }
  return null;
}

// ---------- 守卫记录与升级 ----------
export function logGuardEvent(db, e) {
  db.prepare('INSERT INTO guard_events(task_id,agent,kind,detail,action,actor,ts) VALUES(?,?,?,?,?,?,?)')
    .run(e.task_id || null, e.agent || null, e.kind || null, e.detail || null, e.action || null, e.actor || null, e.ts || nowIso());
  return { ok: true };
}

// 只写守卫三列 + updated_at，不碰 status/version：守卫不改任务状态机
export function setGuard(db, taskId, g) {
  const t = getTask(db, taskId);
  if (!t) return { ok: false, reason: 'not_found', message: '没有这个任务: ' + taskId };
  const patch = g || {};
  let guard = t.guard == null ? null : t.guard;
  if (Object.prototype.hasOwnProperty.call(patch, 'guard')) {
    guard = patch.guard == null ? null : (typeof patch.guard === 'string' ? patch.guard : JSON.stringify(patch.guard));
  }
  let changed = t.changed_files == null ? null : Number(t.changed_files);
  if (Object.prototype.hasOwnProperty.call(patch, 'changed_files')) {
    const n = Number(patch.changed_files);
    changed = Number.isFinite(n) ? n : null;
  }
  let needs = Number(t.needs_human) === 1 ? 1 : 0;
  if (Object.prototype.hasOwnProperty.call(patch, 'needs_human')) needs = patch.needs_human ? 1 : 0;
  db.prepare('UPDATE tasks SET guard=?, changed_files=?, needs_human=?, updated_at=? WHERE id=?')
    .run(guard, changed, needs, nowIso(), taskId);
  return { ok: true, task: getTask(db, taskId) };
}

// review 长期没人收尾就升级提醒一次（escalated_at 保证幂等）
export function sweepReviews(db, policy) {
  const cfg = (policy && policy.economics) || {};
  const raw = cfg.review_timeout_min == null ? 30 : Number(cfg.review_timeout_min);
  const minutes = Number.isFinite(raw) ? raw : 30;
  const lead = (policy && policy.lead) || null;
  const cutoff = new Date(Date.now() - minutes * 60000).toISOString();
  const rows = db.prepare(
    "SELECT id, owner, title FROM tasks WHERE status = 'review' AND escalated_at IS NULL AND updated_at < ?"
  ).all(cutoff);
  const escalated = [];
  for (const r of rows) {
    db.prepare('UPDATE tasks SET escalated_at=? WHERE id=?').run(nowIso(), r.id);
    // 只升级"当前这一条"评审指派；绝不新建评审（重启扫描也不会重复）
    const current = db.prepare("SELECT * FROM reviews WHERE task_id = ? AND status IN ('pending','active') ORDER BY created_at DESC LIMIT 1").get(r.id);
    if (current) db.prepare("UPDATE reviews SET status='escalated', updated_at=? WHERE id=? AND status IN ('pending','active')").run(nowIso(), current.id);
    const detail = 'review 停了超过 ' + minutes + ' 分钟无人验收';
    logGuardEvent(db, { task_id: r.id, agent: r.owner, kind: 'review_timeout', detail: detail, action: 'escalated', actor: 'system' });
    const body = '任务 ' + r.id + ' 需要验收：' + detail + (r.title ? '（' + r.title + '）' : '');
    send(db, { sender: 'system', to: 'human', thread: r.id, kind: 'task.escalated', body: body, refs: { task: r.id } });
    if (lead && lead !== 'human') {
      send(db, { sender: 'system', to: lead, thread: r.id, kind: 'task.escalated', body: body, refs: { task: r.id } });
    }
    escalated.push(r.id);
  }
  return { ok: true, escalated: escalated, count: escalated.length };
}

// 人类把误判的 failed 拉回 review；没传 accepters 就当没权限
export function overrideTask(db, agent, taskId, note, accepters, authContext) {
  const ctx = authContext || { actor: agent === 'human' ? 'human' : 'unknown', auth_method: 'unknown', remote_addr: null };
  return auditMutation(db, ctx, 'task.override', { task: taskId }, function () { return overrideEnabled(db, agent, taskId, note, accepters); });
}

function overrideEnabled(db, agent, taskId, note, accepters) {
  const who = agent || '';
  const t = getTask(db, taskId);
  if (!t) return { ok: false, reason: 'not_found', message: '没有这个任务: ' + taskId };
  if (who !== 'human' || (accepters || []).indexOf('human') < 0) {
    return { ok: false, reason: 'not_permitted', message: '只有具备验收权的人类可以覆盖验收结论' };
  }
  if (t.status !== 'failed') return { ok: false, reason: 'bad_transition', message: '只有 failed 的任务可以覆盖回 review，当前是 ' + t.status };
  const r = db.prepare("UPDATE tasks SET status='review', version=version+1, updated_at=? WHERE id=? AND version=?")
    .run(nowIso(), taskId, t.version);
  if (Number(r.changes) !== 1) return { ok: false, reason: 'race_lost', message: '任务已被他人修改，请刷新后重试' };
  logGuardEvent(db, { task_id: taskId, agent: t.owner, kind: 'override', detail: note || '人类覆盖验收结论', action: 'override', actor: who });
  send(db, { sender: who, to: 'thread:' + taskId, thread: taskId, kind: 'task.review',
    body: note || ('人类把 ' + taskId + ' 拉回 review'), refs: { task: taskId, override: true } });
  return { ok: true, task: getTask(db, taskId) };
}

export function accept(db, agent, taskId, accepters, authContext) {
  if (!getRuntimeState(db).enabled) return runtimeDisabled();
  const ctx = authContext || { actor: 'unknown', auth_method: 'unknown', remote_addr: null };
  try {
    return auditMutation(db, ctx, 'task.accept', { task: taskId }, function () { return acceptEnabled(db, agent, taskId, accepters); });
  } catch (e) {
    if (e && e.message === 'agentbus_disabled') return runtimeDisabled();
    throw e;
  }
}

function acceptEnabled(db, agent, taskId, accepters) {
  const t = getTask(db, taskId);
  if (!t) return { ok: false, reason: 'not_found', message: '没有这个任务: ' + taskId };
  if ((accepters || []).indexOf(agent) < 0) return { ok: false, reason: 'not_permitted', message: agent + ' 没有验收/批准权（permissions.accept）' };
  // 红线权限只能由人类批准：派活方和 Lead 都不能替人点头
  const kinds = parseArray(t.redline);
  const dirs = parseArray(t.extra_dirs);
  if (agent !== 'human' && (kinds.length || dirs.length)) {
    const what = kinds.length ? '红线 ' + kinds.join(', ') : '越界目录 ' + dirs.join(', ');
    return { ok: false, reason: 'redline_human_only', message: '这张任务带' + what + '，只能由人类在控制台上批准' };
  }
  if (t.status !== 'proposed') return { ok: false, reason: 'not_proposed', message: '当前状态是 ' + t.status };
  // 人类批准 = 把红线授权真正落到 grants 上；否则"批了也白批"，事后审计会把本次执行判成违规
  const granted = mergeKinds(parseArray(t.grants), kinds);
  db.prepare("UPDATE tasks SET status='open', grants=?, version=version+1, updated_at=? WHERE id=?")
    .run(jsonArray(granted), nowIso(), taskId);
  send(db, { sender: agent, to: 'broadcast', thread: taskId, kind: 'task.new', body: '任务已批准: ' + t.title, refs: { task: taskId } });
  return { ok: true, task: getTask(db, taskId) };
}

export function decline(db, agent, taskId, reason, accepters, authContext) {
  const ctx = authContext || { actor: 'unknown', auth_method: 'unknown', remote_addr: null };
  return auditMutation(db, ctx, 'task.decline', { task: taskId }, function () { return declineEnabled(db, agent, taskId, reason, accepters); });
}

function declineEnabled(db, agent, taskId, reason, accepters) {
  const t = getTask(db, taskId);
  if (!t) return { ok: false, reason: 'not_found', message: '没有这个任务: ' + taskId };
  const canVeto = (accepters || []).indexOf(agent) >= 0;
  if (t.target !== agent && t.owner !== agent && !canVeto) {
    return { ok: false, reason: 'not_yours', message: '这不是派给你的任务（target=' + (t.target || 'none') + ', owner=' + (t.owner || 'none') + '）' };
  }
  if (t.status === 'done' || t.status === 'cancelled') return { ok: false, reason: 'terminal', message: '任务已结束: ' + t.status };
  db.prepare("UPDATE tasks SET status='declined', decline_reason=?, version=version+1, updated_at=? WHERE id=?")
    .run(reason || '无理由', nowIso(), taskId);
  send(db, { sender: agent, to: 'thread:' + taskId, thread: taskId, kind: 'task.declined', body: reason || '拒绝', refs: { task: taskId } });
  return { ok: true, task: getTask(db, taskId) };
}

// ---------- 租约 ----------
export function renewLease(db, agent, taskId, leaseMin) {
  return grantTransaction(db, function () {
    const now = nowIso();
    const expiry = plusMinutes(leaseMin || 15);
    const grant = getExecutionGrant(db, taskId, agent);
    const r = db.prepare("UPDATE tasks SET lease_until=? WHERE id=? AND owner=? AND status IN ('claimed','in_progress') AND lease_until>?")
      .run(expiry, taskId, agent, now);
    if (Number(r.changes) !== 1) return false;
    if (grant) db.prepare('UPDATE execution_grants SET expires_at=? WHERE grant_id=? AND revoked_at IS NULL').run(expiry, grant.grant_id);
    return true;
  });
}

let lastReap = 0;
export function reapLeases(db, force) {
  if (!force && Date.now() - lastReap < 30000) return 0;
  lastReap = Date.now();
  const now = nowIso();
  const rows = db.prepare(
    "SELECT id, owner FROM tasks WHERE status IN ('claimed','in_progress') AND lease_until IS NOT NULL AND lease_until < ?"
  ).all(now);
  for (const r of rows) {
    const recovered = db.prepare("UPDATE tasks SET status='open', owner=NULL, lease_until=NULL, version=version+1, updated_at=? WHERE id=? AND owner=? AND status IN ('claimed','in_progress') AND lease_until < ?").run(now, r.id, r.owner, now);
    if (Number(recovered.changes) !== 1) continue;
    send(db, { sender: 'system', to: 'broadcast', thread: r.id, kind: 'task.progress',
      body: '租约过期回收 ' + r.id + '（原 owner ' + (r.owner || '?') + '），已退回 open', refs: { task: r.id, reaped: true } });
  }
  return rows.length;
}

// ---------- dispatch（五道守卫） ----------
export function dispatch(db, policy, from, d) {
  if (!getRuntimeState(db).enabled) return runtimeDisabled();
  try { return dispatchEnabled(db, policy, from, d); } catch (e) {
    if (e && e.message === 'agentbus_disabled') return runtimeDisabled();
    throw e;
  }
}

function dispatchEnabled(db, policy, from, d) {
  const g = policy.global || {};
  const to = d.to;
  if (!to) return { ok: false, reason: 'no_target', message: '必须指定收件 agent' };
  // 未知 agent 一律拒绝：以前查不到配置就等于"没有 scope_allowlist、没有速率上限"。
  if (from !== 'human' && !Object.prototype.hasOwnProperty.call(policy.agents || {}, from)) {
    return { ok: false, reason: 'unknown_agent', message: from + ' 不在策略的 agents 列表中，不能派活（未知身份不得绕过 scope_allowlist 与 rate_per_agent_per_hour）' };
  }
  const toCfg = agentCfg(policy, to);
  const fromCfg = agentCfg(policy, from);

  const dispatchers = policy.permissions.dispatch || [];
  const allowedByDispatcher = dispatchers.indexOf(from) >= 0;
  const allowedByAgent = (fromCfg.may_dispatch_to || []).indexOf(to) >= 0 || (fromCfg.may_dispatch_to || []).indexOf('*') >= 0;
  if (!allowedByDispatcher && !allowedByAgent) {
    return { ok: false, reason: 'guard_G1_unauthorized', message: from + ' 无权向 ' + to + ' 派活（既不在 permissions.dispatch，也不在 ' + from + '.may_dispatch_to）' };
  }

  const frozen = freezeTaskVerifier(d, from);
  if (!frozen.ok) return frozen;
  const verification = frozen.legacy ? null : verifyCommandRequired(policy, d);
  if (verification) return verification;
  // 每小时派发率：近一小时内该 agent 创建的任务数（human 不在 agents 表里，不限额）
  const rateCap = Number.isSafeInteger(g.rate_per_agent_per_hour) && g.rate_per_agent_per_hour > 0 ? g.rate_per_agent_per_hour : 20;
  if (Object.prototype.hasOwnProperty.call(policy.agents || {}, from)) {
    const since = new Date(Date.now() - 3600000).toISOString();
    const recent = Number(db.prepare('SELECT COUNT(*) AS c FROM tasks WHERE dispatched_by = ? AND created_at > ?').get(from, since).c);
    if (recent >= rateCap) {
      return { ok: false, reason: 'rate_limited', message: from + ' 近一小时已创建 ' + recent + ' 个任务，达到上限 ' + rateCap };
    }
  }

  // 子代理总限额：任务声明的数量不能超过 economics.max_subagents
  const eco = policy.economics || {};
  const subagentCap = Number.isSafeInteger(eco.max_subagents) ? eco.max_subagents : 0;
  const declaredSubagents = Number.isSafeInteger(Number(d.max_subagents)) ? Number(d.max_subagents) : 0;
  if (declaredSubagents > subagentCap) {
    return { ok: false, reason: 'max_subagents_exceeded', message: 'max_subagents=' + declaredSubagents + ' 超过策略上限 ' + subagentCap };
  }

  // scope_allowlist：配置后每个 write_scope 必须至少匹配一项
  const notAllowed = scopeAllowlistViolations(policy, from, d.write_scope);
  if (notAllowed) {
    return { ok: false, reason: 'scope_not_allowed', message: from + ' 的 scope_allowlist 不允许: ' + notAllowed.join(', ') };
  }

  const depth = (d.depth || 0) + 1;
  const maxDepth = g.max_dispatch_depth == null ? 2 : g.max_dispatch_depth;
  if (depth > maxDepth) {
    return { ok: false, reason: 'guard_G3_depth', message: '派活深度 ' + depth + ' 超过上限 ' + maxDepth + '，请改为发送请求类消息' };
  }

  // 红线识别：命令 / 路径 / 显式 grants 任一命中都必须人类批准，派活方不能自授。
  const kinds = mergeKinds(
    classifyText([d.title, d.body, d.verify_cmd].filter(function (x) { return !!x; }).join('\n')),
    classifyPaths(d.write_scope),
    d.grants
  );
  const grants = d.grants || [];
  const redlineExtra = !!(d.extra_dirs && d.extra_dirs.length) || !!(d.network_grants && d.network_grants.length) || d.redline === true;

  const enabled = g.dispatch_enabled !== false;
  const autonomy = toCfg.autonomy || 'off';
  const budget = budgetAdmission(db, policy, { agent: to, costClass: d.cost_class, tokenBudget: d.token_budget });
  const reasons = [];
  let status = 'open';
  if (d.status === 'proposed' || kinds.length || redlineExtra || frozen.legacy) {
    status = 'proposed';
    if (!kinds.length) reasons.push('redline(需要人类批准: ' + (d.extra_dirs || []).join(', ') + ')');
  } else if (!enabled) { status = 'proposed'; reasons.push('dispatch_enabled=false'); }
  else if (autonomy === 'off' || autonomy === 'propose') { status = 'proposed'; reasons.push('autonomy=' + autonomy); }
  else if (!budget.ok) { status = 'proposed'; reasons.push('budget_exceeded'); }
  else {
    const cap = toCfg.max_open_from_agents == null ? 0 : toCfg.max_open_from_agents;
    const active = Number(db.prepare(
      "SELECT COUNT(*) AS c FROM tasks WHERE target = ? AND origin LIKE 'agent:%' AND status IN ('open','claimed','in_progress','review')"
    ).get(to).c);
    if (active >= cap) { status = 'proposed'; reasons.push('quota(' + active + '/' + cap + ')'); }
  }

  const task = createTask(db, {
    title: d.title, body: d.body, project: d.project, status: status,
    origin: 'agent:' + from, dispatched_by: from, target: to, depth: depth,
    cost_class: d.cost_class, write_scope: d.write_scope, max_subagents: d.max_subagents,
    verify_cmd: d.verify_cmd, ...frozen.fields, extra_dirs: d.extra_dirs, network_grants: d.network_grants, redline: kinds, grants: grants,
    retry_limit: roundLimitOf(policy), parent_task_id: d.parent_task_id || null,
    token_budget: Number.isSafeInteger(d.token_budget) && d.token_budget > 0 ? d.token_budget : null,
  });
  send(db, { policy: policy, sender: from, to: to, thread: task.id, kind: 'task.new', body: d.title, refs: { task: task.id, project: task.project }, hop: 1 });
  const gatedBy = kinds.length ? 'redline:' + kinds.join(',') : (reasons.join('+') || null);
  // budget 准入也会把任务降级为 proposed，原因写在 gated_by 里（真正的硬门在 supervisor 唤醒前）
  return { ok: true, task: task, gated: status === 'proposed', gated_by: gatedBy };
}

// ---------- Token 预算与预留（第 8 项） ----------
// 口径：daily_token_budget 按 policy.economics.budget_timezone 的自然日聚合，输入与输出 token 直接相加。
// 预热：reserveTokens 在 BEGIN IMMEDIATE 内同时汇总「当天实际用量」与「未过期未提交 reservation」，
// 因此并发 supervisor 不可能一起看到"还有余额"然后一起超卖。
const RESERVATION_TTL_MS = 30 * 60 * 1000;
const BUDGET_SAMPLE_SIZE = 20;

export function dayKeyOf(when, timeZone) {
  const date = when instanceof Date ? when : new Date(when == null ? Date.now() : when);
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: timeZone || 'UTC', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(date);
  const map = {};
  for (const part of parts) if (part.type !== 'literal') map[part.type] = part.value;
  return map.year + '-' + map.month + '-' + map.day;
}

function zoneOffsetMs(date, timeZone) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: timeZone || 'UTC', hour12: false,
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).formatToParts(date);
  const map = {};
  for (const part of parts) if (part.type !== 'literal') map[part.type] = part.value;
  const asUtc = Date.UTC(Number(map.year), Number(map.month) - 1, Number(map.day), Number(map.hour) % 24, Number(map.minute), Number(map.second));
  return asUtc - date.getTime();
}

function shiftDayKey(dayKey, days) {
  const [y, m, d] = String(dayKey).split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
}

// 某个自然日在指定时区的起止（UTC 毫秒），DST 也按真实边界算。
export function budgetDayBounds(dayKey, timeZone) {
  const tz = timeZone || 'UTC';
  const key = dayKey || dayKeyOf(new Date(), tz);
  function startOf(localKey) {
    const [y, m, d] = String(localKey).split('-').map(Number);
    const guess = Date.UTC(y, m - 1, d, 0, 0, 0);
    let at = guess - zoneOffsetMs(new Date(guess), tz);
    at = guess - zoneOffsetMs(new Date(at), tz);
    return at;
  }
  const start = startOf(key);
  const end = startOf(shiftDayKey(key, 1));
  return { day_key: key, start_ms: start, end_ms: end, start: new Date(start).toISOString(), end: new Date(end).toISOString() };
}

function budgetPolicyOf(policy) {
  const economics = (policy && policy.economics) || {};
  const limit = Number(economics.daily_token_budget);
  const fallback = Number(economics.default_turn_reserve);
  return {
    timezone: typeof economics.budget_timezone === 'string' && economics.budget_timezone ? economics.budget_timezone : 'UTC',
    limit: Number.isSafeInteger(limit) && limit > 0 ? limit : null,
    fallback: Number.isSafeInteger(fallback) && fallback > 0 ? fallback : null,
  };
}

function usageSum(db, startIso, endIso, filter) {
  const f = filter || {};
  const where = ['u.ts >= ?', 'u.ts < ?'];
  const args = [startIso, endIso];
  if (f.agent) { where.push('u.agent = ?'); args.push(f.agent); }
  if (f.project) { where.push("COALESCE(t.project,'') = ?"); args.push(f.project); }
  const sql = 'SELECT COALESCE(SUM(u.tokens_in + u.tokens_out),0) AS t FROM token_usage u LEFT JOIN tasks t ON t.id = u.task_id WHERE ' + where.join(' AND ');
  return Number(db.prepare(sql).get(...args).t) || 0;
}

function reservedSum(db, dayKey, nowText, filter) {
  const f = filter || {};
  const where = ['r.day_key = ?', 'r.committed_at IS NULL', 'r.expires_at > ?'];
  const args = [dayKey, nowText];
  if (f.agent) { where.push('r.agent = ?'); args.push(f.agent); }
  if (f.project) { where.push("COALESCE(t.project,'') = ?"); args.push(f.project); }
  const sql = 'SELECT COALESCE(SUM(r.reserved_tokens),0) AS t FROM token_reservations r LEFT JOIN tasks t ON t.id = r.task_id WHERE ' + where.join(' AND ');
  return Number(db.prepare(sql).get(...args).t) || 0;
}

// 某个自然日的用量：daily 优先，raw 里同 (agent,project,task) 的行不重复计。
// 这是"归档前后数字一致"的关键：归档把 raw 折进 daily 并在同事务删原行，这里再兜一层去重。
function mergedDayUsage(db, dayKey, startIso, endIso, filter) {
  const f = filter || {};
  const daily = db.prepare('SELECT agent, project, task_id, SUM(tokens_in) AS ti, SUM(tokens_out) AS to_ FROM token_usage_daily WHERE day_key = ? GROUP BY agent, project, task_id').all(dayKey);
  const raw = db.prepare(
    "SELECT u.agent AS agent, COALESCE(t.project,'') AS project, COALESCE(u.task_id,'') AS task_id, SUM(u.tokens_in) AS ti, SUM(u.tokens_out) AS to_ " +
    'FROM token_usage u LEFT JOIN tasks t ON t.id = u.task_id WHERE u.ts >= ? AND u.ts < ? GROUP BY 1,2,3'
  ).all(startIso, endIso);
  const cache = new Map();
  function keyOf(row) { return row.agent + '\u0000' + row.project + '\u0000' + row.task_id; }
  for (const row of daily) cache.set(keyOf(row), { agent: row.agent, project: row.project, task_id: row.task_id, in: Number(row.ti) || 0, out: Number(row.to_) || 0 });
  for (const row of raw) {
    const key = keyOf(row);
    if (cache.has(key)) continue;
    cache.set(key, { agent: row.agent, project: row.project, task_id: row.task_id, in: Number(row.ti) || 0, out: Number(row.to_) || 0 });
  }
  return Array.from(cache.values()).filter(function (row) {
    if (f.agent && row.agent !== f.agent) return false;
    if (f.project && row.project !== f.project) return false;
    return true;
  });
}

function taskUsage(db, taskId, nowText) {
  // 归档过的任务，原始行已被折叠进 daily，这里必须两边相加才不会低估已用额度
  const rawUsed = Number(db.prepare('SELECT COALESCE(SUM(tokens_in + tokens_out),0) AS t FROM token_usage WHERE task_id = ?').get(taskId).t) || 0;
  const dailyUsed = Number(db.prepare('SELECT COALESCE(SUM(tokens_in + tokens_out),0) AS t FROM token_usage_daily WHERE task_id = ?').get(taskId).t) || 0;
  const used = rawUsed + dailyUsed;
  const reserved = Number(db.prepare('SELECT COALESCE(SUM(reserved_tokens),0) AS t FROM token_reservations WHERE task_id = ? AND committed_at IS NULL AND expires_at > ?').get(taskId, nowText).t) || 0;
  return { used: used, reserved: reserved };
}

// agent + cost_class + phase 最近 20 次实际用量的 P90；样本不足返回 null（交给 default_turn_reserve）。
function p90TurnEstimate(db, agent, costClass, phase) {
  const targetPhase = phase || 'execute';
  const rows = db.prepare(
    'SELECT u.tokens_in + u.tokens_out AS total FROM token_usage u JOIN tasks t ON t.id = u.task_id ' +
    'WHERE u.agent = ? AND t.cost_class = ? AND COALESCE(u.phase, ?) = ? ORDER BY u.id DESC LIMIT ?'
  ).all(agent, costClass || 'standard', targetPhase, targetPhase, BUDGET_SAMPLE_SIZE);
  const values = rows.map(function (row) { return Number(row.total) || 0; }).filter(function (v) { return v > 0; });
  if (!values.length) return null;
  values.sort(function (a, b) { return a - b; });
  return values[Math.max(0, Math.ceil(values.length * 0.9) - 1)];
}

// 唯一的额度占用入口：返回 reservation_id 后才允许启动模型。
export function reserveTokens(db, policy, options) {
  const o = options || {};
  const conf = budgetPolicyOf(policy);
  const nowDate = o.now ? new Date(o.now) : new Date();
  const nowText = nowDate.toISOString();
  const bounds = budgetDayBounds(dayKeyOf(nowDate, conf.timezone), conf.timezone);
  const task = o.taskId ? getTask(db, o.taskId) : null;
  // 任务预算独立于日预算：日预算为 null 时，任务自己的 token_budget 仍然生效。
  // 调用方也可以在没有任务行时用 o.tokenBudget 传入声明额度（例如创建前的准入判断）。
  const taskBudget = (task && Number.isSafeInteger(task.token_budget) && task.token_budget > 0 ? task.token_budget : null)
    || (Number.isSafeInteger(o.tokenBudget) && o.tokenBudget > 0 ? o.tokenBudget : null);

  // 两者都没有配置时才不占用、不拦截。
  if (conf.limit == null && taskBudget == null) {
    return { ok: true, reservation_id: null, reserved_tokens: 0, day_key: bounds.day_key, reserved: false, limit: null, detail: 'no_budget_limit' };
  }

  const ttlMs = Number.isSafeInteger(o.ttlMs) && o.ttlMs > 0 ? o.ttlMs : RESERVATION_TTL_MS;
  return grantTransaction(db, function () {
    const used = usageSum(db, bounds.start, bounds.end, null);
    const reserved = reservedSum(db, bounds.day_key, nowText, null);
    let wanted;
    if (taskBudget != null) {
      const own = task ? taskUsage(db, task.id, nowText) : { used: 0, reserved: 0 };
      const room = taskBudget - own.used - own.reserved;
      if (room <= 0) {
        return { ok: false, reason: 'budget_exceeded', detail: { scope: 'task', task_id: task ? task.id : (o.taskId || null), task_budget: taskBudget, task_used: own.used, task_reserved: own.reserved } };
      }
      wanted = room;
    } else {
      const estimate = p90TurnEstimate(db, o.agent, o.costClass, o.phase) || conf.fallback;
      if (!estimate) {
        return { ok: false, reason: 'no_budget_config', detail: '没有历史样本，且 policy.economics.default_turn_reserve 未配置或为 0' };
      }
      wanted = estimate;
    }

    let size = wanted;
    let clamped = false;
    if (conf.limit != null) {
      const room = conf.limit - used - reserved;
      if (room <= 0) {
        return { ok: false, reason: 'budget_exceeded', detail: { scope: 'day', day_key: bounds.day_key, limit: conf.limit, used: used, reserved: reserved, requested: wanted } };
      }
      if (size > room) { size = room; clamped = true; }
    }

    const id = 'res-' + newId();
    const expiresAt = new Date(nowDate.getTime() + ttlMs).toISOString();
    db.prepare('INSERT INTO token_reservations(id,agent,task_id,day_key,reserved_tokens,expires_at,committed_at) VALUES(?,?,?,?,?,?,NULL)')
      .run(id, String(o.agent || 'unknown'), o.taskId || null, bounds.day_key, size, expiresAt);
    return {
      ok: true, reservation_id: id, reserved_tokens: size, day_key: bounds.day_key, expires_at: expiresAt,
      limit: conf.limit, used: used, reserved: reserved, clamped: clamped, requested_tokens: wanted,
    };
  });
}

export function commitReservation(db, reservationId, usage) {
  const u = usage || {};
  const actual = (Number(u.tokensIn) || 0) + (Number(u.tokensOut) || 0);
  return grantTransaction(db, function () {
    const row = db.prepare('SELECT * FROM token_reservations WHERE id = ?').get(reservationId);
    if (!row) return { ok: false, reason: 'not_found', overrun: false };
    if (row.committed_at) return { ok: false, reason: 'already_committed', overrun: false, reserved_tokens: Number(row.reserved_tokens) };
    db.prepare('UPDATE token_reservations SET committed_at=? WHERE id=? AND committed_at IS NULL').run(nowIso(), reservationId);
    return { ok: true, overrun: actual > Number(row.reserved_tokens), reserved_tokens: Number(row.reserved_tokens), actual_tokens: actual };
  });
}

// 崩溃遗留的 reservation 按 expires_at 自动释放（只删未提交的）。
export function releaseExpiredReservations(db, when) {
  const text = when == null ? nowIso() : new Date(when).toISOString();
  const r = db.prepare('DELETE FROM token_reservations WHERE committed_at IS NULL AND expires_at <= ?').run(text);
  return { released: Number(r.changes) };
}

function markBudgetOverrun(db, taskId, detail) {
  if (!taskId) return;
  const task = getTask(db, taskId);
  if (!task) return;
  let guard = task.guard;
  if (typeof guard === 'string') { try { guard = JSON.parse(guard); } catch (e) { guard = null; } }
  if (!guard || typeof guard !== 'object') guard = {};
  guard.budget_overrun = { at: nowIso(), reserved: detail.reserved, actual: detail.actual };
  db.prepare('UPDATE tasks SET guard=?, needs_human=1, escalated_at=?, version=version+1, updated_at=? WHERE id=?')
    .run(JSON.stringify(guard), nowIso(), nowIso(), taskId);
  logGuardEvent(db, { task_id: taskId, agent: task.owner || null, kind: 'budget_overrun', detail: JSON.stringify(detail), action: 'escalated', actor: 'system' });
  escalate(db, taskId, 'budget_overrun');
}

export function budgetStatus(db, policy, options) {
  const o = options || {};
  const conf = budgetPolicyOf(policy);
  const nowDate = o.now ? new Date(o.now) : new Date();
  const nowText = nowDate.toISOString();
  const bounds = budgetDayBounds(o.dayKey || dayKeyOf(nowDate, conf.timezone), conf.timezone);
  const filter = { agent: o.agent || null, project: o.project || null };
  const mergedRows = mergedDayUsage(db, bounds.day_key, bounds.start, bounds.end, filter);
  const used = mergedRows.reduce(function (n, row) { return n + row.in + row.out; }, 0);
  const reserved = reservedSum(db, bounds.day_key, nowText, filter);
  const byAgentTotals = new Map();
  for (const row of mergedDayUsage(db, bounds.day_key, bounds.start, bounds.end, null)) {
    byAgentTotals.set(row.agent, (byAgentTotals.get(row.agent) || 0) + row.in + row.out);
  }
  const byAgentUsed = Array.from(byAgentTotals.entries()).map(function (entry) { return { agent: entry[0], used: entry[1] }; });
  const byAgentReserved = db.prepare(
    'SELECT r.agent, COALESCE(SUM(r.reserved_tokens),0) AS reserved FROM token_reservations r WHERE r.day_key = ? AND r.committed_at IS NULL AND r.expires_at > ? GROUP BY r.agent'
  ).all(bounds.day_key, nowText);
  const agents = {};
  for (const row of byAgentUsed) agents[row.agent] = { agent: row.agent, used: Number(row.used) || 0, reserved: 0 };
  for (const row of byAgentReserved) {
    if (!agents[row.agent]) agents[row.agent] = { agent: row.agent, used: 0, reserved: 0 };
    agents[row.agent].reserved = Number(row.reserved) || 0;
  }
  const projectTotals = new Map();
  for (const row of mergedDayUsage(db, bounds.day_key, bounds.start, bounds.end, null)) {
    const name = row.project || '(unassigned)';
    projectTotals.set(name, (projectTotals.get(name) || 0) + row.in + row.out);
  }
  const byProject = Array.from(projectTotals.entries())
    .map(function (entry) { return { project: entry[0], used: entry[1] }; })
    .sort(function (a, b) { return b.used - a.used; });
  return {
    day_key: bounds.day_key, timezone: conf.timezone, start: bounds.start, end: bounds.end,
    limit: conf.limit, used: used, reserved: reserved,
    remaining: conf.limit == null ? null : Math.max(0, conf.limit - used - reserved),
    by_agent: Object.keys(agents).sort().map(function (k) { return agents[k]; }),
    by_project: byProject,
  };
}

// 派发/创建时的准入检查：只判断"现在还有没有余量"，真正硬门在 supervisor 唤醒前。
function budgetAdmission(db, policy, opts) {
  const o = opts || {};
  const conf = budgetPolicyOf(policy);
  const task = o.taskId ? getTask(db, o.taskId) : null;
  // 任务预算独立于日预算：日预算没配（null/非正整数）时，任务自己的额度照样要拦。
  const taskBudget = (task && Number.isSafeInteger(task.token_budget) && task.token_budget > 0 ? task.token_budget : null)
    || (Number.isSafeInteger(o.tokenBudget) && o.tokenBudget > 0 ? o.tokenBudget : null);
  if (conf.limit == null && taskBudget == null) return { ok: true, gated: null };
  const nowDate = new Date();
  const nowText = nowDate.toISOString();
  const bounds = budgetDayBounds(dayKeyOf(nowDate, conf.timezone), conf.timezone);
  const estimate = p90TurnEstimate(db, o.agent, o.costClass, 'execute') || conf.fallback || 0;
  if (taskBudget != null) {
    const own = task ? taskUsage(db, task.id, nowText) : { used: 0, reserved: 0 };
    const room = taskBudget - own.used - own.reserved;
    if (room <= 0 || room < estimate) {
      return { ok: false, reason: 'budget_exceeded', detail: { scope: 'task', task_id: task ? task.id : (o.taskId || null), task_budget: taskBudget, task_used: own.used, task_reserved: own.reserved, estimated: estimate } };
    }
  }
  if (conf.limit != null) {
    const used = mergedDayUsage(db, bounds.day_key, bounds.start, bounds.end, null).reduce(function (n, row) { return n + row.in + row.out; }, 0);
    const reserved = reservedSum(db, bounds.day_key, nowText, null);
    if (used + reserved + estimate > conf.limit) {
      return { ok: false, reason: 'budget_exceeded', detail: { scope: 'day', day_key: bounds.day_key, limit: conf.limit, used: used, reserved: reserved, estimated: estimate } };
    }
  }
  return { ok: true, gated: null };
}

// ---------- 成本 ----------
// 第 8 项：reservationId 可选。带预留时在同一个事务里写实际用量 + 提交预留；
// 实际超过预留仍然完整记账，但任务标 budget_overrun、需人审、升级一次（UNIQUE(task_id,kind)）。
export function recordUsage(db, agent, taskId, phase, tokensIn, tokensOut, reservation) {
  const reservationId = typeof reservation === 'string' ? reservation : (reservation && reservation.reservationId) || null;
  const inTokens = Number(tokensIn) || 0;
  const outTokens = Number(tokensOut) || 0;
  const result = { ok: true, agent: agent, tokens_in: inTokens, tokens_out: outTokens };
  grantTransaction(db, function () {
    db.prepare('INSERT INTO token_usage(agent,task_id,phase,tokens_in,tokens_out,ts) VALUES(?,?,?,?,?,?)')
      .run(agent, taskId || null, phase || null, inTokens, outTokens, nowIso());
    if (!reservationId) return;
    const row = db.prepare('SELECT * FROM token_reservations WHERE id = ?').get(reservationId);
    if (!row) { result.reservation_reason = 'not_found'; return; }
    if (row.committed_at) { result.reservation_reason = 'already_committed'; return; }
    db.prepare('UPDATE token_reservations SET committed_at=? WHERE id=? AND committed_at IS NULL').run(nowIso(), reservationId);
    const actual = inTokens + outTokens;
    const reserved = Number(row.reserved_tokens);
    result.reservation_id = reservationId;
    result.reserved_tokens = reserved;
    result.overrun = actual > reserved;
    if (result.overrun) markBudgetOverrun(db, taskId, { reserved: reserved, actual: actual });
  });
  return result;
}

const ACTIVE_STATUS_SQL = "('open','proposed','claimed','in_progress','review')";
// 归档前 daily 与未归档 raw 的合并视图：同一 (day,agent,project,task) 只取一份（daily 优先），
// 保证归档前后成本数字完全一致。日报表的 day_key 是按策略时区算的自然日，
// 这里的 NOT EXISTS 只是"万一 raw 行没删干净"的兜底；正常归档在同一个事务里删原始行，两份天然不重叠。
const MERGED_USAGE_SQL = "SELECT day_key, agent, project, task_id, tokens_in, tokens_out FROM token_usage_daily " +
  "UNION ALL SELECT substr(u.ts,1,10) AS day_key, u.agent, COALESCE(t.project, '') AS project, COALESCE(u.task_id, '') AS task_id, u.tokens_in, u.tokens_out " +
  "FROM token_usage u LEFT JOIN tasks t ON t.id = u.task_id " +
  "WHERE NOT EXISTS (SELECT 1 FROM token_usage_daily d WHERE d.day_key = substr(u.ts,1,10) AND d.agent = u.agent AND d.project = COALESCE(t.project, '') AND d.task_id = COALESCE(u.task_id, ''))";

export function costByProject(db, leadId) {
  const lead = leadId || 'codex/main';
  const rows = db.prepare('SELECT agent, project, task_id, SUM(tokens_in) AS ti, SUM(tokens_out) AS to_ FROM (' + MERGED_USAGE_SQL + ') GROUP BY agent, project, task_id').all();
  const projectTasks = new Map(db.prepare('SELECT project, COUNT(*) AS c FROM tasks GROUP BY project').all().map(function (row) { return [row.project, Number(row.c)]; }));
  const perProject = new Map();
  let ti = 0, to = 0, leadTokens = 0, unassignedIn = 0, unassignedOut = 0;
  for (const row of rows) {
    const inT = Number(row.ti) || 0;
    const outT = Number(row.to_) || 0;
    ti += inT; to += outT;
    if (row.agent === lead) leadTokens += inT + outT;
    if (!row.project) { unassignedIn += inT; unassignedOut += outT; continue; }
    const entry = perProject.get(row.project) || { project: row.project, in: 0, out: 0, lead_tokens: 0 };
    entry.in += inT; entry.out += outT;
    if (row.agent === lead) entry.lead_tokens += inT + outT;
    perProject.set(row.project, entry);
  }
  for (const project of projectTasks.keys()) if (!perProject.has(project)) perProject.set(project, { project: project, in: 0, out: 0, lead_tokens: 0 });
  const total = ti + to;
  const unassigned = unassignedIn + unassignedOut;
  const projects = Array.from(perProject.values()).map(function (entry) {
    const tokens = entry.in + entry.out;
    return { project: entry.project, tasks: projectTasks.get(entry.project) || 0, in: entry.in, out: entry.out, total: tokens,
      lead_tokens: entry.lead_tokens, lead_ratio: tokens ? entry.lead_tokens / tokens : 0 };
  }).sort(function (a, b) { return b.total - a.total || String(a.project).localeCompare(String(b.project)); });
  return { total: { in: ti, out: to, total },
    lead: { agent: lead, tokens: leadTokens, ratio: total ? leadTokens / total : 0 },
    projects, unassigned: { in: unassignedIn, out: unassignedOut, total: unassigned,
      ratio: total ? unassigned / total : 0 } };
}

export function costSummary(db, leadId) {
  const lead = leadId || 'codex/main';
  const merged = '(' + MERGED_USAGE_SQL + ')';
  const r = db.prepare('SELECT agent, SUM(tokens_in) AS ti, SUM(tokens_out) AS to_ FROM ' + merged + ' GROUP BY agent').all();
  let total = 0, leadTokens = 0;
  for (const x of r) {
    const t = (x.ti || 0) + (x.to_ || 0);
    total += t;
    if (x.agent === lead) leadTokens += t;
  }
  const perTask = db.prepare(
    'SELECT task_id, SUM(tokens_in) AS ti, SUM(tokens_out) AS to_, SUM(tokens_in+tokens_out) AS t ' +
    "FROM " + merged + " WHERE task_id <> '' GROUP BY task_id ORDER BY t DESC"
  ).all();
  const perTaskAgent = db.prepare(
    'SELECT task_id, agent, SUM(tokens_in) AS ti, SUM(tokens_out) AS to_ ' +
    "FROM " + merged + " WHERE task_id <> '' GROUP BY task_id, agent ORDER BY task_id, (SUM(tokens_in)+SUM(tokens_out)) DESC"
  ).all();
  const agentsByTask = {};
  for (const x of perTaskAgent) {
    if (!agentsByTask[x.task_id]) agentsByTask[x.task_id] = [];
    agentsByTask[x.task_id].push({ agent: x.agent, in: x.ti || 0, out: x.to_ || 0, total: (x.ti || 0) + (x.to_ || 0) });
  }
  return {
    total: total, lead: leadTokens, lead_ratio: total ? leadTokens / total : 0,
    by_agent: r.map(function (x) { return { agent: x.agent, in: x.ti || 0, out: x.to_ || 0 }; }),
    by_task: perTask.map(function (x) {
      return { task_id: x.task_id, in: x.ti || 0, out: x.to_ || 0, total: x.t || 0, t: x.t || 0, agents: agentsByTask[x.task_id] || [] };
    }),
    lead_id: lead,
  };
}

// ---------- 归档状态（第 10 项） ----------
// 轻量查询：只做 count，不跑 buildPlan，供看板/CLI 快速展示。
export function archiveStatus(db, policy) {
  const retention = (policy && policy.retention) || {};
  const now = Date.now();
  const cut = function (days) {
    const n = Number(days);
    return Number.isInteger(n) && n > 0 ? new Date(now - n * 86400000).toISOString() : null;
  };
  const active = ACTIVE_STATUS_SQL;
  const msgCut = cut(retention.message_days);
  const guardCut = cut(retention.guard_event_days);
  const usageCut = cut(retention.raw_usage_days);
  const logCut = cut(retention.log_days);
  const pending = { messages: 0, guard_events: 0, token_usage: 0, logs: 0 };
  if (msgCut) {
    pending.messages = Number(db.prepare('SELECT COUNT(*) AS c FROM messages WHERE ts < ? AND (thread IS NULL OR thread NOT IN (SELECT id FROM tasks WHERE status IN ' + active + '))').get(msgCut).c);
  }
  if (guardCut) {
    pending.guard_events = Number(db.prepare('SELECT COUNT(*) AS c FROM guard_events WHERE ts < ? AND (task_id IS NULL OR task_id NOT IN (SELECT id FROM tasks WHERE status IN ' + active + '))').get(guardCut).c);
  }
  if (usageCut) {
    pending.token_usage = Number(db.prepare('SELECT COUNT(*) AS c FROM token_usage u WHERE u.ts < ? AND (u.task_id IS NULL OR u.task_id NOT IN (SELECT id FROM tasks WHERE status IN ' + active + '))').get(usageCut).c);
  }
  try {
    const dir = path.join(BUS_DIR, 'logs');
    const maxBytes = Number(retention.max_log_bytes) || 0;
    for (const name of fs.readdirSync(dir)) {
      const full = path.join(dir, name);
      let st = null;
      try { st = fs.lstatSync(full); } catch (error) { continue; }
      if (!st.isFile() || st.isSymbolicLink()) continue;
      if ((logCut && new Date(st.mtimeMs).toISOString() < logCut) || (maxBytes > 0 && st.size > maxBytes)) pending.logs += 1;
    }
  } catch (error) { /* 没有 logs 目录 */ }
  const last = db.prepare('SELECT MAX(archived_at) AS ts FROM task_archives').get();
  return {
    last_archived_at: (last && last.ts) || null,
    token_usage_daily_rows: Number(db.prepare('SELECT COUNT(*) AS c FROM token_usage_daily').get().c),
    task_archives_rows: Number(db.prepare('SELECT COUNT(*) AS c FROM task_archives').get().c),
    pending_candidates: pending,
  };
}

export function getTaskArchive(db, taskId) {
  const row = db.prepare('SELECT archive_path, archived_at, sha256, bytes FROM task_archives WHERE task_id = ?').get(taskId);
  if (!row) return null;
  return { archive_path: row.archive_path, archived_at: row.archived_at, sha256: row.sha256, bytes: Number(row.bytes) };
}


// ---------- 合并请求（第 11 项） ----------
// 单一全局 Lead：policy.lead 是唯一来源，human 时返回 'human'。
// 不实现项目级覆盖（旧配置里的 project.lead 会被 admin-config 拒绝并在加载时告警）。

// ---------------------------------------------------------------- 第 15 项第 3/4/5 条：孤儿项目

// 孤儿项目 = tasks.project 里有、projects.json 里没有。历史数据继续可读，但不该再出现在新任务表单里。
export function orphanProjects(db, options = {}) {
  const registryFile = mergeRegistryFile(options);
  const registered = registeredProjects(registryFile);
  const active = "('open','proposed','claimed','in_progress','review')";
  const rows = db.prepare('SELECT project, COUNT(*) AS tasks, SUM(CASE WHEN status IN ' + active + ' THEN 1 ELSE 0 END) AS active_tasks FROM tasks GROUP BY project ORDER BY project').all();
  const rawUsage = db.prepare("SELECT COALESCE(t.project,'') AS project, COALESCE(SUM(u.tokens_in+u.tokens_out),0) AS total FROM token_usage u LEFT JOIN tasks t ON t.id=u.task_id GROUP BY COALESCE(t.project,'')").all();
  const dailyUsage = db.prepare('SELECT project, COALESCE(SUM(tokens_in+tokens_out),0) AS total FROM token_usage_daily GROUP BY project').all();
  const tokensOf = (project) => {
    const raw = rawUsage.find((r) => String(r.project) === project);
    const daily = dailyUsage.find((r) => String(r.project) === project);
    return (Number(raw && raw.total) || 0) + (Number(daily && daily.total) || 0);
  };
  const orphans = rows
    .filter((row) => !registered[String(row.project)])
    .map((row) => ({
      project: String(row.project),
      tasks: Number(row.tasks) || 0,
      active_tasks: Number(row.active_tasks) || 0,
      tokens: tokensOf(String(row.project)),
      legacy_path: /^[a-zA-Z]:[\\/]|^\//.test(String(row.project)) ? String(row.project) : null,
      next_step: Number(row.active_tasks) > 0
        ? '先 drain（关闭总线）再改派/取消 active 任务，然后 projects adopt'
        : '用 doctor --orphan-projects --json 看清单，再走 projects adopt --legacy <旧> --id <新> --path <绝对路径>',
    }));
  const registeredUnused = Object.keys(registered).filter((id) => !rows.some((row) => String(row.project) === id));
  return { registry_file: registryFile, projects: rows.length, orphans, registered_unused: registeredUnused, default_tasks: rows.filter((r) => String(r.project) === 'default').reduce((n, r) => n + Number(r.tasks), 0) };
}

const PROJECT_ID_RE = /^[a-z0-9][a-z0-9._-]{1,63}$/;

// adopt：把孤儿项目迁到已登记项目。BEGIN IMMEDIATE 内一次做完 tasks.project + project_migrations + registry。
export function adoptProject(db, policy, input = {}) {
  const legacy = String(input.legacy || '').trim();
  const nextId = String(input.id || '').trim();
  const targetPath = String(input.path || '').trim();
  if (!legacy || !nextId || !targetPath) return { ok: false, reason: 'adopt_args_missing', message: '需要 --legacy <旧项目> --id <新项目> --path <绝对路径>' };
  if (legacy === 'default' || nextId === 'default') return { ok: false, reason: 'default_reserved', message: 'default 是保留项目，不提供迁移或删除接口（避免把兜底数据搬空）' };
  if (!PROJECT_ID_RE.test(nextId)) return { ok: false, reason: 'invalid_project_id', message: '新项目 id 只允许小写字母数字与 . _ -，2–64 字符' };
  if (!path.isAbsolute(targetPath) || targetPath.split(/[\\/]/).indexOf('..') >= 0) return { ok: false, reason: 'invalid_project_path', message: '项目路径必须是绝对路径且不含 ..' };
  let real = null;
  try { real = fs.realpathSync.native ? fs.realpathSync.native(targetPath) : fs.realpathSync(targetPath); } catch (error) { return { ok: false, reason: 'invalid_project_path', message: '项目路径不存在或无法解析: ' + targetPath }; }
  try { if (!fs.statSync(real).isDirectory()) return { ok: false, reason: 'invalid_project_path', message: '项目路径不是目录: ' + targetPath }; }
  catch (error) { return { ok: false, reason: 'invalid_project_path', message: '项目路径不可访问: ' + targetPath }; }
  const manifest = path.join(real, 'project.json');
  if (fs.existsSync(manifest)) {
    try { JSON.parse(fs.readFileSync(manifest, 'utf8')); }
    catch (error) { return { ok: false, reason: 'invalid_project_manifest', message: 'project.json 不是合法 JSON: ' + String((error && error.message) || error) }; }
  }
  const registryFile = mergeRegistryFile(input);
  const registered = registeredProjects(registryFile);
  if (registered[legacy]) return { ok: false, reason: 'legacy_not_orphan', message: '旧项目已经登记过，不是孤儿: ' + legacy };
  if (registered[nextId]) return { ok: false, reason: 'project_exists', message: '新项目 id 已被占用: ' + nextId };
  const active = "('open','proposed','claimed','in_progress','review')";
  const activeCount = Number(db.prepare('SELECT COUNT(*) AS c FROM tasks WHERE project = ? AND status IN ' + active).get(legacy).c) || 0;
  const state = getRuntimeState(db);
  if (activeCount > 0 && state.mode !== 'draining' && state.mode !== 'disabled') {
    return { ok: false, reason: 'drain_required', message: '旧项目还有 ' + activeCount + ' 个 active 任务，且总线在运行：先 drain（关闭总线）或先改派/取消这些任务', active_tasks: activeCount };
  }
  return grantTransaction(db, function () {
    const moved = Number(db.prepare('UPDATE tasks SET project = ?, updated_at = ? WHERE project = ?').run(nextId, nowIso(), legacy).changes) || 0;
    const record = { id: 'pm-' + newId(), legacy: legacy, next: nextId, path: real, tasks: moved, actor: String(input.actor || 'human'), at: nowIso() };
    db.prepare('INSERT INTO project_migrations(migration_id,legacy_project,new_project,path,tasks_migrated,actor,created_at,note) VALUES(?,?,?,?,?,?,?,?)')
      .run(record.id, record.legacy, record.next, record.path, moved, record.actor, record.at, input.note == null ? null : String(input.note).slice(0, 200));
    const nextRegistry = Object.assign({}, registered, { [nextId]: Object.assign({ path: real, adopted_from: legacy, adopted_at: record.at }, registered[nextId] || {}) });
    try {
      const raw = JSON.parse(fs.readFileSync(registryFile, 'utf8'));
      raw.projects = nextRegistry;
      fs.writeFileSync(registryFile, JSON.stringify(raw, null, 2) + '\n');
    } catch (error) { throw new Error('registry_write_failed: ' + String((error && error.message) || error)); }
    return { ok: true, migration: record, tasks_migrated: moved, registry_file: registryFile, next_step: '历史任务仍可读；新任务请用 ' + nextId + '，旧 id 不再出现在新任务表单' };
  });
}

export function effectiveLead(policy) {
  const lead = policy && policy.lead;
  return typeof lead === 'string' && lead ? lead : 'human';
}

const MERGE_OPEN = "('proposed','approved','merging')";

function mergeRegistryFile(input) {
  return (input && input.registry) || process.env.BUS_PROJECTS || path.join(BUS_DIR, 'projects.json');
}

function registeredProjects(file) {
  try {
    const json = JSON.parse(fs.readFileSync(file, 'utf8'));
    return json && json.projects && typeof json.projects === 'object' && !Array.isArray(json.projects) ? json.projects : {};
  } catch (error) { return {}; }
}

// ref 只允许本地分支/标签名，拒绝以 - 开头、含 ..、含空格与远端写法
function mergeRefOk(ref) {
  return typeof ref === 'string' && ref.length > 0 && ref.length <= 200 && /^[A-Za-z0-9_./-]+$/.test(ref) && ref.charAt(0) !== '-' && ref.indexOf('..') < 0;
}

// 第 11 项第 11 条：申请权限与批准/执行权限分离。
// 申请：permissions.request_merge（缺省回退 legacy permissions.merge，再回退 effective Lead）；Human 永远可以。
// 批准/执行：写死在 approveMergeRequest / merge-worker，任何策略值都不能授予 Agent。
export function mergeRequestPermission(policy) {
  const p = (policy && policy.permissions) || {};
  const explicit = Array.isArray(p.request_merge) ? p.request_merge.filter(function (x) { return typeof x === 'string' && x; }) : [];
  if (explicit.length) return explicit;
  const legacy = Array.isArray(p.merge) ? p.merge.filter(function (x) { return typeof x === 'string' && x; }) : [];
  // 老版本 savePolicy 会把 merge 强制写成 ['human']，那不是"人类刻意禁止 Lead"，
  // 所以只在 legacy 里出现了具体 agent 时才尊重它；否则回退到有效 Lead。
  if (legacy.some(function (x) { return x !== 'human'; })) return legacy;
  const lead = effectiveLead(policy);
  if (lead && lead !== 'human') return legacy.indexOf('human') >= 0 ? [lead, 'human'] : [lead];
  return legacy.length ? legacy : ['human'];
}

// 最新一次验证运行必须"成功 + frozen hash 与任务当前 verify_spec_hash 一致"才算有效。
// 刻意不做"从历史里挑一个通过的"：那等于允许用旧结论放行新代码。
export function latestFrozenVerification(db, taskId) {
  const task = getTask(db, taskId);
  if (!task) return { ok: false, reason: 'task_not_found', run: null, expected_hash: null };
  const expected = task.verify_spec_hash ? String(task.verify_spec_hash) : null;
  const row = db.prepare('SELECT run_id,task_id,verify_id,verify_spec_hash,exit_code,ok,started_at,finished_at,reason FROM verification_runs WHERE task_id=? ORDER BY started_at DESC, run_id DESC LIMIT 1').get(taskId);
  if (!row) return { ok: false, reason: 'no_verification_run', run: null, expected_hash: expected };
  if (Number(row.ok) !== 1) return { ok: false, reason: 'last_run_failed', run: row, expected_hash: expected };
  if (!expected) return { ok: false, reason: 'task_has_no_frozen_hash', run: row, expected_hash: null };
  if (String(row.verify_spec_hash || '') !== expected) return { ok: false, reason: 'stale_verification_hash', run: row, expected_hash: expected };
  return { ok: true, reason: null, run: row, expected_hash: expected };
}

export function getMergeRequest(db, id) {
  const row = db.prepare('SELECT * FROM merge_requests WHERE id = ?').get(id);
  if (!row) return null;
  let taskIds = [];
  try { const parsed = JSON.parse(row.task_ids_json || '[]'); taskIds = Array.isArray(parsed) ? parsed : []; } catch (error) { taskIds = []; }
  return Object.assign({}, row, { task_ids: taskIds, version: Number(row.version) || 0 });
}

export function createMergeRequest(db, policy, actor, input) {
  const who = actor || '';
  const allow = mergeRequestPermission(policy);
  if (allow.indexOf(who) < 0 && who !== 'human') {
    return { ok: false, reason: 'not_permitted', message: who + ' 不在 permissions.request_merge（或 legacy permissions.merge）中，不能发起合并' };
  }
  const i = input || {};
  const project = String(i.project || '').trim();
  if (!project) return { ok: false, reason: 'invalid_project', message: '必须指定项目' };
  const registryFile = mergeRegistryFile(i);
  if (!Object.prototype.hasOwnProperty.call(registeredProjects(registryFile), project)) {
    return { ok: false, reason: 'project_not_registered', message: '项目不在 registry 中: ' + project };
  }
  const taskIds = Array.isArray(i.task_ids) ? i.task_ids.map(String) : [];
  if (!taskIds.length) return { ok: false, reason: 'no_tasks', message: '合并请求必须关联至少一个任务' };
  for (const id of taskIds) {
    const task = getTask(db, id);
    if (!task) return { ok: false, reason: 'task_not_found', message: '任务不存在: ' + id };
    if (task.status !== 'done') return { ok: false, reason: 'task_not_done', message: '任务 ' + id + ' 还没 done（当前 ' + task.status + '）' };
    if (task.project !== project) return { ok: false, reason: 'task_project_mismatch', message: '任务 ' + id + ' 属于 ' + task.project + '，不是 ' + project };
  }
  const sourceRef = String(i.source_ref || '').trim();
  const targetRef = String(i.target_ref || 'main').trim();
  if (!mergeRefOk(sourceRef)) return { ok: false, reason: 'invalid_source_ref', message: 'source_ref 必须是本地 ref 名' };
  if (!mergeRefOk(targetRef)) return { ok: false, reason: 'invalid_target_ref', message: 'target_ref 必须是本地 ref 名' };
  if (sourceRef === targetRef) return { ok: false, reason: 'same_ref', message: 'source 与 target 不能相同' };
  const dup = db.prepare('SELECT id FROM merge_requests WHERE project = ? AND source_ref = ? AND target_ref = ? AND task_ids_json = ? AND status IN ' + MERGE_OPEN).get(project, sourceRef, targetRef, JSON.stringify(taskIds));
  if (dup) return { ok: false, reason: 'duplicate', message: '同一个合并请求已经在队列里: ' + dup.id, existing: dup.id };
  const id = 'mr-' + newId();
  const ts = nowIso();
  db.prepare('INSERT INTO merge_requests(id,project,task_ids_json,source_ref,target_ref,status,requested_by,approved_by,verify_run_id,merge_commit,version,created_at,updated_at) VALUES(?,?,?,?,?,?,?,NULL,NULL,NULL,0,?,?)')
    .run(id, project, JSON.stringify(taskIds), sourceRef, targetRef, 'proposed', who, ts, ts);
  logGuardEvent(db, { task_id: taskIds[0], agent: who, kind: 'merge', detail: 'request ' + sourceRef + ' → ' + targetRef, action: 'merge_requested', actor: who });
  return { ok: true, merge_request: getMergeRequest(db, id) };
}

// 只有 Human 能批准：permissions.accept 或 permissions.merge 都不能替代人。
export function approveMergeRequest(db, actor, id, expectVersion) {
  const who = actor || '';
  if (who !== 'human') return { ok: false, reason: 'human_only', message: '只有 Human 可以批准合并请求（accept / merge 权限都不等于人工审批）' };
  const mr = getMergeRequest(db, id);
  if (!mr) return { ok: false, reason: 'not_found', message: '没有这个合并请求: ' + id };
  if (mr.status !== 'proposed') return { ok: false, reason: 'not_proposed', message: '当前状态是 ' + mr.status };
  if (Number.isSafeInteger(expectVersion) && expectVersion !== mr.version) {
    return { ok: false, reason: 'version_mismatch', message: '合并请求已被修改，当前 version=' + mr.version };
  }
  const updated = db.prepare("UPDATE merge_requests SET status='approved', approved_by=?, version=version+1, updated_at=? WHERE id=? AND status='proposed' AND version=?")
    .run(who, nowIso(), id, mr.version);
  if (Number(updated.changes) !== 1) return { ok: false, reason: 'race_lost', message: '并发批准没有抢到' };
  logGuardEvent(db, { task_id: (mr.task_ids[0] || null), agent: who, kind: 'merge', detail: 'approved ' + mr.source_ref + ' → ' + mr.target_ref, action: 'merge_approved', actor: who });
  return { ok: true, merge_request: getMergeRequest(db, id) };
}

// 第 11 项第 13 条：进入 merging 时同时写下 worker_id / started_at / lease_until，
// 崩溃后靠 lease 过期判定「这是一次遗留」，而不是靠猜。
// needs_human=1 时硬拒：worker 自己不许清这个标志。
export function startMerge(db, id, expectVersion, workerOptions) {
  const w = workerOptions || {};
  const mr = getMergeRequest(db, id);
  if (!mr) return { ok: false, reason: 'not_found', message: '没有这个合并请求: ' + id };
  if (mr.status !== 'approved') return { ok: false, reason: 'not_approved', message: '只有已批准（approved）的请求才能开始合并，当前 ' + mr.status };
  if (Number(mr.needs_human) === 1) {
    return { ok: false, reason: 'needs_human', message: '这个请求被标记为需要人工重新确认' + (mr.needs_human_reason ? '：' + mr.needs_human_reason : '') };
  }
  if (Number.isSafeInteger(expectVersion) && expectVersion !== mr.version) {
    return { ok: false, reason: 'version_mismatch', message: '合并请求已被修改，当前 version=' + mr.version };
  }
  const startedAt = nowIso();
  const leaseMin = Number.isSafeInteger(w.leaseMin) && w.leaseMin > 0 ? w.leaseMin : 30;
  const leaseUntil = plusMinutes(leaseMin);
  const workerId = String(w.workerId || 'merge-worker');
  const updated = db.prepare("UPDATE merge_requests SET status='merging', worker_id=?, started_at=?, lease_until=?, error=NULL, version=version+1, updated_at=? WHERE id=? AND status='approved' AND version=?")
    .run(workerId, startedAt, leaseUntil, startedAt, id, mr.version);
  if (Number(updated.changes) !== 1) return { ok: false, reason: 'race_lost', message: '并发开始合并没有抢到' };
  return { ok: true, merge_request: getMergeRequest(db, id), lease_until: leaseUntil, worker_id: workerId };
}

// needs_human：worker / 系统只能置位，清除只能由 Human 做（第 11 项第 12 条）。
export function setMergeNeedsHuman(db, actor, id, reason, options) {
  const o = options || {};
  const mr = getMergeRequest(db, id);
  if (!mr) return { ok: false, reason: 'not_found', message: '没有这个合并请求: ' + id };
  const clearing = reason == null || String(reason) === '';
  if (clearing && actor !== 'human') {
    return { ok: false, reason: 'human_only', message: '只有 Human 可以清除 needs_human（worker 不许给自己解封）' };
  }
  const flag = clearing ? 0 : 1;
  const text = clearing ? null : String(reason).slice(0, 500);
  const updated = db.prepare('UPDATE merge_requests SET needs_human=?, needs_human_reason=?, version=version+1, updated_at=? WHERE id=? AND version=?')
    .run(flag, text, nowIso(), id, mr.version);
  if (Number(updated.changes) !== 1) return { ok: false, reason: 'race_lost', message: '并发修改没有抢到' };
  logGuardEvent(db, { task_id: (mr.task_ids[0] || null), agent: actor || 'unknown', kind: 'merge',
    detail: (clearing ? 'needs_human 清除' : 'needs_human 置位：' + text),
    action: clearing ? 'merge_needs_human_cleared' : 'merge_needs_human_set', actor: actor });
  return { ok: true, merge_request: getMergeRequest(db, id) };
}

// Human 重新确认：把二次确认快照 hash 冻结进 approved_preflight 并清除 needs_human。
export function confirmMergeRequest(db, id, actor, preflightHash) {
  if (actor !== 'human') return { ok: false, reason: 'human_only', message: '只有 Human 可以重新确认合并请求' };
  const hash = String(preflightHash || '');
  if (!/^[0-9a-f]{64}$/.test(hash)) return { ok: false, reason: 'invalid_preflight', message: 'preflight_hash 必须是 sha256' };
  const mr = getMergeRequest(db, id);
  if (!mr) return { ok: false, reason: 'not_found', message: '没有这个合并请求: ' + id };
  if (mr.status !== 'approved') return { ok: false, reason: 'not_approved', message: '只有 approved 状态可以重新确认，当前 ' + mr.status };
  const updated = db.prepare('UPDATE merge_requests SET approved_preflight=?, needs_human=0, needs_human_reason=NULL, version=version+1, updated_at=? WHERE id=? AND status=? AND version=?')
    .run(hash, nowIso(), id, 'approved', mr.version);
  if (Number(updated.changes) !== 1) return { ok: false, reason: 'race_lost', message: '并发确认没有抢到' };
  logGuardEvent(db, { task_id: (mr.task_ids[0] || null), agent: 'human', kind: 'merge', detail: 're-confirmed ' + hash.slice(0, 12), action: 'merge_confirmed', actor: 'human' });
  return { ok: true, merge_request: getMergeRequest(db, id) };
}

// 崩溃遗留的 merging 请求：Human 可以决定「重试」（回到 approved，清掉 worker/lease）。
// 调用方（CLI / 看板）必须先确认没有 MERGE_HEAD 再调用本函数。
export function resetMergeForRetry(db, id, actor, options) {
  const o = options || {};
  if (actor !== 'human') return { ok: false, reason: 'human_only', message: '只有 Human 可以重置合并请求' };
  const mr = getMergeRequest(db, id);
  if (!mr) return { ok: false, reason: 'not_found', message: '没有这个合并请求: ' + id };
  if (mr.status !== 'merging') return { ok: false, reason: 'not_merging', message: '只有 merging 状态可以重置，当前 ' + mr.status };
  if (o.inMerge === true) {
    return { ok: false, reason: 'merge_in_progress', message: '仓库仍处于 merge 冲突状态，请先由人执行 git merge --abort（不会自动 reset --hard）' };
  }
  const updated = db.prepare("UPDATE merge_requests SET status='approved', worker_id=NULL, started_at=NULL, lease_until=NULL, error=NULL, version=version+1, updated_at=? WHERE id=? AND status='merging' AND version=?")
    .run(nowIso(), id, mr.version);
  if (Number(updated.changes) !== 1) return { ok: false, reason: 'race_lost', message: '并发重置没有抢到' };
  logGuardEvent(db, { task_id: (mr.task_ids[0] || null), agent: 'human', kind: 'merge', detail: 'reset for retry after crash' + (o.note ? '：' + String(o.note).slice(0, 200) : ''), action: 'merge_retry_reset', actor: 'human' });
  return { ok: true, merge_request: getMergeRequest(db, id) };
}

// 崩溃恢复的判定输入：状态 + worker + 租约是否过期（in_merge 由调用方用 git 查，store 不碰 git）。
export function mergeExecutionState(db, id, options) {
  const o = options || {};
  const mr = getMergeRequest(db, id);
  if (!mr) return { ok: false, reason: 'not_found' };
  const now = o.now ? new Date(o.now) : new Date();
  const leaseMs = mr.lease_until ? Date.parse(mr.lease_until) : null;
  return {
    ok: true,
    id: mr.id,
    status: mr.status,
    worker_id: mr.worker_id || null,
    started_at: mr.started_at || null,
    lease_until: mr.lease_until || null,
    lease_expired: mr.status === 'merging' ? (leaseMs != null && Number.isFinite(leaseMs) ? leaseMs <= now.getTime() : true) : false,
    needs_human: Number(mr.needs_human) === 1,
    needs_human_reason: mr.needs_human_reason || null,
    error: mr.error || null,
    approved_preflight: mr.approved_preflight || null,
    log_path: mr.log_path || null,
  };
}

export function finishMerge(db, id, payload, expectVersion) {
  const p = payload || {};
  const status = String(p.status || '');
  if (['merged', 'failed', 'cancelled'].indexOf(status) < 0) {
    return { ok: false, reason: 'invalid_status', message: 'finishMerge 只接受 merged / failed / cancelled' };
  }
  const mr = getMergeRequest(db, id);
  if (!mr) return { ok: false, reason: 'not_found', message: '没有这个合并请求: ' + id };
  const froms = status === 'cancelled' ? ['proposed', 'approved', 'merging'] : ['merging'];
  if (froms.indexOf(mr.status) < 0) return { ok: false, reason: 'bad_transition', message: '不能从 ' + mr.status + ' 迁到 ' + status + '（允许来源: ' + froms.join(',') + '）' };
  if (Number.isSafeInteger(expectVersion) && expectVersion !== mr.version) {
    return { ok: false, reason: 'version_mismatch', message: '合并请求已被修改，当前 version=' + mr.version };
  }
  const commit = status === 'merged' ? String(p.commit || '').trim() : null;
  if (status === 'merged' && !/^[0-9a-f]{7,64}$/i.test(commit)) {
    return { ok: false, reason: 'invalid_commit', message: 'merged 必须带合法的 merge_commit' };
  }
  // 第 11 项第 10 条：收尾必须是**一条** UPDATE 同时写 status / verify_run_id / merge_commit / version。
  // 影响行数不为 1 就一个字段都不许变（旧写法先单独写 verify_run_id，CAS 失败会留下部分更新）。
  const verifyRunId = p.verify_run_id ? String(p.verify_run_id) : mr.verify_run_id;
  // 第 11 项第 13 条：失败原因、执行日志路径/hash 也写进同一条 UPDATE；同时清空 lease。
  const errorText = p.error == null ? (status === 'failed' ? String(p.note || 'failed').slice(0, 500) : null) : String(p.error).slice(0, 500);
  const logPath = p.log_path == null ? mr.log_path : String(p.log_path);
  const logSha = p.log_sha256 == null ? mr.log_sha256 : String(p.log_sha256);
  const updated = db.prepare('UPDATE merge_requests SET status=?, verify_run_id=?, merge_commit=?, error=?, log_path=?, log_sha256=?, lease_until=NULL, version=version+1, updated_at=? WHERE id=? AND status=? AND version=?')
    .run(status, verifyRunId, commit, errorText, logPath, logSha, nowIso(), id, mr.status, mr.version);
  if (Number(updated.changes) !== 1) {
    return { ok: false, reason: 'race_lost', message: '并发收尾没有抢到（未写入任何字段）' };
  }
  logGuardEvent(db, { task_id: (mr.task_ids[0] || null), agent: 'merge-runner', kind: 'merge', detail: status + (commit ? ' ' + commit : '') + (p.note ? ' — ' + String(p.note).slice(0, 200) : ''), action: 'merge_' + status, actor: 'merge-runner' });
  return { ok: true, merge_request: getMergeRequest(db, id) };
}

// 第 11 项第 12 条：批准/执行前的二次确认快照。
// 快照里只放"人能核对的东西"：项目、两端 ref、关联任务与其 frozen verification、当前分支/HEAD/工作树状态。
// 执行前必须重算一次，不一致就不许沿用旧批准（持久化的 approved_preflight 等新列到位后再写）。
export function mergePreflight(db, policy, id, options) {
  const o = options || {};
  const mr = getMergeRequest(db, id);
  if (!mr) return { ok: false, reason: 'not_found', message: '没有这个合并请求: ' + id };
  const tasks = mr.task_ids.map(function (taskId) {
    const task = getTask(db, taskId);
    const verified = latestFrozenVerification(db, taskId);
    return {
      task_id: taskId,
      status: task ? task.status : null,
      verify_spec_hash: task ? (task.verify_spec_hash || null) : null,
      verification_ok: verified.ok === true,
      verification_reason: verified.reason || null,
      verify_run_id: verified.run ? verified.run.run_id : null,
      verify_run_hash: verified.run ? (verified.run.verify_spec_hash || null) : null,
    };
  });
  const repo = o.repo !== undefined ? o.repo : (typeof o.gitInfo === 'function' ? o.gitInfo({ project: mr.project }) : null);
  const body = {
    request: { id: mr.id, project: mr.project, source_ref: mr.source_ref, target_ref: mr.target_ref,
      status: mr.status, version: mr.version, requested_by: mr.requested_by, approved_by: mr.approved_by },
    repo: repo || null,
    tasks: tasks,
  };
  // hash 只覆盖"安全相关且人看得懂"的事实：请求身份、两端 ref、仓库分支/HEAD/工作树、每个任务的状态与
  // 固化验证（run id + hash）。**不**包含 version/status/timestamps —— 否则批准/确认本身会推进 version，
  // 刚冻结的 hash 下一秒就"过期"，形成自我否定的循环。
  const stable = {
    request: { id: body.request.id, project: body.request.project, source_ref: body.request.source_ref, target_ref: body.request.target_ref },
    repo: body.repo ? { root: body.repo.root, branch: body.repo.branch, head: body.repo.head, worktree: body.repo.worktree, in_merge: body.repo.in_merge === true } : null,
    tasks: tasks.map(function (t) { return { task_id: t.task_id, status: t.status, verify_spec_hash: t.verify_spec_hash, verify_run_id: t.verify_run_id }; }),
  };
  body.preflight_hash = crypto.createHash('sha256').update(JSON.stringify(stable)).digest('hex');
  return { ok: true, merge_request: mr, preflight: body, preflight_hash: body.preflight_hash,
    verification_ok: tasks.every(function (t) { return t.verification_ok; }) };
}

export function listMergeRequests(db, filter) {
  const f = filter || {};
  const where = [];
  const args = [];
  if (f.project) { where.push('project = ?'); args.push(f.project); }
  if (f.status) { where.push('status = ?'); args.push(f.status); }
  if (f.open) where.push('status IN ' + MERGE_OPEN);
  const limit = Number.isSafeInteger(f.limit) && f.limit > 0 ? Math.min(f.limit, 200) : 100;
  const rows = db.prepare('SELECT * FROM merge_requests' + (where.length ? ' WHERE ' + where.join(' AND ') : '') + ' ORDER BY created_at DESC, id DESC LIMIT ' + limit).all(...args);
  return rows.map(function (row) { return getMergeRequest(db, row.id); });
}

