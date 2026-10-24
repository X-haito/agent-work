#!/usr/bin/env node
// 网络目标白名单：策略判定、地址解析、日志脱敏与 schema 幂等。
// 只跑纯判定，不建连、不发真实 DNS（解析函数全部注入假 lookup）。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as S from './store.mjs';
import * as A from './admin-config.mjs';
import * as N from './network-policy.mjs';
import { migrateDb } from './migrations.mjs';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentbus-network-'));
let pass = 0;
let fail = 0;

function ok(name, value, detail) {
  if (value) { pass += 1; console.log('  PASS  ' + name); }
  else { fail += 1; console.log('  FAIL  ' + name + (detail ? ' — ' + JSON.stringify(detail) : '')); }
}

function reasonOf(result) { return result && result.ok === false ? result.reason : 'ok'; }

console.log('[1] host 规范化：大小写、IDN 与拒绝形态');
ok('大写域名规范化为小写', N.normalizeHost('  ExAmPle.COM  ').host === 'example.com');
ok('IDN 转为 punycode', N.normalizeHost('örnek.example').host === 'xn--rnek-4qa.example', N.normalizeHost('örnek.example'));
ok('punycode 幂等', N.normalizeHost(N.normalizeHost('API.Örnek.com').host).host === 'api.xn--rnek-4qa.com');
ok('拒绝用户名', reasonOf(N.normalizeHost('user@example.com')) === 'host_has_userinfo');
ok('拒绝路径', reasonOf(N.normalizeHost('example.com/admin')) === 'host_has_path');
ok('拒绝 query', reasonOf(N.normalizeHost('example.com?token=secret')) === 'host_has_query');
ok('拒绝通配', reasonOf(N.normalizeHost('*.example.com')) === 'host_wildcard_forbidden');
ok('拒绝裸 IP 段（CIDR）', reasonOf(N.normalizeHost('10.0.0.0/8')) === 'host_cidr_forbidden');
ok('拒绝带端口', reasonOf(N.normalizeHost('example.com:8080')) === 'host_has_port');
ok('拒绝尾点', reasonOf(N.normalizeHost('example.com.')) === 'host_trailing_dot');
ok('拒绝空值与非字符串', reasonOf(N.normalizeHost('   ')) === 'host_required' && reasonOf(N.normalizeHost(42)) === 'host_required');
ok('拒绝含下划线的伪域名', reasonOf(N.normalizeHost('bad_host.example.com')) === 'host_invalid');
ok('公网字面 IPv4 可用', N.normalizeHost('93.184.216.34').host === '93.184.216.34');
ok('IPv6 字面量统一小写方括号', N.normalizeHost('[::1]').host === '[::1]');

console.log('\n[2] grant 规范化');
const goodGrant = { protocol: 'HTTPS:', host: 'API.Example.com', ports: [443, '443', 8443], purpose: ' 调用 API ' };
const normalizedGrant = N.normalizeGrant(goodGrant);
ok('protocol 大小写与冒号容错', normalizedGrant.ok && normalizedGrant.grant.protocol === 'https');
ok('host 规范化', normalizedGrant.grant.host === 'api.example.com');
ok('ports 去重并排序', JSON.stringify(normalizedGrant.grant.ports) === '[443,8443]');
ok('purpose 去空白', normalizedGrant.grant.purpose === '调用 API');
ok('purpose 必填', reasonOf(N.normalizeGrant({ protocol: 'https', host: 'a.com', ports: [443] })) === 'purpose_required');
ok('purpose 超长拒绝', reasonOf(N.normalizeGrant({ protocol: 'https', host: 'a.com', ports: [443], purpose: 'x'.repeat(201) })) === 'purpose_too_long');
ok('端口必须 1-65535', reasonOf(N.normalizeGrant({ protocol: 'https', host: 'a.com', ports: [0], purpose: 'x' })) === 'port_must_be_1_65535'
  && reasonOf(N.normalizeGrant({ protocol: 'https', host: 'a.com', ports: [65536], purpose: 'x' })) === 'port_must_be_1_65535');
