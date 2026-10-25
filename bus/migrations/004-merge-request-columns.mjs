// 第 12 项第 5 条：版本化迁移步骤 004（第 11 项：合并请求基础列）。
export default {
  version: 4,
  name: 'merge-request-columns',
  tables: [
    ['merge_requests', [
      ['task_ids_json', 'TEXT'], ['source_ref', 'TEXT'], ['target_ref', 'TEXT'], ['status', 'TEXT'],
      ['requested_by', 'TEXT'], ['approved_by', 'TEXT'], ['verify_run_id', 'TEXT'], ['merge_commit', 'TEXT'],
      ['version', 'INTEGER DEFAULT 0'], ['created_at', 'TEXT'], ['updated_at', 'TEXT'],
    ]],
  ],
};
