// Agent Bus 数据层：所有写操作都经过这里，守卫在此强制执行。
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';
import { classifyText, classifyPaths, mergeKinds, KINDS } from './redline.mjs';

export const BUS_DIR = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(BUS_DIR, '..');
export const DEFAULT_DB = path.join(BUS_DIR, 'bus.db');
export const POLICY_PATH = path.join(BUS_DIR, 'policy.json');

export const TERMINAL = ['done', 'failed', 'declined', 'cancelled'];
export const ACTIVE = ['open', 'proposed', 'claimed', 'in_progress', 'review'];

export function nowIso() { return new Date().toISOString(); }
export function plusMinutes(m) { return new Date(Date.now() + m * 60000).toISOString(); }
export function newId() { return Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10); }

function pragma(db, s) {
  try { db.exec(s); } catch (e) { try { db.prepare(s).get(); } catch (e2) {} }
}

function ensureColumn(db, table, col, def) {
  try {
    const cols = db.prepare('PRAGMA table_info(' + table + ')').all().map(function (c) { return c.name; });
    if (cols.indexOf(col) < 0) db.exec('ALTER TABLE ' + table + ' ADD COLUMN ' + col + ' ' + def);
  } catch (e) {}
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
  const p = dbPath || DEFAULT_DB;
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const db = new DatabaseSync(p);
  pragma(db, 'PRAGMA journal_mode = WAL');
  pragma(db, 'PRAGMA busy_timeout = 3000');
  db.exec(fs.readFileSync(path.join(BUS_DIR, 'schema.sql'), 'utf8'));
  // 老库补列：CREATE TABLE IF NOT EXISTS 不会给已存在的表加列
  ensureColumn(db, 'tasks', 'verify_cmd', 'TEXT');
  ensureColumn(db, 'tasks', 'extra_dirs', 'TEXT');
  ensureColumn(db, 'tasks', 'redline', 'TEXT');
  ensureColumn(db, 'tasks', 'grants', 'TEXT');
  ensureColumn(db, 'tasks', 'guard', 'TEXT');
  ensureColumn(db, 'tasks', 'changed_files', 'INTEGER');
  ensureColumn(db, 'tasks', 'needs_human', 'INTEGER NOT NULL DEFAULT 0');
  ensureColumn(db, 'tasks', 'escalated_at', 'TEXT');
  return db;
}

export function getRuntimeState(db) {
  const row = db.prepare('SELECT enabled,updated_at,updated_by,version FROM agentbus_runtime_state WHERE singleton=1').get();
  const active = Number(db.prepare("SELECT COUNT(*) AS n FROM tasks WHERE status IN ('claimed','in_progress','review')").get().n);
  const enabled = !!row && row.enabled === 1;
  return { enabled, mode: enabled ? 'enabled' : (active ? 'draining' : 'disabled'),
    active_tasks: active, updated_at: row ? row.updated_at : null,
    updated_by: row ? row.updated_by : null, version: row ? row.version : 0 };
}

export function setRuntimeState(db, actor, enabled, expectVersion) {
  if (actor !== 'human') return { ok: false, reason: 'not_permitted', message: '只有 Human 可在本地控制台启停 AgentBus' };
  if (typeof enabled !== 'boolean' || (expectVersion !== undefined && (!Number.isSafeInteger(expectVersion) || expectVersion < 0))) {
    return { ok: false, reason: 'invalid_runtime_state', message: 'enabled 必须为 boolean，version 必须为非负整数' };
  }
  const result = db.prepare('UPDATE agentbus_runtime_state SET enabled=?,updated_at=?,updated_by=?,version=version+1 WHERE singleton=1' +
    (expectVersion === undefined ? '' : ' AND version=?')).run(...[enabled ? 1 : 0, nowIso(), actor].concat(expectVersion === undefined ? [] : [expectVersion]));
  if (Number(result.changes) !== 1) return { ok: false, reason: 'version_mismatch', message: '运行状态已变更，请刷新后重试', ...getRuntimeState(db) };
  return { ok: true, ...getRuntimeState(db) };
}

export function runtimeDisabled() {
  return { ok: false, reason: 'disabled', message: 'AgentBus 已关闭；请由 Human 在本地控制台启用' };
}

