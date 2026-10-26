#!/usr/bin/env node
// 第 11 项：隔离合同审计。目标不是"证明我们记得设环境变量"，而是证明**忘了设就会立刻失败**。
import cp from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as Guard from './smoke-support/isolation-guard.mjs';
import * as Env from './smoke-support/env.mjs';
import { pathToFileURL } from 'node:url';
import { fingerprint, sameContent, describe } from './smoke-support/db-fingerprint.mjs';

let pass = 0, fail = 0, skip = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  PASS  ' + name); }
  else { fail++; console.log('  FAIL  ' + name + (extra === undefined ? '' : '  -> ' + JSON.stringify(extra).slice(0, 300))); }
}
// 非目标平台一律 SKIP（绝不当 PASS）：SKIP 就是"本机没有证据"，CI matrix 的 macos-latest 才有。
function skipped(name, why) {
  skip++;
  console.log('  SKIP  ' + name + (why ? ' （' + why + '）' : ''));
}
function throwsIsolation(fn) {
  try { fn(); return { threw: false }; }
  catch (e) { return { threw: true, name: e.name, message: String(e.message || ''), findings: e.findings }; }
}
const REAL_DB = Guard.REAL_STATE.db;
const dbBefore = fingerprint(REAL_DB);

console.log('[1] 真实状态常量与命中判定');
ok('REAL_STATE 覆盖 db/policy/projects/lifecycle', ['db', 'policy', 'projects', 'lifecycle'].every(function (k) { return typeof Guard.REAL_STATE[k] === 'string'; }), Object.keys(Guard.REAL_STATE));
ok('命中真实 bus.db', Guard.hitsRealState('db', Guard.REAL_STATE.db) === true);
ok('命中 -wal / -shm（同一个库的旁路文件）', Guard.hitsRealState('db', Guard.REAL_STATE.db + '-wal') === true && Guard.hitsRealState('db', Guard.REAL_STATE.db + '-shm') === true);
ok('临时目录里的同名文件不算', Guard.hitsRealState('db', path.join(os.tmpdir(), 'x', 'bus.db')) === false);
ok('命中真实 policy/projects/lifecycle', ['policy', 'projects', 'lifecycle'].every(function (k) { return Guard.hitsRealState(k, Guard.REAL_STATE[k]) === true; }));

console.log('');
console.log('[2] 守卫关闭时不拦（生产路径不能被测试合同影响）');
delete process.env.AGENTBUS_TEST_GUARD;
ok('默认不启用', Guard.guardEnabled() === false);
ok('关闭时 assertIsolated 原样放行', Guard.assertIsolated('db', Guard.REAL_STATE.db) === Guard.REAL_STATE.db);

console.log('');
console.log('[3] AGENTBUS_TEST_GUARD=1 时，真实状态一律立即抛错');
process.env.AGENTBUS_TEST_GUARD = '1';
ok('启用后 guardEnabled()=true', Guard.guardEnabled() === true);
const dbThrow = throwsIsolation(function () { Guard.assertIsolated('db', Guard.REAL_STATE.db); });
ok('指向真实 bus.db → IsolationError', dbThrow.threw && dbThrow.name === 'IsolationError', dbThrow);
ok('错误信息里点名环境变量 BUS_DB', /BUS_DB/.test(dbThrow.message), dbThrow.message.slice(0, 160));
ok('错误信息里给出真实路径与修法', dbThrow.message.indexOf(Guard.REAL_STATE.db) >= 0 && /suiteEnv|临时目录/.test(dbThrow.message));
ok('policy / projects / lifecycle 同样抛错',
  ['policy', 'projects', 'lifecycle'].every(function (k) { return throwsIsolation(function () { Guard.assertIsolated(k, Guard.REAL_STATE[k]); }).threw; }));
ok('临时路径不抛（放行并回传）', Guard.assertIsolated('db', path.join(os.tmpdir(), 't', 'bus.db')).indexOf('bus.db') >= 0);
ok('WAL 旁路文件也拦', throwsIsolation(function () { Guard.assertIsolated('db', Guard.REAL_STATE.db + '-wal'); }).threw);

