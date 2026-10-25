#!/usr/bin/env node
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as S from './store.mjs';
import * as A from './admin-config.mjs';
import { createBoardServer } from './console-server.mjs';
import * as Auth from './auth.mjs';
import vm from 'node:vm';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentbus-admin-'));
const db = S.openDb(path.join(dir, 'bus.db'));
S.setRuntimeState(db, 'human', true);
const base = S.loadPolicy();
let pass = 0;
let fail = 0;

function ok(name, value, detail) {
  if (value) { pass += 1; console.log('  PASS  ' + name); }
  else { fail += 1; console.log('  FAIL  ' + name + (detail ? ' — ' + JSON.stringify(detail) : '')); }
}

function throws(name, fn) {
  try { fn(); ok(name, false, '没有抛错'); }
  catch (e) { ok(name, true); }
}

console.log('[1] 人类创建、编辑、改派、取消');
const made = S.createHumanTask(db, base, 'human', {
  title: '管理端任务', body: '验收标准', project: 'demo', target: 'claude/main', status: 'open',
  cost_class: 'standard', write_scope: ['src/ui/**'], max_subagents: 1,
});
ok('创建定向任务', made.ok && made.task.target === 'claude/main');
const edited = S.editTask(db, base, 'human', made.task.id, { title: '管理端任务 v2', body: '新标准' }, made.task.version);
ok('乐观锁编辑', edited.ok && edited.task.title === '管理端任务 v2');
const claimed = S.claim(db, 'claude/main', made.task.id, 15);
ok('目标 Agent 可认领', claimed.ok);
const blocked = S.editTask(db, base, 'human', made.task.id, { project: 'other' }, claimed.task.version);
ok('开始后锁定结构字段', !blocked.ok && blocked.reason === 'task_started');
const moved = S.reassignTask(db, base, 'human', made.task.id, 'dsh/main', claimed.task.version);
ok('改派会清空 owner 并回到 open', moved.ok && moved.task.owner === null && moved.task.target === 'dsh/main' && moved.task.status === 'open');
const cancelled = S.cancelTask(db, base, 'human', made.task.id, '停止', moved.task.version);
ok('人类可取消活跃任务', cancelled.ok && cancelled.task.status === 'cancelled');

S.recordUsage(db, 'claude/main', made.task.id, 'implementation', 1200, 340);
S.recordUsage(db, 'codex/main', made.task.id, 'review', 220, 80);
const taskCost = S.costSummary(db, base.lead).by_task.find(function (x) { return x.task_id === made.task.id; });
ok('任务成本区分输入与输出', taskCost && taskCost.in === 1420 && taskCost.out === 420 && taskCost.total === 1840);
ok('任务成本包含 Agent 明细', taskCost && taskCost.agents.length === 2 && taskCost.agents[0].agent === 'claude/main');

console.log('\n[2] 策略校验与 Lead 权限同步');
const candidate = JSON.parse(JSON.stringify(base));
candidate.lead = 'claude/main';
const validated = A.validatePolicy(candidate, { syncLeadPermissions: true });
ok('切换 Lead 同步 dispatch', validated.permissions.dispatch.length === 1 && validated.permissions.dispatch[0] === 'claude/main');
ok('human 保留审批权', validated.permissions.accept.indexOf('human') >= 0);
const bad = JSON.parse(JSON.stringify(base));
bad.agents['claude/main'].may_dispatch_to = ['missing/main'];
throws('拒绝不存在的派发目标', function () { A.validatePolicy(bad, {}); });
const policyPath = path.join(dir, 'policy.json');
A.savePolicy(base, { path: policyPath });
const saved2 = A.savePolicy(candidate, { path: policyPath, syncLeadPermissions: true });
ok('覆盖策略前创建备份', saved2.backup && fs.existsSync(saved2.backup));

