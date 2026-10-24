// 网络目标白名单的回归测试：能力声明、准入转待批、代理三重校验、跨域重定向、CONNECT、日志脱敏。
// 全程只连 127.0.0.1 的本地桩服务，不访问任何真实外网；DNS 用注入的 lookup 固定。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import * as S from './store.mjs';
import { startEgressProxy, proxyEnv, EGRESS_UNENFORCEABLE } from './egress-proxy.mjs';
import { recordEvent } from './network-policy.mjs';
import * as Codex from './engines/codex.mjs';
import * as Claude from './engines/claude.mjs';
import * as Dsh from './engines/dsh.mjs';

let pass = 0, fail = 0;
function ok(name, cond, detail) {
  if (cond) { pass++; console.log('PASS ' + name); return true; }
  fail++; console.log('FAIL ' + name + (detail === undefined ? '' : ' :: ' + String(detail).slice(0, 300)));
  return false;
}
const here = path.dirname(fileURLToPath(import.meta.url));
const SECRET_AUTH = 'Bearer SECRET-AUTH-1';
const SECRET_COOKIE = 'sid=SECRET-COOKIE-1';
const SECRET_QUERY = 'SECRET-QUERY-1';
const SECRET_BODY = 'SECRET-BODY-1';
const EVENT_KEYS = ['task_id', 'grant_id', 'protocol', 'host', 'port', 'resolved_ip', 'decision', 'status_code', 'bytes'];

function listen(server) {
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
}
function closeServer(server) { return new Promise(resolve => { try { server.close(() => resolve()); } catch (e) { resolve(); } }); }

// 代表"执行端能强制网络隔离"的假引擎；没有它联网任务永远只能转待批。
const enforced = { capabilities: () => ({ strongWriteIsolation: true, networkIsolation: true }) };

function sliceFunction(source, header) {
  const start = source.indexOf(header);
  assert(start >= 0, 'supervisor 里找不到 ' + header);
  const end = source.indexOf('\n}\n', start);
  assert(end > start, 'supervisor 函数边界变了: ' + header);
  return source.slice(start, end + 3);
}

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'agentbus-egress-'));
const servers = [];
const proxies = [];
let db = null;

