// 第 12 项第 5 条：版本化迁移步骤 003（第 9 项：评审指派表，只补早期残缺表）。
export default {
  version: 3,
  name: 'reviews-columns',
  tables: [
    ['reviews', [
      ['reviewer', 'TEXT'], ['route', 'TEXT'], ['status', 'TEXT'], ['task_version', 'INTEGER'],
      ['verdict', 'TEXT'], ['summary', 'TEXT'], ['lease_until', 'TEXT'], ['created_at', 'TEXT'], ['updated_at', 'TEXT'],
    ]],
  ],
};