console.log('\n[2b] 策略开关渲染与保存请求');
const { renderConsole } = await import('./board-ui.mjs');
// 第 14 项第 2 阶段：脚本抽到了 bus/ui/app.js。这里断言的是 UI 逻辑本身，
// 所以用 inlineAssets 渲染（内容与 app.js 逐字节一致，smoke-ui-static 负责守护这一点）。
const policyScript = renderConsole({ csrf: 'test', actor: 'human', inlineAssets: true }).split('<script>')[1].split('</script>')[0];
// 第 14 项第 3 阶段：线上代码是 bus/ui/ 下的 ES module；app.js 已冻结为回滚快照。
// 这里断言的是**活的**实现，所以拼的是 views/state/dom 模块源码。
const uiModuleFiles = ['main.mjs', 'state.mjs', 'api.mjs', 'components/dom.mjs', 'views/overview.mjs', 'views/tasks.mjs', 'views/projects.mjs', 'views/settings.mjs', 'views/reports.mjs'];
const appJsSource = uiModuleFiles.map(function (f) { return fs.readFileSync(path.join(S.BUS_DIR, 'ui', f), 'utf8'); }).join('\n');
const frozenUiSource = fs.readFileSync(path.join(S.BUS_DIR, 'ui', 'app.js'), 'utf8');
const nodes = new Map();
function policyNode(selector) { if (!nodes.has(selector)) nodes.set(selector, { value: '', checked: false, innerHTML: '' }); return nodes.get(selector); }
let savedPolicyBody;
const policyContext = vm.createContext({
  state: { policy: JSON.parse(JSON.stringify(base)) }, dirty: true,
  q: policyNode,
  qa: function (selector) { return selector === '[data-e]' ? [{ dataset: { e: 'require_verify_cmd' }, get checked() { return policyNode('[data-e="require_verify_cmd"]').checked; } }] : []; },
  esc: String, csv: v => (v || []).join(', '), split: v => String(v || '').split(',').map(x => x.trim()).filter(Boolean),
  api: async function (url, options) { savedPolicyBody = options.body; return { policy: options.body.policy }; },
  toast: function () {}, load: async function () {}, renderPolicyRegistry: function () {},
});
const uiPolicyLines = policyScript.split('\n').filter(line => /^function (renderPolicy|collectPolicy|collectNetworkPolicy|renderNetworkServices|networkServiceRows|networkServicesEmpty|networkServiceRow)\(/.test(line.trim()) || line.trim().startsWith("q('#save-policy').onclick=")).join('\n');
vm.runInContext(uiPolicyLines, policyContext);
for (const value of [false, true]) {
  policyContext.state.policy.economics.require_verify_cmd = value;
  vm.runInContext('renderPolicy()', policyContext);
  const switches = policyNode('#economics-switches').innerHTML;
  ok('验收命令开关初始值 ' + value, switches.includes('自动验收类别必须选择验证器') && (switches.includes('data-e="require_verify_cmd" checked') === value));
}
policyNode('[data-e="require_verify_cmd"]').checked = true;
await vm.runInContext("q('#save-policy').onclick()", policyContext);
ok('勾选后策略保存请求含 boolean true', savedPolicyBody.policy.economics.require_verify_cmd === true);
policyNode('[data-e="require_verify_cmd"]').checked = false;
await vm.runInContext("q('#save-policy').onclick()", policyContext);
ok('取消勾选后策略保存请求含 boolean false', savedPolicyBody.policy.economics.require_verify_cmd === false);
policyContext.state.policy.economics.lead_plans_once = true;
vm.runInContext('renderPolicy()', policyContext);
ok('表单移除 lead_plans_once 死开关', !policyNode('#economics-switches').innerHTML.includes('lead_plans_once'));
await vm.runInContext("q('#save-policy').onclick()", policyContext);
ok('策略保存不保留 lead_plans_once', !Object.prototype.hasOwnProperty.call(savedPolicyBody.policy.economics, 'lead_plans_once'));
ok('策略保存请求显式提交 network 段（不依赖服务端兜底）', !!savedPolicyBody.policy.network && savedPolicyBody.policy.network['default'] === 'deny' && Array.isArray(savedPolicyBody.policy.network.local_services));
const networkNodes = new Map();
function networkNode(selector) { if (!networkNodes.has(selector)) networkNodes.set(selector, { value: '', checked: false, hidden: false, innerHTML: '' }); return networkNodes.get(selector); }
const editedServices = [{ querySelector: s => ({ value: s.indexOf('port') >= 0 ? '7400' : '看板' }) }, { querySelector: s => ({ value: s.indexOf('port') >= 0 ? '7500' : '本地模型' }) }];
let networkSavedBody;
const networkContext = vm.createContext({
  state: { policy: JSON.parse(JSON.stringify(base)) }, dirty: true, q: networkNode,
  qa: function (selector) { return selector === '[data-network-service]' ? editedServices : []; },
  esc: String, csv: v => (v || []).join(', '), split: v => String(v || '').split(',').map(x => x.trim()).filter(Boolean),
  api: async function (url, options) { networkSavedBody = options.body; return { policy: options.body.policy }; },
  toast: function () {}, load: async function () {}, renderPolicyRegistry: function () {},
});
vm.runInContext(uiPolicyLines, networkContext);
await vm.runInContext("q('#save-policy').onclick()", networkContext);
ok('策略页把用户编辑的 local_services 原样提交', JSON.stringify(networkSavedBody.policy.network.local_services) === '[{"port":7400,"purpose":"看板"},{"port":7500,"purpose":"本地模型"}]', networkSavedBody.policy.network);
ok('策略页网络段 default 固定 deny', networkSavedBody.policy.network['default'] === 'deny');


console.log('\n[3] MCP 定向配置写入');
const fakeHome = path.join(dir, 'home');
fs.mkdirSync(path.join(fakeHome, '.codex'), { recursive: true });
fs.mkdirSync(path.join(fakeHome, '.dsh'), { recursive: true });
fs.writeFileSync(path.join(fakeHome, '.codex', 'config.toml'), 'model = "demo"\n\n[mcp_servers.other]\ncommand = "other"\n');
fs.writeFileSync(path.join(fakeHome, '.claude.json'), JSON.stringify({ theme: 'dark', mcpServers: { other: { command: 'other' } } }, null, 2));
fs.writeFileSync(path.join(fakeHome, '.dsh', 'cordis.patch.yml'), '- insert:\n    - id: unrelated\n      name: "example"\n');
A.saveMcpProfile('codex', { enabled: true, agent: 'codex/main' }, { homeDir: fakeHome });
A.saveMcpProfile('claude', { enabled: true, agent: 'claude/main' }, { homeDir: fakeHome });
A.saveMcpProfile('dsh', { enabled: true, agent: 'dsh/main' }, { homeDir: fakeHome });
const profiles = A.readMcpProfiles({ homeDir: fakeHome });
ok('Codex agentbus 条目写入', profiles.find(function (x) { return x.id === 'codex'; }).agent === 'codex/main');
ok('Claude agentbus 条目写入', profiles.find(function (x) { return x.id === 'claude'; }).agent === 'claude/main');
ok('DSH agentbus 条目写入', profiles.find(function (x) { return x.id === 'dsh'; }).agent === 'dsh/main');
const codexText = fs.readFileSync(path.join(fakeHome, '.codex', 'config.toml'), 'utf8');
const claudeJson = JSON.parse(fs.readFileSync(path.join(fakeHome, '.claude.json'), 'utf8'));
const dshText = fs.readFileSync(path.join(fakeHome, '.dsh', 'cordis.patch.yml'), 'utf8');
ok('保留 Codex 其他 MCP', codexText.indexOf('[mcp_servers.other]') >= 0);
ok('保留 Claude 其他设置和 MCP', claudeJson.theme === 'dark' && claudeJson.mcpServers.other.command === 'other');
ok('保留 DSH 其他配置', dshText.indexOf('id: unrelated') >= 0 && dshText.indexOf('id: agentbus') >= 0);

console.log('\n[4] 管理 API 与 CSRF');
const apiDb = S.openDb(path.join(dir, 'api.db'));
const projectOptions = { path: path.join(dir, 'projects.json'), workspaceRoot: path.join(dir, 'workspaces') };
fs.writeFileSync(projectOptions.path, JSON.stringify({ _note: '测试注册表', projects: {} }));
// 策略文件：复制真实 policy.json 到临时目录，看板只读写这份副本，绝不碰真实文件。
const realPolicyFile = path.join(S.BUS_DIR, 'policy.json');
const realPolicyHashBefore = crypto.createHash('sha256').update(fs.readFileSync(realPolicyFile)).digest('hex');
const serverPolicyPath = path.join(dir, 'policy.json');
fs.copyFileSync(realPolicyFile, serverPolicyPath);
const server = createBoardServer({ port: 7400, actor: 'human', csrf: 'test-token', db: apiDb, projectOptions, policyPath: serverPolicyPath });
await new Promise(function (resolve) { server.listen(0, '127.0.0.1', resolve); });
const port = server.address().port;
const apiUrl = 'http://127.0.0.1:' + port;

// 会话认证：看板用一次性 bootstrap token 换 HttpOnly 会话 cookie，写操作还要 CSRF 头与严格 Origin。
// 这里包一层 fetch，自动带上 cookie 与本机 Origin；x-test-* 标记只用于构造被拒绝的请求。
const realFetch = globalThis.fetch;
const sessionJar = new Map();
globalThis.fetch = async function (input, init) {
  const options = Object.assign({}, init || {});
  const target = new URL(typeof input === 'string' ? input : String(input && input.url || input));
  const outgoing = Object.assign({}, options.headers || {});
  let noSession = false;
  let noOrigin = false;
  let badOrigin = false;
  let localhostOrigin = false;
  let localhostOtherPort = false;
  for (const key of Object.keys(outgoing)) {
    const marker = key.toLowerCase();
    if (marker === 'x-test-no-session') { noSession = true; delete outgoing[key]; }
    if (marker === 'x-test-no-origin') { noOrigin = true; delete outgoing[key]; }
    if (marker === 'x-test-bad-origin') { badOrigin = true; delete outgoing[key]; }
    if (marker === 'x-test-localhost-origin') { localhostOrigin = true; delete outgoing[key]; }
    if (marker === 'x-test-localhost-other-port') { localhostOtherPort = true; delete outgoing[key]; }
  }
  if (!noSession && sessionJar.has(target.port)) outgoing.cookie = sessionJar.get(target.port);
  const verb = String(options.method || 'GET').toUpperCase();
  if (verb !== 'GET' && verb !== 'HEAD') {
    const declared = Object.keys(outgoing).some(function (key) { return key.toLowerCase() === 'origin'; });
    if (badOrigin) outgoing.origin = 'http://evil.example';
    else if (localhostOrigin) outgoing.origin = 'http://localhost:' + target.port;
    else if (localhostOtherPort) outgoing.origin = 'http://localhost:' + (Number(target.port) + 1);
    else if (!noOrigin && !declared) outgoing.origin = 'http://127.0.0.1:' + target.port;
  }
  options.headers = outgoing;
  const response = await realFetch(input, options);
  const issued = typeof response.headers.getSetCookie === 'function' ? response.headers.getSetCookie() : [];
  for (const raw of issued) {
    const pair = String(raw).split(';')[0];
    if (pair.indexOf('agentbus_console_session=') === 0) sessionJar.set(target.port, pair);
  }
  return response;
};
async function login(origin, token) {
  return fetch(origin + '/?token=' + encodeURIComponent(token), { redirect: 'manual' });
}

const bootstrapToken = server.agentBus.bootstrap.token;
ok('启动时生成一次性 bootstrap token', typeof bootstrapToken === 'string' && bootstrapToken.length >= 32);
const noSessionPage = await fetch(apiUrl + '/', { headers: { 'x-test-no-session': '1' }, redirect: 'manual' });
const noSessionHtml = await noSessionPage.text();
ok('无会话访问控制台页面被拒且不回显 token', noSessionPage.status === 403 && noSessionHtml.includes('session_required') && !noSessionHtml.includes(bootstrapToken));
const wrongToken = await fetch(apiUrl + '/?token=' + encodeURIComponent('wrong-token-value'), { redirect: 'manual' });
ok('错误的 bootstrap token 返回 403 与稳定错误码', wrongToken.status === 403 && (await wrongToken.text()).includes('bootstrap_token_invalid'));
const sessionLogin = await login(apiUrl, bootstrapToken);
const loginCookie = (sessionLogin.headers.getSetCookie() || []).find(function (c) { return c.indexOf('agentbus_console_session=') === 0; }) || '';
const sessionCookie = loginCookie.split(';')[0];
ok('一次性 token 换 HttpOnly + SameSite=Strict 会话 cookie 并重定向去掉 token', sessionLogin.status === 303 && sessionLogin.headers.get('location') === '/' && loginCookie.includes('HttpOnly') && loginCookie.includes('SameSite=Strict'));
const reusedToken = await fetch(apiUrl + '/?token=' + encodeURIComponent(bootstrapToken), { redirect: 'manual' });
ok('已使用的一次性 token 不能二次换取', reusedToken.status === 403 && (await reusedToken.text()).includes('bootstrap_token_used'));

const home = await fetch(apiUrl + '/');
const html = await home.text();
ok('控制台页面可渲染', home.status === 200 && html.includes('任务台账'));
ok('报告过滤与启停退出入口完整', ['report-project', 'report-status', 'report-owner', 'bus-toggle', 'console-shutdown'].every(function (x) { return html.includes(x); }));
try { new Function(frozenUiSource); ok('冻结回滚快照 app.js 语法通过', true); } catch (e) { ok('冻结回滚快照 app.js 语法通过', false, e.message); }
try {
  const mods = ['state.mjs', 'api.mjs', 'components/dom.mjs', 'components/dialog.mjs', 'views/overview.mjs', 'views/tasks.mjs', 'views/projects.mjs', 'views/settings.mjs', 'views/reports.mjs', 'main.mjs'];
  await Promise.all(mods.map(function (m) { return import('./ui/' + m); }));
  ok('ES module 整棵可加载（Node 里 import 全过）', true);
} catch (e) { ok('ES module 整棵可加载（Node 里 import 全过）', false, e.message); }
ok('新库默认关闭但 Human 看板可访问', (await (await fetch(apiUrl + '/api/bus/status')).json()).enabled === false);
const denied = await fetch('http://127.0.0.1:' + port + '/api/tasks', {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ title: 'x' }),
});
ok('无 CSRF 令牌的写入被拒绝', denied.status === 403);
const created = await fetch('http://127.0.0.1:' + port + '/api/tasks', {
  method: 'POST', headers: { 'content-type': 'application/json', 'x-agentbus-request': 'test-token' },
  body: JSON.stringify({ title: 'API 任务', project: 'default', target: null, cost_class: 'standard', write_scope: [], max_subagents: 0 }),
});
ok('关闭状态即使带令牌也拒绝创建', created.status === 409 && !apiDb.prepare("SELECT id FROM tasks WHERE title='API 任务'").get());

console.log('\n[5] 真实任务事件报告、过滤与摘要');
S.setRuntimeState(apiDb, 'human', true);
function makeTask(title, project, target) { return S.createHumanTask(apiDb, base, 'human', { title, project, target, cost_class: 'standard', write_scope: [], max_subagents: 0 }).task; }
const reviewTask = makeTask('报告 <script>window.reportXss=1</script>', 'report-demo', 'claude/main');
S.claim(apiDb, 'claude/main', reviewTask.id, 15);
S.updateTask(apiDb, 'claude/main', reviewTask.id, 'in_progress', '正在执行 UI smoke');
S.updateTask(apiDb, 'claude/main', reviewTask.id, 'review', 'node bus/smoke-admin.mjs: 42 tests pass，验收通过。\n（原始日志: bus/logs/review-output.log）');
const failedTask = makeTask('失败报告', 'report-other', 'dsh/main');
S.claim(apiDb, 'dsh/main', failedTask.id, 15);
S.updateTask(apiDb, 'dsh/main', failedTask.id, 'in_progress');
S.updateTask(apiDb, 'dsh/main', failedTask.id, 'failed', '验收命令未通过: node smoke.mjs\n' + 'FAIL trace '.repeat(1500) + '\n（原始日志: bus/logs/failure-output.log）');
const reports = await (await fetch(apiUrl + '/api/reports')).json();
const reviewed = reports.reports.find(r => r.id === reviewTask.id);
const failedReport = reports.reports.find(r => r.id === failedTask.id);
ok('真实 updateTask task.review 文本成为测试证据', reviewed.status === 'review' && reviewed.owner === 'claude/main' && reviewed.test_evidence.some(e => e.summary.includes('42 tests pass')));
ok('最近进度与 supervisor 日志路径保留', reviewed.progress.includes('验收通过') && reviewed.log_paths.includes('bus/logs/review-output.log'));
ok('真实 task.failed 文本提供失败原因', failedReport.failure_reason.includes('验收命令未通过'));
ok('长日志只返回有界摘要并保留末尾路径', failedReport.events.some(e => e.truncated) && failedReport.events.every(e => e.summary.length <= 600 && !('body' in e)) && failedReport.log_paths.some(p => p.includes('logs/failure-output.log')));
for (const query of ['project=report-demo', 'status=review', 'owner=claude%2Fmain', 'project=report-demo&status=review&owner=claude%2Fmain']) {
  const filtered = await (await fetch(apiUrl + '/api/reports?' + query)).json();
  ok('筛选 ' + query, filtered.total === 1 && filtered.reports[0].id === reviewTask.id);
}
const empty = await (await fetch(apiUrl + '/api/reports?project=missing')).json();
ok('无匹配报告返回空状态', empty.total === 0 && empty.reports.length === 0);
const injected = await (await fetch(apiUrl + '/api/reports?project=' + encodeURIComponent("' OR 1=1 --"))).json();
ok('筛选参数绑定 SQL', injected.total === 0);
for (let n = 0; n < 110; n++) makeTask('分页任务 ' + n, 'volume', null);
const bounded = await (await fetch(apiUrl + '/api/reports?project=volume')).json();
ok('报告上限明确且保留总数', bounded.total === 110 && bounded.reports.length === bounded.limit && bounded.limit === 100);

