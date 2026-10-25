#!/usr/bin/env node
// 第 3 项第 9/11 条 + 第 6 项第 10/11 条：隔离 provider 抽象。
//
// 诚实标注：本机没有可安全实测的 CLI、也没有容器运行时。
// 这个套件断言的是「结构正确 + fail-closed + 不自述能力」，**不是**「隔离有效」。
// 因此所有真实 provider 的 verified 都必须是 false；任何断言都不允许声称隔离已验证。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import os from 'node:os';
import * as Iso from './isolation/provider.mjs';
import * as EngineReport from './isolation/engine-report.mjs';
import * as S from './store.mjs';
import * as Codex from './engines/codex.mjs';
import * as Claude from './engines/claude.mjs';
import * as Dsh from './engines/dsh.mjs';

const BUS_DIR = path.dirname(fileURLToPath(import.meta.url));
let pass = 0;
let fail = 0;
function ok(name, value, detail) {
  if (value) { pass += 1; console.log('  PASS  ' + name); }
  else { fail += 1; console.log('  FAIL  ' + name + (detail === undefined ? '' : ' — ' + JSON.stringify(detail).slice(0, 400))); }
}
function derived(caps) { return Iso.capabilitiesFromProbe(caps.probe); }
const NO_RUNTIME = { which: function () { return null; } };
const WITH_RUNTIME = { which: function (name) { return name === 'docker' ? '/usr/bin/docker' : null; } };
const GOOD_CANARY = function () { return { engine_version: 'test', write_inside: true, write_outside: false, network_direct: false, network_via_proxy: true, tested_at: '2026-01-01T00:00:00.000Z' }; };

console.log('[1] host-native：如实声明没有 OS 级隔离');
const host = Iso.providerNamed(Iso.HOST_NATIVE);
const hostProbe = host.probe();
ok('probe 的四个实测字段都是 null（没测就不能填 true/false）',
  hostProbe.write_inside === null && hostProbe.write_outside === null && hostProbe.network_direct === null && hostProbe.network_via_proxy === null, hostProbe);
ok('probe.verified=false 且给出原因', hostProbe.verified === false && hostProbe.reason === 'no_os_sandbox', hostProbe.reason);
ok('probe 带版本与 provider 名', hostProbe.provider === 'host-native' && hostProbe.probe_version === Iso.PROBE_VERSION);
const hostCaps = host.capabilities();
ok('capabilities 与 probe 推导一致', hostCaps.strongWriteIsolation === derived(hostCaps).strongWriteIsolation && hostCaps.networkIsolation === derived(hostCaps).networkIsolation);
ok('host-native 两项隔离能力都是 false', hostCaps.strongWriteIsolation === false && hostCaps.networkIsolation === false && hostCaps.verified === false, hostCaps);
ok('说明里写明无 OS 级写隔离与无法强制网络', (hostCaps.notes || []).join(' ').indexOf('OS 级写隔离') >= 0 && (hostCaps.notes || []).join(' ').indexOf('无法阻止子进程绕过代理') >= 0, hostCaps.notes);

console.log('');
console.log('[2] host-native：带网络授权的任务一律 fail-closed');
const netTask = { id: 't-1', network_grants: [{ protocol: 'https', host: 'example.com', ports: [443] }] };
const netWrap = host.wrap(netTask, { roots: ['/tmp/root'], redline: [] });
ok('有 network_grants → 拒绝执行并停在 needs_human', netWrap.ok === false && netWrap.reason === 'network_isolation_unavailable' && netWrap.needs_human === true, netWrap);
const redlineWrap = host.wrap({ id: 't-2', grants: ['net:egress'] }, { roots: ['/tmp/root'], redline: ['net:egress'] });
ok('只带 net:egress 红线 → 同样 fail-closed', redlineWrap.ok === false && redlineWrap.reason === 'network_isolation_unavailable', redlineWrap);
const plainWrap = host.wrap({ id: 't-3' }, { roots: ['/tmp/root'], redline: [] });
ok('无网络授权可以执行，但必须带 verified=false 与警告', plainWrap.ok === true && plainWrap.verified === false && /无 OS 级写隔离/.test(plainWrap.exec.warning), plainWrap);

