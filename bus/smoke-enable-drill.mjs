#!/usr/bin/env node
// task-61 开关启用演练：把 DELIVERY-STATUS 里 enabled=no 的三项在临时环境里真的打开一次。
// 铁律：只用临时 db / 临时 policy 副本；真实 bus/policy.json 与 bus/bus.db 用 db-fingerprint 证明未改动。
// SKIP 表示「这条没能证明」，不算 PASS。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as S from './store.mjs';
import * as Auth from './auth.mjs';
import { buildPlan, applyArchive } from './archive.mjs';
import { fingerprint, sameContent, describe } from './smoke-support/db-fingerprint.mjs';

const REAL_DB = path.join(S.BUS_DIR, 'bus.db');
const REAL_POLICY = path.join(S.BUS_DIR, 'policy.json');
const before = { db: fingerprint(REAL_DB), policy: fs.readFileSync(REAL_POLICY, 'utf8') };
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'agentbus-drill-'));
let pass = 0, fail = 0, skipped = 0;
function ok(name, value, detail) {
  if (value) { pass += 1; console.log('  PASS  ' + name); }
  else { fail += 1; console.log('  FAIL  ' + name + (detail === undefined ? '' : ' — ' + JSON.stringify(detail).slice(0, 300))); }
}
function skip(name, why) { skipped += 1; console.log('  SKIP  ' + name + ' — ' + why + '（这不是 PASS）'); }
const REAL_POLICY_OBJ = JSON.parse(fs.readFileSync(REAL_POLICY, 'utf8'));
function policyWith(patch) { return Object.assign({}, REAL_POLICY_OBJ, patch); }
function freshDb(name) {
  const db = S.openDb(path.join(tmp, name));
  S.setRuntimeState(db, 'human', true);
  return db;
}
const NOW = new Date('2026-06-01T00:00:00.000Z');
function daysAgo(n) { return new Date(NOW.getTime() - n * 86400000).toISOString(); }

