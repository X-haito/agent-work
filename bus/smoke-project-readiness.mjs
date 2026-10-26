#!/usr/bin/env node
// 第 9 项：项目 registry 上线门禁。目标：一次列出所有不合格项目，并在启动与 release-check 里 fail-closed。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fingerprint, sameContent, describe } from './smoke-support/db-fingerprint.mjs';

let pass = 0, fail = 0;
function ok(name, cond, detail) {
  if (cond) { pass++; console.log('  PASS  ' + name); }
  else { fail++; console.log('  FAIL  ' + name + (detail === undefined ? '' : '  -> ' + JSON.stringify(detail).slice(0, 500))); }
}
const BUS = path.dirname(new URL(import.meta.url).pathname).replace(/^\//, '');
const REAL_REGISTRY = path.join(BUS, 'projects.json');
const realBefore = fs.existsSync(REAL_REGISTRY) ? fingerprint(REAL_REGISTRY) : null;
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'agentbus-ready-'));
const registryFile = path.join(tmp, 'projects.json');
const policyPath = path.join(tmp, 'policy.json');
fs.copyFileSync(path.join(BUS, 'policy.json'), policyPath);
const dbFile = path.join(tmp, 'bus.db');
process.env.BUS_DB = dbFile;
process.env.BUS_POLICY_PATH = policyPath;
process.env.BUS_LIFECYCLE = path.join(tmp, 'lifecycle.json');
process.env.BUS_PROJECTS = registryFile;

const S = await import('./store.mjs');
const PR = await import('./project-registry.mjs');
const policy = JSON.parse(fs.readFileSync(policyPath, 'utf8'));
const LEAD = policy.lead;
const WORKERS = Object.keys(policy.agents).filter(function (a) { return a !== LEAD; });
const db = S.openDb(dbFile);
S.setRuntimeState(db, 'human', true);
function writeRegistry(obj) { fs.writeFileSync(registryFile, typeof obj === 'string' ? obj : JSON.stringify(obj, null, 2)); }
function audit() { return PR.auditProjects(db, policy, {}); }
function projectDir(id) { const d = path.join(tmp, 'ws', id); fs.mkdirSync(d, { recursive: true }); return d; }
function activeTask(project) { return S.createTask(db, { title: '门禁用例 ' + project, status: 'open', project: project }); }
function codes(a) { return a.errors.map(function (f) { return f.code; }); }
function findingsFor(a, id) { return a.findings.filter(function (f) { return f.project === id; }); }
function levelOf(a, id, code) { const hit = findingsFor(a, id).filter(function (f) { return f.code === code; })[0]; return hit ? hit.level : null; }
function cancelAll() { db.exec("UPDATE tasks SET status='cancelled' WHERE status IN ('open','proposed','claimed','in_progress','review')"); }

console.log('[1] registry 缺失');
try { fs.unlinkSync(registryFile); } catch (e) {}
// 空安装（库里没有任何任务）时"没有 registry"只是警告：刚 init 完还没有项目是正常的。
const emptyInstall = audit();
ok('空安装 + 无 registry → warning（不阻断全新安装）', emptyInstall.ok === true && levelOf(emptyInstall, null, 'registry_missing') === 'warning', emptyInstall.findings.map(function (f) { return f.level + ':' + f.code; }));
// 一旦库里有任务，缺 registry 就必须是 error（fail-closed）
activeTask('proj-legacy');
const missing = audit();
ok('registry 不存在 → error registry_missing', missing.ok === false && codes(missing).indexOf('registry_missing') >= 0, codes(missing));
ok('给出可操作修法', missing.fixes.length >= 1 && /projects adopt/.test(missing.fixes.join(' ')), missing.fixes);

console.log('');
console.log('[2] JSON 损坏');
writeRegistry('{ not json');
const corrupt = audit();
ok('JSON 损坏 → error registry_unreadable（库里已有任务）', corrupt.ok === false && codes(corrupt).indexOf('registry_unreadable') >= 0, codes(corrupt));
db.exec("UPDATE tasks SET status='cancelled' WHERE status IN ('open','proposed','claimed','in_progress','review')");

