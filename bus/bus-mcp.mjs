#!/usr/bin/env node
// Agent Bus MCP server（零依赖，stdio JSON-RPC）。
// 启动: node bus-mcp.mjs --agent codex/main [--db path]
// 身份也可用环境变量 AGENT_BUS_ID 指定（有些宿主只让配 env）。
import readline from 'node:readline';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as S from './store.mjs';
import { validateTaskFields } from './console-server.mjs';
import { validateNetworkGrants } from './admin-config.mjs';
import { KINDS } from './redline.mjs';
import * as Creds from './auth.mjs';

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

function sweepReviews() {
  if (!S.getRuntimeState(DB).enabled) return;
  const fn = storeFn('sweepReviews');
  if (!fn) return;
  try { fn(DB, policy); } catch (e) {}
}

const TOOLS = [
  {
    name: 'bus_runtime_status',
    description: '读取 AgentBus 全局运行状态；仅 Human 可在本地控制台启用。',
    inputSchema: { type: 'object', properties: {} },
    handler: function () { return S.getRuntimeState(DB); },
  },
  {
    name: 'bus_renew_lease',
    description: '续租已认领任务；关闭排空期间仍可使用。',
    inputSchema: { type: 'object', properties: { task_id: { type: 'string' }, lease_min: { type: 'number' } }, required: ['task_id'] },
    handler: function (a) { return { ok: S.renewLease(DB, AGENT, a.task_id, a.lease_min) }; },
  },
  {
    name: 'bus_online',
    description: '查看谁在线、各自手上有几个活。开工前先调这个。',
    inputSchema: { type: 'object', properties: {} },
    handler: function () { S.heartbeat(DB, AGENT, 'idle'); return { me: AGENT, agents: S.listAgents(DB) }; },
  },
  {
    name: 'bus_send',
    description: '发送一条消息（纯信息，不产生任务）。kind 取自封闭词表: note/question/answer/status/handoff/task.progress。',
    inputSchema: {
      type: 'object',
      properties: {
        to: { type: 'string' }, kind: { type: 'string' }, body: { type: 'string' },
        thread: { type: 'string' }, refs: { type: 'object' }, reply_to: { type: 'string' }, msg_id: { type: 'string' },
      },
      required: ['to', 'kind', 'body'],
    },
    handler: function (a) {
      return S.send(DB, { sender: AGENT, to: a.to, kind: a.kind, body: a.body, thread: a.thread, refs: a.refs, reply_to: a.reply_to, msg_id: a.msg_id, hop: 1 });
    },
  },
  {
    name: 'bus_wait',
    description: '长轮询取新消息。空闲时反复调用它 —— 这是"实时"的全部秘密。timeout_ms 上限 55000。',
    inputSchema: { type: 'object', properties: { since_seq: { type: 'number' }, timeout_ms: { type: 'number' } } },
    handler: async function (a) {
      S.heartbeat(DB, AGENT, 'idle');
      return await S.waitFor(DB, AGENT, typeof a.since_seq === 'number' ? a.since_seq : undefined, a.timeout_ms == null ? 25000 : a.timeout_ms);
    },
  },
  {
    name: 'bus_tasks',
    description: '列出任务。默认只列未结束的。',
    inputSchema: { type: 'object', properties: { status: { type: 'string' }, owner: { type: 'string' }, project: { type: 'string' } } },
    handler: function (a) {
      const extra = guardFieldsById();
      const rows = S.listTasks(DB, a);
      return { tasks: rows.map(function (r) { return Object.assign({}, r, cardFields(Object.assign({}, extra[r.id], r))); }) };
    },
  },
  {
    name: 'bus_claim',
    description: '认领任务。条件更新，抢不到会返回实际 owner；write_scope 重叠会被拒。返回里带 workspace（cwd/branch），照着它干活。',
    inputSchema: { type: 'object', properties: { task_id: { type: 'string' }, lease_min: { type: 'number' } }, required: ['task_id'] },
    handler: function (a) {
      const r = S.claim(DB, AGENT, a.task_id, a.lease_min);
      S.heartbeat(DB, AGENT, r.ok ? 'busy' : 'idle');
      return r;
    },
  },
  {
    name: 'bus_update',
    description: '推进任务状态。允许迁移: claimed->in_progress->review->done，或任意->failed/cancelled。',
    inputSchema: {
      type: 'object',
      properties: { task_id: { type: 'string' }, status: { type: 'string' }, note: { type: 'string' }, expect_version: { type: 'number' } },
      required: ['task_id', 'status'],
    },
    handler: function (a) { return S.updateTask(DB, AGENT, a.task_id, a.status, a.note, a.expect_version, policy.permissions.accept); },
  },
  {
    name: 'bus_dispatch',
    description: '派活（结构化，服务端过五道守卫）。绝不要用 bus_send 假装派活。',
    inputSchema: {
      type: 'object',
      properties: {
        to: { type: 'string' }, title: { type: 'string' }, body: { type: 'string' }, project: { type: 'string' },
        write_scope: { type: 'array', items: { type: 'string' } },
        grants: { type: 'array', maxItems: 5, items: { type: 'string', maxLength: 100, enum: KINDS } },
        verify_id: { type: 'string', maxLength: 100, pattern: '^[a-z0-9._-]+$' },
        verify_cmd: { type: 'string', maxLength: 1000 },
        extra_dirs: { type: 'array', maxItems: 20, items: { type: 'string', maxLength: 500 } },
        network_grants: { type: 'array', maxItems: 8, items: { type: 'object', properties: { protocol: { type: 'string', enum: ['http', 'https'] }, host: { type: 'string', maxLength: 253 }, ports: { type: 'array', maxItems: 16, items: { type: 'number' } }, purpose: { type: 'string', maxLength: 200 } }, required: ['protocol', 'host', 'ports', 'purpose'] } },
        cost_class: { type: 'string' }, max_subagents: { type: 'number' }, depth: { type: 'number' },
      },
      required: ['to', 'title'],
    },
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
    description: '拒绝一个派来的任务，必须给理由。被派活的一方永远有拒绝权，不许沉默。',
    inputSchema: { type: 'object', properties: { task_id: { type: 'string' }, reason: { type: 'string' } }, required: ['task_id', 'reason'] },
    handler: function (a) { return S.decline(DB, AGENT, a.task_id, a.reason, policy.permissions.accept); },
  },
  {
    name: 'bus_accept',
    description: '批准一个待批任务（只有人类或 Lead 应该调用）。',
    inputSchema: { type: 'object', properties: { task_id: { type: 'string' } }, required: ['task_id'] },
    handler: function (a) { return S.accept(DB, AGENT, a.task_id, policy.permissions.accept); },
  },
  {
    name: 'bus_override',
    description: '人类放行一张红线任务：failed 的卡回到 review，并写入 guard_events 留痕。只有身份为 human 才能调用，其他 agent 一律 not_permitted。',
    inputSchema: { type: 'object', properties: { task_id: { type: 'string' }, note: { type: 'string' } }, required: ['task_id'] },
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
    description: '报告本回合消耗的 token（按"谁消耗"记账，不是按任务 owner）。Lead 派活/验收的开销也要记在 Lead 名下。',
    inputSchema: {
      type: 'object',
      properties: { task_id: { type: 'string' }, phase: { type: 'string' }, tokens_in: { type: 'number' }, tokens_out: { type: 'number' } },
      required: ['tokens_in', 'tokens_out'],
    },
    handler: function (a) { return S.recordUsage(DB, AGENT, a.task_id, a.phase, a.tokens_in, a.tokens_out); },
  },
  {
    name: 'bus_status',
    description: '当前身份、生效的策略快照、成本汇总。',
    inputSchema: { type: 'object', properties: {} },
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

async function handle(msg) {
  const id = msg.id;
  const method = msg.method;
  if (method === 'initialize') {
    return { jsonrpc: '2.0', id: id, result: {
      protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'agent-bus', version: '0.1.0' },
    } };
  }
  if (method === 'tools/list') {
    return { jsonrpc: '2.0', id: id, result: { tools: TOOLS.map(function (t) {
      return { name: t.name, description: t.description, inputSchema: t.inputSchema };
    }) } };
  }
  if (method === 'tools/call') {
    const p = msg.params || {};
    freshPolicy();
    resolveIdentity();
    if (!AUTH.ok) {
      return { jsonrpc: '2.0', id: id, result: textResult({
        ok: false, reason: AUTH.reason, message: 'AgentBus 需要有效凭据（AGENT_BUS_TOKEN）；human 不签发 MCP 凭据',
      }, true) };
    }
    const tool = byName(p.name);
    if (!tool) return { jsonrpc: '2.0', id: id, error: { code: -32601, message: 'unknown tool: ' + p.name } };
    try {
      const a = p.arguments || {};
      if (S.getRuntimeState(DB).enabled) { try { S.reapLeases(DB); } catch (e) {} }
      if (!S.getRuntimeState(DB).enabled && AGENT !== 'human') {
        const task = (a.task_id || a.thread) ? S.getTask(DB, a.task_id || a.thread) : null;
        const finishing = task && ['claimed', 'in_progress', 'review'].indexOf(task.status) >= 0;
        const allowed = ['bus_runtime_status', 'bus_status', 'bus_tasks', 'bus_online', 'bus_renew_lease'].indexOf(p.name) >= 0 ||
          (p.name === 'bus_update' && finishing) || p.name === 'bus_usage' ||
          (p.name === 'bus_send' && finishing);
        if (!allowed) return { jsonrpc: '2.0', id: id, result: textResult(S.runtimeDisabled(), true) };
      }
      const out = await tool.handler(a);
      return { jsonrpc: '2.0', id: id, result: textResult(out, out && out.ok === false) };
    } catch (e) {
      return { jsonrpc: '2.0', id: id, result: textResult({ ok: false, error: String(e && e.message || e) }, true) };
    } finally {
      sweepReviews();
    }
  }
  if (method === 'ping') return { jsonrpc: '2.0', id: id, result: {} };
  if (typeof id === 'undefined') return null;
  return { jsonrpc: '2.0', id: id, error: { code: -32601, message: 'unsupported method: ' + method } };
}

function writeOut(obj) { process.stdout.write(JSON.stringify(obj) + '\n'); }

const rl = readline.createInterface({ input: process.stdin, terminal: false });
rl.on('line', function (line) {
  const s = line.trim();
  if (!s) return;
  let msg;
  try { msg = JSON.parse(s); } catch (e) { return; }
  Promise.resolve(handle(msg)).then(function (res) { if (res) writeOut(res); })
    .catch(function (e) {
      if (msg && typeof msg.id !== 'undefined') {
        writeOut({ jsonrpc: '2.0', id: msg.id, error: { code: -32603, message: String(e && e.message || e) } });
      }
    });
});
rl.on('close', function () { process.exit(0); });

process.stderr.write('[agent-bus] ' + AGENT + ' ready, db=' + argOf('db', S.DEFAULT_DB) + '\n');