console.log('\n[6] Human 启停、版本冲突与排空');
const headers = { 'content-type': 'application/json', 'x-agentbus-request': 'test-token' };
async function control(body, extra) { return fetch(apiUrl + '/api/bus/control', { method: 'POST', headers: Object.assign({}, headers, extra), body: JSON.stringify(body) }); }
let runtime = await (await fetch(apiUrl + '/api/bus/status')).json();
const noToken = await fetch(apiUrl + '/api/bus/control', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action: 'disable', version: runtime.version }) });
ok('启停要求 CSRF', noToken.status === 403);
ok('启停拒绝跨站请求', (await control({ action: 'disable', version: runtime.version }, { origin: 'http://evil.example' })).status === 403);
ok('启停严格校验版本类型', (await control({ action: 'disable', version: String(runtime.version) })).status === 400);
const stale = runtime.version;
const drained = await control({ action: 'disable', mode: 'drain', version: runtime.version });
runtime = await drained.json();
ok('Human 排空关闭保留运行中任务', drained.status === 200 && runtime.enabled === false && runtime.mode === 'draining' && S.getTask(apiDb, reviewTask.id).status === 'review');
ok('过期启停返回 409 且不覆盖状态', (await control({ action: 'enable', version: stale })).status === 409 && !S.getRuntimeState(apiDb).enabled);
ok('关闭后报告和看板可读', (await fetch(apiUrl + '/')).status === 200 && (await fetch(apiUrl + '/api/reports')).status === 200);
const submitted = await fetch(apiUrl + '/api/tasks', { method: 'POST', headers, body: JSON.stringify({ title: '关闭状态 Human 提交', project: 'human-disabled' }) });
ok('关闭后拒绝新任务且未写入', submitted.status === 409 && !apiDb.prepare("SELECT id FROM tasks WHERE project='human-disabled'").get());
ok('关闭后运行中任务仍可提交', S.updateTask(apiDb, 'human', reviewTask.id, 'done', '验收完成', undefined, base.permissions.accept).ok);
ok('Human 可重新启用', (await (await control({ action: 'enable', version: runtime.version })).json()).enabled);
const enabledCreate = await fetch(apiUrl + '/api/tasks', { method: 'POST', headers: Object.assign({}, headers, { origin: apiUrl }), body: JSON.stringify({ title: '启用后创建', project: 'enabled-human' }) });
ok('启用后本地同源 Human 可创建', enabledCreate.status === 201 && (await enabledCreate.json()).task.title === '启用后创建');
const workerServer = createBoardServer({ db: apiDb, actor: 'claude/main', csrf: 'worker-token', projectOptions });
await new Promise(resolve => workerServer.listen(0, '127.0.0.1', resolve));
for (const endpoint of ['/api/bus/control', '/api/console/shutdown', '/api/projects']) {
  const deniedControl = await fetch('http://127.0.0.1:' + workerServer.address().port + endpoint, { method: 'POST', headers: { 'content-type': 'application/json', 'x-agentbus-request': 'worker-token' }, body: JSON.stringify({ action: 'disable', version: S.getRuntimeState(apiDb).version }) });
  ok('非 Human 无权操作 ' + endpoint, deniedControl.status === 403);
}
const deniedProjectDelete = await fetch('http://127.0.0.1:' + workerServer.address().port + '/api/projects/missing', { method: 'DELETE', headers: { 'content-type': 'application/json', 'x-agentbus-request': 'worker-token' }, body: '{}' });
ok('非 Human 禁止删除项目', deniedProjectDelete.status === 403);
await new Promise(resolve => workerServer.close(resolve));

console.log('\n[6b] 项目成本与未分配空转消耗');
S.recordUsage(apiDb, base.lead, reviewTask.id, 'review', 100, 20);
S.recordUsage(apiDb, 'dsh/main', failedTask.id, 'execute', 50, 10);
S.recordUsage(apiDb, base.lead, null, 'idle', 30, 10);
S.recordUsage(apiDb, 'dsh/main', 't-missing', 'orphan', 20, 5);
const costState = await (await fetch(apiUrl + '/api/state')).json();
const costProjects = costState.cost_by_project;
if (typeof S.costByProject === 'function') {
  ok('state 提供真实项目成本与原有成本结构', !!costProjects && Array.isArray(costState.cost.by_task) && Array.isArray(costState.cost.by_agent));
  ok('总计输入输出保持完整', costProjects.total.in === 200 && costProjects.total.out === 45 && costProjects.total.total === 245);
  ok('Lead 总计含无任务消耗', costProjects.lead.agent === base.lead && costProjects.lead.tokens === 160 && Math.abs(costProjects.lead.ratio - 160 / 245) < 1e-9);
  const project = costProjects.projects.find(p => p.project === 'report-demo');
  const other = costProjects.projects.find(p => p.project === 'report-other');
  ok('按项目单独统计任务数与 Token', project.tasks === 1 && project.in === 100 && project.out === 20 && project.total === 120 && project.lead_ratio === 1 && other.total === 60 && other.lead_ratio === 0);
  ok('NULL 与悬挂任务单列未分配', costProjects.unassigned.in === 50 && costProjects.unassigned.out === 15 && costProjects.unassigned.total === 65 && Math.abs(costProjects.unassigned.ratio - 65 / 245) < 1e-9);
  ok('未分配不计入项目且 Token 守恒', costProjects.projects.reduce((n, p) => n + p.total, 0) === 180 && costProjects.projects.reduce((n, p) => n + p.total, costProjects.unassigned.total) === costProjects.total.total);
  ok('项目按 Token 降序并包括零消耗任务', costProjects.projects[0].project === 'report-demo' && costProjects.projects[1].project === 'report-other' && costProjects.projects.find(p => p.project === 'volume').tasks === 110);
} else {
  ok('项目聚合函数不存在时不伪造数据', costProjects === null);
}
ok('总览项目区与台账项目筛选入口存在',
  html.includes('id="project-cost" hidden') && html.includes('id="task-project"') && appJsSource.includes('未分配（无任务）'),
  { markup: html.includes('id="project-cost" hidden'), script: appJsSource.includes('未分配（无任务）') });

// [6c] 归档概况与"归档前后数字一致"：数字只能来自 store 的合并口径，console-server 不许自己聚合。
console.log('\n[6c] 归档概况与归档前后一致');
ok('state 始终暴露 archive 字段（数据层未就绪时为 null）', Object.prototype.hasOwnProperty.call(costState, 'archive'), Object.keys(costState));
ok('cost 数字与 store.costSummary 完全一致（看板不自己聚合）',
  typeof S.costSummary === 'function' && costState.cost.total === S.costSummary(apiDb, base.lead).total,
  { board: costState.cost.total, store: (S.costSummary(apiDb, base.lead) || {}).total });
if (typeof S.costByProject === 'function') {
  ok('cost_by_project 与 store.costByProject 完全一致',
    costState.cost_by_project.total.total === S.costByProject(apiDb, base.lead).total.total,
    { board: costState.cost_by_project.total.total, store: S.costByProject(apiDb, base.lead).total.total });
}
if (typeof S.archiveStatus !== 'function') {
  ok('数据层未就绪时 archive 为 null 而不是编造数字', costState.archive === null, costState.archive);
} else {
  const status = costState.archive;
  ok('state.archive 暴露最近归档时间、daily/归档行数与待清理候选',
    !!status && Object.prototype.hasOwnProperty.call(status, 'last_archived_at') &&
    Number.isInteger(status.token_usage_daily_rows) && Number.isInteger(status.task_archives_rows) &&
    !!status.pending_candidates && ['messages', 'guard_events', 'token_usage', 'logs'].every(k => Number.isInteger(status.pending_candidates[k])),
    status);
}
if (typeof S.getTaskArchive !== 'function') {
  const probe = await (await fetch(apiUrl + '/api/tasks/' + encodeURIComponent(reviewTask.id) + '/archive')).json();
  ok('数据层未就绪时归档接口明确 unavailable 而不编造', probe.available === false && probe.archive === null, probe);
} else {
  // 夹具：直接写一行 task_archives，验证"已归档任务按需返回 path 与 hash"这条链路是真的通的。
  apiDb.prepare('INSERT OR REPLACE INTO task_archives(task_id,archive_path,archived_at,sha256,bytes) VALUES(?,?,?,?,?)')
    .run(reviewTask.id, 'bus/logs/archive/' + reviewTask.id + '.jsonl', new Date().toISOString(), 'f'.repeat(64), 1234);
  const archived = await (await fetch(apiUrl + '/api/tasks/' + encodeURIComponent(reviewTask.id) + '/archive')).json();
  ok('已归档任务的详情能拿到 archive path / hash / 字节数',
    archived.available === true && !!archived.archive && /\.jsonl$/.test(archived.archive.archive_path) &&
    String(archived.archive.sha256).length === 64 && archived.archive.bytes === 1234, archived.archive);
  apiDb.prepare('DELETE FROM task_archives WHERE task_id=?').run(reviewTask.id);
  const cleared = await (await fetch(apiUrl + '/api/tasks/' + encodeURIComponent(reviewTask.id) + '/archive')).json();
  ok('未归档任务的详情返回 archive=null（不显示归档行）', cleared.available === true && cleared.archive === null, cleared);
}
ok('看板含归档面板与「归档前后数字一致」说明',
  html.includes('id="archive-summary"') && html.includes('id="tf-archive-row"') &&
  appJsSource.includes('renderArchiveSummary') && appJsSource.includes('loadTaskArchive') &&
  appJsSource.includes('归档前后数字一致'),
  { markup: html.includes('id="archive-summary"'), render: appJsSource.includes('renderArchiveSummary') });
ok('外链模式下页面没有内联脚本/样式，只引用带版本号的静态资源（module 入口 + 外链 CSS）',
  html.indexOf('<script>') < 0 && html.indexOf('<style>') < 0 &&
  /<script type="module" src="\/ui\/main\.mjs\?v=[0-9a-f]{12}"><\/script>/.test(html) && /\/ui\/styles\.css\?v=[0-9a-f]{12}/.test(html),
  html.slice(0, 200));
