// 网络目标白名单：把 net:egress 从"命令名"升级为目标级判定。
// 本模块只做纯策略判定，绝不建连：出口代理在每次 HTTP 请求与 HTTPS CONNECT 前调用 checkTarget，
// 对 resolveHost 的结果做单连接固定（防 DNS rebinding），跨 host 的 3xx 必须重新调用 checkTarget。
// 所有导出的失败形态统一为 { ok:false, reason }，reason 是稳定的英文标识，便于测试与日志。
import net from 'node:net';
import { lookup as dnsLookup } from 'node:dns/promises';

const PROTOCOLS = ['http', 'https'];
const DEFAULT_PORTS = { http: 80, https: 443 };
const MAX_HOST = 253;
const MAX_HOST_INPUT = 512;
const MAX_LABEL = 63;
const MAX_PORTS = 16;
const MAX_PURPOSE = 200;
const MAX_LOCAL_SERVICES = 20;

// 不允许出现在 host 里的字符：它们会把 host 变成 URL、用户信息、路径或通配。
const CIDR_RE = /^[^/?#@\s]+\/\d{1,3}$/;
const BAD_CHARS_RE = /[\s\u0000-\u001f\u007f]/;

function stripBrackets(host) {
  return String(host).replace(/^\[/, '').replace(/\]$/, '');
}

// 小写 + punycode 规范化；拒绝用户名、路径、通配、CIDR 与带端口的输入。
export function normalizeHost(value) {
  if (typeof value !== 'string') return { ok: false, reason: 'host_required' };
  const raw = value.trim();
  if (!raw) return { ok: false, reason: 'host_required' };
  if (raw.length > MAX_HOST_INPUT) return { ok: false, reason: 'host_too_long' };
  if (BAD_CHARS_RE.test(raw)) return { ok: false, reason: 'host_invalid' };
  if (CIDR_RE.test(raw)) return { ok: false, reason: 'host_cidr_forbidden' };
  if (raw.indexOf('@') >= 0) return { ok: false, reason: 'host_has_userinfo' };
  if (raw.indexOf('/') >= 0 || raw.indexOf('\\') >= 0) return { ok: false, reason: 'host_has_path' };
  if (raw.indexOf('?') >= 0 || raw.indexOf('#') >= 0) return { ok: false, reason: 'host_has_query' };
  if (raw.indexOf('*') >= 0) return { ok: false, reason: 'host_wildcard_forbidden' };
  if (raw.indexOf(',') >= 0) return { ok: false, reason: 'host_invalid' };

  let url;
  try { url = new URL('http://' + raw + '/'); } catch (error) { return { ok: false, reason: 'host_invalid' }; }
  if (url.username || url.password) return { ok: false, reason: 'host_has_userinfo' };
  if (url.port) return { ok: false, reason: 'host_has_port' };
  if (url.pathname !== '/' || url.search || url.hash) return { ok: false, reason: 'host_invalid' };

  // WHATWG URL 已经把 IDN 转成 punycode、把字母转成小写，IPv6 保留方括号。
  const host = url.hostname;
  if (!host) return { ok: false, reason: 'host_required' };
  const bare = stripBrackets(host);
  if (net.isIP(bare)) {
    return { ok: true, host: net.isIP(bare) === 6 ? '[' + bare.toLowerCase() + ']' : bare };
  }
  if (host.endsWith('.')) return { ok: false, reason: 'host_trailing_dot' };
  if (host.length > MAX_HOST) return { ok: false, reason: 'host_too_long' };
  if (host.startsWith('.') || host.indexOf('..') >= 0) return { ok: false, reason: 'host_invalid' };
  for (const label of host.split('.')) {
    if (!label || label.length > MAX_LABEL) return { ok: false, reason: 'host_invalid' };
    // LDH：punycode 的 xn-- 前缀同样满足这条规则。
    if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/.test(label)) return { ok: false, reason: 'host_invalid' };
  }
  return { ok: true, host };
}

function normalizePorts(value) {
  if (!Array.isArray(value) || !value.length) return { ok: false, reason: 'ports_required' };
  if (value.length > MAX_PORTS) return { ok: false, reason: 'ports_too_many' };
  const ports = [];
  for (const item of value) {
    const port = Number(item);
    if (!Number.isInteger(port) || port < 1 || port > 65535) return { ok: false, reason: 'port_must_be_1_65535' };
    if (ports.indexOf(port) < 0) ports.push(port);
  }
  return { ok: true, ports: ports.sort(function (a, b) { return a - b; }) };
}

// grant = { protocol:'http'|'https', host, ports:[1-65535], purpose }
export function normalizeGrant(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { ok: false, reason: 'grant_must_be_object' };
  const protocol = String(raw.protocol == null ? '' : raw.protocol).trim().toLowerCase().replace(/:$/, '');
  if (PROTOCOLS.indexOf(protocol) < 0) return { ok: false, reason: 'protocol_must_be_http_or_https' };
  const host = normalizeHost(raw.host);
  if (!host.ok) return host;
  const ports = normalizePorts(raw.ports);
  if (!ports.ok) return ports;
  const purpose = typeof raw.purpose === 'string' ? raw.purpose.trim() : '';
  if (!purpose) return { ok: false, reason: 'purpose_required' };
  if (purpose.length > MAX_PURPOSE) return { ok: false, reason: 'purpose_too_long' };
  return { ok: true, grant: { protocol: protocol, host: host.host, ports: ports.ports, purpose: purpose } };
}