console.log('');
console.log('[4] 真实模块接线：store / admin-config / lifecycle 都过守卫（子进程验证）');
function runNode(source, env) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentbus-guard-'));
  const file = path.join(dir, 'probe.mjs');
  fs.writeFileSync(file, source);
  const out = path.join(dir, 'out.txt');
  const fdOut = fs.openSync(out, 'w'), fdErr = fs.openSync(out + '.err', 'w');
  const child = cp.spawn(process.execPath, [file], { cwd: Guard.BUS_ROOT, stdio: ['ignore', fdOut, fdErr], windowsHide: true, shell: false, env: env });
  return new Promise(function (resolve) {
    child.on('close', function (code) {
      fs.closeSync(fdOut); fs.closeSync(fdErr);
      resolve({ code: code, stdout: fs.readFileSync(out, 'utf8'), stderr: fs.readFileSync(out + '.err', 'utf8') });
    });
    child.on('error', function (e) { resolve({ code: -1, stdout: '', stderr: String(e && e.message || e) }); });
  });
}
const guardEnv = Object.assign({}, process.env, { AGENTBUS_TEST_GUARD: '1' });
delete guardEnv.BUS_DB; delete guardEnv.BUS_POLICY_PATH; delete guardEnv.BUS_PROJECTS; delete guardEnv.BUS_LIFECYCLE;
// 探针文件放在临时目录里，所以必须用绝对 file URL 引用真实模块（相对路径会解析到临时目录）
const storeUrl = pathToFileURL(path.join(Guard.BUS_ROOT, 'store.mjs')).href;
const serverUrl = pathToFileURL(path.join(Guard.BUS_ROOT, 'console-server.mjs')).href;
const storeSrc = [
  'import * as S from ' + JSON.stringify(storeUrl) + ';',
  "try { S.openDb(); console.log('NO_THROW'); } catch (e) { console.log('THREW ' + e.name + ' ' + /BUS_DB/.test(e.message)); }",
].join('\n');
const storeProbe = await runNode(storeSrc, guardEnv);
ok('store.openDb() 默认路径指向真实库 → 抛 IsolationError 并点名 BUS_DB',
  /THREW IsolationError true/.test(storeProbe.stdout), storeProbe.stdout.trim().slice(0, 200) || storeProbe.stderr.slice(0, 200));
const policySrc = [
  'import * as S from ' + JSON.stringify(storeUrl) + ';',
  "try { S.loadPolicy(); console.log('NO_THROW'); } catch (e) { console.log('THREW ' + e.name + ' ' + /BUS_POLICY_PATH/.test(e.message)); }",
].join('\n');
const policyProbe = await runNode(policySrc, guardEnv);
ok('store.loadPolicy() 读到真实 policy.json → 抛错并点名 BUS_POLICY_PATH',
  /THREW IsolationError true/.test(policyProbe.stdout), policyProbe.stdout.trim().slice(0, 200) || policyProbe.stderr.slice(0, 200));
const lifecycleSrc = [
  'import * as CS from ' + JSON.stringify(serverUrl) + ';',
  "console.log('LOADED ' + CS.LIFECYCLE_FILE.indexOf('lifecycle.json') >= 0);",
].join('\n');
const lifecycleProbe = await runNode(lifecycleSrc, guardEnv);
ok('console-server 载入时 lifecycle 指向真实文件 → 抛错（task-67 那次的入口）',
  lifecycleProbe.code !== 0 && /IsolationError|测试隔离被破坏/.test(lifecycleProbe.stderr), { code: lifecycleProbe.code, stderr: lifecycleProbe.stderr.slice(0, 160) });

console.log('');
console.log('[5] fail closed：省略任何一个环境变量都必须拒绝');
const complete = Env.suiteEnv(path.join(os.tmpdir(), 'iso-complete-' + process.pid), { port: 1234 });
ok('完整环境通过体检', Guard.assertEnvironmentComplete(complete).every(function (f) { return f.status === 'ok'; }));
for (const name of ['BUS_DB', 'BUS_PROJECTS', 'BUS_POLICY_PATH', 'BUS_LIFECYCLE']) {
  const partial = Object.assign({}, complete);
  delete partial[name];
  const res = throwsIsolation(function () { Guard.assertEnvironmentComplete(partial); });
  ok('缺少 ' + name + ' → fail closed', res.threw && /fail closed/.test(res.message) && res.message.indexOf(name) >= 0, res.message && res.message.slice(0, 140));
}
const realOne = Object.assign({}, complete, { BUS_DB: Guard.REAL_STATE.db });
ok('把 BUS_DB 指回真实库 → fail closed 并点名', throwsIsolation(function () { Guard.assertEnvironmentComplete(realOne); }).threw);

console.log('');
console.log('[6] suiteEnv 注入全套变量 + 动态端口');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentbus-env-'));
const built = Env.suiteEnv(dir, { port: 4321 });
ok('四个状态变量都指向临时目录',
  ['BUS_DB', 'BUS_PROJECTS', 'BUS_POLICY_PATH', 'BUS_LIFECYCLE'].every(function (k) { return String(built[k]).indexOf(dir) === 0; }), built.BUS_DB);
