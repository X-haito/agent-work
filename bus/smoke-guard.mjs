// 红线/守卫回归测试：分类矩阵、派活门禁、授权链路、事后审计、宽改动、人类专审、超时升级、人类放行。
// 全程只用临时目录里的临时库 + 临时策略（BUS_POLICY_PATH），不碰真实 bus.db 与 bus/policy.json。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as S from './store.mjs';
import * as G from './guard.mjs';
import * as R from './redline.mjs';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'agentbus-guard-'));
const TDB = path.join(TMP, 'bus.db');
const POLICY = path.join(TMP, 'policy.json');

// 策略自己造，不从真实 policy.json 复制：超时与宽改动上限写死，换谁调仓都不会让这个文件变红
const POLICY_OBJ = {
  lead: 'dsh/main',
  redline: { human_only: R.KINDS.slice() },
  permissions: { dispatch: ['dsh/main'], accept: ['dsh/main', 'human'], merge: ['human'], reassign: ['dsh/main'] },
  global: { dispatch_enabled: true, max_dispatch_depth: 2 },
  economics: { max_changed_files: 20, review_timeout_min: 30 },
  agents: {
    'dsh/main': { autonomy: 'auto', may_dispatch_to: [], max_open_from_agents: 3, max_concurrent: 1 },
    'codex/main': { autonomy: 'auto', may_dispatch_to: [], max_open_from_agents: 3, max_concurrent: 1 },
    'claude/main': { autonomy: 'auto', may_dispatch_to: [], max_open_from_agents: 3, max_concurrent: 1 },
  },
};
fs.writeFileSync(POLICY, JSON.stringify(POLICY_OBJ, null, 2));
process.env.BUS_POLICY_PATH = POLICY;          // 让 loadPolicy() 只认这个临时文件
const pol = S.loadPolicy();
const LEAD = pol.lead;
const ACC = pol.permissions.accept;
const WORKERS = Object.keys(pol.agents).filter(function (a) { return a !== LEAD; });
const W1 = WORKERS[0];

let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  PASS  ' + name); }
  else { fail++; console.log('  FAIL  ' + name + (extra !== undefined ? '  -> ' + JSON.stringify(extra).slice(0, 260) : '')); }
}
// 库里 redline/grants 是 JSON 文本，getTask 原样返回；这里统一成数组
function arrOf(v) {
  if (v == null) return [];
  if (Array.isArray(v)) return v.filter(Boolean);
  try { const p = JSON.parse(String(v)); return Array.isArray(p) ? p.filter(Boolean) : []; } catch (e) { return []; }
}

console.log('角色: LEAD=' + LEAD + '  W1=' + W1 + '  ACC=' + ACC.join(','));
// 逐字对得上临时策略 = 证明运行时没读过真实 bus/policy.json
ok('策略逐字等于临时文件', JSON.stringify(pol) === JSON.stringify(POLICY_OBJ), Object.keys(pol));

console.log('');
console.log('[A] 红线分类矩阵');
const TEXT_CASES = [
  ['npm install left-pad', 'dep:install'],
  ['npm i', 'dep:install'],
  ['npm ci', 'dep:install'],
  ['pnpm add zod', 'dep:install'],
  ['pip install requests', 'dep:install'],
  ['cargo add serde', 'dep:install'],
  ['npm test', null],
  ['npm run build', null],
  ['npm init -y', null],
  ['git status', null],
  ['已经确认没有 rm 过任何东西', null],
  ['rm -rf build', 'fs:delete'],
  ['Remove-Item -Recurse dist', 'fs:delete'],
  ['git push origin main', 'git:risky'],
  ['git reset --hard origin/main', 'git:risky'],
  ['curl https://example.com/x.json', 'net:egress'],
];
for (const c of TEXT_CASES) {
  const got = R.classifyText(c[0]);
  if (c[1]) ok('「' + c[0] + '」 -> ' + c[1], got.indexOf(c[1]) >= 0, got);
  else ok('「' + c[0] + '」 不命中红线', got.length === 0, got);
}
ok('write_scope 含 RULES.md -> cfg:edit', R.classifyPaths(['RULES.md']).indexOf('cfg:edit') >= 0, R.classifyPaths(['RULES.md']));
ok('write_scope 含 bus/policy.json -> cfg:edit', R.classifyPaths(['bus/policy.json']).indexOf('cfg:edit') >= 0, R.classifyPaths(['bus/policy.json']));
ok('普通路径不命中红线', R.classifyPaths(['src/auth/login.ts']).length === 0, R.classifyPaths(['src/auth/login.ts']));
ok('5 种 kinds 都算人类专属', R.KINDS.length === 5 && R.KINDS.every(function (k) { return R.isHumanOnly([k], pol); }), R.KINDS);

