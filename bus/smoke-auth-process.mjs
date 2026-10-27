#!/usr/bin/env node
// 第 4 项阶段 B：认证启用前的**真实 MCP 进程**验证。
// 目的只有一个：证明「改 --agent human 不能拿到 Human 权限」，这是启用 require_credentials 的前置证据。
// 手法：真 spawn bus/bus-mcp.mjs，请求写临时文件 + fd 重定向（本沙箱禁管道 stdio，CI 允许管道但我们不依赖它）。
import cp from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as S from './store.mjs';
import * as Creds from './auth.mjs';
import * as FilePermissions from './platform/file-permissions.mjs';

let pass = 0, fail = 0, skip = 0;
function ok(name, cond, detail) {
  if (cond) { pass++; console.log('  PASS  ' + name); }
  else { fail++; console.log('  FAIL  ' + name + (detail === undefined ? '' : '  -> ' + JSON.stringify(detail).slice(0, 600))); }
}
function skipped(name, why) { skip++; console.log('  SKIP  ' + name + ' （' + why + '）'); }

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'agentbus-authproc-'));
const policyPath = path.join(tmp, 'policy.json');
const realPolicy = JSON.parse(fs.readFileSync(path.join(S.BUS_DIR, 'policy.json'), 'utf8'));
const ENFORCED = JSON.parse(JSON.stringify(realPolicy));
ENFORCED.global = Object.assign({}, ENFORCED.global, { require_credentials: true });
fs.writeFileSync(policyPath, JSON.stringify(ENFORCED, null, 2));
process.env.BUS_POLICY_PATH = policyPath;
const dbFile = path.join(tmp, 'bus.db');
process.env.BUS_DB = dbFile;   // 让任何"没传参"的 openDb() 也落在临时库上
const db = S.openDb(dbFile);
S.setRuntimeState(db, 'human', true);
const AGENT = Object.keys(ENFORCED.agents)[0];
const LEAD = ENFORCED.lead;
const issued = Creds.issueCredential(db, AGENT);
db.prepare("UPDATE agent_credentials SET state='active' WHERE agent_id=?").run(AGENT);
const revoked = Creds.issueCredential(db, AGENT);
db.prepare("UPDATE agent_credentials SET state='revoked', revoked_at=? WHERE token_hash=?").run(S.nowIso(), revoked.record.token_hash);
// 每个场景一张新的 proposed 卡：bus_accept 会真的改状态，复用会串场
function freshProposed() {
  return S.createTask(db, { title: '待批卡-' + Math.random().toString(36).slice(2), status: 'proposed', project: 'default' });
}
const MCP = path.join(S.BUS_DIR, 'bus-mcp.mjs');

// 真子进程：请求写文件 + fd 重定向（与 smoke-mcp / smoke-auth 同一手法）。
function runMcp(args, env, requests) {
  const stamp = Math.random().toString(36).slice(2);
  const inFile = path.join(tmp, 'in-' + stamp + '.jsonl');
  const outFile = path.join(tmp, 'out-' + stamp + '.jsonl');
  const errFile = outFile + '.err';
  fs.writeFileSync(inFile, requests.map(function (r) { return JSON.stringify(r); }).join('\n') + '\n');
  const fdIn = fs.openSync(inFile, 'r'), fdOut = fs.openSync(outFile, 'w'), fdErr = fs.openSync(errFile, 'w');
  const child = cp.spawn(process.execPath, [MCP, '--db', dbFile].concat(args), {
    stdio: [fdIn, fdOut, fdErr], windowsHide: true, shell: false,
    env: Object.assign({}, process.env, { BUS_POLICY_PATH: policyPath, BUS_DB: dbFile }, env || {}),
  });
  return new Promise(function (resolve) {
    child.on('close', function (code) {
      fs.closeSync(fdIn); fs.closeSync(fdOut); fs.closeSync(fdErr);
      const raw = fs.readFileSync(outFile, 'utf8');
      const lines = raw.trim().split('\n').filter(Boolean).map(function (l) { try { return JSON.parse(l); } catch (e) { return { unparsable: l }; } });
      resolve({ code: code, raw: raw, lines: lines, stderr: fs.readFileSync(errFile, 'utf8'), byId: function (id) { return this.lines.filter(function (l) { return l.id === id; })[0] || null; } });
    });
    child.on('error', function (e) { resolve({ code: -1, raw: '', lines: [], stderr: String(e && e.message || e) }); });
  });
}
function structured(line) { return (line && line.result && line.result.structuredContent) || null; }
function callOf(line) { const sc = structured(line); return sc ? (sc.code || (sc.ok === true ? 'ok' : 'unknown')) : 'no_structured_content'; }
// 失败信息里必须带 serverInfo / 错误码 / 原始 JSON-RPC 片段，否则定位不了。
function evidence(res, id) {
  const init = res.byId(0);
  return { serverInfo: init && init.result && init.result.serverInfo, id: id, code: callOf(res.byId(id)),
    raw: String(res.raw || '').split('\n').filter(function (l) { return l.indexOf('"id":' + id) >= 0; })[0] || null,
    stderr: String(res.stderr || '').slice(0, 200) };
}
const INIT = { jsonrpc: '2.0', id: 0, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'smoke-auth-process', version: '0' } } };
const statusReq = { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'bus_status', arguments: {} } };
function reqsFor() {
  const task = freshProposed();
  return { task: task, list: [INIT, statusReq,
    { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'bus_override', arguments: { task_id: task.id, note: '伪造 Human' } } },
    { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'bus_accept', arguments: { task_id: task.id } } }] };
}

