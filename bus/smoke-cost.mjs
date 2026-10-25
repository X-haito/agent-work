import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as S from './store.mjs';
import * as A from './admin-config.mjs';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'agentbus-cost-'));
const db = S.openDb(path.join(tmp, 'bus.db'));
let pass = 0;
function check(name, fn) { fn(); pass++; console.log('PASS ' + name); }
// 派活来源必须在 agents 里登记（unknown_agent 硬拒），否则 dispatch 会被当成未知身份。
const policy = { lead: 'lead', global: {}, permissions: { dispatch: ['lead'] },
  economics: { auto_accept: ['trivial'] },
  agents: { lead: { autonomy: 'auto', may_dispatch_to: ['worker'], max_open_from_agents: 100, max_concurrent: 5 },
    worker: { autonomy: 'auto', max_open_from_agents: 100 } } };
try {
  check('empty database reports finite zero totals and ratios', () => {
    assert.deepEqual(S.costByProject(db, 'lead'), {
      total: { in: 0, out: 0, total: 0 }, lead: { agent: 'lead', tokens: 0, ratio: 0 },
      projects: [], unassigned: { in: 0, out: 0, total: 0, ratio: 0 },
    });
  });
  const policyFile = path.join(tmp, 'policy.json');
  check('require_verify_cmd defaults to boolean false', () => {
    fs.writeFileSync(policyFile, JSON.stringify(policy));
    assert.equal(S.loadPolicy(policyFile).economics.require_verify_cmd === true, false);
  });
  const validPolicy = S.loadPolicy();
  check('admin validation preserves true and false through repeated round trips', () => {
    for (const value of [true, false]) {
      const input = structuredClone(validPolicy);
      input.economics.require_verify_cmd = value;
      const clean = A.validatePolicy(input);
      assert.equal(clean.economics.require_verify_cmd, value);
      assert.equal(A.validatePolicy(JSON.parse(JSON.stringify(clean))).economics.require_verify_cmd, value);
    }
  });
  check('admin validation defaults an omitted verification gate to false', () => {
    const input = structuredClone(validPolicy);
    delete input.economics.require_verify_cmd;
    assert.equal(A.validatePolicy(input).economics.require_verify_cmd, false);
  });
  check('admin validation rejects nonboolean verification gates with readable errors', () => {
    for (const value of [null, 'true', 'false', 0, 1, [], {}]) {
      const input = structuredClone(validPolicy);
      input.economics.require_verify_cmd = value;
      assert.throws(() => A.validatePolicy(input), /economics[.]require_verify_cmd 必须是 true 或 false/);
    }
  });
  check('saving a production-policy copy keeps the actual verification gate enabled', () => {
    const original = fs.readFileSync(S.POLICY_PATH, 'utf8');
    const snapshot = JSON.parse(original);
    const outputFile = path.join(tmp, 'saved-policy.json');
    A.savePolicy(snapshot, { path: outputFile });
    const saved = JSON.parse(fs.readFileSync(outputFile, 'utf8'));
    assert.equal(saved.economics.require_verify_cmd, snapshot.economics.require_verify_cmd === true);
    assert.equal(A.validatePolicy(saved).economics.require_verify_cmd, saved.economics.require_verify_cmd);
    assert.equal(fs.readFileSync(S.POLICY_PATH, 'utf8'), original);
  });
  S.setRuntimeState(db, 'human', true);
  const alpha = S.createTask(db, { title: 'alpha task', status: 'open', project: 'alpha' });
  const beta = S.createTask(db, { title: 'beta task', status: 'open', project: 'beta' });
  S.createTask(db, { title: 'no tokens yet', status: 'open', project: 'alpha' });
  S.createTask(db, { title: 'zero project', status: 'open', project: 'zero' });
  const deleted = S.createTask(db, { title: 'removed task', status: 'open', project: 'deleted' });
  S.recordUsage(db, 'worker', alpha.id, 'execute', 30, 10);
  S.recordUsage(db, 'lead', alpha.id, 'review', 5, 5);
  S.recordUsage(db, 'worker', beta.id, 'execute', 100, 50);
  S.recordUsage(db, 'lead', beta.id, 'plan', 10, 10);
  S.recordUsage(db, 'lead', null, 'plan', 7, 3);
  S.recordUsage(db, 'worker', 'missing-task', 'execute', 4, 6);
  S.recordUsage(db, 'lead', deleted.id, 'review', 2, 3);
  db.prepare('DELETE FROM tasks WHERE id=?').run(deleted.id);
  const cost = S.costByProject(db, 'lead');
  check('multiple projects sort by token totals and count distinct tasks', () => {
    assert.deepEqual(cost.projects.map(p => p.project), ['beta', 'alpha', 'zero']);
    assert.deepEqual(cost.projects.map(p => p.tasks), [1, 2, 1]);
    assert.deepEqual(cost.projects.map(p => p.total), [170, 50, 0]);
  });
  check('NULL, missing and deleted task usage is independently unassigned', () => {
    assert.deepEqual(cost.unassigned, { in: 13, out: 12, total: 25, ratio: 25 / 245 });
    assert(!cost.projects.some(p => p.project === 'deleted'));
  });
  check('all input and output tokens are conserved without duplicated joins', () => {
    assert.deepEqual(cost.total, { in: 158, out: 87, total: 245 });
    for (const field of ['in', 'out', 'total']) {
      assert.equal(cost.projects.reduce((sum, p) => sum + p[field], 0) + cost.unassigned[field], cost.total[field]);
    }
  });
  check('lead attribution includes its unassigned usage and project ratios', () => {
    assert.deepEqual(cost.lead, { agent: 'lead', tokens: 45, ratio: 45 / 245 });
    assert.equal(cost.projects[0].lead_tokens, 20);
    assert.equal(cost.projects[0].lead_ratio, 20 / 170);
    assert.equal(cost.projects[1].lead_tokens, 10);
    assert.equal(cost.projects[1].lead_ratio, 10 / 50);
    assert.equal(cost.projects[2].lead_ratio, 0);
    assert.equal(S.costByProject(db, 'worker').lead.tokens, 200);
  });
  check('existing costSummary retains its original structure and values', () => {
    const original = S.costSummary(db, 'lead');
    assert.equal(original.total, 245);
    assert.equal(original.lead, 45);
    assert(Array.isArray(original.by_task) && Array.isArray(original.by_agent));
    assert.equal(original.lead_id, 'lead');
    assert.equal(typeof original.total, 'number');
  });
  check('switch off accepts automatic classes without verify_cmd on both creation paths', () => {
    assert.equal(S.createHumanTask(db, policy, 'human', { title: 'manual', cost_class: 'trivial' }).ok, true);
    assert.equal(S.dispatch(db, policy, 'lead', { to: 'worker', title: 'dispatch', cost_class: 'trivial' }).ok, true);
  });
  policy.economics.require_verify_cmd = true;
  check('switch on rejects empty automatic-class validators without creating cards or events', () => {
    const tasksBefore = db.prepare('SELECT COUNT(*) AS n FROM tasks').get().n;
    const messagesBefore = db.prepare('SELECT COUNT(*) AS n FROM messages').get().n;
    for (const verify_id of [undefined, '']) {
      for (const result of [
        S.createHumanTask(db, policy, 'human', { title: 'manual', cost_class: 'trivial', verify_id }),
        S.dispatch(db, policy, 'lead', { to: 'worker', title: 'dispatch', cost_class: 'trivial', verify_id }),
      ]) {
        assert.equal(result.reason, 'verify_cmd_required');
        assert.match(result.message, /trivial.*verify_id/);
      }
    }
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM tasks').get().n, tasksBefore);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM messages').get().n, messagesBefore);
  });
  check('switch on permits registered validator IDs for automatic classes', () => {
    const verify_id = 'smoke';
    fs.writeFileSync(path.join(tmp, 'project.json'),JSON.stringify({validators:{smoke:{command:'node',args:[],cwd:'.',timeout_ms:1000}}}));
    assert.equal(S.createHumanTask(db, policy, 'human', { title: 'manual', project:tmp, cost_class: 'trivial', verify_id }).ok, true);
    assert.equal(S.dispatch(db, policy, 'lead', { to: 'worker', title: 'dispatch', project:tmp, cost_class: 'trivial', verify_id }).ok, true);
  });
  check('other cost classes remain unrestricted with switch on', () => {
    assert.equal(S.createHumanTask(db, policy, 'human', { title: 'manual', cost_class: 'standard' }).ok, true);
    assert.equal(S.dispatch(db, policy, 'lead', { to: 'worker', title: 'dispatch', cost_class: 'heavy' }).ok, true);
  });
  check('omitted cost class uses standard and can be required explicitly', () => {
    policy.economics.auto_accept.push('standard');
    assert.equal(S.createHumanTask(db, policy, 'human', { title: 'manual' }).reason, 'verify_cmd_required');
    assert.equal(S.dispatch(db, policy, 'lead', { to: 'worker', title: 'dispatch' }).reason, 'verify_cmd_required');
  });
  check('only boolean true enables the gate and policy changes persist through load', () => {
    policy.economics.require_verify_cmd = 'true';
    assert.equal(S.createHumanTask(db, policy, 'human', { title: 'manual' }).ok, true);
    fs.writeFileSync(policyFile, JSON.stringify(policy));
    assert.equal(S.loadPolicy(policyFile).economics.require_verify_cmd === true, false);
    policy.economics.require_verify_cmd = true;
    fs.writeFileSync(policyFile, JSON.stringify(policy));
    assert.equal(S.loadPolicy(policyFile).economics.require_verify_cmd, true);
  });
  console.log('PASS ' + pass + '   FAIL 0');
} finally { db.close(); fs.rmSync(tmp, { recursive: true, force: true }); }