// target = { protocol, host, port }；port 缺省按协议取 80/443。
export function checkTarget(grant, target) {
  const normalized = normalizeGrant(grant);
  if (!normalized.ok) return { ok: false, reason: 'grant_invalid' };
  if (!target || typeof target !== 'object' || Array.isArray(target)) return { ok: false, reason: 'target_required' };
  const protocol = String(target.protocol == null ? '' : target.protocol).trim().toLowerCase().replace(/:$/, '');
  if (PROTOCOLS.indexOf(protocol) < 0) return { ok: false, reason: 'protocol_must_be_http_or_https' };
  if (protocol !== normalized.grant.protocol) return { ok: false, reason: 'protocol_not_granted' };
  const host = normalizeHost(target.host);
  if (!host.ok) return host;
  if (host.host !== normalized.grant.host) return { ok: false, reason: 'host_not_granted' };
  const raw = target.port == null || target.port === '' ? DEFAULT_PORTS[protocol] : Number(target.port);
  if (!Number.isInteger(raw) || raw < 1 || raw > 65535) return { ok: false, reason: 'port_invalid' };
  if (normalized.grant.ports.indexOf(raw) < 0) return { ok: false, reason: 'port_not_granted' };
  return { ok: true };
}

function octetsOf(ip) {
  return String(ip).split('.').map(function (part) { return Number(part); });
}

function isPrivateV4(ip) {
  const octets = octetsOf(ip);
  if (octets.length !== 4 || octets.some(function (n) { return !Number.isInteger(n) || n < 0 || n > 255; })) return true;
  const [a, b] = octets;
  if (a === 0) return true;                                   // 0.0.0.0/8
  if (a === 10) return true;                                  // RFC1918
  if (a === 100 && b >= 64 && b <= 127) return true;          // CGNAT 100.64/10
  if (a === 127) return true;                                 // loopback
  if (a === 169 && b === 254) return true;                    // link-local + 云元数据 169.254.169.254
  if (a === 172 && b >= 16 && b <= 31) return true;           // RFC1918
  if (a === 192 && b === 168) return true;                    // RFC1918
  if (a === 192 && b === 0 && octets[2] === 0) return true;   // IETF protocol assignments
  if (a === 192 && b === 0 && octets[2] === 2) return true;   // TEST-NET-1
  if (a === 198 && (b === 18 || b === 19)) return true;       // benchmarking
  if (a === 198 && b === 51 && octets[2] === 100) return true; // TEST-NET-2
  if (a === 203 && b === 0 && octets[2] === 113) return true; // TEST-NET-3
  if (a >= 224) return true;                                  // multicast + 保留 + 广播
  return false;
}

function isPrivateV6(ip) {
  const value = stripBrackets(String(ip)).toLowerCase();
  const mapped = value.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (mapped) return isPrivateV4(mapped[1]);                  // IPv4-mapped 按 IPv4 判定
  if (value === '::' || value === '::1') return true;         // 未指定 / loopback
  if (/^f[cd]/.test(value)) return true;                      // fc00::/7 唯一本地地址（含 fd00:ec2::254）
  if (/^fe[89ab]/.test(value)) return true;                   // fe80::/10 link-local
  if (/^ff/.test(value)) return true;                         // ff00::/8 multicast
  if (/^64:ff9b:/.test(value)) return true;                   // NAT64，内嵌 IPv4 不可信
  if (/^2002:/.test(value)) return true;                      // 6to4
  if (/^2001:db8:/.test(value)) return true;                  // 文档地址
  return false;
}

export function isPublicAddress(ip) {
  const value = stripBrackets(String(ip == null ? '' : ip)).trim();
  const family = net.isIP(value);
  if (family === 4) return !isPrivateV4(value);
  if (family === 6) return !isPrivateV6(value);
  return false;
}

function isLoopback(ip) {
  const value = stripBrackets(String(ip == null ? '' : ip)).toLowerCase();
  if (net.isIP(value) === 6) return value === '::1';
  if (net.isIP(value) !== 4) return false;
  return octetsOf(value)[0] === 127;
}

