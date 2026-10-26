// Agent Bus 本地管理控制台。只监听 127.0.0.1；所有写操作经过数据层守卫与配置校验。
import http from 'node:http';
import * as ProjectRegistry from './project-registry.mjs';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import * as S from './store.mjs';
import { assertIsolated } from './smoke-support/isolation-guard.mjs';
import * as A from './admin-config.mjs';
import * as Auth from './auth.mjs';
import * as boardUi from './board-ui.mjs';
import { renderConsole, renderDenied } from './board-ui.mjs';
import { KINDS } from './redline.mjs';
import * as Archive from './archive.mjs';
import * as Retention from './archive-retention.mjs';
import * as LogInventory from './log-inventory.mjs';
import * as MergeRunner from './merge-runner.mjs';
import { runMergeRequest } from './merge-worker.mjs';

const policyRuntime = fs.existsSync(new URL('./policy-runtime.mjs', import.meta.url)) ? await import('./policy-runtime.mjs') : null;

const COSTS = ['mechanical', 'tests', 'docs', 'standard', 'architectural', 'interface'];

// 看板会话：bootstrap token 只打印一次，之后浏览器靠 HttpOnly + SameSite=Strict 的 cookie。
const SESSION_COOKIE = 'agentbus_console_session';
const SESSION_TTL_MS = 12 * 60 * 60 * 1000;

function httpError(message, status, code) {
  const e = new Error(message);
  e.statusCode = status || 400;
  if (code) e.code = code;
  throw e;
}

function sameSecret(left, right) {
  const a = Buffer.from(String(left == null ? '' : left), 'utf8');
  const b = Buffer.from(String(right == null ? '' : right), 'utf8');
  return a.length > 0 && a.length === b.length && crypto.timingSafeEqual(a, b);
}

function parseCookies(header) {
  const out = {};
  String(header || '').split(';').forEach(function (part) {
    const at = part.indexOf('=');
    if (at < 0) return;
    const key = part.slice(0, at).trim();
    if (key) out[key] = part.slice(at + 1).trim();
  });
  return out;
}

function sessionStore() {
  const sessions = new Map();
  return {
    issue: function () {
      const id = crypto.randomBytes(32).toString('base64url');
      sessions.set(id, Date.now());
      return id;
    },
    valid: function (id) {
      const key = typeof id === 'string' ? id : '';
      const createdAt = sessions.get(key);
      if (!createdAt) return false;
      if (Date.now() - createdAt > SESSION_TTL_MS) { sessions.delete(key); return false; }
      return true;
    },
  };
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

export function validateTaskFields(input) {
  const out = {};
  const has = key => Object.prototype.hasOwnProperty.call(input, key);
  if (has('verify_id')) {
    if (typeof input.verify_id !== 'string' || input.verify_id.length > 100 || (input.verify_id && !/^[a-z0-9._-]+$/.test(input.verify_id))) httpError('verify_id 必须是最多 100 字符的验证器 ID');
    out.verify_id = input.verify_id;
  }
  if (has('verify_cmd')) {
    if (typeof input.verify_cmd !== 'string' || input.verify_cmd.length > 1000) httpError('verify_cmd 必须是最多 1000 个字符的文本');
    out.verify_cmd = input.verify_cmd;
  }
  for (const [key, limit, length] of [['extra_dirs', 20, 500], ['grants', 5, 100]]) {
    if (!has(key)) continue;
    const values = input[key];
    if (!Array.isArray(values) || values.length > limit) httpError(key + ' 必须是最多 ' + limit + ' 项的字符串数组');
    for (const value of values) {
      if (typeof value !== 'string' || !value.trim() || value.length > length) httpError(key + ' 每项必须为非空文本且不超过 ' + length + ' 个字符');
      if (key === 'grants' && !KINDS.includes(value)) httpError('grants 包含无效红线授权: ' + value);
      if (key === 'extra_dirs') {
        const absolute = path.isAbsolute(value) || path.win32.isAbsolute(value);
        if (value.includes('\0') || (!absolute && (value.split(/[\\/]/).includes('..') || /^[a-z]:/i.test(value)))) {
          httpError('extra_dirs 必须是绝对路径或项目内相对路径');
        }
      }
    }
    out[key] = values.slice();
  }
  if (has('network_grants')) {
    if (input.network_grants == null) out.network_grants = [];
    else {
      try { out.network_grants = A.validateNetworkGrants(input.network_grants); }
      catch (error) { httpError(error && error.message ? error.message : 'network_grants 无效', 400); }
    }
  }
  return out;
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
  if (!partial || has('token_budget')) out.token_budget = A.validateTokenBudget(input.token_budget);
  Object.assign(out, validateTaskFields(input));
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
  out.verify_cmd = row.verify_cmd || '';
  out.verify_id = row.verify_id || '';
  out.verify_spec_hash = row.verify_spec_hash || '';
  out.verify_spec_json = parseJson(row.verify_spec_json, null);
  out.extra_dirs = Array.isArray(row.extra_dirs) ? row.extra_dirs : parseJson(row.extra_dirs, []);
  out.redline = Array.isArray(row.redline) ? row.redline : parseJson(row.redline, []);
  out.grants = Array.isArray(row.grants) ? row.grants : parseJson(row.grants, []);
  out.network_grants = Array.isArray(row.network_grants) ? row.network_grants : parseJson(row.network_grants, []);
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

function projectList(db, options, policyPath) {
  const registry = projectRegistry(options);
  const groups = typeof S.costByProject === 'function' ? S.costByProject(db, S.loadPolicy(policyPath).lead).projects : null;
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
    let validators = {}, validators_error = '';
    const validatorRoot = directory || (path.isAbsolute(id) ? id : null);
    if (validatorRoot) { try { validators = JSON.parse(fs.readFileSync(path.join(validatorRoot, 'project.json'), 'utf8')).validators || {}; } catch(e) { if (e.code !== 'ENOENT') validators_error = '验证器配置读取失败：' + e.message; } }
    return { validators, validators_error, id, path: directory, topology: config && config.topology || (registered ? 'clone-per-agent' : null),
      agents: config && Array.isArray(config.agents) ? config.agents : [], registered, exists,
      tasks: count ? count.tasks : 0, tokens: groups ? (cost ? cost.total : 0) : null };
  });
}

