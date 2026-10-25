#!/usr/bin/env node
// 第 14 项第 1 阶段：静态资源 allowlist、缓存/MIME/安全头、CSP、CSS 外链与内联回滚。
// 关键验证方式：**用渲染产物**做 new vm.Script(...) 校验（node --check 查不出模板字面量里的转义问题）。
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import * as S from './store.mjs';
import * as CS from './console-server.mjs';
import { renderConsole, renderDenied } from './board-ui.mjs';

let pass = 0, fail = 0;
function ok(name, cond, detail) {
  if (cond) { pass++; console.log('PASS ' + name); return true; }
  fail++; console.log('FAIL ' + name + (detail === undefined ? '' : ' :: ' + String(detail).slice(0, 400)));
  return false;
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'agentbus-ui-static-'));
const db = S.openDb(path.join(tmp, 'bus.db'));
S.setRuntimeState(db, 'human', true);
const uiDir = path.join(S.BUS_DIR, 'ui');
const cssPath = path.join(uiDir, 'styles.css');
const deniedPath = path.join(uiDir, 'denied.css');
ok('短视频样式文件存在（bus/ui/styles.css）', fs.existsSync(cssPath));
ok('403 页面样式文件存在（bus/ui/denied.css）', fs.existsSync(deniedPath));
const css = fs.readFileSync(cssPath, 'utf8');

// ---------- [1] 静态资源解析（纯函数） ----------
console.log('\n[1] 静态资源 allowlist 与路径规范化');
ok('白名单内的文件可解析且 MIME 正确', (function () {
  const a = CS.resolveUiAsset('styles.css');
  return a && a.name === 'styles.css' && a.type === 'text/css; charset=utf-8' && a.version === crypto.createHash('sha256').update(css).digest('hex').slice(0, 12);
})(), CS.resolveUiAsset('styles.css'));
for (const bad of ['../console-server.mjs', '..%2Fconsole-server.mjs', '../../etc/passwd', '/etc/passwd', 'C:\\Windows\\win.ini', 'unknown.css', 'styles.css/../store.mjs', '..', '', 'styles.css%00.png']) {
  ok('拒绝越权/未知路径: ' + JSON.stringify(bad), CS.resolveUiAsset(bad) === null, CS.resolveUiAsset(bad));
}
const MODULES = ['main.mjs', 'api.mjs', 'state.mjs', 'components/dom.mjs', 'components/dialog.mjs',
  'views/overview.mjs', 'views/tasks.mjs', 'views/projects.mjs', 'views/settings.mjs', 'views/reports.mjs'];
ok('白名单是显式列举（13 项，含冻结的 app.js）', Object.keys(CS.UI_ASSET_ALLOWLIST || {}).length === 13, Object.keys(CS.UI_ASSET_ALLOWLIST || {}));
ok('每个 ES module 都在白名单里且 MIME 正确',
  MODULES.every(function (m) { const a = CS.resolveUiAsset(m); return a && String(a.type).indexOf('text/javascript') === 0; }),
  MODULES.filter(function (m) { return !CS.resolveUiAsset(m); }));
ok('仍然拒绝穿越/绝对路径', ['../bus.db', 'views/../../x', '/etc/passwd', 'views/x.mjs', 'a/b/c.mjs'].every(function (p) { return CS.resolveUiAsset(p) === null; }));

// ---------- [2] CSP 头 ----------
console.log('\n[2] CSP');
const cspStage1 = CS.uiContentSecurityPolicy(false);
ok('CSP 含 default-src/script-src/style-src/connect-src', /default-src 'self'/.test(cspStage1) && /script-src/.test(cspStage1) && /style-src/.test(cspStage1) && /connect-src 'self'/.test(cspStage1), cspStage1);
ok('CSP 关闭 frame-ancestors 之外的嵌套', /frame-ancestors 'none'/.test(cspStage1));
ok('外链模式的 CSP 已是目标形态：script-src / style-src 都不含 unsafe-inline', cspStage1.indexOf('unsafe-inline') < 0 && /script-src 'self'/.test(cspStage1) && /style-src 'self'/.test(cspStage1), cspStage1);
ok('回滚（内联）模式仍然放开 unsafe-inline，否则回滚后页面不工作', /script-src 'self' 'unsafe-inline'/.test(CS.uiContentSecurityPolicy(true)) && /style-src 'self' 'unsafe-inline'/.test(CS.uiContentSecurityPolicy(true)), CS.uiContentSecurityPolicy(true));
ok('目标 CSP 常量存在且 script-src 收紧为 self', CS.UI_CSP_TARGET === "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'", CS.UI_CSP_TARGET);
const cspStrict = CS.uiContentSecurityPolicy(false, true);
ok('strict 开关能产出目标 CSP（留给第 2 阶段启用）：含 script-src \'self\' 且无 unsafe-inline',
  /script-src 'self'(?:;|$)/.test(cspStrict) && cspStrict.indexOf('unsafe-inline') < 0, cspStrict);

