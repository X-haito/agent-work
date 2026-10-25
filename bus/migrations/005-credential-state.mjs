// 第 12 项第 5 条：版本化迁移步骤 005（第 5 项：凭据状态，pending 只有 activate 之后才被认可）。
export default {
  version: 5,
  name: 'credential-state',
  tables: [['agent_credentials', [['state', "TEXT NOT NULL DEFAULT 'active'"]]]],
};
