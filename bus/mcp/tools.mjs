// MCP 工具定义（第 13 项）：从 bus-mcp.mjs 里拆出来的协议层。
// 每个工具声明 title / description / inputSchema / outputSchema / 四个 annotations。
// 输入校验走 ./schemas.mjs（strict：拒绝未知字段），返回统一走 toolResult()。
// 注意：本机无网络，**没有**迁移到官方 @modelcontextprotocol/server——这里仍是零依赖的 JSON-RPC 实现。
import * as SC from './schemas.mjs';

const MAX_CONTENT = 6000;   // 人类可读摘要的长度上限
const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

const READ = Object.freeze({ readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false });
const WRITE = Object.freeze({ readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false });
const WRITE_IDEMPOTENT = Object.freeze({ readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false });

function annotate(readOnly, idempotent) {
  return readOnly ? READ : (idempotent ? WRITE_IDEMPOTENT : WRITE);
}

const objectOutput = function (properties, required) {
  return { type: 'object', properties: properties || {}, required: required || [], additionalProperties: true };
};
const S = SC.str, I = SC.int, B = SC.bool, A = SC.arr, O = SC.obj;

// ---- 统一错误信封 ----
// 业务失败：{ok:false, code, message, remedy, details} + isError:true。
const ERROR_CODES = {
  invalid_arguments: '参数不合法（strict 校验拒绝）',
  not_authenticated: '缺少有效凭据',
  not_permitted: '当前身份没有这个权限',
  not_available: '依赖的 store 能力还没落地',
  runtime_disabled: '总线处于关闭（排空）状态',
  internal_error: '服务端异常',
};

export function normalizeError(error) {
  if (typeof error === 'string') error = { code: 'internal_error', message: error };
  const e = error || {};
  const code = String(e.code || e.error || 'internal_error');
  const envelope = {
    ok: false,
    code: code,
    message: String(e.message || ERROR_CODES[code] || '调用失败').slice(0, 2000),
    remedy: e.remedy == null ? (ERROR_CODES[code] || '') : String(e.remedy).slice(0, 1000),
    details: e.details == null ? null : JSON.parse(JSON.stringify(e.details).slice(0, 4000)),
  };
  // 兼容别名：老消费者按 reason 判断（例如 auth_required / guard_G1_unauthorized），别把语义抹掉。
  if (e.reason != null) envelope.reason = String(e.reason).slice(0, 200);
  // 其它顶层字段原样带出去（例如 runtimeDisabled() 的 mode），错误信封不该丢掉调用方需要的状态。
  for (const key of Object.keys(e)) {
    if (key === 'ok' || key === 'code' || key === 'error' || key === 'message' || key === 'remedy' || key === 'details' || key === 'reason') continue;
    envelope[key] = e[key];
  }
  return envelope;
}

function summarize(data) {
  let text;
  try { text = JSON.stringify(data); } catch (e) { text = '{}'; }
  if (typeof text !== 'string') text = '{}';
  if (text.length > MAX_CONTENT) text = text.slice(0, MAX_CONTENT) + '…（已截断，完整内容见 structuredContent）';
  return text;
}

// 正常结果：structuredContent=data + 有长度上限的 content 摘要。
// 失败结果：content 里放人话，structuredContent 放统一错误信封，isError=true。
// content[0].text 依旧是「结构化结果的 JSON」，只是**封顶**在 MAX_CONTENT；
// 老消费者（把 text 当 JSON 解析）因此继续工作，同时长度不再无界。
export function toolResult(data, error) {
  if (error) {
    const envelope = normalizeError(error);
    return { content: [{ type: 'text', text: summarize(envelope) }], structuredContent: envelope, isError: true };
  }
  return { content: [{ type: 'text', text: summarize(data) }], structuredContent: data == null ? {} : data, isError: false };
}

// ---- (updated_at, id) 稳定游标 ----
// 不用 offset：翻页期间新增/更新任务不会造成重复或漏项，游标是 opaque 的 base64url。
export function encodeCursor(row) {
  if (!row) return null;
  const payload = JSON.stringify({ u: String(row.updated_at || ''), i: String(row.id || '') });
  return Buffer.from(payload, 'utf8').toString('base64url');
}

export function decodeCursor(cursor) {
  if (cursor == null || cursor === '') return null;
  try {
    const raw = Buffer.from(String(cursor), 'base64url').toString('utf8');
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed.u !== 'string' || typeof parsed.i !== 'string') return { error: 'cursor 结构不对（需要 {updated_at, id}）' };
    return { u: parsed.u, i: parsed.i };
  } catch (e) {
    return { error: 'cursor 不是合法的 base64url JSON' };
  }
}