const BASE_COLUMNS = 'id,title,body,project,status,owner,origin,dispatched_by,target,depth,cost_class,write_scope,' +
  'max_subagents,verify_cmd,extra_dirs,version,lease_until,decline_reason,created_at,updated_at';
const GUARD_COLUMNS = ',redline,grants,guard,changed_files,needs_human,escalated_at';

function allTasks(db) {
  const tail = ' FROM tasks ORDER BY updated_at DESC LIMIT 200';
  let rows;
  try { rows = db.prepare('SELECT ' + BASE_COLUMNS + GUARD_COLUMNS + ',verify_id,verify_spec_json,verify_spec_hash,network_grants' + tail).all(); }
  catch (e) {
    // store 的新列还没落地：逐级退回到更窄的列集合
    try { rows = db.prepare('SELECT ' + BASE_COLUMNS + GUARD_COLUMNS + ',verify_id,verify_spec_json,verify_spec_hash' + tail).all(); }
    catch (inner) { rows = db.prepare('SELECT ' + BASE_COLUMNS + tail).all(); }
  }
  return rows.map(jsonScope);
}

// 归档概况只从 store 拿（阈值、daily 合并与计数口径都在 store 里）。
// 这里一行聚合 SQL 都不写：否则归档后看板会和真实账本对不上。
function archiveOverview(db, policy) {
  if (typeof S.archiveStatus !== 'function') return null;
  try {
    const status = S.archiveStatus(db, policy);
    if (!status || typeof status !== 'object') return null;
    // 孤儿过期行的归类口径在 archive.mjs 里（与 buildPlan 同一套判定），这里只搬运计数。
    let unmanaged = null;
    try { unmanaged = typeof Archive.unmanagedSummary === 'function' ? Archive.unmanagedSummary(db, policy) : null; }
    catch (e) { unmanaged = null; }
    return Object.assign({}, status, { unmanaged: unmanaged });
  } catch (e) { return null; }
}

// 二级保留与旧日志：只读概况。缺数据就返回 null，前端显示「—」，绝不拿 0 冒充。
function retentionOverview(policy) {
  try {
    const summaryLayers = Retention.summarize(policy, {});
    return summaryLayers && typeof summaryLayers === 'object' ? summaryLayers : null;
  } catch (e) { return null; }
}

