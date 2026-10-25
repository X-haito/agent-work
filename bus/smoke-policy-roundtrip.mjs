#!/usr/bin/env node
// 第 15 项：POLICY_SCHEMA 单一声明 + 策略无损往返。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as A from './admin-config.mjs';
import * as S from './store.mjs';
import * as R from './policy-runtime.mjs';
import { POLICY_SCHEMA, DEPRECATED_POLICY_PATHS, registryFields, unknownPolicyPaths } from './policy-schema.mjs';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'agentbus-policy-rt-'));
const realPolicyPath = path.join(S.BUS_DIR, 'policy.json');
const realBytes = fs.readFileSync(realPolicyPath);
const real = JSON.parse(realBytes.toString('utf8'));

let pass = 0, fail = 0;
function ok(name, value, detail) {
  if (value) { pass += 1; console.log('  PASS  ' + name); }
  else { fail += 1; console.log('  FAIL  ' + name + (detail ? ' — ' + JSON.stringify(detail) : '')); }
}
function deepEqual(a, b) { return JSON.stringify(a) === JSON.stringify(b); }

try {
  console.log('[1] 单一声明：三处派生一致');
  ok('POLICY_SCHEMA 每个字段都有 path/type/stage/status/owner/editable', POLICY_SCHEMA.every(function (e) { return e.path && e.type && e.stage && e.status && e.owner && typeof e.editable === 'boolean'; }));
  ok('注册表由 POLICY_SCHEMA 派生且逐字段一致', (function () {
    const expected = registryFields().map(function (e) { return e.path; });
    const actual = R.POLICY_FIELDS.map(function (f) { return f.path; });
    return deepEqual(expected, actual) && actual.length > 20;
  })(), { derived: registryFields().length, registry: R.POLICY_FIELDS.length });
  ok('schema 里没有重复 path', (function () { const seen = new Set(); for (const e of POLICY_SCHEMA) { if (seen.has(e.path)) return false; seen.add(e.path); } return true; })());

  console.log('\n[2] 未知字段报错并指出路径（不再静默丢弃）');
  const withUnknown = JSON.parse(JSON.stringify(real));
  withUnknown.economics.some_future_field = 1;
  let unknownMessage = '';
  try { A.validatePolicy(withUnknown, {}); } catch (error) { unknownMessage = error.message; }
  ok('未知 economics 字段被拒且报出完整路径', unknownMessage.indexOf('economics.some_future_field') >= 0, unknownMessage);
  const withUnknownAgent = JSON.parse(JSON.stringify(real));
  withUnknownAgent.agents[Object.keys(withUnknownAgent.agents)[0]].mystery = true;
  let agentMessage = '';
  try { A.validatePolicy(withUnknownAgent, {}); } catch (error) { agentMessage = error.message; }
  ok('未知 agent 字段被拒且报出路径', agentMessage.indexOf('.mystery') >= 0, agentMessage);
  ok('已废弃字段不算未知（会被丢弃）', unknownPolicyPaths({ economics: { lead_plans_once: true } }).length === 0);

  console.log('\n[3] 真实 policy.json 无损往返');
  const tempPath = path.join(tmp, 'policy.json');
  fs.copyFileSync(realPolicyPath, tempPath);
  const saved = A.savePolicy(real, { path: tempPath });
  const reloaded = JSON.parse(fs.readFileSync(tempPath, 'utf8'));
  ok('保存后重新加载与校验结果一致', deepEqual(reloaded, saved.policy));
  ok('真实 policy.json 每个叶子字段都还在（逐字段深比较）', (function () {
    function leaves(obj, prefix, out) {
      for (const key of Object.keys(obj)) {
        const value = obj[key];
        const p = prefix ? prefix + '.' + key : key;
        if (value && typeof value === 'object' && !Array.isArray(value)) leaves(value, p, out);
        else out[p] = JSON.stringify(value);
      }
      return out;
    }
    const before = leaves(real, '', {});
    const after = leaves(reloaded, '', {});
    const missing = Object.keys(before).filter(function (p) { return !Object.prototype.hasOwnProperty.call(after, p); });
    const changed = Object.keys(before).filter(function (p) { return Object.prototype.hasOwnProperty.call(after, p) && before[p] !== after[p]; });
    return missing.length === 0 && changed.length === 0 ? true : { missing: missing, changed: changed };
  })());
  ok('往返不引入 schema 之外的字段', (function () {
    function keys(obj, prefix, out) {
      for (const key of Object.keys(obj)) {
        const p = prefix ? prefix + '.' + key : key;
        if (obj[key] && typeof obj[key] === 'object' && !Array.isArray(obj[key])) keys(obj[key], p, out);
        else out.push(p);
      }
      return out;
    }
    return unknownPolicyPaths(reloaded).length === 0 && keys(reloaded, '', []).length > 0;
  })());

  console.log('\n[4] 边界值：false / null / 空数组 / 显式清空 local_services');
  const edge = JSON.parse(JSON.stringify(real));
  edge.global.dispatch_enabled = false;
  edge.economics.require_verify_cmd = false;
  edge.economics.report_no_raw_diff = false;
  edge.economics.lead_may_read_files = false;
  edge.economics.daily_token_budget = null;
  edge.economics.default_turn_reserve = null;
  edge.economics.auto_accept = [];
  edge.economics.peer_review = [];
  edge.economics.lead_wake_on = [];
  edge.network.local_services = [];
  const edgeSaved = A.savePolicy(edge, { path: path.join(tmp, 'edge.json') });
  const edgeBack = JSON.parse(fs.readFileSync(path.join(tmp, 'edge.json'), 'utf8'));
  ok('false 不被默认值覆盖', edgeBack.global.dispatch_enabled === false && edgeBack.economics.require_verify_cmd === false && edgeBack.economics.report_no_raw_diff === false && edgeBack.economics.lead_may_read_files === false, edgeBack.economics);
  ok('null 保持 null', edgeBack.economics.daily_token_budget === null && edgeBack.economics.default_turn_reserve === null);
  ok('空数组保持空数组', deepEqual(edgeBack.economics.auto_accept, []) && deepEqual(edgeBack.economics.peer_review, []) && deepEqual(edgeBack.economics.lead_wake_on, []));
  ok('显式清空 network.local_services 生效', deepEqual(edgeBack.network.local_services, []) && edgeBack.network['default'] === 'deny', edgeBack.network);
  ok('校验返回值与落盘一致', deepEqual(edgeSaved.policy, edgeBack));

  console.log('\n[5] 每个 schema 字段都有明确归属（可编辑 / 原样保留）');
  const registryPaths = R.POLICY_FIELDS.map(function (f) { return f.path; });
  const unowned = POLICY_SCHEMA.filter(function (entry) {
    const inRegistry = registryPaths.indexOf(entry.path) >= 0;
    const explicitlyPreserved = entry.registry === false;
    return !(entry.editable || explicitlyPreserved || inRegistry);
  });
  ok('不存在"两不管"字段', unowned.length === 0, unowned.map(function (e) { return e.path; }));
  ok('editable 字段都带 stage/status/owner 说明', POLICY_SCHEMA.filter(function (e) { return e.editable; }).every(function (e) { return e.stage && e.status && e.owner; }));
  ok('registry:false 的字段有 note 说明归属', POLICY_SCHEMA.filter(function (e) { return e.registry === false; }).every(function (e) { return !!e.note; }));

  console.log('\n[6] 默认值来自同一份 schema');
  const sparse = JSON.parse(JSON.stringify(real));
  delete sparse.global.max_chain_len;
  delete sparse.economics.report_max_lines;
  delete sparse.economics.default_turn_reserve;
  const filled = A.validatePolicy(sparse, {});
  ok('缺失字段按 schema 默认补回', filled.global.max_chain_len === 3 && filled.economics.report_max_lines === 40 && filled.economics.default_turn_reserve === null, filled.global);
  ok('补默认值不会凭空造出未声明字段', unknownPolicyPaths(filled).length === 0);
  ok('废弃字段在保存后消失', (function () {
    const legacy = JSON.parse(JSON.stringify(real));
    legacy.economics.lead_plans_once = true;
    const out = A.validatePolicy(legacy, {});
    return !Object.prototype.hasOwnProperty.call(out.economics, 'lead_plans_once') && DEPRECATED_POLICY_PATHS.indexOf('economics.lead_plans_once') >= 0;
  })());

  console.log('\n[7] 真实文件未被测试改写');
  ok('bus/policy.json 字节未变', realBytes.equals(fs.readFileSync(realPolicyPath)));
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}

console.log('\n==================================');
console.log('PASS ' + pass + '   FAIL ' + fail);
process.exitCode = fail ? 1 : 0;
