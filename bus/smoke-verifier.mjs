import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as S from './store.mjs';
import * as A from './admin-config.mjs';
import { runVerifier, validateFrozenVerifier, verifierHash } from './verifier.mjs';

const tmp=fs.mkdtempSync(path.join(os.tmpdir(),'agentbus-verifier-'));
const root=path.join(tmp,'project');fs.mkdirSync(root);
const node=process.execPath;
const spec={command:node,args:['-e','console.log("verified")'],cwd:'.',timeout_ms:2000};
const config=()=>fs.writeFileSync(path.join(root,'project.json'),JSON.stringify({topology:'shared',validators:{smoke:spec}}));config();
const db=S.openDb(path.join(tmp,'bus.db'));S.setRuntimeState(db,'human',true);
const policy={global:{dispatch_enabled:true},permissions:{dispatch:['lead','human']},economics:{},agents:{lead:{autonomy:'auto',may_dispatch_to:['worker']},human:{autonomy:'auto',may_dispatch_to:['worker']},worker:{autonomy:'auto',max_open_from_agents:100}}};
let pass=0;async function check(name,fn){await fn();pass++;console.log('PASS '+name);}
const create=extra=>S.createHumanTask(db,policy,'human',{title:'task',project:root,...extra});
const opts={db,task_id:'test-task',projectRoot:root,logRoot:tmp};
try {
  await check('validator IDs normalize and reject malformed commands or cwd',()=>{
    assert.deepEqual(A.validateProjectValidators({smoke:spec}),{smoke:spec});
    for(const input of [{'Bad':spec},{smoke:{...spec,command:'node && echo'}},{smoke:{...spec,cwd:'../outside'}},{smoke:{...spec,args:'x'}},{smoke:{...spec,timeout_ms:0}}])assert.throws(()=>A.validateProjectValidators(input));
  });
  await check('unknown validator and Agent legacy commands create no cards',()=>{
    const before=S.listTasks(db,{}).length;
    assert.equal(create({verify_id:'missing'}).reason,'unknown_validator');
    assert.equal(S.dispatch(db,policy,'lead',{to:'worker',title:'legacy',verify_cmd:'echo ok'}).reason,'legacy_verify_cmd_forbidden');
    assert.equal(S.listTasks(db,{}).length,before);
  });
  await check('Human non-redline legacy and requested proposed remain proposed',()=>{
    assert.equal(create({verify_cmd:'echo ok'}).task.status,'proposed');
    const legacy=S.dispatch(db,policy,'human',{to:'worker',title:'legacy',verify_cmd:'echo ok'});assert(legacy.ok);assert.equal(legacy.task.status,'proposed');
    const requested=S.dispatch(db,policy,'lead',{to:'worker',title:'planned',status:'proposed'});assert(requested.ok);assert.equal(requested.task.status,'proposed');
  });
  let task;
  await check('task create dispatch edit and projections freeze actual project spec',()=>{
    task=create({verify_id:'smoke'}).task;assert.equal(task.verify_id,'smoke');assert.equal(task.verify_spec_hash,verifierHash(spec));assert.deepEqual(JSON.parse(task.verify_spec_json),spec);
    const listed=S.listTasks(db,{}).find(t=>t.id===task.id);assert.equal(listed.verify_id,'smoke');assert.equal(listed.verify_spec_hash,task.verify_spec_hash);
    const d=S.dispatch(db,policy,'lead',{to:'worker',title:'trusted',project:root,verify_id:'smoke'});assert(d.ok);assert.equal(d.task.verify_spec_hash,task.verify_spec_hash);
    assert.equal(S.editTask(db,policy,'human',task.id,{verify_id:'missing'}).reason,'unknown_validator');
    assert(S.editTask(db,policy,'human',task.id,{verify_id:'smoke'}).ok);
    assert.equal(S.editTask(db,policy,'lead',task.id,{verify_id:'smoke',verify_cmd:'echo ok'}).reason,'legacy_verify_cmd_forbidden');
  });
  await check('success persists bounded summary and relative complete log path',async()=>{
    const result=await runVerifier(spec,{...opts,verify_id:'smoke',verify_spec_hash:task.verify_spec_hash});assert(result.ok,JSON.stringify(result));assert.equal(result.exit_code,0);assert.match(result.stdout_tail,/verified/);assert(!path.isAbsolute(result.log_path));assert(fs.readFileSync(path.join(tmp,result.log_path),'utf8').includes('verified'));
    const row=db.prepare('SELECT * FROM verification_runs ORDER BY started_at DESC LIMIT 1').get();assert.equal(row.verify_id,'smoke');assert.equal(row.log_path,result.log_path);assert.equal(row.ok,1);
  });
  await check('configuration and frozen hash tampering fail before spawn',async()=>{
    assert.equal(validateFrozenVerifier({...task,verify_spec_hash:'bad'},root).reason,'config_tampered');
    fs.writeFileSync(path.join(root,'project.json'),JSON.stringify({validators:{smoke:{...spec,args:['-e','throw Error("changed")']}}}));
    const result=await runVerifier(spec,{...opts,verify_id:'smoke',verify_spec_hash:task.verify_spec_hash});assert.equal(result.reason,'config_tampered');assert.equal(result.log_path,null);config();
  });
  await check('shell false preserves shell metacharacters as literal args',async()=>{
    const marker=path.join(tmp,'injected');const literal='; echo injected > '+marker;
    const result=await runVerifier({...spec,args:['-e','console.log(process.argv[1])',literal]},opts);assert(result.ok);assert(result.stdout_tail.includes(literal));assert(!fs.existsSync(marker));
  });
  await check('cwd traversal and real junction escape are rejected',async()=>{
    assert.equal((await runVerifier({...spec,cwd:'..'},opts)).reason,'invalid_verifier');
    const outside=path.join(tmp,'outside');fs.mkdirSync(outside);fs.symlinkSync(outside,path.join(root,'escape'),process.platform==='win32'?'junction':'dir');
    assert.equal((await runVerifier({...spec,cwd:'escape'},opts)).reason,'invalid_verifier');
  });
  await check('nonzero exit records failed result',async()=>{
    const result=await runVerifier({...spec,args:['-e','process.stderr.write("failure");process.exit(7)']},opts);assert.equal(result.ok,false);assert.equal(result.exit_code,7);assert.equal(result.reason,'nonzero_exit');assert.equal(result.stderr_tail,'failure');
  });
  await check('timeout kills process tree and reports timeout',async()=>{
    const marker=path.join(tmp,'child-survived');
    const childCode='setTimeout(()=>require("fs").writeFileSync('+JSON.stringify(marker)+',"bad"),700)';
    const parent='require("child_process").spawn(process.execPath,["-e",'+JSON.stringify(childCode)+'],{stdio:"ignore"});setInterval(()=>{},1000)';
    const result=await runVerifier({...spec,args:['-e',parent],timeout_ms:150},opts);assert.equal(result.reason,'timeout');assert.equal(result.ok,false);await new Promise(resolve=>setTimeout(resolve,900));assert(!fs.existsSync(marker));
  });
  await check('output tails truncate by byte while complete log remains intact',async()=>{
    const result=await runVerifier({...spec,args:['-e','process.stdout.write("x".repeat(5000));process.stderr.write("y".repeat(3000))']},{...opts,output_limit_bytes:100});assert(result.ok);assert.equal(Buffer.byteLength(result.stdout_tail),100);assert.equal(Buffer.byteLength(result.stderr_tail),100);assert.equal(fs.statSync(path.join(tmp,result.log_path)).size,8000);
  });
  await check('project creation and validator editing preserve atomic backups',()=>{
    const options={path:path.join(tmp,'projects.json'),workspaceRoot:tmp};const dir=path.join(tmp,'managed');fs.mkdirSync(dir);
    A.createProject({id:'managed',path:dir,topology:'shared',validators:{smoke:spec}},options);
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir,'project.json'),'utf8')).validators,{smoke:spec});
    const saved=A.saveProjectValidators('managed',{second:spec},options);assert(saved.ok);assert(saved.backup);assert(fs.existsSync(saved.backup));assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir,'project.json'),'utf8')).validators,{second:spec});
  });
  await check('legacy task columns and verification run table migrate idempotently',()=>{
    const legacyPath=path.join(tmp,'legacy.db');let legacy=S.openDb(legacyPath);
    legacy.exec('DROP TABLE verification_runs');
    for(const col of ['verify_id','verify_spec_json','verify_spec_hash'])legacy.exec('ALTER TABLE tasks DROP COLUMN '+col);
    legacy.close();
    for(let i=0;i<3;i++){legacy=S.openDb(legacyPath);for(const col of ['verify_id','verify_spec_json','verify_spec_hash'])assert(legacy.prepare('PRAGMA table_info(tasks)').all().some(c=>c.name===col));assert(legacy.prepare("SELECT name FROM sqlite_master WHERE name='verification_runs'").get());legacy.close();}
  });
  console.log('PASS '+pass+'   FAIL 0');
}finally{db.close();fs.rmSync(tmp,{recursive:true,force:true});}
