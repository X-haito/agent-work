// MCP 输入校验（第 13 项）：手写 strict 校验，不依赖 Zod。
// 语义与 Zod 的 .strict() 对齐：**拒绝未知字段**、校验类型/枚举/长度/数量/整数，错误一次列全。
// 自己写的原因：本机无网络，装不了 @modelcontextprotocol/server 与 zod；也不塞一个假 SDK 层。

export const LIMITS = { string: 8000, short: 200, array: 50 };

export function str(options) {
  const o = options || {};
  return { kind: 'string', maxLength: o.maxLength == null ? LIMITS.string : o.maxLength, minLength: o.minLength || 0, pattern: o.pattern || null, enum: o.enum || null, optional: o.optional === true };
}
export function int(options) {
  const o = options || {};
  return { kind: 'integer', min: o.min, max: o.max, optional: o.optional === true };
}
export function bool(options) { return { kind: 'boolean', optional: (options || {}).optional === true }; }
export function arr(item, options) {
  const o = options || {};
  return { kind: 'array', item: item, maxItems: o.maxItems == null ? LIMITS.array : o.maxItems, optional: o.optional === true };
}
export function looseObject(options) { return { kind: 'object', loose: true, optional: (options || {}).optional === true }; }
export function obj(shape) {
  const keys = {};
  for (const key of Object.keys(shape || {})) keys[key] = shape[key];
  return { kind: 'object', shape: keys, loose: false, optional: false };
}

function describe(value) {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  return typeof value;
}

function checkValue(spec, value, path, errors) {
  if (value === undefined || value === null) {
    if (spec.optional) return;
    errors.push({ path: path, code: 'missing', message: path + ' 是必填字段' });
    return;
  }
  if (spec.kind === 'string') {
    if (typeof value !== 'string') { errors.push({ path: path, code: 'type', message: path + ' 必须是字符串（收到 ' + describe(value) + '）' }); return; }
    if (value.length < spec.minLength) errors.push({ path: path, code: 'min_length', message: path + ' 至少 ' + spec.minLength + ' 个字符' });
    if (value.length > spec.maxLength) errors.push({ path: path, code: 'max_length', message: path + ' 超过上限 ' + spec.maxLength + ' 个字符（收到 ' + value.length + '）' });
    if (spec.pattern && !new RegExp(spec.pattern).test(value)) errors.push({ path: path, code: 'pattern', message: path + ' 不匹配 ' + spec.pattern });
    if (spec.enum && spec.enum.indexOf(value) < 0) errors.push({ path: path, code: 'enum', message: path + ' 必须是以下之一: ' + spec.enum.join(', ') });
    return;
  }
  if (spec.kind === 'integer') {
    if (typeof value !== 'number' || !Number.isSafeInteger(value)) {
      errors.push({ path: path, code: 'integer', message: path + ' 必须是整数（收到 ' + describe(value) + (typeof value === 'number' ? ':' + value : '') + '）' });
      return;
    }
    if (spec.min != null && value < spec.min) errors.push({ path: path, code: 'min', message: path + ' 不能小于 ' + spec.min });
    if (spec.max != null && value > spec.max) errors.push({ path: path, code: 'max', message: path + ' 不能大于 ' + spec.max });
    return;
  }
  if (spec.kind === 'boolean') {
    if (typeof value !== 'boolean') errors.push({ path: path, code: 'boolean', message: path + ' 必须是布尔值' });
    return;
  }
  if (spec.kind === 'array') {
    if (!Array.isArray(value)) { errors.push({ path: path, code: 'type', message: path + ' 必须是数组' }); return; }
    if (value.length > spec.maxItems) errors.push({ path: path, code: 'max_items', message: path + ' 最多 ' + spec.maxItems + ' 项（收到 ' + value.length + '）' });
    value.forEach(function (item, index) { checkValue(spec.item, item, path + '[' + index + ']', errors); });
    return;
  }
  if (spec.kind === 'object') {
    if (typeof value !== 'object' || Array.isArray(value)) { errors.push({ path: path, code: 'type', message: path + ' 必须是对象' }); return; }
    if (spec.loose) return;
    for (const key of Object.keys(spec.shape)) checkValue(spec.shape[key], value[key], path ? path + '.' + key : key, errors);
    for (const key of Object.keys(value)) {
      if (!Object.prototype.hasOwnProperty.call(spec.shape, key)) {
        errors.push({ path: path ? path + '.' + key : key, code: 'unknown_field',
          message: (path ? path + '.' : '') + key + ' 不是该工具接受的字段（strict 模式拒绝未知字段）' });
      }
    }
    return;
  }
  errors.push({ path: path, code: 'bad_spec', message: '内部 schema 定义错误: ' + spec.kind });
}

// 返回 {ok, value, errors}；value 只保留 schema 声明过的字段。
export function validateArgs(spec, input) {
  const errors = [];
  const value = input == null ? {} : input;
  if (typeof value !== 'object' || Array.isArray(value)) {
    return { ok: false, value: null, errors: [{ path: '', code: 'type', message: 'arguments 必须是对象' }] };
  }
  checkValue(spec, value, '', errors);
  if (errors.length) return { ok: false, value: null, errors: errors };
  const clean = {};
  for (const key of Object.keys(spec.shape)) { if (value[key] !== undefined) clean[key] = value[key]; }
  return { ok: true, value: clean, errors: [] };
}

// 转成 MCP 客户端看的 JSON Schema（additionalProperties:false 明确表达 strict）。
export function toJsonSchema(spec) {
  if (!spec) return { type: 'object', properties: {}, additionalProperties: false };
  if (spec.kind === 'string') {
    const out = { type: 'string' };
    if (spec.maxLength) out.maxLength = spec.maxLength;
    if (spec.enum) out.enum = spec.enum.slice();
    if (spec.pattern) out.pattern = spec.pattern;
    return out;
  }
  if (spec.kind === 'integer') {
    const out = { type: 'integer' };
    if (spec.min != null) out.minimum = spec.min;
    if (spec.max != null) out.maximum = spec.max;
    return out;
  }
  if (spec.kind === 'boolean') return { type: 'boolean' };
  if (spec.kind === 'array') return { type: 'array', maxItems: spec.maxItems, items: toJsonSchema(spec.item) };
  if (spec.kind === 'object') {
    if (spec.loose) return { type: 'object', additionalProperties: true };
    const properties = {};
    const required = [];
    for (const key of Object.keys(spec.shape)) {
      properties[key] = toJsonSchema(spec.shape[key]);
      if (!spec.shape[key].optional) required.push(key);
    }
    const out = { type: 'object', properties: properties, additionalProperties: false };
    if (required.length) out.required = required;
    return out;
  }
  return { type: 'object' };
}