console.log('');
console.log('[3] container：没有运行时必须 fail-closed，原因明确');
const noRt = Iso.providerNamed(Iso.CONTAINER, NO_RUNTIME);
const noRtProbe = noRt.probe();
ok('无运行时 → verified=false 且 reason=no_container_runtime', noRtProbe.verified === false && noRtProbe.reason === 'no_container_runtime', noRtProbe.reason);
ok('probe 列出搜过的运行时（docker/podman）与一次都没找到', (noRtProbe.detail.searched || []).map(function (x) { return x.name; }).join(',') === 'docker,podman' && noRtProbe.detail.searched.every(function (x) { return x.path === null; }), noRtProbe.detail);
const noRtWrap = noRt.wrap({ id: 't-4' }, { roots: ['/tmp/root'], redline: [] });
ok('wrap fail-closed 并提示装 Docker/Podman 或改离线', noRtWrap.ok === false && noRtWrap.reason === 'no_container_runtime' && noRtWrap.needs_human === true && /Docker 或 Podman/.test(noRtWrap.message), noRtWrap);
const realHost = Iso.providerNamed(Iso.CONTAINER).probe();
console.log('  （本机实际检测：' + (realHost.reason === 'no_container_runtime' ? '没找到 docker/podman' : realHost.reason) + '，verified=' + realHost.verified + '）');
ok('本机真实探测也没给出 verified=true', realHost.verified === false, realHost.reason);

console.log('');
console.log('[4] container：有运行时但没跑 canary 仍然不算验证过');
const rtOnly = Iso.providerNamed(Iso.CONTAINER, WITH_RUNTIME);
const rtProbe = rtOnly.probe();
ok('检测到 docker 但没有 canary → reason=canary_not_executed', rtProbe.verified === false && rtProbe.reason === 'canary_not_executed', rtProbe.reason);
ok('运行时路径被记录进 probe.detail', rtProbe.detail.runtime === 'docker' && rtProbe.detail.runtime_path === '/usr/bin/docker', rtProbe.detail);
ok('这种状态下 wrap 也 fail-closed（isolation_unverified）', (function () { const w = rtOnly.wrap({ id: 't-5' }, { roots: ['/tmp/root'], redline: [] }); return w.ok === false && w.reason === 'isolation_unverified' && w.needs_human === true; })(), rtOnly.wrap({ id: 't-5' }, { roots: ['/tmp/root'], redline: [] }));

console.log('');
console.log('[5] container：参数完整性（用假 canary 证明接口，不代表真隔离）');
const fake = Iso.providerNamed(Iso.CONTAINER, { which: WITH_RUNTIME.which, canary: GOOD_CANARY });
const fakeProbe = fake.probe();
ok('假 canary 四项达标 → verified=true（仅说明推导链路通，不是真隔离）', fakeProbe.verified === true && fakeProbe.write_inside === true && fakeProbe.write_outside === false && fakeProbe.network_direct === false && fakeProbe.network_via_proxy === true, fakeProbe);
const fakeCaps = fake.capabilities();
ok('此时两项能力由 probe 推导为 true', fakeCaps.strongWriteIsolation === true && fakeCaps.networkIsolation === true, fakeCaps);
const fakeWrap = fake.wrap({ id: 't-6' }, { roots: ['/tmp/root-a', '/tmp/root-b'], redline: [] }, { which: WITH_RUNTIME.which, canary: GOOD_CANARY, proxyUrl: 'http://127.0.0.1:8899' });
ok('容器命令禁用特权/只读根/非 root/去能力/禁提权', fakeWrap.ok === true && fakeWrap.exec.privileged === false && fakeWrap.exec.readOnlyRoot === true
  && fakeWrap.exec.argv.indexOf('--privileged') < 0 && fakeWrap.exec.argv.indexOf('--read-only') >= 0
  && fakeWrap.exec.argv.indexOf('--cap-drop') >= 0 && fakeWrap.exec.argv[fakeWrap.exec.argv.indexOf('--cap-drop') + 1] === 'ALL'
  && fakeWrap.exec.argv.indexOf('--security-opt') >= 0 && fakeWrap.exec.argv.indexOf('no-new-privileges') >= 0
  && fakeWrap.exec.argv.indexOf('--user') >= 0, fakeWrap.exec && fakeWrap.exec.argv);
