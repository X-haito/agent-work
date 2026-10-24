// Agent Bus 本地管理控制台。只监听 127.0.0.1；所有写操作经过数据层守卫与配置校验。
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import * as S from './store.mjs';
import * as A from './admin-config.mjs';
import { renderConsole } from './board-ui.mjs';

const COSTS = ['mechanical', 'tests', 'docs', 'standard', 'architectural', 'interface'];

function httpError(message, status) {
  const e = new Error(message);
  e.statusCode = status || 400;
  throw e;
}

function text(v, name, max, required) {
  if (v == null) {
    if (required) httpError(name + ' 不能为空');
    return '';
  }
  if (typeof v !== 'string') httpError(name + ' 必须是文本');
  const s = v.trim();
  if (required && !s) httpError(name + ' 不能为空');
  if (s.length > max) httpError(name + ' 最多 ' + max + ' 个字符');
  return s;
}

function int(v, name, min, max) {
  const n = Number(v);
  if (!Number.isInteger(n) || n < min || n > max) httpError(name + ' 必须是 ' + min + '–' + max + ' 的整数');
  return n;
}

function scopes(v) {
  const list = Array.isArray(v) ? v : typeof v === 'string' ? v.split(/[\r\n,]+/) : [];
  return list.map(function (x) { return String(x).trim(); }).filter(Boolean).map(function (x) {
    if (x.length > 300 || /^[a-zA-Z]:[\\/]/.test(x) || x.startsWith('/') || x.split(/[\\/]/).indexOf('..') >= 0) {
      httpError('写作用域必须是项目内的相对路径或 glob: ' + x);
    }
    return x.split('\\').join('/');
  }).filter(function (x, i, all) { return all.indexOf(x) === i; });
}

function normalizeTask(input, policy, partial) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) httpError('任务数据无效');
  const out = {};
  function has(k) { return Object.prototype.hasOwnProperty.call(input, k); }
  if (!partial || has('title')) out.title = text(input.title, '标题', 200, true);
  if (!partial || has('body')) out.body = text(input.body || '', '说明', 12000, false);
  if (!partial || has('project')) out.project = text(input.project || 'default', '项目', 300, true);
  if (!partial || has('target')) {
    out.target = input.target ? text(input.target, '目标 Agent', 120, true) : null;
    if (out.target && !policy.agents[out.target]) httpError('目标 Agent 不存在: ' + out.target);
  }
  if (!partial || has('cost_class')) {
    out.cost_class = text(input.cost_class || 'standard', '成本档位', 40, true);
    if (COSTS.indexOf(out.cost_class) < 0) httpError('成本档位无效: ' + out.cost_class);
  }
  if (!partial || has('write_scope')) out.write_scope = scopes(input.write_scope);
  if (!partial || has('max_subagents')) out.max_subagents = int(input.max_subagents == null ? 0 : input.max_subagents, '子代理上限', 0, 5);
  if (!partial || has('status')) out.status = input.status === 'proposed' ? 'proposed' : 'open';
  return out;
}

function parseJson(raw, def) {
  if (raw == null || raw === '') return def;
  if (typeof raw === 'object') return raw;
  try { return JSON.parse(raw); } catch (e) { return def; }
}

function jsonScope(row) {
  const out = Object.assign({}, row);
  out.write_scope = Array.isArray(row.write_scope) ? row.write_scope : parseJson(row.write_scope, []);
  out.redline = Array.isArray(row.redline) ? row.redline : parseJson(row.redline, []);
  out.grants = Array.isArray(row.grants) ? row.grants : parseJson(row.grants, []);
  out.guard = row.guard && typeof row.guard === 'object' ? row.guard : parseJson(row.guard, null);
  out.changed_files = Number(row.changed_files) || 0;
  out.needs_human = row.needs_human ? 1 : 0;
  out.escalated_at = row.escalated_at || null;
  return out;
}

// 放行 = 把 failed 的卡拉回 review；needs_human 的 review 卡人类直接用"验收完成"。
function needsHumanRelease(task) {
  return !!task && task.status === 'failed';
}

function projectRegistry(options) {
  if (typeof A.readProjectsRegistry === 'function') return A.readProjectsRegistry(options).projects;
  const file = options && options.path || path.join(S.BUS_DIR, 'projects.json');
  const json = JSON.parse(fs.readFileSync(file, 'utf8'));
  return json.projects || {};
}

