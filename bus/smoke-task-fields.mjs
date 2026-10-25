import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import * as S from './store.mjs';
import { createBoardServer } from './console-server.mjs';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'agentbus-fields-'));
const dbFile = path.join(tmp, 'bus.db');
fs.writeFileSync(path.join(tmp,'project.json'),JSON.stringify({validators:{smoke:{command:'node',args:['--version'],cwd:'.',timeout_ms:1000}}}));
const policyFile = path.join(tmp, 'policy.json');
const oldPolicy = process.env.BUS_POLICY_PATH;
const policy = { lead:'codex/main', permissions:{dispatch:['codex/main'],accept:['human','codex/main'],reassign:['human']}, global:{}, economics:{require_verify_cmd:true,auto_accept:['tests']}, agents:{'codex/main':{autonomy:'auto'},'claude/main':{autonomy:'auto',max_open_from_agents:100}} };
fs.writeFileSync(policyFile, JSON.stringify(policy));
process.env.BUS_POLICY_PATH = policyFile;
const db = S.openDb(dbFile);
S.setRuntimeState(db,'human',true);
const server = createBoardServer({db,actor:'human',csrf:'fields-token',projectOptions:{path:path.join(tmp,'projects.json'),workspaceRoot:path.join(tmp,'workspaces')}});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const url='http://127.0.0.1:'+server.address().port;
// 看板要求会话 cookie + CSRF + loopback Origin：先用一次性 token 换会话，再让 api() 带上。
const login=await fetch(url+'/?token='+encodeURIComponent(server.agentBus.bootstrap.token),{redirect:'manual'});
const sessionCookie=(login.headers.getSetCookie().find(c=>c.indexOf('agentbus_console_session=')===0)||'').split(';')[0];
assert.equal(login.status,303);assert(sessionCookie.indexOf('agentbus_console_session=')===0);
let pass=0;
async function check(name,fn){await fn();pass++;console.log('PASS '+name);}
async function api(method,route,body){const r=await fetch(url+route,{method,headers:{'content-type':'application/json','x-agentbus-request':'fields-token',cookie:sessionCookie,origin:url},body:body===undefined?undefined:JSON.stringify(body)});return {status:r.status,data:await r.json()};}
function mcp(messages){
  const files=['in','out','err'].map(name=>path.join(tmp,name));fs.writeFileSync(files[0],messages.map(x=>JSON.stringify(x)).join('\n')+'\n');
  const fds=[fs.openSync(files[0],'r'),fs.openSync(files[1],'w'),fs.openSync(files[2],'w')];
  let child;try{child=spawnSync(process.execPath,[path.join(S.BUS_DIR,'bus-mcp.mjs'),'--agent','codex/main','--db',dbFile],{stdio:fds,timeout:5000,env:{...process.env,BUS_POLICY_PATH:policyFile}});}finally{fds.forEach(fd=>fs.closeSync(fd));}
  assert.ifError(child.error);assert.equal(child.status,0,fs.readFileSync(files[2],'utf8'));
  return fs.readFileSync(files[1],'utf8').trim().split('\n').map(line=>JSON.parse(line));
}
try{
  const rows=mcp([
    {jsonrpc:'2.0',id:1,method:'tools/list'},
    {jsonrpc:'2.0',id:2,method:'tools/call',params:{name:'bus_dispatch',arguments:{to:'claude/main',title:'MCP normal',cost_class:'tests',project:tmp,verify_id:'smoke'}}},
    {jsonrpc:'2.0',id:3,method:'tools/call',params:{name:'bus_dispatch',arguments:{to:'claude/main',title:'MCP directories',extra_dirs:['relative/path']}}},
    {jsonrpc:'2.0',id:4,method:'tools/call',params:{name:'bus_dispatch',arguments:{to:'claude/main',title:'MCP invalid',verify_cmd:100}}},
    {jsonrpc:'2.0',id:5,method:'tools/call',params:{name:'bus_tasks',arguments:{}}},
    {jsonrpc:'2.0',id:6,method:'tools/call',params:{name:'bus_dispatch',arguments:{to:'claude/main',title:'Agent legacy',verify_cmd:'echo ok'}}},
  ]);
  const replies=new Map(rows.map(row=>[row.id,row]));
  await check('MCP schema exposes fields and their bounds',()=>{
    const props=replies.get(1).result.tools.find(t=>t.name==='bus_dispatch').inputSchema.properties;
    assert.equal(props.verify_id.maxLength,100);assert.equal(props.verify_cmd.maxLength,1000);assert.equal(props.extra_dirs.maxItems,20);assert.equal(props.extra_dirs.items.maxLength,500);assert.equal(props.grants.maxItems,5);assert(props.grants.items.enum.includes('cfg:edit'));
  });
  await check('MCP required verify dispatch succeeds with registered validator',()=>{
    const r=JSON.parse(replies.get(2).result.content[0].text);assert.equal(r.ok,true);assert.equal(r.task.verify_id,'smoke');assert.equal(typeof r.task.verify_spec_hash,'string');assert.equal(r.task.status,'open');
  });
  await check('MCP directories are persisted and gated; invalid fields rejected',()=>{
    const r=JSON.parse(replies.get(3).result.content[0].text);assert.equal(r.task.status,'proposed');assert.deepEqual(r.task.extra_dirs,['relative/path']);assert.equal(replies.get(4).result.isError,true);
  });
  await check('MCP task listings return structured extra directories and authorization arrays',()=>{
    const tasks=JSON.parse(replies.get(5).result.content[0].text).items;
    const task=tasks.find(t=>t.title==='MCP directories');assert.deepEqual(task.extra_dirs,['relative/path']);assert(Array.isArray(task.redline));assert(Array.isArray(task.grants));assert.equal(typeof task.verify_cmd,'string');
  });
  await check('MCP Agent free command is rejected with legacy reason',()=>{
    const r=JSON.parse(replies.get(6).result.content[0].text);assert.equal(r.reason,'legacy_verify_cmd_forbidden');
  });
  let id;
  await check('API creation echoes all fields and gates extra directories',async()=>{
    const r=await api('POST','/api/tasks',{title:'API fields',target:'claude/main',verify_cmd:'Write-Output passed',extra_dirs:[tmp,'relative'],grants:['cfg:edit']});
    assert.equal(r.status,201);id=r.data.task.id;assert.equal(r.data.task.status,'proposed');assert.equal(r.data.task.verify_cmd,'Write-Output passed');assert.deepEqual(r.data.task.extra_dirs,[tmp,'relative']);assert.deepEqual(r.data.task.grants,['cfg:edit']);assert(r.data.task.redline.includes('cfg:edit'));
  });
  await check('API pre-start edit persists three fields and snapshots echo them',async()=>{
    const r=await api('PATCH','/api/tasks/'+id,{verify_cmd:'Write-Output changed',extra_dirs:['another'],grants:['net:egress']});assert.equal(r.status,200);assert.equal(r.data.task.verify_cmd,'Write-Output changed');assert.deepEqual(r.data.task.extra_dirs,['another']);assert.deepEqual(r.data.task.grants,['net:egress']);
    const list=await api('GET','/api/tasks');const task=list.data.find(t=>t.id===id);assert.equal(task.verify_cmd,'Write-Output changed');assert.deepEqual(task.extra_dirs,['another']);
  });
  await check('editing open task extra directories sends it back to proposed',async()=>{
    const made=await api('POST','/api/tasks',{title:'open task'});assert.equal(made.data.task.status,'open');const r=await api('PATCH','/api/tasks/'+made.data.task.id,{extra_dirs:['relative']});assert.equal(r.status,200);assert.equal(r.data.task.status,'proposed');
  });
  const invalid=[{verify_cmd:null},{verify_cmd:1},{verify_cmd:'a'.repeat(1001)},{extra_dirs:'path'},{extra_dirs:Array(21).fill('ok')},{extra_dirs:['a'.repeat(501)]},{extra_dirs:['../escape']},{extra_dirs:[null]},{grants:'cfg:edit'},{grants:Array(6).fill('cfg:edit')},{grants:['unknown']}];
  await check('API create and edit reject all invalid types lengths and traversal',async()=>{
    for(const fields of invalid){for(const [method,route,body] of [['POST','/api/tasks',{title:'bad',...fields}],['PATCH','/api/tasks/'+id,fields]]){const r=await api(method,route,body);assert.equal(r.status,400,JSON.stringify(fields));assert(r.data.error.length>0);}}
  });
  await check('each started state locks all structural authorization fields',async()=>{
    for(const state of ['claimed','in_progress','review','done']){
      db.prepare('UPDATE tasks SET status=?,owner=? WHERE id=?').run(state,'claude/main',id);
      for(const fields of [{verify_cmd:'changed'},{extra_dirs:[]},{grants:[]}]){const r=await api('PATCH','/api/tasks/'+id,fields);assert.equal(r.status,409);assert.match(r.data.error,/结构性授权字段已锁定/);}
    }
  });
  await check('started title edits retain existing behavior',async()=>{
    db.prepare("UPDATE tasks SET status='in_progress' WHERE id=?").run(id);
    assert.equal((await api('PATCH','/api/tasks/'+id,{title:'renamed'})).status,200);
  });
  console.log('PASS '+pass+'   FAIL 0');
}finally{
  await new Promise(resolve=>server.close(resolve));db.close();if(oldPolicy===undefined)delete process.env.BUS_POLICY_PATH;else process.env.BUS_POLICY_PATH=oldPolicy;fs.rmSync(tmp,{recursive:true,force:true});
}
