// 评审路由（第 9 项）：把 review 收敛成唯一 route。
// 固定优先级：Human（红线 / needs_human / guard 阻塞）> Lead 类别 > Peer 类别 > Auto。
// Auto 只有在「guard 干净 + 固化验证器成功」时才成立，否则一律降级 Human，绝不默认放行。
export const ROUTES = ['auto', 'peer', 'lead', 'human'];

function list(value) {
  return Array.isArray(value) ? value.filter(function (x) { return typeof x === 'string' && x; }) : [];
}

// 统一取 guard 证据：hard/soft/truncated 任一存在都不干净
export function describeGuard(guard) {
  const g = guard && typeof guard === 'object' ? guard : null;
  const hard = list(g && g.hard);
  const soft = list(g && g.soft);
  const reasons = [];
  if (!g) reasons.push('缺少 guard 证据');
  if (hard.length) reasons.push('guard.hard=' + hard.join(','));
  if (soft.length) reasons.push('guard.soft=' + soft.join(','));
  if (g && g.truncated) reasons.push('guard 扫描被截断');
  if (g && g.ok === false) reasons.push('guard.ok=false');
  return { present: !!g, hard: hard, soft: soft, clean: !!g && !hard.length && !soft.length && !(g && g.truncated) && (g && g.ok !== false), reasons: reasons };
}

export function routeFor(task, guard, verification, policy) {
  const t = task || {};
  const eco = (policy && policy.economics) || {};
  const leadClasses = list(eco.lead_review);
  const peerClasses = list(eco.peer_review);
  const costClass = t.cost_class || 'standard';
  const guardInfo = describeGuard(guard);
  const conflicts = [];

  // 1) Human：红线 / needs_human / guard 阻塞
  const humanReasons = [];
  const redline = list(t.redline);
  if (redline.length) humanReasons.push('红线命中=' + redline.join(','));
  if (Number(t.needs_human) === 1) humanReasons.push('needs_human');
  if (guardInfo.hard.length) humanReasons.push('guard.hard=' + guardInfo.hard.join(','));
  if (guardInfo.soft.length) humanReasons.push('guard.soft=' + guardInfo.soft.join(','));
  if (humanReasons.length) {
    if (leadClasses.indexOf(costClass) >= 0 || peerClasses.indexOf(costClass) >= 0) {
      conflicts.push('cost_class "' + costClass + '" 本可路由到类别评审，但存在 Human 级阻塞，按固定优先级走 Human');
    }
    return { route: 'human', reason: '需要人工验收：' + humanReasons.join('；'), conflicts: conflicts };
  }

  const inLead = leadClasses.indexOf(costClass) >= 0;
  const inPeer = peerClasses.indexOf(costClass) >= 0;
  if (inLead && inPeer) conflicts.push('cost_class "' + costClass + '" 同时出现在 lead_review 与 peer_review，按固定优先级走 Lead');

  // 2) Lead 类别
  if (inLead) return { route: 'lead', reason: 'cost_class "' + costClass + '" 命中 lead_review', conflicts: conflicts };
  // 3) Peer 类别
  if (inPeer) return { route: 'peer', reason: 'cost_class "' + costClass + '" 命中 peer_review', conflicts: conflicts };

  // 4) Auto：必须 guard 干净 + 固化验证器成功
  const run = Array.isArray(verification) ? verification[0] : verification;
  const autoBlockers = [];
  if (!guardInfo.clean) autoBlockers.push.apply(autoBlockers, guardInfo.reasons.length ? guardInfo.reasons : ['guard 不干净']);
  if (!t.verify_id) autoBlockers.push('任务没有固化验证器');
  if (!run) autoBlockers.push('没有验证器运行记录');
  else {
    // verification_runs.ok 在 SQLite 里是 0/1 整数，不能只认 boolean true
    const passed = run.ok === true || Number(run.ok) === 1;
    if (!passed) autoBlockers.push('验证器未通过' + (run.exit_code == null ? '' : '(exit=' + run.exit_code + ')'));
    if (t.verify_spec_hash && run.verify_spec_hash && run.verify_spec_hash !== t.verify_spec_hash) autoBlockers.push('验证器规格与冻结值不一致');
  }
  if (autoBlockers.length) {
    return { route: 'human', reason: '不能自动通过（' + autoBlockers.join('；') + '），降级人工', conflicts: conflicts };
  }
  return { route: 'auto', reason: 'guard 干净且固化验证器通过', conflicts: conflicts };
}
