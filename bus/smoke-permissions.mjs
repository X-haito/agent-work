// 第 5 项第 10/11/12 条：ACL 加固的 fail-closed 记录、审计下沉同事务、认证就绪门禁。
// 原则：ACL 做不到就如实返回 ok:false 并被记录，安全门禁放在 doctor --auth-readiness/validatePolicy；
// 绝不为了让测试变绿而假装 ACL 成功。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as S from './store.mjs';
import * as Auth from './auth.mjs';
import * as A from './admin-config.mjs';
import * as FP from './platform/file-permissions.mjs';

let pass = 0, fail = 0;
function ok(name, cond, detail) {
  if (cond) { pass++; console.log('PASS ' + name); return true; }
  // 对象用 JSON 打印：String(obj) 只会得到 [object Object]，CI 上等于没有信息。
  const shown = detail === undefined ? '' : (typeof detail === 'string' ? detail : JSON.stringify(detail)).slice(0, 300);
  fail++; console.log('FAIL ' + name + (shown ? ' :: ' + shown : ''));
  return false;
}
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'agentbus-perm-'));
const policy = S.loadPolicy();

// ---------- [1] 平台权限：真实环境 + 注入桩 ----------
const user = FP.currentUser();
if (process.platform === 'win32') {
  ok('能取到当前用户 SID', typeof user.sid === 'string' && /^S-1-\d+-\d+/.test(user.sid), user);
} else {
  // POSIX 没有 SID 概念：要求取到用户名，且**不编造** SID（编一个假的比 null 更危险）。
  ok('POSIX：能取到当前用户名且不编造 SID', typeof user.name === 'string' && user.name.length > 0 && user.sid === null, user);
}
const plainFile = path.join(temp, 'plain.json');
fs.writeFileSync(plainFile, '{"a":1}\n');
const realVerify = FP.verify(plainFile);
ok('新建文件默认不通过 ACL 校验（fail-closed）', realVerify.ok === false && String(realVerify.detail).length > 0, realVerify);
const realHarden = FP.harden(plainFile);
ok('harden 返回结构化结果且不抛错', typeof realHarden.ok === 'boolean' && typeof realHarden.method === 'string' && typeof realHarden.detail === 'string', realHarden);
if (realHarden.ok === false) {
  ok('加固失败时如实记录原因（不静默、不假装成功）', /失败|denied|受托人|SID/i.test(realHarden.detail), realHarden);
  const afterFail = FP.verify(plainFile);
  ok('加固失败后 verify 仍判不合格（没有自我安慰）', afterFail.ok === false, afterFail);
} else {
  const afterOk = FP.verify(plainFile);
  ok('加固成功后 verify 通过', afterOk.ok === true, afterOk);
}
ok('空路径与不存在的路径都 fail-closed', FP.harden('').ok === false && FP.verify('').ok === false && FP.harden(path.join(temp, 'nope.json')).ok === false);

// 注入桩：验证参数数组调用与输出解析（本机改不了 ACL，但别让解析逻辑没人测）
const calls = [];
const fakeUser = { sid: 'S-1-5-21-1111-2222-3333-4444', name: 'HOST\\tester' };
const okRun = (cmd, args) => {
  calls.push([cmd].concat(args));
  if (cmd === 'icacls' && args[0] === plainFile) return { status: 0, stdout: '', stderr: '' };
  return { status: 0, stdout: '', stderr: '' };
};
const stubHarden = FP.harden(plainFile, { run: okRun, user: fakeUser });
ok('harden 用参数数组调用 icacls（不拼 shell 字符串）',
  stubHarden.ok === true && calls.some(c => c[0] === 'icacls' && c[1] === plainFile && c[2] === '/inheritance:r') &&
  calls.some(c => c[0] === 'icacls' && c[2] === '/grant:r' && c[3] === '*' + fakeUser.sid + ':F'),
  JSON.stringify(calls));
ok('harden 在 icacls 失败时不返回 ok:true',
  FP.harden(plainFile, { run: () => ({ status: 1, stdout: '', stderr: 'Access is denied.' }), user: fakeUser }).ok === false);
