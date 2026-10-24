// 传输层冒烟：真的 spawn 一个 MCP server，按 JSON-RPC 握手、列工具、调工具。
import { spawn } from 'node:child_process';
import * as S from './store.mjs';
import readline from 'node:readline';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
// 测试库放系统临时目录，不污染工作区
const TDB = path.join(os.tmpdir(), 'agentbus-mcp-' + process.pid + '.db');
for (const f of [TDB, TDB + '-wal', TDB + '-shm']) { try { fs.unlinkSync(f); } catch (e) {} }

let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  PASS  ' + name); }
  else { fail++; console.log('  FAIL  ' + name + (extra !== undefined ? '  -> ' + JSON.stringify(extra) : '')); }
}

const setupDb = S.openDb(TDB);
S.setRuntimeState(setupDb, 'human', true);
setupDb.close();

const child = spawn(process.execPath, [path.join(HERE, 'bus-mcp.mjs'), '--agent', 'claude/main', '--db', TDB], {
  stdio: ['pipe', 'pipe', 'pipe'],
});

const rl = readline.createInterface({ input: child.stdout });
const pending = new Map();
const stray = [];
let nextId = 1;

rl.on('line', function (line) {
  let msg = null;
  try { msg = JSON.parse(line); } catch (e) { stray.push(line); return; }
  if (msg && msg.id && pending.has(msg.id)) { const f = pending.get(msg.id); pending.delete(msg.id); f(msg); }
});

function rpc(method, params) {
  const id = nextId++;
  return new Promise(function (resolve, reject) {
    const timer = setTimeout(function () { pending.delete(id); reject(new Error('timeout on ' + method)); }, 20000);
    pending.set(id, function (m) { clearTimeout(timer); resolve(m); });
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: id, method: method, params: params || {} }) + '\n');
  });
}
function notify(method) {
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: method }) + '\n');
}
function payload(res) {
  try { return JSON.parse(res.result.content[0].text); } catch (e) { return res; }
}

try {
  console.log('[1] 握手');
  const init = await rpc('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'smoke', version: '0' } });
  ok('返回 protocolVersion', !!init.result && !!init.result.protocolVersion, init.result);
  ok('serverInfo 名为 agent-bus', init.result.serverInfo.name === 'agent-bus', init.result.serverInfo);
  ok('声明 tools 能力', !!init.result.capabilities.tools, init.result.capabilities);
  notify('notifications/initialized');

  console.log('');
  console.log('[2] 工具清单');
  const list = await rpc('tools/list');
  const names = list.result.tools.map(function (t) { return t.name; });
  ok('工具数 = 14 且含 bus_override', names.length === 14 && names.indexOf('bus_override') >= 0, names);
  ok('包含 bus_wait', names.indexOf('bus_wait') >= 0, names);
  ok('包含 bus_dispatch', names.indexOf('bus_dispatch') >= 0, names);
  ok('每个工具都有 inputSchema', list.result.tools.every(function (t) { return t.inputSchema && t.inputSchema.type === 'object'; }));

  console.log('');
  console.log('[3] 调用 bus_online');
  const online = payload(await rpc('tools/call', { name: 'bus_online', arguments: {} }));
  ok('返回自己的身份', online.me === 'claude/main', online.me);
  ok('自己已上报心跳', (online.agents || []).some(function (a) { return a.agent_id === 'claude/main'; }), online.agents);

  console.log('');
  console.log('[4] 调用 bus_tasks');
  const tasks = payload(await rpc('tools/call', { name: 'bus_tasks', arguments: {} }));
  ok('返回 tasks 数组', Array.isArray(tasks.tasks), tasks);

  console.log('');
  console.log('[5] 守卫在 MCP 层同样生效');
  const bad = payload(await rpc('tools/call', { name: 'bus_dispatch', arguments: { to: 'codex/main', title: '我是 claude，无权派活' } }));
  ok('非授权派活被拒', bad.ok === false && bad.reason === 'guard_G1_unauthorized', bad);

  console.log('');
  console.log('[6] 未知工具不崩');
  const unknown = await rpc('tools/call', { name: 'bus_nope', arguments: {} });
  ok('返回 JSON-RPC 错误', !!unknown.error, unknown.error);

  console.log('');
  console.log('[7] stdout 干净（无日志污染）');
  ok('没有混入非 JSON 行', stray.length === 0, stray);

  console.log('');
  console.log('[8] bus_usage 记账');
  const usage = payload(await rpc('tools/call', { name: 'bus_usage', arguments: { phase: 'execute', tokens_in: 100, tokens_out: 50 } }));
  ok('记录成功', usage.ok === true && usage.tokens_in === 100, usage);
} catch (e) {
  fail++;
  console.log('EXCEPTION: ' + (e && e.message || e));
} finally {
  child.kill();
  for (const f of [TDB, TDB + '-wal', TDB + '-shm']) { try { fs.unlinkSync(f); } catch (e) {} }
}

console.log('');
console.log('==================================');
console.log('PASS ' + pass + '   FAIL ' + fail);
process.exit(fail ? 1 : 0);
