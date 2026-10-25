// 第 8 项 supervisor 硬门：预算没拿到 reservation 就绝不启动 CLI；overrun 只停后续轮次、不强杀。
// reserveTokens / budgetStatus / token_reservations 属第 8 项数据层，未就绪时这里用桩验证装配，
// 并把「数据层未就绪」如实打印出来，不假装覆盖了并发不超卖。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import * as S from './store.mjs';
import { POLICY_FIELDS, describePolicy } from './policy-runtime.mjs';
import * as Codex from './engines/codex.mjs';

let pass = 0, fail = 0;
function ok(name, cond, detail) {
  if (cond) { pass++; console.log('PASS ' + name); return true; }
  fail++; console.log('FAIL ' + name + (detail === undefined ? '' : ' :: ' + String(detail).slice(0, 300)));
  return false;
}
function skip(name, why) { console.log('SKIP ' + name + ' :: ' + why); }
const here = path.dirname(fileURLToPath(import.meta.url));
const STUDIED = ['claude-supervisor.mjs', 'codex-supervisor.mjs'];
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'agentbus-budget-'));

function sliceFunction(source, header) {
  const start = source.indexOf(header);
  assert(start >= 0, '找不到：' + header);
  const end = source.indexOf('\n}\n', start);
  assert(end > start, '函数边界变了：' + header);
  return source.slice(start, end + 3);
}
function sliceBetween(source, header, tail) {
  const start = source.indexOf(header);
  const end = source.indexOf(tail, start);
  assert(start >= 0 && end > start, '边界变了：' + header);
  return source.slice(start, end).trim();
}

// 抽出真实的预算函数，桩只替换数据层边界（S），这样测的是 supervisor 自己的逻辑。
function budgetKit(file) {
  const source = fs.readFileSync(path.join(here, file), 'utf8');
  const parts = {};
  return { source, parts };
}

const budgetOn = { lead: 'lead', economics: { daily_token_budget: 1000, default_turn_reserve: 200 }, global: {} };
const budgetOff = { lead: 'lead', economics: { daily_token_budget: null }, global: {} };