// 第 1 项：verify 必须返回**结构化** ACL 结论，且同一 SID 以账户名显示时仍然通过。
{
  const aclFile = path.join(temp, 'acl-structured.json');
  fs.writeFileSync(aclFile, '{}\n');
  // 注意：路径与第一条 ACE 必须分行——stripPaths 会剥掉路径，同行会把 ACE 一起带走。
  const base = function (aces) { return { status: 0, stdout: aclFile + '\n' + aces.join('\n') + '\n', stderr: '' }; };
  // 同一 SID 被 icacls 显示成 domain\\user（本地化/解析差异）——不得因此判不合格。
  const asName = FP.verify(aclFile, { run: function () { return base(['BUILTIN\\runneradmin:(F)']); }, user: { sid: 'S-1-5-21-1-2-3-500', name: 'runneradmin' } });
  ok('verify：同一账户名（大小写/域名不同）仍判合格', asName.ok === true && asName.inherited === false && asName.extra_principals.length === 0, asName);
  ok('verify：返回 expected_sid / expected_name / matched_principals', asName.expected_sid === 'S-1-5-21-1-2-3-500' && asName.expected_name === 'runneradmin' && asName.matched_principals.length === 1, asName);
  // 额外 SYSTEM / Administrators 必须失败，并把它们列在 extra_principals 里。
  const extra = FP.verify(aclFile, { run: function () { return base(['BUILTIN\\runneradmin:(F)', 'NT AUTHORITY\\SYSTEM:(F)', 'BUILTIN\\Administrators:(F)']); }, user: { sid: 'S-1-5-21-1-2-3-500', name: 'runneradmin' } });
  ok('verify：额外 SYSTEM/Administrators 必须失败', extra.ok === false && extra.extra_principals.length === 2, extra);
  ok('verify：失败时也带结构化字段（不是只有文案）', extra.inherited === false && Array.isArray(extra.matched_principals) && extra.matched_principals.length === 1, extra);
  // 继承 ACE 必须失败并置 inherited=true。
  const inh = FP.verify(aclFile, { run: function () { return base(['BUILTIN\\runneradmin:(F)', 'BUILTIN\\Users:(I)(RX)']); }, user: { sid: 'S-1-5-21-1-2-3-500', name: 'runneradmin' } });
  ok('verify：继承 ACE 必须失败且 inherited=true', inh.ok === false && inh.inherited === true, inh);
}

ok('取不到 SID 时 harden 也 fail-closed',
  FP.harden(plainFile, { run: () => ({ status: 1, stdout: '', stderr: '' }) }).ok === false);
const aceOk = FP.verify(plainFile, { run: () => ({ status: 0, stdout: plainFile + ' HOST\\tester:(F)\n', stderr: '' }), user: fakeUser });
ok('只授当前用户时 verify 通过', aceOk.ok === true, aceOk);
const aceOther = FP.verify(plainFile, { run: () => ({ status: 0, stdout: plainFile + ' HOST\\tester:(F)\n  BUILTIN\\Users:(RX)\n', stderr: '' }), user: fakeUser });
ok('多出受托人时 verify 判不合格', aceOther.ok === false && /BUILTIN/.test(aceOther.detail), aceOther);
const aceInherited = FP.verify(plainFile, { run: () => ({ status: 0, stdout: plainFile + ' HOST\\tester:(I)(F)\n', stderr: '' }), user: fakeUser });
ok('仍带继承标记时 verify 判不合格', aceInherited.ok === false && /继承/.test(aceInherited.detail), aceInherited);

// POSIX 分支：此前只有 Windows 跑过（台账 D4 的空白）。这里补上真实 chmod 语义。
if (process.platform === 'win32') {
  console.log('  SKIP  POSIX 分支（chmod 0600）—— 当前是 win32，不是 PASS');
} else {
  const posixFile = path.join(temp, 'posix-mode.json');
  fs.writeFileSync(posixFile, '{}\n');
  fs.chmodSync(posixFile, 0o644);
  const loose = FP.verify(posixFile);
  ok('POSIX：0644 时 verify 判不合格', loose.ok === false && loose.method === 'posix', loose);
  const narrowed = FP.harden(posixFile);
  const afterNarrow = FP.verify(posixFile);
  ok('POSIX：harden 收窄为 0600 且 verify 通过', narrowed.ok === true && narrowed.method === 'posix' && afterNarrow.ok === true, { narrowed, afterNarrow });
  const mode = fs.statSync(posixFile).mode & 0o777;
  ok('POSIX：实际模式不含 group/other 权限位', (mode & 0o077) === 0, mode.toString(8));
}

