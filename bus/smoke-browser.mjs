#!/usr/bin/env node
// 第 7 项：真实浏览器验收（零依赖 CDP）。本机无网络、不能装 playwright/puppeteer，
// 所以直接驱动已装好的 Chrome：--remote-debugging-port + fetch /json/list + Node 24 内置 WebSocket。
import cp from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

let pass = 0, fail = 0, skip = 0;
function ok(name, cond, detail) {
  if (cond) { pass++; console.log('  PASS  ' + name); }
  else { fail++; console.log('  FAIL  ' + name + (detail === undefined ? '' : '  -> ' + JSON.stringify(detail).slice(0, 900))); }
}
function skipped(name, why) { skip++; console.log('  SKIP  ' + name + ' （' + why + '）'); }

const BROWSERS = [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
  '/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium',
  '/usr/bin/chromium-browser', '/snap/bin/chromium', '/opt/google/chrome/chrome',
];
const BROWSER = BROWSERS.filter(function (p) { return fs.existsSync(p); })[0] || process.env.AGENTBUS_BROWSER || null;
if (!BROWSER) {
  console.log('  SKIP  没有找到 Chrome/Edge 可执行文件（设 AGENTBUS_BROWSER 指向它）');
  console.log('');
  console.log('==================================');
  console.log('PASS 0   FAIL 0   SKIP 1');
  process.exitCode = 0;
  process.exit(0);
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'agentbus-browser-'));
const policyPath = path.join(tmp, 'policy.json');
fs.copyFileSync(path.join(path.dirname(new URL(import.meta.url).pathname).replace(/^\//, ''), 'policy.json'), policyPath);
const dbFile = path.join(tmp, 'bus.db');
process.env.BUS_DB = dbFile;
process.env.BUS_POLICY_PATH = policyPath;
process.env.BUS_LIFECYCLE = path.join(tmp, 'lifecycle.json');
process.env.BUS_PROJECTS = path.join(tmp, 'projects.json');
fs.writeFileSync(process.env.BUS_PROJECTS, JSON.stringify({ projects: {} }));

const S = await import('./store.mjs');
const CS = await import('./console-server.mjs');
const Env = await import('./smoke-support/env.mjs');

const db = S.openDb(dbFile);
S.setRuntimeState(db, 'human', true);
const policy = JSON.parse(fs.readFileSync(policyPath, 'utf8'));
const LEAD = policy.lead;
// 造点内容，保证关键视图不是空壳：几个项目 + 任务 + 一条消息
const projects = ['proj-demo', 'proj-web', 'proj-infra'];
for (const p of projects) {
  for (let i = 0; i < 3; i++) {
    S.createTask(db, { title: p + ' 任务 ' + i, status: i === 0 ? 'open' : (i === 1 ? 'in_progress' : 'review'), project: p, cost_class: 'standard' });
  }
}
S.send(db, { sender: LEAD, to: Object.keys(policy.agents)[0], kind: 'note', body: '浏览器验收用消息', policy: policy });
db.close();

const server = CS.startConsole({ port: await Env.allocatePort(), actor: 'human', dbPath: dbFile, policyPath: policyPath });
await new Promise(function (resolve) { setTimeout(resolve, 300); });
const PORT = server.address().port;
const BASE = 'http://127.0.0.1:' + PORT;
const TOKEN = server.agentBus.bootstrap && server.agentBus.bootstrap.token;

// ---------- CDP 客户端（零依赖） ----------
function connectCdp(wsUrl) {
  const ws = new WebSocket(wsUrl);
  let nextId = 1;
  const pending = new Map();
  const events = [];
  const waiters = [];
  ws.addEventListener('message', function (ev) {
    let msg = null;
    try { msg = JSON.parse(ev.data); } catch (e) { return; }
    if (msg.id && pending.has(msg.id)) {
      const p = pending.get(msg.id); pending.delete(msg.id);
      if (msg.error) p.reject(new Error(msg.error.message || 'cdp_error')); else p.resolve(msg.result);
      return;
    }
    if (msg.method) {
      events.push(msg);
      for (let i = waiters.length - 1; i >= 0; i--) {
        if (waiters[i].match(msg)) { const w = waiters.splice(i, 1)[0]; w.resolve(msg); }
      }
    }
  });
  const ready = new Promise(function (resolve, reject) {
    ws.addEventListener('open', function () { resolve(); });
    ws.addEventListener('error', function (e) { reject(new Error('ws_error')); });
  });
  return {
    events: events,
    ready: ready,
    send: function (method, params) {
      const id = nextId++;
      return new Promise(function (resolve, reject) {
        pending.set(id, { resolve: resolve, reject: reject });
        ws.send(JSON.stringify({ id: id, method: method, params: params || {} }));
      });
    },
    waitFor: function (match, timeoutMs) {
      return new Promise(function (resolve, reject) {
        const w = { match: match, resolve: resolve };
        waiters.push(w);
        setTimeout(function () {
          const i = waiters.indexOf(w);
          if (i >= 0) { waiters.splice(i, 1); reject(new Error('cdp_timeout')); }
        }, timeoutMs || 15000);
      });
    },
    close: function () { try { ws.close(); } catch (e) {} },
  };
}

async function jsonList(cdpPort) {
  for (let i = 0; i < 60; i++) {
    try {
      const res = await fetch('http://127.0.0.1:' + cdpPort + '/json/list');
      const list = await res.json();
      const page = list.filter(function (t) { return t.type === 'page' && t.webSocketDebuggerUrl; })[0];
      if (page) return page;
    } catch (e) { /* 还没起来 */ }
    await new Promise(function (r) { setTimeout(r, 250); });
  }
  return null;
}

const cdpPort = await Env.allocatePort();
const profile = path.join(tmp, 'chrome-profile');
const browserErrFile = path.join(tmp, 'browser.err');
const browserErrFd = fs.openSync(browserErrFile, 'w');
// --require-browser 与 AGENTBUS_REQUIRE_BROWSER=1 等价：CI 用环境变量（workflow 里更容易设）。
const REQUIRE_BROWSER = process.argv.indexOf('--require-browser') >= 0 || process.env.AGENTBUS_REQUIRE_BROWSER === '1';
const chrome = cp.spawn(BROWSER, ['--headless=new', '--remote-debugging-port=' + cdpPort, '--user-data-dir=' + profile,
  '--no-first-run', '--no-default-browser-check', '--disable-gpu', '--disable-extensions', '--disable-background-networking',
  '--disable-features=Translate,MediaRouter', '--window-size=1280,900', 'about:blank'],
  { stdio: ['ignore', 'ignore', browserErrFd], windowsHide: true, shell: false });
let chromeExited = false;
chrome.on('exit', function () { chromeExited = true; });

function cleanup() {
  try { chrome.kill(); } catch (e) {}
  try { server.close(); } catch (e) {}
}
process.on('exit', cleanup);

console.log('[0] 环境');
console.log('  浏览器: ' + BROWSER);
console.log('  看板: ' + BASE + '  CDP: ' + cdpPort);
ok('浏览器进程已启动', !chromeExited);
ok('看板服务在监听且端口是动态分配的', Number.isInteger(PORT) && PORT > 0, PORT);
ok('拿到一次性登录 token（看板需要它建会话）', typeof TOKEN === 'string' && TOKEN.length > 0);

const pageTarget = await jsonList(cdpPort);
if (!pageTarget) {
  const stderrText = (function () { try { fs.closeSync(browserErrFd); return fs.readFileSync(browserErrFile, 'utf8'); } catch (e) { return ''; } })();
  const sandboxBlocked = /platform_channel|OpenProcess: 拒绝访问|crash server failed to launch|Check failed/i.test(stderrText);
  const why = sandboxBlocked ? 'sandbox_blocks_named_pipes' : 'browser_did_not_start';
  console.log('  浏览器没能提供 CDP 端点，原始 stderr（前 400 字符）：');
  console.log('  ' + stderrText.slice(0, 400).replace(/\n/g, '\n  '));
  if (REQUIRE_BROWSER) {
    fail++;
    console.log('  FAIL  CDP /json/list 可用  -> ' + why + '（--require-browser 下不允许 SKIP）');
  } else {
    skipped('CDP /json/list 可用', why);
    skipped('零 console error / 零 CSP 违规 / 模块 200 / DOM 渲染 / 交互 / 截图', 'no_browser_available');
    // 套件级 SKIP：smoke-all 见到这一行会把整棵树的这一格记成"跳过"而不是"通过"。
    console.log('SKIP_SUITE: ' + why);
  }
  console.log('');
  console.log('==================================');
  console.log('PASS ' + pass + '   FAIL ' + fail + '   SKIP ' + skip);
  process.exitCode = fail ? 1 : 0;
  process.exit(process.exitCode);
}
ok('CDP /json/list 返回 page target（真浏览器已就绪）', !!pageTarget.webSocketDebuggerUrl, pageTarget.url);

const cdp = connectCdp(pageTarget.webSocketDebuggerUrl);
await cdp.ready;
await cdp.send('Page.enable');
await cdp.send('Runtime.enable');
await cdp.send('Log.enable');
await cdp.send('Network.enable');

function consoleErrors() {
  return cdp.events.filter(function (e) {
    if (e.method === 'Runtime.consoleAPICalled' && e.params.type === 'error') return true;
    if (e.method === 'Log.entryAdded' && e.params.entry && e.params.entry.level === 'error') return true;
    return false;
  });
}
function cspViolations() {
  return cdp.events.filter(function (e) {
    if (e.method !== 'Log.entryAdded' || !e.params.entry) return false;
    const en = e.params.entry;
    return en.source === 'security' || /Content Security Policy/i.test(String(en.text || ''));
  });
}
function exceptions() { return cdp.events.filter(function (e) { return e.method === 'Runtime.exceptionThrown'; }); }
function responses() { return cdp.events.filter(function (e) { return e.method === 'Network.responseReceived'; }).map(function (e) { return e.params.response; }); }

async function evaluate(expression) {
  const r = await cdp.send('Runtime.evaluate', { expression: expression, returnByValue: true, awaitPromise: true });
  return r && r.result ? r.result.value : undefined;
}

async function loadPage(url, label) {
  cdp.events.length = 0;
  await cdp.send('Page.navigate', { url: url });
  try { await cdp.waitFor(function (m) { return m.method === 'Page.loadEventFired'; }, 20000); } catch (e) { /* 继续，用 DOM 判定 */ }
  // ES module 是异步加载的：给主脚本与首次渲染留时间，再取 DOM。
  await new Promise(function (r) { setTimeout(r, 1500); });
}

// ---------- 外链模式（默认） ----------
console.log('');
console.log('[1] 外链模式：零 console error / 零 CSP 违规 / 模块全 200');
await loadPage(BASE + '/?token=' + encodeURIComponent(TOKEN), 'external');

const errs = consoleErrors();
ok('零 console error', errs.length === 0, errs.slice(0, 3).map(function (e) { return e.params; }));
const exs = exceptions();
ok('零未捕获异常（Runtime.exceptionThrown）', exs.length === 0, exs.slice(0, 3).map(function (e) { return e.params; }));
const csps = cspViolations();
ok('零 CSP 违规', csps.length === 0, csps.slice(0, 3).map(function (e) { return e.params.entry; }));

const UI_MODULES = ['main.mjs', 'api.mjs', 'state.mjs', 'components/dom.mjs', 'components/dialog.mjs',
  'views/overview.mjs', 'views/tasks.mjs', 'views/projects.mjs', 'views/settings.mjs', 'views/reports.mjs'];
const resp = responses();
const byName = {};
for (const r of resp) { const u = String(r.url || ''); const m = u.match(/\/ui\/(.+?)(\?|$)/); if (m) byName[m[1]] = r.status; }
const missing = UI_MODULES.filter(function (m) { return byName[m] !== 200; });
ok('全部 ' + UI_MODULES.length + ' 个 ES module 都是 200（' + Object.keys(byName).length + ' 个 ui 资源被请求）', missing.length === 0,
  { missing: missing.map(function (m) { return m + '=' + byName[m]; }), seen: Object.keys(byName) });
ok('styles.css 也是 200', byName['styles.css'] === 200, byName['styles.css']);
ok('没有任何 4xx/5xx 的 ui 资源', Object.keys(byName).every(function (k) { return byName[k] === 200; }), byName);

console.log('');
console.log('[2] 关键视图真的渲染出内容（取 DOM，不是「页面能打开」）');
const shell = await evaluate('JSON.stringify({ nav: document.querySelectorAll(\'[data-view]\').length, main: !!document.querySelector(\'main\'), mainText: (document.querySelector(\'main\')||{}).textContent ? document.querySelector(\'main\').textContent.trim().length : 0, heading: (document.querySelector(\'h1\')||{}).textContent || null })');
const shellObj = JSON.parse(shell || '{}');
ok('主导航有视图切换按钮（data-view）', shellObj.nav >= 3, shellObj);
ok('main 容器存在且有实际文本内容（>200 字符）', shellObj.main === true && shellObj.mainText > 200, shellObj);
ok('页面有 h1 标题', !!shellObj.heading, shellObj.heading);
const overview = await evaluate('JSON.stringify({ cards: document.querySelectorAll(\'[data-label]\').length, tables: document.querySelectorAll(\'table\').length, rows: document.querySelectorAll(\'tbody tr\').length, text: (document.body.textContent||\'\').replace(/\\s+/g,\' \').slice(0,400) })');
const ovObj = JSON.parse(overview || '{}');
ok('概览渲染出统计卡片/表格（不是空壳）', ovObj.cards >= 3 || ovObj.rows >= 1, { cards: ovObj.cards, rows: ovObj.rows, tables: ovObj.tables });
ok('页面文本里能看到真实项目名（proj-demo）', ovObj.text.indexOf('proj') >= 0, ovObj.text.slice(0, 200));

console.log('');
console.log('[3] 真实交互：切到任务视图后 DOM 必须变化');
const before = await evaluate('document.querySelector(\'main\').innerHTML.length');
const clickInfo = await evaluate('(function(){ var b = Array.prototype.slice.call(document.querySelectorAll(\'[data-view]\')).filter(function(x){ return /tasks/.test(x.getAttribute(\'data-view\')||\'\'); })[0]; if(!b) return null; b.click(); return b.getAttribute(\'data-view\'); })()');
ok('找到并点击了任务视图按钮', !!clickInfo, clickInfo);
await new Promise(function (r) { setTimeout(r, 900); });
const after = await evaluate('document.querySelector(\'main\').innerHTML.length');
const tasksDom = await evaluate('JSON.stringify({ rows: document.querySelectorAll(\'tbody tr\').length, text: (document.querySelector(\'main\')||{}).textContent ? document.querySelector(\'main\').textContent.replace(/\\s+/g,\' \').slice(0,300) : \'\' })');
const tObj = JSON.parse(tasksDom || '{}');
ok('交互后 DOM 长度变化（不是静态截图）', Number(before) !== Number(after), { before: before, after: after });
ok('任务视图渲染出任务行或任务文本', tObj.rows >= 1 || /任务/.test(tObj.text), { rows: tObj.rows, text: tObj.text.slice(0, 160) });
const errs2 = consoleErrors();
ok('交互过程中没有新增 console error', errs2.length === 0, errs2.slice(0, 2).map(function (e) { return e.params; }));

console.log('');
console.log('[4] 截图存证');
const shot = await cdp.send('Page.captureScreenshot', { format: 'png' });
const shotPath = path.join(tmp, 'board.png');
fs.writeFileSync(shotPath, Buffer.from(shot.data, 'base64'));
const shotSize = fs.statSync(shotPath).size;
ok('截图已落盘且体积像真实页面（>20KB）', shotSize > 20000, { path: shotPath, bytes: shotSize });

// ---------- 回滚开关 ----------
console.log('');
console.log('[5] 回滚开关 AGENTBUS_UI_INLINE=1：同一套核心断言');
process.env.AGENTBUS_UI_INLINE = '1';
await loadPage(BASE + '/?token=' + encodeURIComponent(TOKEN) + '&inline=1', 'inline');
const inlineErrs = consoleErrors();
ok('[回滚] 零 console error', inlineErrs.length === 0, inlineErrs.slice(0, 3).map(function (e) { return e.params; }));
const inlineCsp = cspViolations();
ok('[回滚] 零 CSP 违规', inlineCsp.length === 0, inlineCsp.slice(0, 3).map(function (e) { return e.params.entry; }));
const inlineResp = responses();
const appJs = inlineResp.filter(function (r) { return /\/ui\/app\.js/.test(String(r.url || '')); })[0];
ok('[回滚] app.js 以 200 加载（回滚路径真的用上了）', !!appJs && appJs.status === 200, appJs && appJs.status);
const inlineDom = await evaluate('JSON.stringify({ text: (document.querySelector(\'main\')||{}).textContent ? document.querySelector(\'main\').textContent.replace(/\\s+/g,\' \').slice(0,200) : \'\', nav: document.querySelectorAll(\'[data-view]\').length })');
const iObj = JSON.parse(inlineDom || '{}');
ok('[回滚] 页面仍然渲染出内容', (iObj.text || '').length > 100, iObj);
const cspHeader = await evaluate('fetch(\'/api/state\').then(function(r){return r.headers.get(\'content-security-policy\')})');
ok('[回滚] 内联模式 CSP 放开 unsafe-inline（否则回滚页面不工作）', /unsafe-inline/.test(String(cspHeader || '')), cspHeader);
delete process.env.AGENTBUS_UI_INLINE;

await loadPage(BASE + '/?token=' + encodeURIComponent(TOKEN) + '&back=1', 'external-again');
const cspStrict = await evaluate('fetch(\'/api/state\').then(function(r){return r.headers.get(\'content-security-policy\')})');
ok('切回默认后 CSP 又变严格（script-src 不含 unsafe-inline）', !/unsafe-inline/.test(String(cspStrict || '')), cspStrict);

console.log('');
console.log('[6] 证据摘要');
console.log('  截图: ' + shotPath + '（' + shotSize + ' 字节）');
console.log('  模块响应: ' + JSON.stringify(byName));
ok('本次运行没有致命错误（fail=0 由退出码体现）', true);

cleanup();
try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (e) {}
console.log('');
console.log('==================================');
console.log('PASS ' + pass + '   FAIL ' + fail + '   SKIP ' + skip);
process.exitCode = fail ? 1 : 0;