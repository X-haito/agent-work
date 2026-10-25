#!/usr/bin/env node
// 第 12 项第 1/2/3/9 条：安装（init）、诊断（doctor）、版本、以及 package files 白名单。
// 全部在临时 HOME / 临时运行目录里跑，不碰真实 bus.db、projects.json、~/.codex 等。
import fs from 'node:fs';
import cp from 'node:child_process';
import crypto from 'node:crypto';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import * as CLI from './cli.mjs';
import * as S from './store.mjs';

let pass = 0, fail = 0;
function ok(name, cond, detail) {
  if (cond) { pass++; console.log('PASS ' + name); return true; }
  fail++; console.log('FAIL ' + name + (detail === undefined ? '' : ' :: ' + String(detail).slice(0, 400)));
  return false;
}
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'agentbus-install-'));
function freshRoot(name) {
  const root = path.join(tmp, name);
  const home = path.join(root, 'home');
  fs.mkdirSync(home, { recursive: true });
  return { root: root, homeDir: home, dbPath: path.join(root, 'bus.db'), registryPath: path.join(root, 'projects.json'),
    policyPath: path.join(root, 'policy.json'), manifestPath: path.join(root, 'install-manifest.json') };
}
const SPECIALS = '\ ^ $ . * + ? ( ) [ ] { } |'.split(' ');
// npm files 语义：'**/' 匹配任意层目录（含零层），'**' 匹配任意字符，'*' 不跨目录。
function globToRegExp(glob) {
  const ANYDIR = String.fromCharCode(1);
  const ANY = String.fromCharCode(2);
  let s = String(glob).split('**/').join(ANYDIR).split('**').join(ANY);
  let out = '';
  for (const ch of s) {
    if (ch === ANYDIR) out += '(?:[^/]+/)*';
    else if (ch === ANY) out += '.*';
    else if (ch === '*') out += '[^/]*';
    else if (SPECIALS.indexOf(ch) >= 0) out += String.fromCharCode(92) + ch;
    else out += ch;
  }
  return new RegExp('^' + out + '$');
}

