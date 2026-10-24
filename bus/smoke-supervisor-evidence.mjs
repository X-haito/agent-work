import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { reportText, leadPermissions, filterLeadWake } from './policy-runtime.mjs';
import * as CodexEngine from './engines/codex.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
let pass = 0;
function extract(source, start, end) {
  const first = source.indexOf(start);
  const last = source.indexOf(end, first + start.length);
  assert(first >= 0 && last > first, 'supervisor function boundary changed');
  return source.slice(first, last).trim();
}
for (const script of ['codex-supervisor.mjs', 'claude-supervisor.mjs']) {
  const source = fs.readFileSync(path.join(here, script), 'utf8');
  for (const verified of [true, false]) {
    const emitted = [];
    let writes = 0, enabled = true;
    const task = { id: 't-evidence', project: 'example', status: 'open', verify_id: 'unit', verify_spec_json: JSON.stringify({ command: 'node', args: ['verify.mjs'], cwd: '.', timeout_ms: 1000 }), verify_spec_hash: 'frozen-hash' };
    const context = {
      runVerifier: async () => ({ ok: verified, exit_code: verified ? 0 : 1, duration_ms: 3, stdout_tail: Array.from({ length: 70 }, (_, i) => 'line ' + i).join(String.fromCharCode(10)), stderr_tail: '', log_path: 'logs/verify/t-evidence/run.json' }),
      validateFrozenVerifier: () => ({ ok: true, spec: { command: 'node', args: ['verify.mjs'], cwd: '.', timeout_ms: 1000 } }),
      S: { resolveProjectDir: () => here,
        BUS_DIR: here, getRuntimeState: () => ({ enabled }), reapLeases() {}, heartbeat() {},
        loadPolicy: () => ({ lead: 'lead' }), sweepReviews() {}, workspaceFor: () => ({ cwd: here }),
        claim: () => ({ ok: true, task: { version: 1 } }), renewLease: () => true, recordUsage() {},
        issueExecutionGrant: () => ({ ok: true, grant: { grant_id: 'g-test', roots: [here], redline: [], task_version: 1 } }),
        getExecutionGrant: () => ({ grant_id: 'g-test' }), extendExecutionGrant: () => ({ ok: true }), revokeExecutionGrant() {}, deferExecutionTask() {},
        updateTask(_db, _agent, _id, status, note) { emitted.push({ status, note }); return { ok: true }; },
      },
      fs: { existsSync: () => true, mkdirSync() {}, writeFileSync() { writes++; } },
      reportText, leadPermissions, filterLeadWake, path, db: {}, AGENT: 'worker', policy: { lead: 'lead' }, IS_LEAD: false,
      AbortController, FAKE: false, CodexEngine, CODEX: {}, RUNNER: {}, DSH_PROFILE: 'test', DSH_PATCH: 'test', extractTokens: () => ({ in: 1, out: 1 }),
      ENGINE: 'claude', REPORT_MAX: 3, DRY: false, skipped: new Set(), log() {},
      pickTask: () => task, buildTaskPrompt: () => 'prompt', snapshotAll: () => ({}),
      auditRun: () => ({ hard: [] }), summarize: out => out,
      setInterval: () => 1, clearInterval() {},
    };
    // Close admission while the already claimed run completes.
    context.runCodex = context.runAgent = async () => {
      enabled = false;
      return { code: 0, out: 'agent output', tokens: { in: 1, out: 1 } };
    };
    context.TASK_ENGINE = { capabilities: () => ({ strongWriteIsolation: true }), spawnTask: context.runCodex };
    context.bounded = vm.runInNewContext('(' + extract(source, 'function bounded(text) {', '\n}') + '\n})', context);
    context.saveRawLog = vm.runInNewContext('(' + extract(source, 'function saveRawLog(taskId, raw) {', '\n}') + '\n})', context);
    const start = source.indexOf('async function oneRound(roundNo) {');
    const end = source.indexOf('async function main()', start);
    const oneRound = vm.runInNewContext('(' + source.slice(start, end).trim() + ')', context);
    assert.equal(await oneRound(1), 'worked');
    assert.equal(writes, 1);
    const result = emitted.at(-1);
    assert.equal(result.status, verified ? 'review' : 'failed');
    assert.match(result.note, verified ? /机械验收通过: 项目验证器 unit/ : /机械验收失败: 项目验证器 unit/);
    assert.match(result.note, /line 0/);
    assert.match(result.note, /已截断/);
    assert(!result.note.includes('line 69'));
    assert.match(result.note, /agent output/);
    const logPaths = result.note.match(/(?:bus[\\/])?logs[\\/]verify[\\/][^\s"<>|]+\.(?:log|txt|json|md)/g) || [];
    assert.equal(logPaths.length, 1, 'report must recognize the raw log path');
    assert.match(logPaths[0], /t-evidence.*\.(?:log|json)$/);
    assert(/验收/.test(result.note.slice(0, 600)));
    pass++;
    console.log('PASS ' + script + ' verify ' + (verified ? 'success' : 'failure') + ' during drain');
  }
}
console.log('PASS ' + pass + '   FAIL 0');
