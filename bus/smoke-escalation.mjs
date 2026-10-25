// 第 7 项的上层验收：升级事件只到 Lead/Human、supervisor 见到升级不再启动模型、
// 注册表把 max_chain_len / max_rounds_per_task 标为 enforced（owner item-7）。
// 数据层（store.retryTask / send 的 hop+chain_root / task_escalations）由并行任务实现，
// 这里按契约探测：就绪就真跑，未就绪就 SKIP 并打印，绝不假装验证过。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import * as S from './store.mjs';
import { POLICY_FIELDS, describePolicy, filterLeadWake } from './policy-runtime.mjs';
import {
  isEscalationKind, isRelevantMessage, routeMessages, ESCALATION_KINDS, canAutoAccept,
} from './message-routing.mjs';
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
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'agentbus-escalation-'));

function sliceFunction(source, header) {
  // Windows 检出可能是 CRLF：先归一化，否则 '\n}\n' 永远找不到边界。
  source = String(source).replace(/\r\n/g, '\n');
  const start = source.indexOf(header);
  assert(start >= 0, '找不到：' + header);
  const end = source.indexOf('\n}\n', start);
  assert(end > start, '函数边界变了：' + header);
  return source.slice(start, end + 3);
}
function sliceBetween(source, header, tail) {
  source = String(source).replace(/\r\n/g, '\n');
  const start = source.indexOf(header);
  const end = source.indexOf(tail, start);
  assert(start >= 0 && end > start, '边界变了：' + header);
  return source.slice(start, end).trim();
}

// ---------- [1] 路由：升级事件只给 Lead ----------
const workerCtx = { agent: 'codex/main', isLead: false, mine: new Set(['t-1']), getTask: () => ({ status: 'open' }) };
const leadCtx = { agent: 'lead', isLead: true, mine: new Set(), getTask: () => ({ status: 'open' }) };
const chainLimit = { kind: 'chain_limit', sender: 'lead', recipient: 'codex/main', thread: 't-1', refs: { task: 't-1' }, body: 'x' };
const retryExceeded = { kind: 'retry_exceeded', sender: 'lead', recipient: 'codex/main', thread: 't-1', refs: { task: 't-1' }, body: 'x' };
const threadOnly = { kind: 'chain_limit', sender: 'lead', recipient: 'thread:t-1', thread: 't-1', body: 'x' };
const plainNote = { kind: 'note', sender: 'lead', recipient: 'thread:t-1', thread: 't-1', body: 'x' };

ok('ESCALATION_KINDS 只包含这两类', ESCALATION_KINDS.join(',') === 'retry_exceeded,chain_limit', ESCALATION_KINDS.join(','));
ok('isEscalationKind 认两类升级事件', isEscalationKind(chainLimit) && isEscalationKind(retryExceeded));
ok('isEscalationKind 不误伤普通消息与 failed', !isEscalationKind(plainNote) && !isEscalationKind({ kind: 'task.failed' }) && !isEscalationKind(null));
ok('worker 不被点名式 chain_limit 唤醒', isRelevantMessage(chainLimit, workerCtx) === false);
ok('worker 不被点名式 retry_exceeded 唤醒', isRelevantMessage(retryExceeded, workerCtx) === false);
ok('worker 在自己 thread 里的 chain_limit 也不唤醒', isRelevantMessage(threadOnly, workerCtx) === false);
ok('Lead 收到 chain_limit', isRelevantMessage(chainLimit, leadCtx) === true);
ok('Lead 收到 retry_exceeded', isRelevantMessage(retryExceeded, leadCtx) === true);
ok('普通 note 仍唤醒 worker（回归）', isRelevantMessage(plainNote, workerCtx) === true);
const workerBatch = routeMessages([chainLimit, retryExceeded, threadOnly, plainNote], workerCtx);
ok('routeMessages 对 worker 只留下普通消息', workerBatch.length === 1 && workerBatch[0].kind === 'note', JSON.stringify(workerBatch.map(m => m.kind)));
const leadBatch = routeMessages([chainLimit, retryExceeded, plainNote], leadCtx);
// note 本来就不唤醒 Lead（既有规则），所以这里只要求两类升级事件被保留。
ok('routeMessages 对 Lead 保留升级事件',
  leadBatch.length === 2 && leadBatch.map(m => m.kind).sort().join(',') === 'chain_limit,retry_exceeded',
  JSON.stringify(leadBatch.map(m => m.kind)));
