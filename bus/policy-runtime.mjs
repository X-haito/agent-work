import { registryFields } from './policy-schema.mjs';

const field = (path, stage, status, owner, note) => ({ path, stage, status, owner, note });
// 第 15 项：注册表不再手写白名单，直接从 POLICY_SCHEMA 派生（registry:false 的字段由专属面板编辑）
export const POLICY_FIELDS = registryFields().map(function (entry) {
  return field(entry.path, entry.stage, entry.status, entry.owner, entry.note);
});
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
