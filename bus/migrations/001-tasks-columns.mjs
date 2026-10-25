// 第 12 项第 5 条：版本化迁移步骤 001。
// 老库里 CREATE TABLE IF NOT EXISTS 不会补列，而 schema.sql 会为**新列**建索引，
// 所以缺列必须在 exec(schema) 之前补上（历史事故：真实 bus.db 抛 no such column: state 打不开）。
export default {
  version: 1,
  name: 'tasks-columns',
  tables: [
    ['tasks', [
      ['verify_id', 'TEXT'], ['verify_spec_json', 'TEXT'], ['verify_spec_hash', 'TEXT'],
      ['verify_cmd', 'TEXT'], ['extra_dirs', 'TEXT'], ['redline', 'TEXT'], ['grants', 'TEXT'],
      ['network_grants', 'TEXT'], ['guard', 'TEXT'],
      ['changed_files', 'INTEGER'], ['needs_human', 'INTEGER NOT NULL DEFAULT 0'], ['escalated_at', 'TEXT'],
      // 第 7 项：轮次与任务树
      ['round_count', 'INTEGER NOT NULL DEFAULT 0'], ['retry_limit', 'INTEGER'], ['parent_task_id', 'TEXT'],
      // 第 8 项：任务级 token 预算（空表示只受日预算限制）
      ['token_budget', 'INTEGER'],
    ]],
  ],
};