export function loadPolicy(p) {
  // BUS_POLICY_PATH 让测试能用临时策略，不污染真实配置
  const file = p || process.env.BUS_POLICY_PATH || POLICY_PATH;
  const policy = JSON.parse(fs.readFileSync(file, 'utf8'));
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
export function send(db, m) {
  const row = {
    msg_id: m.msg_id || newId(),
    ts: nowIso(),
    sender: m.sender,
    recipient: m.to,
    thread: m.thread || null,
    kind: m.kind,
    body: m.body || '',
    refs: m.refs ? JSON.stringify(m.refs) : null,
    reply_to: m.reply_to || null,
    hop: m.hop || 0,
  };
  db.prepare(
    'INSERT OR IGNORE INTO messages(msg_id,ts,sender,recipient,thread,kind,body,refs,reply_to,hop) VALUES(?,?,?,?,?,?,?,?,?,?)'
  ).run(row.msg_id, row.ts, row.sender, row.recipient, row.thread, row.kind, row.body, row.refs, row.reply_to, row.hop);
  const got = db.prepare('SELECT seq FROM messages WHERE msg_id = ?').get(row.msg_id);
  return { msg_id: row.msg_id, seq: got ? got.seq : null };
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
    'write_scope,max_subagents,verify_cmd,extra_dirs,redline,grants,guard,changed_files,needs_human,escalated_at,' +
    'version,lease_until,decline_reason,created_at,updated_at FROM tasks WHERE ' +
    where.join(' AND ') + ' ORDER BY id LIMIT 200';
  return db.prepare(sql).all(...args);
}

export function createTask(db, t) {
  const id = nextTaskId(db);
  const ts = nowIso();
  db.prepare(
    'INSERT INTO tasks(id,title,body,project,status,owner,origin,dispatched_by,target,depth,cost_class,' +
    'write_scope,max_subagents,verify_cmd,extra_dirs,redline,grants,version,created_at,updated_at) ' +
    'VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)'
  ).run(id, t.title, t.body || null, t.project || 'default', t.status, null, t.origin || 'human',
    t.dispatched_by || null, t.target || null, t.depth || 0, t.cost_class || 'standard',
    t.write_scope ? JSON.stringify(t.write_scope) : null, t.max_subagents || 0,
    t.verify_cmd || null, t.extra_dirs ? JSON.stringify(t.extra_dirs) : null,
    jsonArray(t.redline), jsonArray(t.grants), 0, ts, ts);
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
      (typeof task.verify_cmd !== 'string' || !task.verify_cmd.trim())) {
    return { ok: false, reason: 'verify_cmd_required', message: '自动验收类别 ' + (task.cost_class || 'standard') + ' 必须提供非空 verify_cmd 验证命令' };
  }
  return null;
}

function createHumanTaskEnabled(db, policy, actor, t) {
  const who = actor || 'human';
  const canCreate = who === 'human' || (policy.permissions.dispatch || []).indexOf(who) >= 0;
  if (!canCreate) return { ok: false, reason: 'not_permitted', message: who + ' 没有创建/派发任务的权限' };
  const verification = verifyCommandRequired(policy, t);
  if (verification) return verification;
  const kinds = mergeKinds(
    classifyText([t.title, t.body, t.verify_cmd].filter(function (x) { return !!x; }).join('\n')),
    classifyPaths(t.write_scope),
    t.grants
  );
  const status = (t.status === 'proposed' || kinds.length) ? 'proposed' : 'open';
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
    redline: kinds,
    grants: t.grants || [],
  });
  send(db, {
    sender: who,
    to: task.target || 'broadcast',
    thread: task.id,
    kind: 'task.new',
    body: task.title,
    refs: { task: task.id, project: task.project },
  });
  return { ok: true, task: task };
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

  const structural = ['project', 'target', 'write_scope'];
  if (t.status !== 'open' && t.status !== 'proposed' && structural.some(function (k) { return Object.prototype.hasOwnProperty.call(patch, k); })) {
    return { ok: false, reason: 'task_started', message: '任务开始后不能修改项目、目标 Agent 或写作用域；请先改派任务' };
  }

  const sets = [];
  const args = [];
  const allowed = ['title', 'body', 'project', 'target', 'cost_class', 'max_subagents'];
  for (const key of allowed) {
    if (!Object.prototype.hasOwnProperty.call(patch, key)) continue;
    sets.push(key + '=?');
    args.push(patch[key] === '' ? null : patch[key]);
  }
  if (Object.prototype.hasOwnProperty.call(patch, 'write_scope')) {
    sets.push('write_scope=?');
    args.push(patch.write_scope && patch.write_scope.length ? JSON.stringify(patch.write_scope) : null);
  }
  if (!sets.length) return { ok: false, reason: 'empty_patch', message: '没有可更新的字段' };
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

