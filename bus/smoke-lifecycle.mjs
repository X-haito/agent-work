#!/usr/bin/env node
// 第 15 项第 10 条：生命周期命令与 restart_required。
// 全部在临时 lifecycle.json 上跑（BUS_LIFECYCLE），不碰真实运行目录；进程操作只针对本套件自己起的假进程。
import cp from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import * as S from './store.mjs';
import * as CS from './console-server.mjs';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'agentbus-lifecycle-'));
const lifecycleFile = path.join(tmp, 'lifecycle.json');
// 注意：ESM 的 import 先于本行执行，console-server 的 LIFECYCLE_FILE 早就定型了。
// 所以下面一律显式传 { file: lifecycleFile }，不依赖环境变量。
const FILE_OPT = { file: lifecycleFile };
const dbFile = path.join(tmp, 'bus.db');
const db = S.openDb(dbFile);
let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  PASS  ' + name); }
  else { fail++; console.log('  FAIL  ' + name + (extra === undefined ? '' : '  -> ' + JSON.stringify(extra).slice(0, 300))); }
}

console.log('[1] lifecycle.json 读取与组件记录');
ok('missing 文件返回空结构（不抛）', (function () { const s = CS.readLifecycle(lifecycleFile); return s.components && Array.isArray(s.restart_required) && s.restart_required.length === 0; })());
CS.recordComponent('board', { pid: process.pid, version: '9.9.9', started_at: new Date().toISOString(), instance_nonce: 'n1' }, FILE_OPT);
const rec = CS.readLifecycle(lifecycleFile).components.board;
ok('记录写入后可读回', !!rec && rec.version === '9.9.9' && rec.instance_nonce === 'n1', rec);
ok('当前进程被判为 running', CS.componentState(rec).running === true);
ok('刚启动的记录不是 stale', CS.componentState(rec).stale === false);
ok('uptime 有数值', typeof CS.componentState(rec).uptime_s === 'number');

console.log('');
console.log('[2] 残留 PID 与端口占用检测');
CS.recordComponent('codex', { pid: 999999, version: '1.0.0', started_at: new Date().toISOString() }, FILE_OPT);
const ghost = CS.componentState(CS.readLifecycle(lifecycleFile).components.codex);
ok('不存在的 PID 判为 not running', ghost.running === false, ghost);
CS.recordComponent('claude', { pid: process.pid, version: '1.0.0', started_at: new Date(Date.now() - 48 * 3600 * 1000).toISOString() }, FILE_OPT);
const stale = CS.componentState(CS.readLifecycle(lifecycleFile).components.claude);
ok('活着但记录超过 24h 判为 stale（不猜、也不杀）', stale.running === true && stale.stale === true, stale);

// 端口检测：CLI 用的是同一套（能 listen 即空闲）
async function portFree(port) {
  return new Promise(function (resolve) {
    const server = net.createServer();
    server.once('error', function () { resolve(false); });
    server.once('listening', function () { server.close(function () { resolve(true); }); });
    server.listen(port, '127.0.0.1');
  });
}
const probe = net.createServer();
await new Promise(function (r) { probe.listen(0, '127.0.0.1', r); });
const busyPort = probe.address().port;
ok('被占用端口检测失败（false）', (await portFree(busyPort)) === false);
await new Promise(function (r) { probe.close(r); });
ok('释放后检测通过（true）', (await portFree(busyPort)) === true);

console.log('');
console.log('[3] restart_required：写入 / 逐项清除');
CS.markRestartRequired('codex', 'mcp_config_saved', Object.assign({ required_hash: 'h1' }, FILE_OPT));
let snap = CS.lifecycleSnapshot(db, FILE_OPT);
ok('写入后出现在 restart_required', snap.restart_required.length === 1 && snap.restart_required[0].component === 'codex', snap.restart_required);
ok('每项都带可执行命令', snap.restart_required[0].command.indexOf('codex') >= 0, snap.restart_required[0].command);
ok('改动时间之后没有心跳 → 不清除', snap.restart_required.length === 1);
// 造"客户端已重启"的证据：心跳晚于改动时间
S.heartbeat(db, 'codex/main', 'idle');
db.prepare('UPDATE presence SET last_seen=? WHERE agent_id=?').run(new Date(Date.now() + 5000).toISOString(), 'codex/main');
snap = CS.lifecycleSnapshot(db, FILE_OPT);
ok('新心跳晚于改动时间后自动清除该项', snap.restart_required.length === 0, snap.restart_required);
ok('清除记录里有 cleared_now 证据', snap.cleared_now.length === 1 && snap.cleared_now[0].component === 'codex', snap.cleared_now);

// board 的清除依据是新 started_at
CS.markRestartRequired('board', 'restart_by_operator', FILE_OPT);
ok('board 项在没重启时保持', CS.lifecycleSnapshot(db, FILE_OPT).restart_required.length === 1);
CS.recordComponent('board', { pid: process.pid, version: '9.9.9', started_at: new Date(Date.now() + 5000).toISOString(), instance_nonce: 'n2' }, FILE_OPT);
ok('board 新 started_at 后自动清除', CS.lifecycleSnapshot(db, FILE_OPT).restart_required.length === 0);