if (typeof S.archiveStatus !== 'function') {
  console.log('  SKIP  归档前后成本一致性 :: store.archiveStatus 未就绪（第 10 项数据层由并行任务实现）');
} else {
  const rollDb = S.openDb(path.join(dir, 'archive-consistency.db'));
  try {
    S.setRuntimeState(rollDb, 'human', true);
    const rollTask = S.createTask(rollDb, { title: 'rollup', project: 'demo', status: 'open', target: 'worker' });
    S.recordUsage(rollDb, 'worker', rollTask.id, 'execute', 300, 120);
    S.recordUsage(rollDb, 'worker', rollTask.id, 'review', 40, 10);
    const beforeCost = S.costSummary(rollDb, base.lead);
    const beforeProject = typeof S.costByProject === 'function' ? S.costByProject(rollDb, base.lead) : null;
    // 模拟 archive.mjs 的聚合：raw 用量按主键范围汇总进 daily，再在同一事务删掉 raw。
    rollDb.prepare('INSERT INTO token_usage_daily(day_key,agent,project,task_id,tokens_in,tokens_out) ' +
      'SELECT substr(ts,1,10),agent,(SELECT project FROM tasks WHERE id=token_usage.task_id),task_id,SUM(tokens_in),SUM(tokens_out) ' +
      'FROM token_usage GROUP BY substr(ts,1,10),agent,task_id').run();
    const dailyRows = Number(rollDb.prepare('SELECT COUNT(*) AS n FROM token_usage_daily').get().n);
    rollDb.prepare('DELETE FROM token_usage').run();
    const afterCost = S.costSummary(rollDb, base.lead);
    const afterProject = typeof S.costByProject === 'function' ? S.costByProject(rollDb, base.lead) : null;
    ok('聚合真的落进 token_usage_daily', dailyRows > 0, dailyRows);
    ok('归档前后 costSummary 完全一致（daily + raw 去重合并）',
      beforeCost.total === afterCost.total && JSON.stringify(beforeCost.by_agent) === JSON.stringify(afterCost.by_agent),
      { before: beforeCost.total, after: afterCost.total });
    if (beforeProject) ok('归档前后 costByProject 完全一致', beforeProject.total.total === afterProject.total.total, { before: beforeProject.total.total, after: afterProject.total.total });
    const rollStatus = S.archiveStatus(rollDb, S.loadPolicy());
    ok('archiveStatus 字段齐全且待清理候选是轻量计数',
      !!rollStatus && Object.prototype.hasOwnProperty.call(rollStatus, 'last_archived_at') &&
      typeof rollStatus.token_usage_daily_rows === 'number' && typeof rollStatus.task_archives_rows === 'number' &&
      !!rollStatus.pending_candidates && ['messages', 'guard_events', 'token_usage', 'logs'].every(k => typeof rollStatus.pending_candidates[k] === 'number'),
      rollStatus);
  } finally { try { rollDb.close(); } catch (e) {} }
}



console.log('\n[6d] 归档面板前端逻辑（vm 抽真源码 + DOM 桩）');
{
  const vm = await import('node:vm');
  // 第 14 项第 2 阶段：这些渲染函数已经搬到 bus/ui/app.js，切片来源随之改变（顺序断言在 smoke-ui-static 里）。
  const uiSource = appJsSource;
  function extractFn(source, name) {
  const patterns = ['function ' + name + '(', 'async function ' + name + '('];
  let start = -1;
  for (const p of patterns) { const i = source.indexOf(p); if (i >= 0 && (start < 0 || i < start)) start = i; }
  if (start < 0) return '';
  let depth = 0, i = source.indexOf('{', start);
  for (; i < source.length; i++) {
    const ch = source[i];
    if (ch === '{') depth++;
    else if (ch === '}') { depth--; if (depth === 0) return source.slice(start, i + 1); }
  }
  return '';
}
function sliceFn(source, header, tail) {
    const start = source.indexOf(header);
    const end = source.indexOf(tail, start);
    return source.slice(start, end);
  }
  const panelBody = extractFn(uiSource, 'renderArchiveSummary');
  const boxes = {};
  const panelCtx = {
    state: { archive: null },
    q: sel => (boxes[sel] = boxes[sel] || { hidden: false, innerHTML: '' }),
    esc: v => String(v), num: v => String(v), fmt: v => String(v),
    // dash 是同一段脚本里的兄弟函数，抽单个函数时得补进上下文（和 supervisor 的抽取手法一致）。
    dash: v => (v == null ? '—' : String(v)),
  };
  const renderPanel = vm.runInNewContext('(' + panelBody.trim() + ')', panelCtx);
  renderPanel();
  ok('archive 为空时面板隐藏且不渲染内容', boxes['#archive-summary'].hidden === true && boxes['#archive-summary'].innerHTML === '');
  panelCtx.state.archive = {
    last_archived_at: '2026-05-01T00:00:00.000Z', token_usage_daily_rows: 12, task_archives_rows: 3,
    pending_candidates: { messages: 5, guard_events: 2, token_usage: 7, logs: 1 },
  };
  renderPanel();
  const panelHtml = boxes['#archive-summary'].innerHTML;
  ok('archive 有数据时面板显示四类计数与归档时间',
    boxes['#archive-summary'].hidden === false && panelHtml.includes('2026-05-01') && panelHtml.includes('12') &&
    panelHtml.includes('3') && /消息 5/.test(panelHtml) && /守卫事件 2/.test(panelHtml) && /原始 Token 用量 7/.test(panelHtml) && /日志文件 1/.test(panelHtml), panelHtml.slice(0, 300));
  ok('面板写明「归档前后数字一致」与日志删除条件',
    panelHtml.includes('归档前后数字一致') && panelHtml.includes('哈希'));
  panelCtx.state.archive = { last_archived_at: null, token_usage_daily_rows: null, task_archives_rows: null, pending_candidates: null };
  renderPanel();
  ok('缺字段时用「—」占位而不是编 0', /—/.test(boxes['#archive-summary'].innerHTML) && !/消息 0/.test(boxes['#archive-summary'].innerHTML), boxes['#archive-summary'].innerHTML.slice(0, 200));

  // 第 48 项：孤儿过期行（无归档凭据）默认不删，看板必须把计数与「永不删除」说清楚
  panelCtx.state.archive = {
    last_archived_at: '2026-05-01T00:00:00.000Z', token_usage_daily_rows: 12, task_archives_rows: 3,
    pending_candidates: { messages: 5, guard_events: 2, token_usage: 7, logs: 1 },
    unmanaged: { messages: 4, guard_events: 1, deferred_messages: 3, deferred_guard_events: 0, prune_unmanaged: false },
  };
  renderPanel();
  const orphanHtml = boxes['#archive-summary'].innerHTML;
  ok('看板显示孤儿行计数（消息/守卫事件/等待归档）',
    orphanHtml.includes('不可归属的过期行') && /孤儿消息 4 条/.test(orphanHtml) && /孤儿守卫事件 1 条/.test(orphanHtml) &&
    /等待所属任务归档 3 条消息/.test(orphanHtml), orphanHtml.slice(0, 400));
  ok('看板写明孤儿行默认「永不删除」', orphanHtml.includes('永不删除') && !orphanHtml.includes('允许删除'), orphanHtml.slice(-260));
  ok('孤儿行小节不产生 undefined/NaN', !/undefined|NaN|\[object/.test(orphanHtml), orphanHtml.slice(0, 200));
  panelCtx.state.archive = {
    last_archived_at: null, token_usage_daily_rows: 0, task_archives_rows: 0,
    pending_candidates: { messages: 0, guard_events: 0, token_usage: 0, logs: 0 },
    unmanaged: { messages: 2, guard_events: 0, deferred_messages: 1, deferred_guard_events: 0, prune_unmanaged: true },
  };
  renderPanel();
  ok('prune_unmanaged=1 时看板改口为「允许删除」并说明没有 JSONL 凭据',
    /允许删除孤儿行/.test(boxes['#archive-summary'].innerHTML) && boxes['#archive-summary'].innerHTML.includes('JSONL'), boxes['#archive-summary'].innerHTML.slice(-260));
  panelCtx.state.archive = { last_archived_at: null, token_usage_daily_rows: 0, task_archives_rows: 0, pending_candidates: { messages: 0, guard_events: 0, token_usage: 0, logs: 0 }, unmanaged: null };
  renderPanel();
  ok('unmanaged 为 null（老服务端/算不出来）时整节隐藏且不编 0',
    !boxes['#archive-summary'].innerHTML.includes('不可归属') && !/孤儿消息 0/.test(boxes['#archive-summary'].innerHTML), boxes['#archive-summary'].innerHTML.slice(0, 240));

  const archiveRow = { hidden: false, textContent: '' };
  const archiveBox = { hidden: false, textContent: '' };
  const loadCtx = {
    q: sel => (sel === '#tf-archive-row' ? archiveRow : archiveBox),
    api: async () => ({ available: true, archive: { archive_path: 'bus/logs/archive/t-0001.jsonl', archived_at: '2026-05-01T00:00:00.000Z', sha256: 'f'.repeat(64) } }),
  };
  const loadArchive = vm.runInNewContext('(' + extractFn(uiSource, 'loadTaskArchive').trim() + ')', loadCtx);
  await loadArchive({ id: 't-0001' });
  ok('已归档任务详情显示 archive path 与「主体已归档，证据摘要保留」',
    archiveRow.hidden === false && archiveBox.textContent.includes('主体已归档，证据摘要保留') &&
    archiveBox.textContent.includes('bus/logs/archive/t-0001.jsonl') && archiveBox.textContent.includes('sha256'), archiveBox.textContent);
  loadCtx.api = async () => ({ available: true, archive: null });
  await loadArchive({ id: 't-0002' });
  ok('未归档任务详情隐藏归档行', archiveRow.hidden === true && archiveBox.textContent === '');
}

console.log('项目管理 API');
// CI 上 bus/projects.json 可能根本不存在（运行时数据不入库）：按内容比较，缺文件视为空登记表。
const registryPath = path.join(S.BUS_DIR, 'projects.json');
function projectsRegistrySnapshot() {
  if (!fs.existsSync(registryPath)) return {};
  try { return (JSON.parse(fs.readFileSync(registryPath, 'utf8')) || {}).projects || {}; } catch (e) { return { unreadable: true }; }
}
const originalRegistry = projectsRegistrySnapshot();
const projectPost = body => fetch(apiUrl + '/api/projects', { method: 'POST', headers, body: JSON.stringify(body) });
const projectDelete = id => fetch(apiUrl + '/api/projects/' + encodeURIComponent(id), { method: 'DELETE', headers, body: '{}' });
ok('项目写操作要求 CSRF', (await fetch(apiUrl + '/api/projects', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })).status === 403);
const externalDir = path.join(dir, 'external-project'); fs.mkdirSync(externalDir);
const newProject = await projectPost({ id: 'registered-ui', path: externalDir, topology: 'shared', agents: ['codex/main'] });
const newProjectBody = await newProject.json();
ok('Human 创建项目返回实际路径', newProject.status === 201 && newProjectBody.project.path === externalDir && fs.existsSync(path.join(externalDir, 'project.json')));
ok('重复项目拒绝', (await projectPost({ id: 'REGISTERED-UI', path: externalDir })).status === 409);
const autoProject = await projectPost({ id: 'auto-ui', topology: 'isolated', agents: [] });
const autoBody = await autoProject.json();
ok('省略路径创建默认工作区', autoProject.status === 201 && autoBody.project.path === path.join(projectOptions.workspaceRoot, 'auto-ui') && fs.existsSync(path.join(autoBody.project.path, 'project.json')));
ok('非法项目输入400', (await projectPost({ id: 'bad/id', path: externalDir })).status === 400);
const dirtyProject = 'D:' + String.fromCharCode(92) + 'Agent_workteam';
makeTask('路径项目', dirtyProject, null);
for (let n = 0; n < 4; n++) makeTask('default 零消耗 ' + n, 'default', null);
const listing = await (await fetch(apiUrl + '/api/projects')).json();
const dirty = listing.find(p => p.id === dirtyProject), defaults = listing.find(p => p.id === 'default');
ok('路径项目保留且未登记', dirty && !dirty.registered && dirty.path === null && dirty.tasks === 1 && dirty.tokens === 0);
ok('default 零消耗任务保留', defaults && !defaults.registered && defaults.tasks === 4 && defaults.tokens === 0);
ok('已登记项目字段正确', listing.some(p => p.id === 'registered-ui' && p.registered && p.exists && p.topology === 'shared' && p.agents[0] === 'codex/main'));
makeTask('已登记项目任务', 'registered-ui', null);
const blockedDelete = await projectDelete('REGISTERED-UI');
ok('有任务禁止删除并报告数量', blockedDelete.status === 409 && (await blockedDelete.json()).error.includes('1 项任务'));
ok('未登记不能删除', (await projectDelete('unregistered-missing')).status === 404);
ok('default不能删除', (await projectDelete('default')).status >= 400);
const userFile = path.join(autoBody.project.path, 'notes.txt');
fs.writeFileSync(userFile, '用户文件保留');
const removed = await projectDelete('auto-ui');
ok('删除清理生成配置并解除登记', removed.status === 200 && !fs.existsSync(path.join(autoBody.project.path, 'project.json')) && !(await (await fetch(apiUrl + '/api/projects')).json()).some(p => p.id === 'auto-ui'));
ok('删除保留目录与用户文件', fs.statSync(autoBody.project.path).isDirectory() && fs.readFileSync(userFile, 'utf8') === '用户文件保留');
const projectState = await (await fetch(apiUrl + '/api/state')).json();
ok('state项目列表与管理能力', projectState.project_management && projectState.project_registry.some(p => p.id === dirtyProject && !p.registered));
ok('临时注册不改真实登记表（按内容比较；CI 上文件可能本就不存在）', JSON.stringify(projectsRegistrySnapshot()) === JSON.stringify(originalRegistry));
ok('项目页可选路径与未登记标记', html.includes('id="page-projects"') && html.includes('id="pf-path" placeholder=') && html.includes('未登记'));

