// 第 12 项第 5/10 条：版本化迁移入口。
//
// 设计要点：
// 1. 步骤定义拆到 bus/migrations/*.mjs（文件名按版本排序），只导出纯数据对象，方便算 checksum；
// 2. schema_migrations(version,name,applied_at,checksum) 记账；**checksum 不匹配立即停止**，
//    且在停止前不做任何 DDL（校验排在最前面）；
// 3. 已有版本的磁盘库在升级前做数据库快照（VACUUM INTO，失败不影响迁移，事务本身保证原子性）；
// 4. 「补列」保留为每次打开都执行的幂等自愈动作（历史事故：列丢失导致真实 bus.db 打不开），
//    版本只负责记账与 SQL 步骤；列补丁必须在 exec(schema) **之前**跑，否则会死在
//    CREATE INDEX 引用的新列上（no such column）。
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const STEPS_DIR = path.join(HERE, 'migrations');
const SCHEMA_FILE = path.join(HERE, 'schema.sql');
const BACKUP_DIRNAME = 'migrations-backups';
const KEEP_BACKUPS = 3;
// 逃生舱：多进程占用导致 VACUUM INTO 必然失败时，允许显式放行"无快照升级"。
// 默认拒绝——需要备份的时刻正是升级前，"以为有备份其实没有"是最坏的组合。
export const ALLOW_NO_SNAPSHOT_ENV = 'AGENTBUS_MIGRATION_ALLOW_NO_SNAPSHOT';
const requireStep = createRequire(import.meta.url);

let STEP_CACHE = null;

function sha256(text) { return crypto.createHash('sha256').update(text).digest('hex'); }

// 稳定序规范化：同一份步骤定义永远算出同一个 checksum（键序不影响）
function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') {
    const out = {};
    for (const key of Object.keys(value).sort()) out[key] = canonical(value[key]);
    return out;
  }
  return value === undefined ? null : value;
}

export function stepChecksum(step) {
  return sha256(JSON.stringify(canonical({
    version: step.version,
    name: step.name,
    tables: step.tables || [],
    sql: step.sql || null,
  })));
}

// 同步加载：migrateDb 必须保持同步（store.mjs 在 openDb 里同步调用它），
// 所以这里用 require() 读 ESM 步骤文件（Node >= 22 支持 require(esm)，前提是步骤文件没有顶层 await）。
export function loadSteps() {
  if (STEP_CACHE) return STEP_CACHE;
  const names = fs.readdirSync(STEPS_DIR)
    .filter(function (n) { return /^\d{3}-.+\.mjs$/.test(n); })
    .sort();
  const steps = [];
  const seen = new Set();
  for (const name of names) {
    const mod = requireStep(path.join(STEPS_DIR, name));
    const step = mod && (mod.default || mod);
    if (!step || typeof step !== 'object') throw new Error('migration_invalid_step: ' + name);
    if (!Number.isSafeInteger(step.version) || step.version <= 0) throw new Error('migration_invalid_version: ' + name);
    if (typeof step.name !== 'string' || !step.name) throw new Error('migration_missing_name: ' + name);
    if (seen.has(step.version)) throw new Error('migration_duplicate_version: ' + step.version);
    if (!Array.isArray(step.tables) && typeof step.sql !== 'string') throw new Error('migration_empty_step: ' + name);
    seen.add(step.version);
    steps.push({
      version: step.version,
      name: step.name,
      file: name,
      tables: Array.isArray(step.tables) ? step.tables : [],
      sql: typeof step.sql === 'string' ? step.sql : null,
      checksum: stepChecksum(step),
    });
  }
  if (!steps.length) throw new Error('migration_no_steps');
  steps.sort(function (a, b) { return a.version - b.version; });
  STEP_CACHE = steps;
  return steps;
}

function migrationError(code, message, detail) {
  const error = new Error(message);
  error.code = code;
  Object.assign(error, detail || {});
  return error;
}

function readRegistrySafe(db) {
  try {
    const rows = db.prepare('SELECT version, name, checksum FROM schema_migrations ORDER BY version').all();
    const map = new Map();
    for (const row of rows) map.set(Number(row.version), { name: row.name, checksum: row.checksum });
    return map;
  } catch (error) { return null; }
}

// 版本台账校验：必须在任何 DDL 之前跑完。任何偏差都直接抛，不给"半迁移"的机会。
function verifyRegistry(recorded, steps) {
  if (!recorded) return;
  const known = new Map(steps.map(function (s) { return [s.version, s]; }));
  for (const [version, row] of recorded) {
    const step = known.get(version);
    if (!step) {
      throw migrationError('migration_unknown_version', 'migration_unknown_version: 库里有版本 ' + version + '（' + row.name + '），当前代码没有这个步骤；请升级代码而不是降级库', { version: version, recorded: row.name });
    }
    if (row.checksum !== step.checksum) {
      throw migrationError('migration_checksum_mismatch', 'migration_checksum_mismatch: 版本 ' + version + '（' + step.name + '）记录 ' + String(row.checksum).slice(0, 12) + '… 与当前定义 ' + step.checksum.slice(0, 12) + '… 不一致，已停止，不做任何改动', { version: version, name: step.name, recorded: row.checksum, expected: step.checksum });
    }
  }
}

// 幂等补列：表不存在就跳过（schema.sql 稍后会建），列已存在就跳过
function applyColumns(db, step) {
  for (const pair of step.tables) {
    const table = pair[0];
    const columns = pair[1] || [];
    let existing;
    try { existing = new Set(db.prepare('PRAGMA table_info(' + table + ')').all().map(function (c) { return c.name; })); }
    catch (error) { continue; }
    if (!existing.size) continue;
    for (const column of columns) {
      const name = column[0];
      const definition = column[1];
      if (!existing.has(name)) db.exec('ALTER TABLE ' + table + ' ADD COLUMN ' + name + ' ' + definition);
    }
  }
}

