#!/usr/bin/env node
// 第 15 项第 3/4/5 条：孤儿项目诊断、projects adopt 迁移、孤儿任务归档路径。
// 铁律：临时 db + 临时 registry（BUS_PROJECTS），真实 bus.db 与 bus/projects.json 用指纹/哈希证明未改动。
import cp from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as S from './store.mjs';
import { buildPlan } from './archive.mjs';
import { fingerprint, sameContent, describe } from './smoke-support/db-fingerprint.mjs';

const REAL_DB = path.join(S.BUS_DIR, 'bus.db');
const REAL_REGISTRY = path.join(S.BUS_DIR, 'projects.json');
const before = {
  db: fingerprint(REAL_DB),
  registry: fs.existsSync(REAL_REGISTRY) ? fs.readFileSync(REAL_REGISTRY, 'utf8') : null,
};
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'agentbus-orphan-'));
const registryFile = path.join(tmp, 'projects.json');
fs.writeFileSync(registryFile, JSON.stringify({ projects: { known: { path: tmp } } }, null, 2));
process.env.BUS_PROJECTS = registryFile;
let pass = 0, fail = 0, skipped = 0;
function ok(name, value, detail) {
  if (value) { pass += 1; console.log('  PASS  ' + name); }
  else { fail += 1; console.log('  FAIL  ' + name + (detail === undefined ? '' : ' — ' + JSON.stringify(detail).slice(0, 300))); }
}
function skip(name, why) { skipped += 1; console.log('  SKIP  ' + name + ' — ' + why + '（这不是 PASS）'); }