// /api/state 里只做小样本扫描（限制文件数，避免一次请求把大盘日志全哈希一遍）。
function logsOverview(db) {
  try {
    // 看板会频繁轮询：只做分类不哈希（verified 为 null，前端显示「—」），全量的 hash 校验走 /api/logs/inventory。
    const inventory = LogInventory.buildInventory(db, { limit: 200, hashFiles: false });
    return {
      root: inventory.root,
      scanned: inventory.totals.files,
      managed: inventory.totals.managed,
      unmanaged: inventory.totals.unmanaged,
      unmanaged_bytes: inventory.totals.unmanaged_bytes,
      truncated: inventory.totals.files >= 200,
      unmanaged_sample: inventory.unmanaged.slice(0, 20).map(function (row) {
        // 第 3 项：样本也带 confidence/basis —— 看板上"为什么归不了户"要能追溯
        return { relative_path: row.relative_path, size: row.size, status: row.status, confidence: row.confidence,
          reason: row.reason, inferred_task_id: row.inferred_task_id, basis_detail: row.basis && row.basis.detail };
      }),
      scanned_at: inventory.scanned_at,
    };
  } catch (e) { return null; }
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
  return { id: task.id, title: task.title, project: task.project, status: task.status, owner: task.owner, target: task.target, updated_at: task.updated_at, verify_id: task.verify_id || '', verify_spec_hash: task.verify_spec_hash || '',
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
  const tasks = db.prepare('SELECT id,title,project,status,owner,target,updated_at,decline_reason,verify_id,verify_spec_hash FROM tasks' + where + ' ORDER BY updated_at DESC,id DESC LIMIT 100').all(...values);
  function distinct(column) { return db.prepare('SELECT DISTINCT ' + column + ' AS value FROM tasks WHERE ' + column + ' IS NOT NULL AND ' + column + " != '' ORDER BY " + column).all().map(function (r) { return r.value; }); }
  return { reports: tasks.map(function (t) { return reportFor(db, t); }), total: total, limit: 100,
    filters: { projects: distinct('project'), statuses: distinct('status'), owners: distinct('owner') }, server_time: S.nowIso() };
}

function snapshot(db, projectOptions, policyPath) {
  try { S.reapLeases(db); } catch (e) {}
  const policy = S.loadPolicy(policyPath);
  return {
    tasks: allTasks(db), agents: S.listAgents(db), cost: S.costSummary(db, policy.lead),
    cost_by_project: typeof S.costByProject === 'function' ? S.costByProject(db, policy.lead) : null,
    policy_registry: policyRuntime && typeof policyRuntime.describePolicy === 'function' && Array.isArray(policyRuntime.POLICY_FIELDS) ? policyRuntime.POLICY_FIELDS : null,
    project_registry: projectList(db, projectOptions, policyPath), project_management: typeof A.createProject === 'function' && typeof A.deleteProject === 'function',
    agentbus_version: agentbusVersion(),
    lifecycle: lifecycleSnapshot(db),
    archive: archiveOverview(db, policy),
    archive_retention: retentionOverview(policy),
    logs_inventory: logsOverview(db),
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

// 写操作三要素：会话 cookie（handler 里已校验）+ CSRF 头 + 严格 Origin。缺一即 403，错误码稳定。
// Origin 只接受 loopback 的两种写法，且端口必须等于当前监听端口。
function ensureMutation(req, port, csrf) {
  if (req.headers['x-agentbus-request'] !== csrf) httpError('请求令牌无效，请刷新页面', 403, 'csrf_required');
  const accepted = ['http://127.0.0.1:' + port, 'http://localhost:' + port];
  const allowed = accepted.join(' 或 ');
  const origin = req.headers.origin;
  if (!origin) httpError('写操作必须带 Origin 头，只接受 ' + allowed, 403, 'origin_required');
  if (accepted.indexOf(origin) < 0) httpError('拒绝跨站写入：Origin 必须是 ' + allowed, 403, 'origin_mismatch');
  const type = String(req.headers['content-type'] || '');
  if (type && type.indexOf('application/json') < 0) httpError('写操作只接受 application/json', 415, 'content_type_invalid');
}

function expectOk(result) {
  if (!result || result.ok !== true) { const e = new Error((result && result.message) || '操作失败'); e.statusCode = 409; e.reason = result && result.reason; throw e; }
  return result;
}

// 人类放行：把决定交给 store.overrideTask（它负责 failed->review 与 guard_events 留痕）。
function releaseTask(db, actor, taskId, note, policyPath) {
  const fn = typeof S.overrideTask === 'function' ? S.overrideTask : null;
  if (!fn) httpError('store.overrideTask 还没落地，暂时无法放行', 503);
  const policy = S.loadPolicy(policyPath);
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

const BUS_UI_DIR = path.join(S.BUS_DIR, 'ui');

// 版本号单一来源：package.json（与 agentbus version / MCP serverInfo 同处）。
export function agentbusVersion() {
  try { return String(JSON.parse(fs.readFileSync(path.join(S.BUS_DIR, '..', 'package.json'), 'utf8')).version || '0.0.0'); }
  catch (error) { return '0.0.0'; }
}

// 真正把白名单资源写出去。版本号一致的请求给长期缓存（内容 hash 变了 URL 就变，不会撕裂）。
function serveUiAsset(requested, versionParam, res) {
  const asset = resolveUiAsset(requested);
  if (!asset) return false;
  const fresh = versionParam != null && String(versionParam) === asset.version;
  const body = fs.readFileSync(path.join(BUS_UI_DIR, asset.name));
  res.writeHead(200, {
    'content-type': asset.type,
    'cache-control': fresh ? 'public, max-age=31536000, immutable' : 'no-cache',
    'x-content-type-options': 'nosniff',
    'content-length': body.length,
    'etag': 'W/"' + asset.version + '"',
  });
  res.end(body);
  return true;
}
// 静态资源白名单：文件名 → MIME。只有这里列出来的才能被 /ui/ 服务。
export const UI_ASSET_ALLOWLIST = {
  'styles.css': 'text/css; charset=utf-8',
  'denied.css': 'text/css; charset=utf-8',
  // 第 14 项第 3 阶段：ES module 入口与拆分后的模块（显式列表，不做目录通配）
  'main.mjs': 'text/javascript; charset=utf-8',
  'api.mjs': 'text/javascript; charset=utf-8',
  'state.mjs': 'text/javascript; charset=utf-8',
  'components/dom.mjs': 'text/javascript; charset=utf-8',
  'components/dialog.mjs': 'text/javascript; charset=utf-8',
  'views/overview.mjs': 'text/javascript; charset=utf-8',
  'views/tasks.mjs': 'text/javascript; charset=utf-8',
  'views/projects.mjs': 'text/javascript; charset=utf-8',
  'views/settings.mjs': 'text/javascript; charset=utf-8',
  'views/reports.mjs': 'text/javascript; charset=utf-8',
  // 第 2 阶段的单文件实现，冻结保留用于回滚（AGENTBUS_UI_INLINE=1）
  'app.js': 'text/javascript; charset=utf-8',
};

// 路径规范化：拒绝 ..、绝对路径、盘符、编码绕过；只接受白名单里的裸文件名。
export function resolveUiAsset(requested) {
  const raw = String(requested || '');
  if (!raw || raw.length > 96) return null;
  let decoded = raw;
  try { decoded = decodeURIComponent(raw); } catch (e) { return null; }
  const backslash = String.fromCharCode(92);
  if (decoded.indexOf(backslash) >= 0 || decoded.indexOf(String.fromCharCode(0)) >= 0) return null;
  if (decoded === '.' || decoded === '..' || decoded.indexOf('..') >= 0) return null;
  if (/^[A-Za-z]:/.test(decoded) || decoded.startsWith('/')) return null;
  // 只允许一层子目录（components/… 或 views/…），且每一段都必须是非空、非 . 的名字
  const segments = decoded.split('/');
  if (segments.length > 2 || segments.some(function (s) { return !s || s === '.' || s === '..'; })) return null;
  if (!Object.prototype.hasOwnProperty.call(UI_ASSET_ALLOWLIST, decoded)) return null;
  return { name: decoded, type: UI_ASSET_ALLOWLIST[decoded], version: boardUi.uiAssetVersion(decoded) };
}

// 看板 CSP（第 14 项第 2 阶段完成后的真实形态）：
//  · 外链模式（默认）= UI_CSP_TARGET 的形态：script-src 'self'、style-src 'self'。
//    页面里已经没有任何内联 <script>/<style>，也没有 inline style 属性
//    （13 处静态改成了 class，3 处动态改成 CSSOM setProperty —— CSP 只拦 style 属性，不拦 CSSOM）；
//  · 内联模式（AGENTBUS_UI_INLINE=1 回滚）= 必须放开两处 'unsafe-inline'，否则回滚后页面直接不工作。
export function uiContentSecurityPolicy(inlineAssets, strict) {
  if (strict === true) return UI_CSP_TARGET + "; img-src 'self' data:; font-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'";
  const scriptSrc = inlineAssets ? "script-src 'self' 'unsafe-inline'" : "script-src 'self'";
  const styleSrc = inlineAssets ? "style-src 'self' 'unsafe-inline'" : "style-src 'self'";
  return ["default-src 'self'", scriptSrc, styleSrc, "connect-src 'self'",
    "img-src 'self' data:", "font-src 'self'", "base-uri 'none'", "form-action 'self'", "frame-ancestors 'none'"].join('; ');
}

// 第 14 项第 2 阶段的目标 CSP（脚本抽出去之后启用）：script-src 收紧到 'self'。
export const UI_CSP_TARGET = "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'";
// opts.policyPath：让看板读写指定的策略文件（测试用临时副本，缺省仍是真实 bus/policy.json）。
export function createBoardServer(options) {
  const opts = options || {};
  const port = Number(opts.port || 7400);
  const actor = opts.actor || 'human';
  const csrf = opts.csrf || crypto.randomBytes(24).toString('base64url');
  const db = opts.db || S.openDb(opts.dbPath);
  const sessions = sessionStore();
  const bootstrap = { token: crypto.randomBytes(32).toString('base64url') };
  let shuttingDown = false;
  const server = http.createServer(async function (req, res) {
    const u = new URL(req.url, 'http://localhost');
    const localPort = req.socket.localPort || port;
    const wantsHtml = !u.pathname.startsWith('/api/');
    const presentToken = u.searchParams.get('token');
    function audit(action, resource, result) {
      try {
        Auth.logAudit(db, { actor: actor, auth_method: 'session', action: action, resource: resource, result: result || 'ok', remote_addr: req.socket.remoteAddress });
      } catch (e) { /* 审计失败不阻断请求 */ }
    }
    try {
      // 第 14 项第 1/8 条：静态资源走白名单，只有显式列出的文件可被服务。
      // 路径规范化 + 拒绝 .. / 绝对路径 / 符号链接逃逸；找不到就 404，绝不回退到目录读取。
      if (req.method === 'GET' && u.pathname.indexOf('/ui/') === 0) {
        const requested = u.pathname.slice('/ui/'.length);
        const served = serveUiAsset(requested, u.searchParams.get('v'), res);
        if (served) return;
        res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
        res.end('not found'); return;
      }
      if (req.method === 'GET' && u.pathname === '/favicon.ico') { res.writeHead(204, { 'cache-control': 'public, max-age=86400' }); res.end(); return; }
      // 浏览器首次带 ?token= 访问：校验一次性 token，换成会话 cookie，再重定向去掉 token。
      if (req.method === 'GET' && u.pathname === '/' && presentToken != null) {
        if (!bootstrap.token) httpError('一次性登录令牌已被使用，请重启看板获取新链接', 403, 'bootstrap_token_used');
        if (!sameSecret(presentToken, bootstrap.token)) httpError('一次性登录令牌无效', 403, 'bootstrap_token_invalid');
        bootstrap.token = null;
        res.writeHead(303, {
          'cache-control': 'no-store', location: '/',
          'set-cookie': SESSION_COOKIE + '=' + sessions.issue() + '; HttpOnly; SameSite=Strict; Path=/; Max-Age=' + Math.floor(SESSION_TTL_MS / 1000),
        });
        res.end(); return;
      }
      if (!sessions.valid(parseCookies(req.headers.cookie)[SESSION_COOKIE])) {
        httpError('缺少或已过期的看板会话，请使用启动时终端打印的一次性登录链接', 403, 'session_required');
      }
      if (req.method === 'GET' && u.pathname === '/') {
        const inlineAssets = boardUi.uiInlineMode({});
        const body = renderConsole({ csrf: csrf, actor: actor, inlineAssets: inlineAssets });
        res.writeHead(200, {
          'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store',
          'content-security-policy': uiContentSecurityPolicy(inlineAssets),
          'x-frame-options': 'DENY', 'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer',
        });
        res.end(body); return;
      }
      if (req.method === 'GET' && u.pathname === '/api/state') { sendJson(res, 200, snapshot(db, opts.projectOptions, opts.policyPath)); return; }
      if (req.method === 'GET' && u.pathname === '/api/projects') { sendJson(res, 200, projectList(db, opts.projectOptions, opts.policyPath)); return; }
      if (req.method === 'GET' && u.pathname === '/api/reports') { sendJson(res, 200, taskReports(db, u.searchParams)); return; }
      if (req.method === 'GET' && u.pathname === '/api/bus/status') { sendJson(res, 200, runtimeState(db)); return; }
      if (req.method === 'GET' && u.pathname === '/api/merge-requests') {
        if (typeof S.listMergeRequests !== 'function') { sendJson(res, 200, { available: false, requests: [] }); return; }
        const filter = { project: u.searchParams.get('project') || undefined, status: u.searchParams.get('status') || undefined, open: u.searchParams.get('open') === '1' || undefined };
        sendJson(res, 200, { available: true, requests: S.listMergeRequests(db, filter) }); return;
      }
      if (req.method === 'POST' && /^\/api\/merge-requests\/[^/]+\/approve$/.test(u.pathname)) {
        if (actor !== 'human') httpError('只有 Human 可以在看板批准合并', 403);
        const id = decodeURIComponent(u.pathname.split('/')[3]);
        const body = await readJson(req);
        const result = S.approveMergeRequest(db, actor, id, Number.isInteger(body.version) ? body.version : undefined);
        if (result && result.ok) { try { auth.logAudit(db, { actor: 'human', auth_method: 'console-session', action: 'merge.approve', resource: { id }, result: 'ok' }); } catch (e) {} }
        sendJson(res, result && result.ok ? 200 : 400, result); return;
      }
      // 第 11 项第 9/12 条：批准只改状态；真正的 git 合并必须由 Human 显式点"执行合并"。
      // preflight 给出二次确认所需的全部事实（项目、两端 ref、任务、最新验证、分支、工作树）。
      const preflightMatch = u.pathname.match(/^\/api\/merge-requests\/([^/]+)\/preflight$/);
      if (req.method === 'GET' && preflightMatch) {
        const id = decodeURIComponent(preflightMatch[1]);
        const mr = S.getMergeRequest(db, id);
        if (!mr) { sendJson(res, 404, { ok: false, reason: 'not_found' }); return; }
        let repo = null;
        try { repo = await MergeRunner.repoState({ project: mr.project, projectOptions: opts.projectOptions }); }
        catch (error) { repo = { ok: false, reason: 'repo_state_failed', detail: String((error && error.message) || error) }; }
        const pre = S.mergePreflight(db, S.loadPolicy(opts.policyPath), id, { repo: repo });
        sendJson(res, pre.ok ? 200 : 400, pre); return;
      }
      const executeMatch = u.pathname.match(/^\/api\/merge-requests\/([^/]+)\/execute$/);
      if (req.method === 'POST' && executeMatch) {
        if (actor !== 'human') httpError('只有 Human 可以执行合并', 403);
        const id = decodeURIComponent(executeMatch[1]);
        const body = await readJson(req);
        let result = null;
        try {
          result = await runMergeRequest(db, S.loadPolicy(opts.policyPath), id, {
            expectPreflight: body && typeof body.preflight_hash === 'string' ? body.preflight_hash : null,
            projectOptions: opts.projectOptions, actor: actor,
          });
        } catch (error) {
          result = { ok: false, status: 'error', reason: 'worker_threw', message: String((error && error.message) || error) };
        }
        try { auth.logAudit(db, { actor: 'human', auth_method: 'console-session', action: 'merge.execute', resource: { id }, result: result && result.ok ? 'ok' : String((result && result.reason) || 'failed') }); } catch (e) {}
        sendJson(res, result && result.ok ? 200 : 400, result); return;
      }
      // 第 11 项第 13 条：崩溃遗留（merging）由 Human 决定重试或标失败；needs_human 只能由 Human 解除。
      const recoverMatch = u.pathname.match(/^\/api\/merge-requests\/([^/]+)\/recover$/);
      if (req.method === 'POST' && recoverMatch) {
        if (actor !== 'human') httpError('只有 Human 可以处理崩溃遗留的合并', 403);
        const id = decodeURIComponent(recoverMatch[1]);
        const body = await readJson(req);
        const action = String((body && body.action) || '');
        let result = null;
        if (action === 'fail') {
          const mr = S.getMergeRequest(db, id);
          result = mr ? S.finishMerge(db, id, { status: 'failed', error: String((body && body.note) || 'Human 判定为崩溃遗留') }, mr.version) : { ok: false, reason: 'not_found' };
        } else if (action === 'retry') {
          const mr = S.getMergeRequest(db, id);
          let repo = null;
          try { repo = await MergeRunner.repoState({ project: mr && mr.project, projectOptions: opts.projectOptions }); } catch (e) { repo = null; }
          result = S.resetMergeForRetry(db, id, 'human', { inMerge: !!(repo && repo.in_merge), note: 'console recover --retry' });
        } else {
          result = { ok: false, reason: 'invalid_action', message: 'action 只能是 retry 或 fail' };
        }
        try { auth.logAudit(db, { actor: 'human', auth_method: 'console-session', action: 'merge.recover', resource: { id: id, action: action }, result: result && result.ok ? 'ok' : String((result && result.reason) || 'failed') }); } catch (e) {}
        sendJson(res, result && result.ok ? 200 : 400, result); return;
      }
      const confirmMatch = u.pathname.match(/^\/api\/merge-requests\/([^/]+)\/confirm$/);
      if (req.method === 'POST' && confirmMatch) {
        if (actor !== 'human') httpError('只有 Human 可以重新确认合并', 403);
        const id = decodeURIComponent(confirmMatch[1]);
        const body = await readJson(req);
        const result = S.confirmMergeRequest(db, id, 'human', body && body.preflight_hash);
        try { auth.logAudit(db, { actor: 'human', auth_method: 'console-session', action: 'merge.confirm', resource: { id: id }, result: result && result.ok ? 'ok' : String((result && result.reason) || 'failed') }); } catch (e) {}
        sendJson(res, result && result.ok ? 200 : 400, result); return;
      }
      if (req.method === 'GET' && u.pathname === '/api/reviews') {
        if (typeof S.listReviews !== 'function') { sendJson(res, 200, { available: false, reviews: [] }); return; }
        const filter = {
          status: u.searchParams.get('status') || undefined,
          route: u.searchParams.get('route') || undefined,
          reviewer: u.searchParams.get('reviewer') || undefined,
          project: u.searchParams.get('project') || undefined,
          open: u.searchParams.get('open') === '1' || undefined,
        };
        sendJson(res, 200, { available: true, reviews: S.listReviews(db, filter), now: S.nowIso() }); return;
      }
      if (req.method === 'GET' && u.pathname === '/api/budget') {
        if (typeof S.budgetStatus !== 'function') { sendJson(res, 200, { available: false }); return; }
        const query = { agent: u.searchParams.get('agent') || undefined, project: u.searchParams.get('project') || undefined, dayKey: u.searchParams.get('day') || undefined };
        sendJson(res, 200, Object.assign({ available: true }, S.budgetStatus(db, S.loadPolicy(opts.policyPath), query))); return;
      }
      // 旧日志全量 inventory：按需查（/api/state 只给小样本），只读，不删除任何文件。
      if (req.method === 'GET' && u.pathname === '/api/logs/inventory') {
        let inventory = null;
        try { inventory = LogInventory.buildInventory(db, { limit: 2000 }); } catch (e) { inventory = null; }
        if (!inventory) { sendJson(res, 200, { available: false }); return; }
        sendJson(res, 200, { available: true, inventory: inventory }); return;
      }
      // 已归档任务的 archive path：按需单查（不随 /api/state 批量查，避免 200 次点查）。
      const taskArchive = u.pathname.match(/^\/api\/tasks\/(t-\d+)\/archive$/);
      if (req.method === 'GET' && taskArchive) {
        if (typeof S.getTaskArchive !== 'function') { sendJson(res, 200, { available: false, archive: null }); return; }
        let archive = null;
        try { archive = S.getTaskArchive(db, taskArchive[1]) || null; } catch (e) { archive = null; }
        sendJson(res, 200, { available: true, task_id: taskArchive[1], archive: archive }); return;
      }
      if (req.method === 'GET' && u.pathname === '/api/tasks') { sendJson(res, 200, snapshot(db, opts.projectOptions, opts.policyPath).tasks); return; }
      const taskGet = u.pathname.match(/^\/api\/tasks\/(t-\d+)$/);
      if (req.method === 'GET' && taskGet) {
        const task = S.getTask(db, taskGet[1]);
        if (!task) httpError('没有这个任务', 404);
        sendJson(res, 200, jsonScope(task)); return;
      }
      if (req.method !== 'GET' && req.method !== 'HEAD') ensureMutation(req, localPort, csrf);
      if (req.method === 'POST' && u.pathname === '/api/projects') {
        if (actor !== 'human') httpError('只有 Human 可以创建项目', 403);
        if (typeof A.createProject !== 'function') httpError('项目管理后端尚未可用', 503);
        const input = await readJson(req);
        if (input.validators != null) { if (typeof A.validateProjectValidators !== 'function') httpError('验证器管理后端尚未可用', 503); input.validators = A.validateProjectValidators(input.validators); }
        const created = expectOk(A.createProject(input, opts.projectOptions));
        audit('project.create', { project: (created.project && created.project.id) || String(input.id || '') });
        sendJson(res, 201, created); return;
      }
      const projectValidators = u.pathname.match(/^\/api\/projects\/([^/]+)\/validators$/);
      if (req.method === 'PUT' && projectValidators) {
        if (actor !== 'human') httpError('只有 Human 可以编辑验证器', 403);
        if (typeof A.saveProjectValidators !== 'function' || typeof A.validateProjectValidators !== 'function') httpError('验证器编辑后端尚未可用', 503);
        const body = await readJson(req);
        const projectId = decodeURIComponent(projectValidators[1]);
        const saved = expectOk(A.saveProjectValidators(projectId, A.validateProjectValidators(body.validators), opts.projectOptions));
        audit('validators.save', { project: projectId, validators: Object.keys(body.validators || {}).length });
        sendJson(res, 200, saved); return;
      }
      const projectDelete = u.pathname.match(/^\/api\/projects\/(.+)$/);
      if (req.method === 'DELETE' && projectDelete) {
        if (actor !== 'human') httpError('只有 Human 可以删除项目', 403);
        if (typeof A.deleteProject !== 'function') httpError('项目管理后端尚未可用', 503);
        const id = decodeURIComponent(projectDelete[1]);
        const count = db.prepare('SELECT count(*) AS n FROM tasks WHERE project = ? COLLATE NOCASE').get(id).n;
        if (count) httpError('项目仍有 ' + count + ' 项任务，不能删除', 409);
        const removed = expectOk(A.deleteProject(id, opts.projectOptions));
        audit('project.delete', { project: id });
        sendJson(res, 200, removed); return;
      }
      if (req.method === 'POST' && u.pathname === '/api/bus/control') {
        if (actor !== 'human') httpError('只有 Human 可以启用或关闭 AgentBus', 403);
        const body = await readJson(req);
        if (!['enable', 'disable'].includes(body.action) || (body.mode && body.mode !== 'drain')) httpError('只支持启用或排空关闭');
        if (typeof S.setRuntimeState !== 'function') httpError('运行控制后端尚未可用', 503);
        if (!Number.isSafeInteger(body.version) || body.version < 0) httpError('version 必须是非负整数');
        const control = expectOk(S.setRuntimeState(db, actor, body.action === 'enable', body.version));
        audit(body.action === 'enable' ? 'bus.enable' : 'bus.disable', { mode: body.mode || null, enabled: !!control.enabled });
        sendJson(res, 200, control); return;
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
        audit('console.shutdown', { port: localPort });
        sendJson(res, 200, { ok: true, message: '仅退出看板；AgentBus 与运行中任务保持原状态' });
        return;
      }
      if (req.method === 'POST' && u.pathname === '/api/tasks') {
        const policy = S.loadPolicy(opts.policyPath);
        const result = expectOk(S.createHumanTask(db, policy, actor, normalizeTask(await readJson(req), policy, false)));
        sendJson(res, 201, { ...result, task: jsonScope(result.task) }); return;
      }
      const taskEdit = u.pathname.match(/^\/api\/tasks\/(t-\d+)$/);
      if (req.method === 'PATCH' && taskEdit) {
        const policy = S.loadPolicy(opts.policyPath);
        const body = await readJson(req);
        const input = normalizeTask(body, policy, true);
        delete input.status;
        const current = S.getTask(db, taskEdit[1]);
        if (current && !['open', 'proposed'].includes(current.status) && ['verify_id', 'verify_cmd', 'extra_dirs', 'grants', 'network_grants'].some(key => Object.prototype.hasOwnProperty.call(input, key))) {
          httpError('结构性授权字段已锁定', 409);
        }
        const result = expectOk(S.editTask(db, policy, actor, taskEdit[1], input, Number.isInteger(body.version) ? body.version : undefined));
        sendJson(res, 200, { ...result, task: jsonScope(result.task) }); return;
      }
      const taskAction = u.pathname.match(/^\/api\/tasks\/(t-\d+)\/actions$/);
      if (req.method === 'POST' && taskAction) {
        const policy = S.loadPolicy(opts.policyPath);
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
        } else if (body.action === 'override') result = releaseTask(db, actor, id, text(body.note || '人类在控制台放行', '放行说明', 1000, true), opts.policyPath);
        else if (body.action === 'complete') result = S.updateTask(db, actor, id, 'done', text(body.note || '验收完成', '验收说明', 1000, true), version, policy.permissions.accept);
        else httpError('未知任务操作: ' + body.action);
        sendJson(res, 200, expectOk(result)); return;
      }
      if (req.method === 'PUT' && u.pathname === '/api/policy') {
        const body = await readJson(req);
        const result = A.savePolicy(body.policy, { syncLeadPermissions: body.sync_lead_permissions !== false, path: opts.policyPath });
        audit('policy.save', { path: '/api/policy', lead: result.policy && result.policy.lead, backup: !!result.backup });
        sendJson(res, 200, { ok: true, policy: result.policy, backup: result.backup }); return;
      }
      const mcp = u.pathname.match(/^\/api\/mcp\/(codex|claude|dsh)$/);
      if (req.method === 'PUT' && mcp) {
        const result = A.saveMcpProfile(mcp[1], await readJson(req));
        // 第 15 项第 10 条：改了 MCP 配置 → 该客户端必须重启才生效，写一条 restart_required。
        const savedPath = (result.profile && result.profile.path) || null;
        const savedHash = (function () {
          try { return savedPath ? crypto.createHash('sha256').update(fs.readFileSync(savedPath)).digest('hex') : null; }
          catch (e) { return null; }
        })();
        const marker = markRestartRequired(mcp[1], 'mcp_config_saved', { required_hash: savedHash });
        sendJson(res, 200, Object.assign({ ok: true }, result, { restart_required: marker })); return;
      }
      httpError('没有这个接口', 404);
    } catch (e) {
      const status = e.statusCode || 500;
      // 认证/Origin 类拒绝留痕，resource 只放方法、路径与错误码。
      if (e.code) audit('request.rejected', { method: req.method, path: u.pathname, code: e.code }, 'denied');
      if (wantsHtml && (status === 401 || status === 403)) {
        const body = renderDenied({ code: e.code || 'forbidden', hint: e.message || '' });
        res.writeHead(status, {
          'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store',
          'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'",
          'x-frame-options': 'DENY', 'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer',
        });
        res.end(body); return;
      }
      sendJson(res, status, { ok: false, error: e.message || String(e), ...(e.code ? { code: e.code } : {}), ...(e.reason ? { reason: e.reason } : {}) });
    }
  });
  server.agentBus = { db: db, csrf: csrf, actor: actor, port: port, sessions: sessions, bootstrap: bootstrap };
  return server;
}


// ---------------------------------------------------------------- 生命周期与 restart_required（第 15 项第 10 条）
// 状态落在运行目录的 lifecycle.json（本卡禁止改 schema，所以不进数据库）：
//   components: board/codex/claude/dsh 的 pid/started_at/version/nonce/心跳
//   restart_required: [{component, reason, required_hash, created_at}]
// 清除规则只有一条：**看到组件真的重启了**（board 是新 started_at；MCP 客户端是它自己的心跳晚于 created_at）。
export const LIFECYCLE_FILE = (function () {
  const file = process.env.BUS_LIFECYCLE || path.join(S.BUS_DIR, 'lifecycle.json');
  // 第 11 项：这里正是 task-67 那次"测试写进真实 lifecycle.json"的入口，现在过守卫。
  return assertIsolated('lifecycle', file, 'lifecycle 路径落到了真实文件；测试请设 BUS_LIFECYCLE。');
})();
export const LIFECYCLE_COMPONENTS = ['board', 'codex', 'claude', 'dsh'];
const COMPONENT_AGENT = { codex: 'codex/main', claude: 'claude/main', dsh: 'dsh/main' };

export function readLifecycle(file) {
  const target = file || LIFECYCLE_FILE;
  try {
    const raw = JSON.parse(fs.readFileSync(target, 'utf8'));
    return {
      version: 1,
      components: raw && typeof raw.components === 'object' && raw.components ? raw.components : {},
      restart_required: Array.isArray(raw && raw.restart_required) ? raw.restart_required : [],
      file: target,
    };
  } catch (error) {
    return { version: 1, components: {}, restart_required: [], file: target };
  }
}

export function writeLifecycle(state, file) {
  const target = (state && state.file) || file || LIFECYCLE_FILE;
  const body = { version: 1, components: (state && state.components) || {}, restart_required: (state && state.restart_required) || [] };
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const tmp = target + '.tmp-' + process.pid + '-' + Date.now();
  fs.writeFileSync(tmp, JSON.stringify(body, null, 2) + '\n');
  fs.renameSync(tmp, target);
  return target;
}

export function processAlive(pid) {
  const n = Number(pid);
  if (!Number.isInteger(n) || n <= 0) return false;
  try { process.kill(n, 0); return true; } catch (error) { return error && error.code === 'EPERM'; }
}

// record 描述"我们自己启动的进程"：pid + nonce + started_at。进程活着但记录很旧 → stale（不猜、也不杀）。
export function componentState(record, now) {
  const at = now == null ? Date.now() : now;
  if (!record || !record.pid) return { running: false, stale: false, record: record || null };
  const alive = processAlive(record.pid);
  const startedMs = Date.parse(record.started_at || '') || 0;
  const ageMs = startedMs ? at - startedMs : null;
  return {
    running: alive, stale: alive && ageMs != null && ageMs > 24 * 3600 * 1000,
    pid: Number(record.pid), started_at: record.started_at || null, version: record.version || null,
    uptime_s: ageMs == null ? null : Math.max(0, Math.round(ageMs / 1000)), record: record,
  };
}

export function recordComponent(name, patch, options) {
  const file = options && options.file;
  const state = readLifecycle(file);
  state.components[name] = Object.assign({}, state.components[name] || {}, patch || {}, { updated_at: S.nowIso() });
  writeLifecycle(state, file);
  return state.components[name];
}

export function clearComponent(name, options) {
  const file = options && options.file;
  const state = readLifecycle(file);
  if (state.components[name]) delete state.components[name];
  writeLifecycle(state, file);
  return state;
}

export function markRestartRequired(component, reason, options) {
  const o = options || {};
  if (LIFECYCLE_COMPONENTS.indexOf(component) < 0) return null;
  const state = readLifecycle(o.file);
  const existing = state.restart_required.filter(function (r) { return r.component === component; })[0];
  const entry = {
    component: component,
    reason: String(reason || 'config_changed'),
    required_hash: o.required_hash == null ? null : String(o.required_hash),
    created_at: S.nowIso(),
  };
  state.restart_required = state.restart_required.filter(function (r) { return r.component !== component; }).concat([entry]);
  writeLifecycle(state, o.file);
  return entry;
}

// 逐项自动清除：只有"真的重启了"才算，没证据就继续挂着（宁可多提示一次，也不假装已经清掉）。
export function resolveRestartRequired(db, options) {
  const o = options || {};
  const state = readLifecycle(o.file);
  if (!state.restart_required.length) return { state: state, cleared: [] };
  const agents = (function () { try { return S.listAgents(db) || []; } catch (e) { return []; } })();
  const lastSeenOf = function (component) {
    const agent = COMPONENT_AGENT[component];
    const row = agent ? agents.filter(function (a) { return a.agent_id === agent; })[0] : null;
    return row ? Date.parse(row.last_seen || '') || 0 : 0;
  };
  const boardRecord = state.components.board || null;
  const cleared = [];
  const kept = [];
  for (const entry of state.restart_required) {
    const createdAt = Date.parse(entry.created_at || '') || 0;
    let evidence = 0;
    if (entry.component === 'board') evidence = Date.parse((boardRecord && boardRecord.started_at) || '') || 0;
    else evidence = lastSeenOf(entry.component);
    if (evidence > createdAt) { cleared.push(Object.assign({ cleared_at: S.nowIso(), evidence_at: new Date(evidence).toISOString() }, entry)); continue; }
    kept.push(entry);
  }
  if (cleared.length) { state.restart_required = kept; writeLifecycle(state, o.file); }
  return { state: state, cleared: cleared };
}

// 看板侧只读快照：组件状态 + 待重启项（顺带把能证明已重启的项清掉）。
export function lifecycleSnapshot(db, options) {
  const resolved = resolveRestartRequired(db, options);
  const state = resolved.state;
  const components = LIFECYCLE_COMPONENTS.map(function (name) {
    const detail = componentState(state.components[name]);
    return {
      component: name, running: detail.running, stale: detail.stale, pid: detail.pid || null,
      started_at: detail.started_at || null, version: detail.version || null, uptime_s: detail.uptime_s,
      last_heartbeat: name === 'board' ? (state.components.board && state.components.board.last_heartbeat) || null : null,
    };
  });
  return {
    file: state.file,
    components: components,
    restart_required: state.restart_required.map(function (r) {
      return {
        component: r.component, reason: r.reason, required_hash: r.required_hash, created_at: r.created_at,
        command: r.component === 'board' ? 'agentbus restart --component board' : '重启 ' + r.component + ' 客户端（重启后这条会自动消失）',
      };
    }),
    cleared_now: resolved.cleared,
  };
}

export const DEFAULT_BOARD_PORT = 7400;

// 端口解析（第 3 项）：只有"没给"才用默认值；显式 0 是合法的"让系统分配"，不能被当成空值。
// 非法值返回可操作的错误，不静默回退——静默回退会让人以为服务在 7400，其实在别处。
export function resolveBoardPort(value) {
  if (value == null || value === '') return { ok: true, port: DEFAULT_BOARD_PORT, explicit: false };
  const num = Number(value);
  if (!Number.isInteger(num) || num < 0 || num > 65535) {
    return { ok: false, reason: 'invalid_port',
      message: '端口必须是 0-65535 的整数（收到 ' + JSON.stringify(value) + '）；传 0 表示让系统分配，留空表示用 ' + DEFAULT_BOARD_PORT };
  }
  return { ok: true, port: num, explicit: true };
}

export function startConsole(options) {
  const opts = options || {};
  const resolved = resolveBoardPort(opts.port);
  if (!resolved.ok) {
    const err = new Error(resolved.message);
    err.reason = resolved.reason;
    throw err;
  }
  const port = resolved.port;
  const actor = opts.actor || 'human';
  const server = createBoardServer({ port: port, actor: actor, dbPath: opts.dbPath, policyPath: opts.policyPath, projectOptions: opts.projectOptions });
  // 第 9 项：启动即门禁。项目 registry 不合格（有 active 任务却没登记 / 没有潜在 reviewer 等）
  // 就拒绝启动，而不是让人以为服务起来了、任务却永远卡在 pending 评审。
  if (opts.allowUnreadyProjects !== true) {
    const audit = ProjectRegistry.auditProjects(server.agentBus.db, S.loadPolicy(), {});
    if (!audit.ok) {
      try { server.close(); } catch (error) {}
      try { server.agentBus.db.close(); } catch (error) {}
      const err = new Error('项目 registry 未就绪（fail-closed）：' + audit.errors.map(function (f) { return (f.project || '-') + '/' + f.code + ' ' + f.message; }).join('；'));
      err.reason = 'project_readiness_failed';
      err.audit = audit;
      throw err;
    }
  }
  S.reapLeases(server.agentBus.db, true);
  server.listen(port, '127.0.0.1', function () {
    // listen(0) 之后真实端口只认 address()，绝不回退打印 0。
    const bound = server.address().port;
    process.stderr.write('[board] http://127.0.0.1:' + bound + '  actor=' + actor + '\n');
    // 一次性登录链接只在这里打印一次；不写日志文件、不进响应体、不入审计。
    if (server.agentBus.bootstrap.token) {
      process.stderr.write('[board] 一次性登录链接（仅本次启动有效）: http://127.0.0.1:' + bound + '/?token=' + server.agentBus.bootstrap.token + '\n');
    }
  });
  return server;
}