// 只读分页查询（store.mjs 不在本卡 scope，所以在这里用已导出的 db 句柄自己查）。
export function pageTasks(db, options) {
  const o = options || {};
  const limit = Math.min(Math.max(Number.isInteger(o.limit) ? o.limit : DEFAULT_LIMIT, 1), MAX_LIMIT);
  const marker = decodeCursor(o.cursor);
  if (marker && marker.error) return { ok: false, code: 'invalid_arguments', message: marker.error, remedy: 'cursor 必须原样返回上一次的 next_cursor' };
  const where = [];
  const args = [];
  if (o.status) { where.push('status = ?'); args.push(String(o.status)); }
  else { where.push("status NOT IN ('done','failed','declined','cancelled')"); }
  if (o.owner) { where.push('owner = ?'); args.push(String(o.owner)); }
  if (o.project) { where.push('project = ?'); args.push(String(o.project)); }
  if (marker) {
    where.push("(COALESCE(updated_at,'') > ? OR (COALESCE(updated_at,'') = ? AND id > ?))");
    args.push(marker.u, marker.u, marker.i);
  }
  const sql = 'SELECT * FROM tasks WHERE ' + where.join(' AND ') + " ORDER BY COALESCE(updated_at,'') ASC, id ASC LIMIT ?";
  let rows;
  try { rows = db.prepare(sql).all(...args, limit + 1); }
  catch (e) { return { ok: false, code: 'internal_error', message: '分页查询失败: ' + String((e && e.message) || e) }; }
  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;
  const decorate = typeof o.decorate === 'function' ? o.decorate : function (row) { return row; };
  const items = page.map(function (row) { return decorate(row); });
  return {
    ok: true,
    items: items,
    count: items.length,
    next_cursor: hasMore ? encodeCursor(page[page.length - 1]) : null,
    has_more: hasMore,
    limit: limit,
  };
}

