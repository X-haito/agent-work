// 测试基线自检（第 11 项第 1/3/6 条）：契约检查与汇总判定必须真的会失败。
// 这个套件不连库、不起服务：它测的是「测试基础设施本身」——正是最容易腐烂又最没人看的地方。
import * as Contracts from './smoke-support/contracts.mjs';
import { decide, CI_REQUIRED_SUITES, normalizeSuiteName } from './smoke-support/summary.mjs';

let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  PASS  ' + name); }
  else { fail++; console.log('  FAIL  ' + name + (extra === undefined ? '' : '  -> ' + JSON.stringify(extra).slice(0, 300))); }
}
function throwsWith(fn, pattern) {
  try { fn(); return { threw: false }; }
  catch (e) { return { threw: true, message: String(e && e.message || e), matches: pattern ? pattern.test(String(e && e.message || e)) : true }; }
}

console.log('[1] bus_tasks 分页契约：形状不对必须炸，不能退化成 undefined');
const good = { items: [{ id: 't-1' }], count: 1, next_cursor: null, has_more: false };
ok('合法 payload 通过并返回 items', Contracts.taskPagePayload(good).length === 1);
const legacy = { tasks: [{ id: 't-1' }] };
const legacyResult = throwsWith(function () { Contracts.taskPagePayload(legacy); }, /items/);
ok('旧的 tasks 形状被拒（并提示分页改造已改名）', legacyResult.threw && legacyResult.matches, legacyResult);
ok('旧形状的错误信息点明 tasks → items', /tasks/.test(String(legacyResult.message)), legacyResult.message);
ok('缺 count 被拒', throwsWith(function () { Contracts.taskPagePayload({ items: [], count: undefined, next_cursor: null, has_more: false }); }, /count/).threw);
ok('缺 has_more 被拒', throwsWith(function () { Contracts.taskPagePayload({ items: [], count: 0, next_cursor: null }); }, /has_more/).threw);
ok('缺 next_cursor 字段被拒（末页必须是 null，不能整个缺失）', throwsWith(function () { Contracts.taskPagePayload({ items: [], count: 0, has_more: false }); }, /next_cursor/).threw);
ok('count 与 items.length 不一致被拒', throwsWith(function () { Contracts.taskPagePayload({ items: [], count: 3, next_cursor: null, has_more: false }); }, /count/).threw);
ok('has_more=true 却无 next_cursor 被拒', throwsWith(function () { Contracts.taskPagePayload({ items: [{ id: 'a' }], count: 1, next_cursor: null, has_more: true }); }, /next_cursor/).threw);
ok('has_more=false 却给 next_cursor 被拒', throwsWith(function () { Contracts.taskPagePayload({ items: [{ id: 'a' }], count: 1, next_cursor: 'x', has_more: false }); }, /next_cursor/).threw);
ok('不是对象被拒', throwsWith(function () { Contracts.taskPagePayload(null); }).threw);
ok('数组被当成非法 payload 拒绝', throwsWith(function () { Contracts.taskPagePayload([]); }).threw);

console.log('');
console.log('[2] 工具结果信封契约');
ok('成功结果要求 structuredContent', Contracts.toolEnvelope({ content: [{ type: 'text', text: '{}' }], structuredContent: { ok: true } }).ok === true);
ok('成功但缺 structuredContent 被拒', throwsWith(function () { Contracts.toolEnvelope({ content: [{ type: 'text', text: '{}' }] }); }, /structuredContent/).threw);
ok('失败结果必须有 code 与 message', throwsWith(function () { Contracts.toolEnvelope({ content: [{ type: 'text', text: 'x' }], isError: true, structuredContent: { ok: false } }); }, /code/).threw);
ok('失败信封完整时通过', Contracts.toolEnvelope({ content: [{ type: 'text', text: 'x' }], isError: true, structuredContent: { ok: false, code: 'invalid_arguments', message: 'm' } }).code === 'invalid_arguments');
ok('content 不是 text 被拒', throwsWith(function () { Contracts.toolEnvelope({ content: [{ type: 'image' }] }); }, /text/).threw);

console.log('');
console.log('[3] 汇总判定：SKIP ≠ PASS，超时 ≠ PASS');
const mk = function (name, status, extra) { return Object.assign({ name: name, status: status, pass: 1, fail: 0, reason: null, duration_ms: 1 }, extra || {}); };
ok('全绿时 ok', decide([mk('smoke-a', 'passed')], {}).ok === true);
ok('有失败套件时不 ok', decide([mk('smoke-a', 'passed'), mk('smoke-b', 'failed')], {}).ok === false);
ok('超时按失败算（不能当成通过）', decide([mk('smoke-b', 'timeout')], {}).ok === false);
ok('unparsed 也按失败算', decide([mk('smoke-b', 'unparsed')], {}).ok === false);
ok('非 strict 下普通 SKIP 不判失败', decide([mk('smoke-x', 'skipped', { reason: 'spawn_eperm' })], {}).ok === true);
ok('strict 下任何 SKIP 判失败', decide([mk('smoke-x', 'skipped')], { strict: true }).ok === false);
ok('必需套件 SKIP 判失败（CI 语义）', decide([mk('smoke-e2e', 'skipped', { reason: 'spawn_eperm' })], { require: ['smoke-e2e'] }).ok === false);
ok('必需套件 SKIP 时给出原因', decide([mk('smoke-e2e', 'skipped')], { require: ['smoke-e2e'] }).reasons.join('|').indexOf('必需套件被 SKIP') >= 0);
ok('必需套件通过时不判失败', decide([mk('smoke-e2e', 'passed')], { require: ['smoke-e2e'] }).ok === true);
ok('套件名带 .mjs 也能匹配必需清单', decide([mk('smoke-e2e.mjs', 'skipped')], { require: ['smoke-e2e'] }).ok === false);
ok('CI 必需清单覆盖 e2e/auth/permissions/verifier/install',
  ['smoke-e2e', 'smoke-auth', 'smoke-permissions', 'smoke-verifier', 'smoke-install'].every(function (n) { return CI_REQUIRED_SUITES.indexOf(n) >= 0; }), CI_REQUIRED_SUITES);
ok('断言总数与失败数分开统计', (function () {
  const d = decide([mk('a', 'passed', { pass: 3, fail: 1 }), mk('b', 'passed', { pass: 2, fail: 0 })], {});
  return d.assertions === 6 && d.failed_assertions === 1;
})());
ok('退出码：ok → 0，不 ok → 1', decide([mk('a', 'passed')], {}).exit_code === 0 && decide([mk('a', 'failed')], {}).exit_code === 1);
ok('normalizeSuiteName 去掉 .mjs', normalizeSuiteName('smoke-x.mjs') === 'smoke-x');

console.log('');
console.log('==================================');
console.log('PASS ' + pass + '   FAIL ' + fail);
process.exit(fail ? 1 : 0);