for (const file of STUDIED) {
  const source = fs.readFileSync(path.join(here, file), 'utf8');
  const enabled = vm.runInNewContext('(' + sliceFunction(source, 'function budgetEnabled(cfg) {') + ')', {});
  const statusOf = vm.runInNewContext('(' + sliceFunction(source, 'function budgetStatusOf(cfg) {') + ')', { S, db: {} });
  const noteOf = vm.runInNewContext('(' + sliceFunction(source, 'function budgetNote(cfg, refusal) {') + ')', { budgetEnabled: enabled, budgetStatusOf: statusOf, S, db: {}, AGENT: 'worker' });
  const detailOf = vm.runInNewContext('(' + sliceFunction(source, 'function budgetDetailText(detail) {') + ')', {});
  const reserveCtx = { S: {}, db: { name: 'db' }, AGENT: 'worker', log() {}, budgetEnabled: enabled, budgetDetailText: detailOf };
  const reserve = vm.runInNewContext('(' + sliceFunction(source, 'function reserveTurn(cfg, taskId, phase, costClass) {') + ')', reserveCtx);

  ok(file + ' 未配预算时直接放行（行为不变）', enabled(budgetOff) === false && enabled({}) === false && enabled({ economics: { daily_token_budget: 0 } }) === false);
  ok(file + ' 未配预算的 reserveTurn 不调用数据层', (() => { let hit = 0; reserveCtx.S.reserveTokens = () => { hit++; return { ok: true, reservation_id: 'x' }; }; const r = reserve(budgetOff, 't-1', 'execute', 'standard'); return hit === 0 && r.ok === true && r.disabled === true && r.reservation_id === null; })());

  // 预算启用但数据层缺 reserveTokens：fail-closed，且必须说清为什么。
  delete reserveCtx.S.reserveTokens;
  const missing = reserve(budgetOn, 't-1', 'execute', 'standard');
  ok(file + ' 预算启用但缺 reserveTokens 时 fail-closed', missing.ok === false && missing.reason === 'budget_api_unavailable' && /拒绝启动模型/.test(missing.message), JSON.stringify(missing));

  let called = null;
  reserveCtx.S.reserveTokens = (db, cfg, args) => { called = { db, cfg, args }; return { ok: false, reason: 'budget_exceeded', detail: '当日额度 1000 已用 900' }; };
  const refused = reserve(budgetOn, 't-1', 'execute', 'standard');
  ok(file + ' 数据层拒绝时透传 budget_exceeded 与 detail', refused.ok === false && refused.reason === 'budget_exceeded' && /已用 900/.test(refused.message), JSON.stringify(refused));
  // 数据层真实 detail 是对象（scope/day_key/limit/used/reserved/requested），不能变成 [object Object]。
  ok(file + ' 对象型 detail 被拼成人话而不是 [object Object]',
    (() => {
      reserveCtx.S.reserveTokens = () => ({ ok: false, reason: 'budget_exceeded', detail: { scope: 'day', day_key: '2026-05-01', limit: 500, used: 300, reserved: 500, requested: 200 } });
      const text = String(reserve(budgetOn, 't-1', 'execute', 'standard').message || '');
      return /额度 500/.test(text) && /已预留 500/.test(text) && /本次需要 200/.test(text) && text.indexOf('[object Object]') < 0;
    })());
  ok(file + ' reserveTurn 把 agent/phase/costClass/now 交给数据层',
    !!called && called.db === reserveCtx.db && called.cfg === budgetOn && called.args.agent === 'worker' && called.args.taskId === 't-1' &&
    called.args.phase === 'execute' && called.args.costClass === 'standard' && /^\d{4}-\d{2}-\d{2}T/.test(String(called.args.now)),
    JSON.stringify(called && called.args));

  reserveCtx.S.reserveTokens = () => { throw new Error('db locked'); };
  ok(file + ' 数据层抛异常时也不放行', reserve(budgetOn, 't-1', 'execute', 'standard').reason === 'budget_reserve_failed');

  reserveCtx.S.reserveTokens = () => ({ ok: true, reservation_id: 'res-9', reserved_tokens: 200, day_key: '2026-05-01' });
  const granted = reserve(budgetOn, null, 'react', null);
  ok(file + ' 预留成功时把 reservation_id 交回调用方', granted.ok === true && granted.reservation_id === 'res-9' && granted.day_key === '2026-05-01', JSON.stringify(granted));

  // 拒绝说明必须让人能判断"调额还是等明天"：带额度，缺 budgetStatus 时写明未知。
  const noteNoStatus = noteOf(budgetOn, { reason: 'budget_exceeded', message: '当日额度已用尽' });
  ok(file + ' 预算拒绝说明含 budget_exceeded 与当日额度', /budget_exceeded/.test(noteNoStatus) && /当日额度 1000/.test(noteNoStatus), noteNoStatus);
  ok(file + ' 缺 budgetStatus 时写明未知而不是编数字', /未知/.test(noteNoStatus) && !/剩余 0/.test(noteNoStatus), noteNoStatus);
  ok(file + ' 拒绝说明明确不自动重试、由 Human 手动 retryTask', /不会自动重试/.test(noteNoStatus) && /retryTask/.test(noteNoStatus), noteNoStatus);
  const noteCtx = { budgetEnabled: enabled, budgetStatusOf: () => ({ day_key: '2026-05-01', limit: 1000, used: 800, reserved: 200, remaining: 0 }), S, db: {}, AGENT: 'worker' };
  const noteWithStatus = vm.runInNewContext('(' + sliceFunction(source, 'function budgetNote(cfg, refusal) {') + ')', noteCtx);
  const detailed = noteWithStatus(budgetOn, { reason: 'budget_exceeded' });
  ok(file + ' 有 budgetStatus 时写出已用/已预留/剩余', /已用 800/.test(detailed) && /已预留 200/.test(detailed) && /剩余 0/.test(detailed) && /2026-05-01/.test(detailed), detailed);
}

