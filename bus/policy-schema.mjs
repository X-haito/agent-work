// 单一策略字段声明（第 15 项）：validatePolicy / 注册表 / 看板表单 都从这里派生。
// 新增字段只改这一个文件，忘记接线的字段会在保存时被 unknownPolicyPaths 拦下，而不是静默丢弃。
// registry:false 表示"有意不出现在 policy-runtime 注册表"（由专属面板编辑，如 network/retention）。
export const POLICY_SCHEMA = [
  { path: 'lead', type: 'agentId', default: null, stage: 'config', status: 'enforced', owner: 'lead', editable: true, note: '每轮重新读取 Lead 身份' },
  { path: 'permissions.dispatch', type: 'principals', default: [], stage: 'dispatch', status: 'enforced', owner: 'lead', editable: true, note: '数据层权限守卫' },
  { path: 'permissions.accept', type: 'principals', default: [], stage: 'dispatch', status: 'enforced', owner: 'lead', editable: true, note: '数据层权限守卫' },
  { path: 'permissions.reassign', type: 'principals', default: [], stage: 'dispatch', status: 'enforced', owner: 'lead', editable: true, note: '数据层权限守卫' },
  { path: 'redline.human_only', type: 'kinds', default: null, stage: 'review', status: 'enforced', owner: 'lead', editable: true, note: '红线人工验收守卫' },
  { path: 'global.dispatch_enabled', type: 'boolean', default: true, stage: 'dispatch', status: 'enforced', owner: 'lead', editable: true, note: '派发数据层守卫' },
  { path: 'global.max_dispatch_depth', type: 'integer', bounds: [1, 5], default: 2, stage: 'dispatch', status: 'enforced', owner: 'lead', editable: true, note: '派发数据层守卫' },
  { path: 'global.max_chain_len', type: 'integer', bounds: [1, 10], default: 3, stage: 'dispatch', status: 'enforced', owner: 'item-7', editable: true, note: '第 7 项：消息链 hop 上限，超过后改写为 chain_limit 事件只给 Lead/Human' },
  { path: 'global.rate_per_agent_per_hour', type: 'integer', bounds: [1, 1000], default: 20, stage: 'dispatch', status: 'enforced', owner: 'item-7', editable: true, note: '数据层：近一小时该 agent 创建任务数超限即拒（smoke-limits 覆盖）' },
  { path: 'global.require_credentials', type: 'boolean', default: false, stage: 'dispatch', status: 'enforced', owner: 'item-5', editable: true, registry: false, note: '第 5 项：开启后 MCP 必须带 active 凭据（doctor --auth-readiness 未 ready 时禁止置 true）' },
  { path: 'economics.lead_may_read_files', type: 'boolean', default: false, stage: 'wake', status: 'enforced', owner: 'lead', editable: true, note: 'Codex/Claude：任一关闭降级 read-only/plan，不能禁止读取；DSH 不支持权限参数，仅能靠 patch 关闭写工具，并记录警告' },
  { path: 'economics.lead_may_write_code', type: 'boolean', default: false, stage: 'wake', status: 'enforced', owner: 'lead', editable: true, note: 'Codex/Claude：任一关闭降级 read-only/plan，不能禁止读取；DSH 不支持权限参数，仅能靠 patch 关闭写工具，并记录警告' },
  { path: 'economics.lead_wake_on', type: 'strings', default: [], stage: 'wake', status: 'enforced', owner: 'lead', editable: true, note: '只唤醒列出的消息 kind 或 refs.reason；task.failed/task.declined 对应 retry_exceeded，question 对应 cross_module_decision' },
  { path: 'economics.report_no_raw_diff', type: 'boolean', default: true, stage: 'report', status: 'enforced', owner: 'lead', editable: true, note: 'Worker 摘要和验证输出剥离 diff 块，原始日志保留' },
  { path: 'economics.report_max_lines', type: 'integer', bounds: [10, 500], default: 40, stage: 'report', status: 'enforced', owner: 'lead', editable: true, note: '回报输出按该行数裁剪' },
  { path: 'economics.auto_accept', type: 'costClasses', default: [], stage: 'review', status: 'enforced', owner: 'lead', editable: true, note: '审计通过且无红线的自动验收类别' },
  { path: 'economics.require_verify_cmd', type: 'boolean', default: false, stage: 'dispatch', status: 'enforced', owner: 'lead', editable: true, note: '自动验收类别必须带验证命令' },
  { path: 'economics.lead_review', type: 'costClasses', default: [], stage: 'review', status: 'enforced', owner: 'item-9', editable: true, note: '第 9 项：cost_class 命中该类走 Lead 路由，评审分配只发给 policy.lead' },
  { path: 'economics.peer_review', type: 'costClasses', default: [], stage: 'review', status: 'enforced', owner: 'item-9', editable: true, note: '第 9 项：cost_class 命中该类走 Peer 路由，只唤醒被指定的 reviewer，owner 不得自审' },
  { path: 'permissions.request_merge', type: 'principals', default: [], stage: 'dispatch', status: 'enforced', owner: 'item-11', editable: true, note: '第 11 项第 11 条：谁可以发起合并申请（默认回退到有效 Lead + Human）；批准与执行永远 Human，不可配置' },
  { path: 'permissions.merge', type: 'principals', default: [], stage: 'dispatch', status: 'enforced', owner: 'item-11', editable: false, note: '第 11 项：legacy 别名，仅作 request_merge 的回退；只含 human 时视为旧默认，不再阻止 Lead 申请；批准只能由 human 在看板完成，执行只走本机 merge runner' },
  { path: 'economics.max_rounds_per_task', type: 'integer', bounds: [1, 10], default: 2, stage: 'review', status: 'enforced', owner: 'item-7', editable: true, note: '第 7 项：创建任务时固化为 retry_limit，超额走 retryTask 升级 retry_exceeded' },
  { path: 'economics.daily_token_budget', type: 'integer', bounds: [1, 1000000000], default: null, nullable: true, stage: 'dispatch', status: 'enforced', owner: 'item-8', editable: true, note: '第 8 项：supervisor 启动模型前 reserveTokens；日预算与任务预算各自独立生效（日预算为 null 时任务 token_budget 仍然拦），两者同时存在取剩余更小者，拿不到 reservation 就拒绝启动' },
  { path: 'economics.budget_timezone', type: 'timezone', default: 'UTC', stage: 'dispatch', status: 'enforced', owner: 'item-8', editable: true, registry: false, note: '第 8 项：日预算按该 IANA 时区的自然日聚合' },
  { path: 'economics.default_turn_reserve', type: 'integer', bounds: [1, 100000000], default: null, nullable: true, stage: 'dispatch', status: 'enforced', owner: 'item-8', editable: true, registry: false, note: '第 8 项：无历史样本时的一次回合预留额度（正整数；启用日预算时必须显式配置）' },
  { path: 'economics.max_changed_files', type: 'integer', bounds: [1, 10000], default: 20, stage: 'review', status: 'enforced', owner: 'lead', editable: true, note: '审计最大修改文件数' },
  { path: 'economics.max_subagents', type: 'integer', bounds: [0, 5], default: 0, stage: 'dispatch', status: 'enforced', owner: 'item-7', editable: true, note: '数据层：任务 max_subagents 超过策略上限即拒（smoke-limits 覆盖）' },
  { path: 'economics.review_timeout_min', type: 'integer', bounds: [1, 10080], default: 30, stage: 'review', status: 'enforced', owner: 'lead', editable: true, note: '超时验收升级' },
  { path: 'agents.*.autonomy', type: 'autonomy', default: 'off', stage: 'dispatch', status: 'enforced', owner: 'lead', editable: true, note: '派发数据层守卫' },
  { path: 'agents.*.may_dispatch_to', type: 'strings', default: [], stage: 'dispatch', status: 'enforced', owner: 'lead', editable: true, note: '派发数据层守卫' },
  { path: 'agents.*.max_open_from_agents', type: 'integer', bounds: [0, 10], default: 0, stage: 'dispatch', status: 'enforced', owner: 'lead', editable: true, note: '派发数据层守卫' },
  { path: 'agents.*.max_concurrent', type: 'integer', bounds: [1, 5], default: 1, stage: 'dispatch', status: 'enforced', owner: 'item-7', editable: true, note: '数据层：claim 并发上限 / write_scope 必须命中 allowlist（smoke-limits 覆盖）' },
  { path: 'agents.*.scope_allowlist', type: 'strings', default: [], stage: 'dispatch', status: 'enforced', owner: 'item-7', editable: true, note: '数据层：claim 并发上限 / write_scope 必须命中 allowlist（smoke-limits 覆盖）' },
  { path: 'agents.*.capabilities', type: 'strings', default: [], stage: 'config', status: 'enforced', owner: 'lead', editable: true, note: '能力元数据用于提示与看板，不限制权限' },
  { path: 'network.default', type: 'literal:deny', default: 'deny', stage: 'dispatch', status: 'enforced', owner: 'item-6', editable: true, registry: false, note: '第 6 项：网络默认拒绝（只允许字面量 deny）' },
  { path: 'network.local_services', type: 'localServices', default: [], stage: 'dispatch', status: 'enforced', owner: 'item-6', editable: true, registry: false, note: '第 6 项：localhost 精确端口白名单' },
  { path: 'retention.terminal_task_days', type: 'integer', bounds: [0, 3650], default: 0, stage: 'config', status: 'enforced', owner: 'item-10', editable: true, registry: false, note: '第 10 项：0 表示不清理' },
  { path: 'retention.message_days', type: 'integer', bounds: [0, 3650], default: 0, stage: 'config', status: 'enforced', owner: 'item-10', editable: true, registry: false, note: '第 10 项：0 表示不清理' },
  { path: 'retention.guard_event_days', type: 'integer', bounds: [0, 3650], default: 0, stage: 'config', status: 'enforced', owner: 'item-10', editable: true, registry: false, note: '第 10 项：0 表示不清理' },
  { path: 'retention.raw_usage_days', type: 'integer', bounds: [0, 3650], default: 0, stage: 'config', status: 'enforced', owner: 'item-10', editable: true, registry: false, note: '第 10 项：0 表示不清理' },
  { path: 'retention.log_days', type: 'integer', bounds: [0, 3650], default: 0, stage: 'config', status: 'enforced', owner: 'item-10', editable: true, registry: false, note: '第 10 项：0 表示不清理' },
  // 第 10 项第 13 条：原名 max_log_bytes 实际只约束单个文件，正名为 max_single_log_bytes；
  // 旧名进 DEPRECATED_POLICY_PATHS（读入允许、保存后消失），保存路径里新名优先。
  { path: 'retention.max_single_log_bytes', type: 'integer', bounds: [0, 100000000000], default: 0, stage: 'config', status: 'enforced', owner: 'item-10', editable: true, registry: false, note: '第 10 项：单个日志文件的大小阈值（不是目录总量），0 表示不清理' },
  { path: 'retention.archive_lease_ttl_min', type: 'integer', bounds: [0, 1440], default: 30, stage: 'config', status: 'enforced', owner: 'item-10', editable: true, registry: false, note: '第 10 项：归档单例租约的持锁时长上限（分钟），0 表示不设上限' },
  // 第 10 项第 12 条：数据库快照与任务 JSONL 归档包的二级保留。
  // editable=true 表示可在策略面板编辑（保存路径必须同步认这些键，否则会被静默丢弃）；
  // registry=false 表示有意不进 policy-runtime 注册表（由专属 retention 面板编辑，同其它 retention 字段）。
  { path: 'retention.snapshot_days', type: 'integer', bounds: [0, 3650], default: 0, stage: 'config', status: 'enforced', owner: 'item-10', editable: true, registry: false, note: '第 10 项第 12 条：数据库快照保留天数，0 表示不清理' },
  { path: 'retention.archive_bundle_days', type: 'integer', bounds: [0, 3650], default: 0, stage: 'config', status: 'enforced', owner: 'item-10', editable: true, registry: false, note: '第 10 项第 12 条：任务 JSONL 归档包保留天数，0 表示不清理' },
  { path: 'retention.min_snapshots', type: 'integer', bounds: [0, 1000], default: 0, stage: 'config', status: 'enforced', owner: 'item-10', editable: true, registry: false, note: '第 10 项第 12 条：无论多老都保留的最新快照个数（硬下限）' },
  { path: 'retention.min_archive_bundles', type: 'integer', bounds: [0, 1000], default: 0, stage: 'config', status: 'enforced', owner: 'item-10', editable: true, registry: false, note: '第 10 项第 12 条：无论多老都保留的最新归档包个数（硬下限）' },
  // 第 48 项：孤儿过期行（thread/task_id 为空或指向不存在的任务）没有归档凭据，默认永不删除；
  // 只有本字段显式为 1 才允许清理。0 = 只上报（保守缺省）。
  // default 故意为 null：admin-config 的保存白名单（另一个轨道的文件）还不认这个键，
  // 若这里补默认值，读出来的策略会多出一个"保存时会被静默丢弃"的字段，往返就不无损了。
  // 缺省语义由 archive.mjs 自己按 0 处理（只上报、不删）。
  { path: 'retention.prune_unmanaged', type: 'integer', bounds: [0, 1], default: null, stage: 'config', status: 'enforced', owner: 'item-10', editable: true, registry: false, note: '第 48 项：1 表示允许删除无归档凭据的孤儿过期行，缺省/0 表示只上报不删' },
];