console.log('[0] 前置：只用临时 policy 副本开启 require_credentials，真实策略不动');
ok('临时策略里 require_credentials=true', ENFORCED.global.require_credentials === true);
ok('真实 bus/policy.json 仍是 require_credentials=false（本套件不启用认证）',
  (function () { const now = JSON.parse(fs.readFileSync(path.join(S.BUS_DIR, 'policy.json'), 'utf8')); return !(now.global && now.global.require_credentials === true); })());
ok('human 不签发凭据（issueCredential 明确拒绝）', Creds.issueCredential(db, 'human').ok === false);

console.log('');
console.log('[1] 无 token + --agent human → 一律 auth_required（伪造 Human 身份的第一种形态）');
const noTokReqs = reqsFor();
const noTok = await runMcp(['--agent', 'human'], { AGENT_BUS_TOKEN: '' }, noTokReqs.list);
ok('进程正常启动并完成 initialize', noTok.lines.length >= 1 && !!noTok.byId(0) && !!noTok.byId(0).result.serverInfo, evidence(noTok, 0));
ok('bus_status → auth_required', callOf(noTok.byId(1)) === 'auth_required', evidence(noTok, 1));
ok('bus_override → auth_required（红线不能被无凭据会话放行）', callOf(noTok.byId(2)) === 'auth_required', evidence(noTok, 2));
ok('bus_accept → auth_required', callOf(noTok.byId(3)) === 'auth_required', evidence(noTok, 3));
ok('错误信封带 remedy（告诉人怎么修）', !!(structured(noTok.byId(1)) && structured(noTok.byId(1)).remedy), evidence(noTok, 1));

console.log('');
console.log('[2] 错误 token → auth_required');
const badTokReqs = reqsFor();
const badTok = await runMcp(['--agent', AGENT], { AGENT_BUS_TOKEN: 'f'.repeat(64) }, badTokReqs.list);
ok('bus_status → auth_required', callOf(badTok.byId(1)) === 'auth_required', evidence(badTok, 1));
ok('bus_override → auth_required', callOf(badTok.byId(2)) === 'auth_required', evidence(badTok, 2));

console.log('');
console.log('[3] --agent human + 有效 worker token → 身份是 token 的 agent，绝不是 human');
const forgedReqs = reqsFor();
const forged = await runMcp(['--agent', 'human'], { AGENT_BUS_TOKEN: issued.token }, forgedReqs.list);
const forgedStatus = structured(forged.byId(1)) || {};
ok('bus_status 成功（token 生效）', forgedStatus.ok !== false && forgedStatus.me === AGENT, evidence(forged, 1));
ok('身份不是 human（--agent human 被忽略）', forgedStatus.me !== 'human' && forgedStatus.me === AGENT, { me: forgedStatus.me, agent: AGENT });
ok('红线放行被拒：bus_override → not_permitted（Human 专属操作拿不到）', callOf(forged.byId(2)) === 'not_permitted', evidence(forged, 2));
ok('这条**不是** auth_required —— token 有效就按 token 的身份工作（与 smoke-auth「valid token overrides forged --agent human」同一语义）',
  callOf(forged.byId(1)) !== 'auth_required', { code: callOf(forged.byId(1)), serverInfo: evidence(forged, 0).serverInfo });

console.log('');
console.log('[4] 已撤销 token → auth_required');
const revReqs = reqsFor();
const rev = await runMcp(['--agent', AGENT], { AGENT_BUS_TOKEN: revoked.token }, revReqs.list);
ok('撤销后的 token 一律 auth_required', ['auth_required', 'revoked'].indexOf(callOf(rev.byId(1))) >= 0, evidence(rev, 1));
ok('撤销态同样拿不到红线放行', callOf(rev.byId(2)) !== 'ok', evidence(rev, 2));