ok('ports 不能为空', reasonOf(N.normalizeGrant({ protocol: 'https', host: 'a.com', ports: [], purpose: 'x' })) === 'ports_required');
ok('ports 项数上限', reasonOf(N.normalizeGrant({ protocol: 'https', host: 'a.com', ports: Array.from({ length: 17 }, (_, i) => 1000 + i), purpose: 'x' })) === 'ports_too_many');
ok('protocol 只接受 http/https', reasonOf(N.normalizeGrant({ protocol: 'ftp', host: 'a.com', ports: [21], purpose: 'x' })) === 'protocol_must_be_http_or_https');
ok('grant 非法 host 透传原因', reasonOf(N.normalizeGrant({ protocol: 'https', host: 'a.com/x', ports: [443], purpose: 'x' })) === 'host_has_path');

console.log('\n[3] checkTarget：默认端口与严格匹配');
const httpsGrant = N.normalizeGrant({ protocol: 'https', host: 'api.example.com', ports: [443], purpose: 'api' }).grant;
const httpGrant = N.normalizeGrant({ protocol: 'http', host: 'example.com', ports: [80], purpose: 'web' }).grant;
ok('https 省略端口按 443 匹配', N.checkTarget(httpsGrant, { protocol: 'https', host: 'api.example.com' }).ok === true);
ok('http 省略端口按 80 匹配', N.checkTarget(httpGrant, { protocol: 'http', host: 'example.com', port: null }).ok === true);
ok('host 大小写不同仍匹配', N.checkTarget(httpsGrant, { protocol: 'https', host: 'API.EXAMPLE.COM', port: 443 }).ok === true);
ok('IDN 两端一致匹配', N.checkTarget(N.normalizeGrant({ protocol: 'https', host: 'xn--rnek-4qa.example', ports: [443], purpose: 'idn' }).grant, { protocol: 'https', host: 'örnek.example', port: 443 }).ok === true);
ok('子域不放行', reasonOf(N.checkTarget(httpsGrant, { protocol: 'https', host: 'evil.example.com', port: 443 })) === 'host_not_granted');
ok('后缀欺骗不放行', reasonOf(N.checkTarget(httpsGrant, { protocol: 'https', host: 'api.example.com.evil.tld', port: 443 })) === 'host_not_granted');
ok('未授权端口拒绝', reasonOf(N.checkTarget(httpsGrant, { protocol: 'https', host: 'api.example.com', port: 8443 })) === 'port_not_granted');
ok('未授权端口拒绝（默认端口换成 80）', reasonOf(N.checkTarget(httpsGrant, { protocol: 'http', host: 'api.example.com' })) === 'protocol_not_granted');
ok('协议降级拒绝', reasonOf(N.checkTarget(httpsGrant, { protocol: 'http', host: 'api.example.com', port: 443 })) === 'protocol_not_granted');
ok('缺 target 拒绝', reasonOf(N.checkTarget(httpsGrant, null)) === 'target_required');
ok('非法 grant 拒绝', reasonOf(N.checkTarget({ protocol: 'ftp', host: 'a.com', ports: [21], purpose: 'x' }, { protocol: 'ftp', host: 'a.com', port: 21 })) === 'grant_invalid');