ok('canAutoAccept 不因本次改动变化（回归）',
  canAutoAccept({ status: 'review', cost_class: 'mechanical', guard: { ok: true, hard: [], truncated: false } }, { economics: { auto_accept: ['mechanical'] } }) === true &&
  canAutoAccept({ status: 'review', cost_class: 'mechanical', needs_human: 1, guard: { ok: true, hard: [], truncated: false } }, { economics: { auto_accept: ['mechanical'] } }) === false);

// ---------- [2] 注册表：这两项真的被标为 enforced ----------
const byPath = id => POLICY_FIELDS.find(f => f.path === id);
for (const [id, word] of [['global.max_chain_len', 'chain_limit'], ['economics.max_rounds_per_task', 'retry']]) {
  const entry = byPath(id);
  ok(id + ' 已置为 enforced', !!entry && entry.status === 'enforced', entry && entry.status);
  ok(id + ' 保留 owner=item-7', !!entry && entry.owner === 'item-7', entry && entry.owner);
  ok(id + ' 不再留「待第 7 项接线」', !!entry && !/待第 7 项接线/.test(entry.note), entry && entry.note);
  ok(id + ' note 说明实际执行点', !!entry && entry.note.indexOf(word) >= 0, entry && entry.note);
}
const described = describePolicy({ lead: 'lead', agents: { 'codex/main': { autonomy: 'auto' } }, global: { max_chain_len: 3 }, economics: { max_rounds_per_task: 2 } });
ok('describePolicy 把这两项标为生效',
  described.find(f => f.path === 'global.max_chain_len').effective === true &&
  described.find(f => f.path === 'economics.max_rounds_per_task').effective === true);
ok('注册表条目自身仍是合法形状（回归）',
  POLICY_FIELDS.every(f => ['config', 'dispatch', 'wake', 'review', 'report'].indexOf(f.stage) >= 0 && ['enforced', 'planned'].indexOf(f.status) >= 0 && !!f.note) &&
  new Set(POLICY_FIELDS.map(f => f.path)).size === POLICY_FIELDS.length);
// 第 7 项的数据层字段已由 smoke-limits 覆盖执行行为，标 enforced；第 8/9 项仍未接线，必须仍标 planned —— 不替别人宣布完成。
const item7Enforced = ['global.max_chain_len', 'economics.max_rounds_per_task', 'global.rate_per_agent_per_hour',
  'economics.max_subagents', 'agents.*.max_concurrent', 'agents.*.scope_allowlist'];
ok('第 7 项字段已标 enforced 且带 owner',
  item7Enforced.every(id => { const f = byPath(id); return !!f && f.status === 'enforced' && /^(item-\d+|lead)$/.test(f.owner); }),
  item7Enforced.map(id => id + '=' + (byPath(id) || {}).status).join(' '));

// 第 7/8/9 项已接线：这些必须 enforced；只有合并权限还没接线，必须仍标 planned。
// 第 7/8/9/11 项已全部接线：注册表里不应再有 planned 字段。
ok('注册表已无 planned 字段（第 1–11 项全部接线）',
  POLICY_FIELDS.filter(f => f.status === 'planned').length === 0,
  POLICY_FIELDS.filter(f => f.status === 'planned').map(f => f.path).join(','));
const wiredNow = ['global.max_chain_len', 'economics.max_rounds_per_task', 'global.rate_per_agent_per_hour',
  'economics.max_subagents', 'agents.*.max_concurrent', 'agents.*.scope_allowlist', 'economics.daily_token_budget',
  'economics.peer_review', 'economics.lead_review', 'permissions.merge'];
