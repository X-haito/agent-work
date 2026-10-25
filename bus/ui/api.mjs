// 统一请求层（第 14 项第 3 阶段）：CSRF 头、JSON 解析、错误码、AbortController。
export class HttpError extends Error {
  constructor(message, status, payload) {
    super(message);
    this.name = 'HttpError';
    this.status = status || 0;
    this.payload = payload === undefined ? null : payload;
  }
}

let csrf = '';
export function setCsrf(value) { csrf = String(value || ''); }

const inflight = new Map();
// 同一 url 的旧请求在发新请求前中止（切页面/连点不会把旧响应画到新界面上）。
export async function api(url, opt) {
  opt = opt || {};
  const key = String(url);
  if (inflight.has(key)) { try { inflight.get(key).abort(); } catch (e) {} inflight.delete(key); }
  const controller = typeof AbortController === 'function' ? new AbortController() : null;
  if (controller) inflight.set(key, controller);
  opt.headers = Object.assign({ accept: 'application/json' }, opt.headers || {});
  if (opt.body) {
    opt.headers['content-type'] = 'application/json';
    opt.headers['x-agentbus-request'] = csrf;
    opt.body = JSON.stringify(opt.body);
  }
  if (controller) opt.signal = controller.signal;
  try {
    const r = await fetch(url, opt);
    const data = await r.json().catch(function () { return { error: '响应不是 JSON（HTTP ' + r.status + '）' }; });
    if (!r.ok) throw new HttpError(data.error || data.message || ('HTTP ' + r.status), r.status, data);
    return data;
  } finally {
    if (controller && inflight.get(key) === controller) inflight.delete(key);
  }
}