// 已废弃字段：允许出现在旧配置里（会被丢弃并在保存后消失），不算未知字段
export const DEPRECATED_POLICY_PATHS = ['economics.lead_plans_once', 'retention.max_log_bytes'];

export const TOP_SECTIONS = ['lead', 'redline', 'permissions', 'global', 'economics', 'network', 'retention', 'agents'];
export const STRUCTURED_SECTIONS = { redline: ['human_only'], network: ['default', 'local_services'], retention: ['terminal_task_days', 'message_days', 'guard_event_days', 'raw_usage_days', 'log_days', 'snapshot_days', 'archive_bundle_days', 'min_snapshots', 'min_archive_bundles', 'max_single_log_bytes', 'archive_lease_ttl_min', 'prune_unmanaged', 'max_log_bytes'] };
export const AGENT_KEYS = ['autonomy', 'may_dispatch_to', 'max_open_from_agents', 'max_concurrent', 'scope_allowlist', 'capabilities'];

export function schemaPaths() { return POLICY_SCHEMA.map(function (entry) { return entry.path; }); }
export function registryFields() { return POLICY_SCHEMA.filter(function (entry) { return entry.registry !== false; }); }

// 未知字段报错（而不是静默丢弃）：返回形如 ['economics.foo', 'agents.a.bar'] 的路径列表
export function unknownPolicyPaths(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return [];
  const out = [];
  for (const key of Object.keys(input)) {
    if (TOP_SECTIONS.indexOf(key) < 0) out.push(key);
  }
  const known = {};
  for (const entry of POLICY_SCHEMA) {
    const parts = entry.path.split('.');
    if (parts[0] === 'agents') continue;
    known[parts[0]] = known[parts[0]] || [];
    known[parts[0]].push(parts[1]);
  }
  for (const section of ['permissions', 'global', 'economics']) {
    const raw = input[section];
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue;
    for (const key of Object.keys(raw)) {
      if ((known[section] || []).indexOf(key) < 0) out.push(section + '.' + key);
    }
  }
  const agents = input.agents;
  if (agents && typeof agents === 'object' && !Array.isArray(agents)) {
    for (const id of Object.keys(agents)) {
      const cfg = agents[id];
      if (!cfg || typeof cfg !== 'object' || Array.isArray(cfg)) continue;
      for (const key of Object.keys(cfg)) {
        if (AGENT_KEYS.indexOf(key) < 0) out.push('agents.' + id + '.' + key);
      }
    }
  }
  for (const section of Object.keys(STRUCTURED_SECTIONS)) {
    const raw = input[section];
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue;
    for (const key of Object.keys(raw)) {
      if (STRUCTURED_SECTIONS[section].indexOf(key) < 0) out.push(section + '.' + key);
    }
  }
  return out.filter(function (path) { return DEPRECATED_POLICY_PATHS.indexOf(path) < 0; });
}

// 用同一份 schema 补默认值：只补"缺失"，不覆盖已有值（含 false / null / []）
export function applyPolicyDefaults(input) {
  const source = input && typeof input === 'object' && !Array.isArray(input) ? input : {};
  const out = JSON.parse(JSON.stringify(source));
  for (const entry of POLICY_SCHEMA) {
    if (entry.default === null || entry.default === undefined) continue;
    const parts = entry.path.split('.');
    if (parts[0] === 'agents') continue;
    let cursor = out;
    let ok = true;
    for (let i = 0; i < parts.length - 1; i += 1) {
      if (cursor[parts[i]] == null || typeof cursor[parts[i]] !== 'object' || Array.isArray(cursor[parts[i]])) cursor[parts[i]] = {};
      cursor = cursor[parts[i]];
    }
    if (!Object.prototype.hasOwnProperty.call(cursor, parts[parts.length - 1])) {
      cursor[parts[parts.length - 1]] = Array.isArray(entry.default) ? entry.default.slice() : entry.default;
    }
  }
  return out;
}