console.log('');
console.log('[B] 派活门禁：卡面命令命中红线 -> proposed');
const db = S.openDb(TDB);
S.setRuntimeState(db, 'human', true);
const dB = S.dispatch(db, pol, LEAD, { to: W1, title: '给项目装依赖', body: '跑 pip install requests 然后重跑测试', project: 'proj-guard' });
ok('派活成功', dB.ok === true, dB);
ok('停在 proposed', dB.task.status === 'proposed', dB.task && dB.task.status);
const redRow = S.getTask(db, dB.task.id);
ok('落库的 redline 非空', arrOf(redRow.redline).length > 0, redRow.redline);
ok('redline 含 dep:install', arrOf(redRow.redline).indexOf('dep:install') >= 0, redRow.redline);
ok('gated_by 以 redline: 开头', String(dB.gated_by).indexOf('redline:') === 0, dB.gated_by);

console.log('');
console.log('[C] 授权链路：非人类批不了；人类批准即授权');
const denyC = S.accept(db, LEAD, dB.task.id, ACC);
ok('非 human accept 被拒', denyC.ok === false && denyC.reason === 'redline_human_only', denyC);
ok('被拒后 grants 仍为空', arrOf(S.getTask(db, dB.task.id).grants).length === 0, S.getTask(db, dB.task.id).grants);
ok('被拒后仍是 proposed', S.getTask(db, dB.task.id).status === 'proposed', S.getTask(db, dB.task.id).status);
const accC = S.accept(db, 'human', dB.task.id, ACC);
ok('human accept -> open', accC.ok === true && accC.task.status === 'open', accC);
const granted = S.getTask(db, dB.task.id);
ok('grants 含 dep:install', arrOf(granted.grants).indexOf('dep:install') >= 0, granted.grants);
// 用真实快照复核：批准过的卡改 package.json 不该再被判违规
const WS = path.join(TMP, 'ws');
fs.mkdirSync(WS, { recursive: true });
fs.writeFileSync(path.join(WS, 'index.js'), 'console.log(1)\n');
fs.writeFileSync(path.join(WS, 'package.json'), '{"name":"demo"}\n');
const wsBefore = G.snapshot(WS);
fs.writeFileSync(path.join(WS, 'package.json'), '{"name":"demo","dependencies":{"requests":"2.31.0"}}\n');
const wsAfter = G.snapshot(WS);
const auditOk = G.audit({ task: granted, ws: { cwd: WS }, before: wsBefore, after: wsAfter, policy: pol });
ok('复核：批准后 hard 为空', auditOk.ok === true && auditOk.hard.length === 0, auditOk.hard);
ok('复核：changed_files = 1', auditOk.changed_files === 1, auditOk.changed_files);
const auditCtrl = G.audit({ task: { grants: [] }, ws: { cwd: WS }, before: wsBefore, after: wsAfter, policy: pol });
ok('对照：无 grants 时 hard 含 dep:install', auditCtrl.ok === false && auditCtrl.hard.some(function (h) { return h.kind === 'dep:install'; }), auditCtrl.hard);

console.log('');
console.log('[D] 事后审计四类 hard（每条配放行对照）');
const DW = path.join(TMP, 'audit');
function fixture(files) {
  fs.rmSync(DW, { recursive: true, force: true });
  fs.mkdirSync(DW, { recursive: true });
  for (const k of Object.keys(files)) fs.writeFileSync(path.join(DW, k), files[k]);
  return G.snapshot(DW);
}
function auditAfter(before, mutate, task) {
  mutate();
  return G.audit({ task: task, ws: { cwd: DW }, before: before, after: G.snapshot(DW), policy: pol });
}
function hasKind(a, kind) { return a.hard.some(function (h) { return h.kind === kind; }); }
const twoFiles = { 'a.txt': 'AAA\n', 'b.txt': 'BBB\n' };

let dBefore = fixture(twoFiles);
let dRes = auditAfter(dBefore, function () { fs.unlinkSync(path.join(DW, 'a.txt')); }, { grants: [] });
ok('删文件无授权 -> hard fs:delete', dRes.ok === false && hasKind(dRes, 'fs:delete'), dRes.hard);
dBefore = fixture(twoFiles);
dRes = auditAfter(dBefore, function () { fs.unlinkSync(path.join(DW, 'a.txt')); }, { grants: ['fs:delete'] });
ok('带 fs:delete 授权 -> hard 为空', dRes.ok === true && dRes.hard.length === 0, dRes.hard);