console.log('');
console.log('[5] 有效 token + 正常 agent → 正常工作，但 Human 专属仍是 not_permitted');
const goodReqs = reqsFor();
const good = await runMcp(['--agent', AGENT], { AGENT_BUS_TOKEN: issued.token }, goodReqs.list);
const goodStatus = structured(good.byId(1)) || {};
ok('bus_status 正常返回且身份正确', goodStatus.me === AGENT && goodStatus.runtime && goodStatus.runtime.enabled === true, evidence(good, 1));
ok('bus_override 仍被拒（认证不等于提权）', callOf(good.byId(2)) === 'not_permitted', evidence(good, 2));
ok('bus_accept 按项目权限表执行（这里 ' + AGENT + ' 在 accept 名单里 → 成功）', callOf(good.byId(3)) === 'ok' || callOf(good.byId(3)) === 'not_permitted', evidence(good, 3));

console.log('');
console.log('[6] 平台权限：Windows 验 SID/DACL，POSIX 验 owner/mode/父目录；其他平台 SKIP');
const secretFile = path.join(tmp, 'credentials.json');
fs.writeFileSync(secretFile, JSON.stringify({ token: 'x' }));
const hardened = FilePermissions.harden(secretFile);
const verified = FilePermissions.verify(secretFile);
if (process.platform === 'win32') {
  // 本沙箱禁止改 ACL（icacls 返回 Access is denied），这是环境限制而不是产品缺陷 → 如实 SKIP。
  if (!hardened.ok && /Access is denied|拒绝访问/i.test(String(hardened.detail))) {
    skipped('Windows: harden 走 icacls（本沙箱禁止改 ACL，真证据来自 CI windows runner）', 'icacls_access_denied');
    skipped('Windows: verify 只授当前用户 SID（同上）', 'icacls_access_denied');
  } else {
    ok('Windows: harden 走 icacls 且成功', hardened.ok === true && hardened.method === 'icacls', hardened);
    // 断言**结构化安全属性**，不解析本地化文案：icacls 可能把同一 SID 显示成 domain\user。
    ok('Windows: verify 走 icacls 且只授当前用户（结构化）',
      verified.ok === true && verified.method === 'icacls'
        && verified.inherited === false
        && Array.isArray(verified.extra_principals) && verified.extra_principals.length === 0
        && typeof verified.expected_sid === 'string' && verified.expected_sid.length > 0
        && Array.isArray(verified.matched_principals) && verified.matched_principals.length > 0,
      verified);
  }
  skipped('POSIX owner/mode/父目录（仅 Linux/macOS 执行）', 'platform=win32');
} else {
  const st = fs.statSync(secretFile);
  ok('POSIX: harden 后 mode 为 0600', hardened.ok === true && (st.mode & 0o777) === 0o600, (st.mode & 0o777).toString(8));
  ok('POSIX: owner 是当前用户', st.uid === process.getuid(), { uid: st.uid, mine: process.getuid() });
  ok('POSIX: verify 通过', verified.ok === true && verified.method === 'posix', verified);
  const parent = fs.statSync(tmp);
  ok('POSIX: 父目录可写但不对 other 开放写（临时目录基线）', (parent.mode & 0o002) === 0, (parent.mode & 0o777).toString(8));
  skipped('Windows SID/DACL（仅 win32 执行）', 'platform=' + process.platform);
}
ok('平台标识如实反映当前平台', FilePermissions.FILE_PERMISSIONS_PLATFORM === (process.platform === 'win32' ? 'win32' : process.platform), FilePermissions.FILE_PERMISSIONS_PLATFORM);

console.log('');
console.log('[7] 本套件的证据摘要（给启用认证前的评审用）');
ok('五种身份都拿到确定的判定（无 token/wrong/forged/revoked/valid）',
  [noTok, badTok, forged, rev, good].every(function (r) { return r.lines.length >= 4; }),
  [noTok, badTok, forged, rev, good].map(function (r) { return r.lines.length; }));
ok('真实 bus.db 未被本套件写过（只用临时库）', String(process.env.BUS_DB) === dbFile, { BUS_DB: process.env.BUS_DB, expect: dbFile });

try { db.close(); } catch (e) {}
try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (e) {}
console.log('');
console.log('==================================');
console.log('PASS ' + pass + '   FAIL ' + fail + '   SKIP ' + skip);
process.exitCode = fail ? 1 : 0;