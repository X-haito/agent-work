#!/usr/bin/env node
// Agent Bus MCP server（零依赖，stdio JSON-RPC）。
// 启动: node bus-mcp.mjs --agent codex/main [--db path]
// 身份也可用环境变量 AGENT_BUS_ID 指定（有些宿主只让配 env）。
import fs from 'node:fs';
import readline from 'node:readline';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as S from './store.mjs';
import { validateTaskFields } from './console-server.mjs';
import { validateNetworkGrants } from './admin-config.mjs';
import { KINDS } from './redline.mjs';
import * as Creds from './auth.mjs';
import * as MCP from './mcp/tools.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));

function argOf(name, def) {
  const i = process.argv.indexOf('--' + name);
  if (i >= 0 && process.argv[i + 1] && process.argv[i + 1].slice(0, 2) !== '--') return process.argv[i + 1];
  const eq = process.argv.filter(function (a) { return a.indexOf('--' + name + '=') === 0; })[0];
  if (eq) return eq.slice(name.length + 3);
  return def;
}

// 身份以凭据为准：--agent 只是提示。human 永不签发凭据，因此 --agent human 拿不到 Human 权限。
const TOKEN = process.env.AGENT_BUS_TOKEN || argOf('token', '');
let AGENT = argOf('agent', process.env.AGENT_BUS_ID || 'unknown');
const DB = S.openDb(argOf('db', S.DEFAULT_DB));
let policy = S.loadPolicy();
function freshPolicy() { try { policy = S.loadPolicy(); } catch (e) {} return policy; }

let AUTH = { ok: false, reason: 'auth_required', enforced: false, method: 'none' };
function resolveIdentity() {
  const enforced = !!(policy && policy.global && policy.global.require_credentials === true);
  if (TOKEN) {
    const verified = Creds.verifyCredential(DB, TOKEN);
    if (verified.ok) { AGENT = verified.agent; AUTH = { ok: true, agent: verified.agent, enforced: enforced, method: 'token' }; return; }
    AUTH = { ok: false, reason: verified.reason, enforced: enforced, method: 'token' };
    return;
  }
  AUTH = enforced
    ? { ok: false, reason: 'auth_required', enforced: true, method: 'none' }
    : { ok: true, agent: AGENT, enforced: false, method: 'legacy' };
}
resolveIdentity();
if (AUTH.ok) S.heartbeat(DB, AGENT, 'idle');

function textResult(obj, isError) {
  return { content: [{ type: 'text', text: JSON.stringify(obj, null, 2) }], isError: !!isError };
}

// ---- 红线 / 护卫字段 ----
// store 侧的新列与新函数由 guard-core 落地，可能比本文件晚；读不到就按旧数据兜底。
function storeFn(name) { const fn = S[name]; return typeof fn === 'function' ? fn : null; }

function parseJson(raw, def) {
  if (raw == null || raw === '') return def;
  if (typeof raw === 'object') return raw;
  try { return JSON.parse(raw); } catch (e) { return def; }
}

function guardFieldsById() {
  const map = {};
  try {
    const rows = DB.prepare('SELECT id,redline,grants,guard,changed_files,needs_human,escalated_at FROM tasks').all();
    for (const r of rows) map[r.id] = r;
  } catch (e) { /* 老库还没有这些列 */ }
  return map;
}

function cardFields(row) {
  const redline = parseJson(row && row.redline, []);
  const grants = parseJson(row && row.grants, []);
  const guard = parseJson(row && row.guard, null);
  const changed = Number(row && row.changed_files);
  return {
    verify_cmd: (row && row.verify_cmd) || '',
    verify_id: (row && row.verify_id) || null,
    verify_spec_hash: (row && row.verify_spec_hash) || null,
    extra_dirs: parseJson(row && row.extra_dirs, []),
    redline: Array.isArray(redline) ? redline.map(String) : [],
    grants: Array.isArray(grants) ? grants.map(String) : [],
    guard: guard && typeof guard === 'object' ? guard : null,
    changed_files: Number.isFinite(changed) && changed > 0 ? changed : 0,
    needs_human: row && row.needs_human ? 1 : 0,
    escalated_at: (row && row.escalated_at) || null,
  };
}