dBefore = fixture({ 'package.json': '{"name":"demo"}\n' });
dRes = auditAfter(dBefore, function () { fs.writeFileSync(path.join(DW, 'package.json'), '{"name":"demo","dependencies":{"left-pad":"1.3.0"}}\n'); }, { grants: [] });
ok('改 package.json 无授权 -> hard dep:install', dRes.ok === false && hasKind(dRes, 'dep:install'), dRes.hard);
dBefore = fixture({ 'package.json': '{"name":"demo"}\n' });
dRes = auditAfter(dBefore, function () { fs.writeFileSync(path.join(DW, 'package.json'), '{"name":"demo","dependencies":{"left-pad":"1.3.0"}}\n'); }, { grants: ['dep:install'] });
ok('带 dep:install 授权 -> hard 为空', dRes.ok === true && dRes.hard.length === 0, dRes.hard);

dBefore = fixture({ 'RULES.md': '# 规则\n' });
dRes = auditAfter(dBefore, function () { fs.writeFileSync(path.join(DW, 'RULES.md'), '# 规则\n\n新增：合并权只归人类\n'); }, { grants: [] });
ok('改 RULES.md 无授权 -> hard cfg:edit', dRes.ok === false && hasKind(dRes, 'cfg:edit'), dRes.hard);
dBefore = fixture({ 'RULES.md': '# 规则\n' });
dRes = auditAfter(dBefore, function () { fs.writeFileSync(path.join(DW, 'RULES.md'), '# 规则\n\n新增：合并权只归人类\n'); }, { grants: ['cfg:edit'] });
ok('带 cfg:edit 授权 -> hard 为空', dRes.ok === true && dRes.hard.length === 0, dRes.hard);

const OUT_ROOT = path.join(TMP, 'outside');
const OUT_WS = path.join(OUT_ROOT, 'ws');
const OUT_OTHER = path.join(OUT_ROOT, 'other');
fs.mkdirSync(OUT_WS, { recursive: true });
fs.mkdirSync(OUT_OTHER, { recursive: true });
fs.writeFileSync(path.join(OUT_WS, 'index.js'), 'a\n');
fs.writeFileSync(path.join(OUT_OTHER, 'note.txt'), 'one\n');
const outBefore = G.snapshot(OUT_ROOT);
fs.writeFileSync(path.join(OUT_OTHER, 'note.txt'), 'one, two, three\n');
const outAfter = G.snapshot(OUT_ROOT);
// diff 里是相对路径，audit 按 cwd 解析；cwd 缺失时一律判越界（fail-closed）
const outRes = G.audit({ task: { grants: [] }, ws: {}, before: outBefore, after: outAfter, policy: pol });
ok('无法确定 cwd -> hard fs:outside', outRes.ok === false && hasKind(outRes, 'fs:outside'), outRes.hard);
const outCtrl = G.audit({ task: { grants: [] }, ws: { cwd: OUT_ROOT }, before: outBefore, after: outAfter, policy: pol });
ok('给了 cwd 且改动在其内 -> hard 为空', outCtrl.ok === true && outCtrl.hard.length === 0, outCtrl.hard);

console.log('');
console.log('[E] 宽改动只是提示，不是拒绝');
function wideFiles(dir, n) {
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  const before = G.snapshot(dir);
  for (let i = 1; i <= n; i++) fs.writeFileSync(path.join(dir, 'f' + String(i).padStart(2, '0') + '.txt'), 'x' + i + '\n');
  return G.audit({ task: { grants: [] }, ws: { cwd: dir }, before: before, after: G.snapshot(dir), policy: pol });
}
const wide21 = wideFiles(path.join(TMP, 'wide21'), 21);
ok('21 个文件 -> changed_files = 21', wide21.changed_files === 21, wide21.changed_files);
ok('21 个文件 -> soft 含 wide:change', wide21.soft.some(function (s) { return s.kind === 'wide:change'; }), wide21.soft);
ok('宽改动不拦，ok 仍为 true', wide21.ok === true && wide21.hard.length === 0, wide21.hard);
const wide20 = wideFiles(path.join(TMP, 'wide20'), 20);
ok('20 个文件 -> changed_files = 20', wide20.changed_files === 20, wide20.changed_files);
ok('20 个文件 -> soft 为空', wide20.soft.length === 0, wide20.soft);

