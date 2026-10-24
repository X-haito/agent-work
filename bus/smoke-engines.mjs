import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import * as Codex from './engines/codex.mjs';
import * as Claude from './engines/claude.mjs';
import * as Dsh from './engines/dsh.mjs';
import * as S from './store.mjs';
import * as G from './guard.mjs';
import { canAutoAccept } from './message-routing.mjs';
let pass = 0;
function test(name, fn) { fn(); pass++; console.log('PASS ' + name); }
const root = path.resolve('.');
const extra = path.resolve('other');
const grant = { grant_id: 'g-test', task_id: 't-test', owner: 'worker', task_version: 1, roots: [root], redline: [], expires_at: '2099-01-01T00:00:00Z' };
test('Codex 参数快照强制 workspace-write', () => assert.deepEqual(Codex.planArgs({ ...grant, roots: [root, extra] }, 'prompt', { sandbox: 'danger-full-access' }), ['exec', '--skip-git-repo-check', '-s', 'workspace-write', '-C', root, '--json', '--add-dir', extra, 'prompt']));
test('Claude 参数快照拒绝绕过权限模式', () => assert.deepEqual(Claude.planArgs(grant, 'prompt', { permissionMode: 'bypassPermissions' }), ['-p', 'prompt', '--permission-mode', 'default', '--output-format', 'json']));
test('DSH 非敏感授权可计划执行', () => assert.deepEqual(Dsh.planArgs(grant, 'prompt', { profile: 'worker', patch: 'patch.yml' }), ['--profile', 'worker', '--patch', 'patch.yml', '--json', 'prompt']));
for (const engine of [Claude, Dsh]) {
  test('弱隔离引擎拒绝多根授权', () => assert.throws(() => engine.planArgs({ ...grant, roots: [root, extra] }, 'prompt'), /执行端不支持强隔离/));
  for (const kind of ['fs:delete', 'cfg:edit']) test('敏感授权拒绝: ' + kind, () => assert.throws(() => engine.planArgs({ ...grant, redline: [kind] }, 'prompt'), /隔离配置不可用/));
}
test('截断快照拒绝自动验收', () => assert.equal(canAutoAccept({ status: 'review', cost_class: 'micro', guard: { ok: true, hard: [], truncated: true } }, { economics: { auto_accept: ['micro'] } }), false));
test('纯计划不依赖授权时间', () => assert.deepEqual(Codex.planArgs({ ...grant, expires_at: '2000-01-01' }, 'p'), Codex.planArgs(grant, 'p')));
test('运行时拒绝过期授权', () => assert.throws(() => Codex.spawnTask({ ...grant, expires_at: '2000-01-01' }, 'p', { dryRun: true }), /expired/));
for (const [name, engine, opts] of [['codex', Codex, {}], ['claude', Claude, {}], ['dsh', Dsh, { profile: 'worker', patch: 'patch.yml' }]]) {
  const result = await engine.spawnTask(grant, 'prompt', { ...opts, dryRun: true });
  assert.equal(result.ok, true); assert.equal(result.engine, name); assert.equal(result.dry, true);
  assert.deepEqual(result.args, engine.planArgs(grant, 'prompt', opts));
  pass++; console.log('PASS ' + name + ' dry-run 不启动进程');
}
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'agentbus-engines-'));
const db = S.openDb(path.join(temp, 'test.db'));
try {
  S.setRuntimeState(db, 'human', true);
  for (const engine of [Claude, Dsh]) test('能力不足退回 proposed + needs_human', () => {
    const task = S.createTask(db, { title: 'sensitive', project: temp, status: 'open', target: 'worker', grants: ['fs:delete'] });
    const claimed = S.claim(db, 'worker', task.id);
    assert.equal(claimed.ok, true);
    const issued = S.issueExecutionGrant(db, task.id, 'worker', { task_version: claimed.task.version });
    assert.equal(issued.ok, true, JSON.stringify(issued));
    const result = Codex.admitTask(S, db, task, 'worker', engine, issued.grant);
    assert.equal(result.reason, 'engine_isolation_unsupported');
    const saved = S.getTask(db, task.id);
    assert.equal(saved.status, 'proposed'); assert.equal(saved.needs_human, 1); assert.equal(saved.owner, null);
    assert.equal(S.getExecutionGrant(db, task.id, 'worker'), null);
  });
  test('快照使用 grant roots 且事件记录授权和截断', () => {
    const before = G.snapshotGrant({ ...grant, roots: [temp] });
    const detail = G.recordGrantAudit(db, { id: 't-test' }, 'worker', grant, before, { truncated: true });
    assert.equal(detail.truncated, true);
    const row = db.prepare("SELECT detail FROM guard_events WHERE kind='execution:snapshot' ORDER BY id DESC LIMIT 1").get();
    assert.deepEqual(JSON.parse(row.detail), { grant_id: 'g-test', task_version: 1, truncated: true });
  });
} finally { db.close(); }
const here = path.dirname(fileURLToPath(import.meta.url));
for (const file of ['codex-supervisor.mjs', 'claude-supervisor.mjs']) {
  const source = fs.readFileSync(path.join(here, file), 'utf8');
  const start = source.indexOf('async function oneRound(roundNo) {');
  const body = source.slice(start, source.indexOf('async function main()', start));
  for (const mode of ['claim-fails', 'issue-fails', 'snapshot-fails', 'grant-revoked', 'lease-fails', 'weak-capability']) {
    const order = [], emitted = [];
    let interval, spawned = 0, aborted = false;
    const task = { id: 't-isolation', project: 'x', version: 0, extra_dirs: mode === 'weak-capability' ? [extra] : [] };
    const context = {
      S: { getRuntimeState: () => ({ enabled: true }), reapLeases() {}, heartbeat() {}, loadPolicy: () => ({ lead: 'lead' }), sweepReviews() {}, workspaceFor: () => ({ cwd: root }),
        claim: () => { order.push('claim'); return mode === 'claim-fails' ? { ok: false, reason: 'not_open' } : { ok: true, task: { version: 1 } }; },
        issueExecutionGrant: () => { order.push('grant'); return mode === 'issue-fails' ? { ok: false, reason: 'denied' } : { ok: true, grant }; },
        getExecutionGrant: () => mode === 'grant-revoked' ? null : grant, revokeExecutionGrant() {}, renewLease: () => false, extendExecutionGrant: () => ({ ok: true }),
        deferExecutionTask: () => { emitted.push('proposed'); return { ok: true }; }, updateTask: (_db, _owner, _id, status) => emitted.push(status),
      },
      CodexEngine: Codex, TASK_ENGINE: { capabilities: () => ({ strongWriteIsolation: mode !== 'weak-capability' }), spawnTask: async (_grant, _prompt, opts) => { order.push('spawn'); spawned++; opts.signal.addEventListener('abort', () => { aborted = true; }); interval(); return { code: -1, out: '' }; } },
      AGENT: 'worker', ENGINE: 'claude', IS_LEAD: false, policy: { lead: 'lead' }, db: {}, log() {}, DRY: false, FAKE: false, skipped: new Set(),
      pickTask: () => task, buildTaskPrompt: () => 'p', fs: { existsSync: () => true }, CODEX: {}, RUNNER: {}, DSH_PROFILE: 'worker', DSH_PATCH: 'patch',
      leadPermissions: () => ({ restricted: false }), snapshotAll: () => { order.push('snapshot'); if (mode === 'snapshot-fails') throw new Error('snapshot failed'); return {}; }, AbortController,
      setInterval: fn => { interval = fn; return 1; }, clearInterval() {}, extractTokens: () => ({ in: 0, out: 0 }),
    };
    const oneRound = vm.runInNewContext('(' + body + ')', context);
    assert.equal(await oneRound(1), mode === 'claim-fails' ? 'retry' : 'worked');
    if (mode === 'lease-fails') { assert.deepEqual(order, ['claim', 'grant', 'snapshot', 'spawn']); assert.equal(aborted, true); assert.equal(emitted.at(-1), 'failed'); }
    else { assert.equal(spawned, 0); assert.equal(emitted.at(-1), mode === 'claim-fails' ? undefined : mode === 'weak-capability' ? 'proposed' : 'failed'); }
    pass++; console.log('PASS ' + file + ' ' + mode);
  }
}
console.log('PASS ' + pass + '   FAIL 0');
