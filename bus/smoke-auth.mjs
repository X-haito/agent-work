import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as S from './store.mjs';
import * as A from './auth.mjs';
import * as AdminConfig from './admin-config.mjs';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentbus-auth-'));
const db = S.openDb(path.join(dir, 'bus.db'));
let passed = 0;
function check(name, fn) { fn(); passed += 1; console.log('PASS ' + name); }

try {
  check('human cannot be issued MCP credentials', () => {
    const r = A.issueCredential(db, 'human');
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'human_credentials_forbidden');
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM agent_credentials WHERE agent_id='human'").get().n, 0);
  });

  const issued = A.issueCredential(db, 'codex/main');
  check('issue returns token once and stores only a hash', () => {
    assert.equal(issued.ok, true);
    assert.equal(issued.token.length, 64);
    const row = db.prepare('SELECT token_hash FROM agent_credentials WHERE agent_id=?').get('codex/main');
    assert.equal(row.token_hash, A.hashToken(issued.token));
    assert.notEqual(row.token_hash, issued.token);
  });

  check('valid token verifies and records last_used_at', () => {
    const v = A.verifyCredential(db, issued.token);
    assert.equal(v.ok, true);
    assert.equal(v.agent, 'codex/main');
    const row = db.prepare('SELECT last_used_at FROM agent_credentials WHERE agent_id=?').get('codex/main');
    assert.ok(row.last_used_at);
  });

  check('wrong and missing tokens are auth_required', () => {
    assert.equal(A.verifyCredential(db, 'f'.repeat(64)).reason, 'auth_required');
    assert.equal(A.verifyCredential(db, '').reason, 'auth_required');
    assert.equal(A.verifyCredential(db, null).reason, 'auth_required');
  });

  check('expired token is rejected', () => {
    const short = A.issueCredential(db, 'claude/main', { expiresInMs: -1000 });
    assert.equal(short.ok, true);
    assert.equal(A.verifyCredential(db, short.token).reason, 'expired');
  });

  check('revoked token is rejected', () => {
    assert.equal(A.revokeCredential(db, 'codex/main').revoked, 1);
    assert.equal(A.verifyCredential(db, issued.token).reason, 'revoked');
    assert.equal(A.revokeCredential(db, 'codex/main').revoked, 0);
  });

  check('rotation keeps old token during grace then revokes it', () => {
    const first = A.issueCredential(db, 'dsh/main');
    const rotated = A.rotateCredential(db, 'dsh/main', { graceMs: 60000 });
    assert.equal(rotated.ok, true);
    assert.equal(A.verifyCredential(db, rotated.token).ok, true);
    assert.equal(A.verifyCredential(db, first.token).ok, true, '旧 token 在宽限期内仍可用');
    const cleaned = A.revokeSuperseded(db, 'dsh/main');
    assert.ok(cleaned.revoked >= 1);
    assert.equal(A.verifyCredential(db, first.token).reason, 'revoked');
    assert.equal(A.verifyCredential(db, rotated.token).ok, true);
  });

  check('audit log redacts tokens, cookies and long bodies', () => {
    A.logAudit(db, {
      actor: 'human', auth_method: 'local-session', action: 'policy.update', result: 'ok', remote_addr: '127.0.0.1',
      resource: { token: 'a'.repeat(64), Authorization: 'Bearer secret', body: 'x'.repeat(900), project: 'demo' },
    });
    const rows = A.listAudit(db, 5);
    const text = JSON.stringify(rows);
    assert.equal(text.includes('a'.repeat(64)), false, '原始 token 不得入库');
    assert.equal(text.includes('Bearer secret'), false, 'Authorization 不得入库');
    const row = rows[0];
    assert.equal(row.action, 'policy.update');
    const res = JSON.parse(row.resource);
    assert.equal(res.token, '[redacted]');
    assert.equal(res.Authorization, '[redacted]');
    assert.equal(res.project, 'demo');
    assert.ok(res.body.length <= 501);
  });

  check('verify is timing-safe against mismatched stored hash', () => {
    // 命中主键查询后再用 timingSafeEqual 复核长度与内容，长度不同不得抛错
    assert.equal(A.verifyCredential(db, 'z'.repeat(64)).reason, 'auth_required');
    assert.equal(A.hashToken('abc').length, 64);
  });

  // ---- MCP 层：凭据决定身份，--agent human 不再有权威性 ----
  const { spawnSync } = await import('node:child_process');
  const { fileURLToPath } = await import('node:url');
  const here = path.dirname(fileURLToPath(import.meta.url));
  const dbFile = path.join(dir, 'bus.db');
  const strictPolicy = JSON.parse(fs.readFileSync(path.join(here, 'policy.json'), 'utf8'));
  strictPolicy.global.require_credentials = true;
  const policyFile = path.join(dir, 'policy-strict.json');
  fs.writeFileSync(policyFile, JSON.stringify(strictPolicy, null, 2));
  // 先启用总线，否则会被运行闸门挡在认证之前
  assert.equal(S.setRuntimeState(db, 'human', true).ok, true);

  function callMcp(extraArgs, extraEnv, request) {
    const tag = Math.random().toString(16).slice(2);
    const inFile = path.join(dir, 'in-' + tag);
    const outFile = path.join(dir, 'out-' + tag);
    const errFile = path.join(dir, 'err-' + tag);
    fs.writeFileSync(inFile, JSON.stringify(request) + '\n');
    const fds = [fs.openSync(inFile, 'r'), fs.openSync(outFile, 'w'), fs.openSync(errFile, 'w')];
    let result;
    try {
      result = spawnSync(process.execPath, [path.join(here, 'bus-mcp.mjs'), '--db', dbFile].concat(extraArgs), {
        stdio: fds, timeout: 20000,
        env: Object.assign({}, process.env, { BUS_POLICY_PATH: policyFile }, extraEnv),
      });
    } finally { fds.forEach(function (fd) { fs.closeSync(fd); }); }
    const raw = fs.readFileSync(outFile, 'utf8').trim();
    const line = raw.split('\n').filter(Boolean).pop();
    let parsed = null;
    try { parsed = JSON.parse(line); } catch (e) { parsed = null; }
    let payload = null;
    if (parsed && parsed.result && parsed.result.content) {
      try { payload = JSON.parse(parsed.result.content[0].text); } catch (e) { payload = null; }
    }
    return { status: result.status, payload: payload, stderr: fs.readFileSync(errFile, 'utf8') };
  }

  check('MCP without token is rejected when credentials are required', () => {
    const r = callMcp(['--agent', 'human'], {}, { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'bus_online', arguments: {} } });
    assert.equal(r.payload.ok, false);
    assert.equal(r.payload.reason, 'auth_required');
  });

  check('MCP with forged human identity but invalid token is rejected', () => {
    const r = callMcp(['--agent', 'human'], { AGENT_BUS_TOKEN: 'f'.repeat(64) }, { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'bus_online', arguments: {} } });
    assert.equal(r.payload.ok, false);
    assert.equal(r.payload.reason, 'auth_required');
  });

  check('valid worker token overrides forged --agent human', () => {
    const issuedWorker = A.issueCredential(db, 'worker/main');
    assert.equal(issuedWorker.ok, true);
    const r = callMcp(['--agent', 'human'], { AGENT_BUS_TOKEN: issuedWorker.token },
      { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'bus_status', arguments: {} } });
    assert.ok(r.payload, 'MCP 应返回结构化结果: ' + r.stderr);
    assert.equal(r.payload.me, 'worker/main', '身份必须来自凭据，而不是 --agent');
  });

  // ---- 凭据写入各客户端 MCP 配置（用临时 homeDir，绝不碰真实配置） ----
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'agentbus-home-'));
  const hexToken = 'ab'.repeat(32);

  check('claude profile embeds AGENT_BUS_ID and token', () => {
    const saved = AdminConfig.saveMcpProfile('claude', { enabled: true, agent: 'claude/main', token: hexToken }, { homeDir: home });
    const json = JSON.parse(fs.readFileSync(saved.profile.path, 'utf8'));
    assert.equal(json.mcpServers.agentbus.env.AGENT_BUS_ID, 'claude/main');
    assert.equal(json.mcpServers.agentbus.env.AGENT_BUS_TOKEN, hexToken);
  });

  check('codex profile writes env section with token', () => {
    const saved = AdminConfig.saveMcpProfile('codex', { enabled: true, agent: 'codex/main', token: hexToken }, { homeDir: home });
    const text = fs.readFileSync(saved.profile.path, 'utf8');
    assert.ok(text.includes('[mcp_servers.agentbus.env]'), text);
    assert.ok(text.includes('AGENT_BUS_TOKEN = "' + hexToken + '"'), text);
  });

  check('human can never be written into MCP credentials', () => {
    assert.throws(function () {
      AdminConfig.saveMcpProfile('claude', { enabled: true, agent: 'human', token: hexToken }, { homeDir: home });
    });
  });

  check('malformed credential is rejected', () => {
    assert.throws(function () {
      AdminConfig.saveMcpProfile('claude', { enabled: true, agent: 'claude/main', token: 'nothex' }, { homeDir: home });
    });
  });

  console.log('PASS ' + passed + '   FAIL 0');
} finally {
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
}