// 解析并校验目的地址。options: { port, localServices:[{port,purpose}], lookup(name)->{address,family} }
// 只有 loopback 在命中 local_services 精确端口时才放行；RFC1918/link-local/元数据一律拒绝。
export async function resolveHost(host, options) {
  const opts = options || {};
  const normalized = normalizeHost(host);
  if (!normalized.ok) return normalized;
  const name = normalized.host;
  const port = Number(opts.port);
  const services = Array.isArray(opts.localServices) ? opts.localServices : [];
  const localPort = Number.isInteger(port) && port >= 1 && port <= 65535 && services.some(function (service) {
    return service && Number(service.port) === port;
  });

  const literal = stripBrackets(name);
  if (net.isIP(literal)) {
    if (isPublicAddress(literal)) return { ok: true, ip: literal, family: net.isIP(literal), literal: true };
    if (localPort && isLoopback(literal)) return { ok: true, ip: literal, family: net.isIP(literal), literal: true, local: true };
    return { ok: false, reason: 'private_address' };
  }

  const lookup = typeof opts.lookup === 'function' ? opts.lookup : dnsLookup;
  let found;
  try { found = await lookup(name); } catch (error) {
    return { ok: false, reason: 'dns_failed', detail: String((error && (error.code || error.message)) || '') };
  }
  const ip = stripBrackets(String(found && found.address || found || ''));
  if (!ip || !net.isIP(ip)) return { ok: false, reason: 'dns_failed' };
  if (isPublicAddress(ip)) return { ok: true, ip: ip, family: net.isIP(ip) };
  if (localPort && isLoopback(ip)) return { ok: true, ip: ip, family: net.isIP(ip), local: true };
  return { ok: false, reason: 'private_address', ip: ip };
}

// policy.network = { default:'deny', local_services:[{ port, purpose }] }
export function normalizeNetworkPolicy(input) {
  const raw = input == null ? {} : input;
  if (typeof raw !== 'object' || Array.isArray(raw)) return { ok: false, reason: 'network_must_be_object' };
  if (raw.default != null && raw.default !== 'deny') return { ok: false, reason: 'network_default_must_be_deny' };
  const services = raw.local_services == null ? [] : raw.local_services;
  if (!Array.isArray(services)) return { ok: false, reason: 'local_services_must_be_array' };
  if (services.length > MAX_LOCAL_SERVICES) return { ok: false, reason: 'local_services_too_many' };
  const out = [];
  for (const item of services) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return { ok: false, reason: 'local_service_must_be_object' };
    const port = Number(item.port);
    if (!Number.isInteger(port) || port < 1 || port > 65535) return { ok: false, reason: 'local_service_port_invalid' };
    const purpose = typeof item.purpose === 'string' ? item.purpose.trim() : '';
    if (!purpose) return { ok: false, reason: 'local_service_purpose_required' };
    if (purpose.length > MAX_PURPOSE) return { ok: false, reason: 'local_service_purpose_too_long' };
    if (out.some(function (entry) { return entry.port === port; })) return { ok: false, reason: 'local_service_port_duplicate' };
    out.push({ port: port, purpose: purpose });
  }
  out.sort(function (a, b) { return a.port - b.port; });
  return { ok: true, network: { default: 'deny', local_services: out } };
}

const EVENT_KEYS = ['task_id', 'grant_id', 'protocol', 'host', 'port', 'resolved_ip', 'decision', 'status_code', 'bytes'];

function scrub(value, max) {
  if (value == null) return null;
  const text = String(value);
  const cut = text.search(/[/?#@\s]/);
  const head = (cut >= 0 ? text.slice(0, cut) : text).trim();
  return head ? head.slice(0, max) : null;
}

// host 列只放规范化域名/IP：端口、query、userinfo 一律切掉，规范不了也不留原文。
function scrubHostValue(value) {
  if (value == null) return null;
  let text = String(value).trim();
  const cut = text.search(/[/?#@\s]/);
  if (cut >= 0) text = text.slice(0, cut);
  text = text.replace(/:\d{1,5}$/, '');
  const normalized = normalizeHost(text);
  return normalized.ok ? normalized.host : null;
}

function intOrNull(value) {
  if (value == null || value === '') return null;
  const n = Number(value);
  return Number.isSafeInteger(n) ? n : null;
}

// 唯一允许写 network_events 的入口：字段白名单 + 值脱敏。
// Authorization / Cookie / query / 正文永远不会出现在这条 INSERT 里。
export function recordEvent(db, event, now) {
  const input = event || {};
  const row = {};
  for (const key of EVENT_KEYS) row[key] = input[key] == null ? null : input[key];
  const protocol = row.protocol == null ? null : String(row.protocol).trim().toLowerCase().replace(/:$/, '');
  const ts = typeof now === 'string' && now ? now : new Date().toISOString();
  db.prepare('INSERT INTO network_events(task_id,grant_id,protocol,host,port,resolved_ip,decision,status_code,bytes,ts) VALUES(?,?,?,?,?,?,?,?,?,?)')
    .run(
      scrub(row.task_id, 80), scrub(row.grant_id, 80),
      protocol && PROTOCOLS.indexOf(protocol) >= 0 ? protocol : null,
      scrubHostValue(row.host),
      intOrNull(row.port), net.isIP(stripBrackets(String(row.resolved_ip == null ? '' : row.resolved_ip))) ? stripBrackets(String(row.resolved_ip)) : null,
      String(row.decision == null ? 'unknown' : row.decision).trim().slice(0, 40) || 'unknown',
      intOrNull(row.status_code), intOrNull(row.bytes), ts,
    );
  return { ok: true };
}

export const NETWORK_LIMITS = { MAX_PORTS, MAX_PURPOSE, MAX_LOCAL_SERVICES, MAX_HOST, PROTOCOLS, DEFAULT_PORTS };