function projectList(db, options) {
  const registry = projectRegistry(options);
  const groups = typeof S.costByProject === 'function' ? S.costByProject(db, S.loadPolicy().lead).projects : null;
  const counts = db.prepare('SELECT project,count(*) AS tasks FROM tasks GROUP BY project').all();
  const ids = [...new Set(Object.keys(registry).concat(counts.map(r => r.project)))].sort();
  return ids.map(function (id) {
    const registered = Object.prototype.hasOwnProperty.call(registry, id);
    const config = registered ? registry[id] : null;
    const directory = typeof config === 'string' ? config : config && config.path || null;
    let exists = false;
    try { exists = !!directory && fs.statSync(directory).isDirectory(); } catch (e) {}
    const cost = groups && groups.find(p => p.project === id);
    const count = counts.find(p => p.project === id);
    return { id, path: directory, topology: config && config.topology || (registered ? 'clone-per-agent' : null),
      agents: config && Array.isArray(config.agents) ? config.agents : [], registered, exists,
      tasks: count ? count.tasks : 0, tokens: groups ? (cost ? cost.total : 0) : null };
  });
}

const BASE_COLUMNS = 'id,title,body,project,status,owner,origin,dispatched_by,target,depth,cost_class,write_scope,' +
  'max_subagents,version,lease_until,decline_reason,created_at,updated_at';
const GUARD_COLUMNS = ',redline,grants,guard,changed_files,needs_human,escalated_at';

function allTasks(db) {
  const tail = ' FROM tasks ORDER BY updated_at DESC LIMIT 200';
  let rows;
  try { rows = db.prepare('SELECT ' + BASE_COLUMNS + GUARD_COLUMNS + tail).all(); }
  catch (e) { rows = db.prepare('SELECT ' + BASE_COLUMNS + tail).all(); } // store 的新列还没落地
  return rows.map(jsonScope);
}

function runtimeState(db) {
  if (typeof S.getRuntimeState !== 'function') return { enabled: false, mode: 'unavailable', active_tasks: 0 };
  return S.getRuntimeState(db);
}

function summary(value, max = 600) {
  const raw = typeof value === 'string' ? value : value == null ? '' : JSON.stringify(value);
  const compact = raw.replace(/\s+/g, ' ').trim();
  return { summary: compact.slice(0, max), truncated: compact.length > max };
}

