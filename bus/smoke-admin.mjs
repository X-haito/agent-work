#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as S from './store.mjs';
import * as A from './admin-config.mjs';
import { createBoardServer } from './console-server.mjs';
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
const policyScript = renderConsole({ csrf: 'test', actor: 'human' }).split('<script>')[1].split('</script>')[0];
const nodes = new Map();
function policyNode(selector) { if (!nodes.has(selector)) nodes.set(selector, { value: '', checked: false, innerHTML: '' }); return nodes.get(selector); }
let savedPolicyBody;
const policyContext = vm.createContext({
  state: { policy: JSON.parse(JSON.stringify(base)) }, dirty: true,
  q: policyNode,
  qa: function (selector) { return selector === '[data-e]' ? [{ dataset: { e: 'require_verify_cmd' }, get checked() { return policyNode('[data-e="require_verify_cmd"]').checked; } }] : []; },
  esc: String, csv: v => (v || []).join(', '), split: v => String(v || '').split(',').map(x => x.trim()).filter(Boolean),
  api: async function (url, options) { savedPolicyBody = options.body; return { policy: options.body.policy }; },
  toast: function () {}, load: async function () {},
});
vm.runInContext(policyScript.split('\n').filter(line => line.trim().startsWith('function renderPolicy()') || line.trim().startsWith('function collectPolicy()') || line.trim().startsWith("q('#save-policy').onclick=")).join('\n'), policyContext);
for (const value of [false, true]) {
  policyContext.state.policy.economics.require_verify_cmd = value;
  vm.runInContext('renderPolicy()', policyContext);
  const switches = policyNode('#economics-switches').innerHTML;
  ok('验收命令开关初始值 ' + value, switches.includes('自动验收类别必须填写 verify_cmd') && (switches.includes('data-e="require_verify_cmd" checked') === value));
}
policyNode('[data-e="require_verify_cmd"]').checked = true;
await vm.runInContext("q('#save-policy').onclick()", policyContext);
ok('勾选后策略保存请求含 boolean true', savedPolicyBody.policy.economics.require_verify_cmd === true);
policyNode('[data-e="require_verify_cmd"]').checked = false;
await vm.runInContext("q('#save-policy').onclick()", policyContext);
ok('取消勾选后策略保存请求含 boolean false', savedPolicyBody.policy.economics.require_verify_cmd === false);

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
const server = createBoardServer({ port: 7400, actor: 'human', csrf: 'test-token', db: apiDb, projectOptions });
await new Promise(function (resolve) { server.listen(0, '127.0.0.1', resolve); });
const port = server.address().port;
const apiUrl = 'http://127.0.0.1:' + port;
const home = await fetch(apiUrl + '/');
const html = await home.text();
ok('控制台页面可渲染', home.status === 200 && html.includes('任务台账'));
ok('报告过滤与启停退出入口完整', ['report-project', 'report-status', 'report-owner', 'bus-toggle', 'console-shutdown'].every(function (x) { return html.includes(x); }));
try { new Function(html.split('<script>')[1].split('</script>')[0]); ok('完整浏览器脚本语法通过', true); } catch (e) { ok('完整浏览器脚本语法通过', false, e.message); }
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
ok('总览项目区与台账项目筛选入口存在', html.includes('id="project-cost" hidden') && html.includes('未分配（无任务）') && html.includes('id="task-project"'));



console.log('项目管理 API');
const originalRegistry = fs.readFileSync(path.join(S.BUS_DIR, 'projects.json'), 'utf8');
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
ok('临时注册不改真实文件', fs.readFileSync(path.join(S.BUS_DIR, 'projects.json'), 'utf8') === originalRegistry);
ok('项目页可选路径与未登记标记', html.includes('id="page-projects"') && html.includes('id="pf-path" placeholder=') && html.includes('未登记'));
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
    '    errors = []',
    '    page.on("pageerror", lambda e: errors.append(str(e)))',
    '    page.goto(sys.argv[1])',
    '    page.wait_for_load_state("networkidle")',
    '    page.locator("[data-page=projects]").click()',
    '    expect(page.locator("#page-projects")).to_be_visible()',
    '    expect(page.locator("[data-project-id=default]")).to_contain_text("未登记")',
    '    expect(page.locator("[data-project-id=default]")).to_contain_text("4")',
    '    expect(page.locator("[data-project-id=registered-ui] [data-delete-project]")).to_be_disabled()',
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
    '    page.once("dialog", lambda d: d.accept())',
    '    page.locator("[data-project-id=browser-ui] [data-delete-project]").click()',
    '    expect(page.locator("[data-project-id=browser-ui]")).to_have_count(0)',
    '    page.locator("[data-page=tasks]").click()',
    '    page.locator("#task-project").select_option("default")',
    '    expect(page.locator("#task-rows tr")).to_have_count(4)',
    '    expect(page.locator("#task-rows tr").first).to_contain_text("未登记")',
    '    page.locator("[data-page=overview]").click()',
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
    '    page.on("dialog", lambda d: d.accept())',
    '    page.locator("#bus-toggle").click()',
    '    expect(page.locator("#bus-control-title")).to_contain_text("已关闭")',
    '    expect(page.locator("#page-reports")).to_be_visible()',
    '    assert page.locator("[data-new-task]").first.is_disabled()',
    '    page.locator("#bus-toggle").click()',
    '    expect(page.locator("#bus-control-title")).to_contain_text("已启用")',
    '    assert not errors, errors',
    '    page.set_viewport_size({"width": 1440, "height": 1050})',
    '    page.locator("[data-page=policy]").click()',
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
console.log('\n[8] 退出看板不影响总线 / Worker');
const beforeShutdown = S.getRuntimeState(apiDb);
if (server.listening) {
  ok('退出看板要求 CSRF', (await fetch(apiUrl + '/api/console/shutdown', { method: 'POST' })).status === 403);
  const closeEvent = new Promise(resolve => server.once('close', resolve));
  const shutdown = await fetch(apiUrl + '/api/console/shutdown', { method: 'POST', headers, body: '{}' });
  ok('Human 可优雅关闭本看板', shutdown.status === 200 && (await shutdown.json()).ok);
  await closeEvent;
}
let portClosed = false;
try { await fetch(apiUrl + '/api/state'); } catch (e) { portClosed = true; }
ok('退出后看板端口关闭', portClosed && !server.listening);
ok('退出不改变总线状态且任务仍在', S.getRuntimeState(apiDb).enabled === beforeShutdown.enabled && S.getTask(apiDb, failedTask.id).status === 'failed');
console.log('测试临时目录: ' + dir);
apiDb.close(); db.close();


console.log('\n==================================');
console.log('PASS ' + pass + '   FAIL ' + fail);
process.exitCode = fail ? 1 : 0;