console.log('\n[4] resolveHost：私网、IPv6 与 localhost 精确端口');
const services = [{ port: 7400, purpose: 'AgentBus 本地看板' }];
const publicLookup = async () => ({ address: '93.184.216.34', family: 4 });
ok('公网 A 记录通过', (await N.resolveHost('public.example.com', { lookup: publicLookup })).ip === '93.184.216.34');
ok('lookup 返回裸字符串也接受', (await N.resolveHost('public.example.com', { lookup: async () => '93.184.216.34' })).ok === true);
ok('loopback 无 local_service 拒绝', reasonOf(await N.resolveHost('127.0.0.1', { lookup: publicLookup })) === 'private_address');
ok('loopback 命中 local_services 精确端口放行', (await N.resolveHost('127.0.0.1', { port: 7400, localServices: services })).local === true);
ok('loopback 端口不精确仍拒绝', reasonOf(await N.resolveHost('127.0.0.1', { port: 7401, localServices: services })) === 'private_address');
ok('localhost 域名按 local_services 放行', (await N.resolveHost('localhost', { port: 7400, localServices: services, lookup: async () => ({ address: '127.0.0.1', family: 4 }) })).ok === true);
ok('localhost 域名无 local_service 拒绝', reasonOf(await N.resolveHost('localhost', { lookup: async () => ({ address: '127.0.0.1', family: 4 }) })) === 'private_address');
for (const [label, ip] of [['RFC1918 10/8', '10.1.2.3'], ['RFC1918 172.16/12', '172.20.0.9'], ['RFC1918 192.168/16', '192.168.1.10'], ['link-local', '169.254.1.1'], ['云元数据', '169.254.169.254'], ['CGNAT', '100.64.0.1'], ['multicast', '239.1.1.1']]) {
  ok('拒绝 ' + label, reasonOf(await N.resolveHost('evil.example.com', { lookup: async () => ({ address: ip, family: 4 }) })) === 'private_address');
}
for (const [label, ip] of [['IPv6 loopback ::1', '::1'], ['IPv6 ULA fc00::/7', 'fd12:3456::1'], ['IPv6 link-local fe80::/10', 'fe80::1'], ['IPv6 mapped 127.0.0.1', '::ffff:127.0.0.1'], ['IPv6 multicast', 'ff02::1'], ['6to4 2002::', '2002:c000:0204::1']]) {
  ok('拒绝 ' + label, reasonOf(await N.resolveHost('evil.example.com', { lookup: async () => ({ address: ip, family: 6 }) })) === 'private_address');
}
ok('公网 IPv6 通过', (await N.resolveHost('public.example.com', { lookup: async () => ({ address: '2606:2800:220:1::1', family: 6 }) })).ok === true);
ok('DNS 失败给出稳定原因', reasonOf(await N.resolveHost('nx.example.com', { lookup: async () => { throw Object.assign(new Error('nx'), { code: 'ENOTFOUND' }); } })) === 'dns_failed');

console.log('\n[5] DNS rebinding 与跨域重定向');
const rebound = [{ address: '93.184.216.34', family: 4 }, { address: '10.0.0.7', family: 4 }];
const firstLookup = await N.resolveHost('rebind.example.com', { lookup: async () => rebound[0] });
ok('首次解析公网地址通过', firstLookup.ok === true && firstLookup.ip === '93.184.216.34');
ok('DNS 翻转为私网后被拒（rebinding 拦截）', reasonOf(await N.resolveHost('rebind.example.com', { lookup: async () => rebound[1] })) === 'private_address');
ok('单连接固定：已绑定 IP 继续按公网判定，不再重解析', N.isPublicAddress(firstLookup.ip) === true && firstLookup.ip !== rebound[1].address);
const redirectGrant = N.normalizeGrant({ protocol: 'https', host: 'app.example.com', ports: [443], purpose: '跳转测试' }).grant;
function checkLocation(from, location) {
  const url = new URL(location, from);
  return N.checkTarget(redirectGrant, { protocol: url.protocol.replace(':', ''), host: url.hostname, port: url.port ? Number(url.port) : undefined });
}
ok('同 host 3xx 继续放行', checkLocation('https://app.example.com/a', '/b').ok === true);
ok('跨 host 3xx 重新校验并拒绝', reasonOf(checkLocation('https://app.example.com/a', 'https://cdn.example.net/b')) === 'host_not_granted');
ok('3xx 到同 host 未授权端口拒绝', reasonOf(checkLocation('https://app.example.com/a', 'https://app.example.com:8443/b')) === 'port_not_granted');
ok('3xx 协议降级拒绝', reasonOf(checkLocation('https://app.example.com/a', 'http://app.example.com/b')) === 'protocol_not_granted');