function reportFor(db, task) {
  const rows = db.prepare('SELECT seq,ts,sender,kind,body,refs FROM messages WHERE thread = ? ORDER BY seq DESC LIMIT 40').all(task.id);
  const logPaths = new Set();
  const events = rows.map(function (m) {
    const refs = parseJson(m.refs, {}) || {};
    ['log_path', 'log', 'logs', 'artifact_path', 'report_path'].forEach(function (key) {
      const values = Array.isArray(refs[key]) ? refs[key] : [refs[key]];
      values.filter(function (v) { return typeof v === 'string'; }).forEach(function (v) { logPaths.add(v.slice(0, 1000)); });
    });
    const body = parseJson(m.body, null);
    if (body && typeof body === 'object') ['log_path', 'report_path'].forEach(function (key) { if (typeof body[key] === 'string') logPaths.add(body[key].slice(0, 1000)); });
    const paths = String(m.body || '').match(/(?:[A-Za-z]:[\\/]|\/|(?:bus[\\/])?(?:logs?|reports?|artifacts?)[\\/])[^\s"<>|]+\.(?:log|txt|json|md)/g) || [];
    paths.slice(0, 10).forEach(function (p) { logPaths.add(p.slice(0, 1000)); });
    return { seq: m.seq, ts: m.ts, sender: m.sender, kind: m.kind, ...summary(m.body), test_evidence: summary(refs.test_evidence || refs.tests || (body && (body.test_evidence || body.tests)) || '').summary };
  });
  let guards = [];
  try { guards = db.prepare('SELECT ts,kind,detail,action,actor FROM guard_events WHERE task_id = ? ORDER BY id DESC LIMIT 10').all(task.id).map(function (g) { return { ts: g.ts, kind: g.kind, action: g.action, actor: g.actor, ...summary(g.detail) }; }); } catch (e) {}
  const progress = events.find(function (e) { return /^task\.(progress|in_progress|review|done|failed|cancelled|declined)$/.test(e.kind); });
  const evidence = events.filter(function (e) { return e.test_evidence || /test|smoke|verify|pass|fail|测试|验收|验证/i.test(e.summary); }).slice(0, 8);
  const failure = events.find(function (e) { return /\.(failed|declined|cancelled)$/.test(e.kind); });
  return { id: task.id, title: task.title, project: task.project, status: task.status, owner: task.owner, target: task.target, updated_at: task.updated_at,
    progress: progress ? progress.summary : '尚未提交进度', progress_truncated: !!(progress && progress.truncated),
    test_evidence: evidence, failure_reason: ['failed', 'declined', 'cancelled'].includes(task.status) ? summary(task.decline_reason || (failure && failure.summary) || (guards[0] && guards[0].summary) || '尚未报告失败原因').summary : '',
    log_paths: [...logPaths].slice(0, 20), events: events.slice(0, 12), guard_events: guards };
}

function taskReports(db, params) {
  const filters = ['project', 'status', 'owner'].filter(function (k) { return params.get(k); });
  const clauses = filters.map(function (k) { return k + ' = ?'; });
  if (params.get('task')) clauses.push('id = ?');
  const values = filters.map(function (k) { return params.get(k); });
  if (params.get('task')) values.push(params.get('task'));
  const where = clauses.length ? ' WHERE ' + clauses.join(' AND ') : '';
  const total = db.prepare('SELECT count(*) AS n FROM tasks' + where).get(...values).n;
  const tasks = db.prepare('SELECT id,title,project,status,owner,target,updated_at,decline_reason FROM tasks' + where + ' ORDER BY updated_at DESC,id DESC LIMIT 100').all(...values);
  function distinct(column) { return db.prepare('SELECT DISTINCT ' + column + ' AS value FROM tasks WHERE ' + column + ' IS NOT NULL AND ' + column + " != '' ORDER BY " + column).all().map(function (r) { return r.value; }); }
  return { reports: tasks.map(function (t) { return reportFor(db, t); }), total: total, limit: 100,
    filters: { projects: distinct('project'), statuses: distinct('status'), owners: distinct('owner') }, server_time: S.nowIso() };
}

function snapshot(db, projectOptions) {
  try { S.reapLeases(db); } catch (e) {}
  const policy = S.loadPolicy();
  return {
    tasks: allTasks(db), agents: S.listAgents(db), cost: S.costSummary(db, policy.lead),
    cost_by_project: typeof S.costByProject === 'function' ? S.costByProject(db, policy.lead) : null,
    project_registry: projectList(db, projectOptions), project_management: typeof A.createProject === 'function' && typeof A.deleteProject === 'function',
    runtime: runtimeState(db), policy: policy, projects: Object.keys(projectRegistry(projectOptions)).sort(), mcp: A.readMcpProfiles(), server_time: S.nowIso(),
  };
}

function sendJson(res, status, value) {
  const body = JSON.stringify(value);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store',
    'content-length': Buffer.byteLength(body),
  });
  res.end(body);
}

function readJson(req) {
  return new Promise(function (resolve, reject) {
    const chunks = [];
    let size = 0;
    req.on('data', function (chunk) {
      size += chunk.length;
      if (size > 262144) { reject(Object.assign(new Error('请求体超过 256 KB'), { statusCode: 413 })); req.destroy(); return; }
      chunks.push(chunk);
    });
    req.on('end', function () {
      try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}); }
      catch (e) { reject(Object.assign(new Error('JSON 格式无效'), { statusCode: 400 })); }
    });
    req.on('error', reject);
  });
}

function ensureMutation(req, port, csrf) {
  if (req.headers['x-agentbus-request'] !== csrf) httpError('请求令牌无效，请刷新页面', 403);
  const origin = req.headers.origin;
  if (origin && origin !== 'http://127.0.0.1:' + port && origin !== 'http://localhost:' + port) httpError('拒绝跨站写入', 403);
  const type = String(req.headers['content-type'] || '');
  if (type && type.indexOf('application/json') < 0) httpError('写操作只接受 application/json', 415);
}

function expectOk(result) {
  if (!result || result.ok !== true) httpError((result && result.message) || '操作失败', 409);
  return result;
}

