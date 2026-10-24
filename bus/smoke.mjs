// 逻辑层冒烟测试：直接打 store，验证守卫、状态机、租约与成本。不涉及 MCP 传输。
// 角色从 policy 读取，不写死 —— 换谁当 Lead 都不用改这个文件。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as S from './store.mjs';

const TDB = path.join(os.tmpdir(), 'agentbus-smoke-' + process.pid + '.db');
for (const f of [TDB, TDB + '-wal', TDB + '-shm']) { try { fs.unlinkSync(f); } catch (e) {} }

const db = S.openDb(TDB);
S.setRuntimeState(db, 'human', true);
const policy = S.loadPolicy();
const LEAD = policy.lead;                       // 谁是 Lead 由 policy 决定
const ACC = policy.permissions.accept;
const WORKERS = Object.keys(policy.agents).filter(function (a) { return a !== LEAD; });
const W1 = WORKERS[0];
const W2 = WORKERS[1] || WORKERS[0];

// 测试自己设定前提：所有 worker 一律 off 档起步，需要 auto 的用例自己改。
// 这样 policy.json 怎么调都不会让测试变红。
for (const w of WORKERS) {
  policy.agents[w].autonomy = 'off';
  policy.agents[w].max_open_from_agents = 0;
}

let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  PASS  ' + name); }
  else { fail++; console.log('  FAIL  ' + name + (extra !== undefined ? '  -> ' + JSON.stringify(extra).slice(0, 260) : '')); }
}
console.log('角色: LEAD=' + LEAD + '  W1=' + W1 + '  W2=' + W2);

console.log('[1] 授权守卫 G1（政策违规 -> 拒绝）');
const g1 = S.dispatch(db, policy, W2, { to: W1, title: '越权派活' });
ok('worker 不能派活', g1.ok === false && g1.reason === 'guard_G1_unauthorized', g1);

console.log('');
console.log('[2] autonomy=off -> 降级为 proposed（不拒绝）');
const d1 = S.dispatch(db, policy, LEAD, { to: W1, title: '登录页错误提示', project: 'proj-demo', write_scope: ['src/auth/*'], cost_class: 'standard' });
ok('派活成功', d1.ok === true, d1);
ok('状态是 proposed', d1.task.status === 'proposed', d1.task && d1.task.status);
ok('原因是 autonomy=off', d1.gated_by === 'autonomy=off', d1.gated_by);

console.log('');
console.log('[3] proposed 不能被直接认领');
const c0 = S.claim(db, W1, d1.task.id);
ok('待批任务认领被拒', c0.ok === false && c0.reason === 'needs_approval', c0);

console.log('');
console.log('[4] 批准 -> open -> 认领');
const acc = S.accept(db, LEAD, d1.task.id, ACC);
ok('批准后变 open', acc.ok === true && acc.task.status === 'open', acc);
const c1 = S.claim(db, W1, d1.task.id);
ok('认领成功', c1.ok === true && c1.task.owner === W1, c1);
ok('返回 workspace', !!(c1.workspace && c1.workspace.cwd && c1.workspace.branch), c1.workspace);
ok('clone-per-agent 无需文件锁', c1.workspace.lock_required === false, c1.workspace);

console.log('');
console.log('[5] 并发认领只有一个成功');
const d2 = S.dispatch(db, policy, LEAD, { to: W2, title: '第二个活', project: 'proj-demo' });
S.accept(db, LEAD, d2.task.id, ACC);
const raceA = S.claim(db, W2, d2.task.id);
const raceB = S.claim(db, W1, d2.task.id);
ok('先到者成功', raceA.ok === true, raceA);
ok('后到者被拒', raceB.ok === false, raceB);

console.log('');
console.log('[6] write_scope 重叠检测');
const d3 = S.dispatch(db, policy, LEAD, { to: W1, title: '同文件冲突', project: 'proj-demo', write_scope: ['src/auth/*'] });
S.accept(db, LEAD, d3.task.id, ACC);
const conflict = S.claim(db, W1, d3.task.id);
ok('重叠范围被拒', conflict.ok === false && conflict.reason === 'scope_conflict', conflict);

console.log('');
console.log('[7] 状态机迁移');
ok('claimed -> done 非法', S.updateTask(db, W1, d1.task.id, 'done').ok === false);
ok('claimed -> in_progress', S.updateTask(db, W1, d1.task.id, 'in_progress').ok === true);
ok('in_progress -> review', S.updateTask(db, W1, d1.task.id, 'review').ok === true);
const dn = S.updateTask(db, W1, d1.task.id, 'done', '改完 +42/-8，18 tests pass');
ok('review -> done', dn.ok === true && dn.task.status === 'done', dn);