ok('第 7/8/9 项已接线的字段全部 enforced 且不带「待接线」话术',
  wiredNow.every(id => { const f = byPath(id); return !!f && f.status === 'enforced' && !/待第 \d+ 项接线/.test(f.note); }),
  wiredNow.map(id => id + '=' + (byPath(id) || {}).status).join(' '));

// ---------- [3] 唤醒过滤：升级事件不再被 lead_wake_on 静默丢弃 ----------
const leadWake = [{ kind: 'task.failed', thread: 't-1' }, { kind: 'note', thread: 't-1' }];
const filtered = filterLeadWake(leadWake, { economics: { lead_wake_on: ['retry_exceeded'] } }, true);
ok('filterLeadWake 行为未被本次改动破坏（回归）', filtered.length === 1 && filtered[0].kind === 'task.failed', JSON.stringify(filtered.map(m => m.kind)));

// ---------- [4] supervisor：升级事件只上报、不喂模型 ----------
for (const file of STUDIED) {
  const source = fs.readFileSync(path.join(here, file), 'utf8');
  const body = sliceFunction(source, 'function absorbEscalations(msgs) {');
  const logged = [];
  const absorb = vm.runInNewContext('(' + body + ')', { isEscalationKind, refTaskId: m => (m.refs && m.refs.task) || m.thread || null, log: line => logged.push(line) });
  const kept = absorb([chainLimit, plainNote, retryExceeded]);
  ok(file + ' 把升级事件从模型回合里摘掉', kept.length === 1 && kept[0].kind === 'note', JSON.stringify(kept.map(m => m.kind)));
  ok(file + ' 升级事件只上报状态（日志记 kind/task/sender）',
    logged.length === 2 && logged.every(line => /升级事件只上报状态、不启动模型/.test(line)) &&
    logged.some(line => /chain_limit/.test(line) && /t-1/.test(line)), JSON.stringify(logged));
  ok(file + ' 上报日志不含消息正文', logged.every(line => line.indexOf('body') < 0 && line.indexOf('x') !== line.length - 1));
}

// ---------- [5] supervisor：已存在 escalation 的任务不再执行 ----------
const escDb = S.openDb(path.join(temp, 'esc.db'));
escDb.prepare('CREATE TABLE IF NOT EXISTS task_escalations(task_id TEXT, kind TEXT, created_at TEXT)').run();
escDb.prepare('INSERT INTO task_escalations(task_id,kind,created_at) VALUES(?,?,?)').run('t-esc', 'retry_exceeded', new Date().toISOString());
const bareDb = S.openDb(path.join(temp, 'bare.db'));
bareDb.prepare('DROP TABLE IF EXISTS task_escalations').run();
for (const file of STUDIED) {
  const source = fs.readFileSync(path.join(here, file), 'utf8');
  const body = sliceFunction(source, 'function escalationBlocks(taskId) {');
  const withTable = vm.runInNewContext('(' + body + ')', { db: escDb });
  const withoutTable = vm.runInNewContext('(' + body + ')', { db: bareDb });
  ok(file + ' 读到已存在的升级', JSON.stringify(withTable('t-esc')) === JSON.stringify(['retry_exceeded']), JSON.stringify(withTable('t-esc')));
  ok(file + ' 没有升级的任务返回空', withTable('t-none').length === 0);
  ok(file + ' 表不存在时不抛错也不挡正常任务', Array.isArray(withoutTable('t-esc')) && withoutTable('t-esc').length === 0);
}

