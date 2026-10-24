import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import * as S from './store.mjs';
import { normalizeRoots } from './execution-grant.mjs';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'agentbus-grant-'));
const project = path.join(tmp, 'project');
const outside = path.join(tmp, 'outside');
fs.mkdirSync(project); fs.mkdirSync(outside);
fs.writeFileSync(path.join(project, 'project.json'), JSON.stringify({ topology:'shared' }));
const dbFile = path.join(tmp, 'bus.db');
let db = S.openDb(dbFile);
S.setRuntimeState(db, 'human', true);
const policy = { permissions: { reassign: ['human'], accept: ['human'] } };
let pass = 0;
function check(name, fn) { fn(); pass++; console.log('PASS '+name); }
function task(extra = {}) { return S.createTask(db, { title:'grant task', project, status:'open', ...extra }); }
function claimed(extra = {}) { const t = task(extra); const c = S.claim(db,'worker/main',t.id); assert(c.ok); return c.task; }
try {
  check('no claim, owner mismatch, expired lease and stale version cannot issue',()=>{
    const t=task(); assert.equal(S.issueExecutionGrant(db,t.id,'worker/main').reason,'not_claimed');
    const c=claimed(); assert.equal(S.issueExecutionGrant(db,c.id,'other/main').reason,'not_owner');
    assert.equal(S.issueExecutionGrant(db,c.id,'worker/main',{task_version:c.version-1}).reason,'version_mismatch');
    db.prepare('UPDATE tasks SET lease_until=? WHERE id=?').run('2000-01-01T00:00:00.000Z',c.id);
    assert.equal(S.issueExecutionGrant(db,c.id,'worker/main').reason,'lease_expired');
    assert.equal(S.renewLease(db,'worker/main',c.id,15),false);
  });
  check('claimed task issues canonical roots and idempotent current grant',()=>{
    const c=claimed({extra_dirs:[outside,'.',outside],redline:['cfg:edit'],grants:['fs:delete']});
    const result=S.issueExecutionGrant(db,c.id,'worker/main',{task_version:c.version});assert(result.ok);
    assert.deepEqual(result.grant.roots,[fs.realpathSync(project),fs.realpathSync(outside)]);
    assert.deepEqual(result.grant.redline,['cfg:edit','fs:delete']);
    assert.equal(result.grant.task_version,c.version);
    assert.equal(S.issueExecutionGrant(db,c.id,'worker/main').grant.grant_id,result.grant.grant_id);
    assert.equal(S.getExecutionGrant(db,c.id,'other/main'),null);
  });
  check('partial unique index prevents concurrent duplicate live grants',()=>{
    const c=claimed();const g=S.issueExecutionGrant(db,c.id,'worker/main').grant;
    const other=S.openDb(dbFile);
    assert.throws(()=>other.prepare('INSERT INTO execution_grants SELECT ?,task_id,owner,task_version,roots_json,redline_json,issued_at,expires_at,NULL,NULL FROM execution_grants WHERE grant_id=?').run('duplicate',g.grant_id),/UNIQUE/);
    other.close();
  });
  check('claim to in_progress preserves grant and synchronizes version and lease',()=>{
    const c=claimed();const before=S.issueExecutionGrant(db,c.id,'worker/main').grant;
    assert(S.updateTask(db,'worker/main',c.id,'in_progress').ok);
    const after=S.getExecutionGrant(db,c.id,'worker/main');assert(after);assert.equal(after.grant_id,before.grant_id);assert.equal(after.task_version,c.version+1);
    assert(S.renewLease(db,'worker/main',c.id,20));
    assert.equal(S.getExecutionGrant(db,c.id,'worker/main').expires_at,S.getTask(db,c.id).lease_until);
    assert(S.extendExecutionGrant(db,c.id,'worker/main',10**9).ok);
    assert.equal(S.getExecutionGrant(db,c.id,'worker/main').expires_at,S.getTask(db,c.id).lease_until);
    assert.equal(S.extendExecutionGrant(db,c.id,'other/main',100).reason,'not_owner');
    assert.equal(S.extendExecutionGrant(db,c.id,'worker/main',-1).reason,'invalid_duration');
  });
  check('reassignment immediately revokes old owner and permits later grant',()=>{
    const c=claimed();const old=S.issueExecutionGrant(db,c.id,'worker/main').grant;
    assert(S.reassignTask(db,policy,'human',c.id,'other/main').ok);
    assert.equal(S.getExecutionGrant(db,c.id,'worker/main'),null);
    assert(db.prepare('SELECT revoked_at FROM execution_grants WHERE grant_id=?').get(old.grant_id).revoked_at);
    const current=S.claim(db,'other/main',c.id);assert(current.ok);
    assert(S.issueExecutionGrant(db,c.id,'other/main',{task_version:current.task.version}).ok);
  });
  check('cancel, review, completion and lease reclamation revoke grants',()=>{
    const cancel=claimed();S.issueExecutionGrant(db,cancel.id,'worker/main');assert(S.cancelTask(db,policy,'human',cancel.id,'cancel').ok);assert.equal(S.getExecutionGrant(db,cancel.id,'worker/main'),null);
    const finish=claimed();S.issueExecutionGrant(db,finish.id,'worker/main');S.updateTask(db,'worker/main',finish.id,'in_progress');assert(S.updateTask(db,'worker/main',finish.id,'review').ok);assert.equal(S.getExecutionGrant(db,finish.id,'worker/main'),null);assert(S.updateTask(db,'human',finish.id,'done','ok',undefined,['human']).ok);
    const expire=claimed();const g=S.issueExecutionGrant(db,expire.id,'worker/main').grant;db.prepare('UPDATE tasks SET lease_until=? WHERE id=?').run('2000-01-01T00:00:00.000Z',expire.id);
    assert.equal(S.getExecutionGrant(db,expire.id,'worker/main'),null);assert(S.reapLeases(db,true)>0);assert(db.prepare('SELECT revoked_at FROM execution_grants WHERE grant_id=?').get(g.grant_id).revoked_at);
  });
  check('explicit revocation and version changes invalidate old grants',()=>{
    const c=claimed();S.issueExecutionGrant(db,c.id,'worker/main');S.revokeExecutionGrant(db,c.id,'test');assert.equal(S.getExecutionGrant(db,c.id,'worker/main'),null);
    assert(S.issueExecutionGrant(db,c.id,'worker/main').ok);db.prepare('UPDATE tasks SET version=version+1 WHERE id=?').run(c.id);assert.equal(S.getExecutionGrant(db,c.id,'worker/main'),null);
  });
  check('unsupported execution defers atomically with human evidence and revocation',()=>{
    const c=claimed();S.issueExecutionGrant(db,c.id,'worker/main');const r=S.deferExecutionTask(db,c.id,'worker/main','test adapter');assert(r.ok);assert.equal(r.task.status,'proposed');assert.equal(r.task.needs_human,1);assert.equal(r.task.owner,null);assert.equal(r.task.lease_until,null);assert.match(r.task.decline_reason,/执行端不支持强隔离/);assert.equal(S.getExecutionGrant(db,c.id,'worker/main'),null);assert.equal(db.prepare("SELECT COUNT(*) AS n FROM guard_events WHERE task_id=? AND kind='execution_isolation'").get(c.id).n,1);
  });
  check('closing admission preserves claimed execution grant and renewal',()=>{
    const c=claimed();S.issueExecutionGrant(db,c.id,'worker/main');S.setRuntimeState(db,'human',false);assert(S.getExecutionGrant(db,c.id,'worker/main'));assert(S.renewLease(db,'worker/main',c.id,10));S.setRuntimeState(db,'human',true);
  });
  check('dot dot traversal and missing parents cannot issue roots',()=>{
    for(const extra of ['../outside',path.join(project,'missing','child')]) {
      const c=claimed({extra_dirs:[extra]});assert.equal(S.issueExecutionGrant(db,c.id,'worker/main').reason,'invalid_execution_roots');
    }
    assert.equal(normalizeRoots({projectRoot:project,cwd:project,extraDirs:[project+path.sep+'..'+path.sep+'outside']}).ok,false);
  });
  check('symlink and dangling link escapes are rejected',()=>{
    // Windows JS realpath may keep a junction path unchanged; native realpath must resolve its target.
    const link=path.join(project,'escape');fs.symlinkSync(outside,link,process.platform==='win32'?'junction':'dir');
    assert.equal(normalizeRoots({projectRoot:project,cwd:link}).ok,false);
    assert.equal(normalizeRoots({projectRoot:project,cwd:project,extraDirs:['escape']}).ok,false);
    assert.equal(normalizeRoots({projectRoot:project,cwd:project,extraDirs:[link]}).ok,false);
    const broken=path.join(project,'broken');const missing=path.join(tmp,'no-target');fs.mkdirSync(missing);fs.symlinkSync(missing,broken,process.platform==='win32'?'junction':'dir');fs.rmdirSync(missing);
    assert.equal(normalizeRoots({projectRoot:project,cwd:project,extraDirs:['broken']}).ok,false);
  });
  check('missing final cwd is canonical when parent exists',()=>{
    const result=normalizeRoots({projectRoot:project,cwd:path.join(project,'new-worker'),extraDirs:[outside,outside]});assert(result.ok);assert.deepEqual(result.roots,[path.join(fs.realpathSync(project),'new-worker'),fs.realpathSync(outside)]);
  });
  check('old schema migrates idempotently without losing tasks',()=>{
    const legacyPath=path.join(tmp,'legacy.db');const legacy=new DatabaseSync(legacyPath);let schema=fs.readFileSync(path.join(S.BUS_DIR,'schema.sql'),'utf8');
    schema=schema.slice(0,schema.indexOf('CREATE TABLE IF NOT EXISTS execution_grants'));
    legacy.exec(schema);legacy.prepare('UPDATE agentbus_runtime_state SET enabled=1').run();
    for(const col of ['verify_cmd','extra_dirs','redline','grants','guard','changed_files','needs_human','escalated_at'])legacy.exec('ALTER TABLE tasks DROP COLUMN '+col);
    legacy.prepare("INSERT INTO tasks(id,title,status,created_at,updated_at) VALUES('legacy','existing','open',?,?)").run(S.nowIso(),S.nowIso());legacy.close();
    for(let i=0;i<3;i++){const migrated=S.openDb(legacyPath);assert.equal(S.getTask(migrated,'legacy').title,'existing');assert(migrated.prepare('PRAGMA table_info(tasks)').all().some(c=>c.name==='extra_dirs'));assert(migrated.prepare("SELECT name FROM sqlite_master WHERE name='i_execution_grant_active'").get());migrated.close();}
  });
  console.log('PASS '+pass+'   FAIL 0');
} finally { db.close();fs.rmSync(tmp,{recursive:true,force:true}); }
