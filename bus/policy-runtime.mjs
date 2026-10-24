const field = (path, stage, status, owner, note) => ({ path, stage, status, owner, note });
export const POLICY_FIELDS = [
  field('lead', 'config', 'enforced', 'lead', '每轮重新读取 Lead 身份'),
  ...['dispatch','accept','merge','reassign'].map(key => field('permissions.'+key,'dispatch',key==='merge'?'planned':'enforced',key==='merge'?'item-9':'lead',key==='merge'?'待第 9 项接线：合并权限':'数据层权限守卫')),
  field('redline.human_only','review','enforced','lead','红线人工验收守卫'),
  ...['dispatch_enabled','max_dispatch_depth'].map(key => field('global.'+key,'dispatch','enforced','lead','派发数据层守卫')),
  field('global.max_chain_len','dispatch','planned','item-7','待第 7 项接线：调度链上限'),
  field('global.rate_per_agent_per_hour','dispatch','planned','item-7','待第 7 项接线：派发速率限制'),
  ...['lead_may_read_files','lead_may_write_code'].map(key => field('economics.'+key,'wake','enforced','lead','Codex/Claude：任一关闭降级 read-only/plan，不能禁止读取；DSH 不支持权限参数，仅能靠 patch 关闭写工具，并记录警告')),
  field('economics.lead_wake_on','wake','enforced','lead','只唤醒列出的消息 kind 或 refs.reason；task.failed/task.declined 对应 retry_exceeded，question 对应 cross_module_decision'),
  field('economics.report_no_raw_diff','report','enforced','lead','Worker 摘要和验证输出剥离 diff 块，原始日志保留'),
  field('economics.report_max_lines','report','enforced','lead','回报输出按该行数裁剪'),
  field('economics.auto_accept','review','enforced','lead','审计通过且无红线的自动验收类别'),
  field('economics.require_verify_cmd','dispatch','enforced','lead','自动验收类别必须带验证命令'),
  ...['peer_review','lead_review'].map(key => field('economics.'+key,'review','planned','item-9','待第 9 项接线：验收路由')),
  field('economics.max_rounds_per_task','review','planned','item-7','待第 7 项接线：任务重试上限'),
  field('economics.daily_token_budget','dispatch','planned','item-8','待第 8 项接线：Token 预算'),
  field('economics.max_changed_files','review','enforced','lead','审计最大修改文件数'),
  field('economics.max_subagents','dispatch','planned','item-7','待第 7 项接线：子代理总限额'),
  field('economics.review_timeout_min','review','enforced','lead','超时验收升级'),
  ...['autonomy','may_dispatch_to','max_open_from_agents'].map(key => field('agents.*.'+key,'dispatch','enforced','lead','派发数据层守卫')),
  ...['max_concurrent','scope_allowlist'].map(key => field('agents.*.'+key,'dispatch','planned','item-7','待第 7 项接线：并发与作用域约束')),
  field('agents.*.capabilities','config','enforced','lead','能力元数据用于提示与看板，不限制权限'),
];

export function describePolicy(policy) {
  return POLICY_FIELDS.flatMap(entry => {
    const paths = entry.path.includes('.*.') ? Object.keys((policy || {}).agents || {}).map(id => ({ path: entry.path.replace('*', id), value: (policy.agents[id] || {})[entry.path.split('.*.')[1]] })) :
      [{ path: entry.path, value: entry.path.split('.').reduce((value,key) => value == null ? undefined : value[key], policy) }];
    return paths.map(value => ({ ...entry, ...value, effective: entry.status === 'enforced' }));
  });
}

export function leadPermissions(policy, isLead) {
  const economics = (policy || {}).economics || {};
  return { restricted: !!isLead && !(economics.lead_may_write_code === true && economics.lead_may_read_files === true) };
}

export function reportText(text, policy, maxLines) {
  let value = String(text || '');
  if (((policy || {}).economics || {}).report_no_raw_diff !== false) {
    const lines = value.split(/\r?\n/);
    const kept = [];
    let fenced = false, unified = false;
    for (const line of lines) {
      if (/^\s*\x60{3}(diff|patch)\b/i.test(line)) { fenced = true; continue; }
      if (fenced) { if (/^\s*\x60{3}\s*$/.test(line)) fenced = false; continue; }
      if (/^(diff --git |Index: |--- |\+\+\+ |@@ )/.test(line)) { unified = true; continue; }
      if (unified && (/^(?: |[+-]|$)/.test(line) || line.startsWith(String.fromCharCode(92)))) continue;
      unified = false;
      kept.push(line);
    }
    value = kept.join('\n');
  }
  const limit = Number.isInteger(maxLines) && maxLines > 0 ? maxLines : 40;
  const lines = value.trim().split(/\r?\n/);
  return lines.length > limit ? lines.slice(0,limit).join('\n')+'\n（已截断，原文共 '+lines.length+' 行）' : value.trim();
}

export function filterLeadWake(messages, policy, isLead) {
  if (!isLead) return messages;
  const allowed = (((policy || {}).economics || {}).lead_wake_on || []);
  return messages.filter(message => {
    let refs = message.refs || {};
    if (typeof refs === 'string') { try { refs = JSON.parse(refs); } catch { refs = {}; } }
    const reason = refs.reason || refs.wake_reason || ({ 'task.failed':'retry_exceeded', 'task.declined':'retry_exceeded', question:'cross_module_decision' })[message.kind] || message.kind;
    return allowed.includes(reason) || allowed.includes(message.kind);
  });
}