// ---- 工具表 ----
const SPECS = [
  {
    name: 'bus_runtime_status',
    title: '总线运行状态',
    description: '读取 AgentBus 全局运行状态；仅 Human 可在本地控制台启用。',
    input: O({}),
    output: objectOutput({ enabled: { type: 'boolean' }, changed_at: { type: 'string' }, changed_by: { type: 'string' } }, ['enabled']),
    annotations: annotate(true, true),
  },
  {
    name: 'bus_renew_lease',
    title: '续租任务',
    description: '续租已认领任务；关闭排空期间仍可使用。',
    input: O({ task_id: S({ maxLength: 200 }), lease_min: I({ min: 1, max: 1440, optional: true }) }),
    output: objectOutput({ ok: { type: 'boolean' } }, ['ok']),
    annotations: annotate(false, false),
  },
  {
    name: 'bus_online',
    title: '在线成员与负载',
    description: '查看谁在线、各自手上有几个活。开工前先调这个。',
    input: O({}),
    output: objectOutput({ me: { type: 'string' }, agents: { type: 'array', items: { type: 'object' } } }, ['me']),
    annotations: annotate(false, true),
  },
  {
    name: 'bus_send',
    title: '发送消息',
    description: '发送一条消息（纯信息，不产生任务）。kind 取自封闭词表: note/question/answer/status/handoff/task.progress。带 msg_id 时服务端按它去重，重试安全。',
    input: O({
      to: S({ maxLength: 200 }), kind: S({ maxLength: 40, enum: ['note', 'question', 'answer', 'status', 'handoff', 'task.progress'] }), body: S({ maxLength: 8000 }),
      thread: S({ maxLength: 200, optional: true }), refs: SC.looseObject({ optional: true }), reply_to: S({ maxLength: 200, optional: true }), msg_id: S({ maxLength: 200, optional: true }),
    }),
    output: objectOutput({ id: { type: 'string' }, seq: { type: 'number' } }),
    annotations: annotate(false, true),
  },
  {
    name: 'bus_wait',
    title: '长轮询取消息',
    description: '长轮询取新消息。空闲时反复调用它 —— 这是"实时"的全部秘密。timeout_ms 上限 55000。',
    input: O({ since_seq: I({ min: 0, optional: true }), timeout_ms: I({ min: 0, max: 55000, optional: true }) }),
    output: objectOutput({ messages: { type: 'array', items: { type: 'object' } }, seq: { type: 'number' } }),
    annotations: annotate(true, true),
  },
  {
    name: 'bus_tasks',
    title: '列出任务（游标分页）',
    description: '列出任务，默认只列未结束的。按 (updated_at, id) 稳定游标分页：limit 默认 50、最大 200；把 next_cursor 原样传回来取下一页。',
    input: O({
      status: S({ maxLength: 40, optional: true }), owner: S({ maxLength: 200, optional: true }), project: S({ maxLength: 200, optional: true }),
      limit: I({ min: 1, max: MAX_LIMIT, optional: true }), cursor: S({ maxLength: 500, optional: true }),
    }),
    output: objectOutput({
      items: { type: 'array', items: { type: 'object' } },
      count: { type: 'integer' },
      next_cursor: { type: ['string', 'null'] }, has_more: { type: 'boolean' },
    }, ['items', 'count', 'has_more']),
    annotations: annotate(true, true),
    paginated: true,
  },
  {
    name: 'bus_claim',
    title: '认领任务',
    description: '认领任务。条件更新，抢不到会返回实际 owner；write_scope 重叠会被拒。返回里带 workspace（cwd/branch），照着它干活。',
    input: O({ task_id: S({ maxLength: 200 }), lease_min: I({ min: 1, max: 1440, optional: true }) }),
    output: objectOutput({ ok: { type: 'boolean' }, owner: { type: 'string' }, reason: { type: 'string' }, workspace: { type: 'object' } }),
    annotations: annotate(false, false),
  },
  {
    name: 'bus_update',
    title: '推进任务状态',
    description: '推进任务状态。允许迁移: claimed->in_progress->review->done，或任意->failed/cancelled。带 expect_version 做乐观锁。',
    input: O({ task_id: S({ maxLength: 200 }), status: S({ maxLength: 40 }), note: S({ maxLength: 8000, optional: true }), expect_version: I({ min: 0, optional: true }) }),
    output: objectOutput({ ok: { type: 'boolean' }, status: { type: 'string' }, version: { type: 'integer' } }),
    annotations: annotate(false, false),
  },
  {
    name: 'bus_dispatch',
    title: '派活',
    description: '派活（结构化，服务端过五道守卫）。绝不要用 bus_send 假装派活。',
    input: O({
      to: S({ maxLength: 200 }), title: S({ maxLength: 500 }), body: S({ maxLength: 8000, optional: true }), project: S({ maxLength: 200, optional: true }),
      write_scope: A(S({ maxLength: 500 }), { maxItems: 30, optional: true }),
      grants: A(S({ maxLength: 100, enum: ['dep:install', 'fs:delete', 'git:risky', 'cfg:edit', 'net:egress'] }), { maxItems: 5, optional: true }),
      verify_id: S({ maxLength: 100, pattern: '^[a-z0-9._-]+$', optional: true }),
      verify_cmd: S({ maxLength: 1000, optional: true }),
      extra_dirs: A(S({ maxLength: 500 }), { maxItems: 20, optional: true }),
      cost_class: S({ maxLength: 40, optional: true }),
      max_subagents: I({ min: 0, max: 20, optional: true }),
      depth: I({ min: 0, max: 5, optional: true }),
    }),
    output: objectOutput({ ok: { type: 'boolean' }, task_id: { type: 'string' }, status: { type: 'string' } }),
    annotations: annotate(false, false),
  },
  {
    name: 'bus_decline',
    title: '拒绝任务',
    description: '拒绝一个派来的任务，必须给理由。被派活的一方永远有拒绝权，不许沉默。',
    input: O({ task_id: S({ maxLength: 200 }), reason: S({ maxLength: 2000, minLength: 1 }) }),
    output: objectOutput({ ok: { type: 'boolean' }, status: { type: 'string' } }),
    annotations: annotate(false, false),
  },
  {
    name: 'bus_accept',
    title: '批准待批任务',
    description: '批准一个待批任务（只有人类或 Lead 应该调用）。',
    input: O({ task_id: S({ maxLength: 200 }) }),
    output: objectOutput({ ok: { type: 'boolean' }, status: { type: 'string' } }),
    annotations: annotate(false, true),
  },
  {
    name: 'bus_override',
    title: '人类放行红线任务',
    description: '人类放行一张红线任务：failed 的卡回到 review，并写入 guard_events 留痕。只有身份为 human 才能调用，其他 agent 一律 not_permitted。',
    input: O({ task_id: S({ maxLength: 200 }), note: S({ maxLength: 2000, optional: true }) }),
    output: objectOutput({ ok: { type: 'boolean' }, status: { type: 'string' } }),
    annotations: annotate(false, true),
  },
  {
    name: 'bus_usage',
    title: '上报 Token 用量',
    description: '报告本回合消耗的 token（按"谁消耗"记账，不是按任务 owner）。Lead 派活/验收的开销也要记在 Lead 名下。',
    input: O({ task_id: S({ maxLength: 200, optional: true }), phase: S({ maxLength: 60, optional: true }), tokens_in: I({ min: 0, max: 100000000 }), tokens_out: I({ min: 0, max: 100000000 }) }),
    output: objectOutput({ ok: { type: 'boolean' } }),
    annotations: annotate(false, false),
  },
  {
    name: 'bus_reviews',
    title: '列出评审分配',
    description: '列出评审分配。Worker 默认只看自己的；Lead 默认看全部。Human 路由的评审只在看板处理，这里只读。',
    input: O({ status: S({ maxLength: 40, optional: true }), reviewer: S({ maxLength: 200, optional: true }), task_id: S({ maxLength: 200, optional: true }), route: S({ maxLength: 40, optional: true }) }),
    output: objectOutput({ ok: { type: 'boolean' }, me: { type: 'string' }, reviews: { type: 'array', items: { type: 'object' } } }),
    annotations: annotate(true, true),
  },
  {
    name: 'bus_claim_review',
    title: '认领评审',
    description: '认领一份评审分配。owner 不得自审，非 review 路由不认领，同一份评审只能被一个人认领（第二个人会被拒）。',
    input: O({ review_id: S({ maxLength: 200 }), expect_version: I({ min: 0, optional: true }) }),
    output: objectOutput({ ok: { type: 'boolean' } }),
    annotations: annotate(false, false),
  },
  {
    name: 'bus_submit_review',
    title: '提交评审结论',
    description: '提交评审结论（approved / changes_requested）。必须带 review version 防覆盖他人结论；Human 路由的评审只能在看板处理。',
    input: O({
      review_id: S({ maxLength: 200 }), verdict: S({ maxLength: 40, enum: ['approved', 'changes_requested'] }),
      summary: S({ maxLength: 4000, optional: true }), version: I({ min: 0 }),
    }),
    output: objectOutput({ ok: { type: 'boolean' } }),
    annotations: annotate(false, true),
  },
  {
    name: 'bus_merge_requests',
    title: '列出合并申请',
    description: '列出合并申请。批准与执行只在看板由 Human 完成，MCP 只读。',
    input: O({ status: S({ maxLength: 40, optional: true }), task_id: S({ maxLength: 200, optional: true }) }),
    output: objectOutput({ ok: { type: 'boolean' }, merge_requests: { type: 'array', items: { type: 'object' } } }),
    annotations: annotate(true, true),
  },
  {
    name: 'bus_request_merge',
    title: '发起合并申请',
    description: '发起合并申请（不执行合并）。能否发起由 policy.permissions.request_merge 决定。',
    input: O({ task_id: S({ maxLength: 200 }), summary: S({ maxLength: 2000, optional: true }) }),
    output: objectOutput({ ok: { type: 'boolean' }, id: { type: 'string' }, status: { type: 'string' } }),
    annotations: annotate(false, false),
  },
  {
    name: 'bus_status',
    title: '当前身份与成本',
    description: '当前身份、生效的策略快照、成本汇总。',
    input: O({}),
    output: objectOutput({ me: { type: 'string' }, policy: { type: 'object' }, cost: { type: 'object' } }),
    annotations: annotate(true, true),
  },
];

const BY_NAME = new Map(SPECS.map(function (s) { return [s.name, s]; }));

export function specOf(name) { return BY_NAME.get(String(name || '')) || null; }
export function allSpecs() { return SPECS.slice(); }

// tools/list 的条目：不含内部 input spec，只给 JSON Schema + 元信息。
export function listTools() {
  return SPECS.map(function (s) {
    return {
      name: s.name,
      title: s.title,
      description: s.description,
      inputSchema: SC.toJsonSchema(s.input),
      outputSchema: s.output,
      annotations: Object.assign({}, s.annotations),
    };
  });
}

export function validateArgs(name, args) {
  const spec = specOf(name);
  if (!spec) return { ok: false, errors: [{ path: 'name', code: 'unknown_tool', message: '未知工具: ' + name }] };
  return SC.validateArgs(spec.input, args);
}

export { DEFAULT_LIMIT, MAX_LIMIT, MAX_CONTENT };
