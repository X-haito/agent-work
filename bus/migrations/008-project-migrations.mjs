// 第 15 项第 4 条：项目迁移台账表（老库没有这张表时补出来）。
export default {
  version: 8,
  name: 'project-migrations-table',
  tables: [],
  sql: "CREATE TABLE IF NOT EXISTS project_migrations (migration_id TEXT PRIMARY KEY, legacy_project TEXT NOT NULL, new_project TEXT NOT NULL, path TEXT NOT NULL, tasks_migrated INTEGER NOT NULL DEFAULT 0, actor TEXT NOT NULL, created_at TEXT NOT NULL, note TEXT); CREATE INDEX IF NOT EXISTS i_project_migrations_legacy ON project_migrations(legacy_project, created_at);",
};