console.log('');
console.log('[F] 人类专审闸门 needs_human');
const tF = S.createTask(db, { title: '守卫要人点头的活', status: 'open', origin: 'human', project: 'proj-guard' });
S.claim(db, W1, tF.id);
S.updateTask(db, W1, tF.id, 'in_progress');
S.updateTask(db, W1, tF.id, 'review');
const gF = S.setGuard(db, tF.id, { guard: { hard: ['cfg:edit'] }, changed_files: 3, needs_human: 1 });
ok('setGuard 写入三列', gF.ok === true && Number(gF.task.needs_human) === 1 && Number(gF.task.changed_files) === 3, gF.task);
ok('setGuard 不动状态机', gF.task.status === 'review' && Number(gF.task.version) === S.getTask(db, tF.id).version, gF.task.status);
const blockedF = S.updateTask(db, LEAD, tF.id, 'done', '我验收了', null, ACC);
ok('Lead 判 done 被 needs_human 拦下', blockedF.ok === false && blockedF.reason === 'needs_human', blockedF);
const humanF = S.updateTask(db, 'human', tF.id, 'done', '人类确认放行', null, ACC);
ok('human 判 done 成功', humanF.ok === true && humanF.task.status === 'done', humanF);

console.log('');
console.log('[G] review 超时升级（含幂等）');
const tG = S.createTask(db, { title: '没人验收的活', status: 'open', origin: 'human', project: 'proj-guard' });
S.claim(db, W1, tG.id);
S.updateTask(db, W1, tG.id, 'in_progress');
S.updateTask(db, W1, tG.id, 'review');
const stale = new Date(Date.now() - 120 * 60000).toISOString();
db.prepare('UPDATE tasks SET updated_at = ? WHERE id = ?').run(stale, tG.id);
ok('构造完成：updated_at 在 2 小时前', S.getTask(db, tG.id).updated_at === stale, S.getTask(db, tG.id).updated_at);
const sw1 = S.sweepReviews(db, pol);
ok('escalated 含该卡', sw1.escalated.indexOf(tG.id) >= 0, sw1.escalated);
ok('escalated_at 已落库', !!S.getTask(db, tG.id).escalated_at, S.getTask(db, tG.id).escalated_at);
const evG = db.prepare('SELECT kind, action FROM guard_events WHERE task_id = ?').all(tG.id);
ok('guard_events 有 review_timeout/escalated', evG.some(function (e) { return e.kind === 'review_timeout' && e.action === 'escalated'; }), evG);
const msgG = db.prepare("SELECT COUNT(*) AS c FROM messages WHERE recipient = 'human' AND kind = 'task.escalated' AND thread = ?").get(tG.id);
ok('human 收到升级消息', Number(msgG.c) >= 1, msgG);
const evCount = db.prepare('SELECT COUNT(*) AS c FROM guard_events WHERE task_id = ?').get(tG.id).c;
const sw2 = S.sweepReviews(db, pol);
ok('再扫一次 escalated 为空', sw2.escalated.length === 0, sw2.escalated);
ok('没有重复写事件', Number(db.prepare('SELECT COUNT(*) AS c FROM guard_events WHERE task_id = ?').get(tG.id).c) === Number(evCount));

console.log('');
console.log('[H] 人类放行：overrideTask');
const tH = S.createTask(db, { title: '被误判失败的活', status: 'open', origin: 'human', project: 'proj-guard' });
S.claim(db, W1, tH.id);
S.updateTask(db, W1, tH.id, 'in_progress');
S.updateTask(db, W1, tH.id, 'failed');
const notHuman = S.overrideTask(db, LEAD, tH.id, '我来改判', ACC);
ok('非 human 覆盖被拒', notHuman.ok === false && notHuman.reason === 'not_permitted', notHuman);
const backH = S.overrideTask(db, 'human', tH.id, '误判，退回 review', ACC);
ok('human 覆盖 failed -> review', backH.ok === true && backH.task.status === 'review', backH);
const evH = db.prepare('SELECT action FROM guard_events WHERE task_id = ?').all(tH.id).map(function (e) { return e.action; });
ok('guard_events 有 action=override', evH.indexOf('override') >= 0, evH);
const againH = S.overrideTask(db, 'human', tH.id, '再来一次', ACC);
ok('review 卡再覆盖 -> bad_transition', againH.ok === false && againH.reason === 'bad_transition', againH);

console.log('');
console.log('==================================');
console.log('PASS ' + pass + '   FAIL ' + fail);
try { db.close(); } catch (e) {}
try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (e) {}
process.exit(fail ? 1 : 0);