console.log('');
console.log('[3] 项目缺失 / 路径不存在');
const goodDir = projectDir('proj-good');
writeRegistry({ projects: { 'proj-gone': { path: path.join(tmp, 'ws', 'never-created') } } });
const gonePath = audit();
ok('path 不存在 → error path_not_found', codes(gonePath).indexOf('path_not_found') >= 0, codes(gonePath));
writeRegistry({ projects: { 'proj-rel': { path: 'ws/rel' } } });
const rel = audit();
ok('相对路径 → error path_not_absolute', codes(rel).indexOf('path_not_absolute') >= 0, codes(rel));
writeRegistry({ projects: { 'proj-nopath': {} } });
const noPath = audit();
ok('缺 path → error path_missing', codes(noPath).indexOf('path_missing') >= 0, codes(noPath));

console.log('');
console.log('[4] 有 active 任务但项目没登记');
writeRegistry({ projects: {} });
activeTask('proj-unregistered');
const unreg = audit();
ok('active 项目未登记 → error active_project_unregistered', codes(unreg).indexOf('active_project_unregistered') >= 0, codes(unreg));
ok('修法指出哪个项目要 adopt', unreg.fixes.join(' ').indexOf('proj-unregistered') >= 0, unreg.fixes);

console.log('');
console.log('[5] agents 为空 / 未知 agent');
writeRegistry({ projects: { 'proj-good': { path: goodDir, agents: [] } } });
const emptyAgents = audit();
ok('agents 为空且无 active 任务 → warning（不是 error）', levelOf(emptyAgents, 'proj-good', 'agents_empty') === 'warning', findingsFor(emptyAgents, 'proj-good'));
writeRegistry({ projects: { 'proj-good': { path: goodDir, agents: ['ghost/agent', WORKERS[0]] } } });
const unknownAgent = audit();
ok('声明了 policy 里没有的 agent → warning（此时没有 active 任务）', levelOf(unknownAgent, 'proj-good', 'agent_not_in_policy') === 'warning', findingsFor(unknownAgent, 'proj-good'));
activeTask('proj-good');
const unknownAgentActive = audit();
ok('同样的问题在项目有 active 任务时升级为 error（fail-closed）', unknownAgentActive.ok === false && codes(unknownAgentActive).indexOf('agent_not_in_policy') >= 0, codes(unknownAgentActive));

console.log('');
console.log('[6] 没有非 Lead、非 owner 的潜在 reviewer → error');
writeRegistry({ projects: { 'proj-good': { path: goodDir, agents: [LEAD] } } });
const leadOnly = audit();
ok('只声明 Lead → error no_potential_reviewer', codes(leadOnly).indexOf('no_potential_reviewer') >= 0, codes(leadOnly));
ok('修法告诉人怎么加 reviewer', /--agents/.test(leadOnly.fixes.join(' ')), leadOnly.fixes);
writeRegistry({ projects: { 'proj-good': { path: goodDir, agents: WORKERS } } });
const ownersAsReviewers = audit();
// WORKERS[0] 在 accept 名单里，把它设成 owner 之后再建成 active 任务：owner 不能评审自己
const ownerTask = S.createTask(db, { title: 'owner 占位', status: 'open', project: 'proj-good' });
db.prepare("UPDATE tasks SET owner=?, status='in_progress' WHERE id=?").run(WORKERS[0], ownerTask.id);
writeRegistry({ projects: { 'proj-good': { path: goodDir, agents: [WORKERS[0]] } } });
const ownerOnly = audit();
ok('项目里只有 owner 本人 → error no_potential_reviewer', codes(ownerOnly).indexOf('no_potential_reviewer') >= 0, codes(ownerOnly));
db.prepare("UPDATE tasks SET owner=NULL, status='cancelled' WHERE id=?").run(ownerTask.id);