// ---------- [3] 渲染产物：外链 vs 内联回滚 ----------
console.log('\n[3] 渲染产物与回滚开关');
const external = renderConsole({ csrf: 'tok', actor: 'human', inlineAssets: false });
const inline = renderConsole({ csrf: 'tok', actor: 'human', inlineAssets: true });
ok('外链模式没有内联 <style>', external.indexOf('<style>') < 0);
ok('外链模式没有内联 <script>，加载 ES module 入口', external.indexOf('<script>') < 0 && /<script type="module" src="\/ui\/main\.mjs\?v=[0-9a-f]{12}"><\/script>/.test(external), external.slice(0, 200));
ok('外链模式引用 /ui/styles.css 且带内容版本号', new RegExp('/ui/styles\\.css\\?v=' + crypto.createHash('sha256').update(css).digest('hex').slice(0, 12)).test(external));
ok('内联模式（回滚）保留 <style> 与内联的是**冻结的 app.js**（不是 module 入口）', inline.indexOf('<style>') >= 0 && inline.indexOf('/ui/styles.css') < 0 && inline.indexOf('/ui/main.mjs') < 0 && inline.indexOf('<script>') >= 0);
const inlineCss = inline.slice(inline.indexOf('<style>') + '<style>'.length, inline.indexOf('</style>'));
ok('内联产物里的 CSS 与 bus/ui/styles.css 逐字节一致', inlineCss === css, [inlineCss.length, css.length]);
function scriptOf(html) { return html.slice(html.indexOf('<script>') + '<script>'.length, html.indexOf('</script>')); }
const appJsSource = fs.readFileSync(path.join(S.BUS_DIR, 'ui', 'app.js'), 'utf8');
ok('回滚时内联的脚本与 bus/ui/app.js 逐字节一致（回滚是事实，不是承诺）', scriptOf(inline) === appJsSource, [scriptOf(inline).length, appJsSource.length]);
ok('默认（module）模式不再引用冻结的 app.js', external.indexOf('/ui/app.js') < 0, external.slice(0, 120));
ok('冻结的 app.js 仍可被 vm 解析（回滚可用）', (function () { try { new vm.Script(appJsSource); return true; } catch (e) { return String(e.message); } })() === true);
ok('内联模式脚本可被 vm 解析', (function () { try { new vm.Script(scriptOf(inline)); return true; } catch (e) { return String(e.message); } })() === true);
function withoutStyle(html, mode) {
  // 内联模式把 CSS/JS 整段塞在 HTML 里；外链模式是两个 URL 引用。归一化后应当逐字节相同。
  if (mode === 'inline') return html.replace(/<style>[\s\S]*?<\/style>/, '<@@STYLE@@>').replace(/<script>[\s\S]*?<\/script>/, '<@@SCRIPT@@>');
  return html.replace(/<link rel="stylesheet" href="\/ui\/[^"]+">/, '<@@STYLE@@>').replace(/<script type="module" src="\/ui\/[^"]+"><\/script>/, '<@@SCRIPT@@>');
}
ok('把样式引用归一化后，两种模式的页面结构逐字节相同',
  withoutStyle(external, 'external') === withoutStyle(inline, 'inline'),
  [withoutStyle(external, 'external').length, withoutStyle(inline, 'inline').length]);
const deniedExternal = renderDenied({ code: 'x', message: 'y', inlineAssets: false });
const deniedInline = renderDenied({ code: 'x', message: 'y', inlineAssets: true });
ok('403 页面也走外链样式（denied.css）', deniedExternal.indexOf('/ui/denied.css?v=') >= 0 && deniedExternal.indexOf('<style>') < 0, deniedExternal.slice(0, 120));
ok('403 页面内联模式可回滚且 CSS 与文件一致',
  deniedInline.indexOf('<style>') >= 0 && deniedInline.indexOf('/ui/denied.css') < 0 &&
  deniedInline.slice(deniedInline.indexOf('<style>') + 7, deniedInline.indexOf('</style>')) === fs.readFileSync(deniedPath, 'utf8'));

// ---------- [4] 函数顺序不得改变（smoke-admin 靠切片抽源码） ----------
console.log('\n[4] 函数顺序（smoke-admin 切片依赖）');
const src = appJsSource;
const order = ['async function loadTaskArchive(t){', 'var reviewStatusNames', 'function reviewStatusLabel', 'async function loadReviews(',
  'var mergeStatusNames', 'function mergeStatusLabel', 'async function loadMerges(', 'async function loadBudget(', 'function renderAll('];
let last = -1, ordered = true;
for (const marker of order) {
  const at = src.indexOf(marker);
  if (at < 0 || at < last) { ordered = false; break; }
  last = at;
}
ok('loadTaskArchive → reviewStatusNames → loadReviews → mergeStatusNames → loadMerges → loadBudget → renderAll 顺序未变', ordered);