export function reassignTask(db, policy, actor, taskId, target, expectVersion) {
  if (!getRuntimeState(db).enabled) return runtimeDisabled();
  try { return reassignTaskEnabled(db, policy, actor, taskId, target, expectVersion); } catch (e) {
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

export function cancelTask(db, policy, actor, taskId, note, expectVersion) {
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
  const t = getTask(db, taskId);
  if (!t) return { ok: false, reason: 'not_found', message: '没有这个任务: ' + taskId };
  if (t.status === 'proposed') return { ok: false, reason: 'needs_approval', message: '任务在待批状态，需先 accept' };
  if (t.status !== 'open') return { ok: false, reason: 'not_open', message: '任务当前状态是 ' + t.status + '，owner=' + (t.owner || 'none') };
  if (t.target && t.target !== agent) return { ok: false, reason: 'not_target', message: '这个任务是定向派给 ' + t.target + ' 的，你不能认领' };

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

export function updateTask(db, agent, taskId, status, note, expectVersion, accepters) {
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
  db.prepare('UPDATE tasks SET status=?, version=version+1, updated_at=?, lease_until=NULL WHERE id=?')
    .run(status, nowIso(), taskId);
  send(db, { sender: agent, to: 'thread:' + taskId, thread: taskId, kind: 'task.' + status, body: note || (taskId + ' -> ' + status), refs: { task: taskId } });
  return { ok: true, task: getTask(db, taskId) };
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
export function overrideTask(db, agent, taskId, note, accepters) {
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

export function accept(db, agent, taskId, accepters) {
  if (!getRuntimeState(db).enabled) return runtimeDisabled();
  try { return acceptEnabled(db, agent, taskId, accepters); } catch (e) {
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

export function decline(db, agent, taskId, reason, accepters) {
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
  const r = db.prepare(
    "UPDATE tasks SET lease_until=? WHERE id=? AND owner=? AND status IN ('claimed','in_progress')"
  ).run(plusMinutes(leaseMin || 15), taskId, agent);
  return Number(r.changes) === 1;
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
    db.prepare("UPDATE tasks SET status='open', owner=NULL, lease_until=NULL, version=version+1, updated_at=? WHERE id=?").run(now, r.id);
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
  const toCfg = agentCfg(policy, to);
  const fromCfg = agentCfg(policy, from);
  if (!to) return { ok: false, reason: 'no_target', message: '必须指定收件 agent' };

  const dispatchers = policy.permissions.dispatch || [];
  const allowedByDispatcher = dispatchers.indexOf(from) >= 0;
  const allowedByAgent = (fromCfg.may_dispatch_to || []).indexOf(to) >= 0 || (fromCfg.may_dispatch_to || []).indexOf('*') >= 0;
  if (!allowedByDispatcher && !allowedByAgent) {
    return { ok: false, reason: 'guard_G1_unauthorized', message: from + ' 无权向 ' + to + ' 派活（既不在 permissions.dispatch，也不在 ' + from + '.may_dispatch_to）' };
  }

  const verification = verifyCommandRequired(policy, d);
  if (verification) return verification;
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
  const redlineExtra = !!(d.extra_dirs && d.extra_dirs.length) || d.redline === true;

  const enabled = g.dispatch_enabled !== false;
  const autonomy = toCfg.autonomy || 'off';
  const reasons = [];
  let status = 'open';
  if (kinds.length || redlineExtra) {
    status = 'proposed';
    if (!kinds.length) reasons.push('redline(需要人类批准: ' + (d.extra_dirs || []).join(', ') + ')');
  } else if (!enabled) { status = 'proposed'; reasons.push('dispatch_enabled=false'); }
  else if (autonomy === 'off' || autonomy === 'propose') { status = 'proposed'; reasons.push('autonomy=' + autonomy); }
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
    verify_cmd: d.verify_cmd, extra_dirs: d.extra_dirs, redline: kinds, grants: grants,
  });
  send(db, { sender: from, to: to, thread: task.id, kind: 'task.new', body: d.title, refs: { task: task.id, project: task.project }, hop: 1 });
  const gatedBy = kinds.length ? 'redline:' + kinds.join(',') : (reasons.join('+') || null);
  return { ok: true, task: task, gated: status === 'proposed', gated_by: gatedBy };
}

// ---------- 成本 ----------
export function recordUsage(db, agent, taskId, phase, tokensIn, tokensOut) {
  db.prepare('INSERT INTO token_usage(agent,task_id,phase,tokens_in,tokens_out,ts) VALUES(?,?,?,?,?,?)')
    .run(agent, taskId || null, phase || null, tokensIn || 0, tokensOut || 0, nowIso());
  return { ok: true, agent: agent, tokens_in: tokensIn || 0, tokens_out: tokensOut || 0 };
}

export function costByProject(db, leadId) {
  const lead = leadId || 'codex/main';
  const sums = db.prepare(
    'SELECT COALESCE(SUM(u.tokens_in),0) AS ti, COALESCE(SUM(u.tokens_out),0) AS to_, ' +
    'COALESCE(SUM(CASE WHEN u.agent=? THEN u.tokens_in+u.tokens_out ELSE 0 END),0) AS lead_tokens, ' +
    'COALESCE(SUM(CASE WHEN t.id IS NULL THEN u.tokens_in ELSE 0 END),0) AS unassigned_in, ' +
    'COALESCE(SUM(CASE WHEN t.id IS NULL THEN u.tokens_out ELSE 0 END),0) AS unassigned_out ' +
    'FROM token_usage u LEFT JOIN tasks t ON t.id=u.task_id'
  ).get(lead);
  const total = sums.ti + sums.to_;
  const unassigned = sums.unassigned_in + sums.unassigned_out;
  const projects = db.prepare(
    'SELECT t.project, COUNT(DISTINCT t.id) AS tasks, COALESCE(SUM(u.tokens_in),0) AS ti, ' +
    'COALESCE(SUM(u.tokens_out),0) AS to_, ' +
    'COALESCE(SUM(CASE WHEN u.agent=? THEN u.tokens_in+u.tokens_out ELSE 0 END),0) AS lead_tokens ' +
    'FROM tasks t LEFT JOIN token_usage u ON u.task_id=t.id GROUP BY t.project ' +
    'ORDER BY (COALESCE(SUM(u.tokens_in),0)+COALESCE(SUM(u.tokens_out),0)) DESC,t.project'
  ).all(lead).map(function (row) {
    const tokens = row.ti + row.to_;
    return { project: row.project, tasks: row.tasks, in: row.ti, out: row.to_, total: tokens,
      lead_tokens: row.lead_tokens, lead_ratio: tokens ? row.lead_tokens / tokens : 0 };
  });
  return { total: { in: sums.ti, out: sums.to_, total },
    lead: { agent: lead, tokens: sums.lead_tokens, ratio: total ? sums.lead_tokens / total : 0 },
    projects, unassigned: { in: sums.unassigned_in, out: sums.unassigned_out, total: unassigned,
      ratio: total ? unassigned / total : 0 } };
}

export function costSummary(db, leadId) {
  const lead = leadId || 'codex/main';
  const r = db.prepare('SELECT agent, SUM(tokens_in) AS ti, SUM(tokens_out) AS to_ FROM token_usage GROUP BY agent').all();
  let total = 0, leadTokens = 0;
  for (const x of r) {
    const t = (x.ti || 0) + (x.to_ || 0);
    total += t;
    if (x.agent === lead) leadTokens += t;
  }
  const perTask = db.prepare(
    'SELECT task_id, SUM(tokens_in) AS ti, SUM(tokens_out) AS to_, SUM(tokens_in+tokens_out) AS t ' +
    'FROM token_usage WHERE task_id IS NOT NULL GROUP BY task_id ORDER BY t DESC'
  ).all();
  const perTaskAgent = db.prepare(
    'SELECT task_id, agent, SUM(tokens_in) AS ti, SUM(tokens_out) AS to_ ' +
    'FROM token_usage WHERE task_id IS NOT NULL GROUP BY task_id, agent ORDER BY task_id, (SUM(tokens_in)+SUM(tokens_out)) DESC'
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