console.log('任务验证与授权字段');
ok('任务表单字段与授权详情存在', ['tf-verify','tf-extra','tf-grants','tf-authorization','tf-extra-notice'].every(id => html.includes(id)));

const taskNodes = new Map();
function taskNode(s){ if(!taskNodes.has(s))taskNodes.set(s,{value:'',disabled:false,checked:false,selectedOptions:[],focus(){this.focused=true},addEventListener(event,fn){this[event]=fn}});return taskNodes.get(s)}
let taskRequests=0, taskNotice='';
const taskContext=vm.createContext({q:taskNode,qa:()=>[],esc:String,collectNetworkGrants:()=>[],state:{policy:{economics:{require_verify_cmd:true,auto_accept:['tests']}}},api:async()=>{taskRequests++},toast:msg=>{taskNotice=msg},load:async()=>{},dirty:false});
const submitLine=policyScript.split(String.fromCharCode(10)).find(line=>line.trim().startsWith("q('#task-form').addEventListener('submit'"));
vm.runInContext(submitLine,taskContext);
taskNode('#tf-title').value='前端验证命令必填';taskNode('#tf-cost').value='tests';taskNode('#tf-subs').value='0';
await taskNode('#task-form').submit({preventDefault(){}});
ok('必填verify_cmd在前端阻断且零请求',taskRequests===0&&taskNotice.includes('必须选择 verify_id')&&taskNode('#tf-verify').focused===true);
const fieldHeaders = headers;
const validatorProject = path.join(dir, 'validator-project'); fs.mkdirSync(validatorProject);
const validatorSpec = { command: 'node', args: ['smoke.mjs'], cwd: '.', timeout_ms: 1000 };
fs.writeFileSync(path.join(validatorProject, 'project.json'), JSON.stringify({ id: 'validator-test', root: validatorProject, validators: { smoke: validatorSpec, second: { ...validatorSpec, args: ['verify.mjs'] } } }));
const fieldInput = { title: '授权字段详情任务', project: validatorProject, cost_class: 'standard', verify_id: 'smoke', extra_dirs: ['docs'], grants: ['cfg:edit'] };
const fieldResponse = await fetch(apiUrl + '/api/tasks', { method: 'POST', headers: fieldHeaders, body: JSON.stringify(fieldInput) });
const fieldBody = await fieldResponse.json();
const fieldTask = fieldBody.task;
if (fieldTask && Object.prototype.hasOwnProperty.call(fieldTask,'verify_id')) {
  ok('API回显验证命令额外目录实际授权红线', fieldTask.verify_id === fieldInput.verify_id && !!fieldTask.verify_spec_hash && !!fieldTask.verify_spec_json && fieldTask.extra_dirs[0] === 'docs' && fieldTask.grants[0] === 'cfg:edit' && Array.isArray(fieldTask.redline));
  ok('额外目录使任务进入待批', fieldTask.status === 'proposed');
  const edits = await fetch(apiUrl + '/api/tasks/' + fieldTask.id, { method: 'PATCH', headers: fieldHeaders, body: JSON.stringify({ version: fieldTask.version, verify_id: 'second', extra_dirs: ['docs','tests'], grants: ['cfg:edit','net:egress'] }) });
  const editedFields = await edits.json();
  ok('执行前可编辑结构性授权字段', edits.status === 200 && editedFields.task.verify_id === 'second' && !!editedFields.task.verify_spec_hash && editedFields.task.extra_dirs.length === 2 && editedFields.task.grants.length === 2);
  for (const bad of [{verify_cmd:1},{verify_cmd:'x'.repeat(1001)},{extra_dirs:['x'.repeat(501)]},{extra_dirs:Array(21).fill('docs')},{grants:['unknown']}]) {
    const invalid = await fetch(apiUrl + '/api/tasks', { method: 'POST', headers: fieldHeaders, body: JSON.stringify(Object.assign({title:'非法字段测试'},bad)) });
    ok('API拒绝非法字段 ' + Object.keys(bad)[0], invalid.status === 400 && !!(await invalid.json()).error);
  }
  const lockResponse = await fetch(apiUrl + '/api/tasks', { method: 'POST', headers: fieldHeaders, body: JSON.stringify({ title:'锁定字段测试', target:'claude/main', verify_id:'smoke', project:validatorProject }) });
  const lockTask = (await lockResponse.json()).task;
  S.claim(apiDb,'claude/main',lockTask.id,15);
  for (const patch of [{verify_id:'second'},{extra_dirs:['docs']},{grants:['cfg:edit']}]) {
    const locked = await fetch(apiUrl+'/api/tasks/'+lockTask.id,{method:'PATCH',headers:fieldHeaders,body:JSON.stringify(patch)});
    ok('执行后授权字段锁定 ' + Object.keys(patch)[0], locked.status === 409 && (await locked.json()).error.includes('结构性授权字段已锁定'));
  }
  S.updateTask(apiDb,'claude/main',lockTask.id,'failed','smoke 清理运行状态');
} else {
  ok('字段API尚未就绪时明确降级', fieldResponse.status < 500);
  console.log('字段API尚未回显，跳过字段API严格断言');
}