try {
  // ---------- 本地桩服务 ----------
  const upstream = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://upstream.invalid');
    if (url.pathname === '/ok') { res.writeHead(200, { 'content-type': 'text/plain' }); res.end('hello ' + String(req.headers.host || '')); return; }
    if (url.pathname === '/echo') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ host: req.headers.host || '', auth: req.headers.authorization ? 'present' : 'absent', cookie: req.headers.cookie ? 'present' : 'absent', path: url.pathname }));
      return;
    }
    if (url.pathname === '/hop') { res.writeHead(302, { location: 'https://evil.example/steal?token=' + SECRET_QUERY }); res.end(); return; }
    if (url.pathname === '/same') { res.writeHead(302, { location: '/ok' }); res.end(); return; }
    if (url.pathname === '/scheme') { res.writeHead(302, { location: 'ftp://allowed.example/x' }); res.end(); return; }
    res.writeHead(404); res.end('nope');
  });
  servers.push(upstream);
  const upPort = await listen(upstream);
  const echo = net.createServer(socket => socket.pipe(socket));
  servers.push(echo);
  const echoPort = await listen(echo);

  const lookup = () => Promise.resolve({ address: '127.0.0.1', family: 4 });
  const policy = { network: { default: 'deny', local_services: [{ port: upPort, purpose: 'smoke upstream' }, { port: echoPort, purpose: 'smoke echo' }] } };
  const grants = [
    { protocol: 'http', host: 'allowed.example', ports: [upPort], purpose: 'smoke 明文放行' },
    { protocol: 'https', host: 'allowed.example', ports: [echoPort], purpose: 'smoke CONNECT 放行' },
    { protocol: 'http', host: '127.0.0.1', ports: [upPort], purpose: 'smoke 本机服务' },
    { protocol: 'http', host: '10.0.0.5', ports: [upPort], purpose: 'smoke 私网拒绝' },
  ];
  const events = [];
  const proxy = await startEgressProxy({ policy, grant: grants, taskId: 't-egress', lookup, log: event => events.push(event) });
  proxies.push(proxy);
  const proxyPort = Number(new URL(proxy.url).port);

  function call(targetUrl, options = {}) {
    return new Promise((resolve, reject) => {
      const req = http.request({ host: '127.0.0.1', port: proxyPort, method: options.method || 'GET', path: targetUrl, headers: options.headers || {} }, res => {
        let body = '';
        res.on('data', chunk => { body += chunk; });
        res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }));
      });
      req.on('error', reject);
      if (options.body) req.write(options.body);
      req.end();
    });
  }

  function connectAuthority(authority) {
    return new Promise((resolve, reject) => {
      const socket = net.connect(proxyPort, '127.0.0.1', () => {
        socket.write('CONNECT ' + authority + ' HTTP/1.1\r\nHost: ' + authority + '\r\n\r\n');
      });
      let buffer = '';
      const onData = chunk => {
        buffer += chunk.toString('latin1');
        const cut = buffer.indexOf('\r\n\r\n');
        if (cut < 0) return;
        socket.removeListener('data', onData);
        resolve({ socket, head: buffer.slice(0, cut), rest: buffer.slice(cut + 4) });
      };
      socket.on('data', onData);
      socket.on('error', reject);
    });
  }

  // ---------- [1] capabilities ----------
  for (const [name, engine] of [['codex', Codex], ['claude', Claude], ['dsh', Dsh]]) {
    const caps = engine.capabilities();
    ok(name + ' 声明 networkIsolation=false', caps.networkIsolation === false, JSON.stringify(caps));
    ok(name + ' notes 说明无法阻止绕过代理', caps.notes.some(note => /绕过代理|无法/.test(note)), JSON.stringify(caps.notes));
  }
  ok('写隔离能力未被网络字段改动（codex 强、claude/dsh 弱）', Codex.capabilities().strongWriteIsolation === true && Claude.capabilities().strongWriteIsolation === false && Dsh.capabilities().strongWriteIsolation === false);
  ok('EGRESS_UNENFORCEABLE 写明仅审计且无法强制隔离', /仅审计/.test(EGRESS_UNENFORCEABLE) && /无法强制隔离/.test(EGRESS_UNENFORCEABLE), EGRESS_UNENFORCEABLE);
  ok('engine 的联网说明同样写明无法强制执行', /仅审计/.test(Codex.NETWORK_UNENFORCEABLE) && /无法强制执行/.test(Codex.NETWORK_UNENFORCEABLE), Codex.NETWORK_UNENFORCEABLE);

  // ---------- [2] 准入：能力不足一律转 proposed + needs_human ----------
  db = S.openDb(path.join(temp, 'test.db'));
  S.setRuntimeState(db, 'human', true);
  const netGrants = [{ protocol: 'http', host: 'api.example', ports: [443], purpose: 'smoke' }];

  function admitWith(engine, fields) {
    const task = S.createTask(db, Object.assign({ title: 'net', project: temp, status: 'open', target: 'worker', grants: ['net:egress'] }, fields));
    const claimed = S.claim(db, 'worker', task.id);
    assert.equal(claimed.ok, true, JSON.stringify(claimed));
    const issued = S.issueExecutionGrant(db, task.id, 'worker', { task_version: claimed.task.version });
    assert.equal(issued.ok, true, JSON.stringify(issued));
    const result = Codex.admitTask(S, db, S.getTask(db, task.id), 'worker', engine, issued.grant);
    return { task: task.id, result, saved: S.getTask(db, task.id), grant: S.getExecutionGrant(db, task.id, 'worker') };
  }

  const claudeNet = admitWith(Claude, { network_grants: netGrants });
  ok('claude 联网任务被转待批', claudeNet.result.ok === false && claudeNet.result.reason === 'engine_network_isolation_unsupported', JSON.stringify(claudeNet.result));
  ok('claude 联网任务状态 proposed + needs_human + owner 清空',
    claudeNet.saved.status === 'proposed' && claudeNet.saved.needs_human === 1 && claudeNet.saved.owner === null,
    JSON.stringify({ status: claudeNet.saved.status, needs_human: claudeNet.saved.needs_human, owner: claudeNet.saved.owner }));
  ok('claude 联网任务的执行授权被收回', claudeNet.grant === null);
  ok('待批原因写明「仅审计，无法强制隔离」', /仅审计/.test(String(claudeNet.saved.decline_reason || '')) && /无法强制隔离/.test(String(claudeNet.saved.decline_reason || '')), claudeNet.saved.decline_reason);
  ok('转待批结果带 deferred 标记（supervisor 不会把卡再判 failed）', claudeNet.result.deferred === true);

  const dshNet = admitWith(Dsh, { network_grants: netGrants });
  ok('dsh 联网任务同样转待批', dshNet.result.reason === 'engine_network_isolation_unsupported' && dshNet.saved.status === 'proposed', JSON.stringify(dshNet.result));

  const enforcedNet = admitWith(enforced, { network_grants: netGrants });
  ok('声明了强制隔离的引擎才能启动联网任务', enforcedNet.result.ok === true, JSON.stringify(enforcedNet.result));

  const noGrants = admitWith(enforced, {});
  ok('没有 network_grants 的联网任务仍转待批', noGrants.result.ok === false && noGrants.result.reason === 'network_grants_missing' && noGrants.saved.status === 'proposed', JSON.stringify(noGrants.result));

  const offline = admitWith(Claude, { grants: [], network_grants: null });
  ok('非联网任务不受网络准入影响', offline.result.ok === true && offline.saved.status === 'claimed', JSON.stringify(offline.result));

  // ---------- [3] 代理三重校验 ----------
  const deniedHost = await call('http://not-allowed.example:' + upPort + '/ok');
  ok('未授权域名被拒 403 + host_not_granted', deniedHost.status === 403 && /host_not_granted/.test(deniedHost.body), deniedHost.body);
  const otherPort = upPort === 65000 ? 65001 : 65000;
  const deniedPort = await call('http://allowed.example:' + otherPort + '/ok');
  ok('未授权端口被拒 403 + port_not_granted', deniedPort.status === 403 && /port_not_granted/.test(deniedPort.body), deniedPort.body);
  const wrongProtocol = await call('https://allowed.example/ok');
  ok('明文口上的 https 绝对 URL 被拒', wrongProtocol.status === 400 && /protocol_not_granted/.test(wrongProtocol.body), wrongProtocol.body);
  const privateIp = await call('http://10.0.0.5:' + upPort + '/ok');
  ok('grant 指向 RFC1918 时按解析结果拒绝', privateIp.status === 403 && /private_address/.test(privateIp.body), privateIp.body);
  const allowed = await call('http://allowed.example:' + upPort + '/ok');
  ok('授权目标放行 200', allowed.status === 200 && /hello/.test(allowed.body), allowed.status + ' ' + allowed.body);
  ok('放行时 Host 头保留原域名（而不是解析后的 IP）', /allowed\.example/.test(allowed.body), allowed.body);
  const localService = await call('http://127.0.0.1:' + upPort + '/ok');
  ok('命中 local_services 精确端口的 loopback 才放行', localService.status === 200, localService.status + ' ' + localService.body);

  // ---------- [4] 跨域 3xx 重新校验 ----------
  const crossHost = await call('http://allowed.example:' + upPort + '/hop');
  ok('跨 host 3xx 被重新校验并拒绝', crossHost.status === 403 && /redirect_host_not_granted/.test(crossHost.body), crossHost.status + ' ' + crossHost.body);
  ok('被拒的重定向没有把 Location 泄给客户端', !crossHost.headers.location, JSON.stringify(crossHost.headers));
  const sameHost = await call('http://allowed.example:' + upPort + '/same');
  ok('同目标 3xx 重新校验后放行', sameHost.status === 302 && /\/ok$/.test(String(sameHost.headers.location || '')), sameHost.status + ' ' + JSON.stringify(sameHost.headers));
  const scheme = await call('http://allowed.example:' + upPort + '/scheme');
  ok('非 http(s) 重定向目标被拒', scheme.status === 403 && /redirect_protocol_must_be_http_or_https/.test(scheme.body), scheme.status + ' ' + scheme.body);

  // ---------- [5] CONNECT ----------
  const connectDenied = await connectAuthority('evil.example:' + echoPort);
  ok('CONNECT 未授权 host 被拒 403', /^HTTP\/1\.1 403/.test(connectDenied.head), connectDenied.head);
  connectDenied.socket.destroy();
  const connectPort = await connectAuthority('allowed.example:' + upPort);
  ok('CONNECT 未授权端口被拒 403', /^HTTP\/1\.1 403/.test(connectPort.head), connectPort.head);
  connectPort.socket.destroy();
  const tunnel = await connectAuthority('allowed.example:' + echoPort);
  ok('CONNECT 授权目标建立隧道', /^HTTP\/1\.1 200 Connection Established/.test(tunnel.head), tunnel.head);
  const echoed = await new Promise(resolve => {
    tunnel.socket.once('data', chunk => resolve(chunk.toString('utf8')));
    tunnel.socket.write('ping-through-tunnel');
  });
  ok('隧道双向可用', echoed === 'ping-through-tunnel', echoed);
  tunnel.socket.destroy();

  // ---------- [6] 日志脱敏 ----------
  const secret = await call('http://allowed.example:' + upPort + '/echo?token=' + SECRET_QUERY, {
    method: 'POST',
    headers: { authorization: SECRET_AUTH, cookie: SECRET_COOKIE, 'content-type': 'text/plain' },
    body: SECRET_BODY,
  });
  ok('带凭据与 query 的请求仍然放行', secret.status === 200 && /"auth":"present"/.test(secret.body) && /"cookie":"present"/.test(secret.body), secret.status + ' ' + secret.body);
  const dump = JSON.stringify(events);
  ok('事件里没有任何凭据、cookie、query 或正文', !/SECRET/.test(dump), dump.slice(0, 400));
  ok('事件字段恰好是契约白名单（没有 path/header/body）', events.every(event => Object.keys(event).sort().join(',') === EVENT_KEYS.slice().sort().join(',')), dump.slice(0, 300));
  ok('拒绝事件用 decision 前缀标出原因', events.some(e => e.decision === 'denied:host_not_granted') && events.some(e => e.decision === 'denied:private_address'));
  ok('放行事件带 resolved_ip / status_code / bytes', events.some(e => e.decision === 'allow' && e.resolved_ip === '127.0.0.1' && e.status_code === 200 && e.bytes > 0));
  ok('重定向事件单独留痕', events.some(e => e.decision === 'redirect_revalidated'));
  ok('CONNECT 事件记录协议与端口', events.some(e => e.protocol === 'https' && e.port === echoPort && e.status_code === 200));

  // network_events 是唯一的落库入口：写入后整表也不能出现凭据。
  for (const event of events) recordEvent(db, event);
  const rows = db.prepare('SELECT * FROM network_events').all();
  const tableDump = JSON.stringify(rows);
  ok('network_events 已落库', rows.length === events.length && rows.length > 0, rows.length + ' vs ' + events.length);
  ok('network_events 整表不含凭据、cookie、query 与正文', !/SECRET/.test(tableDump), tableDump.slice(0, 400));
  ok('network_events 列与契约一致', Object.keys(rows[0]).filter(key => key !== 'id' && key !== 'ts').sort().join(',') === EVENT_KEYS.slice().sort().join(','), Object.keys(rows[0]).join(','));

  // ---------- [7] supervisor 接线：能力不足不启代理，能力具备才注入 ----------
  for (const file of ['claude-supervisor.mjs', 'codex-supervisor.mjs']) {
    const source = fs.readFileSync(path.join(here, file), 'utf8');
    const body = sliceFunction(source, 'async function startTaskEgress(');
    // 走 127.0.0.1 + local_services：supervisor 里的 startTaskEgress 不注入 lookup，只能靠本地服务白名单。
    const taskNet = { id: 't-egress-wire', network_grants: [{ protocol: 'http', host: '127.0.0.1', ports: [upPort], purpose: 'smoke' }] };
    const idle = vm.runInNewContext('(' + body + ')', { CodexEngine: Codex, startEgressProxy, proxyEnv, log() {} });
    const blocked = await idle(taskNet, { capabilities: () => ({ networkIsolation: false }) }, policy, () => {});
    ok(file + ' 能力不足时不启动代理', blocked === null);
    let captured = [];
    const live = vm.runInNewContext('(' + body + ')', { CodexEngine: Codex, startEgressProxy, proxyEnv, log() {} });
    const started = await live(taskNet, { capabilities: () => ({ networkIsolation: true }) }, Object.assign({}, policy, { network: { default: 'deny', local_services: [{ port: upPort, purpose: 'smoke upstream' }] } }), event => captured.push(event));
    ok(file + ' 能力具备时返回代理地址与 env', !!started && /^http:\/\/127\.0\.0\.1:\d+$/.test(started.url) && started.env.HTTP_PROXY === started.url && started.env.HTTPS_PROXY === started.url, JSON.stringify(started && { url: started.url }));
    const viaSupervisor = await new Promise((resolve, reject) => {
      const target = new URL(started.url);
      const req = http.request({ host: target.hostname, port: target.port, path: 'http://127.0.0.1:' + upPort + '/ok' }, res => {
        let text = '';
        res.on('data', chunk => { text += chunk; });
        res.on('end', () => resolve({ status: res.statusCode, body: text }));
      });
      req.on('error', reject);
      req.end();
    });
    ok(file + ' 注入的代理真的能放行授权目标', viaSupervisor.status === 200 && /hello/.test(viaSupervisor.body), JSON.stringify(viaSupervisor));
    ok(file + ' 代理事件按契约字段回传', captured.length > 0 && captured.every(event => Object.keys(event).sort().join(',') === EVENT_KEYS.slice().sort().join(',')));
    await started.close();
    const gone = await new Promise(resolve => {
      const target = new URL(started.url);
      const req = http.request({ host: target.hostname, port: target.port, path: 'http://127.0.0.1:' + upPort + '/ok' }, () => resolve(false));
      req.on('error', () => resolve(true));
      req.end();
    });
    ok(file + ' close() 后代理不再监听', gone === true);
  }
} finally {
  for (const proxy of proxies) { try { await proxy.close(); } catch (e) {} }
  for (const server of servers) { await closeServer(server); }
  if (db) { try { db.close(); } catch (e) {} }
  try { fs.rmSync(temp, { recursive: true, force: true }); } catch (e) {}
}
console.log('\nPASS ' + pass + '   FAIL ' + fail);
if (fail) process.exitCode = 1;
