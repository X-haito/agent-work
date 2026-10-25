// 第 12 项第 5 条：版本化迁移步骤 007（第 11 项：合并执行留痕 + needs_human 标志，不动 status 的 CHECK 约束）。
export default {
  version: 7,
  name: 'merge-request-execution-columns',
  tables: [
    ['merge_requests', [
      ['worker_id', 'TEXT'], ['started_at', 'TEXT'], ['lease_until', 'TEXT'], ['approved_preflight', 'TEXT'],
      ['error', 'TEXT'], ['log_path', 'TEXT'], ['log_sha256', 'TEXT'],
      ['needs_human', 'INTEGER NOT NULL DEFAULT 0'], ['needs_human_reason', 'TEXT'],
    ]],
  ],
};