console.log('');
console.log('[8] 消息幂等');
const m1 = S.send(db, { sender: W2, to: W1, kind: 'note', body: 'hi', msg_id: 'fixed-id-1' });
const m2 = S.send(db, { sender: W2, to: W1, kind: 'note', body: 'hi again', msg_id: 'fixed-id-1' });
ok('同一 msg_id 返回同一 seq', m1.seq === m2.seq, { m1: m1, m2: m2 });
ok('库里只有 1 条', Number(db.prepare('SELECT COUNT(*) c FROM messages WHERE msg_id = ?').get('fixed-id-1').c) === 1);

console.log('');
console.log('[9] bus_wait');
const before = S.cursorOf(db, W1);
const w = await S.waitFor(db, W1, before, 300);
ok('收到消息', w.messages.length > 0, w.messages.length);
ok('next_seq 前进', w.next_seq > before, { before: before, next: w.next_seq });
const w2 = await S.waitFor(db, W1, w.next_seq, 250);
ok('无消息时干净超时', w2.timed_out === true && w2.messages.length === 0, w2);

console.log('');
console.log('[10] 递归深度 G3');
policy.global.max_dispatch_depth = 1;
const deep = S.dispatch(db, policy, LEAD, { to: W1, title: '太深了', depth: 1 });
ok('深度超限被拒', deep.ok === false && deep.reason === 'guard_G3_depth', deep);
policy.global.max_dispatch_depth = 2;

console.log('');
console.log('[11] 配额 G2（负载问题 -> 降级为 proposed）');
policy.agents[W2].autonomy = 'auto';
policy.agents[W2].max_open_from_agents = 1;
const q = S.dispatch(db, policy, LEAD, { to: W2, title: '超配额的活', project: 'proj-demo' });
ok('不被拒绝', q.ok === true, q);
ok('降级为 proposed', q.task.status === 'proposed', q.task && q.task.status);
ok('原因含 quota', String(q.gated_by).indexOf('quota') === 0, q.gated_by);

console.log('');
console.log('[12] 总闸 G5');
policy.global.dispatch_enabled = false;
policy.agents[W2].max_open_from_agents = 9;
const shut = S.dispatch(db, policy, LEAD, { to: W2, title: '总闸关了', project: 'proj-demo' });
ok('停在 proposed', shut.ok === true && shut.task.status === 'proposed', shut.task && shut.task.status);
ok('原因 dispatch_enabled=false', shut.gated_by === 'dispatch_enabled=false', shut.gated_by);
policy.global.dispatch_enabled = true;

console.log('');
console.log('[13] 拒绝权 G4');
const dd = S.dispatch(db, policy, LEAD, { to: W2, title: '可能被拒的活', project: 'proj-demo' });
const dec = S.decline(db, W2, dd.task.id, '手上还有别的事', ACC);
ok('被派活方可拒绝并带理由', dec.ok === true && dec.task.status === 'declined' && dec.task.decline_reason === '手上还有别的事', dec);

console.log('');
console.log('[14] 人类直接建任务');
const ht = S.createTask(db, { title: '人直接建的活', status: 'open', origin: 'human', project: 'proj-demo' });
ok('human origin 默认 open', ht.status === 'open' && ht.origin === 'human', ht.status);

console.log('');
console.log('[15] 成本按"谁消耗"记账');
S.recordUsage(db, LEAD, null, 'plan', 1000, 500);
S.recordUsage(db, W1, d1.task.id, 'execute', 8000, 4000);
const cost = S.costSummary(db, LEAD);
ok('总消耗正确', cost.total === 13500, cost.total);
ok('Lead 占比正确', Math.abs(cost.lead_ratio - 1500 / 13500) < 1e-9, cost.lead_ratio);
ok('Lead 不持有任务也能记账', cost.lead === 1500, cost.lead);
ok('能按任务归集', cost.by_task.length === 1 && cost.by_task[0].t === 12000, cost.by_task);

console.log('');
console.log('[16] 定向派活不能被别人抢');
const t16 = S.dispatch(db, policy, LEAD, { to: W1, title: '定向给 W1', project: 'proj-demo' });
S.accept(db, LEAD, t16.task.id, ACC);
const steal = S.claim(db, W2, t16.task.id);
ok('非 target 认领被拒', steal.ok === false && steal.reason === 'not_target', steal);

