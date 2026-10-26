-- Agent Bus schema. 由 store.mjs 在每次启动时执行，须保持幂等。
PRAGMA journal_mode = WAL;

-- 第 12 项第 5 条：迁移版本台账。(version,checksum) 是"这份库跑过哪些步骤"的唯一凭据：
-- checksum 与代码里的步骤定义不匹配时 migrations.mjs 立即停止，且停止前不做任何 DDL。
CREATE TABLE IF NOT EXISTS schema_migrations (
  version    INTEGER PRIMARY KEY,
  name       TEXT NOT NULL,
  applied_at TEXT NOT NULL,
  checksum   TEXT NOT NULL
);

-- 第 15 项第 4 条：项目迁移台账（adopt 的唯一凭据；与 tasks.project 更新同一事务）
CREATE TABLE IF NOT EXISTS project_migrations (
  migration_id   TEXT PRIMARY KEY,
  legacy_project TEXT NOT NULL,
  new_project    TEXT NOT NULL,
  path           TEXT NOT NULL,
  tasks_migrated INTEGER NOT NULL DEFAULT 0,
  actor          TEXT NOT NULL,
  created_at     TEXT NOT NULL,
  note           TEXT
);
CREATE INDEX IF NOT EXISTS i_project_migrations_legacy ON project_migrations(legacy_project, created_at);

CREATE TABLE IF NOT EXISTS agentbus_runtime_state (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  enabled INTEGER NOT NULL DEFAULT 0 CHECK (enabled IN (0,1)),
  updated_at TEXT NOT NULL,
  updated_by TEXT NOT NULL CHECK (updated_by IN ('system','human')),
  version INTEGER NOT NULL DEFAULT 0 CHECK (version >= 0)
);
INSERT OR IGNORE INTO agentbus_runtime_state(singleton,enabled,updated_at,updated_by,version)
VALUES(1,0,strftime('%Y-%m-%dT%H:%M:%fZ','now'),'system',0);

CREATE TABLE IF NOT EXISTS messages (
  seq        INTEGER PRIMARY KEY AUTOINCREMENT,
  msg_id     TEXT NOT NULL UNIQUE,
  ts         TEXT NOT NULL,
  sender     TEXT NOT NULL,
  recipient  TEXT NOT NULL,
  thread     TEXT,
  kind       TEXT NOT NULL,
  body       TEXT NOT NULL,
  refs       TEXT,
  reply_to   TEXT,
  hop        INTEGER NOT NULL DEFAULT 0,
  chain_root TEXT,
  claimed_by TEXT
);
CREATE INDEX IF NOT EXISTS i_msg_seq    ON messages(seq);
CREATE INDEX IF NOT EXISTS i_msg_thread ON messages(thread, seq);

