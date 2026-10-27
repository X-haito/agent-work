#!/usr/bin/env node
// 第 3 项：startConsole 的端口语义。0 是合法的「让系统分配」，不是空值。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { writePolicyFixture } from './smoke-support/policy-fixture.mjs';

let pass = 0, fail = 0;
function ok(name, cond, detail) {
  if (cond) { pass++; console.log('  PASS  ' + name); }
  else { fail++; console.log('  FAIL  ' + name + (detail === undefined ? '' : '  -> ' + JSON.stringify(detail).slice(0, 400))); }
}
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'agentbus-port-'));
const BUS = path.dirname(new URL(import.meta.url).pathname).replace(/^\//, '');
const policyPath = path.join(tmp, 'policy.json');
writePolicyFixture(policyPath, BUS);
const dbFile = path.join(tmp, 'bus.db');
process.env.BUS_DB = dbFile;
process.env.BUS_POLICY_PATH = policyPath;
process.env.BUS_LIFECYCLE = path.join(tmp, 'lifecycle.json');
process.env.BUS_PROJECTS = path.join(tmp, 'projects.json');
fs.writeFileSync(process.env.BUS_PROJECTS, JSON.stringify({ projects: {} }));

const S = await import('./store.mjs');
const CS = await import('./console-server.mjs');
const db = S.openDb(dbFile);
S.setRuntimeState(db, 'human', true);
db.close();

function waitListening(server) {
  return new Promise(function (resolve, reject) {
    if (server.listening) return resolve(server.address().port);
    server.once('listening', function () { resolve(server.address().port); });
    server.once('error', reject);
    setTimeout(function () { reject(new Error('listen_timeout')); }, 10000);
  });
}

console.log('[1] 端口解析：只有 null/undefined/空串 才用默认值');
ok('undefined → 7400', CS.resolveBoardPort(undefined).port === 7400, CS.resolveBoardPort(undefined));
ok('null → 7400', CS.resolveBoardPort(null).port === 7400, CS.resolveBoardPort(null));
ok('空字符串 → 7400', CS.resolveBoardPort('').port === 7400, CS.resolveBoardPort(''));
ok('显式 0 → 保留 0（不是 7400）', CS.resolveBoardPort(0).port === 0 && CS.resolveBoardPort(0).explicit === true, CS.resolveBoardPort(0));
ok('字符串 0 → 0', CS.resolveBoardPort('0').port === 0, CS.resolveBoardPort('0'));
ok('正常端口原样保留', CS.resolveBoardPort(8081).port === 8081);

console.log('');
console.log('[2] 非法端口被拒，且错误可操作（不静默回退）');
for (const bad of ['abc', -1, 70000, 1.5, 'NaN']) {
  const r = CS.resolveBoardPort(bad);
  ok('非法端口被拒: ' + JSON.stringify(bad), r.ok === false && r.reason === 'invalid_port' && /0-65535/.test(r.message), r);
}
let threw = null;
try { CS.startConsole({ port: 'abc', dbPath: dbFile, policyPath: policyPath }); } catch (e) { threw = e; }
ok('startConsole 对非法端口直接抛错（不静默用 7400）', !!threw && threw.reason === 'invalid_port' && /0-65535/.test(threw.message), threw && threw.message);

console.log('');
console.log('[3] port:0 真的拿到系统分配的端口');
const s1 = CS.startConsole({ port: 0, dbPath: dbFile, policyPath: policyPath });
const p1 = await waitListening(s1);
ok('port:0 得到的端口是非零整数', Number.isInteger(p1) && p1 > 0 && p1 !== 7400, p1);
ok('实际端口以 server.address().port 为准', s1.address().port === p1, s1.address());

console.log('');
console.log('[4] 两个并行 port:0 实例端口不同');
const s2 = CS.startConsole({ port: 0, dbPath: dbFile, policyPath: policyPath });
const p2 = await waitListening(s2);
ok('两个实例端口不同', p1 !== p2, { p1: p1, p2: p2 });
ok('两个实例都在监听', s1.listening === true && s2.listening === true);

console.log('');
console.log('[5] 默认值路径');
ok('不传 port 时解析为默认 7400', CS.resolveBoardPort().port === CS.DEFAULT_BOARD_PORT, CS.DEFAULT_BOARD_PORT);
ok('DEFAULT_BOARD_PORT 是 7400（保持既有约定）', CS.DEFAULT_BOARD_PORT === 7400);

try { s1.close(); } catch (e) {}
try { s2.close(); } catch (e) {}
try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (e) {}
console.log('');
console.log('==================================');
console.log('PASS ' + pass + '   FAIL ' + fail);
process.exitCode = fail ? 1 : 0;