// 回归汇总与退出码（第 11 项第 3/6 条）：唯一判定来源，smoke-all 只做 IO，不做判定。
// 规则：
//   · failed 套件、断言失败 > 0            → 失败
//   · skipped 且该套件在 required 列表里   → 失败（CI 里 SKIP 不能当 PASS）
//   · --strict 时任何 skipped              → 失败
export const CI_REQUIRED_SUITES = ['smoke-e2e', 'smoke-auth', 'smoke-permissions', 'smoke-verifier', 'smoke-install'];

export function normalizeSuiteName(name) {
  return String(name || '').replace(/\.mjs$/, '');
}

export function decide(results, options) {
  const o = options || {};
  const required = (o.require || []).map(normalizeSuiteName);
  const strict = o.strict === true;
  // 任何既不是 passed 也不是 skipped 的状态（failed/timeout/unparsed）都算失败——超时不能被当成通过。
  const failed = results.filter(function (r) { return r.status !== 'passed' && r.status !== 'skipped'; });
  const skipped = results.filter(function (r) { return r.status === 'skipped'; });
  const passed = results.filter(function (r) { return r.status === 'passed'; });
  const requiredSkips = skipped.filter(function (r) { return required.indexOf(normalizeSuiteName(r.name)) >= 0; });
  const ok = failed.length === 0 && requiredSkips.length === 0 && (!strict || skipped.length === 0);
  const failedAssertions = results.reduce(function (n, r) { return n + (Number(r.fail) || 0); }, 0);
  const assertions = results.reduce(function (n, r) { return n + (Number(r.pass) || 0) + (Number(r.fail) || 0); }, 0);
  return {
    ok: ok,
    suites: results.length,
    assertions: assertions,
    failed_assertions: failedAssertions,
    passed: passed.length,
    failed: failed.map(function (r) { return normalizeSuiteName(r.name); }),
    skipped: skipped.map(function (r) { return { name: normalizeSuiteName(r.name), reason: r.reason || 'unknown' }; }),
    required_skips: requiredSkips.map(function (r) { return normalizeSuiteName(r.name); }),
    reasons: [].concat(
      failed.length ? ['失败套件 ' + failed.length + ' 个'] : [],
      requiredSkips.length ? ['必需套件被 SKIP: ' + requiredSkips.map(function (r) { return normalizeSuiteName(r.name); }).join(', ')] : [],
      strict && skipped.length && !requiredSkips.length ? ['--strict 下存在 SKIP'] : [],
    ),
    exit_code: ok ? 0 : 1,
  };
}