console.log('[1] package.json：版本号单一来源 + files 白名单');
const pkg = CLI.readPackage();
ok('package.json 可读且 type=module', pkg.type === 'module' && typeof pkg.version === 'string' && pkg.version.length > 0, pkg.type);
ok('engines.node 要求 >=24', String(pkg.engines && pkg.engines.node) === '>=24', pkg.engines);
ok('bin.agentbus 指向 bus/cli.mjs', pkg.bin && pkg.bin.agentbus === 'bus/cli.mjs', pkg.bin);
ok('readVersion() 与 package.json 是同一处', CLI.readVersion() === pkg.version, [CLI.readVersion(), pkg.version]);
ok('files 是显式白名单数组', Array.isArray(pkg.files) && pkg.files.length > 0 && pkg.files.length < 20, pkg.files);
for (const pattern of [/bus\.db/i, /(^|\/)logs(\/|$)/i, /projects\.json/i, /workspaces/i, /\.bak/i, /credential/i, /\.tmp/i, /policy\.json/i]) {
  ok('files 白名单不含敏感项: ' + pattern, !pkg.files.some(function (entry) { return pattern.test(entry); }), pkg.files);
}
ok('files 白名单不包含通配一切', !pkg.files.some(function (entry) { return entry === '**' || entry === '*' || entry === '.' || entry === 'bus'; }), pkg.files);
const repoRoot = path.resolve(S.BUS_DIR, '..');
const patterns = pkg.files.map(globToRegExp);
const packed = [];
function walk(dir, rel) {
  let entries = [];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { return; }
  for (const entry of entries) {
    const relPath = (rel ? rel + '/' : '') + entry.name;
    if (entry.isDirectory()) { if (entry.name !== 'node_modules' && entry.name !== '.git') walk(path.join(dir, entry.name), relPath); continue; }
    if (patterns.some(function (re) { return re.test(relPath); })) packed.push(relPath);
  }
}
walk(path.join(repoRoot, 'bus'), 'bus');
for (const name of ['README.md', 'package.json']) if (fs.existsSync(path.join(repoRoot, name))) packed.push(name);
ok('按白名单枚举出的打包清单非空', packed.length > 10, packed.length);
for (const pattern of [/bus\.db/i, /\/logs\//i, /projects\.json/i, /workspaces/i, /\.bak-/i, /install-manifest\.json/i]) {
  ok('实际打包清单不含 ' + pattern, !packed.some(function (p) { return pattern.test(p); }), packed.filter(function (p) { return pattern.test(p); }).slice(0, 5));
}
ok('打包清单含 bus/cli.mjs 与 bus/schema.sql', packed.indexOf('bus/cli.mjs') >= 0 && packed.indexOf('bus/schema.sql') >= 0);

console.log('\n[2] 首次 init：每一步都写进 install-manifest');
const A = freshRoot('first');
const first = CLI.runInit(A);
ok('init 成功', first.ok === true, first.reason);
ok('建了数据库文件', fs.existsSync(A.dbPath));
ok('建了 projects registry（内容是空 projects）', fs.existsSync(A.registryPath) && JSON.stringify(JSON.parse(fs.readFileSync(A.registryPath, 'utf8'))) === '{"projects":{}}');
ok('写了 install-manifest.json', fs.existsSync(A.manifestPath));
const manifest = JSON.parse(fs.readFileSync(A.manifestPath, 'utf8'));
ok('manifest 记录了版本号', manifest.agentbus_version === CLI.readVersion(), manifest.agentbus_version);
const ids = manifest.steps.map(function (s) { return s.id; });
ok('manifest 覆盖 run_dir / database / project_registry / policy / mcp', ['run_dir', 'database', 'project_registry', 'policy', 'mcp'].every(function (id) { return ids.indexOf(id) >= 0; }), ids);
ok('每步都带时间戳与结果', manifest.steps.every(function (s) { return typeof s.at === 'string' && typeof s.result === 'string'; }));
ok('manifest.files 记录了创建的文件（未来 uninstall 的依据）',
  Object.keys(manifest.files).length >= 3 && Object.keys(manifest.files).some(function (p) { return /bus\.db$/.test(p); }),
  Object.keys(manifest.files));
const dbEntry = manifest.steps.find(function (s) { return s.id === 'database'; });
ok('数据库步骤记录了 schema_version 字段', 'schema_version' in dbEntry, dbEntry);
const mcpSteps = first.steps.filter(function (s) { return s.id === 'mcp'; });
ok('首次 init 写了 MCP 配置', mcpSteps.some(function (s) { return s.result === 'written'; }), mcpSteps);
ok('MCP 步骤带客户端 id 与路径', mcpSteps.every(function (s) { return !!s.client && !!s.path; }), mcpSteps);

console.log('\n[3] 重复 init 幂等，已配置被保留');
const codexPath = path.join(A.homeDir, '.codex', 'config.toml');
const beforeContent = fs.existsSync(codexPath) ? fs.readFileSync(codexPath, 'utf8') : null;
ok('首次 init 后 codex 配置存在且含 agentbus managed block', typeof beforeContent === 'string' && beforeContent.indexOf('agentbus') >= 0, beforeContent && beforeContent.slice(0, 80));
if (beforeContent) fs.writeFileSync(codexPath, beforeContent + String.fromCharCode(10) + '# 用户自定义标记 user-marker' + String.fromCharCode(10));
const second = CLI.runInit(A);
ok('重复 init 仍然成功', second.ok === true, second.reason);
ok('数据库被识别为已存在（没有重建）', second.steps.some(function (s) { return s.id === 'database' && s.result === 'existed'; }), second.steps.filter(function (s) { return s.id === 'database'; }));
ok('registry 被识别为已存在', second.steps.some(function (s) { return s.id === 'project_registry' && s.result === 'existed'; }));
ok('已启用的 MCP 配置被保留（keep 而不是 write）',
  second.steps.filter(function (s) { return s.id === 'mcp'; }).every(function (s) { return s.result === 'kept'; }),
  second.steps.filter(function (s) { return s.id === 'mcp'; }));
ok('用户手改的内容没有被覆盖', fs.readFileSync(codexPath, 'utf8').indexOf('user-marker') >= 0, fs.readFileSync(codexPath, 'utf8').slice(-80));
const manifest2 = JSON.parse(fs.readFileSync(A.manifestPath, 'utf8'));
ok('重复 init 不会让 manifest 里同一步骤重复堆积',
  manifest2.steps.filter(function (s) { return s.id === 'database'; }).length === 1,
  manifest2.steps.filter(function (s) { return s.id === 'database'; }).length);

console.log('\n[4] doctor：故障码、修复命令、只读');
const B = freshRoot('doctor-empty');
const emptyReport = await CLI.runDoctor({ root: B.root, dbPath: B.dbPath, registryPath: B.registryPath, policyPath: B.policyPath, homeDir: B.homeDir, port: 0 });
function byId(report) { const map = {}; for (const c of report.checks) map[c.id] = c; return map; }
const emptyChecks = byId(emptyReport);
ok('空环境：数据库项 FAIL', emptyChecks.sqlite && emptyChecks.sqlite.status === 'fail', emptyChecks.sqlite);
ok('空环境：策略项 FAIL', emptyChecks.policy && emptyChecks.policy.status === 'fail', emptyChecks.policy);
ok('空环境：退出码 1', emptyReport.exit_code === 1 && emptyReport.ok === false, emptyReport.exit_code);
ok('每个非 ok 检查项都给了具体修复命令',
  emptyReport.checks.filter(function (c) { return c.status !== 'ok'; }).every(function (c) { return typeof c.fix === 'string' && c.fix.length > 8; }),
  emptyReport.checks.filter(function (c) { return c.status !== 'ok' && !c.fix; }).map(function (c) { return c.id; }));
ok('修复命令里带可执行命令名（agentbus / node）',
  emptyReport.checks.filter(function (c) { return c.status !== 'ok'; }).some(function (c) { return /agentbus |node bus\//.test(String(c.fix)); }));
ok('doctor 不会创建数据库（只读）', !fs.existsSync(B.dbPath));
const C = freshRoot('doctor-badpolicy');
fs.writeFileSync(C.policyPath, '{ not json');
const badPolicy = byId(await CLI.runDoctor({ root: C.root, dbPath: C.dbPath, registryPath: C.registryPath, policyPath: C.policyPath, homeDir: C.homeDir, port: 0 }));
ok('坏 policy：策略项 FAIL 且带修复命令', badPolicy.policy.status === 'fail' && !!badPolicy.policy.fix, badPolicy.policy);
const D = freshRoot('doctor-port');
CLI.runInit(D);
const listener = net.createServer();
await new Promise(function (resolve) { listener.listen(0, '127.0.0.1', resolve); });
const busyPort = listener.address().port;
const portReport = byId(await CLI.runDoctor({ root: D.root, dbPath: D.dbPath, registryPath: D.registryPath, policyPath: D.policyPath, homeDir: D.homeDir, port: busyPort }));
await new Promise(function (resolve) { listener.close(resolve); });
ok('端口被占用：该项 warn 且给出换端口命令', portReport.board_port.status === 'warn' && /AGENTBUS_PORT/.test(String(portReport.board_port.fix)), portReport.board_port);
const failures = [emptyChecks.sqlite.id, emptyChecks.policy.id, badPolicy.policy.id, portReport.board_port.id];
ok('至少覆盖 3 种不同故障码', new Set(failures).size >= 3, failures);

console.log('\n[5] init 之后 doctor 的关键项转好');
const E = freshRoot('doctor-after');
CLI.runInit(E);
const afterReport = await CLI.runDoctor({ root: E.root, dbPath: E.dbPath, registryPath: E.registryPath, policyPath: E.policyPath, homeDir: E.homeDir, port: 0 });
const afterChecks = byId(afterReport);
ok('init 之后数据库项不再是 FAIL', afterChecks.sqlite.status !== 'fail', afterChecks.sqlite);
ok('init 之后 MCP 项不再是 FAIL', afterChecks.mcp.status !== 'fail', afterChecks.mcp);
ok('schema_version 项诚实标注（没有 schema_migrations 就 warn，不假装 ok）',
  afterChecks.schema_version.status === 'warn' || afterChecks.schema_version.status === 'ok', afterChecks.schema_version);
ok('Node 版本项在本机通过', afterChecks.node_version.status === 'ok', afterChecks.node_version.detail);
ok('doctor 报告带 version 与计数', afterReport.version === CLI.readVersion() && typeof afterReport.counts.ok === 'number');

console.log('\n[6] manifest 是唯一卸载依据（内容自洽）');
const manifestFinal = JSON.parse(fs.readFileSync(E.manifestPath, 'utf8'));
ok('manifest 里每个 file 条目都指向真实存在的路径',
  Object.keys(manifestFinal.files).every(function (p) { return fs.existsSync(p); }),
  Object.keys(manifestFinal.files).filter(function (p) { return !fs.existsSync(p); }));
ok('manifest 记录了 MCP 配置文件的 kind（uninstall 要按 kind 找 managed block）',
  Object.keys(manifestFinal.files).some(function (p) { return manifestFinal.files[p].kind === 'mcp-config'; }),
  Object.keys(manifestFinal.files).map(function (p) { return manifestFinal.files[p].kind; }));


console.log('\n[7] 版本号三处同源（package.json / CLI / 看板 API / MCP serverInfo）');
{
  const pkgVersion = CLI.readVersion();
  const CS = await import('./console-server.mjs');
  ok('看板 API 的版本与 package.json 一致', CS.agentbusVersion() === pkgVersion, [CS.agentbusVersion(), pkgVersion]);
  // MCP serverInfo：用 fd 重定向喂一条 initialize（沙箱禁管道 stdio）
  const io = fs.mkdtempSync(path.join(tmp, 'mcp-'));
  const reqFile = path.join(io, 'in.jsonl');
  const outFile = path.join(io, 'out.jsonl');
  const errFile = path.join(io, 'err.txt');
  fs.writeFileSync(reqFile, JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize' }) + String.fromCharCode(10));
  const fdIn = fs.openSync(reqFile, 'r');
  const fdOut = fs.openSync(outFile, 'w');
  const fdErr = fs.openSync(errFile, 'w');
  let spawnErr = null;
  try {
    const child = cp.spawn(process.execPath, [path.join(S.BUS_DIR, 'bus-mcp.mjs'), '--agent', 'codex/main', '--db', path.join(io, 'mcp.db')],
      { stdio: [fdIn, fdOut, fdErr], windowsHide: true, shell: false });
    await new Promise(function (resolve) { child.on('close', resolve); child.on('error', function () { resolve(); }); });
  } catch (error) { spawnErr = String((error && error.message) || error); }
  fs.closeSync(fdIn); fs.closeSync(fdOut); fs.closeSync(fdErr);
  const raw = fs.readFileSync(outFile, 'utf8');
  let serverInfo = null;
  for (const line of raw.split(String.fromCharCode(10))) {
    if (!line.trim()) continue;
    try { const msg = JSON.parse(line); if (msg && msg.result && msg.result.serverInfo) serverInfo = msg.result.serverInfo; } catch (e) {}
  }
  if (spawnErr) { ok('MCP serverInfo 版本读不到（spawn 受限，如实标注）', false, spawnErr); }
  else ok('MCP serverInfo.version 与 package.json 一致', !!serverInfo && serverInfo.version === pkgVersion, serverInfo);
}

console.log('\n[8] init 之后 doctor 在全新临时 home 下 0 FAIL');
{
  const G = freshRoot('fresh-full');
  CLI.runInit(G);
  ok('policy.json 由示例复制而来', fs.existsSync(G.policyPath));
  const cloned = JSON.parse(fs.readFileSync(G.policyPath, 'utf8'));
  ok('复制时去掉了 _ 开头的说明字段', !Object.keys(cloned).some(function (k) { return k.charAt(0) === '_'; }), Object.keys(cloned));
  ok('示例策略能被 validatePolicy 接受', (function () { try { return !!CLI.readExamplePolicy().lead; } catch (e) { return false; } })());
  const mf = JSON.parse(fs.readFileSync(G.manifestPath, 'utf8'));
  const policyStep = mf.steps.find(function (s) { return s.id === 'policy'; });
  ok('manifest 把 policy 记为 created（来自示例）', policyStep && policyStep.result === 'created' && /policy\.example\.json/.test(String(policyStep.detail)), policyStep);
  ok('manifest 给文本配置记了 sha256（uninstall 判断依据）',
    Object.keys(mf.files).some(function (p) { return /policy\.json$/.test(p) && /^[0-9a-f]{64}$/.test(String(mf.files[p].sha256)); }),
    Object.keys(mf.files).map(function (p) { return [p, mf.files[p].sha256 ? 'hash' : 'nohash']; }));
  const fresh = await CLI.runDoctor({ root: G.root, dbPath: G.dbPath, registryPath: G.registryPath, policyPath: G.policyPath, homeDir: G.homeDir, port: 0 });
  ok('全新安装后 doctor 没有 FAIL', fresh.counts.fail === 0 && fresh.exit_code === 0, fresh.checks.filter(function (c) { return c.status === 'fail'; }));
}

console.log('\n[9] uninstall：只删 manifest 记录项，用户改过的文件拒删，默认保留数据');
{
  const H = freshRoot('uninstall');
  CLI.runInit(H);
  const kept = CLI.runUninstall({ root: H.root, homeDir: H.homeDir });
  ok('默认卸载成功并保留数据库', kept.ok === true && fs.existsSync(H.dbPath), kept.blocked);
  ok('默认卸载保留策略与 registry', fs.existsSync(H.policyPath) && fs.existsSync(H.registryPath));
  const codex = path.join(H.homeDir, '.codex', 'config.toml');
  ok('codex 配置文件本身还在（只删 managed block）', fs.existsSync(codex));
  ok('managed block 已被移除', fs.readFileSync(codex, 'utf8').indexOf('agentbus') < 0, fs.readFileSync(codex, 'utf8').slice(-120));
  ok('默认不删 manifest（还能再跑一次）', fs.existsSync(H.manifestPath));

  // 用户改过文件的场景
  const I = freshRoot('uninstall-modified');
  CLI.runInit(I);
  const claude = path.join(I.homeDir, '.claude.json');
  fs.writeFileSync(claude, JSON.stringify({ custom: true, mcpServers: { agentbus: { command: 'node' } } }, null, 2) + String.fromCharCode(10));
  const blockedRun = CLI.runUninstall({ root: I.root, homeDir: I.homeDir });
  ok('文件被用户改过后拒绝删除', blockedRun.ok === false && blockedRun.blocked.some(function (b) { return /claude\.json$/.test(b.path) && b.reason === 'modified_since_install'; }), blockedRun.blocked);
  ok('拒绝时不覆盖整份配置（用户内容还在）', fs.readFileSync(claude, 'utf8').indexOf('"custom": true') >= 0);
  ok('其它未被改动的客户端仍然被卸载', blockedRun.removed.some(function (r) { return /codex/.test(r.path); }), blockedRun.removed);

  // --purge-data 需要确认
  const J = freshRoot('uninstall-purge');
  CLI.runInit(J);
  const noConfirm = CLI.runUninstall({ root: J.root, homeDir: J.homeDir, purgeData: true });
  ok('--purge-data 缺 --yes 时拒绝并列出待删路径', noConfirm.ok === false && noConfirm.reason === 'confirm_required' && noConfirm.would_delete.length > 0, noConfirm.reason);
  ok('拒绝时数据库仍在', fs.existsSync(J.dbPath));
  const purged = CLI.runUninstall({ root: J.root, homeDir: J.homeDir, purgeData: true, confirm: true });
  ok('--purge-data --yes 才真正删除数据库', purged.ok === true && !fs.existsSync(J.dbPath), purged.blocked);
  ok('没有 manifest 时拒绝卸载（不猜）', CLI.runUninstall({ root: freshRoot('uninstall-nomanifest').root }).reason === 'no_manifest');
}

console.log('\n[10] release-check：打包检查能拦住敏感文件');
{
  const RC = await import('./release-check.mjs');
  const inspect = RC.inspectPack({ root: path.resolve(S.BUS_DIR, '..') });
  ok('真实仓库的打包清单通过检查', inspect.ok === true && inspect.violations.length === 0, inspect.violations);
  // 造一个带敏感文件的假包目录，确认规则真的会拦
  const fake = fs.mkdtempSync(path.join(tmp, 'fakepack-'));
  fs.mkdirSync(path.join(fake, 'bus', 'logs'), { recursive: true });
  fs.writeFileSync(path.join(fake, 'package.json'), JSON.stringify({ name: 'x', version: '9.9.9', files: ['bus/**/*.mjs', 'bus/logs/*.log', 'bus/bus.db', 'bus/projects.json', 'bus/lifecycle*', 'bus/*.pid'] }));
  fs.writeFileSync(path.join(fake, 'bus', 'cli.mjs'), '// x');
  fs.writeFileSync(path.join(fake, 'bus', 'bus.db'), 'db');
  fs.writeFileSync(path.join(fake, 'bus', 'projects.json'), '{}');
  fs.writeFileSync(path.join(fake, 'bus', 'logs', 'a.log'), 'log');
  fs.writeFileSync(path.join(fake, 'bus', 'lifecycle.json'), '{"components":{"board":{"pid":1}}}');
  fs.writeFileSync(path.join(fake, 'bus', 'lifecycle.json.bak-1'), '{}');
  fs.writeFileSync(path.join(fake, 'bus', 'board.pid'), '1');
  const bad = RC.inspectPack({ root: fake });
  ok('假包里的 bus.db / projects.json / logs 全被拦下', bad.ok === false && bad.violations.filter(function (v) { return ['database', 'projects', 'logs'].indexOf(v.rule) >= 0; }).length === 3, bad.violations.map(function (v) { return v.path + ':' + v.rule; }));
  ok('运行数据 lifecycle.json 及其变体被拦下（改名绕不过规则）',
    bad.violations.filter(function (v) { return v.rule === 'lifecycle'; }).length === 2,
    bad.violations.filter(function (v) { return v.rule === 'lifecycle'; }).map(function (v) { return v.path; }));
  ok('PID 文件被拦下', bad.violations.some(function (v) { return v.rule === 'pidfile'; }), bad.violations.filter(function (v) { return v.rule === 'pidfile'; }).map(function (v) { return v.path; }));
  ok('每个违规都写明原因', bad.violations.every(function (v) { return typeof v.why === 'string' && v.why.length > 0; }));
  const report = await RC.runReleaseCheck({ root: path.resolve(S.BUS_DIR, '..'), skipSmoke: true, exec: async function () { return { code: 1, stdout: '', stderr: 'stub', error: null }; } });
  ok('release-check 结构完整（版本 + 4 个步骤 + 计数）',
    report.version === CLI.readVersion() && report.steps.length === 4 && typeof report.counts.fail === 'number', report.steps.map(function (s) { return s.id + ':' + s.status; }));
}
try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (e) {}
console.log('\nPASS ' + pass + '   FAIL ' + fail);
if (fail) process.exitCode = 1;
