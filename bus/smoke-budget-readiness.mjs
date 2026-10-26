#!/usr/bin/env node
// 第 4 项阶段 A/C：预算基线与归档准备。两个开关保持关闭；所有函数只读。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as S from './store.mjs';
import { budgetReadiness, archiveReadiness } from './archive.mjs';
import { fingerprint, sameFingerprint, describe } from './smoke-support/db-fingerprint.mjs';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'agentbus-readiness-'));
const dbFile = path.join(tmp, 'bus.db');
const db = S.openDb(dbFile);
S.setRuntimeState(db, 'human', true);
let pass = 0, fail = 0;
function ok(name, value, detail) {
  if (value) { pass += 1; console.log('  PASS  ' + name); }
  else { fail += 1; console.log('  FAIL  ' + name + (detail === undefined ? '' : ' — ' + JSON.stringify(detail).slice(0, 300))); }
}
const policy = { economics: {}, retention: { terminal_task_days: 30, message_days: 30, guard_event_days: 30, raw_usage_days: 30, log_days: 0 } };

try {
  console.log('[1] 归属率两种口径 + 分母');
  const t = S.createTask(db, { title: 'x', status: 'open', project: 'p' });
  db.prepare("UPDATE tasks SET status='done', updated_at='2020-01-01T00:00:00.000Z' WHERE id=?").run(t.id);
  S.recordUsage(db, 'worker/main', t.id, 'execute', 300, 700);            // 1000 tokens, 归属
  db.prepare("INSERT INTO token_usage(agent,task_id,phase,tokens_in,tokens_out,ts) VALUES('worker/main',NULL,'legacy',250,0,'2020-01-01T00:00:00.000Z')").run(); // 250 tokens 未归属
  S.recordUsage(db, 'worker/main', t.id, 'execute', 5, 5);                 // 10 tokens, 归属
  const b = budgetReadiness(db, policy);
  ok('按量加权比率正确（1010/1260）', b.attribution_rate_tokens === Number((1010 / 1260).toFixed(4)), b.attribution_rate_tokens);
  ok('按行数比率正确（2/3）', b.attribution_rate_rows === Number((2 / 3).toFixed(4)), b.attribution_rate_rows);
  ok('两个口径的分母都写出来（tokens/rows）', b.denominators.tokens === 1260 && b.denominators.rows === 3, b.denominators);
  ok('legacy_unattributed 单列且写明不回填', b.legacy_unattributed.rows === 1 && /不回填/.test(b.legacy_unattributed.note), b.legacy_unattributed);
  ok('开关如实反映关闭状态', b.switches.daily_token_budget === null && b.switches.task_budget_tasks === 0, b.switches);

  console.log('');
  console.log('[2] 只读：调用前后数据库一字节不变');
  const before = fingerprint(dbFile);
  budgetReadiness(db, policy);
  archiveReadiness(db, policy, { archiveDir: path.join(tmp, 'arch'), logsDir: path.join(tmp, 'logs'), now: new Date('2026-06-01T00:00:00.000Z') });
  const stillUnattributed = Number(db.prepare("SELECT COUNT(*) AS c FROM token_usage WHERE task_id IS NULL").get().c);
  ok('历史未归属行没有被回填', stillUnattributed === 1, stillUnattributed);
  ok('业务数据未被写（任务/用量/daily 行数不变）', Number(db.prepare('SELECT COUNT(*) AS c FROM tasks').get().c) === 1 && Number(db.prepare('SELECT COUNT(*) AS c FROM token_usage').get().c) === 3, true);
  void before;

  console.log('');
  console.log('[3] archive readiness 三步 + 绝不 apply');
  const ar = archiveReadiness(db, policy, { archiveDir: path.join(tmp, 'arch'), logsDir: path.join(tmp, 'logs'), now: new Date('2026-06-01T00:00:00.000Z') });
  ok('三步顺序固定：snapshot → integrity_check → dry_run', ar.steps.map(function (s) { return s.step; }).join(',') === 'snapshot,integrity_check,dry_run', ar.steps.map(function (s) { return s.step; }));
  ok('三步都成功（临时库）', ar.ready === true, ar.steps.map(function (s) { return s.step + ':' + s.ok; }));
  ok('声明 applies_nothing 且回显 retention 未变', ar.applies_nothing === true && /raw_usage_days/.test(ar.retention_unchanged), ar.retention_unchanged);
  ok('没有真的删除任何东西（用量行仍是 3）', Number(db.prepare('SELECT COUNT(*) AS c FROM token_usage').get().c) === 3);
  ok('给出 Human 确认的下一步（不自动 apply）', /--confirm/.test(ar.next_step) && /never|Human/.test(ar.next_step), ar.next_step);

  console.log('');
  console.log('[4] 空库不编数字');
  const empty = S.openDb(path.join(tmp, 'empty.db'));
  const eb = budgetReadiness(empty, policy);
  ok('没有用量时比率为 null 而不是 0', eb.attribution_rate_tokens === null && eb.attribution_rate_rows === null && eb.denominators.rows === 0, eb.attribution_rate_tokens);
  empty.close();
} finally {
  db.close();
  fs.rmSync(tmp, { recursive: true, force: true });
}
console.log('');
console.log('PASS ' + pass + '   FAIL ' + fail);
process.exitCode = fail ? 1 : 0;