function hasBusinessTables(db) {
  try { return !!db.prepare("SELECT 1 AS x FROM sqlite_master WHERE type = 'table' AND name = 'tasks'").get(); }
  catch (error) { return false; }
}

function pruneBackups(dir) {
  try {
    const files = fs.readdirSync(dir).filter(function (n) { return /\.db$/.test(n); })
      .map(function (n) { const full = path.join(dir, n); return { full: full, mtime: fs.statSync(full).mtimeMs }; })
      .sort(function (a, b) { return b.mtime - a.mtime; });
    for (const stale of files.slice(KEEP_BACKUPS)) { try { fs.rmSync(stale.full, { force: true }); } catch (error) { /* ignore */ } }
  } catch (error) { /* ignore */ }
}

// 升级前快照：只对"已有版本记录的磁盘库"做（全新库没必要，内存库没路径）。
// 快照失败不阻塞迁移——真正保证一致性的是下面那个事务；快照是灾难恢复用的第二道保险。
// 返回 { path, error }：失败不抛（快照是第二道保险，不能因为它挡住启动），但原因必须往上报，
// 不能像"静默跳过"那样让人以为升级前一定留了备份。
export function takeMigrationSnapshot(db, label) {
  let dbPath = null;
  try { dbPath = typeof db.location === 'function' ? db.location() : null; } catch (error) { dbPath = null; }
  if (!dbPath || dbPath === ':memory:') return { path: null, error: 'no_disk_path' };
  if (!fs.existsSync(dbPath)) return { path: null, error: 'db_file_missing' };
  const dir = path.join(path.dirname(dbPath), BACKUP_DIRNAME);
  try {
    fs.mkdirSync(dir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const target = path.join(dir, path.basename(dbPath) + '.pre-' + String(label || 'migrate') + '-' + stamp + '.db');
    db.prepare('VACUUM INTO ?').run(target);
    pruneBackups(dir);
    return { path: target, error: null };
  } catch (error) { return { path: null, error: 'vacuum_into_failed: ' + String((error && error.message) || error) }; }
}

export function migrateDb(db) {
  const steps = loadSteps();
  const recorded = readRegistrySafe(db);
  // 1) 台账校验（任何 DDL 之前）
  verifyRegistry(recorded, steps);
  const pending = steps.filter(function (step) { return !recorded || !recorded.has(step.version); });
  // "升级"的两种形态都要先快照：① 已有台账但缺版本；② 有业务表却还没有台账（第一次跑版本化迁移的真实老库）。
  // 全新空库（连 tasks 表都没有）不产生无意义的快照。
  const isUpgrade = !!(recorded && recorded.size) || hasBusinessTables(db);
  // 2) 升级前快照（有 pending 才值得做）
  let snapshot = null;
  let snapshotError = null;
  if (isUpgrade && pending.length) {
    const outcome = takeMigrationSnapshot(db, 'v' + pending[pending.length - 1].version);
    snapshot = outcome.path;
    snapshotError = outcome.error;
    if (!snapshot) {
      const allowed = String(process.env[ALLOW_NO_SNAPSHOT_ENV] || '') === '1';
      if (!allowed) {
        // 拒绝启动，且发生在任何 DDL 之前：库保持原样，修好占用/权限后重试即可
        throw migrationError('migration_snapshot_required',
          'migration_snapshot_required: 有 ' + pending.length + ' 个待执行版本，但升级前快照失败（' + snapshotError + '）。拒绝启动以免"以为有备份其实没有"。确需无快照升级请设 ' + ALLOW_NO_SNAPSHOT_ENV + '=1',
          { snapshot_error: snapshotError, pending: pending.map(function (s) { return s.version; }) });
      }
      process.stderr.write('\n!!!!!!!! 本次升级无快照，失败不可恢复（' + ALLOW_NO_SNAPSHOT_ENV + '=1）: ' + snapshotError + ' !!!!!!!!\n\n');
    }
  }

  // 3) 单事务执行：先补列 → 结构 → 再补列 → SQL 步骤 → 记账
  db.exec('BEGIN IMMEDIATE');
  try {
    db.exec('CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL, checksum TEXT NOT NULL)');
    for (const step of steps) applyColumns(db, step);
    const schema = fs.readFileSync(SCHEMA_FILE, 'utf8');
    db.exec(schema.replace(/PRAGMA journal_mode\s*=\s*WAL;/i, ''));
    for (const step of steps) applyColumns(db, step);
    for (const step of pending) if (step.sql) db.exec(step.sql);
    const insert = db.prepare('INSERT OR REPLACE INTO schema_migrations(version,name,applied_at,checksum) VALUES(?,?,?,?)');
    const appliedAt = new Date().toISOString();
    for (const step of pending) insert.run(step.version, step.name, appliedAt, step.checksum);
    db.exec('COMMIT');
    return { ok: true, applied: pending.map(function (s) { return s.version; }), versions: steps.length, snapshot: snapshot, snapshot_error: snapshotError };
  } catch (error) {
    try { db.exec('ROLLBACK'); } catch (inner) { /* ignore */ }
    error.snapshot = snapshot;
    throw error;
  }
}

// 测试/诊断用：当前代码里的版本清单（不打开数据库）
export function migrationPlan() {
  return loadSteps().map(function (step) { return { version: step.version, name: step.name, file: step.file, checksum: step.checksum }; });
}