ok('只挂载授权根（两个根各一个 mount，目标是容器内路径）', fakeWrap.exec.mounts.length === 2 && fakeWrap.exec.mounts.every(function (m) { return m.source.indexOf('/tmp/root-') === 0 && m.target.indexOf('/') === 0; }), fakeWrap.exec.mounts);
ok('无网络授权时 --network none', fakeWrap.exec.network === 'none' && fakeWrap.exec.argv[fakeWrap.exec.argv.indexOf('--network') + 1] === 'none', fakeWrap.exec.network);
const netFake = fake.wrap({ id: 't-7', network_grants: [{ protocol: 'https', host: 'example.com', ports: [443] }] }, { roots: ['/tmp/root'], redline: [] }, { which: WITH_RUNTIME.which, canary: GOOD_CANARY, proxyUrl: 'http://127.0.0.1:8899' });
ok('有网络授权时只接 task 网络并把代理注入环境', netFake.ok === true && netFake.exec.network !== 'none' && netFake.exec.env.HTTPS_PROXY === 'http://127.0.0.1:8899', netFake.exec);
const belowFake = Iso.providerNamed(Iso.CONTAINER, { which: WITH_RUNTIME.which, canary: function () { return { write_inside: true, write_outside: true, network_direct: false, network_via_proxy: true }; } });
ok('越界写入没被挡住（write_outside=true）→ verified=false', belowFake.probe().verified === false && belowFake.probe().reason === 'canary_results_below_expectation', belowFake.probe().reason);

console.log('');
console.log('[6] 三个 adapter 不再自述强隔离');
const engines = [['codex', Codex], ['claude', Claude], ['dsh', Dsh]];
for (const [name, engine] of engines) {
  const caps = engine.capabilities();
  ok(name + '.capabilities() 的强隔离/网络隔离都是 false', caps.strongWriteIsolation === false && caps.networkIsolation === false, caps);
  ok(name + '.capabilities() 标明 verified=false 与 provider', caps.verified === false && caps.provider === 'host-native', { verified: caps.verified, provider: caps.provider });
  ok(name + '.capabilities() 与 probe 推导逐字段一致', caps.strongWriteIsolation === derived(caps).strongWriteIsolation && caps.networkIsolation === derived(caps).networkIsolation && caps.verified === derived(caps).verified);
  ok(name + '.capabilities() 带上 probe 证据（可追溯）', !!caps.probe && caps.probe.provider === 'host-native' && caps.probe.probe_version === Iso.PROBE_VERSION);
  const src = fs.readFileSync(path.join(BUS_DIR, 'engines', name + '.mjs'), 'utf8');
  ok(name + '.mjs 源码里没有 strongWriteIsolation: true（防止自述回潮）', !/strongWriteIsolation\s*:\s*true/.test(src));
}
ok('adapter 传入 verified 的 probe 时能力随之变 true（证明是推导不是写死）', (function () {
  const verifiedProbe = { provider: 'container', probe_version: Iso.PROBE_VERSION, verified: true, write_inside: true, write_outside: false, network_direct: false, network_via_proxy: true, reason: 'verified', notes: [] };
  const caps = Codex.capabilities({ provider: 'container', probe: verifiedProbe });
  return caps.strongWriteIsolation === true && caps.networkIsolation === true && caps.provider === 'container';
})());
ok('adapter 可以选择 container provider 并如实报告没有运行时', (function () {
  const caps = Codex.capabilities({ provider: 'container', which: NO_RUNTIME.which });
  return caps.provider === 'container' && caps.verified === false && caps.reason === 'no_container_runtime' && caps.strongWriteIsolation === false;
})());

console.log('');
console.log('[7] 交付标注：本机不可能 verified=true');
ok('VERIFIED_REQUIREMENTS 写清需要什么环境', Iso.VERIFIED_REQUIREMENTS.length >= 3 && Iso.VERIFIED_REQUIREMENTS.join(' ').indexOf('docker') >= 0 && Iso.VERIFIED_REQUIREMENTS.join(' ').indexOf('canary') >= 0, Iso.VERIFIED_REQUIREMENTS);
ok('host-native 永远无法 verified（no_os_sandbox）', Iso.providerNamed(Iso.HOST_NATIVE).probe().reason === 'no_os_sandbox');
ok('本机两个 provider 的 verified 都是 false（这就是诚实结论）', host.capabilities().verified === false && Iso.providerNamed(Iso.CONTAINER).capabilities().verified === false);