// ---------- oneRound 装配 ----------
const MODES = ['budget-refused', 'budget-ok', 'budget-overrun', 'halted', 'react-refused'];
for (const file of STUDIED) {
  const source = fs.readFileSync(path.join(here, file), 'utf8');
  const oneRoundBody = sliceBetween(source, 'async function oneRound(roundNo) {', '\nasync function main()');
  const haltBody = sliceFunction(source, 'function haltOnOverrun(taskId, usage) {');
  const noteBody = sliceFunction(source, 'function budgetNote(cfg, refusal) {');
  const enabledBody = sliceFunction(source, 'function budgetEnabled(cfg) {');
  const statusBody = sliceFunction(source, 'function budgetStatusOf(cfg) {');

  for (const mode of MODES) {
    const order = [], notes = [], escalations = [], sent = [];
    let interval, spawned = 0, aborted = false, ranAgent = 0, reservationSeen = null, stateAsked = 0;
    const task = { id: 't-budget', project: 'x', version: 0, extra_dirs: [], cost_class: 'standard' };
    const BUDGET = { halted: null };
    const dbStub = {};
    const SStub = {
      getRuntimeState: () => { stateAsked++; return { enabled: true }; }, reapLeases() {}, heartbeat() {}, loadPolicy: () => budgetOn, sweepReviews() {},
      workspaceFor: () => ({ cwd: here }),
      claim: () => { order.push('claim'); return { ok: true, task: { version: 1 } }; },
      issueExecutionGrant: () => { order.push('grant'); return { ok: true, grant: { grant_id: 'g', roots: [here], redline: [], task_version: 1, expires_at: '2099-01-01T00:00:00Z' } }; },
      getExecutionGrant: () => ({ grant_id: 'g' }), revokeExecutionGrant() {}, renewLease: () => true, extendExecutionGrant: () => ({ ok: true }),
      deferExecutionTask() {},
      recordUsage: (_db, _agent, taskId, phase, tin, tout, reservationId) => {
        order.push('record:' + phase);
        reservationSeen = reservationId === undefined ? reservationSeen : reservationId;
        if (mode === 'budget-overrun') return { ok: true, overrun: true, actual: 900, reserved: 200, task_id: taskId };
        return { ok: true };
      },
      updateTask: (_db, _agent, _id, status, note) => { order.push(status); notes.push({ status, note }); return { ok: true }; },
      cursorOf: () => 0, setCursor() {},
      waitFor: async () => (mode === 'react-refused' ? { messages: [{ kind: 'note', sender: 'lead', thread: 't-budget', recipient: 'worker' }], next_seq: 1 } : { messages: [], next_seq: 0 }),
      escalate: (_db, taskId, kind) => { escalations.push({ taskId, kind }); return { ok: true, created: true }; },
      send: (_db, m) => { sent.push(m); return { ok: true }; },
    };
    const context = {
      S: SStub, db: dbStub, AGENT: 'worker', ENGINE: 'claude', IS_LEAD: false, policy: budgetOn, DRY: false, FAKE: false,
      skipped: new Set(), pickTask: () => (mode === 'react-refused' ? undefined : task), buildTaskPrompt: () => 'p',
      fs: { existsSync: () => true, mkdirSync() {}, writeFileSync() {} }, CODEX: {}, RUNNER: {}, DSH_PROFILE: 'worker', DSH_PATCH: 'patch', REPORT_MAX: 40,
      leadPermissions: () => ({ restricted: false }), reportText: text => String(text), filterLeadWake: m => m,
      snapshotAll: () => ({}), auditRun: () => ({ hard: [] }), summarize: out => out, extractTokens: () => ({ in: 1, out: 1 }),
      saveRawLog: () => null, AbortController, setInterval: fn => { interval = fn; return 1; }, clearInterval() {}, log() {},
      bounded: text => String(text || ''),
      CodexEngine: Codex,
      TASK_ENGINE: {
        capabilities: () => ({ strongWriteIsolation: true, networkIsolation: false }),
        spawnTask: async (_g, _p, opts) => { order.push('spawn'); spawned++; opts.signal.addEventListener('abort', () => { aborted = true; }); interval(); return { code: 0, out: 'done', tokens: { in: 1, out: 1 } }; },
      },
      runAgent: async () => { order.push('runAgent'); ranAgent++; return { code: 0, out: 'msg', tokens: { in: 1, out: 1 } }; },
      runCodex: async () => { order.push('runAgent'); ranAgent++; return { code: 0, out: 'msg', tokens: { in: 1, out: 1 } }; },
      waitFor: async () => (mode === 'react-refused' ? { messages: [{ kind: 'note', sender: 'lead', thread: 't-budget', recipient: 'worker' }], next_seq: 1 } : { messages: [], next_seq: 0 }),
      buildMessagePrompt: () => 'msg-prompt', msgRetry: new Map(), CURSOR_KEY: 'c', WAIT_MS: 5, setCursor() {}, cursorOf: () => 0,
      relevantOnly: msgs => msgs, autoAcceptReviews: msgs => msgs,
      budgetEnabled: vm.runInNewContext('(' + enabledBody + ')', {}),
      budgetStatusOf: vm.runInNewContext('(' + statusBody + ')', { S: SStub, db: dbStub }),
      BUDGET,
    };
    context.budgetNote = vm.runInNewContext('(' + noteBody + ')', context);
    context.haltOnOverrun = vm.runInNewContext('(' + haltBody + ')', context);
    context.budgetHalted = () => BUDGET.halted;
    context.reserveTurn = (cfg, taskId, phase, costClass) => {
      order.push('reserve:' + phase);
      if (mode === 'budget-refused') return { ok: false, reason: 'budget_exceeded', message: '当日额度已用尽' };
      if (mode === 'react-refused') return { ok: false, reason: 'budget_exceeded', message: '当日额度已用尽' };
      return { ok: true, reservation_id: 'res-' + phase };
    };
    if (mode === 'halted') BUDGET.halted = '上一轮已超支';
    const oneRound = vm.runInNewContext('(' + oneRoundBody + ')', context);
    const round = await oneRound(1);

    if (mode === 'halted') {
      ok(file + ' 预算超支后 oneRound 立刻返回 halted', round === 'halted' && stateAsked === 0 && order.length === 0, JSON.stringify({ round, stateAsked, order }));
    } else if (mode === 'budget-refused') {
      ok(file + ' reserve 失败时绝不启动 CLI', spawned === 0 && order.indexOf('spawn') < 0 && order.indexOf('runAgent') < 0, JSON.stringify(order));
      ok(file + ' reserve 失败时卡片置 failed 且 note 写明 budget_exceeded', notes.length > 0 && notes[notes.length - 1].status === 'failed' && /budget_exceeded/.test(String(notes[notes.length - 1].note)), JSON.stringify(notes));
      ok(file + ' reserve 失败时不产生预算升级（升级只属于 overrun）', escalations.length === 0 && sent.length === 0, JSON.stringify(escalations));
    } else if (mode === 'budget-ok') {
      ok(file + ' 拿到 reservation 后才启动 CLI', spawned === 1 && order.indexOf('reserve:execute') >= 0 && order.indexOf('reserve:execute') < order.indexOf('spawn'), JSON.stringify(order));
      ok(file + ' reservation_id 传给 recordUsage', reservationSeen === 'res-execute', JSON.stringify(reservationSeen));
      ok(file + ' 未超支时不升级、不置 halted', escalations.length === 0 && BUDGET.halted === null, JSON.stringify({ escalations, halted: BUDGET.halted }));
    } else if (mode === 'budget-overrun') {
      ok(file + ' overrun 时不强杀已启动的调用', spawned === 1 && aborted === false, JSON.stringify({ spawned, aborted }));
      ok(file + ' overrun 时当前原子步骤照常收尾（提交 review）', order.indexOf('review') > order.indexOf('record:execute') && notes.some(n => n.status === 'review'), JSON.stringify(order));
      ok(file + ' overrun 时登记 budget_overrun 升级并通知 human', escalations.some(e => e.kind === 'budget_overrun') && sent.some(m => m.kind === 'budget_overrun' && m.to === 'human'), JSON.stringify({ escalations, sent: sent.map(m => m.kind) }));
      ok(file + ' overrun 置进程级 halted（后续轮次停）', typeof BUDGET.halted === 'string' && /budget_overrun/.test(BUDGET.halted), BUDGET.halted);
      ok(file + ' overrun 写进 review note', notes.some(n => /budget_overrun/.test(String(n.note))), JSON.stringify(notes.map(n => String(n.note).slice(0, 60))));
    } else if (mode === 'react-refused') {
      ok(file + ' 消息回合 reserve 失败时不开模型', ranAgent === 0 && round === 'idle', JSON.stringify({ round, ranAgent }));
    }
  }
}

