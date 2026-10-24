-- Agent Bus schema. 由 store.mjs 在每次启动时执行，须保持幂等。
PRAGMA journal_mode = WAL;

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

CREATE TABLE IF NOT EXISTS agent_credentials (
  agent_id     TEXT NOT NULL,
  token_hash   TEXT NOT NULL PRIMARY KEY,
  created_at   TEXT NOT NULL,
  expires_at   TEXT,
  revoked_at   TEXT,
  last_used_at TEXT
);
CREATE INDEX IF NOT EXISTS i_cred_agent ON agent_credentials(agent_id, revoked_at);

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