// ---------- [2] admin-config：加固结果记录在 acl 字段，且不因为改不了 ACL 就写不进配置 ----------
const homeDir = path.join(temp, 'home');
fs.mkdirSync(path.join(homeDir, '.codex'), { recursive: true });
const savedNoToken = A.saveMcpProfile('codex', { enabled: true, agent: 'codex/main' }, { homeDir: homeDir });
ok('不带 token 的 MCP 配置写入成功并返回 acl 记录', !!savedNoToken.profile && !!savedNoToken.acl && typeof savedNoToken.acl.ok === 'boolean', savedNoToken.acl);
ok('acl 记录里带 method 与 detail（失败时能看出原因）', typeof savedNoToken.acl.method === 'string' && typeof savedNoToken.acl.detail === 'string', savedNoToken.acl);
const codexFile = savedNoToken.profile.path;
ok('配置文件确实写到了磁盘', fs.existsSync(codexFile) && fs.readFileSync(codexFile, 'utf8').indexOf('agentbus') >= 0);
if (savedNoToken.acl.ok === false) {
  console.log('  （本机 ACL 不可写：' + savedNoToken.acl.detail + '）');
  ok('ACL 失败不阻止写入，但如实记为 ok:false', savedNoToken.acl.ok === false && fs.existsSync(codexFile));
}
const atomicTarget = path.join(temp, 'atomic.json');
const atomic = A.atomicWrite(atomicTarget, '{"ok":true}\n');
ok('atomicWrite 返回临时/正式/备份三处 acl 记录', !!atomic.acl && !!atomic.acl.temp && !!atomic.acl.file && !!atomic.acl.backup, atomic.acl);
ok('atomicWrite 在 ACL 失败时也不抛错且文件已写入', fs.existsSync(atomicTarget), atomic);

// ---------- [3] 审计下沉：同一事务、不伪造 actor、拒绝也留痕 ----------
const db = S.openDb(path.join(temp, 'audit.db'));
S.setRuntimeState(db, 'human', true);
const ctx = { actor: 'codex/main', auth_method: 'mcp-token', remote_addr: '127.0.0.1' };
function auditRows(action, taskId) {
  return db.prepare('SELECT actor,auth_method,action,resource,result,remote_addr FROM audit_log WHERE action=? ORDER BY id DESC').all(action)
    .filter(function (row) { return !taskId || String(row.resource || '').indexOf(taskId) >= 0; });
}
const t1 = S.createTask(db, { title: 'audit accept', project: 'demo', status: 'proposed', target: 'codex/main', redline: ['fs:delete'] });
S.accept(db, 'human', t1.id, ['human'], { actor: 'human', auth_method: 'board-session', remote_addr: '127.0.0.1' });
const acceptRows = auditRows('task.accept', t1.id);
ok('accept 写审计（actor/auth_method/remote_addr 原样落库）',
  acceptRows.length === 1 && acceptRows[0].actor === 'human' && acceptRows[0].auth_method === 'board-session' && acceptRows[0].remote_addr === '127.0.0.1' && acceptRows[0].result === 'ok', acceptRows);
ok('审计 resource 里带任务 id', /t-\d+/.test(String(acceptRows[0] && acceptRows[0].resource)), acceptRows[0] && acceptRows[0].resource);

const t2 = S.createTask(db, { title: 'audit decline', project: 'demo', status: 'open', target: 'claude/main' });
S.decline(db, 'claude/main', t2.id, '不接', ['human'], ctx);
ok('decline 写审计且 actor 是请求者', auditRows('task.decline', t2.id).some(r => r.actor === 'codex/main' && r.auth_method === 'mcp-token'), auditRows('task.decline', t2.id));