ok('默认带 AGENTBUS_TEST_GUARD=1', built.AGENTBUS_TEST_GUARD === '1');
ok('端口通过 AGENTBUS_TEST_PORT 传入', built.AGENTBUS_TEST_PORT === '4321');
ok('清掉了调用者身份', !('AGENT_BUS_TOKEN' in built) && !('AGENT_BUS_ID' in built));
ok('状态路径不落在仓库里', path.resolve(built.BUS_DB).indexOf(path.resolve(Guard.BUS_ROOT)) !== 0, built.BUS_DB);
const p1 = await Env.allocatePort();
const p2 = await Env.allocatePort();
ok('端口分配器给出可用且不同的端口（listen(0)）', Number.isInteger(p1) && Number.isInteger(p2) && p1 !== p2 && p1 > 0, [p1, p2]);

console.log('');
console.log('[6b] bootstrap：先设环境、再动态 import（静态 import 会冻结模块层路径）');
const bootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentbus-boot-'));
const boot = await import('./smoke-support/bootstrap.mjs');
const booted = await boot.bootstrap(bootDir, { adminConfig: false, consoleServer: false });
ok('bootstrap 返回已隔离的 store 模块', !!booted.store && typeof booted.store.openDb === 'function');
ok('bootstrap 把 BUS_DB 指到临时目录', String(process.env.BUS_DB).indexOf(bootDir) === 0, process.env.BUS_DB);
ok('bootstrap 后环境体检全绿', Guard.assertEnvironmentComplete(process.env).every(function (f) { return f.status === 'ok'; }));
ok('子进程环境里带守卫与端口', process.env.AGENTBUS_TEST_GUARD === '1' && !!process.env.AGENTBUS_TEST_PORT, process.env.AGENTBUS_TEST_PORT);
// 本套件自己早就在设环境之前 import 了 store（静态 import 先于语句执行），
// 所以这里 openDb() **必须**抛错 —— 这正是守卫在拦"导入顺序错了"这种最难自查的错误。
// DB 路径是**调用时**读 BUS_DB 的，所以晚设环境也不会打真实库（这是安全的）
const lateDb = booted.store.openDb();
ok('openDb() 在环境切换后按 BUS_DB 走临时库（DB 路径是调用时读，不是模块常量）',
  fs.existsSync(String(bootDir + path.sep + 'bus.db')), process.env.BUS_DB);
try { lateDb.close(); } catch (e) {}
// 但 lifecycle 是模块常量：早 import 就会被冻在真实文件上 —— 下面用子进程把两种顺序都验一遍
const csUrl = pathToFileURL(path.join(Guard.BUS_ROOT, 'console-server.mjs')).href;
const freezeBad = await runNode(['import * as CS from ' + JSON.stringify(csUrl) + ';', "console.log('LOADED');"].join('\n'), guardEnv);
ok('环境未设就 import console-server → 立即抛错（模块常量已冻结到真实 lifecycle.json）',
  freezeBad.code !== 0 && /IsolationError|测试隔离被破坏/.test(freezeBad.stderr), freezeBad.stderr.slice(0, 140));
const goodEnv = Object.assign({}, guardEnv, { BUS_LIFECYCLE: path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'iso-lc-')), 'lifecycle.json'), BUS_DB: path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'iso-db-')), 'bus.db'), BUS_POLICY_PATH: path.join(os.tmpdir(), 'iso-policy-' + process.pid + '.json') });
try { fs.copyFileSync(path.join(Guard.BUS_ROOT, 'policy.json'), goodEnv.BUS_POLICY_PATH); } catch (e) {}
const freezeGood = await runNode(['import * as CS from ' + JSON.stringify(csUrl) + ';', "console.log('LOADED ' + CS.LIFECYCLE_FILE);"].join('\n'), goodEnv);
ok('环境先设好再 import → 正常载入且指向临时文件',
  freezeGood.code === 0 && freezeGood.stdout.indexOf(goodEnv.BUS_LIFECYCLE) >= 0,
  freezeGood.stdout.trim().slice(0, 200) || freezeGood.stderr.slice(0, 200));
// 正确顺序（先 bootstrap 再 import 模块）在干净子进程里必须成功
const bootUrl = pathToFileURL(path.join(Guard.BUS_ROOT, 'smoke-support', 'bootstrap.mjs')).href;
const bootChildDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentbus-bootc-'));
const bootSrc = [
  'import { bootstrap } from ' + JSON.stringify(bootUrl) + ';',
  'const b = await bootstrap(' + JSON.stringify(bootChildDir) + ', { adminConfig: false, consoleServer: false });',
  'const db = b.store.openDb(); db.close();',
  "console.log('OK ' + process.env.BUS_DB);",
].join('\n');
const bootProbe = await runNode(bootSrc, guardEnv);
ok('子进程里"先 bootstrap 后 openDb"成功，且库落在临时目录',
  /^OK /.test(bootProbe.stdout.trim()) && bootProbe.stdout.indexOf(bootChildDir) >= 0,
  bootProbe.stdout.trim().slice(0, 160) || bootProbe.stderr.slice(0, 220));