console.log('');
console.log('[8] issueExecutionGrant 只接受有效 probe（三种拒绝分开报）');
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentbus-iso-grant-'));
  const db = S.openDb(path.join(dir, 'bus.db'));
  try {
    S.setRuntimeState(db, 'human', true);
    // workspaceFor 会解析项目目录，必须先真的存在（workspaces/ 已被 .gitignore 忽略）
    const projDir = path.join(S.ROOT, 'workspaces', 'proj-iso');
    fs.mkdirSync(projDir, { recursive: true });
    const task = S.createTask(db, { title: '隔离签发', status: 'open', project: 'proj-iso', extra_dirs: [dir], redline: ['cfg:edit'] });
    db.prepare("UPDATE tasks SET status='claimed', owner='worker/main', lease_until=? WHERE id=?").run(new Date(Date.now() + 3600000).toISOString(), task.id);
    const owner = 'worker/main';
    const missing = S.issueExecutionGrant(db, task.id, owner);
    ok('没有 probe → probe_missing', missing.ok === false && missing.reason === 'probe_missing' && !!missing.next_step, missing);
    const unverified = S.issueExecutionGrant(db, task.id, owner, { probe: hostProbe });
    ok('probe 未 verified → probe_not_verified', unverified.ok === false && unverified.reason === 'probe_not_verified', unverified);
    const staleProbe = { provider: 'container', probe_version: Iso.PROBE_VERSION, verified: true, write_inside: true, write_outside: false, network_direct: false, network_via_proxy: true, tested_at: '2020-01-01T00:00:00.000Z', reason: 'verified' };
    const stale = S.issueExecutionGrant(db, task.id, owner, { probe: staleProbe });
    ok('probe 过期 → probe_stale', stale.ok === false && stale.reason === 'probe_stale', stale);
    const granted = S.issueExecutionGrant(db, task.id, owner, { probe: Object.assign({}, staleProbe, { tested_at: new Date().toISOString() }) });
    ok('有效 probe → 正常签发强隔离 grant', granted.ok === true && !!granted.grant, granted.reason || 'ok');
  } finally { db.close(); fs.rmSync(dir, { recursive: true, force: true }); try { fs.rmSync(path.join(S.ROOT, 'workspaces', 'proj-iso'), { recursive: true, force: true }); } catch (e) { /* ignore */ } }
}

console.log('');
console.log('[9] doctor --probe-engine 与看板"缺少可执行后端"接线');
const report = EngineReport.reportEngines({});
ok('三引擎报告全为 verified=false（本机诚实结论）', report.verified === false && report.engines.length === 3 && report.engines.every(function (e) { return e.verified === false; }), report.engines.map(function (e) { return e.reason; }));
ok('每个引擎都带"下一步该做什么"', report.engines.every(function (e) { return typeof e.next_step === 'string' && e.next_step.length > 10; }));
ok('报告带 VERIFIED_REQUIREMENTS 与运行时探测结果', report.requirements.length >= 3 && report.runtime && Array.isArray(report.runtime.searched));
const cliSrc = fs.readFileSync(path.join(BUS_DIR, 'cli.mjs'), 'utf8');
ok('cli 暴露 doctor --probe-engine', cliSrc.indexOf('--probe-engine') >= 0 && cliSrc.indexOf('doctorProbeEngine') >= 0);
const appSrc = fs.readFileSync(path.join(BUS_DIR, 'ui', 'app.js'), 'utf8');
ok('看板任务详情渲染隔离提示（原因 + 下一步）', appSrc.indexOf('renderIsolationNotice') >= 0 && appSrc.indexOf('下一步：') >= 0 && appSrc.indexOf('doctor --probe-engine') >= 0);
const boardSrc = fs.readFileSync(path.join(BUS_DIR, 'board-ui.mjs'), 'utf8');
ok('任务弹窗里留了 #task-isolation 挂载点', boardSrc.indexOf('id="task-isolation"') >= 0);
const noticeBody = appSrc.slice(appSrc.indexOf('function renderIsolationNotice'), appSrc.indexOf('function openTask'));
ok('隔离提示本身不写"需要人工"这种没信息量的话', noticeBody.length > 100 && noticeBody.indexOf('需要人工') < 0, noticeBody.slice(0, 120));

console.log('');
console.log('verified=false：本机没有可安全实测的 CLI / 容器运行时，隔离**未验证**。');
console.log('要变成 verified=true：' + Iso.VERIFIED_REQUIREMENTS.join('；'));
console.log('');
console.log('==================================');
console.log('PASS ' + pass + '   FAIL ' + fail);
process.exitCode = fail ? 1 : 0;
