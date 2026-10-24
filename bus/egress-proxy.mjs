// 出口代理：对 net:egress 任务做目标级审计。
// 诚实前提：本机没有 OS 级网络隔离，子进程完全可以无视 HTTP_PROXY/HTTPS_PROXY 直接建连。
// 本代理只能校验"经过它"的请求，所以每个 engine 的 capabilities().networkIsolation 都是 false，
// 联网任务一律转 proposed + needs_human。任何"白名单已强制执行"的说法都是假的。
//
// 判定全部落在 network-policy.mjs（checkTarget / resolveHost），本模块只负责
// 收流、校验、按单次连接固定 DNS 结果、记录脱敏事件，绝不自己解释 host 语义。
import http from 'node:http';
import net from 'node:net';
import { checkTarget, normalizeGrant, normalizeNetworkPolicy, resolveHost } from './network-policy.mjs';

export const EGRESS_UNENFORCEABLE = '仅审计，无法强制隔离：代理只能校验经过它的请求，无法阻止子进程绕过代理直连';
const MAX_GRANTS = 32;
const BIND_HOST = '127.0.0.1';
// 逐跳头与代理认证头不转发；Host 由 outboundHeaders 重写回原目标。
const HOP_HEADERS = ['proxy-connection', 'proxy-authorization', 'connection', 'keep-alive', 'transfer-encoding', 'upgrade'];

function defaultPort(protocol) {
  return protocol === 'https' ? 443 : 80;
}

function hostOf(url) {
  return String(url.hostname || '').replace(/^\[/, '').replace(/\]$/, '');
}

function bracket(host) {
  return net.isIP(host) === 6 ? '[' + host + ']' : host;
}

// target = { protocol, host, port }；只接受 http/https，端口缺省按协议补。
function splitTarget(raw, protocol) {
  let url;
  try { url = new URL(String(raw)); } catch (error) { return { ok: false, reason: 'target_invalid' }; }
  const scheme = String(url.protocol || '').replace(':', '').toLowerCase();
  if (scheme !== 'http' && scheme !== 'https') return { ok: false, reason: 'protocol_must_be_http_or_https' };
  if (scheme !== protocol) return { ok: false, reason: 'protocol_not_granted' };
  const host = hostOf(url);
  const port = url.port ? Number(url.port) : defaultPort(scheme);
  if (!host) return { ok: false, reason: 'target_required' };
  if (!Number.isInteger(port) || port < 1 || port > 65535) return { ok: false, reason: 'port_invalid' };
  return { ok: true, target: { protocol: scheme, host: host, port: port } };
}

// 明文 HTTP 走 absolute-form；origin-form 只能用 Host 头还原目标。
function requestTarget(req) {
  const raw = String((req && req.url) || '');
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(raw)) {
    if (raw.toLowerCase().indexOf('https://') === 0) return { ok: false, reason: 'protocol_not_granted' };
    return splitTarget(raw, 'http');
  }
  const hostHeader = String((req.headers && req.headers.host) || '').trim();
  if (!hostHeader) return { ok: false, reason: 'target_required' };
  return splitTarget('http://' + hostHeader + '/', 'http');
}

// 上游路径必须带 query（否则代理就不通了），但它只在这里出现，永不进事件。
function requestPath(req) {
  const raw = String((req && req.url) || '/');
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(raw)) {
    try { const url = new URL(raw); return (url.pathname || '/') + (url.search || ''); } catch (error) { return '/'; }
  }
  return raw.charAt(0) === '/' ? raw : '/' + raw;
}

function outboundHeaders(req, target) {
  const source = (req && req.headers) || {};
  const headers = {};
  for (const key of Object.keys(source)) {
    if (HOP_HEADERS.indexOf(key) >= 0) continue;
    headers[key] = source[key];
  }
  const host = bracket(target.host);
  headers.host = target.port === defaultPort(target.protocol) ? host : host + ':' + target.port;
  return headers;
}

// 多份 grant 里任一命中即放行；拒绝理由优先给出最具体的那一个。
function decide(grants, target) {
  if (!grants.length) return { ok: false, reason: 'grant_not_configured' };
  const reasons = [];
  for (const entry of grants) {
    const result = checkTarget(entry.grant, target);
    if (result.ok) return { ok: true, grant: entry };
    reasons.push(result.reason || 'host_not_granted');
  }
  // 理由按"最具体"报：端口 > 主机 > 协议，别让另一份不同协议的 grant 把真实原因盖掉。
  if (reasons.indexOf('port_not_granted') >= 0) return { ok: false, reason: 'port_not_granted' };
  if (reasons.indexOf('host_not_granted') >= 0) return { ok: false, reason: 'host_not_granted' };
  if (reasons.indexOf('protocol_not_granted') >= 0) return { ok: false, reason: 'protocol_not_granted' };
  return { ok: false, reason: reasons[0] };
}

function redirectTarget(location, from) {
  const raw = String(location == null ? '' : location).trim();
  if (!raw) return { ok: false, reason: 'target_required' };
  let url;
  try { url = new URL(raw, from.protocol + '://' + bracket(from.host) + ':' + from.port); } catch (error) { return { ok: false, reason: 'target_invalid' }; }
  return splitTarget(url.href, String(url.protocol || '').replace(':', '').toLowerCase());
}