// ---------- 注册表 ----------
const budgetField = POLICY_FIELDS.find(f => f.path === 'economics.daily_token_budget');
ok('economics.daily_token_budget 已置为 enforced 且 owner=item-8', !!budgetField && budgetField.status === 'enforced' && budgetField.owner === 'item-8', JSON.stringify(budgetField));
ok('daily_token_budget 不再留「待第 8 项接线」', !!budgetField && !/待第 8 项接线/.test(budgetField.note), budgetField && budgetField.note);
ok('describePolicy 把日预算标为生效', describePolicy({ lead: 'lead', economics: { daily_token_budget: 1000 }, agents: {} }).find(f => f.path === 'economics.daily_token_budget').effective === true);
// 第 9 项的评审路由已接线（peer/lead 决定谁来验收）；合并权限仍未接线，必须继续如实标 planned。
ok('item-9 评审路由字段已置为 enforced 且 owner=item-9',
  ['economics.peer_review', 'economics.lead_review'].every(id => { const f = POLICY_FIELDS.find(x => x.path === id); return !!f && f.status === 'enforced' && f.owner === 'item-9' && !/待第 \d+ 项接线/.test(f.note); }),
  ['economics.peer_review', 'economics.lead_review'].map(id => id + '=' + ((POLICY_FIELDS.find(x => x.path === id) || {}).status)).join(' '));