// 人类放行：把决定交给 store.overrideTask（它负责 failed->review 与 guard_events 留痕）。
function releaseTask(db, actor, taskId, note) {
  const fn = typeof S.overrideTask === 'function' ? S.overrideTask : null;
  if (!fn) httpError('store.overrideTask 还没落地，暂时无法放行', 503);
  const policy = S.loadPolicy();
  let direct = null;
  try {
    const row = db.prepare('SELECT id,status,redline,grants,guard,changed_files,needs_human,escalated_at FROM tasks WHERE id = ?').get(taskId);
    direct = row ? jsonScope(row) : null;
  } catch (e) { direct = null; } // 新列未落地：交给 store 自己判定
  const found = direct || S.getTask(db, taskId);
  if (!found) httpError('没有这个任务', 404);
  // 新列读不到时 direct 为 null，判定交给 store.overrideTask 自己
  if (direct && !needsHumanRelease(direct)) httpError('只有 failed 的任务可以放行回 review，当前是 ' + direct.status, 409);
  const r = fn(db, actor, taskId, note, policy.permissions.accept) || {};
  if (r.ok === false) return r;
  return Object.assign({}, r, { ok: true, message: '已放行，记录在 guard_events' });
}

export function createBoardServer(options) {
  const opts = options || {};
  const port = Number(opts.port || 7400);
  const actor = opts.actor || 'human';
  const csrf = opts.csrf || crypto.randomBytes(24).toString('base64url');
  const db = opts.db || S.openDb(opts.dbPath);
  let shuttingDown = false;
  const server = http.createServer(async function (req, res) {
    const u = new URL(req.url, 'http://localhost');
    try {
      if (req.method === 'GET' && u.pathname === '/favicon.ico') { res.writeHead(204, { 'cache-control': 'public, max-age=86400' }); res.end(); return; }
      if (req.method === 'GET' && u.pathname === '/') {
        const body = renderConsole({ csrf: csrf, actor: actor });
        res.writeHead(200, {
          'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store',
          'content-security-policy': "default-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
          'x-frame-options': 'DENY', 'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer',
        });
        res.end(body); return;
      }
      if (req.method === 'GET' && u.pathname === '/api/state') { sendJson(res, 200, snapshot(db, opts.projectOptions)); return; }
      if (req.method === 'GET' && u.pathname === '/api/projects') { sendJson(res, 200, projectList(db, opts.projectOptions)); return; }
      if (req.method === 'GET' && u.pathname === '/api/reports') { sendJson(res, 200, taskReports(db, u.searchParams)); return; }
      if (req.method === 'GET' && u.pathname === '/api/bus/status') { sendJson(res, 200, runtimeState(db)); return; }
      if (req.method === 'GET' && u.pathname === '/api/tasks') { sendJson(res, 200, snapshot(db, opts.projectOptions).tasks); return; }
      const taskGet = u.pathname.match(/^\/api\/tasks\/(t-\d+)$/);
      if (req.method === 'GET' && taskGet) {
        const task = S.getTask(db, taskGet[1]);
        if (!task) httpError('没有这个任务', 404);
        sendJson(res, 200, jsonScope(task)); return;
      }
      if (req.method !== 'GET' && req.method !== 'HEAD') ensureMutation(req, req.socket.localPort || port, csrf);
      if (req.method === 'POST' && u.pathname === '/api/projects') {
        if (actor !== 'human') httpError('只有 Human 可以创建项目', 403);
        if (typeof A.createProject !== 'function') httpError('项目管理后端尚未可用', 503);
        sendJson(res, 201, expectOk(A.createProject(await readJson(req), opts.projectOptions))); return;
      }
      const projectDelete = u.pathname.match(/^\/api\/projects\/(.+)$/);
      if (req.method === 'DELETE' && projectDelete) {
        if (actor !== 'human') httpError('只有 Human 可以删除项目', 403);
        if (typeof A.deleteProject !== 'function') httpError('项目管理后端尚未可用', 503);
        const id = decodeURIComponent(projectDelete[1]);
        const count = db.prepare('SELECT count(*) AS n FROM tasks WHERE project = ? COLLATE NOCASE').get(id).n;
        if (count) httpError('项目仍有 ' + count + ' 项任务，不能删除', 409);
        sendJson(res, 200, expectOk(A.deleteProject(id, opts.projectOptions))); return;
      }
      if (req.method === 'POST' && u.pathname === '/api/bus/control') {
        if (actor !== 'human') httpError('只有 Human 可以启用或关闭 AgentBus', 403);
        const body = await readJson(req);
        if (!['enable', 'disable'].includes(body.action) || (body.mode && body.mode !== 'drain')) httpError('只支持启用或排空关闭');
        if (typeof S.setRuntimeState !== 'function') httpError('运行控制后端尚未可用', 503);
        if (!Number.isSafeInteger(body.version) || body.version < 0) httpError('version 必须是非负整数');
        sendJson(res, 200, expectOk(S.setRuntimeState(db, actor, body.action === 'enable', body.version))); return;
      }
      if (req.method === 'POST' && u.pathname === '/api/console/shutdown') {
        if (actor !== 'human') httpError('只有 Human 可以退出看板程序', 403);
        if (shuttingDown) httpError('看板正在退出', 409);
        shuttingDown = true;
        res.once('finish', function () {
          server.close(function () { if (!opts.db) db.close(); });
          // 强制释放残留 keep-alive 连接，避免进程因浏览器连接未断开而滞留
          if (typeof server.closeIdleConnections === 'function') server.closeIdleConnections();
          setTimeout(function () { if (typeof server.closeAllConnections === 'function') server.closeAllConnections(); }, 300);
        });
        sendJson(res, 200, { ok: true, message: '仅退出看板；AgentBus 与运行中任务保持原状态' });
        return;
      }
      if (req.method === 'POST' && u.pathname === '/api/tasks') {
        const policy = S.loadPolicy();
        const result = expectOk(S.createHumanTask(db, policy, actor, normalizeTask(await readJson(req), policy, false)));
        sendJson(res, 201, result); return;
      }
      const taskEdit = u.pathname.match(/^\/api\/tasks\/(t-\d+)$/);
      if (req.method === 'PATCH' && taskEdit) {
        const policy = S.loadPolicy();
        const body = await readJson(req);
        const input = normalizeTask(body, policy, true);
        delete input.status;
        const result = expectOk(S.editTask(db, policy, actor, taskEdit[1], input, Number.isInteger(body.version) ? body.version : undefined));
        sendJson(res, 200, result); return;
      }
      const taskAction = u.pathname.match(/^\/api\/tasks\/(t-\d+)\/actions$/);
      if (req.method === 'POST' && taskAction) {
        const policy = S.loadPolicy();
        const body = await readJson(req);
        const id = taskAction[1];
        const version = Number.isInteger(body.version) ? body.version : undefined;
        let result;
        if (body.action === 'accept') result = S.accept(db, actor, id, policy.permissions.accept);
        else if (body.action === 'decline') result = S.decline(db, actor, id, text(body.reason || '人类在控制台拒绝', '拒绝理由', 1000, true), policy.permissions.accept);
        else if (body.action === 'cancel') result = S.cancelTask(db, policy, actor, id, text(body.reason || '人类在控制台取消', '取消理由', 1000, true), version);
        else if (body.action === 'reassign') {
          const target = text(body.target || '', '目标 Agent', 120, true);
          if (!policy.agents[target]) httpError('目标 Agent 不存在: ' + target);
          result = S.reassignTask(db, policy, actor, id, target, version);
        } else if (body.action === 'override') result = releaseTask(db, actor, id, text(body.note || '人类在控制台放行', '放行说明', 1000, true));
        else if (body.action === 'complete') result = S.updateTask(db, actor, id, 'done', text(body.note || '验收完成', '验收说明', 1000, true), version, policy.permissions.accept);
        else httpError('未知任务操作: ' + body.action);
        sendJson(res, 200, expectOk(result)); return;
      }
      if (req.method === 'PUT' && u.pathname === '/api/policy') {
        const body = await readJson(req);
        const result = A.savePolicy(body.policy, { syncLeadPermissions: body.sync_lead_permissions !== false });
        sendJson(res, 200, { ok: true, policy: result.policy, backup: result.backup }); return;
      }
      const mcp = u.pathname.match(/^\/api\/mcp\/(codex|claude|dsh)$/);
      if (req.method === 'PUT' && mcp) {
        const result = A.saveMcpProfile(mcp[1], await readJson(req));
        sendJson(res, 200, Object.assign({ ok: true }, result)); return;
      }
      httpError('没有这个接口', 404);
    } catch (e) {
      sendJson(res, e.statusCode || 500, { ok: false, error: e.message || String(e) });
    }
  });
  server.agentBus = { db: db, csrf: csrf, actor: actor, port: port };
  return server;
}

export function startConsole(options) {
  const opts = options || {};
  const port = Number(opts.port || 7400);
  const actor = opts.actor || 'human';
  const server = createBoardServer({ port: port, actor: actor, dbPath: opts.dbPath });
  S.reapLeases(server.agentBus.db, true);
  server.listen(port, '127.0.0.1', function () {
    process.stderr.write('[board] http://127.0.0.1:' + port + '  actor=' + actor + '\n');
  });
  return server;
}