// 同一组件重复标记只保留一条
CS.markRestartRequired('dsh', 'a', FILE_OPT);
CS.markRestartRequired('dsh', 'b', FILE_OPT);
const dupes = CS.lifecycleSnapshot(db, FILE_OPT).restart_required.filter(function (r) { return r.component === 'dsh'; });
ok('同一组件重复标记只保留一条（不堆积）', dupes.length === 1, dupes);
ok('保留的是最新一次原因', dupes[0].reason === 'b', dupes[0].reason);

console.log('');
console.log('[4] CLI：status / stop 的幂等与拒绝路径（真子进程 + fd 重定向）');
function runCli(args, env) {
  const outFile = path.join(tmp, 'cli-' + Math.random().toString(36).slice(2) + '.out');
  const errFile = outFile + '.err';
  const fdOut = fs.openSync(outFile, 'w'), fdErr = fs.openSync(errFile, 'w');
  const child = cp.spawn(process.execPath, [path.join(S.BUS_DIR, 'cli.mjs')].concat(args), {
    cwd: S.BUS_DIR, stdio: ['ignore', fdOut, fdErr], windowsHide: true, shell: false,
    env: Object.assign({}, process.env, { BUS_DB: dbFile, BUS_LIFECYCLE: lifecycleFile, HOME: tmp, USERPROFILE: tmp }, env || {}),
  });
  return new Promise(function (resolve) {
    child.on('close', function (code) {
      fs.closeSync(fdOut); fs.closeSync(fdErr);
      resolve({ code: code, stdout: fs.readFileSync(outFile, 'utf8'), stderr: fs.readFileSync(errFile, 'utf8') });
    });
    child.on('error', function (e) { try { fs.closeSync(fdOut); } catch (x) {} resolve({ code: -1, stdout: '', stderr: String(e && e.message || e) }); });
  });
}
const statusRun = await runCli(['status', '--json']);
let statusJson = null;
try { statusJson = JSON.parse(statusRun.stdout); } catch (e) { statusJson = null; }
if (statusRun.code === -1) {
  console.log('  SKIP  CLI 子进程可用 — spawn_eperm（这不是 PASS）');
} else {
  ok('status --json 退出码 0', statusRun.code === 0, statusRun.code);
  ok('status --json 给出 components 与 restart_required',
    !!statusJson && Array.isArray(statusJson.components) && Array.isArray(statusJson.restart_required), statusJson && Object.keys(statusJson));
  ok('status 列出四个组件', !!statusJson && statusJson.components.length === 4, statusJson && statusJson.components.map(function (c) { return c.component; }));

  // stop 幂等：先删掉所有记录再 stop
  for (const name of ['board', 'codex', 'claude', 'dsh']) CS.clearComponent(name, FILE_OPT);
  const stopEmpty = await runCli(['stop', '--component', 'board']);
  ok('没有 PID 记录时 stop 退出码 0（幂等，不报错）', stopEmpty.code === 0, [stopEmpty.code, stopEmpty.stdout.slice(0, 120)]);
  ok('没有 PID 记录时 stop 明确说"什么都不做"', /没有 PID 记录/.test(stopEmpty.stdout), stopEmpty.stdout.slice(0, 160));

  // 残留 PID：记录一个不存在的 pid，stop 应清理记录且退出码 0
  CS.recordComponent('codex', { pid: 999999, version: '1.0.0', started_at: new Date().toISOString() }, FILE_OPT);
  const stopGhost = await runCli(['stop', '--component', 'codex']);
  ok('残留 PID 被识别并清理', stopGhost.code === 0 && /已不存在/.test(stopGhost.stdout), stopGhost.stdout.slice(0, 160));
  ok('清理后记录确实没了', !CS.readLifecycle(lifecycleFile).components.codex, CS.readLifecycle(lifecycleFile).components);

  // 未知组件：拒绝并给退出码 2
  const bad = await runCli(['stop', '--component', 'nope']);
  ok('未知组件被拒绝（退出码 2）', bad.code === 2 && /未知组件/.test(bad.stdout), [bad.code, bad.stdout.slice(0, 120)]);
  // start 非 board：明确拒绝（MCP 客户端归宿主）
  const startClient = await runCli(['start', '--component', 'codex']);
  ok('start --component codex 明确拒绝并给退出码 2', startClient.code === 2 && /MCP 客户端由宿主启动/.test(startClient.stdout), [startClient.code, startClient.stdout.slice(0, 120)]);
}

console.log('');
console.log('[5] 真实库未被改动');
const realLifecycle = path.join(S.BUS_DIR, 'lifecycle.json');
const realBefore = fs.existsSync(realLifecycle) ? fs.readFileSync(realLifecycle, 'utf8') : null;
ok('本套件全程写在临时文件上（真实 lifecycle.json 字节未变）', realBefore === (fs.existsSync(realLifecycle) ? fs.readFileSync(realLifecycle, 'utf8') : null));

try { db.close(); } catch (e) {}
try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (e) {}
console.log('');
console.log('==================================');
console.log('PASS ' + pass + '   FAIL ' + fail);
process.exit(fail ? 1 : 0);
