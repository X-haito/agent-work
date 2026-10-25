// 传输层冒烟（第 13 项扩展）：真的 spawn bus/bus-mcp.mjs，按 JSON-RPC 打一轮。
// 沙箱里管道 stdio 会 EPERM，所以这里用「请求写到临时文件 + fd 重定向」的等价方式：
// 依然是真实进程、真实 stdin/stdout，只是不用 pipe。
import cp from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as S from './store.mjs';
import * as MCP from './mcp/tools.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PKG = JSON.parse(fs.readFileSync(path.join(HERE, '..', 'package.json'), 'utf8'));
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'agentbus-mcp-'));
const TDB = path.join(TMP, 'bus.db');

let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  PASS  ' + name); }
  else { fail++; console.log('  FAIL  ' + name + (extra === undefined ? '' : '  -> ' + JSON.stringify(extra).slice(0, 400))); }
}

const setupDb = S.openDb(TDB);
S.setRuntimeState(setupDb, 'human', true);
const seeded = [];
for (let i = 0; i < 5; i++) {
  const t = S.createTask(setupDb, { title: 'seed-' + i, status: 'claimed', owner: 'claude/main' });
  setupDb.prepare('UPDATE tasks SET updated_at=? WHERE id=?').run('2024-02-0' + (i + 1) + 'T00:00:00.000Z', t.id);
  seeded.push(t.id);
}
setupDb.close();

let round = 0;
// 一轮 = 一个真实进程：请求全部写文件，进程读完 EOF 后把响应写进另一个文件。
function runRound(requests) {
  round++;
  const inFile = path.join(TMP, 'in-' + round + '.jsonl');
  const outFile = path.join(TMP, 'out-' + round + '.jsonl');
  const errFile = path.join(TMP, 'err-' + round + '.txt');
  fs.writeFileSync(inFile, requests.map(function (r) { return JSON.stringify(r); }).join('\n') + '\n');
  const fdIn = fs.openSync(inFile, 'r'), fdOut = fs.openSync(outFile, 'w'), fdErr = fs.openSync(errFile, 'w');
  const child = cp.spawn(process.execPath, [path.join(HERE, 'bus-mcp.mjs'), '--agent', 'claude/main', '--db', TDB],
    { stdio: [fdIn, fdOut, fdErr], windowsHide: true, shell: false });
  return new Promise(function (resolve, reject) {
    const timer = setTimeout(function () { try { child.kill(); } catch (e) {} reject(new Error('round timeout')); }, 60000);
    child.on('error', function (e) { clearTimeout(timer); reject(e); });
    child.on('close', function () {
      clearTimeout(timer);
      fs.closeSync(fdIn); fs.closeSync(fdOut); fs.closeSync(fdErr);
      const raw = fs.readFileSync(outFile, 'utf8').split('\n').filter(function (l) { return l.trim() !== ''; });
      const byId = {};
      const stray = [];
      for (const line of raw) {
        let msg = null;
        try { msg = JSON.parse(line); } catch (e) { stray.push(line); continue; }
        byId[msg.id] = msg;
      }
      resolve({ byId: byId, count: raw.length, stray: stray, stderr: fs.readFileSync(errFile, 'utf8') });
    });
  });
}