const db = S.openDb(path.join(tmp, 'bus.db'));
try {
  S.setRuntimeState(db, 'human', true);
  const policy = JSON.parse(fs.readFileSync(path.join(S.BUS_DIR, 'policy.json'), 'utf8'));
  console.log('[1] 孤儿识别');
  const t1 = S.createTask(db, { title: '兜底任务', status: 'open', project: 'default' });
  const t2 = S.createTask(db, { title: '路径项目任务', status: 'open', project: 'D:\\legacy\\proj' });
  const t3 = S.createTask(db, { title: '已登记项目任务', status: 'open', project: 'known' });
  S.recordUsage(db, 'worker/main', t1.id, 'execute', 10, 5);
  const orphans = S.orphanProjects(db);
  ok('未登记项目被识别（default 与绝对路径项目各一条）', orphans.orphans.length === 2 && orphans.orphans.some(function (o) { return o.project === 'default'; }) && orphans.orphans.some(function (o) { return o.project === 'D:\\legacy\\proj'; }), orphans.orphans.map(function (o) { return o.project; }));
  ok('已登记项目不算孤儿', orphans.orphans.every(function (o) { return o.project !== 'known'; }));
  ok('每个孤儿带 active/terminal 数与 Token 总量', orphans.orphans.every(function (o) { return Number.isInteger(o.tasks) && Number.isInteger(o.active_tasks) && Number.isInteger(o.tokens); }), orphans.orphans[0]);
  ok('绝对路径旧项目被标成 legacy_path，历史数据仍可读', orphans.orphans.filter(function (o) { return o.project === 'D:\\legacy\\proj'; })[0].legacy_path === 'D:\\legacy\\proj' && !!S.getTask(db, t2.id));
  ok('每个孤儿都给出下一步', orphans.orphans.every(function (o) { return typeof o.next_step === 'string' && o.next_step.length > 10; }));
  ok('default 任务数单独可查', orphans.default_tasks >= 1, orphans.default_tasks);

  console.log('');
  // 先造齐数据再关总线（关了就建不了任务）；迁移要求 active 任务存在时总线处于 drain/disabled
  const orphan2 = 'D:\\legacy\\proj2';
  const t4 = S.createTask(db, { title: '第二个孤儿任务', status: 'open', project: orphan2 });
  console.log('[2] adopt：成功 / 拒绝 / 回滚');
  S.setRuntimeState(db, 'human', false);
  // 迁移要求"有 active 任务时总线处于 drain/disabled"：先造数据，再关总线（关了就建不了新任务）
  const targetDir = path.join(tmp, 'newproj');
  fs.mkdirSync(targetDir, { recursive: true });
  const adopted = S.adoptProject(db, policy, { legacy: 'D:\\legacy\\proj', id: 'legacy-proj', path: targetDir, actor: 'human' });
  ok('adopt 成功并搬走任务', adopted.ok === true && adopted.tasks_migrated === 1, adopted.reason || adopted.tasks_migrated);
  ok('tasks.project 已更新', S.getTask(db, t2.id).project === 'legacy-proj');
  ok('写了 project_migrations 台账', Number(db.prepare('SELECT COUNT(*) AS c FROM project_migrations WHERE legacy_project = ?').get('D:\\legacy\\proj').c) === 1);
  const reg = JSON.parse(fs.readFileSync(registryFile, 'utf8'));
  ok('registry 里出现新项目并记录 adopted_from', !!reg.projects['legacy-proj'] && reg.projects['legacy-proj'].adopted_from === 'D:\\legacy\\proj', reg.projects['legacy-proj']);
  ok('adopt 后该项目不再是孤儿', S.orphanProjects(db).orphans.every(function (o) { return o.project !== 'legacy-proj'; }));
  // 用另一个孤儿项目做"拒绝类"用例，避免全被 default 保留规则挡在前面
  ok('default 不提供迁移接口', (function () { const r = S.adoptProject(db, policy, { legacy: 'default', id: 'x-default', path: targetDir }); return r.ok === false && r.reason === 'default_reserved'; })());
  ok('新 id 非法被拒', (function () { const r = S.adoptProject(db, policy, { legacy: orphan2, id: 'Bad Id', path: targetDir }); return r.ok === false && r.reason === 'invalid_project_id'; })());
  ok('路径含 .. 被拒（越界）', (function () { const r = S.adoptProject(db, policy, { legacy: orphan2, id: 'ok-id', path: path.join(tmp, 'newproj', '..', 'escape') }); return r.ok === false && r.reason === 'invalid_project_path'; })());
  ok('不存在的路径被拒', (function () { const r = S.adoptProject(db, policy, { legacy: orphan2, id: 'ghost', path: path.join(tmp, 'nope-dir') }); return r.ok === false && r.reason === 'invalid_project_path'; })());
  ok('已登记 id 被占用时拒绝', (function () { const r = S.adoptProject(db, policy, { legacy: orphan2, id: 'known', path: targetDir }); return r.ok === false && r.reason === 'project_exists'; })());
  ok('已登记项目不能当 legacy 迁移', (function () { const r = S.adoptProject(db, policy, { legacy: 'known', id: 'known-2', path: targetDir }); return r.ok === false && r.reason === 'legacy_not_orphan'; })());
  // 回滚：registry 写失败（把 registry 指到不可写目录）必须整体回滚
  const brokenRegistry = path.join(tmp, 'no-such-dir', 'projects.json');
  process.env.BUS_PROJECTS = brokenRegistry;
  let rollback = null;
  try { rollback = S.adoptProject(db, policy, { legacy: orphan2, id: 'from-default', path: targetDir }); }
  catch (error) { rollback = { ok: false, reason: 'threw', message: String((error && error.message) || error) }; }
  process.env.BUS_PROJECTS = registryFile;
  ok('registry 写失败时整体回滚（reason=registry_write_failed）', rollback.ok === false && String(rollback.message || rollback.reason).indexOf('registry_write_failed') >= 0, rollback.reason || rollback.message);
  ok('回滚后 tasks.project 与台账都没变', S.getTask(db, t4.id).project === orphan2 && Number(db.prepare('SELECT COUNT(*) AS c FROM project_migrations WHERE new_project = ?').get('from-default').c) === 0);

  console.log('');
  console.log('[3] active 任务存在时要求 drain');
  S.setRuntimeState(db, 'human', true);
  S.claim(db, 'worker/main', t4.id, 60);
  S.updateTask(db, 'worker/main', t4.id, 'in_progress');
  const running = S.getRuntimeState(db);
  const blocked = S.adoptProject(db, policy, { legacy: orphan2, id: 'from-default-2', path: targetDir });
  if (running.mode === 'draining' || running.mode === 'disabled') skip('active 未 drain 被拒', '本库当前 mode=' + running.mode + '，没有可复现的"运行中"状态');
  else ok('active 任务存在且总线在跑时拒绝（drain_required）', blocked.ok === false && blocked.reason === 'drain_required', blocked.reason);
  S.setRuntimeState(db, 'human', false);
  const drained = S.adoptProject(db, policy, { legacy: 'default', id: 'from-default-3', path: targetDir });
  ok('drain 之后允许迁移（但 default 自身仍被保留规则挡住）', drained.ok === false && drained.reason === 'default_reserved', drained.reason);

  console.log('');
  console.log('[4] 孤儿任务走 archive（dry-run 计数），不新增强删接口');
  db.prepare("UPDATE tasks SET status='done', updated_at='2020-01-01T00:00:00.000Z' WHERE id=?").run(t3.id);
  db.prepare("UPDATE tasks SET status='done', updated_at='2020-01-01T00:00:00.000Z' WHERE id=?").run(t2.id);
  const plan = buildPlan(db, JSON.parse(fs.readFileSync(path.join(S.BUS_DIR, 'policy.json'), 'utf8')), { now: new Date('2026-06-01T00:00:00.000Z'), logsDir: path.join(tmp, 'logs'), retention: undefined });
  ok('archive 计划可用（不新增按项目强删的路径）', plan && typeof plan.plan_hash === 'string' && typeof plan.counts.tasks === 'number', plan && plan.counts);
  ok('store 没有"按项目删除任务"的导出接口', typeof S.deleteProject !== 'function' && typeof S.purgeProject !== 'function');
  // ---------- [6] CLI 接线（第 7 项第 1/2 条）：真子进程 + fd 重定向（沙箱禁管道） ----------
  console.log('');
  console.log('[6] CLI：doctor --orphan-projects 与 projects adopt');
  const childEnv = Object.assign({}, process.env, {
    BUS_DB: path.join(tmp, 'bus.db'),
    BUS_PROJECTS: registryFile,
    HOME: tmp,
    USERPROFILE: tmp,
  });
  
  delete childEnv.AGENT_BUS_TOKEN;
  function runCli(args) {
    const outFile = path.join(tmp, 'cli-' + Math.random().toString(36).slice(2) + '.out');
    const errFile = outFile + '.err';
    const fdOut = fs.openSync(outFile, 'w');
    const fdErr = fs.openSync(errFile, 'w');
    const child = cp.spawn(process.execPath, [path.join(S.BUS_DIR, 'cli.mjs')].concat(args), {
      cwd: S.BUS_DIR, env: childEnv, stdio: ['ignore', fdOut, fdErr], windowsHide: true, shell: false,
    });
    return new Promise(function (resolve) {
      child.on('close', function (code) {
        fs.closeSync(fdOut); fs.closeSync(fdErr);
        resolve({ code: code, stdout: fs.readFileSync(outFile, 'utf8'), stderr: fs.readFileSync(errFile, 'utf8') });
      });
      child.on('error', function (error) {
        try { fs.closeSync(fdOut); fs.closeSync(fdErr); } catch (e) {}
        resolve({ code: -1, stdout: '', stderr: String(error && error.message || error) });
      });
    });
  }
  const doctorOut = await runCli(['doctor', '--orphan-projects', '--json']);
  let doctorJson = null;
  try { doctorJson = JSON.parse(doctorOut.stdout); } catch (e) { doctorJson = null; }
  if (doctorOut.code === -1) {
    skip('CLI 子进程可用', 'spawn_eperm');
  } else {
    ok('doctor --orphan-projects --json 退出码 0', doctorOut.code === 0, doctorOut.code);
    ok('doctor 输出可解析且 ok=true', !!doctorJson && doctorJson.ok === true, String(doctorOut.stdout).slice(0, 120));
    ok('doctor 列出孤儿项目与 legacy_path',
      !!doctorJson && Array.isArray(doctorJson.orphans) && doctorJson.orphans.some(function (o) { return o.legacy_path; }),
      doctorJson && doctorJson.orphans && doctorJson.orphans.map(function (o) { return o.project; }));
    ok('doctor 给 active/terminal 数与 Token 总量',
      !!doctorJson && doctorJson.orphans.every(function (o) { return Number.isInteger(o.tasks) && Number.isInteger(o.active_tasks) && Number.isInteger(o.tokens); }));
    ok('doctor 每个孤儿带 next_step', !!doctorJson && doctorJson.orphans.every(function (o) { return typeof o.next_step === 'string' && o.next_step.length > 10; }));
    ok('doctor 标注 adoptable：default 为 false（免得把人指去做必然被拒的 adopt）',
      !!doctorJson && doctorJson.orphans.filter(function (o) { return o.project === 'default'; }).every(function (o) { return o.adoptable === false; }),
      doctorJson && doctorJson.orphans.map(function (o) { return o.project + ':' + o.adoptable; }));
    ok('doctor 只读：真实库未被修改', sameContent(before.db, fingerprint(REAL_DB)), describe(before.db));

    const usage = await runCli(['projects', 'adopt', '--legacy', 'D:\\legacy\\proj3']);
    ok('adopt 缺参数时退出码 2 并给用法', usage.code === 2 && /adopt --legacy/.test(usage.stdout + usage.stderr), [usage.code, (usage.stdout + usage.stderr).slice(0, 120)]);
    const reserved = await runCli(['projects', 'adopt', '--legacy', 'default', '--id', 'anything', '--path', tmp, '--json']);
    let reservedJson = null;
    try { reservedJson = JSON.parse(reserved.stdout); } catch (e) { reservedJson = null; }
    ok('adopt default 被拒（default_reserved）且退出码 1', reserved.code === 1 && !!reservedJson && reservedJson.reason === 'default_reserved', reservedJson && reservedJson.reason);
    const badPath = await runCli(['projects', 'adopt', '--legacy', 'D:\\legacy\\proj3', '--id', 'cli-adopt', '--path', 'relative/path', '--json']);
    let badPathJson = null;
    try { badPathJson = JSON.parse(badPath.stdout); } catch (e) { badPathJson = null; }
    ok('adopt 相对路径被拒（invalid_project_path）', badPath.code === 1 && !!badPathJson && badPathJson.reason === 'invalid_project_path', badPathJson && badPathJson.reason);

    // 成功路径：造一个没有 active 任务、总线已关闭的孤儿
    const cliRoot = fs.mkdtempSync(path.join(tmp, 'cli-proj-'));
    // 造 fixture 需要临时开总线（schema 触发器在关闭时拒绝写入），造完立刻关回去
    S.setRuntimeState(db, 'human', true);
    db.prepare('INSERT INTO tasks(id,title,status,project,version,created_at,updated_at) VALUES(?,?,?,?,0,?,?)')
      .run('t-cli-1', 'CLI 迁移任务', 'done', 'D:\\legacy\\proj4', S.nowIso(), S.nowIso());
    S.setRuntimeState(db, 'human', false);
    const adoptOut = await runCli(['projects', 'adopt', '--legacy', 'D:\\legacy\\proj4', '--id', 'cli-adopt', '--path', cliRoot, '--json']);
    let adoptJson = null;
    try { adoptJson = JSON.parse(adoptOut.stdout); } catch (e) { adoptJson = null; }
    ok('adopt 成功时退出码 0 且 ok=true', adoptOut.code === 0 && !!adoptJson && adoptJson.ok === true, [adoptOut.code, String(adoptOut.stdout).slice(0, 160)]);
    ok('adopt 报告迁移任务数', !!adoptJson && adoptJson.tasks_migrated === 1, adoptJson && adoptJson.tasks_migrated);
    ok('adopt 写 project_migrations 台账', !!db.prepare('SELECT migration_id FROM project_migrations WHERE legacy_project=?').get('D:\\legacy\\proj4'));
    const regAfter = JSON.parse(fs.readFileSync(registryFile, 'utf8'));
    ok('adopt 更新 registry（新 id + adopted_from）',
      !!regAfter.projects['cli-adopt'] && regAfter.projects['cli-adopt'].adopted_from === 'D:\\legacy\\proj4', Object.keys(regAfter.projects));
    ok('adopt 后历史任务仍可读（project 已指向新 id）',
      (db.prepare('SELECT project FROM tasks WHERE id=?').get('t-cli-1') || {}).project === 'cli-adopt');
    ok('adopt 后旧 id 不再是孤儿', S.orphanProjects(db).orphans.every(function (o) { return o.project !== 'D:\\legacy\\proj4'; }));

    // 第 7 项第 3 条：项目维度归档入口（复用 archive 计划，不自建删除逻辑）
    // default 下还有 active 任务 → 必须拒绝并列出
    const aoRefuse = await runCli(['projects', 'archive-orphan', '--project', 'default', '--json']);
    let aoRefuseJson = null;
    try { aoRefuseJson = JSON.parse(aoRefuse.stdout); } catch (e) { aoRefuseJson = null; }
    ok('archive-orphan 对还有 active 任务的项目拒绝并列出任务', aoRefuse.code === 1 && !!aoRefuseJson && aoRefuseJson.reason === 'active_tasks_present' && aoRefuseJson.active_task_ids.length >= 1,
      [aoRefuse.code, aoRefuseJson && aoRefuseJson.reason]);
    // 已迁移、无 active 任务的项目 → dry-run 正常
    const ao = await runCli(['projects', 'archive-orphan', '--project', 'cli-adopt', '--json']);
    let aoJson = null;
    try { aoJson = JSON.parse(ao.stdout); } catch (e) { aoJson = null; }
    ok('archive-orphan dry-run 退出码 0 且给出 plan_hash', ao.code === 0 && !!aoJson && typeof aoJson.plan_hash === 'string', [ao.code, String(ao.stdout).slice(0, 140)]);
    // 规范形状（唯一）：scope {type,project_id} + plan_counts {tasks,outside_project,messages,guard_events,token_usage}
    const counts = aoJson && aoJson.plan_counts;
    ok('archive-orphan dry-run 只给规范形状：scope + plan_counts',
      !!aoJson && !!aoJson.scope && aoJson.scope.type === 'project' && aoJson.scope.project_id === 'cli-adopt' &&
      !!counts && typeof counts.tasks === 'number' && typeof counts.outside_project === 'number' &&
      typeof counts.messages === 'number' && typeof counts.guard_events === 'number' && typeof counts.token_usage === 'number' &&
      aoJson.plan_scope_global === undefined,
      aoJson && { scope: aoJson.scope, plan_counts: aoJson.plan_counts, has_legacy_field: aoJson.plan_scope_global !== undefined });
    ok('项目维度计划里不属于本项目的候选为 0', !!counts && counts.outside_project === 0, counts && counts.outside_project);
    const aoBad = await runCli(['projects', 'archive-orphan', '--project', 'cli-adopt', '--confirm', 'not-the-hash', '--json']);
    let aoBadJson = null;
    try { aoBadJson = JSON.parse(aoBad.stdout); } catch (e) { aoBadJson = null; }
    ok('archive-orphan confirm hash 不符时被 archive 拒绝', aoBad.code === 1 && !!aoBadJson && aoBadJson.applied && aoBadJson.applied.ok === false, aoBadJson && aoBadJson.applied && aoBadJson.applied.reason);
    ok('archive-orphan 缺 --project 时退出码 2', (await runCli(['projects', 'archive-orphan'])).code === 2);
  }

} finally {
  db.close();
  console.log('');
  console.log('[5] 真实文件未被改动');
  const after = { db: fingerprint(REAL_DB), registry: fs.existsSync(REAL_REGISTRY) ? fs.readFileSync(REAL_REGISTRY, 'utf8') : null };
  ok('真实 bus.db 逻辑内容未变', sameContent(before.db, after.db), { before: describe(before.db), after: describe(after.db) });
  ok('真实 bus/projects.json 字节未变（或两边都不存在）', before.registry === after.registry);
  fs.rmSync(tmp, { recursive: true, force: true });
}


console.log('');
if (skipped) console.log('SKIP ' + skipped + '（说明见上：这不等于 PASS）');
console.log('PASS ' + pass + '   FAIL ' + fail);
process.exitCode = fail ? 1 : 0;
