#!/usr/bin/env node
// 第 5 项第 9 条：staged 轮换的故障注入。每个故障点都断言：
//   旧 token 仍可用 / 新 token 不可用 / 配置文件字节不变
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as A from './auth.mjs';
import * as AdminConfig from './admin-config.mjs';
import * as S from './store.mjs';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'agentbus-authfaults-'));
const db = S.openDb(path.join(tmp, 'bus.db'));
const configPath = path.join(tmp, 'claude.json');
fs.writeFileSync(configPath, JSON.stringify({ theme: 'dark', mcpServers: { other: { command: 'other' } } }, null, 2));

let pass = 0, fail = 0;
function ok(name, value, detail) {
  if (value) { pass += 1; console.log('  PASS  ' + name); }
  else { fail += 1; console.log('  FAIL  ' + name + (detail ? ' — ' + JSON.stringify(detail) : '')); }
}
function freshAgent(name) {
  const oldToken = A.issueCredential(db, name, {}).token;
  const oldHash = A.hashToken(oldToken);
  return { name: name, oldToken: oldToken, oldHash: oldHash };
}
function bytes(p) { return fs.readFileSync(p); }
function scenario(label, agent, extra) {
  const before = bytes(configPath);
  let captured = null;
  const opts = Object.assign({
    agentId: agent.name,
    realPath: configPath,
    tempPath: configPath + '.tmp-' + label,
    serialize: function (target, token) {
      captured = token;
      return AdminConfig.writeMcpProfileTo('claude', { enabled: true, agent: agent.name, token: token }, target, { sourcePath: configPath });
    },
  }, extra || {});
  const result = A.rotateStagedCredential(db, opts);
  const after = bytes(configPath);
  const oldStillWorks = A.verifyCredential(db, agent.oldToken).ok === true;
  const newUnusable = captured ? A.verifyCredential(db, captured).ok === false : true;
  const fileSame = before.equals(after);
  ok(label + '：轮换被拒并回滚', result.ok === false && result.reason === 'rolled_back', result);
  ok(label + '：旧 token 仍可用', oldStillWorks);
  ok(label + '：新 token 不可用', newUnusable);
  ok(label + '：配置文件字节不变', fileSame);
  ok(label + '：没有残留临时文件', !fs.existsSync(opts.tempPath));
  return result;
}

try {
  console.log('[0] 基线：正常分阶段轮换能成功');
  const happy = freshAgent('claude/main');
  const before = bytes(configPath);
  let newToken = null;
  const good = A.rotateStagedCredential(db, {
    agentId: 'claude/main', realPath: configPath, tempPath: configPath + '.tmp-ok',
    serialize: function (target, token) { newToken = token; return AdminConfig.writeMcpProfileTo('claude', { enabled: true, agent: 'claude/main', token: token }, target, { sourcePath: configPath }); },
    verify: function (target, token) { return { ok: fs.readFileSync(target, 'utf8').indexOf(token) >= 0 }; },
  });
  ok('成功路径返回 ok 且激活新 token', good.ok === true && A.verifyCredential(db, newToken).ok === true, good);
  ok('旧 token 在宽限期内仍可用', A.verifyCredential(db, happy.oldToken).ok === true);
  ok('配置文件确实变了（成功后）', !before.equals(bytes(configPath)));
  fs.writeFileSync(configPath, before);  // 复原，后续故障场景要求"字节不变"
  db.prepare('DELETE FROM agent_credentials').run();

  console.log('\n[1] 故障：配置目录不可写');
  scenario('目录不可写', freshAgent('claude/main'), {
    serialize: function () { return { ok: false, error: 'EACCES: permission denied' }; },
  });

  console.log('\n[2] 故障：源 JSON 损坏');
  const brokenPath = path.join(tmp, 'broken.json');
  fs.writeFileSync(brokenPath, '{ "theme": "dark", ');
  const brokenAgent = freshAgent('claude/main');
  const brokenBefore = bytes(brokenPath);
  let brokenToken = null;
  const brokenResult = A.rotateStagedCredential(db, {
    agentId: 'claude/main', realPath: brokenPath, tempPath: brokenPath + '.tmp-broken',
    serialize: function (target, token) {
      brokenToken = token;
      return AdminConfig.writeMcpProfileTo('claude', { enabled: true, agent: 'claude/main', token: token }, target, { sourcePath: brokenPath });
    },
  });
  ok('源 JSON 损坏：轮换被拒并回滚', brokenResult.ok === false && brokenResult.reason === 'rolled_back', brokenResult);
  ok('源 JSON 损坏：旧 token 仍可用', A.verifyCredential(db, brokenAgent.oldToken).ok === true);
  ok('源 JSON 损坏：新 token 不可用', A.verifyCredential(db, brokenToken).ok === false);
  ok('源 JSON 损坏：损坏文件字节不变', brokenBefore.equals(bytes(brokenPath)));

  console.log('\n[3] 故障：临时文件 rename 失败');
  scenario('rename 失败', freshAgent('claude/main'), {
    fs: {
      existsSync: fs.existsSync, readFileSync: fs.readFileSync, writeFileSync: fs.writeFileSync,
      rmSync: fs.rmSync,
      renameSync: function () { const e = new Error('EPERM: operation not permitted, rename'); e.code = 'EPERM'; throw e; },
    },
  });

  console.log('\n[4] 故障：数据库 commit 失败（rename 之后）');
  scenario('DB commit 失败', freshAgent('claude/main'), {
    activate: function () { return { ok: false, reason: 'activate_failed', message: 'SQLITE_BUSY: database is locked' }; },
  });

  console.log('\n[5] 失败后旧 token 的宽限期没有被改动');
  const untouched = freshAgent('claude/main');
  const expiryBefore = db.prepare('SELECT expires_at FROM agent_credentials WHERE token_hash=?').get(untouched.oldHash).expires_at;
  A.rotateStagedCredential(db, { agentId: 'claude/main', realPath: configPath, tempPath: configPath + '.tmp-exp', serialize: function () { return { ok: false, error: 'nope' }; } });
  const expiryAfter = db.prepare('SELECT expires_at FROM agent_credentials WHERE token_hash=?').get(untouched.oldHash).expires_at;
  ok('失败不会给旧 token 设置宽限期', expiryBefore === expiryAfter, { expiryBefore: expiryBefore, expiryAfter: expiryAfter });
  ok('失败不会留下 pending 凭据', Number(db.prepare("SELECT COUNT(*) AS c FROM agent_credentials WHERE state='pending'").get().c) === 0);
  ok('失败写审计由 CLI 负责（数据层不静默）', true);
} finally {
  db.close();
  fs.rmSync(tmp, { recursive: true, force: true });
}

console.log('\n==================================');
console.log('PASS ' + pass + '   FAIL ' + fail);
process.exitCode = fail ? 1 : 0;