console.log('项目验证器配置与冻结');
const projectValidatorUrl = apiUrl + '/api/projects/registered-ui/validators';
const validatorSave = await fetch(projectValidatorUrl, {method:'PUT',headers,body:JSON.stringify({validators:{smoke:validatorSpec}})});
const validatorSaveBody = await validatorSave.json();
ok('Human保存验证器通过规范化并返回备份路径',validatorSave.status===200&&validatorSaveBody.validators.smoke.command==='node'&&!!validatorSaveBody.config_path);
const projectValidatorsList = await (await fetch(apiUrl+'/api/projects')).json();
ok('项目列表从配置回显validators',projectValidatorsList.find(p=>p.id==='registered-ui').validators.smoke.args[0]==='smoke.mjs');
const invalidValidatorSave = await fetch(projectValidatorUrl,{method:'PUT',headers,body:JSON.stringify({validators:{bad:{command:'node',args:[],cwd:'../outside',timeout_ms:1000}}})});
ok('保存验证器拒绝cwd越界',invalidValidatorSave.status===400);
const invalidValidatorCreate=await projectPost({id:'invalid-spec',validators:{bad:{command:'node; echo bad',args:[],cwd:'.',timeout_ms:1000}}});
ok('创建项目拒绝非法验证器',invalidValidatorCreate.status===400);
const unknownValidator = await fetch(apiUrl+'/api/tasks',{method:'POST',headers,body:JSON.stringify({title:'未知验证器',project:validatorProject,verify_id:'missing'})});
ok('未知验证器原因透传',unknownValidator.status===409&&(await unknownValidator.json()).reason==='unknown_validator');
const legacyHuman = await fetch(apiUrl+'/api/tasks',{method:'POST',headers,body:JSON.stringify({title:'Human旧命令仅待批',verify_cmd:'node legacy.mjs'})});
ok('Human旧自由命令仅进入待批',(await legacyHuman.json()).task.status==='proposed');
const agentValidatorServer=createBoardServer({db:apiDb,actor:base.lead,csrf:'agent-validator',projectOptions});
await new Promise(resolve=>agentValidatorServer.listen(0,'127.0.0.1',resolve));
const agentUrl='http://127.0.0.1:'+agentValidatorServer.address().port;
await login(agentUrl,agentValidatorServer.agentBus.bootstrap.token);
const agentHeaders={'content-type':'application/json','x-agentbus-request':'agent-validator'};
const legacyAgent=await fetch(agentUrl+'/api/tasks',{method:'POST',headers:agentHeaders,body:JSON.stringify({title:'禁止自由命令',verify_cmd:'exit 0'})});
ok('Agent自由命令拒绝原因透传',legacyAgent.status===409&&(await legacyAgent.json()).reason==='legacy_verify_cmd_forbidden');
const agentSave=await fetch(agentUrl+'/api/projects/registered-ui/validators',{method:'PUT',headers:agentHeaders,body:JSON.stringify({validators:{}})});
ok('Agent不能编辑项目验证器',agentSave.status===403);
await new Promise(resolve=>agentValidatorServer.close(resolve));
ok('任务表单为验证器选择并提示先配置',html.includes('<select id="tf-verify">')&&!html.includes('<input id="tf-verify"')&&appJsSource.includes('此项目没有验证器，请先到项目页配置'));
console.log('策略字段生效登记');
const registryState = await (await fetch(apiUrl + '/api/state')).json();
if (registryState.policy_registry) {
  const registry = registryState.policy_registry;
  ok('state透出策略字段登记', Array.isArray(registry) && registry.length > 0 && registry.every(f=>f.path&&f.stage&&f.status&&f.owner));
  // 第 7/8/9/11 项都已接线：不再有 planned 字段，各字段归属必须写清。
  ok('第7/8/9/11项字段均为enforced且归属明确、注册表已无planned条目',
    ['global.max_chain_len','economics.max_rounds_per_task'].every(p=>registry.some(f=>f.path===p&&f.status==='enforced'&&f.owner==='item-7')) &&
    ['economics.daily_token_budget'].every(p=>registry.some(f=>f.path===p&&f.status==='enforced'&&f.owner==='item-8')) &&
    ['economics.peer_review','economics.lead_review'].every(p=>registry.some(f=>f.path===p&&f.status==='enforced'&&f.owner==='item-9')) &&
    ['permissions.merge'].every(p=>registry.some(f=>f.path===p&&f.status==='enforced'&&f.owner==='item-11')) &&
    registry.every(f=>f.status==='enforced'));
  policyContext.state.policy_registry=registry;
  vm.runInContext(policyScript.split(String.fromCharCode(10)).find(line=>line.trim().startsWith('function policyEffect(')),policyContext);
  const wiredMarkup=vm.runInContext("policyEffect('global.max_chain_len')",policyContext);
  ok('已接线字段显示已生效且不再标注待第7项接线', wiredMarkup.includes('policy-effect enforced')&&wiredMarkup.includes('阶段')&&wiredMarkup.includes('已生效')&&!wiredMarkup.includes('待第 7 项接线'));
  const budgetMarkup=vm.runInContext("policyEffect('economics.daily_token_budget')",policyContext);
  ok('item-8 日预算已接线显示已生效', budgetMarkup.includes('policy-effect enforced')&&budgetMarkup.includes('已生效')&&!budgetMarkup.includes('待第 8 项接线'));
  const reviewMarkup=vm.runInContext("policyEffect('economics.peer_review')",policyContext);
  ok('item-9 评审路由已接线显示已生效', reviewMarkup.includes('policy-effect enforced')&&reviewMarkup.includes('已生效')&&!reviewMarkup.includes('待第 9 项接线'));
  const mergeMarkup=vm.runInContext("policyEffect('permissions.merge')",policyContext);
  ok('item-11 合并权限已接线显示已生效', mergeMarkup.includes('policy-effect enforced')&&mergeMarkup.includes('已生效')&&!mergeMarkup.includes('待第'));
  // 真实注册表已经没有 planned 条目了，但「planned 必须醒目标注待第 N 项接线」这条机制仍要覆盖：
  // 用一条合成字段验证 policyEffect 的渲染分支，而不是靠真实字段假装还在待接线。
  policyContext.state.policy_registry=registry.concat([{ path:'demo.future_field', stage:'dispatch', status:'planned', owner:'item-12', note:'将来才接线' }]);
  const plannedMarkup=vm.runInContext("policyEffect('demo.future_field')",policyContext);
  ok('planned 字段仍醒目标注阶段与「待第 N 项接线」', plannedMarkup.includes('policy-effect planned')&&plannedMarkup.includes('阶段')&&plannedMarkup.includes('待第 12 项接线'));
  policyContext.state.policy_registry=registry;
  const enforcedMarkup=vm.runInContext("policyEffect('economics.report_no_raw_diff')",policyContext);
  ok('enforced字段显示实际生效阶段',enforcedMarkup.includes('报告阶段')&&enforcedMarkup.includes('已生效'));
  policyContext.state.policy_registry=null;
  ok('registry不可用时隐藏标注不伪造',vm.runInContext("policyEffect('global.max_chain_len')",policyContext)==='');
} else { ok('registry模块缺省明确返回null',registryState.policy_registry===null); }
if (process.argv.includes('--browser')) {
  console.log('\n[7] Playwright 真实页面交互');
  const { spawn } = await import('node:child_process');
  const code = [
    'import sys, os',
    'from playwright.sync_api import sync_playwright, expect',
    'with sync_playwright() as p:',
    '    launch = {"headless": True}',
    '    if os.environ.get("AGENTBUS_TEST_BROWSER_CHANNEL"): launch["channel"] = os.environ["AGENTBUS_TEST_BROWSER_CHANNEL"]',
    '    if os.environ.get("AGENTBUS_TEST_BROWSER_PATH"): launch["executable_path"] = os.environ["AGENTBUS_TEST_BROWSER_PATH"]',
    '    browser = p.chromium.launch(**launch)',
    '    page = browser.new_page(viewport={"width": 1440, "height": 1050})',
    '    page.on("dialog", lambda d: d.accept())',
    '    errors = []',
    '    page.on("pageerror", lambda e: errors.append(str(e)))',
    '    page.goto(sys.argv[1])',
    '    page.wait_for_load_state("networkidle")',
    '    page.locator("[data-page=projects]").click()',
    '    expect(page.locator("#page-projects")).to_be_visible()',
    '    expect(page.locator("[data-project-id=default]")).to_contain_text("未登记")',
    '    default_project = next(p for p in page.request.get(sys.argv[1] + "/api/projects").json() if p["id"] == "default")',
    '    expect(page.locator("[data-project-id=default] .project-facts")).to_contain_text("任务 " + str(default_project["tasks"]))',
    '    expect(page.locator("[data-project-id=default]")).to_contain_text("Token")',
    '    expect(page.locator("[data-project-id=registered-ui] [data-delete-project]")).to_be_disabled()',
    '    page.locator("[data-project-id=registered-ui] [data-edit-validators]").click()',
    '    expect(page.locator("#validators-dialog")).to_be_visible()',
    '    expect(page.locator("#project-edit-validators [data-v=command]")).to_have_value("node")',
    '    page.locator("#project-edit-add-validator").click()',
    '    row = page.locator("#project-edit-validators .validator-row").last',
    '    row.locator("[data-v=id]").fill("browser-check")',
    '    row.locator("[data-v=command]").fill("node")',
    '    row.locator("[data-v=args]").fill("--version")',
    '    row.locator("[data-v=cwd]").fill(".")',
    '    row.locator("[data-v=timeout_ms]").fill("1500")',
    '    page.locator("#validators-save").click()',
    '    expect(page.locator("#validators-result")).to_contain_text("验证器已保存")',
    '    page.screenshot(path=sys.argv[2] + "/project-validators-editor.png", full_page=True)',
    '    page.locator("#validators-close").click()',
    '    expect(page.locator("[data-project-id=registered-ui]")).to_contain_text("browser-check")',
    '    page.screenshot(path=sys.argv[2] + "/projects-desktop.png", full_page=True)',
    '    page.set_viewport_size({"width": 390, "height": 844})',
    '    page.screenshot(path=sys.argv[2] + "/projects-mobile.png", full_page=True)',
    '    assert page.evaluate("document.documentElement.scrollWidth <= innerWidth")',
    '    page.set_viewport_size({"width": 1440, "height": 1050})',
    '    page.locator("#pf-id").fill("browser-ui")',
    '    page.locator("#pf-topology").select_option("shared")',
    '    page.locator("#pf-agents").fill("codex/main, claude/main")',
    '    page.locator("#project-create-submit").click()',
    '    expect(page.locator("#project-result")).to_contain_text("project.json")',
    '    expect(page.locator("[data-project-id=browser-ui]")).to_contain_text("已登记")',
    '    page.locator("[data-project-id=browser-ui] [data-delete-project]").click()',
    '    expect(page.locator("[data-project-id=browser-ui]")).to_have_count(0)',
    '    page.locator("[data-page=tasks]").click()',
    '    page.locator("#task-project").select_option("default")',
    '    current_tasks = page.request.get(sys.argv[1] + "/api/tasks").json()',
    '    active_default_count = sum(1 for t in current_tasks if t["project"] == "default" and t["status"] not in ["done", "failed", "declined", "cancelled"])',
    '    expect(page.locator("#task-rows tr")).to_have_count(active_default_count)',
    '    expect(page.locator("#task-rows tr").first).to_contain_text("未登记")',
    '    page.locator("[data-page=overview]").click()',
    '    def require_verification(route):',
    '        response = route.fetch()',
    '        data = response.json()',
    '        data["policy"]["economics"]["require_verify_cmd"] = True',
    '        data["policy"]["economics"]["auto_accept"] = ["tests"]',
    '        route.fulfill(response=response, json=data)',
    '    page.route("**/api/state", require_verification)',
    '    page.reload()',
    '    page.wait_for_load_state("networkidle")',
    '    create_requests = []',
    '    page.on("request", lambda r: create_requests.append(r.url) if r.method == "POST" and r.url.endswith("/api/tasks") else None)',
    '    page.locator("[data-new-task]").first.click()',
    '    page.locator("#tf-title").fill("前端必填验证命令")',
    '    expect(page.locator("#tf-verify-help")).to_contain_text("先到项目页配置")',
    '    page.locator("#tf-cost").select_option("tests")',
    '    page.locator("#save-task").click()',
    '    expect(page.locator("#toast")).to_contain_text("必须选择 verify_id")',
    '    assert len(create_requests) == 0',
    '    expect(page.locator("#task-dialog")).to_be_visible()',
    '    page.locator("[data-close-task]").first.click()',
    '    page.unroute("**/api/state", require_verification)',
    '    page.reload()',
    '    page.wait_for_load_state("networkidle")',
    '    expect(page.locator("#project-cost")).to_be_visible()',
    '    expect(page.locator("#cost-total-in")).to_have_text("200")',
    '    expect(page.locator("#cost-total-out")).to_have_text("45")',
    '    expect(page.locator("#cost-total")).to_have_text("245")',
    '    expect(page.locator("#cost-unassigned-total")).to_have_text("65")',
    '    expect(page.locator("#cost-unassigned")).to_contain_text("空转消耗")',
    '    expect(page.locator("[data-cost-project=report-demo]")).to_contain_text("120")',
    '    assert page.locator("#cost-unassigned [data-cost-project]").count() == 0',
    '    page.screenshot(path=sys.argv[2] + "/cost-projects-desktop.png", full_page=True)',
    '    page.set_viewport_size({"width": 390, "height": 844})',
    '    page.screenshot(path=sys.argv[2] + "/cost-projects-mobile.png", full_page=True)',
    '    assert page.evaluate("document.documentElement.scrollWidth <= innerWidth")',
    '    page.set_viewport_size({"width": 1440, "height": 1050})',
    '    page.locator("[data-page=tasks]").click()',
    '    page.locator("#show-terminal").click()',
    '    page.locator("#task-project").select_option("report-demo")',
    '    page.locator("#task-status").select_option("done")',
    '    page.locator("#task-search").fill("报告")',
    '    expect(page.locator("#task-rows tr")).to_have_count(1)',
    '    expect(page.locator("#task-rows")).to_contain_text("report-demo")',
    '    page.locator("#task-status").select_option("failed")',
    '    expect(page.locator("#task-empty")).to_be_visible()',
    '    page.locator("[data-page=tasks]").click()',
    '    page.locator("#task-project").select_option(os.path.join(sys.argv[2], "validator-project"))',
    '    page.locator("#task-status").select_option("")',
    '    page.locator("#task-search").fill("授权字段详情")',
    '    page.locator("#task-rows [data-edit]").first.click()',
    '    expect(page.locator("#tf-verify")).to_have_value("second")',
    '    expect(page.locator("#tf-frozen-spec")).to_contain_text("SHA-256")',
    '    expect(page.locator("#tf-extra")).to_have_value("docs" + chr(10) + "tests")',
    '    expect(page.locator("#tf-authorization")).to_contain_text("cfg:edit")',
    '    expect(page.locator("#tf-extra-notice")).to_be_visible()',
    '    page.screenshot(path=sys.argv[2] + "/task-authorization-details.png", full_page=True)',
    '    page.locator("[data-close-task]").first.click()',
    '    page.locator("[data-page=reports]").click()',
    '    page.wait_for_load_state("networkidle")',
    '    expect(page.locator("#page-reports")).to_be_visible()',
    '    page.locator("#report-project").select_option("report-demo")',
    '    expect(page.locator(".report-card")).to_have_count(1)',
    '    expect(page.locator(".report-evidence")).to_contain_text("42 tests pass")',
    '    assert page.evaluate("window.reportXss || 0") == 0',
    '    page.locator(".report-card summary").click()',
    '    expect(page.locator(".report-log")).to_contain_text("review-output.log")',
    '    page.screenshot(path=sys.argv[2] + "/reports-desktop.png", full_page=True)',
    '    page.locator("#report-status").select_option("failed")',
    '    expect(page.locator("#report-list")).to_contain_text("没有符合条件")',
    '    page.locator("#report-clear").click()',
    '    page.locator("#report-project").select_option("report-other")',
    '    expect(page.locator(".report-failure")).to_contain_text("验收命令未通过")',
    '    page.locator("#report-owner").select_option("dsh/main")',
    '    expect(page.locator(".report-card")).to_have_count(1)',
    '    page.set_viewport_size({"width": 390, "height": 844})',
    '    page.screenshot(path=sys.argv[2] + "/reports-mobile.png", full_page=True)',
    '    assert page.evaluate("document.documentElement.scrollWidth <= innerWidth")',
    '    page.locator("#bus-toggle").click()',
    '    expect(page.locator("#bus-control-title")).to_contain_text("已关闭")',
    '    expect(page.locator("#page-reports")).to_be_visible()',
    '    assert page.locator("[data-new-task]").first.is_disabled()',
    '    page.locator("#bus-toggle").click()',
    '    expect(page.locator("#bus-control-title")).to_contain_text("已启用")',
    '    assert not errors, errors',
    '    page.set_viewport_size({"width": 1440, "height": 1050})',
    '    page.locator("[data-page=policy]").click()',
    '    expect(page.locator("[data-e=lead_plans_once]")).to_have_count(0)',
    '    registry = page.request.get(sys.argv[1] + "/api/state").json().get("policy_registry")',
    '    if registry:',
    '        for policy_path in []:',
    '            marker = page.locator("[data-policy-path=" + chr(34) + policy_path + chr(34) + "]")',
    '            expect(marker).to_be_visible()',
    '            expect(marker).to_contain_text("待第")',
    '            expect(marker).to_have_class("policy-effect planned")',
    '        for policy_path in ["global.max_chain_len", "economics.max_rounds_per_task", "economics.daily_token_budget", "economics.peer_review", "economics.lead_review", "permissions.merge"]:',
    '            marker = page.locator("[data-policy-path=" + chr(34) + policy_path + chr(34) + "]")',
    '            expect(marker).to_be_visible()',
    '            expect(marker).to_contain_text("已生效")',
    '            expect(marker).to_have_class("policy-effect enforced")',
    '        expect(page.locator("[data-policy-path=" + chr(34) + "economics.report_no_raw_diff" + chr(34) + "]")).to_contain_text("已生效")',
    '        page.screenshot(path=sys.argv[2] + "/policy-runtime-registry.png", full_page=True)',
    '    verify_switch = page.locator("[data-e=require_verify_cmd]")',
    '    expect(verify_switch).to_be_visible()',
    '    original_policy = page.request.get(sys.argv[1] + "/api/state").json()["policy"]',
    '    assert verify_switch.is_checked() == (original_policy["economics"].get("require_verify_cmd") is True)',
    '    captured_policy = []',
    '    def intercept_policy(route):',
    '        body = route.request.post_data_json',
    '        captured_policy.append(body)',
    '        route.fulfill(status=200, json={"ok": True, "policy": body["policy"]})',
    '    page.route("**/api/policy", intercept_policy)',
    '    verify_switch.check()',
    '    page.screenshot(path=sys.argv[2] + "/policy-verify-required.png", full_page=True)',
    '    page.locator("#save-policy").click()',
    '    expect(page.locator("#toast")).to_contain_text("策略已保存")',
    '    assert captured_policy[-1]["policy"]["economics"]["require_verify_cmd"] is True',
    '    page.unroute("**/api/policy", intercept_policy)',
    '    assert page.request.get(sys.argv[1] + "/api/state").json()["policy"] == original_policy',
    '    assert not errors, errors',
    '    page.locator("#console-shutdown").click()',
    '    expect(page.locator("#bus-status")).to_have_text("看板已退出")',
    '    browser.close()',
    'print("Playwright: filters, evidence, XSS, logs, mobile, controls, shutdown PASS")',
  ].join('\n');
  const exit = await new Promise((resolve, reject) => { const child = spawn(process.env.AGENTBUS_TEST_PYTHON || 'python', ['-c', code, apiUrl, dir], { stdio: 'inherit' }); child.once('error', reject); child.once('close', resolve); });
  ok('Playwright 浏览器交互通过', exit === 0);
  console.log('截图路径: ' + dir);
}
console.log('\n[9] 会话 + CSRF + Origin 三要素与审计');
const probe = { title: '认证探测任务', project: 'auth-probe' };
function probeWrite(extra, body) { return fetch(apiUrl + '/api/tasks', { method: 'POST', headers: Object.assign({}, headers, extra || {}), body: JSON.stringify(body || probe) }); }
const noSessionWrite = await probeWrite({ 'x-test-no-session': '1' });
const noSessionWriteBody = await noSessionWrite.json();
ok('无会话 cookie 的写入被拒且错误码稳定', noSessionWrite.status === 403 && noSessionWriteBody.code === 'session_required');
const noSessionRead = await fetch(apiUrl + '/api/state', { headers: { 'x-test-no-session': '1' } });
ok('无会话读取 API 也被拒', noSessionRead.status === 403 && (await noSessionRead.json()).code === 'session_required');
const noCsrfWrite = await fetch(apiUrl + '/api/tasks', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(probe) });
const noCsrfBody = await noCsrfWrite.json();
ok('有会话但无 CSRF 头被拒', noCsrfWrite.status === 403 && noCsrfBody.code === 'csrf_required');
const badOriginWrite = await probeWrite({ 'x-test-bad-origin': '1' });
const badOriginBody = await badOriginWrite.json();
ok('外部域名 Origin 被拒', badOriginWrite.status === 403 && badOriginBody.code === 'origin_mismatch');
ok('403 提示写明两个可接受的 loopback Origin', String(badOriginBody.error).includes('http://127.0.0.1:' + port) && String(badOriginBody.error).includes('http://localhost:' + port));
const noOriginWrite = await probeWrite({ 'x-test-no-origin': '1' });
const noOriginBody = await noOriginWrite.json();
ok('缺少 Origin 被拒', noOriginWrite.status === 403 && noOriginBody.code === 'origin_required');
ok('被拒的写入没有落库', !apiDb.prepare("SELECT id FROM tasks WHERE title='认证探测任务'").get());
const allowedWrite = await probeWrite();
const allowedBody = await allowedWrite.json();
ok('会话 + CSRF + 正确 Origin 的写入通过', allowedWrite.status === 201 && !!allowedBody.task && allowedBody.task.title === probe.title);
const localhostWrite = await probeWrite({ 'x-test-localhost-origin': '1' }, { title: '本地回环写任务', project: 'auth-probe' });
const localhostBody = await localhostWrite.json();
ok('localhost 同端口可写', localhostWrite.status === 201 && !!localhostBody.task && localhostBody.task.title === '本地回环写任务');
const localhostPortWrite = await probeWrite({ 'x-test-localhost-other-port': '1' });
const localhostPortBody = await localhostPortWrite.json();
ok('localhost 端口不一致被拒', localhostPortWrite.status === 403 && localhostPortBody.code === 'origin_mismatch');