function staleReviewCount() {
  try {
    const r = DB.prepare("SELECT COUNT(*) AS n FROM tasks WHERE status = 'review' AND COALESCE(escalated_at,'') <> ''").get();
    return Number(r && r.n) || 0;
  } catch (e) { return 0; }
}

// reviews 表由第 9 项数据层落地；读不到就返回 null，交给 storeFn 的 not_available 处理。
function reviewRowOf(reviewId) {
  try { return DB.prepare('SELECT id,task_id,reviewer,route,status,task_version FROM reviews WHERE id=?').get(String(reviewId || '')) || null; }
  catch (e) { return null; }
}

// 合并权限只用于提示"你能否发起申请"；批准与执行永远只在看板上由 Human 完成。
function canRequestMerge() {
  const allow = (policy && policy.permissions && policy.permissions.merge) || [];
  return Array.isArray(allow) && (allow.indexOf(AGENT) >= 0 || AGENT === 'human');
}

function sweepReviews() {
  if (!S.getRuntimeState(DB).enabled) return;
  const fn = storeFn('sweepReviews');
  if (!fn) return;
  try { fn(DB, policy); } catch (e) {}
}

// 仅作 handler 注册表：name → handler（参数已由 bus/mcp/tools.mjs 的 strict schema 校验过）。
// 元信息（title/description/inputSchema/outputSchema/annotations）单一来源 = bus/mcp/tools.mjs。
const TOOLS = [
  {
    name: 'bus_runtime_status',
    handler: function () { return S.getRuntimeState(DB); },
  },
  {
    name: 'bus_renew_lease',
    handler: function (a) { return { ok: S.renewLease(DB, AGENT, a.task_id, a.lease_min) }; },
  },
  {
    name: 'bus_online',
    handler: function () { S.heartbeat(DB, AGENT, 'idle'); return { me: AGENT, agents: S.listAgents(DB) }; },
  },
  {
    name: 'bus_send',
    handler: function (a) {
      return S.send(DB, { sender: AGENT, to: a.to, kind: a.kind, body: a.body, thread: a.thread, refs: a.refs, reply_to: a.reply_to, msg_id: a.msg_id, hop: 1 });
    },
  },
  {
    name: 'bus_wait',
    handler: async function (a) {
      S.heartbeat(DB, AGENT, 'idle');
      return await S.waitFor(DB, AGENT, typeof a.since_seq === 'number' ? a.since_seq : undefined, a.timeout_ms == null ? 25000 : a.timeout_ms);
    },
  },
  {
    name: 'bus_tasks',
    handler: function (a) {
      const extra = guardFieldsById();
      return MCP.pageTasks(DB, {
        limit: a.limit, cursor: a.cursor, status: a.status, owner: a.owner, project: a.project,
        decorate: function (r) { return Object.assign({}, r, cardFields(Object.assign({}, extra[r.id], r))); },
      });
    },
  },
  {
    name: 'bus_claim',
    handler: function (a) {
      const r = S.claim(DB, AGENT, a.task_id, a.lease_min);
      S.heartbeat(DB, AGENT, r.ok ? 'busy' : 'idle');
      return r;
    },
  },
  {
    name: 'bus_update',
    handler: function (a) { return S.updateTask(DB, AGENT, a.task_id, a.status, a.note, a.expect_version, policy.permissions.accept); },
  },
  {
    name: 'bus_dispatch',
    handler: function (a) {
      Object.assign(a, validateTaskFields(a));
      // grants 是本次派发放宽红线的白名单（kind 列表），可选；去掉它仍是旧的派发语义。
      const d = Object.assign({}, a);
      if (Array.isArray(d.grants)) d.grants = d.grants.map(function (g) { return String(g).trim(); }).filter(Boolean);
      else delete d.grants;
      if (Object.prototype.hasOwnProperty.call(d, 'verify_cmd') && AGENT !== 'human') return { ok: false, reason: 'legacy_verify_cmd_forbidden', message: 'Agent 不得提交自由 verify_cmd，请使用项目已登记的 verify_id' };
      if (Object.prototype.hasOwnProperty.call(d, 'verify_cmd') && d.verify_cmd && !d.verify_id) d.status = 'proposed';
      if (Object.prototype.hasOwnProperty.call(d, 'network_grants')) {
        d.network_grants = validateNetworkGrants(d.network_grants);
        if (d.network_grants.length) d.status = 'proposed'; // 联网必须 Human 批准
      }
      const result = S.dispatch(DB, policy, AGENT, d);
      if (result.task) result.task = { ...result.task, ...cardFields(result.task), extra_dirs: parseJson(result.task.extra_dirs, []), network_grants: parseJson(result.task.network_grants, []) };
      return result;
    },
  },
  {
    name: 'bus_decline',
    handler: function (a) { return S.decline(DB, AGENT, a.task_id, a.reason, policy.permissions.accept); },
  },
  {
    name: 'bus_accept',
    handler: function (a) { return S.accept(DB, AGENT, a.task_id, policy.permissions.accept); },
  },
  {
    name: 'bus_override',
    handler: function (a) {
      if (AGENT !== 'human') {
        return { ok: false, error: 'not_permitted', message: '红线任务只能由人类放行（当前身份 ' + AGENT + '）' };
      }
      const fn = storeFn('overrideTask');
      if (!fn) return { ok: false, error: 'not_available', message: 'store.overrideTask 还没落地，暂时无法放行' };
      const note = typeof a.note === 'string' && a.note.trim() ? a.note.trim() : '人类在 MCP 放行';
      const r = fn(DB, AGENT, a.task_id, note, policy.permissions.accept) || {};
      if (r.ok === false) return r;
      return Object.assign({}, r, { ok: true, message: '已放行，记录在 guard_events' });
    },
  },
  {
    name: 'bus_usage',
    handler: function (a) { return S.recordUsage(DB, AGENT, a.task_id, a.phase, a.tokens_in, a.tokens_out); },
  },
  {
    name: 'bus_reviews',
    handler: function (a) {
      const fn = storeFn('listReviews');
      if (!fn) return { ok: false, error: 'not_available', message: 'store.listReviews 还没落地，评审队列暂不可用' };
      const base = {};
      if (a.status) base.status = a.status;
      if (a.route) base.route = a.route;
      if (a.task_id) base.task_id = a.task_id;
      if (a.reviewer) base.reviewer = a.reviewer;
      const lead = String(policy.lead || '');
      let reviews;
      try {
        if (a.reviewer || AGENT === lead) reviews = fn(DB, base);
        else {
          // Worker 只看自己那份 + 还没被认领的 peer 队列；human/auto 路由不在 MCP 里排队。
          const mine = fn(DB, Object.assign({}, base, { reviewer: AGENT }));
          // 调用方只有在"要 active"或"要非 peer 路由"时才不该看到可认领的 peer 队列。
          const wantsQueue = (!a.status || a.status === 'pending') && (!a.route || a.route === 'peer');
          const queue = wantsQueue ? fn(DB, Object.assign({}, base, { status: 'pending', route: 'peer' })).filter(function (r) { return !r.reviewer; }) : [];
          const seen = new Set();
          reviews = [];
          for (const r of mine.concat(queue)) { const key = String(r.id); if (seen.has(key)) continue; seen.add(key); reviews.push(r); }
        }
      } catch (e) { return { ok: false, error: String(e && e.message || e) }; }
      return { ok: true, me: AGENT, reviews: Array.isArray(reviews) ? reviews : [] };
    },
  },
  {
    name: 'bus_claim_review',
    handler: function (a) {
      const fn = storeFn('claimReview');
      if (!fn) return { ok: false, error: 'not_available', message: 'store.claimReview 还没落地，评审认领暂不可用' };
      const row = reviewRowOf(a.review_id);
      if (row && row.route === 'human') return { ok: false, reason: 'human_route_board_only', message: 'Human 路由的评审只能在看板由人处理，MCP 不暴露审批能力' };
      try { return fn(DB, AGENT, a.review_id, a.expect_version); } catch (e) { return { ok: false, error: String(e && e.message || e) }; }
    },
  },
  {
    name: 'bus_submit_review',
    handler: function (a) {
      if (!Number.isSafeInteger(a.version) || a.version < 0) {
        return { ok: false, reason: 'review_version_required', message: '提交评审必须带 review version（并发下的乐观锁，不能用 0 或缺省蒙过去）' };
      }
      const fn = storeFn('submitReview');
      if (!fn) return { ok: false, error: 'not_available', message: 'store.submitReview 还没落地，评审提交暂不可用' };
      const row = reviewRowOf(a.review_id);
      if (row && row.route === 'human') return { ok: false, reason: 'human_route_board_only', message: 'Human 路由的评审只能在看板由人处理，MCP 不暴露审批能力' };
      try { return fn(DB, AGENT, a.review_id, { verdict: a.verdict, summary: a.summary, version: a.version }); }
      catch (e) { return { ok: false, error: String(e && e.message || e) }; }
    },
  },
  {
    name: 'bus_merge_requests',
    handler: function (a) {
      const fn = storeFn('listMergeRequests');
      if (!fn) return { ok: false, error: 'not_available', message: 'store.listMergeRequests 还没落地，合并队列暂不可用' };
      let requests;
      try {
        requests = fn(DB, { project: a.project || undefined, status: a.status || undefined, open: a.open === true || undefined });
      } catch (e) { return { ok: false, error: String(e && e.message || e) }; }
      return { ok: true, me: AGENT, can_request: canRequestMerge(), approve_and_execute: 'human_on_board_only', requests: Array.isArray(requests) ? requests : [] };
    },
  },
  {
    name: 'bus_request_merge',
    handler: function (a) {
      const fn = storeFn('createMergeRequest');
      if (!fn) return { ok: false, error: 'not_available', message: 'store.createMergeRequest 还没落地，暂时不能提出合并请求' };
      if (!Array.isArray(a.task_ids) || !a.task_ids.length) return { ok: false, reason: 'no_tasks', message: '合并请求必须关联至少一个任务' };
      let result;
      try {
        result = fn(DB, policy, AGENT, { project: a.project, task_ids: a.task_ids, source_ref: a.source_ref, target_ref: a.target_ref });
      } catch (e) { return { ok: false, error: String(e && e.message || e) }; }
      return Object.assign({ note: '已登记为 proposed：批准必须由 Human 在看板完成，执行由本地 merge runner 进行' }, result || {});
    },
  },
  {
    name: 'bus_status',
    handler: function () {
      return {
        runtime: S.getRuntimeState(DB),
        me: AGENT, my_config: policy.agents[AGENT] || null, lead: policy.lead || null,
        permissions: policy.permissions, global: policy.global, economics: policy.economics,
        cost: S.costSummary(DB, policy.lead),
        stale_reviews: staleReviewCount(),
      };
    },
  },
];