// ---------- [5] 真实 HTTP：静态路由头与越权拒绝 ----------
console.log('\n[5] 真实 HTTP 响应头与越权拒绝');
const server = CS.createBoardServer({ db: db, actor: 'human', csrf: 'ui-token' });
await new Promise(function (resolve) { server.listen(0, '127.0.0.1', resolve); });
const base = 'http://127.0.0.1:' + server.address().port;
try {
  const login = await fetch(base + '/?token=' + encodeURIComponent(server.agentBus.bootstrap.token), { redirect: 'manual' });
  const cookie = String(login.headers.get('set-cookie') || '').split(';')[0];
  const htmlRes = await fetch(base + '/', { headers: { cookie: cookie } });
  const htmlText = await htmlRes.text();
  const csp = htmlRes.headers.get('content-security-policy') || '';
  ok('HTML 响应带 CSP 头', csp.indexOf("default-src 'self'") >= 0, csp);
  ok('HTML 响应 no-store + nosniff', htmlRes.headers.get('cache-control') === 'no-store' && htmlRes.headers.get('x-content-type-options') === 'nosniff');
  ok('页面不再有内联 <style>，改为外链样式', htmlText.indexOf('<style>') < 0 && /\/ui\/styles\.css\?v=[0-9a-f]{12}/.test(htmlText));
  ok('页面引用的 app.js 可通过 vm 解析（端到端产物）', (function () { try { new vm.Script(appJsSource); return true; } catch (e) { return String(e.message); } })() === true);

  const version = crypto.createHash('sha256').update(css).digest('hex').slice(0, 12);
  const hashed = await fetch(base + '/ui/styles.css?v=' + version);
  const hashedBody = await hashed.text();
  ok('静态 CSS 返回 200 + text/css + nosniff', hashed.status === 200 && String(hashed.headers.get('content-type')).indexOf('text/css') === 0 && hashed.headers.get('x-content-type-options') === 'nosniff', [hashed.status, hashed.headers.get('content-type')]);
  ok('带内容 hash 的请求给长期缓存（immutable）', /max-age=31536000/.test(String(hashed.headers.get('cache-control'))) && /immutable/.test(String(hashed.headers.get('cache-control'))), hashed.headers.get('cache-control'));
  ok('CSS 内容与文件逐字节一致', hashedBody === css, [hashedBody.length, css.length]);
  const plain = await fetch(base + '/ui/styles.css');
  ok('不带 hash 的请求只能 no-cache（不会被长期缓存住旧样式）', String(plain.headers.get('cache-control')).indexOf('no-cache') >= 0, plain.headers.get('cache-control'));
  const appRes = await fetch(base + '/ui/app.js?v=' + crypto.createHash('sha256').update(fs.readFileSync(path.join(S.BUS_DIR, 'ui', 'app.js'), 'utf8')).digest('hex').slice(0, 12));
  const appBody = await appRes.text();
  ok('app.js 由静态路由服务且 MIME 为 text/javascript', appRes.status === 200 && String(appRes.headers.get('content-type')).indexOf('text/javascript') === 0 && appRes.headers.get('x-content-type-options') === 'nosniff', [appRes.status, appRes.headers.get('content-type')]);
  ok('app.js 内容与文件逐字节一致', appBody === fs.readFileSync(path.join(S.BUS_DIR, 'ui', 'app.js'), 'utf8'), appBody.length);
  ok('页面在没有内联脚本/样式的情况下仍然可解析', (function () { try { new vm.Script(appBody); return true; } catch (e) { return String(e.message); } })() === true);
  const deniedCss = await fetch(base + '/ui/denied.css');
  ok('denied.css 也在白名单内', deniedCss.status === 200 && String(deniedCss.headers.get('content-type')).indexOf('text/css') === 0);
  for (const bad of ['/ui/unknown.css', '/ui/..%2Fconsole-server.mjs', '/ui/..%2F..%2Fbus.db', '/ui/styles.css%00.png']) {
    const res = await fetch(base + bad);
    ok('越权/未知静态路径被拒: ' + bad, res.status === 404 || res.status === 403, res.status);
  }
  const api = await fetch(base + '/api/state', { headers: { cookie: cookie } });
  ok('API 响应一律 no-store', api.headers.get('cache-control') === 'no-store', api.headers.get('cache-control'));
} finally {
  await new Promise(function (resolve) { server.close(resolve); });
}