console.log('\n[6] policy.network 段：校验、保留与不丢失');
const realPolicy = JSON.parse(fs.readFileSync(path.join(S.BUS_DIR, 'policy.json'), 'utf8'));
ok('policy.json 自带 network 段', !!realPolicy.network && realPolicy.network.default === 'deny' && Array.isArray(realPolicy.network.local_services));
ok('normalizeNetworkPolicy 缺省按 deny 处理', JSON.stringify(N.normalizeNetworkPolicy(undefined).network) === '{"default":"deny","local_services":[]}');
ok('default 只允许 deny', reasonOf(N.normalizeNetworkPolicy({ default: 'allow' })) === 'network_default_must_be_deny');
ok('local_services 端口重复拒绝', reasonOf(N.normalizeNetworkPolicy({ local_services: [{ port: 7400, purpose: 'a' }, { port: 7400, purpose: 'b' }] })) === 'local_service_port_duplicate');
ok('local_services 端口范围校验', reasonOf(N.normalizeNetworkPolicy({ local_services: [{ port: 70000, purpose: 'a' }] })) === 'local_service_port_invalid');
ok('local_services 必须写明 purpose', reasonOf(N.normalizeNetworkPolicy({ local_services: [{ port: 7400 }] })) === 'local_service_purpose_required');
ok('local_services 排序规范化', JSON.stringify(N.normalizeNetworkPolicy({ local_services: [{ port: 7401, purpose: 'b' }, { port: 7400, purpose: 'a' }] }).network.local_services.map(function (s) { return s.port; })) === '[7400,7401]');
const validated = A.validatePolicy(realPolicy, {});
ok('admin-config.validatePolicy 保留 network', JSON.stringify(validated.network) === JSON.stringify({ default: 'deny', local_services: N.normalizeNetworkPolicy(realPolicy.network).network.local_services }));
const policyFile = path.join(dir, 'policy.json');
fs.copyFileSync(path.join(S.BUS_DIR, 'policy.json'), policyFile);
const withoutNetwork = JSON.parse(JSON.stringify(realPolicy));
delete withoutNetwork.network;
const savedPolicy = A.savePolicy(withoutNetwork, { path: policyFile });
ok('不提交 network 时沿用文件旧段（保存不丢白名单）', JSON.stringify(JSON.parse(fs.readFileSync(policyFile, 'utf8')).network) === JSON.stringify(realPolicy.network));
ok('savePolicy 返回值同样带 network', !!savedPolicy.policy.network && savedPolicy.policy.network.local_services.length === realPolicy.network.local_services.length);
let badNetworkStatus = 0;
try { A.validatePolicy(Object.assign({}, realPolicy, { network: { default: 'allow' } }), {}); } catch (error) { badNetworkStatus = error.statusCode; }
ok('非法 network 段被 400 拒绝', badNetworkStatus === 400);