function byName(n) { return TOOLS.filter(function (t) { return t.name === n; })[0]; }

// 版本号单一来源：package.json（与 bin/files/engines 同处）。以前这里手写 '0.1.0'，会和 agentbus version 分叉。
const AGENTBUS_VERSION = (function () {
  try { return String(JSON.parse(fs.readFileSync(path.join(HERE, '..', 'package.json'), 'utf8')).version || '0.0.0'); }
  catch (error) { return '0.0.0'; }
})();

async function handle(msg) {
  const id = msg.id;
  const method = msg.method;
  if (method === 'initialize') {
    return { jsonrpc: '2.0', id: id, result: {
      protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'agent-bus', version: AGENTBUS_VERSION },
    } };
  }
  if (method === 'tools/list') {
    return { jsonrpc: '2.0', id: id, result: { tools: MCP.listTools() } };
  }
  if (method === 'tools/call') {
    const p = msg.params || {};
    freshPolicy();
    resolveIdentity();
    if (!AUTH.ok) {
      return { jsonrpc: '2.0', id: id, result: MCP.toolResult(null, {
        code: AUTH.reason || 'not_authenticated',
        reason: AUTH.reason,
        message: 'AgentBus 需要有效凭据（AGENT_BUS_TOKEN）；human 不签发 MCP 凭据',
        remedy: 'agentbus credentials rotate <client> 后用 AGENT_BUS_TOKEN 启动 MCP',
      }) };
    }
    const tool = byName(p.name);
    if (!tool) return { jsonrpc: '2.0', id: id, error: { code: -32601, message: 'unknown tool: ' + p.name } };
    // strict 校验：拒绝未知字段/超长字符串/非整数，错误一次列全（不猜、不忽略）。
    const checked = MCP.validateArgs(p.name, p.arguments || {});
    if (!checked.ok) {
      return { jsonrpc: '2.0', id: id, result: MCP.toolResult(null, {
        code: 'invalid_arguments',
        message: '参数不合法，共 ' + checked.errors.length + ' 处问题',
        remedy: '按 tools/list 里的 inputSchema 传参；strict 模式不接受未声明字段',
        details: checked.errors,
      }) };
    }
    try {
      const a = checked.value;
      if (S.getRuntimeState(DB).enabled) { try { S.reapLeases(DB); } catch (e) {} }
      if (!S.getRuntimeState(DB).enabled && AGENT !== 'human') {
        const task = (a.task_id || a.thread) ? S.getTask(DB, a.task_id || a.thread) : null;
        const finishing = task && ['claimed', 'in_progress', 'review'].indexOf(task.status) >= 0;
        const allowed = ['bus_runtime_status', 'bus_status', 'bus_tasks', 'bus_online', 'bus_renew_lease', 'bus_reviews', 'bus_merge_requests'].indexOf(p.name) >= 0 ||
          (p.name === 'bus_update' && finishing) || p.name === 'bus_usage' ||
          (p.name === 'bus_send' && finishing);
        if (!allowed) return { jsonrpc: '2.0', id: id, result: MCP.toolResult(null, Object.assign({}, S.runtimeDisabled(), {
          code: 'runtime_disabled',
          message: '总线处于关闭（排空）状态，只允许收尾类调用',
          remedy: '让 Human 在看板重新启用总线',
        })) };
      }
      const out = await tool.handler(a);
      if (out && out.ok === false) {
        return { jsonrpc: '2.0', id: id, result: MCP.toolResult(null, {
          code: out.code || out.error || out.reason || 'internal_error',
          reason: out.reason,
          message: out.message || '调用失败',
          remedy: out.remedy,
          details: out.details || null,
        }) };
      }
      return { jsonrpc: '2.0', id: id, result: MCP.toolResult(out, null) };
    } catch (e) {
      return { jsonrpc: '2.0', id: id, result: MCP.toolResult(null, { code: 'internal_error', message: String(e && e.message || e) }) };
    } finally {
      sweepReviews();
    }
  }
  if (method === 'ping') return { jsonrpc: '2.0', id: id, result: {} };
  if (typeof id === 'undefined') return null;
  return { jsonrpc: '2.0', id: id, error: { code: -32601, message: 'unsupported method: ' + method } };
}

function writeOut(obj) { process.stdout.write(JSON.stringify(obj) + '\n'); }

// 请求是异步处理的：stdin 读到 EOF 时不能直接 exit，否则最后几条响应会被吞掉
// （用文件/管道喂请求时尤其明显）。这里等在途请求清零再退出。
const rl = readline.createInterface({ input: process.stdin, terminal: false });
let pending = 0;
let closing = false;
function maybeExit() { if (closing && pending === 0) process.exit(0); }
rl.on('line', function (line) {
  const s = line.trim();
  if (!s) return;
  let msg;
  try { msg = JSON.parse(s); } catch (e) { return; }
  pending++;
  Promise.resolve(handle(msg)).then(function (res) { if (res) writeOut(res); })
    .catch(function (e) {
      if (msg && typeof msg.id !== 'undefined') {
        writeOut({ jsonrpc: '2.0', id: msg.id, error: { code: -32603, message: String(e && e.message || e) } });
      }
    })
    .finally(function () { pending--; maybeExit(); });
});
rl.on('close', function () { closing = true; maybeExit(); });

process.stderr.write('[agent-bus] ' + AGENT + ' ready, db=' + argOf('db', S.DEFAULT_DB) + '\n');