try {
  // ---------- 第 1 轮：握手 / 清单 / 只读调用 / 守卫 ----------
  const r1 = await runRound([
    { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'smoke', version: '0' } } },
    { jsonrpc: '2.0', id: 2, method: 'tools/list' },
    { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'bus_online', arguments: {} } },
    { jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'bus_tasks', arguments: {} } },
    { jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'bus_dispatch', arguments: { to: 'codex/main', title: '我是 claude，无权派活' } } },
    { jsonrpc: '2.0', id: 6, method: 'tools/call', params: { name: 'bus_nope', arguments: {} } },
    { jsonrpc: '2.0', id: 7, method: 'tools/call', params: { name: 'bus_usage', arguments: { phase: 'execute', tokens_in: 100, tokens_out: 50 } } },
  ]);
  ok('这一轮的每个请求都有响应（EOF 不吞尾包）', r1.count === 7, [r1.count, r1.stray]);

  console.log('\n[1] 握手');
  const init = r1.byId[1];
  ok('返回 protocolVersion', !!init.result && !!init.result.protocolVersion, init.result);
  ok('serverInfo 名为 agent-bus', init.result.serverInfo.name === 'agent-bus', init.result.serverInfo);
  ok('serverInfo.version 与 package.json 同源', init.result.serverInfo.version === PKG.version, [init.result.serverInfo.version, PKG.version]);
  ok('声明 tools 能力', !!init.result.capabilities.tools, init.result.capabilities);

  console.log('\n[2] 工具清单与协议元信息');
  const list = r1.byId[2].result.tools;
  const names = list.map(function (t) { return t.name; });
  ok('工具数 = 19 且含 bus_override', names.length === 19 && names.indexOf('bus_override') >= 0, names.length);
  ok('包含评审三件套', ['bus_reviews', 'bus_claim_review', 'bus_submit_review'].every(function (n) { return names.indexOf(n) >= 0; }), names);
  ok('包含合并只读查询与申请（不含批准/执行）',
    names.indexOf('bus_merge_requests') >= 0 && names.indexOf('bus_request_merge') >= 0 &&
    !names.some(function (n) { return /^bus_(approve|execute|run)_merge|^bus_merge_(approve|execute|run)$/.test(n); }), names);
  ok('每个工具都有 title', list.every(function (t) { return typeof t.title === 'string' && t.title.length > 0; }));
  ok('每个工具都有 inputSchema(object)', list.every(function (t) { return t.inputSchema && t.inputSchema.type === 'object'; }));
  ok('每个工具的 inputSchema 都是 strict（additionalProperties:false）',
    list.every(function (t) { return t.inputSchema.additionalProperties === false; }),
    list.filter(function (t) { return t.inputSchema.additionalProperties !== false; }).map(function (t) { return t.name; }));
  ok('每个工具都有 outputSchema', list.every(function (t) { return t.outputSchema && t.outputSchema.type === 'object'; }));
  const ANN = ['readOnlyHint', 'destructiveHint', 'idempotentHint', 'openWorldHint'];
  ok('每个工具都有四个 annotations（布尔）',
    list.every(function (t) { return t.annotations && ANN.every(function (k) { return typeof t.annotations[k] === 'boolean'; }); }),
    list.filter(function (t) { return !t.annotations || !ANN.every(function (k) { return typeof t.annotations[k] === 'boolean'; }); }).map(function (t) { return t.name; }));
  const byName = {};
  for (const t of list) byName[t.name] = t;
  ok('只读工具标 readOnlyHint=true（bus_tasks/bus_status/bus_reviews/bus_merge_requests）',
    ['bus_tasks', 'bus_status', 'bus_reviews', 'bus_merge_requests'].every(function (n) { return byName[n].annotations.readOnlyHint === true; }));
  ok('写工具标 readOnlyHint=false（bus_dispatch/bus_claim/bus_update）',
    ['bus_dispatch', 'bus_claim', 'bus_update'].every(function (n) { return byName[n].annotations.readOnlyHint === false; }));
  ok('没有任何工具声称 destructive（本总线不删数据）', list.every(function (t) { return t.annotations.destructiveHint === false; }));
  ok('没有任何工具声称 openWorld（本地总线不碰外网）', list.every(function (t) { return t.annotations.openWorldHint === false; }));

  console.log('\n[3] 正常结果：structuredContent + 有上限的人类摘要');
  const online = r1.byId[3].result;
  ok('isError=false', online.isError === false, online.isError);
  ok('structuredContent 是对象', online.structuredContent && typeof online.structuredContent === 'object');
  ok('返回自己的身份', online.structuredContent.me === 'claude/main', online.structuredContent.me);
  ok('自己已上报心跳', (online.structuredContent.agents || []).some(function (a) { return a.agent_id === 'claude/main'; }));
  ok('content 是纯文本且不超上限', online.content.length === 1 && online.content[0].type === 'text' && online.content[0].text.length <= MCP.MAX_CONTENT + 40, online.content[0].text.length);

  console.log('\n[4] bus_tasks 游标分页');
  const first = r1.byId[4].result;
  ok('返回 items 数组', Array.isArray(first.structuredContent.items), first.structuredContent);
  ok('带 count / has_more / next_cursor 字段',
    typeof first.structuredContent.count === 'number' && typeof first.structuredContent.has_more === 'boolean' && 'next_cursor' in first.structuredContent);
  ok('默认 limit=50（seed 只有 5 条，所以一页取完）', first.structuredContent.count === 5 && first.structuredContent.has_more === false, first.structuredContent.count);

  console.log('\n[5] 守卫在 MCP 层同样生效');
  const guard = r1.byId[5].result;
  ok('非授权派活被拒（统一错误信封）', guard.isError === true && guard.structuredContent.code === 'guard_G1_unauthorized', guard.structuredContent);
  ok('拒绝里带 remedy 或明确原因', typeof guard.structuredContent.message === 'string' && guard.structuredContent.message.length > 0);

  console.log('\n[6] 未知工具不崩');
  ok('返回 JSON-RPC 错误 -32601', r1.byId[6].error && r1.byId[6].error.code === -32601, r1.byId[6].error);

  console.log('\n[7] stdout 干净（无日志污染）');
  ok('没有混入非 JSON 行', r1.stray.length === 0, r1.stray);

  console.log('\n[8] bus_usage 记账');
  const usage = r1.byId[7].result;
  ok('记录成功', usage.isError === false && usage.structuredContent.ok === true && usage.structuredContent.tokens_in === 100, usage.structuredContent);

  // ---------- 第 2 轮：分页第 1 页 ----------
  const r2 = await runRound([
    { jsonrpc: '2.0', id: 11, method: 'tools/call', params: { name: 'bus_tasks', arguments: { limit: 2 } } },
  ]);
  const page1 = r2.byId[11].result.structuredContent;
  ok('limit=2 生效且 has_more=true', page1.count === 2 && page1.has_more === true, page1);
  ok('next_cursor 是 opaque base64url（不是 offset 数字）', typeof page1.next_cursor === 'string' && /^[A-Za-z0-9_-]+$/.test(page1.next_cursor) && !/^[0-9]+$/.test(page1.next_cursor), page1.next_cursor);

  // ---------- 分页期间插一条 + 改一条，验证游标稳定 ----------
  const mut = S.openDb(TDB);
  const inserted = S.createTask(mut, { title: '插入的新任务', status: 'claimed', owner: 'claude/main' });
  mut.prepare('UPDATE tasks SET updated_at=? WHERE id=?').run('2099-01-01T00:00:00.000Z', inserted.id);
  mut.prepare('UPDATE tasks SET updated_at=? WHERE id=?').run('2024-02-09T00:00:00.000Z', seeded[4]);
  mut.close();

  const r3 = await runRound([
    { jsonrpc: '2.0', id: 21, method: 'tools/call', params: { name: 'bus_tasks', arguments: { limit: 2, cursor: page1.next_cursor } } },
    { jsonrpc: '2.0', id: 22, method: 'tools/call', params: { name: 'bus_tasks', arguments: { limit: 2, bogus: 1 } } },
    { jsonrpc: '2.0', id: 23, method: 'tools/call', params: { name: 'bus_tasks', arguments: { limit: 2.5 } } },
    { jsonrpc: '2.0', id: 24, method: 'tools/call', params: { name: 'bus_tasks', arguments: { cursor: 'not-a-cursor' } } },
    { jsonrpc: '2.0', id: 25, method: 'tools/call', params: { name: 'bus_update', arguments: { task_id: seeded[0] } } },
    { jsonrpc: '2.0', id: 26, method: 'tools/call', params: { name: 'bus_send', arguments: { to: 'codex/main', kind: 'gossip', body: 'x' } } },
    { jsonrpc: '2.0', id: 27, method: 'tools/call', params: { name: 'bus_online', arguments: {} } },
    { jsonrpc: '2.0', id: 28, method: 'tools/call', params: { name: 'bus_tasks', arguments: { status: 'claimed', limit: 200 } } },
  ]);
  const page2 = r3.byId[21].result.structuredContent;
  ok('游标翻页照常返回下一页', Array.isArray(page2.items) && page2.count === 2, page2);
  const overlap = page2.items.map(function (i) { return i.id; }).filter(function (id) { return page1.items.map(function (x) { return x.id; }).indexOf(id) >= 0; });
  ok('翻页不重复（两页 id 无交集）', overlap.length === 0, overlap);
  ok('翻页期间插入的新任务不会插队到已翻过的页之前',
    page2.items.every(function (i) { return i.id !== inserted.id; }), page2.items.map(function (i) { return i.id; }));
  ok('next_cursor 在最后一页为 null 或合法 base64url',
    page2.next_cursor === null || /^[A-Za-z0-9_-]+$/.test(String(page2.next_cursor)), page2.next_cursor);

  console.log('\n[9] strict 校验与统一错误信封');
  // 信封的 code 统一是 invalid_arguments；具体是哪种毛病看 details[].code / .path。
  const cases = [
    ['未知字段被拒', r3.byId[22], 'unknown_field', 'bogus'],
    ['非整数被拒', r3.byId[23], 'integer', 'limit'],
    ['非法游标被拒', r3.byId[24], 'invalid_arguments', null],
    ['缺必填字段被拒', r3.byId[25], 'missing', 'status'],
    ['枚举越界被拒', r3.byId[26], 'enum', 'kind'],
  ];
  for (const [label, res, detailCode, detailPath] of cases) {
    const env = res.result && res.result.structuredContent;
    ok(label + '：isError=true', res.result.isError === true, res.result);
    ok(label + '：信封 code = invalid_arguments', !!env && env.code === 'invalid_arguments', env && env.code);
    ok(label + '：信封字段齐全（ok/code/message/details）',
      !!env && env.ok === false && typeof env.code === 'string' && typeof env.message === 'string' && ('details' in env), env);
    if (detailPath) {
      ok(label + '：details 里有 ' + detailCode + '@' + detailPath,
        Array.isArray(env.details) && env.details.some(function (d) { return d.code === detailCode && d.path === detailPath; }), env.details);
    }
  }
  ok('参数错误给出了修复建议', typeof r3.byId[22].result.structuredContent.remedy === 'string' && r3.byId[22].result.structuredContent.remedy.length > 0, r3.byId[22].result.structuredContent.remedy);
  ok('合法调用不受影响', r3.byId[27].result.isError === false, r3.byId[27].result);
  ok('limit 上限 200 被接受', r3.byId[28].result.isError === false && r3.byId[28].result.structuredContent.items.length > 0);

  console.log('\n[10] 与 tools.mjs 的规格一致（防止 handler 与声明漂移）');
  const specs = MCP.allSpecs().map(function (s) { return s.name; }).sort();
  ok('tools/list 的名字集合 = tools.mjs 的规格集合', JSON.stringify(names.slice().sort()) === JSON.stringify(specs), [names.length, specs.length]);
  ok('分页工具被声明为 readOnly 且幂等', byName.bus_tasks.annotations.readOnlyHint === true && byName.bus_tasks.annotations.idempotentHint === true);
  ok('游标编解码可逆', (function () {
    const c = MCP.encodeCursor({ updated_at: '2024-01-01T00:00:00.000Z', id: 't-0009' });
    const d = MCP.decodeCursor(c);
    return d && d.u === '2024-01-01T00:00:00.000Z' && d.i === 't-0009';
  })());
} catch (e) {
  fail++;
  console.log('EXCEPTION: ' + (e && e.stack || e));
} finally {
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (e) {}
}

console.log('\n==================================');
console.log('PASS ' + pass + '   FAIL ' + fail);
process.exit(fail ? 1 : 0);