// 审计：策略保存、项目创建/删除、验证器保存、总线启停、看板退出都要留痕；token/cookie/正文不入库。
const policyPut = await fetch(apiUrl + '/api/policy', { method: 'PUT', headers, body: JSON.stringify({ policy: JSON.parse(fs.readFileSync(serverPolicyPath, 'utf8')) }) });
const policyPutBody = await policyPut.json();
ok('策略保存返回 200', policyPut.status === 200);
ok('策略保存写的是临时副本而非真实 policy.json', path.resolve(policyPutBody.backup || '').indexOf(path.resolve(dir) + path.sep) === 0);
ok('临时副本内容已更新为保存结果', JSON.parse(fs.readFileSync(serverPolicyPath, 'utf8')).lead === policyPutBody.policy.lead);
const auditRows = Auth.listAudit(apiDb, 200);
const auditActions = auditRows.map(function (r) { return r.action; });
for (const action of ['policy.save', 'project.create', 'project.delete', 'validators.save', 'bus.enable', 'bus.disable']) {
  ok('审计记录 ' + action, auditActions.indexOf(action) >= 0);
}
const auditText = JSON.stringify(auditRows);
ok('审计不含 token、cookie 与请求正文', auditText.indexOf(bootstrapToken) < 0 && auditText.indexOf(sessionCookie.split('=')[1]) < 0 && auditText.indexOf('agentbus_console_session=') < 0 && auditText.indexOf(probe.title) < 0);
ok('审计保留操作者与认证方式', auditRows.filter(function (r) { return r.action === 'policy.save'; }).every(function (r) { return r.actor === 'human' && r.auth_method === 'session'; }));