const t3 = S.createTask(db, { title: 'audit cancel', project: 'demo', status: 'open' });
S.cancelTask(db, policy, 'human', t3.id, '不做了', undefined, { actor: 'human', auth_method: 'local-cli' });
ok('cancel 写审计', auditRows('task.cancel', t3.id).some(r => r.actor === 'human'));

const t4 = S.createTask(db, { title: 'audit reassign', project: 'demo', status: 'open', target: 'claude/main' });
S.reassignTask(db, policy, 'codex/main', t4.id, 'dsh/main', undefined, ctx);
ok('reassign 写审计', auditRows('task.reassign', t4.id).some(r => r.actor === 'codex/main'));

const t5 = S.createTask(db, { title: 'audit override', project: 'demo', status: 'open' });
S.updateTask(db, 'codex/main', t5.id, 'failed', '失败', undefined, undefined, ctx);
S.overrideTask(db, 'human', t5.id, '人工放行', ['human'], { actor: 'human', auth_method: 'board-session' });
ok('override 写审计', auditRows('task.override', t5.id).some(r => r.actor === 'human'));

const t6 = S.createTask(db, { title: 'audit complete', project: 'demo', status: 'open' });
S.claim(db, 'codex/main', t6.id);
S.updateTask(db, 'codex/main', t6.id, 'in_progress', 'x', undefined, undefined, ctx);
S.updateTask(db, 'codex/main', t6.id, 'review', 'y', undefined, undefined, ctx);
S.updateTask(db, 'human', t6.id, 'done', 'ok', undefined, ['human'], { actor: 'human', auth_method: 'board-session' });
ok('complete（done）写审计', auditRows('task.complete', t6.id).some(r => r.actor === 'human'), auditRows('task.complete', t6.id));

const t7 = S.createTask(db, { title: 'audit runtime', project: 'demo', status: 'open' });
const runtimeBefore = S.getRuntimeState(db);
S.setRuntimeState(db, 'human', false, runtimeBefore.version, { actor: 'human', auth_method: 'local-cli', remote_addr: '::1' });
S.setRuntimeState(db, 'human', true, undefined, { actor: 'human', auth_method: 'local-cli' });
ok('运行总闸写审计', auditRows('runtime.toggle').length >= 2 && auditRows('runtime.toggle').some(r => r.remote_addr === '::1'));

const t8 = S.createTask(db, { title: 'no ctx', project: 'demo', status: 'open' });
S.decline(db, 'codex/main', t8.id, '无上下文');
const noCtx = auditRows('task.decline', t8.id);
ok('authContext 缺省时 actor 记 unknown（不拿参数里的 agent 冒充）', noCtx.length === 1 && noCtx[0].actor === 'unknown' && noCtx[0].auth_method === 'unknown', noCtx);

const t9 = S.createTask(db, { title: 'redact', project: 'demo', status: 'open', target: 'codex/main' });
const secretCtx = { actor: 'codex/main', auth_method: 'mcp-token', token: 'f'.repeat(64), cookie: 'sess=abc', remote_addr: '127.0.0.1' };
S.decline(db, 'codex/main', t9.id, 'x', ['human'], secretCtx);
const dump = JSON.stringify(db.prepare('SELECT actor,auth_method,action,resource,result,remote_addr FROM audit_log').all());
ok('审计里不出现 token / cookie 原文', dump.indexOf('f'.repeat(64)) < 0 && dump.indexOf('sess=abc') < 0);

// 审计写不进去 → 状态变更必须回滚（同事务）
const brokeDb = S.openDb(path.join(temp, 'broken.db'));
S.setRuntimeState(brokeDb, 'human', true);
const t10 = S.createTask(brokeDb, { title: 'atomic', project: 'demo', status: 'proposed', target: 'codex/main' });
brokeDb.exec('DROP TABLE audit_log');
let threw = false;
try { S.accept(brokeDb, 'human', t10.id, ['human'], { actor: 'human' }); } catch (error) { threw = true; }
const stillProposed = S.getTask(brokeDb, t10.id).status;
ok('审计写入失败时状态变更回滚（同事务语义）', threw === true && stillProposed === 'proposed', { threw, stillProposed });
try { brokeDb.close(); } catch (e) {}