// oneRound 的真实装配：注入 escalationBlocks 才能覆盖"见到升级就停"的分支
for (const file of STUDIED) {
  const source = fs.readFileSync(path.join(here, file), 'utf8');
  const body = sliceBetween(source, 'async function oneRound(roundNo) {', '\nasync function main()');
  for (const mode of ['escalated', 'clear']) {
    const order = [], emitted = [];
    let interval, spawned = 0;
    const task = { id: 't-esc', project: 'x', version: 0, extra_dirs: [] };
    const skipped = new Set();
    const context = {
      S: {
        getRuntimeState: () => ({ enabled: true }), reapLeases() {}, heartbeat() {}, loadPolicy: () => ({ lead: 'lead' }), sweepReviews() {}, workspaceFor: () => ({ cwd: here }),
        claim: () => { order.push('claim'); return { ok: true, task: { version: 1 } }; },
        issueExecutionGrant: () => { order.push('grant'); return { ok: true, grant: { grant_id: 'g', roots: [here], redline: [], task_version: 1, expires_at: '2099-01-01T00:00:00Z' } }; },
        getExecutionGrant: () => ({ grant_id: 'g' }), revokeExecutionGrant() {}, renewLease: () => true, extendExecutionGrant: () => ({ ok: true }),
        deferExecutionTask() {}, recordUsage() {}, updateTask: (_db, _agent, _id, status) => { order.push(status); emitted.push(status); },
      },
      CodexEngine: Codex,
      TASK_ENGINE: { capabilities: () => ({ strongWriteIsolation: true, networkIsolation: false }), spawnTask: async () => { order.push('spawn'); spawned++; interval(); return { code: 0, out: 'done', tokens: { in: 1, out: 1 } }; } },
      AGENT: 'worker', ENGINE: 'claude', IS_LEAD: false, policy: { lead: 'lead' }, db: {}, DRY: false, FAKE: false, skipped,
      pickTask: () => task, buildTaskPrompt: () => 'p', fs: { existsSync: () => true, mkdirSync() {}, writeFileSync() {} },
      CODEX: {}, RUNNER: {}, DSH_PROFILE: 'worker', DSH_PATCH: 'patch', REPORT_MAX: 40,
      leadPermissions: () => ({ restricted: false }), reportText: text => String(text), filterLeadWake: m => m,
      snapshotAll: () => ({}), auditRun: () => ({ hard: [] }), summarize: out => out, extractTokens: () => ({ in: 1, out: 1 }),
      saveRawLog: () => null, AbortController, setInterval: fn => { interval = fn; return 1; }, clearInterval() {},
      log() {},
      escalationBlocks: () => (mode === 'escalated' ? ['retry_exceeded'] : []),
      waitFor: async () => ({ messages: [], next_seq: 0 }),
    };
    context.bounded = text => String(text || '');
    const oneRound = vm.runInNewContext('(' + body + ')', context);
    const round = await oneRound(1);
    if (mode === 'escalated') {
      ok(file + ' 已有升级的任务：不认领、不启动模型', order.length === 0 && spawned === 0, JSON.stringify(order));
      ok(file + ' 已有升级的任务：本轮按 worked 收尾并跳过后续扫描', round === 'worked' && skipped.has('t-esc'), round + ' skipped=' + skipped.has('t-esc'));
    } else {
      ok(file + ' 没有升级时照常执行（不是无脑阻断）', order[0] === 'claim' && spawned === 1, JSON.stringify(order));
    }
  }
}