console.log('\n[7] schema 幂等与任务字段 network_grants');
const db = S.openDb(path.join(dir, 'bus.db'));
migrateDb(db);
migrateDb(db);
const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(function (row) { return row.name; });
ok('network_events 表存在', tables.indexOf('network_events') >= 0);
const eventColumns = db.prepare('PRAGMA table_info(network_events)').all().map(function (c) { return c.name; });
ok('network_events 列与契约一致', ['task_id', 'grant_id', 'protocol', 'host', 'port', 'resolved_ip', 'decision', 'status_code', 'bytes', 'ts'].every(function (name) { return eventColumns.indexOf(name) >= 0; }));
ok('network_events 没有凭据/正文列', ['authorization', 'cookie', 'query', 'body', 'headers'].every(function (name) { return eventColumns.indexOf(name) < 0; }));
const taskColumns = db.prepare('PRAGMA table_info(tasks)').all().map(function (c) { return c.name; });
ok('tasks.network_grants 列存在', taskColumns.indexOf('network_grants') >= 0);
ok('migrateDb 连跑两次幂等', taskColumns.filter(function (name) { return name === 'network_grants'; }).length === 1);
const grants = A.validateNetworkGrants([{ protocol: 'HTTPS', host: 'API.Example.com', ports: [443, '443'], purpose: 'api' }]);
ok('validateNetworkGrants 规范化', grants.length === 1 && grants[0].protocol === 'https' && grants[0].host === 'api.example.com' && grants[0].ports.length === 1);
let grantRejects = 0;
for (const bad of [{ protocol: 'ftp', host: 'a.com', ports: [21], purpose: 'x' }, { protocol: 'https', host: 'a.com', ports: [443] }, { protocol: 'https', host: '*.a.com', ports: [443], purpose: 'x' }, { protocol: 'https', host: 'a.com', ports: [443], purpose: 'x'.repeat(201) }, 'not-an-array', Array.from({ length: 9 }, function () { return { protocol: 'https', host: 'a.com', ports: [443], purpose: 'x' }; })]) {
  try { A.validateNetworkGrants(bad); } catch (error) { if (error.statusCode === 400) grantRejects += 1; }
}
ok('validateNetworkGrants 拒绝非法项、purpose 超长与超限', grantRejects === 6);
ok('未提供 network_grants 时返回 null', A.validateNetworkGrants(undefined) === null);

console.log('\n[8] network_events 日志脱敏');
N.recordEvent(db, {
  task_id: 't-42', grant_id: 'grant-1', protocol: 'HTTPS', host: 'api.example.com/secret?token=abc#frag', port: 443,
  resolved_ip: '93.184.216.34', decision: 'allow', status_code: 200, bytes: 512,
  Authorization: 'Bearer sk-live-123', Cookie: 'session=deadbeef', query: 'token=abc', body: '{"password":"p"}', headers: { Cookie: 'x' },
}, '2026-01-01T00:00:00.000Z');
const stored = db.prepare('SELECT * FROM network_events ORDER BY id DESC LIMIT 1').get();
ok('只写入白名单列', Object.keys(stored).sort().join(',') === 'bytes,decision,grant_id,host,id,port,protocol,resolved_ip,status_code,task_id,ts');
ok('host 去掉 query 与片段', stored.host === 'api.example.com');
ok('protocol 规范为小写', stored.protocol === 'https');
ok('status/bytes 落库为整数', stored.status_code === 200 && stored.bytes === 512);
ok('无人为指定 ts 时使用给定时间', stored.ts === '2026-01-01T00:00:00.000Z');
N.recordEvent(db, { host: 'evil.example.com:8443/x?y=1', resolved_ip: 'not-an-ip', protocol: 'ftp', port: '443', decision: null });
const second = db.prepare('SELECT * FROM network_events ORDER BY id DESC LIMIT 1').get();
ok('host 去掉端口与路径', second.host === 'evil.example.com');
ok('非法 resolved_ip 置空', second.resolved_ip === null);
ok('非 http/https 协议置空', second.protocol === null);
ok('decision 缺省为 unknown', second.decision === 'unknown');
const dump = JSON.stringify(db.prepare('SELECT * FROM network_events').all());
ok('整表不含凭据、cookie 与 query', ['sk-live-123', 'Bearer', 'deadbeef', 'session=', 'token=abc', 'password', 'Cookie', 'Authorization'].every(function (secret) { return dump.indexOf(secret) < 0; }));

db.close();
console.log('测试临时目录: ' + dir);
console.log('\n==================================');
console.log('PASS ' + pass + '   FAIL ' + fail);
process.exitCode = fail ? 1 : 0;