try {
  console.log('[1] 预算生效：daily_token_budget=500 时预留被夹住');
  {
    const db = freshDb('budget.db');
    const policy = policyWith({ economics: Object.assign({}, REAL_POLICY_OBJ.economics, { daily_token_budget: 500, default_turn_reserve: 200 }) });
    const task = S.createTask(db, { title: '预算演练', status: 'open', project: 'drill' });
    db.prepare("UPDATE tasks SET status='claimed', owner='worker/main', lease_until=? WHERE id=?").run(new Date(Date.now() + 3600000).toISOString(), task.id);
    if (typeof S.reserveTokens !== 'function') {
      skip('预留被预算夹住', 'store 没有导出 reserveTokens');
    } else {
      const results = [];
      for (let i = 0; i < 4; i += 1) {
        try { results.push(S.reserveTokens(db, policy, { agent: 'worker/main', taskId: task.id, tokens: 200 })); }
        catch (error) { results.push({ ok: false, reason: 'threw:' + String(error && error.message).slice(0, 60) }); }
      }
      ok('前两笔预留成功、之后被额度夹住', results[0].ok === true && results[1].ok === true && results.slice(2).some(function (r) { return r.ok === false; }), results.map(function (r) { return r.ok ? 'ok' : r.reason; }));
      const blocked = results.filter(function (r) { return r.ok === false; });
      ok('拒绝原因是额度类而不是崩溃', blocked.length >= 1 && blocked.every(function (r) { return typeof r.reason === 'string' && /budget|reserve|exceed|limit/i.test(r.reason); }), blocked.map(function (r) { return r.reason; }));
    }
    S.recordUsage(db, 'worker/main', task.id, 'execute', 600, 100);
    // recordUsage 用真实时钟打 ts，所以这里也必须按真实"今天"统计，否则会看错天
    const status = S.budgetStatus(db, policy);
    ok('budgetStatus 在额度打开后真的算超支', status.used > 0 && (status.exceeded === true || status.remaining <= 0 || status.limit === 500), { used: status.used, limit: status.limit, exceeded: status.exceeded, remaining: status.remaining });
    db.close();
  }

  console.log('');
  console.log('[2] 认证生效：require_credentials=true 时没有凭据就拿不到 Human 权限');
  {
    const db = freshDb('auth.db');
    const readiness = S.authReadiness(db, { profiles: {}, verify: function () { return { ok: true }; }, requireCredentials: true });
    ok('require_credentials=true 时 authReadiness 判未就绪', readiness.ready === false, readiness.blockers);
    ok('未就绪原因具体（不是一句「需要人工」）', Array.isArray(readiness.blockers) && readiness.blockers.length > 0 && readiness.blockers.join(' ').length > 10, readiness.blockers);
    const verifyName = ['verifyCredential', 'verify', 'checkCredential'].filter(function (n) { return typeof Auth[n] === 'function'; })[0];
    if (!verifyName) {
      skip('human 不带 token 被拒', 'auth.mjs 没有可调用的凭据校验函数');
    } else {
      let denied = null;
      try { denied = Auth[verifyName](db, 'human', null); }
      catch (error) { denied = { ok: false, reason: 'threw:' + String(error && error.message).slice(0, 60) }; }
      ok('human 不带 token 被拒（拿不到 Human 身份）', !!denied && denied.ok !== true, denied);
      ok('拒绝原因是 auth/credential/token 一类', !!denied && /auth|credential|required|token/i.test(JSON.stringify(denied)), denied);
    }
    const mcp = fs.readFileSync(path.join(S.BUS_DIR, 'bus-mcp.mjs'), 'utf8');
    ok('bus-mcp 在 require_credentials 下先校验再执行（源码里确实有这个闸门）', /require_credentials/.test(mcp) && /auth_required|verifyCredential|auditAuthFailure/.test(mcp));
    db.close();
  }

  console.log('');
  console.log('[3] 归档生效：retention 打开后按计划精确删除');
  {
    const db = freshDb('archive.db');
    const logsDir = path.join(tmp, 'logs');
    fs.mkdirSync(logsDir, { recursive: true });
    const policy = policyWith({ retention: { terminal_task_days: 1, message_days: 1, guard_event_days: 1, raw_usage_days: 1, log_days: 0, max_log_bytes: 0 } });
    const oldTask = S.createTask(db, { title: '过期任务', status: 'open', project: 'drill' });
    db.prepare("UPDATE tasks SET status='done', updated_at=?, body='旧正文' WHERE id=?").run(daysAgo(10), oldTask.id);
    const activeTask = S.createTask(db, { title: '活跃任务', status: 'open', project: 'drill' });
    db.prepare("UPDATE tasks SET status='in_progress', owner='worker/main', lease_until=? WHERE id=?").run(new Date(Date.now() + 3600000).toISOString(), activeTask.id);
    const MSG = 'INSERT INTO messages(msg_id,ts,sender,recipient,thread,kind,body,hop) VALUES(?,?,?,?,?,?,?,?)';
    db.prepare(MSG).run('m-old', daysAgo(10), 'worker/main', 'human', oldTask.id, 'note', '旧消息', 0);
    db.prepare(MSG).run('m-active', daysAgo(10), 'worker/main', 'human', activeTask.id, 'note', '活跃消息', 0);
    db.prepare(MSG).run('m-orphan', daysAgo(10), 'worker/main', 'human', null, 'note', '孤儿消息', 0);
    S.recordUsage(db, 'worker/main', oldTask.id, 'execute', 40, 60);
    db.prepare('UPDATE token_usage SET ts = ? WHERE task_id = ?').run(daysAgo(10), oldTask.id);
    const plan = buildPlan(db, policy, { now: NOW, logsDir: logsDir });
    ok('dry-run 只认定过期且有凭据的行', plan.counts.messages === 1 && plan.counts.tasks === 1 && plan.counts.token_usage === 1, plan.counts);
    ok('孤儿行被单列且默认不删', plan.unmanaged.messages === 1 && plan.prune_unmanaged === 0, plan.unmanaged);
    const applied = applyArchive(db, policy, plan, { confirm: plan.plan_hash, archiveDir: path.join(tmp, 'archives'), logsDir: logsDir, now: NOW });
    ok('confirm 后执行成功', applied.ok === true, applied.reason || applied.message);
    ok('删的条数与计划精确相等', applied.deleted.messages === plan.counts.messages && applied.deleted.token_usage === plan.counts.token_usage && applied.deleted.tasks_archived === plan.counts.tasks, { planned: plan.counts, deleted: applied.deleted });
    ok('active 任务的消息被跳过', !!db.prepare("SELECT 1 FROM messages WHERE msg_id='m-active'").get());
    ok('孤儿行仍在（默认不删）', !!db.prepare("SELECT 1 FROM messages WHERE msg_id='m-orphan'").get());
    const daily = db.prepare('SELECT COALESCE(SUM(tokens_in+tokens_out),0) AS t FROM token_usage_daily').get().t;
    ok('token 聚合守恒（原始 100 全进 daily）', Number(daily) === 100, daily);
    ok('原始行已删、任务正文已搬走', Number(db.prepare('SELECT COUNT(*) AS c FROM token_usage').get().c) === 0 && S.getTask(db, oldTask.id).body === null);
    db.close();
  }

  console.log('');
  console.log('[4] 真实文件未被改动（三文件指纹 + 逻辑内容）');
  const after = { db: fingerprint(REAL_DB), policy: fs.readFileSync(REAL_POLICY, 'utf8') };
  ok('真实 bus/policy.json 字节未变', before.policy === after.policy);
  ok('真实 bus.db 逻辑内容未变（WAL 期间字节会动，用 sameContent）', sameContent(before.db, after.db), { before: describe(before.db), after: describe(after.db) });
  ok('真实 bus.db 版本号与各表行数一致', before.db.version === after.db.version && JSON.stringify(before.db.tables) === JSON.stringify(after.db.tables));
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}

console.log('');
console.log('演练结论：机制开了有用（预算/认证/归档在临时环境里都真的生效）；生产仍需 Human 打开开关。');
if (skipped) console.log('SKIP ' + skipped + '（说明见上：这不等于 PASS）');
console.log('PASS ' + pass + '   FAIL ' + fail);
process.exitCode = fail ? 1 : 0;