CREATE TABLE IF NOT EXISTS tasks (
  id             TEXT PRIMARY KEY,
  title          TEXT NOT NULL,
  body           TEXT,
  project        TEXT NOT NULL DEFAULT 'default',
  status         TEXT NOT NULL,
  owner          TEXT,
  origin         TEXT NOT NULL DEFAULT 'human',
  dispatched_by  TEXT,
  target         TEXT,
  depth          INTEGER NOT NULL DEFAULT 0,
  cost_class     TEXT NOT NULL DEFAULT 'standard',
  token_budget   INTEGER,
  write_scope    TEXT,
  max_subagents  INTEGER NOT NULL DEFAULT 0,
  version        INTEGER NOT NULL DEFAULT 0,
  lease_until    TEXT,
  decline_reason TEXT,
  verify_cmd     TEXT,
  verify_id      TEXT,
  verify_spec_json TEXT,
  verify_spec_hash TEXT,
  extra_dirs     TEXT,
  redline        TEXT,
  grants         TEXT,
  network_grants TEXT,
  round_count    INTEGER NOT NULL DEFAULT 0,
  retry_limit    INTEGER,
  parent_task_id TEXT,
  guard          TEXT,
  changed_files  INTEGER,
  needs_human    INTEGER NOT NULL DEFAULT 0,
  escalated_at   TEXT,
  created_at     TEXT NOT NULL,
  updated_at     TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS i_tasks_status ON tasks(status, owner);
CREATE INDEX IF NOT EXISTS i_tasks_project ON tasks(project, status);

CREATE TRIGGER IF NOT EXISTS runtime_tasks_insert BEFORE INSERT ON tasks
WHEN COALESCE((SELECT enabled FROM agentbus_runtime_state WHERE singleton=1),0) <> 1
BEGIN SELECT RAISE(ABORT, 'agentbus_disabled'); END;
CREATE TRIGGER IF NOT EXISTS runtime_tasks_start BEFORE UPDATE ON tasks
WHEN COALESCE((SELECT enabled FROM agentbus_runtime_state WHERE singleton=1),0) <> 1
  AND ((NEW.status='claimed' AND OLD.status='open')
    OR (NEW.status='open' AND OLD.status='proposed')
    OR (NEW.status='open' AND (NEW.target IS NOT OLD.target OR NEW.dispatched_by IS NOT OLD.dispatched_by)))
BEGIN SELECT RAISE(ABORT, 'agentbus_disabled'); END;

-- 守卫/红线事件流水：只增不改，是"谁在什么时候放了行"的唯一凭据
CREATE TABLE IF NOT EXISTS guard_events (
  id      INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id TEXT,
  agent   TEXT,
  kind    TEXT,
  detail  TEXT,
  action  TEXT,
  actor   TEXT,
  ts      TEXT
);
CREATE INDEX IF NOT EXISTS i_guard_task ON guard_events(task_id, ts);

CREATE TABLE IF NOT EXISTS presence (
  agent_id  TEXT PRIMARY KEY,
  status    TEXT NOT NULL DEFAULT 'idle',
  pid       INTEGER,
  session   TEXT,
  last_seen TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS cursor (
  agent_id TEXT PRIMARY KEY,
  last_seq INTEGER NOT NULL DEFAULT 0
);

-- token 按"谁消耗"记账，不按"任务 owner"记账。
-- Lead 在派活/验收时消耗的 token 必须记在 Lead 名下，否则省钱指标从根上就是错的。
CREATE TABLE IF NOT EXISTS token_usage (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  agent      TEXT NOT NULL,
  task_id    TEXT,
  phase      TEXT,
  tokens_in  INTEGER NOT NULL DEFAULT 0,
  tokens_out INTEGER NOT NULL DEFAULT 0,
  ts         TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS i_usage_agent ON token_usage(agent, ts);

-- 合并请求（第 11 项）：唯一合法状态机 proposed → approved → merging → merged|failed|cancelled。
-- 创建需要 permissions.merge；批准只有 human 能做（任务的 accept 权限不能当 merge 权限用）。
CREATE TABLE IF NOT EXISTS merge_requests (
  id            TEXT PRIMARY KEY,
  project       TEXT NOT NULL,
  task_ids_json TEXT NOT NULL DEFAULT '[]',
  source_ref    TEXT NOT NULL,
  target_ref    TEXT NOT NULL DEFAULT 'main',
  status        TEXT NOT NULL CHECK (status IN ('proposed','approved','merging','merged','failed','cancelled')),
  requested_by  TEXT NOT NULL,
  approved_by   TEXT,
  verify_run_id TEXT,
  merge_commit  TEXT,
  version       INTEGER NOT NULL DEFAULT 0,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL,
  -- 第 11 项：执行阶段留痕与"发现值变化 → 回到需人工确认"标志（不改 status 的 CHECK 约束，不许重建表）
  worker_id          TEXT,
  started_at         TEXT,
  lease_until        TEXT,
  approved_preflight TEXT,
  error              TEXT,
  log_path           TEXT,
  log_sha256         TEXT,
  needs_human        INTEGER NOT NULL DEFAULT 0,
  needs_human_reason TEXT
);
CREATE INDEX IF NOT EXISTS i_merge_status ON merge_requests(status, created_at);
CREATE INDEX IF NOT EXISTS i_merge_project ON merge_requests(project, status);

-- 归档聚合（第 10 项）：按 (天, agent, project, task) 折叠的用量。
-- 清理原始 token_usage 前必须先 upsert 到这里并核对总和；查询层合并 daily 与未归档 raw。
CREATE TABLE IF NOT EXISTS token_usage_daily (
  day_key     TEXT NOT NULL,
  agent       TEXT NOT NULL,
  project     TEXT NOT NULL DEFAULT '',
  task_id     TEXT NOT NULL DEFAULT '',
  tokens_in   INTEGER NOT NULL DEFAULT 0,
  tokens_out  INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (day_key, agent, project, task_id)
);
CREATE INDEX IF NOT EXISTS i_usage_daily_agent ON token_usage_daily(agent, day_key);

-- 已归档任务的快照凭据：JSONL 归档文件的路径、hash 与大小
CREATE TABLE IF NOT EXISTS task_archives (
  task_id      TEXT PRIMARY KEY,
  archive_path TEXT NOT NULL,
  archived_at  TEXT NOT NULL,
  sha256       TEXT NOT NULL,
  bytes        INTEGER NOT NULL
);

-- 归档单例租约（第 10 项第 14 条）：同一时刻只允许一个 archive 运行；
-- id 固定为 'archive'，靠主键 + 未过期判定实现"单例"。
CREATE TABLE IF NOT EXISTS archive_leases (
  id          TEXT PRIMARY KEY,
  holder      TEXT NOT NULL,
  acquired_at TEXT NOT NULL,
  expires_at  TEXT NOT NULL,
  note        TEXT,
  -- 第 10 项长尾：单调递增的 fencing token。每次获取/接管租约都换新值，
  -- 旧 worker 即使租约过期后恢复，也必须因为 token 不匹配而无法提交。
  fence_token INTEGER NOT NULL DEFAULT 0
);

-- 日志引用：只有引用任务已归档且文件 hash 一致时才允许删除
CREATE TABLE IF NOT EXISTS artifact_refs (
  task_id       TEXT NOT NULL,
  kind          TEXT NOT NULL,
  relative_path TEXT NOT NULL,
  sha256        TEXT,
  size          INTEGER,
  PRIMARY KEY (task_id, kind, relative_path)
);

-- 预留：supervisor 启动模型前先占额度，commit 后释放为实际用量。
-- 只有 committed_at IS NULL 且 expires_at 未过的行算"占着"（崩溃遗留按过期自动释放）。
CREATE TABLE IF NOT EXISTS token_reservations (
  id              TEXT PRIMARY KEY,
  agent           TEXT NOT NULL,
  task_id         TEXT,
  day_key         TEXT NOT NULL,
  reserved_tokens INTEGER NOT NULL CHECK (reserved_tokens > 0),
  expires_at      TEXT NOT NULL,
  committed_at    TEXT
);
CREATE INDEX IF NOT EXISTS i_res_day  ON token_reservations(day_key, committed_at);
CREATE INDEX IF NOT EXISTS i_res_task ON token_reservations(task_id, committed_at);


CREATE TABLE IF NOT EXISTS execution_grants (
  grant_id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL,
  owner TEXT NOT NULL,
  task_version INTEGER NOT NULL,
  roots_json TEXT NOT NULL,
  redline_json TEXT NOT NULL,
  issued_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  revoked_at TEXT,
  revoke_reason TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS i_execution_grant_active
ON execution_grants(task_id,owner) WHERE revoked_at IS NULL;

CREATE TRIGGER IF NOT EXISTS revoke_execution_on_task_update AFTER UPDATE ON tasks
WHEN NEW.owner IS NOT OLD.owner OR NEW.target IS NOT OLD.target
  OR NEW.status NOT IN ('claimed','in_progress')
  OR (NEW.version <> OLD.version AND NOT (OLD.status='claimed' AND NEW.status='in_progress'))
BEGIN
  UPDATE execution_grants SET revoked_at=strftime('%Y-%m-%dT%H:%M:%fZ','now'),revoke_reason='task_changed'
  WHERE task_id=NEW.id AND revoked_at IS NULL;
END;
CREATE TRIGGER IF NOT EXISTS advance_execution_on_start AFTER UPDATE ON tasks
WHEN OLD.status='claimed' AND NEW.status='in_progress' AND NEW.owner IS OLD.owner
BEGIN
  UPDATE execution_grants SET task_version=NEW.version
  WHERE task_id=NEW.id AND owner=NEW.owner AND task_version=OLD.version AND revoked_at IS NULL;
END;
CREATE TRIGGER IF NOT EXISTS revoke_execution_on_task_delete AFTER DELETE ON tasks
BEGIN
  UPDATE execution_grants SET revoked_at=strftime('%Y-%m-%dT%H:%M:%fZ','now'),revoke_reason='task_deleted'
  WHERE task_id=OLD.id AND revoked_at IS NULL;
END;


CREATE TABLE IF NOT EXISTS verification_runs (
  run_id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL,
  verify_id TEXT,
  verify_spec_hash TEXT,
  started_at TEXT NOT NULL,
  finished_at TEXT NOT NULL,
  exit_code INTEGER,
  duration_ms INTEGER NOT NULL,
  ok INTEGER NOT NULL,
  stdout_tail TEXT NOT NULL,
  stderr_tail TEXT NOT NULL,
  log_path TEXT,
  reason TEXT
);
CREATE INDEX IF NOT EXISTS i_verification_task ON verification_runs(task_id,started_at);

-- 评审指派（第 9 项）：同一任务同时只允许一个 active（已认领）评审，由部分唯一索引强制。
-- pending = 已指派/待认领；它不剥夺 permissions.accept 的最终状态权限，但 active 的 verdict 不可绕过。
CREATE TABLE IF NOT EXISTS reviews (
  id           TEXT PRIMARY KEY,
  task_id      TEXT NOT NULL,
  reviewer     TEXT,
  route        TEXT NOT NULL CHECK (route IN ('auto','peer','lead','human')),
  status       TEXT NOT NULL,
  task_version INTEGER,
  verdict      TEXT,
  summary      TEXT,
  lease_until  TEXT,
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS i_reviews_active ON reviews(task_id) WHERE status = 'active';
CREATE INDEX IF NOT EXISTS i_reviews_task     ON reviews(task_id, created_at);
CREATE INDEX IF NOT EXISTS i_reviews_pending  ON reviews(status, created_at);
CREATE INDEX IF NOT EXISTS i_reviews_reviewer ON reviews(reviewer, status);

-- 网络判定流水：只记目标与结果，是"谁批准了哪个目标、代理放行了什么"的唯一凭据。
-- 白名单纪律：Authorization、Cookie、query 与正文永不入库（写入统一走 network-policy.recordEvent）。
CREATE TABLE IF NOT EXISTS network_events (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id     TEXT,
  grant_id    TEXT,
  protocol    TEXT,
  host        TEXT,
  port        INTEGER,
  resolved_ip TEXT,
  decision    TEXT NOT NULL,
  status_code INTEGER,
  bytes       INTEGER,
  ts          TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS i_net_events_task ON network_events(task_id, ts);
CREATE INDEX IF NOT EXISTS i_net_events_ts ON network_events(ts);

-- 升级记录：task_id + kind 唯一，是"只升级一次"的唯一凭据（retry_exceeded / chain_limit）。
CREATE TABLE IF NOT EXISTS task_escalations (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id    TEXT NOT NULL,
  kind       TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE(task_id, kind)
);
CREATE INDEX IF NOT EXISTS i_escalation_kind ON task_escalations(kind, created_at);

CREATE TABLE IF NOT EXISTS agent_credentials (
  agent_id     TEXT NOT NULL,
  token_hash   TEXT NOT NULL PRIMARY KEY,
  created_at   TEXT NOT NULL,
  expires_at   TEXT,
  revoked_at   TEXT,
  last_used_at TEXT,
  state        TEXT NOT NULL DEFAULT 'active' CHECK (state IN ('pending','active','revoked'))
);
CREATE INDEX IF NOT EXISTS i_cred_agent ON agent_credentials(agent_id, revoked_at);
CREATE INDEX IF NOT EXISTS i_cred_state ON agent_credentials(agent_id, state);

CREATE TABLE IF NOT EXISTS audit_log (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  actor       TEXT NOT NULL,
  auth_method TEXT NOT NULL,
  action      TEXT NOT NULL,
  resource    TEXT,
  result      TEXT NOT NULL,
  remote_addr TEXT,
  ts          TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS i_audit_ts ON audit_log(ts);
