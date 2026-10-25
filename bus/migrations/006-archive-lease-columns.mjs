// 第 12 项第 5 条：版本化迁移步骤 006（第 10 项：归档单例租约表，只补早期残缺表）。
export default {
  version: 6,
  name: 'archive-lease-columns',
  tables: [['archive_leases', [['holder', 'TEXT'], ['acquired_at', 'TEXT'], ['expires_at', 'TEXT'], ['note', 'TEXT']]]],
};