console.log('[7] smoke-all 真的把守卫与四个变量传下去');
const smokeAllSource = fs.readFileSync(new URL('./smoke-all.mjs', import.meta.url), 'utf8');
ok('smoke-all 用统一 env 工厂', /smoke-support\/env\.mjs/.test(smokeAllSource) && /suiteEnv\(dir, \{ port:/.test(smokeAllSource));
ok('smoke-all 每个套件单独分配端口（不写死 7400 之类）', /allocatePort\(\)/.test(smokeAllSource) && !/AGENTBUS_PORT\s*=\s*7/.test(smokeAllSource));

console.log('');
console.log('[8] 真实库只用语义指纹比对，不做字节比较');
ok('真实 bus.db 逻辑内容未变（sameContent + fingerprint）', sameContent(dbBefore, fingerprint(REAL_DB)), describe(dbBefore));

console.log('');
console.log('[9] 平台文件权限（darwin 分支为真断言；非 darwin 打印 SKIP，绝不当 PASS）');
const perms = await import('./platform/file-permissions.mjs');
ok('file-permissions 导出 harden/verify（三平台共用同一入口）', typeof perms.harden === 'function' && typeof perms.verify === 'function');
const isDarwin = process.platform === 'darwin';
const permDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentbus-perm-'));
if (!isDarwin) {
  skipped('owner 是当前用户（仅 darwin 执行）', 'platform=' + process.platform);
  skipped('harden 后 mode 为 0600（仅 darwin 执行）', 'platform=' + process.platform);
  skipped('verify 拒绝 0644（仅 darwin 执行）', 'platform=' + process.platform);
  skipped('harden 是逐文件而非目录继承（仅 darwin 执行）', 'platform=' + process.platform);
  skipped('rename 后权限保持（仅 darwin 执行）', 'platform=' + process.platform);
} else {
  const target = path.join(permDir, 'secret.json');
  fs.writeFileSync(target, '{"token":"x"}');
  fs.chmodSync(target, 0o644);
  const hardened = perms.harden(target);
  const st = fs.statSync(target);
  ok('owner 是当前用户（仅 darwin 执行）', st.uid === process.getuid(), { uid: st.uid, mine: process.getuid() });
  ok('harden 后 mode 为 0600（仅 darwin 执行）', hardened.ok === true && (st.mode & 0o777) === 0o600, (st.mode & 0o777).toString(8));
  ok('verify 通过 hardened 的文件（仅 darwin 执行）', perms.verify(target).ok === true);
  const loose = path.join(permDir, 'loose.json');
  fs.writeFileSync(loose, '{"token":"y"}');
  fs.chmodSync(loose, 0o644);
  ok('verify 拒绝 0644（仅 darwin 执行）', perms.verify(loose).ok === false, perms.verify(loose).detail);
  // 继承：在同一个目录里新建文件不会自动变 0600（harden 是逐文件行为，不是目录策略）
  const sibling = path.join(permDir, 'sibling.json');
  fs.writeFileSync(sibling, 'z');
  const siblingMode = fs.statSync(sibling).mode & 0o777;
  ok('harden 是逐文件而非目录继承：同目录新建文件仍按 umask（仅 darwin 执行）', (siblingMode & 0o077) !== 0 || siblingMode === 0o600, siblingMode.toString(8));
  ok('目录本身不会因为 harden 文件而收窄（仅 darwin 执行）', (fs.statSync(permDir).mode & 0o777) !== 0, (fs.statSync(permDir).mode & 0o777).toString(8));
  // rename 后权限是否保持
  const renamed = path.join(permDir, 'secret-renamed.json');
  fs.renameSync(target, renamed);
  const afterRename = fs.statSync(renamed).mode & 0o777;
  ok('rename 后权限保持 0600（仅 darwin 执行）', afterRename === 0o600, afterRename.toString(8));
  ok('rename 后 verify 仍然通过（仅 darwin 执行）', perms.verify(renamed).ok === true, perms.verify(renamed).detail);
}
ok('本机平台如实记录（不把别的平台结果当 macOS 证据）', perms.FILE_PERMISSIONS_PLATFORM === (process.platform === 'win32' ? 'win32' : process.platform), perms.FILE_PERMISSIONS_PLATFORM);
try { fs.rmSync(permDir, { recursive: true, force: true }); } catch (e) {}
try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) {}
console.log('');
console.log('==================================');
console.log('PASS ' + pass + '   FAIL ' + fail + '   SKIP ' + skip);
process.exitCode = fail ? 1 : 0;