// ---------- [4] 就绪检查与门禁 ----------
const rdb = S.openDb(path.join(temp, 'ready.db'));
const emptyReadiness = S.authReadiness(rdb, { profiles: [] });
ok('没有任何已启用客户端时 readiness=false', emptyReadiness.ready === false && emptyReadiness.blockers.length > 0, emptyReadiness);
const profileFile = path.join(temp, 'profile.json');
fs.writeFileSync(profileFile, '{}\n');
const noToken = S.authReadiness(rdb, { profiles: [{ id: 'codex', agent: 'codex/main', enabled: true, path: profileFile }], verify: () => ({ ok: true, detail: 'stub' }) });
ok('没有 active 凭据时 readiness=false 且指出是凭据问题', noToken.ready === false && noToken.clients[0].hasActiveToken === false && noToken.blockers.some(b => /凭据/.test(b)), noToken);
const issued = Auth.issueCredential(rdb, 'codex/main');
ok('issueCredential 能签发', issued.ok !== false && typeof issued.token === 'string', issued && issued.ok);
const withToken = S.authReadiness(rdb, { profiles: [{ id: 'codex', agent: 'codex/main', enabled: true, path: profileFile }], verify: () => ({ ok: true, detail: 'stub' }) });
ok('有 active 凭据且 ACL 合格时 readiness=true', withToken.ready === true && withToken.clients[0].hasActiveToken === true && withToken.clients[0].permissionOk === true, withToken);
const aclBad = S.authReadiness(rdb, { profiles: [{ id: 'codex', agent: 'codex/main', enabled: true, path: profileFile }], verify: () => ({ ok: false, detail: '额外受托人' }) });
ok('ACL 不合格时 readiness=false 且指出是权限问题', aclBad.ready === false && aclBad.blockers.some(b => /权限/.test(b)), aclBad);
const realReadiness = S.authReadiness(rdb, { profiles: [{ id: 'codex', agent: 'codex/main', enabled: true, path: profileFile }], verify: FP.verify });
ok('用真实 verify 判定时本机未就绪（ACL 改不了就是没就绪）', realReadiness.ready === false && realReadiness.clients[0].permissionOk === false, realReadiness);

// pending 凭据不算 active
rdb.prepare("INSERT INTO agent_credentials(agent_id,token_hash,created_at,expires_at,revoked_at,last_used_at,state) VALUES(?,?,?,?,?,?,?)")
  .run('claude/main', 'a'.repeat(64), new Date().toISOString(), null, null, null, 'pending');
const pendingOnly = S.authReadiness(rdb, { profiles: [{ id: 'claude', agent: 'claude/main', enabled: true, path: profileFile }], verify: () => ({ ok: true, detail: 'stub' }) });
ok('只有 pending 凭据时不算就绪（staged 轮换期间不能启用）', pendingOnly.ready === false && pendingOnly.clients[0].hasActiveToken === false, pendingOnly);

// 门禁：未就绪时禁止把 require_credentials 置 true
const basePolicy = JSON.parse(JSON.stringify(policy));
basePolicy.global.require_credentials = true;
let gateThrew = false;
try { A.validatePolicy(basePolicy, { authReadiness: { ready: false, blockers: ['codex: 权限不合格'] } }); } catch (error) { gateThrew = /auth_readiness_failed/.test(String(error.message)); }
ok('未就绪时 validatePolicy 拒绝开启 require_credentials', gateThrew === true);
let gateOk = null;
try { gateOk = A.validatePolicy(basePolicy, { authReadiness: { ready: true, clients: [], blockers: [] } }); } catch (error) { gateOk = { error: String(error.message) }; }
ok('就绪时允许开启 require_credentials', !!gateOk && gateOk.global && gateOk.global.require_credentials === true, gateOk && gateOk.error);
const baseOff = JSON.parse(JSON.stringify(policy));
baseOff.global.require_credentials = false;
ok('不开启认证时不触发门禁（未就绪也能保存策略）', A.validatePolicy(baseOff, {}).global.require_credentials === false);

try { rdb.close(); } catch (e) {}
try { db.close(); } catch (e) {}
try { fs.rmSync(temp, { recursive: true, force: true }); } catch (e) {}
console.log('\nPASS ' + pass + '   FAIL ' + fail);
if (fail) process.exitCode = 1;
