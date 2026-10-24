// 端到端：三个真实 MCP server 进程 + 共享 SQLite，走完整条派活链路。
// 角色从 policy 读，不写死。
import { spawn } from 'node:child_process';
import readline from 'node:readline';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import * as S from './store.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DB = path.join(os.tmpdir(), 'agentbus-e2e-' + process.pid + '.db');

// 用临时策略跑：强制 worker 为 off 档，链路才有确定的状态序列
const basePolicy = JSON.parse(fs.readFileSync(path.join(HERE, 'policy.json'), 'utf8'));
for (const id of Object.keys(basePolicy.agents)) {
  if (id !== basePolicy.lead) { basePolicy.agents[id].autonomy = 'off'; basePolicy.agents[id].max_open_from_agents = 0; }
}
const POLICY = path.join(os.tmpdir(), 'agentbus-e2e-policy-' + process.pid + '.json');
fs.writeFileSync(POLICY, JSON.stringify(basePolicy, null, 2));
const runtimeDb = S.openDb(DB);
S.setRuntimeState(runtimeDb, 'human', true);
runtimeDb.close();
const policy = S.loadPolicy(POLICY);
const LEAD = policy.lead;
const WORKERS = Object.keys(policy.agents).filter(function (a) { return a !== LEAD; });
const W1 = WORKERS[0];
const W2 = WORKERS[1] || WORKERS[0];

let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  PASS  ' + name); }
  else { fail++; console.log('  FAIL  ' + name + (extra !== undefined ? '  -> ' + JSON.stringify(extra).slice(0, 240) : '')); }
}

function boot(agent) {
  const child = spawn(process.execPath, [path.join(HERE, 'bus-mcp.mjs'), '--agent', agent, '--db', DB], { stdio: ['pipe', 'pipe', 'pipe'], env: Object.assign({}, process.env, { BUS_POLICY_PATH: POLICY }) });
  const rl = readline.createInterface({ input: child.stdout });
  const pending = new Map();
  let seq = 1;
  rl.on('line', function (line) {
    let m = null;
    try { m = JSON.parse(line); } catch (e) { return; }
    if (m && m.id && pending.has(m.id)) { const f = pending.get(m.id); pending.delete(m.id); f(m); }
  });
  const rpc = (method, params) => new Promise(function (res, rej) {
    const id = seq++;
    const t = setTimeout(function () { pending.delete(id); rej(new Error(agent + ' timeout ' + method)); }, 20000);
    pending.set(id, function (m) { clearTimeout(t); res(m); });
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: id, method: method, params: params || {} }) + '\n');
  });
  const call = async (name, args) => {
    const r = await rpc('tools/call', { name: name, arguments: args || {} });
    if (r.error) return { __error: r.error };
    return JSON.parse(r.result.content[0].text);
  };
  return { agent, child, rpc, call };
}

const lead = boot(LEAD);
const w1 = boot(W1);
const w2 = boot(W2);

try {
  await Promise.all([lead.rpc('initialize', {}), w1.rpc('initialize', {}), w2.rpc('initialize', {})]);
  console.log('角色: LEAD=' + LEAD + '  W1=' + W1 + '  W2=' + W2);

  console.log('');
  console.log('[1] 三方 presence 互相可见');
  const online = await lead.call('bus_online');
  ok('看到 3 个 agent', online.agents.length === 3, online.agents.map(function (a) { return a.agent_id; }));

  console.log('');
  console.log('[2] Lead 派活 -> 工作者是 off 档，落到待批');
  const d = await lead.call('bus_dispatch', { to: W1, title: '把登录页错误提示改成中文', project: 'proj-demo', write_scope: ['src/auth/*'], cost_class: 'standard' });
  ok('派活成功', d.ok === true, d);
  ok('停在 proposed', d.task.status === 'proposed', d.task && d.task.status);
  ok('原因 autonomy=off', d.gated_by === 'autonomy=off', d.gated_by);

  console.log('');
  console.log('[3] 工作者能看到待批任务，但认领不了');
  const ct = await w1.call('bus_tasks', {});
  ok('看到这张卡', ct.tasks.some(function (t) { return t.id === d.task.id; }), ct.tasks.length);
  const early = await w1.call('bus_claim', { task_id: d.task.id });
  ok('待批状态认领被拒', early.ok === false && early.reason === 'needs_approval', early);

  console.log('');
  console.log('[4] Lead 批准 -> 认领拿到 workspace');
  const acc = await lead.call('bus_accept', { task_id: d.task.id });
  ok('批准成功', acc.ok === true && acc.task.status === 'open', acc);
  const cl = await w1.call('bus_claim', { task_id: d.task.id });
  ok('认领成功', cl.ok === true && cl.task.owner === W1, cl);
  ok('拿到 cwd', !!(cl.workspace && cl.workspace.cwd), cl.workspace);
  ok('拿到分支', !!(cl.workspace && cl.workspace.branch), cl.workspace && cl.workspace.branch);

  console.log('');
  console.log('[5] 状态推进');
  ok('claimed -> in_progress', (await w1.call('bus_update', { task_id: d.task.id, status: 'in_progress' })).ok === true);
  ok('in_progress -> review', (await w1.call('bus_update', { task_id: d.task.id, status: 'review', note: '改完 +42/-8，18 tests pass' })).ok === true);

  console.log('');
  console.log('[6] Lead 跨进程验收 -> done（非 owner）');
  const done = await lead.call('bus_update', { task_id: d.task.id, status: 'done', note: '验收通过' });
  ok('Lead 能收尾', done.ok === true && done.task.status === 'done', done);

  console.log('');
  console.log('[7] 第三方通过长轮询收到全过程消息');
  const w = await w2.call('bus_wait', { since_seq: 0, timeout_ms: 2000 });
  const kinds = w.messages.map(function (m) { return m.kind; });
  ok('收到了消息', w.messages.length > 0, w.messages.length);
  ok('包含 task.new', kinds.indexOf('task.new') >= 0, kinds);
  ok('包含 task.claim', kinds.indexOf('task.claim') >= 0, kinds);
  ok('包含 task.done', kinds.indexOf('task.done') >= 0, kinds);

  console.log('');
  console.log('[8] 成本按"谁消耗"记账');
  await lead.call('bus_usage', { phase: 'plan', tokens_in: 1200, tokens_out: 400 });
  await w1.call('bus_usage', { phase: 'execute', task_id: d.task.id, tokens_in: 9000, tokens_out: 3500 });
  const st = await lead.call('bus_status', {});
  ok('总 token 正确', st.cost.total === 14100, st.cost.total);
  ok('Lead 记账正确', st.cost.lead === 1600, st.cost.lead);

  console.log('');
  console.log('[9] 未授权方向被拒');
  const bad = await w2.call('bus_dispatch', { to: W1, title: '想派活' });
  ok('worker 无权派活', bad.ok === false && bad.reason === 'guard_G1_unauthorized', bad);
} catch (e) {
  fail++;
  console.log('EXCEPTION: ' + (e && e.message || e));
} finally {
  for (const p of [lead, w1, w2]) { try { p.child.kill(); } catch (e) {} }
  await new Promise(function (r) { setTimeout(r, 300); });
  for (const f of [DB, DB + '-wal', DB + '-shm', POLICY]) { try { fs.unlinkSync(f); } catch (e) {} }
}

console.log('');
console.log('==================================');
console.log('PASS ' + pass + '   FAIL ' + fail);
process.exit(fail ? 1 : 0);