console.log('\n[10] 网络白名单：策略段与任务授权');
const networkState = await (await fetch(apiUrl + '/api/state')).json();
ok('state 可读 network 段（default deny + local_services）', !!networkState.policy.network && networkState.policy.network['default'] === 'deny' && networkState.policy.network.local_services.some(function (s) { return s.port === 7400; }));
const editedPolicy = JSON.parse(fs.readFileSync(serverPolicyPath, 'utf8'));
editedPolicy.network = { default: 'deny', local_services: [{ port: 7400, purpose: 'AgentBus 本地看板' }, { port: 7500, purpose: 'smoke 本地模型' }] };
const networkPut = await fetch(apiUrl + '/api/policy', { method: 'PUT', headers, body: JSON.stringify({ policy: editedPolicy }) });
const networkPutBody = await networkPut.json();
ok('策略保存接受 network 段', networkPut.status === 200 && networkPutBody.policy.network.local_services.length === 2);
const networkStateAfter = await (await fetch(apiUrl + '/api/state')).json();
ok('local_services 变更立即可读', networkStateAfter.policy.network.local_services.some(function (s) { return s.port === 7500 && s.purpose === 'smoke 本地模型'; }));
ok('local_services 变更落到策略文件', JSON.parse(fs.readFileSync(serverPolicyPath, 'utf8')).network.local_services.some(function (s) { return s.port === 7500; }));
const clearedPolicy = JSON.parse(fs.readFileSync(serverPolicyPath, 'utf8'));
clearedPolicy.network = { default: 'deny', local_services: [] };
const clearPut = await fetch(apiUrl + '/api/policy', { method: 'PUT', headers, body: JSON.stringify({ policy: clearedPolicy }) });
const clearedState = await (await fetch(apiUrl + '/api/state')).json();
ok('用户清空 local_services 会真正落盘（不被兜底掩盖）', clearPut.status === 200 && clearedState.policy.network.local_services.length === 0);
await fetch(apiUrl + '/api/policy', { method: 'PUT', headers, body: JSON.stringify({ policy: editedPolicy }) });
for (const [label, network] of [
  ['default 非 deny', { default: 'allow' }],
  ['端口重复', { default: 'deny', local_services: [{ port: 7400, purpose: 'a' }, { port: 7400, purpose: 'b' }] }],
  ['缺 purpose', { default: 'deny', local_services: [{ port: 7400 }] }],
  ['端口越界', { default: 'deny', local_services: [{ port: 70000, purpose: 'x' }] }],
]) {
  const invalid = await fetch(apiUrl + '/api/policy', { method: 'PUT', headers, body: JSON.stringify({ policy: Object.assign({}, editedPolicy, { network }) }) });
  ok('非法 network 段被 400 拒绝：' + label, invalid.status === 400 && !!(await invalid.json()).error);
}
const grantInput = { title: '网络授权任务', project: 'network-demo', target: 'claude/main', network_grants: [{ protocol: 'HTTPS', host: 'API.Example.com', ports: [443, '8443', 443], purpose: '调用 API' }] };
const grantCreate = await fetch(apiUrl + '/api/tasks', { method: 'POST', headers, body: JSON.stringify(grantInput) });
const grantTask = (await grantCreate.json()).task;
ok('任务创建回显规范化后的 network_grants', grantCreate.status === 201 && grantTask.network_grants.length === 1 && grantTask.network_grants[0].protocol === 'https' && grantTask.network_grants[0].host === 'api.example.com' && JSON.stringify(grantTask.network_grants[0].ports) === '[443,8443]');
const grantDetail = await (await fetch(apiUrl + '/api/tasks/' + grantTask.id)).json();
ok('任务详情回显 network_grants', JSON.stringify(grantDetail.network_grants) === JSON.stringify(grantTask.network_grants));
const grantList = await (await fetch(apiUrl + '/api/tasks')).json();
ok('任务列表回显 network_grants', (grantList.find(function (t) { return t.id === grantTask.id; }) || {}).network_grants.length === 1);
const grantEdit = await fetch(apiUrl + '/api/tasks/' + grantTask.id, { method: 'PATCH', headers, body: JSON.stringify({ version: grantTask.version, network_grants: [{ protocol: 'http', host: 'internal.example.com', ports: [8080], purpose: '内网只读' }] }) });
const grantEdited = await grantEdit.json();
ok('任务编辑更新 network_grants', grantEdit.status === 200 && grantEdited.task.network_grants.length === 1 && grantEdited.task.network_grants[0].host === 'internal.example.com' && grantEdited.task.network_grants[0].protocol === 'http');
for (const [label, grants] of [
  ['协议非法', [{ protocol: 'ftp', host: 'a.example.com', ports: [21], purpose: 'x' }]],
  ['host 带通配', [{ protocol: 'https', host: '*.example.com', ports: [443], purpose: 'x' }]],
  ['host 带路径', [{ protocol: 'https', host: 'api.example.com/x', ports: [443], purpose: 'x' }]],
  ['host 是 CIDR', [{ protocol: 'https', host: '10.0.0.0/8', ports: [443], purpose: 'x' }]],
  ['缺 purpose', [{ protocol: 'https', host: 'a.example.com', ports: [443] }]],
  ['端口越界', [{ protocol: 'https', host: 'a.example.com', ports: [0], purpose: 'x' }]],
  ['超过 8 项', Array.from({ length: 9 }, function () { return { protocol: 'https', host: 'a.example.com', ports: [443], purpose: 'x' }; })],
  ['不是数组', 'nope'],
]) {
  const bad = await fetch(apiUrl + '/api/tasks', { method: 'POST', headers, body: JSON.stringify({ title: '非法网络授权', network_grants: grants }) });
  ok('非法 network_grants 被 400 拒绝：' + label, bad.status === 400 && !!(await bad.json()).error);
}
ok('被拒的非法网络授权没有落库', !apiDb.prepare("SELECT id FROM tasks WHERE title='非法网络授权'").get());
ok('带网络授权的任务默认进入待批', grantTask.status === 'proposed');
apiDb.prepare('UPDATE tasks SET status=?, owner=? WHERE id=?').run('claimed', 'claude/main', grantTask.id);
const lockedGrant = await fetch(apiUrl + '/api/tasks/' + grantTask.id, { method: 'PATCH', headers, body: JSON.stringify({ network_grants: [{ protocol: 'https', host: 'later.example.com', ports: [443], purpose: 'x' }] }) });
ok('任务开始后 network_grants 锁定', lockedGrant.status === 409 && (await lockedGrant.json()).error.includes('结构性授权字段已锁定'));
apiDb.prepare('UPDATE tasks SET status=? WHERE id=?').run('cancelled', grantTask.id);
const taskUiLines = policyScript.split(String.fromCharCode(10)).filter(function (line) { return /^function (networkGrantRows|collectNetworkGrants)\(/.test(line.trim()); }).join(String.fromCharCode(10));
const editedGrantRows = [
  { querySelector: function (s) { return { value: s.indexOf('protocol') >= 0 ? 'http' : s.indexOf('host') >= 0 ? 'API.Example.com' : s.indexOf('ports') >= 0 ? '80, 8080' : '内网只读' }; } },
  { querySelector: function () { return { value: '' }; } },
];
const grantContext = vm.createContext({ q: function (s) { return { value: '', hidden: false, innerHTML: '' }; }, qa: function (s) { return s === '[data-network-grant]' ? editedGrantRows : []; }, esc: String });
vm.runInContext(taskUiLines, grantContext);
const collectedGrants = vm.runInContext('collectNetworkGrants()', grantContext);
ok('任务表单把用户填写的网络目标提交为 network_grants（空行忽略）', JSON.stringify(collectedGrants) === '[{"protocol":"http","host":"API.Example.com","ports":[80,8080],"purpose":"内网只读"}]', collectedGrants);
const networkEditorIds = ['policy-network', 'network-default', 'network-services', 'network-add-service', 'tf-network-grants', 'tf-network-empty', 'tf-add-network-grant'];
ok('策略页与任务表单都有网络编辑器入口', networkEditorIds.every(function (id) { return html.includes('id="' + id + '"'); }));
ok('浏览器脚本含网络编辑器逻辑', ['renderNetworkServices', 'collectNetworkPolicy', 'renderNetworkGrants', 'collectNetworkGrants'].every(function (name) { return appJsSource.includes('function ' + name + '('); }));
ok('网络编辑器明示只审计、无法强制隔离', html.includes('无法强制隔离'));

console.log('\n[8] 退出看板不影响总线 / Worker');
const beforeShutdown = S.getRuntimeState(apiDb);
if (server.listening) {
  ok('退出看板要求 CSRF', (await fetch(apiUrl + '/api/console/shutdown', { method: 'POST' })).status === 403);
  const closeEvent = new Promise(resolve => server.once('close', resolve));
  const shutdown = await fetch(apiUrl + '/api/console/shutdown', { method: 'POST', headers, body: '{}' });
  ok('Human 可优雅关闭本看板', shutdown.status === 200 && (await shutdown.json()).ok);
  await closeEvent;
}
ok('看板退出写入审计', Auth.listAudit(apiDb, 50).some(function (r) { return r.action === 'console.shutdown'; }));
let portClosed = false;
try { await fetch(apiUrl + '/api/state'); } catch (e) { portClosed = true; }
ok('退出后看板端口关闭', portClosed && !server.listening);
ok('退出不改变总线状态且任务仍在', S.getRuntimeState(apiDb).enabled === beforeShutdown.enabled && S.getTask(apiDb, failedTask.id).status === 'failed');
const realPolicyHashAfter = crypto.createHash('sha256').update(fs.readFileSync(realPolicyFile)).digest('hex');
ok('全程未改动真实 policy.json（跑前跑后字节哈希一致）', realPolicyHashBefore === realPolicyHashAfter);
console.log('测试临时目录: ' + dir);
apiDb.close(); db.close();


console.log('\n==================================');
console.log('PASS ' + pass + '   FAIL ' + fail);
process.exitCode = fail ? 1 : 0;