console.log('');
console.log('[17] 验收流程：有验收权的人能把 review 推到 done');
const t17 = S.createTask(db, { title: '验收测试', status: 'open', origin: 'human', project: 'proj-demo' });
S.claim(db, W1, t17.id);
S.updateTask(db, W1, t17.id, 'in_progress');
S.updateTask(db, W1, t17.id, 'review');
const byNonAccepter = S.updateTask(db, W2, t17.id, 'done', '我来验收', null, ACC);
ok('无验收权的人不能收尾', byNonAccepter.ok === false && byNonAccepter.reason === 'not_owner', byNonAccepter);
const byLead = S.updateTask(db, LEAD, t17.id, 'done', '验收通过', null, ACC);
ok('Lead 验收通过', byLead.ok === true && byLead.task.status === 'done', byLead);

console.log('');
console.log('[18] 租约过期自动回收');
const t18 = S.createTask(db, { title: '会卡死的任务', status: 'open', origin: 'human', project: 'proj-demo' });
S.claim(db, W1, t18.id, -1);
ok('已认领但租约过期', S.getTask(db, t18.id).status === 'claimed');
const reaped = S.reapLeases(db, true);
const t18after = S.getTask(db, t18.id);
ok('回收器退回 open', reaped >= 1 && t18after.status === 'open' && t18after.owner === null, { reaped: reaped, s: t18after.status });

console.log('');
console.log('[19] 自己发的消息不会回给自己');
const myCursor = S.cursorOf(db, W1);
S.send(db, { sender: W1, to: 'broadcast', kind: 'status', body: '我自己发的一条', msg_id: 'self-echo-1' });
const w19 = await S.waitFor(db, W1, myCursor, 400);
ok('取不到自己发的那条', !w19.messages.some(function (x) { return x.msg_id === 'self-echo-1'; }), w19.messages.length);

console.log('');
console.log('[20] 批准权受 permissions.accept 约束');
const t20b = S.createTask(db, { title: '另一个待批', status: 'proposed', origin: 'agent:' + LEAD, project: 'proj-demo' });
ok('无批准权的人被拒', S.accept(db, W2, t20b.id, ACC).reason === 'not_permitted');

console.log('');
console.log('[21] 项目可以不在本工作目录下');
const ws21 = S.workspaceFor(db, 'proj-demo', W1, 't-9999');
ok('能解析出 root 和 cwd', !!ws21.root && !!ws21.cwd, ws21);
const wsAbs = S.workspaceFor(db, 'D:/somewhere/else/myproj', W2, 't-9998');
ok('绝对路径直接可用', wsAbs.root.indexOf('somewhere') >= 0, wsAbs.root);

console.log('');
console.log('[22] 长任务续租后不会被回收');
const t22 = S.createTask(db, { title: '长任务', status: 'open', origin: 'human', project: 'proj-demo' });
S.claim(db, W2, t22.id, -1);
S.reapLeases(db, true);
S.claim(db, W2, t22.id, 15);
ok('续租成功', S.renewLease(db, W2, t22.id, 15) === true);
S.reapLeases(db, true);
ok('续租后不会被回收', S.getTask(db, t22.id).status === 'claimed', S.getTask(db, t22.id).status);
ok('非 owner 不能续租', S.renewLease(db, W1, t22.id, 15) === false);

console.log('');
console.log('[23] 人类在看板上能拒绝待批任务');
const d23 = S.dispatch(db, policy, LEAD, { to: W1, title: '待人类拒绝', project: 'proj-demo' });
ok('任务停在 proposed', d23.task.status === 'proposed', d23.task.status);
const rejHuman = S.decline(db, 'human', d23.task.id, '人类拒绝', ACC);
ok('human 能拒绝', rejHuman.ok === true && rejHuman.task.status === 'declined', rejHuman);
const d23b = S.dispatch(db, policy, LEAD, { to: W1, title: '无关方尝试拒绝', project: 'proj-demo' });
const rejOther = S.decline(db, W2, d23b.task.id, '我管不着', ACC);
ok('无关方仍被拒', rejOther.ok === false && rejOther.reason === 'not_yours', rejOther);

console.log('');
console.log('==================================');
console.log('PASS ' + pass + '   FAIL ' + fail);
for (const f of [TDB, TDB + '-wal', TDB + '-shm']) { try { fs.unlinkSync(f); } catch (e) {} }
process.exit(fail ? 1 : 0);