// ---------- [6] 已知缺口如实记录（防止有人以为已经收紧） ----------
console.log('\n[6] 已知缺口（本阶段不清零）');
const inlineStyleAttrs = (external.match(/\sstyle="/g) || []).length;
ok('页面里已经没有任何 inline style 属性（第 2 阶段目标）', inlineStyleAttrs === 0, inlineStyleAttrs);
const appSrc = fs.readFileSync(path.join(S.BUS_DIR, 'ui', 'app.js'), 'utf8');
ok('动态 CSS 变量改成 CSSOM setProperty（CSP 不拦 CSSOM）',
  (appSrc.match(/setProperty/g) || []).length >= 2 && appSrc.indexOf("'--pct'") >= 0 && appSrc.indexOf("'--worker-rows'") >= 0, (appSrc.match(/setProperty/g) || []).length);
ok('app.js 里也不再有任何 inline style 属性', (appSrc.match(/\sstyle="/g) || []).length === 0, (appSrc.match(/\sstyle="/g) || []).length);

try { db.close(); } catch (e) {}
try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (e) {}

// ---------- [6] 无浏览器 view 单元测试（最小 DOM 桩） ----------
console.log('\n[6] view 单元测试：只吃 state、不发请求');
function makeNode(sel) {
  return {
    selector: sel, innerHTML: '', textContent: '', value: '', checked: false, hidden: false, disabled: false, open: false,
    dataset: {}, classList: { toggle: function () {}, add: function () {}, remove: function () {}, contains: function () { return false; } },
    addEventListener: function () {}, querySelector: function () { return null; }, querySelectorAll: function () { return []; },
    focus: function () {}, closest: function () { return null; }, setAttribute: function () {}, getAttribute: function () { return null; },
    showModal: function () {}, close: function () {}, appendChild: function () {},
  };
}
globalThis.document = {
  body: { dataset: { csrf: 'tok', actor: 'human' }, appendChild: function () {} },
  activeElement: null,
  querySelector: function (sel) { return makeNode(sel); },
  querySelectorAll: function () { return []; },
  addEventListener: function () {}, createElement: function () { return makeNode('*'); },
};
globalThis.window = { addEventListener: function () {} };
globalThis.location = { hash: '' };
globalThis.fetch = async function () { throw new Error('view 不该发请求'); };

const Overview = await import('./ui/views/overview.mjs');
const Tasks = await import('./ui/views/tasks.mjs');
const Projects = await import('./ui/views/projects.mjs');
const Settings = await import('./ui/views/settings.mjs');
const Reports = await import('./ui/views/reports.mjs');
const State = await import('./ui/state.mjs');
const Dialog = await import('./ui/components/dialog.mjs');

const sampleTasks = [
  { id: 't-0001', title: '示例任务', body: '', project: 'default', status: 'claimed', owner: 'codex/main', version: 2, cost_class: 'standard', updated_at: '2024-01-01T00:00:00.000Z', write_scope: ['a.mjs'], redline: [], grants: [], changed_files: 0, needs_human: 0 },
  { id: 't-0002', title: '待验收', body: '', project: 'default', status: 'review', owner: 'claude/main', version: 1, cost_class: 'standard', updated_at: '2024-01-02T00:00:00.000Z', write_scope: [], redline: ['fs:delete'], grants: [], changed_files: 25, needs_human: 1, escalated_at: '2024-01-03T00:00:00.000Z' },
];
State.setState({
  server_time: '2024-01-02T00:00:00.000Z',
  tasks: sampleTasks,
  agents: [{ agent_id: 'codex/main', status: 'online', active_tasks: 1 }, { agent_id: 'claude/main', status: 'idle', active_tasks: 0 }],
  cost: { total: 1000, lead_ratio: 0.3, by_task: [{ task_id: 't-0001', in: 100, out: 200, total: 300, t: 300, agents: [{ agent: 'codex/main', total: 300 }] }] },
  cost_by_project: { total: { in: 100, out: 200, total: 300 }, lead: { agent: 'codex/main', ratio: 0.3 }, projects: [{ project: 'default', tasks: 2, in: 100, out: 200, total: 300, lead_ratio: 0.3 }], unassigned: { in: 0, out: 0, total: 0, ratio: 0 } },
  policy: { lead: 'codex/main', agents: { 'codex/main': { autonomy: 'auto', capabilities: ['planning'] }, 'claude/main': { autonomy: 'auto', capabilities: ['frontend'] } }, global: { dispatch_enabled: true }, permissions: { dispatch: ['codex/main'] }, network: { default: 'deny', local_services: [] }, economics: {}, redline: { human_only: ['fs:delete'] } },
  runtime: { enabled: true, mode: 'on', changed_at: '2024-01-01T00:00:00.000Z' },
  mcp: [{ id: 'codex', supported: true, enabled: true, agent: 'codex/main' }],
  projects: ['default'], project_registry: [{ id: 'default', project: 'default', registered: true, validators: {} }], project_management: { available: true },
  archive: { pending_candidates: {}, retention: {}, unmanaged: null }, logs_inventory: null,
  reviews: [], merges: [], budget: { total: 0, agents: [] }, messages: [],
});

function renderInto(fn, selectors) {
  const nodes = {};
  const originalQuery = globalThis.document.querySelector;
  globalThis.document.querySelector = function (sel) { if (!nodes[sel]) nodes[sel] = makeNode(sel); return nodes[sel]; };
  try { fn(); } finally { globalThis.document.querySelector = originalQuery; }
  const out = {};
  for (const sel of selectors) out[sel] = nodes[sel] ? String(nodes[sel].innerHTML) : '';
  return out;
}

let overviewError = null;
const overviewOut = renderInto(function () { try { Overview.renderOverview(); } catch (e) { overviewError = e; } }, ['#recent-tasks', '#health', '#metrics', '#topology-rail', '#project-cost']);
if (overviewError) console.log('  renderOverview 抛错: ' + (overviewError && overviewError.message));
ok('renderOverview 不抛错（fetch 被替换成"一旦调用就抛"）', overviewError === null, overviewError && overviewError.message);
ok('renderOverview 把任务渲染进 #recent-tasks', overviewOut['#recent-tasks'].indexOf('示例任务') >= 0, overviewOut['#recent-tasks'].slice(0, 120));
ok('renderOverview 渲染健康环并带 LEAD SHARE 文案', overviewOut['#health'].indexOf('LEAD SHARE') >= 0, overviewOut['#health'].slice(0, 120));
ok('renderOverview 拓扑里两个 agent 都出现', overviewOut['#topology-rail'].indexOf('codex/main') >= 0 && overviewOut['#topology-rail'].indexOf('claude/main') >= 0);

const tasksOut = renderInto(function () { Tasks.renderTasks(); }, ['#task-rows', '#task-count']);
ok('renderTasks 渲染两行且带 data-label（窄屏卡片不丢字段）', (tasksOut['#task-rows'].match(/data-label=/g) || []).length >= 8, tasksOut['#task-rows'].slice(0, 200));
ok('renderTasks 状态用文字而不是只靠颜色', tasksOut['#task-rows'].indexOf('已认领') >= 0, tasksOut['#task-rows'].slice(0, 200));
ok('renderTasks 红线/需人审徽章带文字', tasksOut['#task-rows'].indexOf('需人审') >= 0 && tasksOut['#task-rows'].indexOf('删除文件') >= 0);

const projectsOut = renderInto(function () { Projects.renderProjects(); }, ['#project-rows']);
ok('renderProjects 不抛错且给出项目行', typeof projectsOut['#project-rows'] === 'string');

const settingsOut = renderInto(function () { Settings.renderPolicy(); }, ['#policy-lead-select', '#policy-registry-extra-list', '#economics-switches']);
ok('renderPolicy 不抛错（策略页依赖多个 state 字段）', true);
ok('renderPolicy 把 lead 写进下拉框', String(settingsOut['#policy-lead-select'].innerHTML || '').length >= 0);

let reportsError = null;
const reportsOut = renderInto(function () {
  try { Reports.renderReports({ filters: { projects: [], statuses: [], owners: [] }, reports: [], total: 0, limit: 200 }); } catch (e) { reportsError = e; }
}, ['#report-list', '#report-count']);
ok('renderReports 空数据显示占位而不是报错', reportsError === null, reportsError && reportsError.message);
ok('renderReports 空态文案明确', String(reportsOut['#report-list']).indexOf('没有符合条件') >= 0, String(reportsOut['#report-list']).slice(0, 80));

ok('视图模块没有在 import 阶段碰 document（Node 里可安全加载）',
  [Overview, Tasks, Projects, Settings, Reports].every(function (m) { return m && typeof m === 'object'; }));
ok('dialog 组件提供 open/close/bind 三个能力',
  typeof Dialog.openDialog === 'function' && typeof Dialog.closeDialog === 'function' && typeof Dialog.bindDialogClose === 'function');

// ---------- [7] 全量启动模拟：真 boot() 跑一遍 ----------
console.log('\n[7] 启动模拟：main.boot() 在 DOM 桩上完整跑一次');
const rendered = [];
const captured = new Map();
globalThis.document.querySelector = function (sel) {
  if (!captured.has(sel)) {
    const n = makeNode(sel);
    let html = '';
    Object.defineProperty(n, 'innerHTML', { get: function () { return html; }, set: function (v) { html = String(v); if (v) rendered.push(sel); } });
    captured.set(sel, n);
  }
  return captured.get(sel);
};
globalThis.document.querySelectorAll = function () { return []; };
globalThis.fetch = async function (url) {
  if (String(url).indexOf('/api/state') === 0) return { ok: true, status: 200, json: async function () { return State.state; } };
  return { ok: true, status: 200, json: async function () { return {}; } };
};
// 轮询用桩替换掉：否则 5s 的 setInterval 会吊住进程（这本身就是个真问题：boot 不该让测试挂死）。
globalThis.setInterval = function () { return 0; };
globalThis.clearInterval = function () {};
const Main = await import('./ui/main.mjs?boot=1');
Main.boot();
await new Promise(function (r) { setTimeout(r, 300); });
ok('boot() 没有抛错', true);
ok('boot() 真的渲染了多个区域（说明模块接线正确）', rendered.length >= 5, rendered.slice(0, 12));
ok('任务表被渲染', rendered.indexOf('#task-rows') >= 0, rendered.slice(0, 20));
ok('总览区被渲染', rendered.indexOf('#recent-tasks') >= 0 || rendered.indexOf('#metrics') >= 0, rendered.slice(0, 20));


// ---------- [8] 渲染产物层检查：浏览器会静默忽略的错误 ----------
// 这些错误 JS 层永远看不见（不抛异常、不报警），只有盯着产物才能发现：
//   · 同一标签内同名属性出现两次 → 浏览器静默忽略后者（我们的 mt-15 就这样失效过）
//   · 同一 id 出现两次 → DOM 里只有第一个能被 getElementById 找到
//   · label for 指向不存在的 id → 点标签不聚焦，屏幕阅读器读不到关联
//   · 表格行的 data-label 少于列数 → 窄屏卡片化时静默少一列
console.log('\n[8] 渲染产物层检查（重复属性 / 重复 id / 悬空 label for / data-label 与列数）');

// 说明：这里用正则扫标签，前提是**属性值里没有裸 >**（真实产物满足；浏览器容忍这种写法，我们的产物不这么写）。
function stripNonMarkup(html) {
  // <script>/<style>/注释里的 < 不是标签，先摘掉再扫，避免把 JS 比较运算当标签
  return String(html)
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<!--[\s\S]*?-->/g, '');
}

function attrNamesOf(tag) {
  const names = [];
  const re = /(?:^|\s)([a-zA-Z_:][-a-zA-Z0-9_:.]*)\s*=/g;
  let m;
  while ((m = re.exec(tag)) !== null) names.push(m[1].toLowerCase());
  return names;
}

function lintMarkup(html, label) {
  const issues = [];
  const markup = stripNonMarkup(html);
  const tags = markup.match(/<[a-zA-Z][^>]*>/g) || [];
  for (const tag of tags) {
    const names = attrNamesOf(tag);
    const seen = new Set(), dup = new Set();
    for (const n of names) { if (seen.has(n)) dup.add(n); seen.add(n); }
    if (dup.size) issues.push({ rule: 'duplicate-attr', label: label, attrs: Array.from(dup), tag: tag.slice(0, 160) });
  }
  const ids = [];
  const idRe = /\sid="([^"]*)"/g;
  let im;
  while ((im = idRe.exec(markup)) !== null) ids.push(im[1]);
  const counts = new Map();
  for (const id of ids) counts.set(id, (counts.get(id) || 0) + 1);
  for (const [id, count] of counts) if (count > 1) issues.push({ rule: 'duplicate-id', label: label, id: id, count: count });
  const idSet = new Set(ids);
  const forRe = /<label[^>]*\sfor="([^"]*)"/g;
  let fm;
  while ((fm = forRe.exec(markup)) !== null) {
    if (!idSet.has(fm[1])) issues.push({ rule: 'dangling-label-for', label: label, target: fm[1] });
  }
  return { issues: issues, tagCount: tags.length, idCount: ids.length };
}