// ---------- [6] 数据层契约：数据层已落地就真跑，未落地就如实 SKIP ----------
if (typeof S.retryTask !== 'function') {
  skip('retryTask 与轮次上限', 'store.retryTask 未就绪（第 7 项数据层由并行任务实现）');
} else {
  const db = S.openDb(path.join(temp, 'limits.db'));
  try {
    S.setRuntimeState(db, 'human', true);
// unknown_agent 现在是硬拒：占位 actor 必须登记进**本套件自己的临时策略**（真实 policy 打底，不设任何白名单后门）。
const placeholderPolicy = path.join(temp, 'policy-placeholder.json');
const placeholderBase = JSON.parse(fs.readFileSync(path.join(S.BUS_DIR, 'policy.json'), 'utf8'));
placeholderBase.agents = Object.assign({}, placeholderBase.agents, {
  worker: { autonomy: 'auto', may_dispatch_to: ['*'], max_open_from_agents: 100, max_concurrent: 5 },
});
fs.writeFileSync(placeholderPolicy, JSON.stringify(placeholderBase));
process.env.BUS_POLICY_PATH = placeholderPolicy;
    const task = S.createTask(db, { title: 'retry', project: temp, status: 'open', target: 'worker' });
    const limit = Number((S.getTask(db, task.id) || {}).retry_limit || 0) || 2;
    S.claim(db, 'worker', task.id);
    S.updateTask(db, 'worker', task.id, 'failed', '第一次失败');
    const first = S.retryTask(db, 'worker', task.id, '重试一次');
    ok('retryTask 首次重试成功并回到 open', first.ok === true && S.getTask(db, task.id).status === 'open' && Number(S.getTask(db, task.id).round_count) === 1, JSON.stringify({ ok: first.ok, round: (S.getTask(db, task.id) || {}).round_count }));
    let over = null;
    for (let i = 0; i < 8 && !over; i++) {
      if (S.getTask(db, task.id).status === 'open') S.claim(db, 'worker', task.id);
      S.updateTask(db, 'worker', task.id, 'failed', '再次失败 ' + i);
      const again = S.retryTask(db, 'worker', task.id, '继续重试 ' + i);
      if (!again.ok) over = again;
    }
    ok('超过 retry_limit 时 retryTask 返回 retry_exceeded', !!over && over.reason === 'retry_exceeded', JSON.stringify(over && { reason: over.reason, message: over.message }));
    const rows = db.prepare('SELECT kind FROM task_escalations WHERE task_id=?').all(task.id);
    ok('超额写一条 retry_exceeded 升级', rows.length === 1 && rows[0].kind === 'retry_exceeded', JSON.stringify(rows) + ' limit=' + limit);
    const second = S.retryTask(db, 'worker', task.id, '仍然超额');
    const rows2 = db.prepare('SELECT kind FROM task_escalations WHERE task_id=?').all(task.id);
    ok('同一 (task, kind) 只升级一次', second.ok === false && second.escalation_created === false && rows2.length === 1, JSON.stringify({ created: second.escalation_created, rows: rows2.length }));
    const openTask = S.createTask(db, { title: 'open', project: temp, status: 'open', target: 'worker' });
    S.claim(db, 'worker', openTask.id);
    ok('非 failed/评审退回的任务不能重试', S.retryTask(db, 'worker', openTask.id, 'x').reason === 'not_retryable');

    // 消息链：有父消息时 hop=父+1 并继承 chain_root；超过 max_chain_len 时原消息不入库，
    // 改写成一条只给 Lead/Human 的 chain_limit 事件。
    const chainPolicy = { lead: 'lead', global: { max_chain_len: 1 }, economics: {} };
    const a = S.send(db, { policy: chainPolicy, sender: 'worker', to: 'lead', kind: 'note', body: 'a' });
    const b = S.send(db, { policy: chainPolicy, sender: 'lead', to: 'worker', kind: 'answer', body: 'b', reply_to: a.msg_id });
    ok('reply_to 让 hop 递增且继承同一个 chain_root', a.hop === 0 && b.hop === 1 && b.chain_root === a.chain_root, JSON.stringify({ a: a.hop, b: b.hop }));
    const c = S.send(db, { policy: chainPolicy, sender: 'worker', to: 'lead', kind: 'note', body: 'c', reply_to: b.msg_id });
    ok('超过 max_chain_len 时原消息被丢弃', c.chain_limited === true && c.dropped === true && c.hop === 2, JSON.stringify({ hop: c.hop, dropped: c.dropped }));
    // 数据层契约：原消息不入库，chain_limit 事件由 escalateWithEvent 单独发出，send() 不返回可引用的消息。
    ok('被阻断时 send 不返回可引用的消息', c.msg_id === null && c.seq === null, JSON.stringify({ msg_id: c.msg_id, seq: c.seq }));
    const cRow = db.prepare("SELECT * FROM messages WHERE kind='chain_limit' ORDER BY seq DESC LIMIT 1").get();
    // 按 escalateWithEvent 的语义：发给 policy.lead，只有 lead 是 human 时才降级成 'human'。断言不写死字面量。
    const expectedRecipient = (chainPolicy.lead && chainPolicy.lead !== 'human') ? chainPolicy.lead : 'human';
    ok('改写后的 chain_limit 只发给 Lead/Human',
      !!cRow && cRow.kind === 'chain_limit' && cRow.recipient === expectedRecipient && cRow.recipient !== 'worker',
      cRow && (cRow.kind + '->' + cRow.recipient + ' expect=' + expectedRecipient));
    ok('chain_limit 事件带 escalation 标注', !!cRow && /escalation/.test(String(cRow.refs || '')), cRow && cRow.refs);
    const original = db.prepare("SELECT COUNT(*) AS n FROM messages WHERE body='c'").get();
    ok('被阻断的原消息没有落库', Number(original.n) === 0, String(original.n));
    const chainRows = db.prepare("SELECT task_id FROM task_escalations WHERE kind='chain_limit'").all();
    ok('链路超限写一条 chain_limit 升级', chainRows.length === 1, JSON.stringify(chainRows));
    const c2 = S.send(db, { policy: chainPolicy, sender: 'worker', to: 'lead', kind: 'note', body: 'd', reply_to: b.msg_id });
    ok('链路超限同样只升级一次', c2.escalation_created === false && db.prepare("SELECT COUNT(*) AS n FROM task_escalations WHERE kind='chain_limit'").get().n === 1);

    // lead 被设成 human 时必须降级发给 'human'，不能发去某个 agent 名。
    const humanPolicy = { lead: 'human', global: { max_chain_len: 1 }, economics: {} };
    const h1 = S.send(db, { policy: humanPolicy, sender: 'worker', to: 'worker', thread: 't-human-chain', kind: 'note', body: 'h1' });
    const h2 = S.send(db, { policy: humanPolicy, sender: 'worker', to: 'worker', thread: 't-human-chain', kind: 'note', body: 'h2', reply_to: h1.msg_id });
    const h3 = S.send(db, { policy: humanPolicy, sender: 'worker', to: 'worker', thread: 't-human-chain', kind: 'note', body: 'h3', reply_to: h2.msg_id });
    const hRow = db.prepare("SELECT * FROM messages WHERE kind='chain_limit' AND thread='t-human-chain' ORDER BY seq DESC LIMIT 1").get();
    ok('lead=human 时 chain_limit 降级发给 human', h3.chain_limited === true && !!hRow && hRow.recipient === 'human', hRow && hRow.recipient);

    // 上游产物喂回路由：worker 不被唤醒、Lead 收到。
    const chainMessage = { kind: 'chain_limit', sender: 'system', recipient: 'lead', thread: cRow && cRow.thread, refs: cRow && cRow.refs };
    ok('真实 chain_limit 事件不唤醒 worker', isRelevantMessage(chainMessage, workerCtx) === false);
    ok('真实 chain_limit 事件进入 Lead', isRelevantMessage(chainMessage, leadCtx) === true);
    // 已被升级的任务在 supervisor 眼里必须被挡住（用真实 db 跑抽取出来的 escalationBlocks）。
    const blocked = vm.runInNewContext('(' + sliceFunction(fs.readFileSync(path.join(here, STUDIED[0]), 'utf8'), 'function escalationBlocks(taskId) {') + ')', { db });
    ok('真实升级记录能被 supervisor 读到并停手', JSON.stringify(blocked(task.id)) === JSON.stringify(['retry_exceeded']), JSON.stringify(blocked(task.id)));
  } finally { try { db.close(); } catch (e) {} }
}

try { fs.rmSync(temp, { recursive: true, force: true }); } catch (e) {}
console.log('\nPASS ' + pass + '   FAIL ' + fail);
if (fail) process.exitCode = 1;