ok('permissions.merge 已接线为 enforced 且 owner=item-11',
  (() => { const f = POLICY_FIELDS.find(x => x.path === 'permissions.merge'); return !!f && f.status === 'enforced' && f.owner === 'item-11' && !/待第 \d+ 项接线/.test(f.note); })(),
  JSON.stringify(POLICY_FIELDS.find(x => x.path === 'permissions.merge')));

// ---------- 数据层：真跑到就有数字，没落地就如实 SKIP ----------
if (typeof S.reserveTokens !== 'function') {
  skip('真 reserveTokens 预留/提交/不超卖', 'store.reserveTokens 未就绪（第 8 项数据层由并行任务实现）');
  skip('budgetStatus 汇总与过期释放', 'store.budgetStatus / releaseExpiredReservations 未就绪');
} else {
  const db = S.openDb(path.join(temp, 'budget.db'));
  try {
    S.setRuntimeState(db, 'human', true);
    const policy = { lead: 'lead', economics: { daily_token_budget: 500, default_turn_reserve: 200, budget_timezone: 'UTC' }, global: {}, agents: {} };
    const now = new Date().toISOString();
    const reserve = () => S.reserveTokens(db, policy, { agent: 'worker', taskId: null, phase: 'execute', costClass: 'standard', now });
    const first = reserve();
    ok('数据层真的能预留', first.ok === true && !!first.reservation_id && !!first.day_key, JSON.stringify(first));
    const second = reserve();
    ok('第二笔预留累加到已预留', second.ok === true && Number(second.reserved) === 200 && second.reserved_tokens === 200, JSON.stringify(second));
    // 余额只剩 100：数据层把请求夹到 100 而不是超卖成 600。
    const third = reserve();
    ok('余额不足时按剩余额度夹紧，不超卖', third.ok === true && third.reserved_tokens === 100 && third.clamped === true, JSON.stringify(third));
    const fourth = reserve();
    ok('额度用尽后明确拒绝 budget_exceeded', fourth.ok === false && fourth.reason === 'budget_exceeded', JSON.stringify(fourth));
    ok('拒绝时 detail 带额度/已预留/本次需求（供 Human 判断）',
      !!fourth.detail && typeof fourth.detail === 'object' && fourth.detail.limit === 500 && fourth.detail.reserved === 500 && fourth.detail.requested === 200,
      JSON.stringify(fourth.detail));
    const committed = S.recordUsage(db, 'worker', null, 'execute', 150, 150, first.reservation_id);
    ok('recordUsage 提交该 reservation 并把实际值完整记账', !!committed && committed.ok === true && committed.tokens_in === 150 && committed.tokens_out === 150 && committed.reservation_id === first.reservation_id, JSON.stringify(committed));
    ok('实际用量超过预留时返回 overrun=true', committed.overrun === true && committed.reserved_tokens === 200, JSON.stringify(committed));
    if (typeof S.budgetStatus === 'function') {
      const status = S.budgetStatus(db, policy, { agent: 'worker' });
      ok('budgetStatus 汇总已用/已预留/剩余',
        !!status && status.used === 300 && status.reserved === 300 && status.remaining === 0 && status.day_key === first.day_key,
        JSON.stringify(status));
      ok('budgetStatus 按 agent 下钻', Array.isArray(status.by_agent) && status.by_agent.some(a => a.agent === 'worker' && a.used === 300), JSON.stringify(status.by_agent));
      ok('预算时区写进汇总（policy.budget_timezone）', status.timezone === 'UTC', status.timezone);
    } else {
      skip('budgetStatus 汇总', 'store.budgetStatus 未就绪');
    }
    if (typeof S.releaseExpiredReservations === 'function') {
      const released = S.releaseExpiredReservations(db, now);
      ok('releaseExpiredReservations 不误放未过期的预留', released && released.released === 0, JSON.stringify(released));
    } else {
      skip('过期预留释放', 'store.releaseExpiredReservations 未就绪');
    }
  } finally { try { db.close(); } catch (e) {} }
}

try { fs.rmSync(temp, { recursive: true, force: true }); } catch (e) {}
console.log('\nPASS ' + pass + '   FAIL ' + fail);
if (fail) process.exitCode = 1;