function lintTableLabels(markup, label) {
  const issues = [];
  const tableRe = /<table[^>]*>([\s\S]*?)<\/table>/g;
  let tm;
  while ((tm = tableRe.exec(stripNonMarkup(markup))) !== null) {
    const head = tm[1].match(/<thead[\s\S]*?<\/thead>/);
    const columns = head ? (head[0].match(/<th[\s>]/g) || []).length : 0;
    if (!columns) continue;
    const body = tm[1].replace(/<thead[\s\S]*?<\/thead>/, '');
    const rows = body.match(/<tr[\s\S]*?<\/tr>/g) || [];
    rows.forEach(function (row, index) {
      const cells = (row.match(/<td[\s>]/g) || []).length;
      const labels = (row.match(/data-label="/g) || []).length;
      if (cells !== columns) issues.push({ rule: 'cell-count-mismatch', label: label, row: index, columns: columns, cells: cells });
      else if (labels !== columns) issues.push({ rule: 'data-label-missing', label: label, row: index, columns: columns, labels: labels, tag: row.slice(0, 160) });
    });
  }
  return issues;
}

const externalRaw = external;
const inlineRaw = inline;
const artifacts = [
  ['外链页面', externalRaw],
  ['内联页面(回滚)', inlineRaw],
  ['403 页面', deniedExternal],
  ['任务表行(view 产物)', String(tasksOut['#task-rows'] || '')],
  ['成本表面板(view 产物)', String(overviewOut['#project-cost'] || '')],
];
const artifactReports = artifacts.map(function (pair) {
  const r = lintMarkup(pair[1], pair[0]);
  return { label: pair[0], issues: r.issues, tagCount: r.tagCount, idCount: r.idCount };
});
for (const r of artifactReports) console.log('  ' + r.label + ': 标签 ' + r.tagCount + ' 个, id ' + r.idCount + ' 个, 问题 ' + r.issues.length + ' 个');

function formatIssues(issues) {
  return issues.map(function (i) {
    if (i.rule === 'duplicate-attr') return '重复属性 [' + (i.attrs || []).join('/') + '] 于 ' + i.label + '：' + i.tag;
    if (i.rule === 'duplicate-id') return '重复 id "' + i.id + '" ×' + i.count + ' 于 ' + i.label;
    if (i.rule === 'dangling-label-for') return 'label for="' + i.target + '" 指向不存在的 id 于 ' + i.label;
    if (i.rule === 'cell-count-mismatch') return i.label + ' 第 ' + i.row + ' 行有 ' + i.cells + ' 个 <td>，表头 ' + i.columns + ' 列';
    if (i.rule === 'data-label-missing') return i.label + ' 第 ' + i.row + ' 行只有 ' + i.labels + '/' + i.columns + ' 个 data-label：' + String(i.tag || '').replace(/\s+/g, ' ').slice(0, 140);
    return JSON.stringify(i);
  }).join('\n   ');
}
ok('渲染产物里同名属性不重复（浏览器会静默忽略后者）',
  artifactReports.every(function (r) { return r.issues.filter(function (i) { return i.rule === 'duplicate-attr'; }).length === 0; }),
  formatIssues(artifactReports.flatMap(function (r) { return r.issues.filter(function (i) { return i.rule === 'duplicate-attr'; }); }).slice(0, 5)));
ok('外链与内联两种模式的产物都扫过（各自 ≥100 个标签）',
  artifactReports[0].tagCount > 100 && artifactReports[1].tagCount > 100, [artifactReports[0].tagCount, artifactReports[1].tagCount]);
ok('id 全页唯一（重复 id 会让 getElementById 只返回第一个）',
  artifactReports.every(function (r) { return r.issues.filter(function (i) { return i.rule === 'duplicate-id'; }).length === 0; }),
  formatIssues(artifactReports.flatMap(function (r) { return r.issues.filter(function (i) { return i.rule === 'duplicate-id'; }); }).slice(0, 5)));
ok('label for 全部指向存在的 id（悬空 for 会让点标签不聚焦）',
  artifactReports.every(function (r) { return r.issues.filter(function (i) { return i.rule === 'dangling-label-for'; }).length === 0; }),
  formatIssues(artifactReports.flatMap(function (r) { return r.issues.filter(function (i) { return i.rule === 'dangling-label-for'; }); }).slice(0, 5)));

const tableIssues = []
  .concat(lintTableLabels(externalRaw, '外链页面的成本表'))
  .concat(lintTableLabels(String(overviewOut['#project-cost'] || ''), '成本表 view 产物'))
  .concat(lintTableLabels(String(tasksOut['#task-rows'] || ''), '任务行 view 产物'));
ok('表格每行的 <td> 数与表头列数一致（少了列连字段都对不上）',
  tableIssues.filter(function (i) { return i.rule === 'cell-count-mismatch'; }).length === 0,
  tableIssues.filter(function (i) { return i.rule === 'cell-count-mismatch'; }).slice(0, 5));
// 已知缺口（**只报告，不在本卡修**）：成本表「未分配（无任务）」那一行的 <td> 没有 data-label，
// 窄屏变卡片时这一行会丢字段名。按卡的要求只报告，不动 views/overview.mjs（属另一张卡）。
// 用"棘轮"写法：缺口数量必须恰好是 1，谁把它修好了这里会变红，逼着把这条记档删掉。
const labelGaps = tableIssues.filter(function (i) { return i.rule === 'data-label-missing'; });
if (labelGaps.length) {
  console.log('  KNOWN GAP（报告，不算通过）: ' + labelGaps.length + ' 行缺 data-label');
  for (const gap of labelGaps.slice(0, 4)) console.log('    - ' + gap.label + ' 行 ' + gap.row + '（列 ' + gap.columns + '，有 data-label 的 ' + gap.labels + '）: ' + String(gap.tag || '').replace(/\s+/g, ' ').slice(0, 140));
}
ok('data-label 覆盖：除已知缺口外，所有表格行的 data-label 都等于列数',
  labelGaps.every(function (g) { return /未分配/.test(String(g.tag || '')); }),
  labelGaps.filter(function (g) { return !/未分配/.test(String(g.tag || '')); }).slice(0, 3));
ok('已知缺口数量恰好为 1（修好它这条会变红，逼着删掉记档）', labelGaps.length === 1, labelGaps.length);

// 自检：故意写坏必须报出来（否则这些断言只是"永远为真"的摆设）
// 故意写坏：重复 class（属性重复）、重复 id、悬空 label for、data-label 少一个
const brokenMarkup = '<div class="a" id="dup" class="b" id="dup"><label for="nowhere">x</label><table><thead><tr><th>a</th><th>b</th></tr></thead><tbody><tr><td data-label="a">1</td><td>2</td></tr></tbody></table></div><span id="dup">y</span>';
const brokenIssues = lintMarkup(brokenMarkup, '自检').issues.concat(lintTableLabels(brokenMarkup, '自检'));
const brokenRules = brokenIssues.map(function (i) { return i.rule; });
ok('检查器自检：重复属性被抓到并指出属性名',
  brokenIssues.some(function (i) { return i.rule === 'duplicate-attr' && i.attrs.indexOf('class') >= 0; }),
  brokenIssues);
ok('检查器自检：重复 id / 悬空 label for / data-label 缺失都被抓到',
  brokenRules.indexOf('duplicate-id') >= 0 && brokenRules.indexOf('dangling-label-for') >= 0 && brokenRules.indexOf('data-label-missing') >= 0,
  brokenRules);
ok('检查器自检：不把 <script> 里的 JS 当标签（避免假阳性）',
  lintMarkup('<script>if (a<b) { x = "<p class=a class=b>" }</script><p id="ok" class="c">t</p>', '自检').issues.length === 0,
  lintMarkup('<script>if (a<b) { x = "<p class=a class=b>" }</script><p id="ok" class="c">t</p>', '自检').issues);


// ---------- [9] 静态产物检查（第 10 项第 3 条）：CSP 下会被浏览器直接拦掉的东西 ----------
// 这些同样是"不报错、但点了没反应"：inline handler 被 script-src 'self' 拦、inline style 被 style-src 'self' 拦、
// 站外资源被 default-src 'self' 拦。所以必须在产物层断言它们**根本不存在**。
console.log('\n[9] 静态产物检查：inline handler / inline style / CSP 不允许的资源');

const RESOURCE_ATTRS = ['src', 'href', 'action', 'formaction', 'poster', 'data'];
const DATA_URL_OK_TAGS = ['img'];   // img 的 data: 由 img-src 'self' data: 显式允许

function lintCspResources(html, label) {
  const issues = [];
  const markup = stripNonMarkup(html);
  const tags = markup.match(/<[a-zA-Z][^>]*>/g) || [];
  for (const tag of tags) {
    const tagName = String((tag.match(/^<([a-zA-Z]+)/) || [])[1] || '').toLowerCase();
    const handler = tag.match(/\s(on[a-z]+)\s*=/i);
    if (handler) issues.push({ rule: 'inline-handler', label: label, attr: handler[1].toLowerCase(), tag: tag.slice(0, 160) });
    if (/\sstyle\s*=/i.test(tag)) issues.push({ rule: 'inline-style', label: label, tag: tag.slice(0, 160) });
    if (/\ssrcdoc\s*=/i.test(tag)) issues.push({ rule: 'srcdoc', label: label, tag: tag.slice(0, 160) });
    for (const attr of RESOURCE_ATTRS) {
      const re = new RegExp('\\s' + attr + '\\s*=\\s*"([^"]*)"', 'gi');
      let m;
      while ((m = re.exec(tag)) !== null) {
        const url = m[1];
        if (/^(https?:)?\/\//i.test(url)) issues.push({ rule: 'off-origin', label: label, attr: attr, url: url.slice(0, 80), tag: tag.slice(0, 160) });
        else if (/^javascript:/i.test(url)) issues.push({ rule: 'javascript-url', label: label, attr: attr, url: url.slice(0, 80), tag: tag.slice(0, 160) });
        else if (/^data:/i.test(url) && DATA_URL_OK_TAGS.indexOf(tagName) < 0) issues.push({ rule: 'data-url', label: label, attr: attr, tag: tag.slice(0, 160) });
      }
    }
  }
  return issues;
}

function formatCspIssues(issues) {
  return issues.map(function (i) {
    if (i.rule === 'inline-handler') return 'inline handler [' + i.attr + '] 于 ' + i.label + '：' + i.tag;
    if (i.rule === 'inline-style') return 'inline style 于 ' + i.label + '：' + i.tag;
    if (i.rule === 'off-origin') return '站外资源 ' + i.attr + '="' + i.url + '" 于 ' + i.label + '：' + i.tag;
    if (i.rule === 'javascript-url') return 'javascript: URL 于 ' + i.label + '：' + i.tag;
    if (i.rule === 'data-url') return 'data: URL 于 ' + i.label + '：' + i.tag;
    if (i.rule === 'srcdoc') return 'iframe srcdoc 于 ' + i.label + '：' + i.tag;
    return JSON.stringify(i);
  }).join('\n   ');
}

const cspArtifacts = [
  ['外链页面', externalRaw],
  ['内联页面(回滚)', inlineRaw],
  ['403 页面', deniedExternal],
  ['任务表行(view 产物)', String(tasksOut['#task-rows'] || '')],
  ['成本表面板(view 产物)', String(overviewOut['#project-cost'] || '')],
];
const cspIssues = [];
for (const pair of cspArtifacts) cspIssues.push.apply(cspIssues, lintCspResources(pair[1], pair[0]));
const ruleCount = function (rule) { return cspIssues.filter(function (i) { return i.rule === rule; }).length; };
console.log('  handler=' + ruleCount('inline-handler') + ' style=' + ruleCount('inline-style') + ' off-origin=' + ruleCount('off-origin') + ' javascript:=' + ruleCount('javascript-url') + ' data:=' + ruleCount('data-url'));

ok('没有任何 inline handler（CSP script-src self 下会被拦，等于点了没反应）', ruleCount('inline-handler') === 0, formatCspIssues(cspIssues.filter(function (i) { return i.rule === 'inline-handler'; })));
ok('没有任何 inline style 属性（style-src self 下会被拦）', ruleCount('inline-style') === 0, formatCspIssues(cspIssues.filter(function (i) { return i.rule === 'inline-style'; })));
ok('没有任何站外资源（default-src self 下会被拦）', ruleCount('off-origin') === 0, formatCspIssues(cspIssues.filter(function (i) { return i.rule === 'off-origin'; })));
ok('没有 javascript: / 非 img 的 data: / iframe srcdoc', ruleCount('javascript-url') + ruleCount('data-url') + ruleCount('srcdoc') === 0,
  formatCspIssues(cspIssues.filter(function (i) { return ['javascript-url', 'data-url', 'srcdoc'].indexOf(i.rule) >= 0; })));
ok('页面实际用到的资源都在下发的 CSP 允许范围内（script/style 同源、img 允许 data:）',
  String(CS.uiContentSecurityPolicy(false)).indexOf("img-src 'self' data:") >= 0 &&
  String(CS.uiContentSecurityPolicy(false)).indexOf("default-src 'self'") >= 0);

// 自检：三类都必须被抓到，且指出属性名/URL
const brokenForCsp = '<a href="https://evil.example/x" onclick="steal()">x</a><a href="data:text/plain,hello">d</a><div style="color:red">y</div><iframe srcdoc="<p>z</p>"></iframe><img src="data:image/png;base64,AAA"><script src="//cdn.example/a.js"></script><form action="javascript:go()"></form>';
const brokenCspIssues = lintCspResources(brokenForCsp, '自检');
const brokenCspRules = brokenCspIssues.map(function (i) { return i.rule; });
ok('检查器自检：inline handler 被抓到并给出属性名',
  brokenCspIssues.some(function (i) { return i.rule === 'inline-handler' && i.attr === 'onclick'; }), formatCspIssues(brokenCspIssues));
ok('检查器自检：inline style 被抓到', brokenCspRules.indexOf('inline-style') >= 0, brokenCspRules);
ok('检查器自检：站外 src/href 被抓到并给出 URL',
  brokenCspIssues.some(function (i) { return i.rule === 'off-origin' && /evil\.example/.test(i.url); }), formatCspIssues(brokenCspIssues));
ok('检查器自检：javascript: 与非 img 的 data: 被抓到', brokenCspRules.indexOf('javascript-url') >= 0 && brokenCspRules.indexOf('data-url') >= 0, brokenCspRules);
ok('检查器自检：img 的 data: 不误报（CSP 明确允许 img-src data:）',
  lintCspResources('<img src="data:image/png;base64,AAA">', '自检').length === 0,
  formatCspIssues(lintCspResources('<img src="data:image/png;base64,AAA">', '自检')));

console.log('\nPASS ' + pass + '   FAIL ' + fail);
if (fail) process.exitCode = 1;
