// 测试侧契约校验（第 11 项第 1 条）：把「响应形状」写成会失败的断言，
// 而不是可选链——可选链会把契约变更吞成 undefined，然后测试继续绿。
export class ContractError extends Error {
  constructor(message, detail) {
    super(message);
    this.name = 'ContractError';
    this.detail = detail || null;
  }
}

function isObject(v) { return v !== null && typeof v === 'object' && !Array.isArray(v); }

// bus_tasks 的分页契约：{items, count, next_cursor, has_more}（第 13 项第 3 条定稿）。
export function taskPagePayload(ct) {
  if (!isObject(ct)) throw new ContractError('bus_tasks 响应不是对象', ct);
  if (!Array.isArray(ct.items)) {
    const legacy = Array.isArray(ct.tasks) ? '（检测到旧字段 tasks：分页改造已把它改成 items）' : '';
    throw new ContractError('bus_tasks 响应缺少 items 数组' + legacy, ct);
  }
  if (typeof ct.count !== 'number') throw new ContractError('bus_tasks 响应缺少 number 类型的 count', ct);
  if (typeof ct.has_more !== 'boolean') throw new ContractError('bus_tasks 响应缺少 boolean 类型的 has_more', ct);
  if (!('next_cursor' in ct)) throw new ContractError('bus_tasks 响应缺少 next_cursor 字段（末页应为 null）', ct);
  if (ct.count !== ct.items.length) throw new ContractError('bus_tasks 的 count 与 items.length 不一致', { count: ct.count, items: ct.items.length });
  if (ct.has_more && !ct.next_cursor) throw new ContractError('has_more=true 时必须给 next_cursor', ct);
  if (!ct.has_more && ct.next_cursor) throw new ContractError('has_more=false 时 next_cursor 必须是 null', ct);
  return ct.items;
}

// 工具调用结果的信封契约（第 13 项第 2 条）：normal 有 structuredContent，业务失败带 code/message。
export function toolEnvelope(result) {
  if (!isObject(result)) throw new ContractError('工具结果不是对象', result);
  if (!Array.isArray(result.content) || !result.content.length) throw new ContractError('工具结果缺少 content 数组', result);
  if (result.content[0].type !== 'text' || typeof result.content[0].text !== 'string') throw new ContractError('content[0] 必须是 text', result.content[0]);
  if (result.isError === true) {
    const env = result.structuredContent;
    if (!isObject(env)) throw new ContractError('失败结果缺少 structuredContent 信封', result);
    if (typeof env.code !== 'string' || !env.code) throw new ContractError('失败信封缺少 code', env);
    if (typeof env.message !== 'string' || !env.message) throw new ContractError('失败信封缺少 message', env);
    return env;
  }
  if (!isObject(result.structuredContent)) throw new ContractError('成功结果缺少 structuredContent', result);
  return result.structuredContent;
}