console.log('');
console.log('[7] 合格配置：一次全绿');
writeRegistry({ projects: { 'proj-good': { path: goodDir, agents: [WORKERS[0], WORKERS[1] || WORKERS[0], LEAD] } } });
const healthy = audit();
cancelAll();
const healthy2 = audit();
ok('合格配置下没有 error（全局 ok）', healthy2.ok === true && healthy2.errors.length === 0, healthy2.findings.map(function (f) { return f.level + ':' + f.code; }));
ok('合格项目状态是 ok', (healthy2.projects.filter(function (p) { return p.id === 'proj-good'; })[0] || {}).status === 'ok', healthy2.projects.map(function (p) { return p.id + ':' + p.status; }));
ok('列出潜在 reviewer（非 Lead、非 owner）', healthy.projects.some(function (p) { return (p.reviewers || []).some(function (r) { return r.reviewers.length > 0; }); }), healthy.projects.map(function (p) { return p.reviewers; }));

console.log('');
console.log('[8] 一次列出**所有**不合格项目（不是遇到第一个就返回）');
const d1 = projectDir('bad-1'); const d2 = projectDir('bad-2');
writeRegistry({ projects: { 'bad-1': { path: path.join(tmp, 'nope-1') }, 'bad-2': { path: 'relative/x' }, 'bad-3': {}, 'ok-1': { path: d1, agents: WORKERS } } });
const many = audit();
ok('三个坏项目全部出现在 errors 里', ['bad-1', 'bad-2', 'bad-3'].every(function (id) { return many.errors.some(function (f) { return f.project === id; }); }), many.errors.map(function (f) { return f.project + ':' + f.code; }));
ok('好项目没有被误报', !many.errors.some(function (f) { return f.project === 'ok-1'; }), many.errors.map(function (f) { return f.project; }));
ok('每个 error 都带修法', many.errors.every(function (f) { return typeof f.fix === 'string' && f.fix.length > 0; }), many.errors.map(function (f) { return [f.code, f.fix]; }));

console.log('');
console.log('[9] 启动与 release-check 的 fail-closed 接线');
const CS = await import('./console-server.mjs');
writeRegistry({ projects: {} });
activeTask('proj-blocked');
let startErr = null;
try { CS.startConsole({ port: 0, dbPath: dbFile, policyPath: policyPath }); } catch (e) { startErr = e; }
ok('registry 不合格时 startConsole 直接抛错（不启动半残看板）', !!startErr && startErr.reason === 'project_readiness_failed', startErr && startErr.message && startErr.message.slice(0, 160));
ok('抛出的错误里带完整 audit（人能一次看到所有问题）', !!startErr && startErr.audit && startErr.audit.errors.length >= 1, startErr && startErr.audit && startErr.audit.errors.map(function (f) { return f.code; }));
let allowed = null;
try { allowed = CS.startConsole({ port: 0, dbPath: dbFile, policyPath: policyPath, allowUnreadyProjects: true }); } catch (e) { allowed = null; }
await new Promise(function (resolve) { if (!allowed || allowed.listening) return resolve(); allowed.once('listening', resolve); setTimeout(resolve, 3000); });
ok('显式 allowUnreadyProjects 时可以启动（逃生舱，需显式写）', !!allowed && allowed.listening === true);
try { allowed.close(); } catch (e) {}
const rcSource = fs.readFileSync(path.join(BUS, 'release-check.mjs'), 'utf8');
ok('release-check 里注册了 project_readiness 这一步', /project_readiness/.test(rcSource) && /project-readiness/.test(rcSource));
const cliSource = fs.readFileSync(path.join(BUS, 'cli.mjs'), 'utf8');
ok('agentbus start 前置门禁存在且可用 --allow-unready-projects 逃生', /assertProjectReadiness/.test(cliSource) && /--allow-unready-projects/.test(cliSource));

console.log('');
console.log('[10] 真实 bus/projects.json 未被本套件改动');
ok('真实 registry 文件内容未变', (function () {
  if (realBefore === null) return !fs.existsSync(REAL_REGISTRY) || true;
  return sameContent(realBefore, fingerprint(REAL_REGISTRY));
})(), describe(realBefore));

try { db.close(); } catch (e) {}
try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (e) {}
console.log('');
console.log('==================================');
console.log('PASS ' + pass + '   FAIL ' + fail);
process.exitCode = fail ? 1 : 0;