// Runtime admission, persistence, process isolation and drain regression coverage.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import * as S from './store.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'agentbus-runtime-'));
const dbFile = path.join(tmp, 'bus.db');
const policyFile = path.join(tmp, 'policy.json');
// 派活来源与认领者都必须在 agents 里登记（unknown_agent 硬拒）。
const policy = { lead: 'lead', permissions: { dispatch: ['lead'], accept: ['human','lead'] },
  global: {}, economics: {},
  agents: { lead: { autonomy: 'auto', may_dispatch_to: ['worker'], max_open_from_agents: 10, max_concurrent: 5 },
    worker: { autonomy: 'auto', max_open_from_agents: 10, max_concurrent: 5 } } };
fs.writeFileSync(policyFile, JSON.stringify(policy));
// 父进程自己的 claim/dispatch 也走这份临时策略：否则 claim 读真实 policy，占位 actor 会被判 unknown_agent。
process.env.BUS_POLICY_PATH = policyFile;
let db = S.openDb(dbFile);
let checks = 0;
function check(name, fn) { fn(); checks++; console.log('PASS ' + name); }
function disabled(value) { assert.equal(value.ok, false); assert.equal(value.reason, 'disabled'); }
function runFile(script, args, input, env = {}) {
  const inFile = path.join(tmp, 'stdin-' + checks);
  const outFile = path.join(tmp, 'stdout-' + checks);
  const errFile = path.join(tmp, 'stderr-' + checks);
  fs.writeFileSync(inFile, input || '');
  const fds = [fs.openSync(inFile, 'r'), fs.openSync(outFile, 'w'), fs.openSync(errFile, 'w')];
  let result;
  try { result = spawnSync(process.execPath, [path.join(here, script), ...args], {
    stdio: fds, timeout: 5000, env: { ...process.env, BUS_POLICY_PATH: policyFile, BUS_DB: dbFile, ...env }
  }); } finally { fds.forEach(fd => fs.closeSync(fd)); }
  assert.ifError(result.error);
  assert.equal(result.status, 0, fs.readFileSync(errFile, 'utf8'));
  return fs.readFileSync(outFile, 'utf8');
}
try {
  check('fresh and migrated databases default off', () => {
    assert.equal(S.getRuntimeState(db).enabled, false);
    assert.equal(S.getRuntimeState(db).mode, 'disabled');
    const legacy = S.openDb(path.join(tmp, 'legacy.db'));
    S.setRuntimeState(legacy, 'human', true);
    S.createTask(legacy, {title:'existing old task',status:'open'});
    legacy.exec('DROP TABLE agentbus_runtime_state');
    legacy.close();
    const migrated = S.openDb(path.join(tmp, 'legacy.db'));
    assert.equal(S.getRuntimeState(migrated).enabled, false);
    assert.equal(S.listTasks(migrated, {}).length, 1);
    migrated.close();
  });
  check('only Human may control; validate boolean and version', () => {
    assert.equal(S.setRuntimeState(db, 'lead', true).reason, 'not_permitted');
    assert.equal(S.setRuntimeState(db, 'human', 'true').reason, 'invalid_runtime_state');
    assert.equal(S.setRuntimeState(db, 'human', true, -1).reason, 'invalid_runtime_state');
    assert.equal(S.getRuntimeState(db).enabled, false);
    assert.throws(() => db.prepare('UPDATE agentbus_runtime_state SET enabled=2').run());
  });
  check('disabled rejects dispatch, create, claim, accept and reassign', () => {
    disabled(S.dispatch(db, policy, 'lead', {to:'worker',title:'new'}));
    disabled(S.createHumanTask(db, policy, 'human', {title:'new'}));
    disabled(S.claim(db, 'worker', 'none'));
    disabled(S.accept(db, 'human', 'none', ['human']));
    disabled(S.reassignTask(db, policy, 'human', 'none', 'worker'));
    assert.throws(() => S.createTask(db, {title:'raw',status:'open'}), /agentbus_disabled/);
  });
  check('Human enable persists across reopened connections', () => {
    assert.equal(S.setRuntimeState(db, 'human', true, 0).ok, true);
    db.close(); db = S.openDb(dbFile);
    assert.equal(S.getRuntimeState(db).enabled, true);
    assert.equal(S.getRuntimeState(db).updated_by, 'human');
    assert.equal(S.getRuntimeState(db).version, 1);
  });
  check('state changes are immediately visible to an existing connection', () => {
    const other = S.openDb(dbFile);
    assert.equal(S.getRuntimeState(other).enabled, true);
    S.setRuntimeState(db, 'human', false);
    assert.equal(S.getRuntimeState(other).enabled, false);
    S.setRuntimeState(other, 'human', true);
    assert.equal(S.getRuntimeState(db).enabled, true);
    other.close();
  });
  const open = S.createHumanTask(db, policy, 'human', {title:'pending',target:'worker'}).task;
  const proposed = S.createTask(db, {title:'proposal',status:'proposed'});
  const task = S.dispatch(db, policy, 'lead', {to:'worker',title:'finish'}).task;
  assert.equal(S.claim(db, 'worker', task.id).ok, true);
  check('close transitions to draining without changing in-flight work', () => {
    assert.equal(S.setRuntimeState(db, 'human', false).mode, 'draining');
    assert.equal(S.getTask(db, task.id).status, 'claimed');
    disabled(S.claim(db, 'worker', open.id));
    disabled(S.accept(db, 'human', proposed.id, ['human']));
    assert.equal(S.renewLease(db, 'worker', task.id, 30), true);
    assert.equal(S.recordUsage(db, 'worker', task.id, 'execute', 5, 2).ok, true);
    assert.equal(S.updateTask(db, 'worker', task.id, 'in_progress').ok, true);
    assert.equal(S.updateTask(db, 'worker', task.id, 'review', 'finished').ok, true);
    assert.equal(S.listTasks(db, {}).length, 3);
  });
  check('separate connection cannot bypass close using stale admission', () => {
    const other = S.openDb(dbFile);
    assert.throws(() => other.prepare("UPDATE tasks SET status='claimed',owner='worker' WHERE id=?").run(open.id), /agentbus_disabled/);
    assert.throws(() => other.prepare("UPDATE tasks SET status='open' WHERE id=?").run(proposed.id), /agentbus_disabled/);
    other.close();
  });
  const messages = [
    ['bus_runtime_status',{}], ['bus_wait',{timeout_ms:55000}], ['bus_dispatch',{to:'worker',title:'new'}],
    ['bus_claim',{task_id:open.id}], ['bus_accept',{task_id:proposed.id}],
    ['bus_renew_lease',{task_id:task.id}], ['bus_update',{task_id:task.id,status:'done',note:'complete'}]
  ].map(([name,args], i) => JSON.stringify({jsonrpc:'2.0',id:i+1,method:'tools/call',params:{name,arguments:args}})).join('\n') + '\n';
  check('MCP disabled returns immediately while allowing task completion', () => {
    const output = runFile('bus-mcp.mjs',['--agent','worker','--db',dbFile],messages);
    const rows = output.trim().split('\n').map(s=>JSON.parse(s));
    const byId = new Map(rows.map(row=>[row.id,JSON.parse(row.result.content[0].text)]));
    assert.equal(byId.get(1).mode,'draining');
    [2,3,4,5].forEach(id=>disabled(byId.get(id)));
    assert.equal(byId.get(7).ok,true);
    assert.equal(S.getRuntimeState(db).mode,'disabled');
  });
  check('MCP exposes no enable/disable tools, even for human identity', () => {
    const output = runFile('bus-mcp.mjs',['--agent','human','--db',dbFile], JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/list'})+'\n');
    const names = JSON.parse(output.trim()).result.tools.map(t=>t.name);
    assert(names.includes('bus_runtime_status'));
    assert(!names.some(name=>/enable|disable|control/.test(name)));
  });
  S.send(db,{sender:'human',to:'lead',kind:'question',body:'queued but must not wake'});
  for (const script of ['claude-supervisor.mjs','codex-supervisor.mjs','dsh-supervisor.mjs']) {
    check(script + ' disabled startup never claims or wakes Lead', () => {
      const output = runFile(script,['--agent','lead','--db',dbFile,'--once','--fake','--wait-ms','0'],'');
      assert(!output.includes('消息驱动'));
      assert.equal(S.getTask(db,open.id).status,'open');
      assert.equal(Number(db.prepare('SELECT COUNT(*) AS n FROM token_usage').get().n),1);
    });
  }
  check('disabled hooks return without injecting queued messages', () => {
    S.send(db,{sender:'human',to:'worker',kind:'note',body:'must not wake'});
    assert.equal(runFile('hook.mjs',['stop'],'{}',{AGENT_BUS_ID:'worker',BUS_HOOK_WAIT_MS:'55000'}),'');
    assert(!fs.readFileSync(path.join(tmp, 'stderr-' + checks), 'utf8').includes('【Agent Bus'));
  });
  const version = S.getRuntimeState(db).version;
  const workerCode = 'import * as S from '+JSON.stringify(pathToFileURL(path.join(here,'store.mjs')).href)+';const db=S.openDb(process.argv[1]);const r=S.setRuntimeState(db,"human",true,Number(process.argv[2]));db.close();process.exit(r.ok?0:2);';
  const results = await Promise.all([1,2].map(() => new Promise((resolve,reject)=>{
    const child=spawn(process.execPath,['--input-type=module','-e',workerCode,dbFile,String(version)],{stdio:'ignore'});
    child.on('error',reject);child.on('exit',resolve);
  })));
  check('concurrent CAS admits exactly one state writer', () => {
    assert.deepEqual(results.sort(),[0,2]);
    assert.equal(S.getRuntimeState(db).version,version+1);
  });
  console.log('PASS '+checks+'   FAIL 0');
} finally { db.close(); fs.rmSync(tmp,{recursive:true,force:true}); }