function connectTarget(raw) {
  const text = String(raw == null ? '' : raw).trim();
  const match = text.match(/^\[([^\]]+)\]:(\d+)$/) || text.match(/^([^:\[\]]+):(\d+)$/);
  if (!match) return { ok: false, reason: 'target_required' };
  const port = Number(match[2]);
  if (!Number.isInteger(port) || port < 1 || port > 65535) return { ok: false, reason: 'port_invalid' };
  return { ok: true, target: { protocol: 'https', host: match[1], port: port } };
}

// HTTP_PROXY/HTTPS_PROXY 由调用方注入子进程；子进程仍可无视它们，这正是 networkIsolation=false 的原因。
export function proxyEnv(url) {
  return { HTTP_PROXY: url, HTTPS_PROXY: url, http_proxy: url, https_proxy: url };
}

// startEgressProxy({ policy, grant, log, taskId, lookup }) -> { url, close }
//   policy: 总线策略（只用 policy.network.local_services）
//   grant:  单份 network grant 或数组 { protocol, host, ports, purpose }
//   log:    接收脱敏事件的回调；本模块不碰数据库，落库由 network-policy.recordEvent 负责
//   lookup: 仅测试用，替换 DNS（生产走 network-policy 的默认 lookup）
export async function startEgressProxy(options) {
  const opts = options || {};
  const emit = typeof opts.log === 'function' ? opts.log : null;
  const lookup = typeof opts.lookup === 'function' ? opts.lookup : undefined;
  const taskId = opts.taskId == null ? null : String(opts.taskId);

  const rawGrants = opts.grant == null ? [] : (Array.isArray(opts.grant) ? opts.grant : [opts.grant]);
  const grants = [];
  const rejected = [];
  for (const item of rawGrants.slice(0, MAX_GRANTS)) {
    const normalized = normalizeGrant(item);
    if (normalized.ok) grants.push({ grant_id: (taskId || 'task') + ':' + grants.length, grant: normalized.grant });
    else rejected.push(normalized.reason);
  }
  const network = normalizeNetworkPolicy(opts.policy && opts.policy.network);
  const localServices = network.ok ? network.network.local_services : [];

  // 事件字段白名单：Authorization / Cookie / query / 正文没有任何进入这条路径的机会。
  function record(event) {
    if (!emit) return;
    const row = {
      task_id: taskId,
      grant_id: event.grant_id == null ? null : event.grant_id,
      protocol: event.protocol == null ? null : event.protocol,
      host: event.host == null ? null : event.host,
      port: event.port == null ? null : Number(event.port),
      resolved_ip: event.resolved_ip == null ? null : event.resolved_ip,
      decision: event.decision,
      status_code: event.status_code == null ? null : Number(event.status_code),
      bytes: event.bytes == null ? null : Number(event.bytes),
    };
    try { emit(row); } catch (error) {}
  }

  function refuse(res, status, reason, fields) {
    record(Object.assign({}, fields, { decision: 'denied:' + reason, status_code: status, bytes: 0 }));
    try {
      res.writeHead(status, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' });
      res.end('egress_denied: ' + reason + '\n');
    } catch (error) {}
  }

  function rejectTunnel(socket, status, reason, fields) {
    record(Object.assign({}, fields, { decision: 'denied:' + reason, status_code: status, bytes: 0 }));
    try { socket.end('HTTP/1.1 ' + status + ' ' + (status === 403 ? 'Forbidden' : 'Bad Request') + '\r\n\r\n'); } catch (error) {}
  }

  async function handleHttp(req, res) {
    const parsed = requestTarget(req);
    if (!parsed.ok) return refuse(res, 400, parsed.reason, { protocol: null, host: null, port: null });
    const target = parsed.target;
    const decided = decide(grants, target);
    if (!decided.ok) return refuse(res, 403, decided.reason, { protocol: target.protocol, host: target.host, port: target.port });
    // 单次连接内固定解析结果：出站只连这个 ip，不再按域名二次解析（阻断 DNS rebinding）。
    const resolved = await resolveHost(target.host, { port: target.port, localServices: localServices, lookup: lookup });
    if (!resolved.ok) {
      return refuse(res, 403, resolved.reason, { protocol: target.protocol, host: target.host, port: target.port, resolved_ip: resolved.ip || null });
    }
    const base = { grant_id: decided.grant.grant_id, protocol: target.protocol, host: target.host, port: target.port, resolved_ip: resolved.ip };
    let settled = false;
    // 3xx 指向别的协议/主机/端口就是一次新请求：重新 checkTarget，换目标时还要重新解析并固定新的 ip。
    // 同一目标的重定向沿用本连接已固定的 ip，避免一次连接里出现第二个解析结果。
    async function revalidateRedirect(location) {
      const next = redirectTarget(location, target);
      if (!next.ok) return { ok: false, reason: next.reason };
      const recheck = decide(grants, next.target);
      if (!recheck.ok) return { ok: false, reason: recheck.reason };
      if (next.target.host === target.host && next.target.port === target.port && next.target.protocol === target.protocol) {
        return { ok: true, same: true };
      }
      const again = await resolveHost(next.target.host, { port: next.target.port, localServices: localServices, lookup: lookup });
      if (!again.ok) return { ok: false, reason: again.reason };
      return { ok: true, same: false, resolved_ip: again.ip, grant_id: recheck.grant.grant_id };
    }

    async function forward(up) {
      const location = up.headers && up.headers.location;
      if (up.statusCode >= 300 && up.statusCode < 400 && location) {
        const recheck = await revalidateRedirect(location);
        if (!recheck.ok) {
          settled = true;
          up.resume();
          return refuse(res, 403, 'redirect_' + recheck.reason, base);
        }
        record(Object.assign({}, base, {
          grant_id: recheck.grant_id || base.grant_id,
          resolved_ip: recheck.resolved_ip || base.resolved_ip,
          decision: 'redirect_revalidated', status_code: up.statusCode, bytes: 0,
        }));
      }
      let bytes = 0;
      settled = true;
      up.on('data', function (chunk) { bytes += chunk.length; });
      up.on('end', function () { record(Object.assign({}, base, { decision: 'allow', status_code: up.statusCode, bytes: bytes })); });
      up.on('error', function () { record(Object.assign({}, base, { decision: 'upstream_error', status_code: up.statusCode, bytes: bytes })); });
      try { res.writeHead(up.statusCode, up.headers); } catch (error) {}
      up.pipe(res);
    }

    const upstream = http.request({
      host: resolved.ip, port: target.port, family: resolved.family,
      method: req.method, path: requestPath(req), headers: outboundHeaders(req, target),
    }, function (up) { void forward(up); });
    upstream.on('error', function () {
      if (settled) return;
      settled = true;
      refuse(res, 502, 'upstream_error', base);
    });
    req.on('aborted', function () { try { upstream.destroy(); } catch (error) {} });
    req.pipe(upstream);
  }

  function handleConnect(req, socket, head) {
    const parsed = connectTarget(req && req.url);
    if (!parsed.ok) return rejectTunnel(socket, 400, parsed.reason, { protocol: 'https', host: null, port: null });
    const target = parsed.target;
    const decided = decide(grants, target);
    if (!decided.ok) return rejectTunnel(socket, 403, decided.reason, { protocol: 'https', host: target.host, port: target.port });
    resolveHost(target.host, { port: target.port, localServices: localServices, lookup: lookup }).then(function (resolved) {
      if (!resolved.ok) {
        return rejectTunnel(socket, 403, resolved.reason, { protocol: 'https', host: target.host, port: target.port, resolved_ip: resolved.ip || null });
      }
      const base = { grant_id: decided.grant.grant_id, protocol: 'https', host: target.host, port: target.port, resolved_ip: resolved.ip };
      let bytes = 0;
      const tunnel = net.connect({ host: resolved.ip, port: target.port, family: resolved.family }, function () {
        try { socket.write('HTTP/1.1 200 Connection Established\r\n\r\n'); } catch (error) {}
        if (head && head.length) { bytes += head.length; try { tunnel.write(head); } catch (error) {} }
        record(Object.assign({}, base, { decision: 'allow', status_code: 200, bytes: null }));
      });
      socket.on('data', function (chunk) { bytes += chunk.length; });
      tunnel.on('data', function (chunk) { bytes += chunk.length; });
      tunnel.on('error', function () {
        record(Object.assign({}, base, { decision: 'upstream_error', status_code: null, bytes: bytes }));
        try { socket.destroy(); } catch (error) {}
      });
      socket.on('error', function () { try { tunnel.destroy(); } catch (error) {} });
      tunnel.on('close', function () { try { socket.end(); } catch (error) {} });
      socket.pipe(tunnel);
      tunnel.pipe(socket);
    }, function () {
      rejectTunnel(socket, 403, 'dns_failed', { protocol: 'https', host: target.host, port: target.port });
    });
  }

  const sockets = new Set();
  const server = http.createServer();
  server.on('connection', function (socket) {
    sockets.add(socket);
    socket.on('close', function () { sockets.delete(socket); });
  });
  server.on('request', function (req, res) { void handleHttp(req, res); });
  server.on('connect', function (req, socket, head) { handleConnect(req, socket, head); });
  server.on('clientError', function (error, socket) { try { socket.end('HTTP/1.1 400 Bad Request\r\n\r\n'); } catch (e) {} });

  try {
    await new Promise(function (resolve, reject) {
      server.once('error', reject);
      server.listen(0, BIND_HOST, resolve);
    });
  } catch (error) {
    try { server.close(); } catch (e) {}
    throw error;
  }

  const url = 'http://' + BIND_HOST + ':' + server.address().port;
  return {
    url: url,
    grants: grants.map(function (entry) { return entry.grant; }),
    rejected: rejected,
    close: function close() {
      for (const socket of sockets) { try { socket.destroy(); } catch (error) {} }
      return new Promise(function (resolve) {
        try { server.close(function () { resolve(); }); } catch (error) { resolve(); }
      });
    },
  };
}
