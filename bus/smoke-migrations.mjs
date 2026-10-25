// 第 12 项第 5/10 条：老库升级回归。
// 背景事故：CREATE TABLE IF NOT EXISTS 不会补列，而 schema.sql 会为新列建索引，
// 真实 bus.db 因此在 openDb() 抛 "no such column: state" 完全打不开。
// 现在补列顺序 + 版本化台账（schema_migrations）+ checksum 校验必须一起守住。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { migrateDb, migrationPlan, ALLOW_NO_SNAPSHOT_ENV } from './migrations.mjs';
import { fingerprint, sameFingerprint, sameContent, describe } from './smoke-support/db-fingerprint.mjs';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentbus-migrate-'));
const BUS_DIR = path.dirname(fileURLToPath(import.meta.url));
const PLAN = migrationPlan();
let passed = 0;
let skipped = 0;
function check(name, fn) { fn(); passed += 1; console.log('PASS ' + name); }
function skip(name, why) { skipped += 1; console.log('SKIP ' + name + '（' + why + '）'); }
function columns(db, table) { return db.prepare('PRAGMA table_info(' + table + ')').all().map(function (c) { return c.name; }); }
function makeLegacyDb(file) {
  const db = new DatabaseSync(file);
  db.exec('CREATE TABLE agent_credentials (agent_id TEXT NOT NULL, token_hash TEXT NOT NULL PRIMARY KEY, created_at TEXT NOT NULL, expires_at TEXT, revoked_at TEXT, last_used_at TEXT);');
  db.exec("INSERT INTO agent_credentials(agent_id,token_hash,created_at) VALUES('codex/main','deadbeef','2026-01-01T00:00:00.000Z');");
  return db;
}

try {
  console.log('[1] 历史事故夹具：agent_credentials 缺 state（被 i_cred_state 索引引用）');
  check('老库能被 migrateDb 打开而不抛 no such column', () => {
    const db = makeLegacyDb(path.join(dir, 'legacy-a.db'));
    try { migrateDb(db); } finally { db.close(); }
  });
  check('state 列被补上，且老数据默认为 active', () => {
    const db = makeLegacyDb(path.join(dir, 'legacy-b.db'));
    try {
      migrateDb(db);
      assert.ok(columns(db, 'agent_credentials').includes('state'), 'state 缺失');
      const row = db.prepare("SELECT agent_id, state FROM agent_credentials WHERE agent_id='codex/main'").get();
      assert.equal(row.agent_id, 'codex/main');
      assert.equal(row.state, 'active');
    } finally { db.close(); }
  });
  check('i_cred_state 索引在迁移后可用', () => {
    const db = makeLegacyDb(path.join(dir, 'legacy-c.db'));
    try {
      migrateDb(db);
      assert.ok(db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND name='i_cred_state'").get(), 'i_cred_state 索引不存在');
    } finally { db.close(); }
  });
  check('重复迁移幂等', () => {
    const db = makeLegacyDb(path.join(dir, 'legacy-d.db'));
    try { migrateDb(db); migrateDb(db); assert.ok(columns(db, 'agent_credentials').length >= 7); } finally { db.close(); }
  });
  check('全新空库也能迁移', () => {
    const db = new DatabaseSync(path.join(dir, 'fresh.db'));
    try { migrateDb(db); } finally { db.close(); }
  });

  console.log('');
  console.log('[2] schema_migrations 台账');
  check('当前代码里有 7 个按版本排序的步骤定义，checksum 都是 64 位十六进制', () => {
    assert.equal(PLAN.length, 8, JSON.stringify(PLAN.map(function (p) { return p.version; })));
    assert.deepEqual(PLAN.map(function (p) { return p.version; }), [1, 2, 3, 4, 5, 6, 7, 8]);
    assert.ok(PLAN.every(function (p) { return /^[0-9a-f]{64}$/.test(p.checksum) && p.name && p.file; }), JSON.stringify(PLAN[0]));
    assert.deepEqual(PLAN.map(function (p) { return p.checksum; }), migrationPlan().map(function (p) { return p.checksum; }), 'checksum 不稳定');
  });
  check('全新库跑完 7 个版本都记账，且 applied_at 是 ISO 时间', () => {
    const db = new DatabaseSync(path.join(dir, 'reg-a.db'));
    try {
      const result = migrateDb(db);
      assert.deepEqual(result.applied, [1, 2, 3, 4, 5, 6, 7, 8]);
      const rows = db.prepare('SELECT version, name, applied_at, checksum FROM schema_migrations ORDER BY version').all();
      assert.equal(rows.length, PLAN.length);
      assert.ok(rows.every(function (r) { return /^[0-9]{4}-[0-9]{2}-[0-9]{2}T/.test(r.applied_at) && /^[0-9a-f]{64}$/.test(r.checksum) && r.name; }), JSON.stringify(rows[0]));
      assert.deepEqual(rows.map(function (r) { return r.checksum; }), PLAN.map(function (p) { return p.checksum; }));
    } finally { db.close(); }
  });
  check('第二次迁移不再新增台账行、checksum 不变', () => {
    const db = new DatabaseSync(path.join(dir, 'reg-b.db'));
    try {
      migrateDb(db);
      const before = db.prepare('SELECT version, checksum FROM schema_migrations ORDER BY version').all();
      const again = migrateDb(db);
      assert.deepEqual(again.applied, []);
      const after = db.prepare('SELECT version, checksum FROM schema_migrations ORDER BY version').all();
      assert.deepEqual(after, before);
    } finally { db.close(); }
  });

  console.log('');
  console.log('[3] 真实升级夹具：早期 partial table 缺「被 schema 索引引用的列」');
  check('多张表同时缺列（agent_credentials.state / reviews.status / merge_requests.status / tasks.needs_human）也能升级', () => {
    const db = new DatabaseSync(path.join(dir, 'partial.db'));
    try {
      // 只缺"后来版本新增的列"；基础列（含被 schema 索引引用的 project）必须保留，否则就不是真实老库
      db.exec('CREATE TABLE tasks (id TEXT PRIMARY KEY, title TEXT NOT NULL, body TEXT, project TEXT NOT NULL DEFAULT \'default\', status TEXT NOT NULL, owner TEXT, origin TEXT NOT NULL DEFAULT \'human\', created_at TEXT NOT NULL DEFAULT \'x\', updated_at TEXT NOT NULL);');
      db.exec("INSERT INTO tasks(id,title,status,updated_at) VALUES('t-0001','旧任务','done','2026-01-01T00:00:00.000Z');");
      db.exec('CREATE TABLE reviews (id TEXT PRIMARY KEY, task_id TEXT NOT NULL, created_at TEXT);');
      db.exec("INSERT INTO reviews(id,task_id) VALUES('r-1','t-0001');");
      db.exec('CREATE TABLE merge_requests (id TEXT PRIMARY KEY, project TEXT NOT NULL);');
      db.exec("INSERT INTO merge_requests(id,project) VALUES('m-1','proj');");
      db.exec('CREATE TABLE agent_credentials (agent_id TEXT NOT NULL, token_hash TEXT NOT NULL PRIMARY KEY, created_at TEXT NOT NULL, expires_at TEXT, revoked_at TEXT, last_used_at TEXT);');
      db.exec("INSERT INTO agent_credentials(agent_id,token_hash,created_at) VALUES('w/1','h','2026-01-01T00:00:00.000Z');");
      assert.doesNotThrow(function () { migrateDb(db); });
      assert.ok(columns(db, 'tasks').includes('needs_human'));
      assert.ok(columns(db, 'reviews').includes('status') && columns(db, 'reviews').includes('route'));
      assert.ok(columns(db, 'merge_requests').includes('status') && columns(db, 'merge_requests').includes('created_at') && columns(db, 'merge_requests').includes('needs_human'));
      assert.ok(columns(db, 'agent_credentials').includes('state'));
      for (const index of ['i_cred_state', 'i_reviews_pending', 'i_reviews_active', 'i_merge_status', 'i_tasks_status']) {
        assert.ok(db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND name=?").get(index), '索引缺失: ' + index);
      }
      assert.equal(db.prepare("SELECT COUNT(*) AS c FROM tasks WHERE id='t-0001'").get().c, 1);
      assert.equal(db.prepare("SELECT COUNT(*) AS c FROM reviews WHERE id='r-1'").get().c, 1);
      assert.equal(db.prepare("SELECT COUNT(*) AS c FROM merge_requests WHERE id='m-1'").get().c, 1);
      assert.equal(db.prepare("SELECT COUNT(*) AS c FROM agent_credentials WHERE agent_id='w/1'").get().c, 1);
      assert.equal(db.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
      assert.equal(db.prepare('SELECT COUNT(*) AS c FROM schema_migrations').get().c, PLAN.length);
    } finally { db.close(); }
  });

  console.log('');
  console.log('[4] checksum 不匹配：立即停止、零 DDL、旧库仍可打开');
  const tamperedFile = path.join(dir, 'tampered.db');
  check('checksum 对不上时抛 migration_checksum_mismatch 并指出版本', () => {
    const db = new DatabaseSync(tamperedFile);
    try {
      db.exec('CREATE TABLE agent_credentials (agent_id TEXT NOT NULL, token_hash TEXT NOT NULL PRIMARY KEY, created_at TEXT NOT NULL, expires_at TEXT, revoked_at TEXT, last_used_at TEXT);');
      db.exec('CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL, checksum TEXT NOT NULL);');
      const insert = db.prepare('INSERT INTO schema_migrations(version,name,applied_at,checksum) VALUES(?,?,?,?)');
      for (const step of PLAN) insert.run(step.version, step.name, '2026-01-01T00:00:00.000Z', step.version === 5 ? 'f'.repeat(64) : step.checksum);
      let thrown = null;
      try { migrateDb(db); } catch (error) { thrown = error; }
      assert.ok(thrown, '应当抛错');
      assert.equal(thrown.code, 'migration_checksum_mismatch');
      assert.equal(thrown.version, 5);
      assert.ok(String(thrown.message).includes('migration_checksum_mismatch') && String(thrown.message).includes('版本 5'), String(thrown.message));
    } finally { db.close(); }
  });
  check('停止前一行 DDL 都没做（缺列仍然是缺的），库仍可打开', () => {
    const db = new DatabaseSync(tamperedFile);
    try {
      assert.ok(!columns(db, 'agent_credentials').includes('state'), 'state 不该被补上');
      assert.equal(db.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
      assert.equal(db.prepare('SELECT COUNT(*) AS c FROM schema_migrations').get().c, PLAN.length);
    } finally { db.close(); }
  });
  check('库里版本比代码新（v99）→ 抛 migration_unknown_version 而不是硬跑', () => {
    const db = new DatabaseSync(path.join(dir, 'ahead.db'));
    try {
      migrateDb(db);
      db.prepare("INSERT INTO schema_migrations(version,name,applied_at,checksum) VALUES(99,'future','2026-01-01T00:00:00.000Z','x')").run();
      let thrown = null;
      try { migrateDb(db); } catch (error) { thrown = error; }
      assert.ok(thrown && thrown.code === 'migration_unknown_version' && thrown.version === 99, thrown && thrown.code);
      assert.equal(db.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
    } finally { db.close(); }
  });

  console.log('');
  console.log('[5] 升级前快照 + 失败可恢复');
  check('已有台账的库在升级前生成备份，且备份本身可打开', () => {
    const db = new DatabaseSync(path.join(dir, 'upgrade.db'));
    try {
      migrateDb(db);
      db.prepare('DELETE FROM schema_migrations WHERE version >= 6').run();
      const result = migrateDb(db);
      assert.deepEqual(result.applied, PLAN.map(function (p) { return p.version; }).filter(function (v) { return v >= 6; }));
      assert.ok(result.snapshot && fs.existsSync(result.snapshot), '没生成快照: ' + result.snapshot);
      assert.ok(result.snapshot.includes('migrations-backups'), result.snapshot);
      const backup = new DatabaseSync(result.snapshot);
      try {
        assert.equal(backup.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
        assert.equal(backup.prepare('SELECT COUNT(*) AS c FROM schema_migrations').get().c, 5, '快照应是升级前（只到版本 5）的状态');
      } finally { backup.close(); }
      assert.equal(db.prepare('SELECT COUNT(*) AS c FROM schema_migrations').get().c, PLAN.length);
    } finally { db.close(); }
  });
  check('全新库（没有台账）不产生无意义的快照', () => {
    const db = new DatabaseSync(path.join(dir, 'no-snapshot.db'));
    try {
      const result = migrateDb(db);
      assert.equal(result.snapshot, null);
      assert.equal(result.snapshot_error, null);
    } finally { db.close(); }
  });
  check('第一次跑版本化迁移的真实老库（有业务表、无台账）也要先快照', () => {
    const db = new DatabaseSync(path.join(dir, 'first-versioned.db'));
    try {
      db.exec('CREATE TABLE tasks (id TEXT PRIMARY KEY, title TEXT NOT NULL, project TEXT NOT NULL DEFAULT \'default\', status TEXT NOT NULL, owner TEXT, origin TEXT NOT NULL DEFAULT \'human\', created_at TEXT NOT NULL DEFAULT \'x\', updated_at TEXT NOT NULL);');
      db.exec("INSERT INTO tasks(id,title,status,updated_at) VALUES('t-0009','老数据','done','2026-01-01T00:00:00.000Z');");
      const result = migrateDb(db);
      assert.ok(result.snapshot && fs.existsSync(result.snapshot), '真实老库首跑没快照: ' + result.snapshot);
      const backup = new DatabaseSync(result.snapshot);
      try {
        assert.equal(backup.prepare("SELECT COUNT(*) AS c FROM tasks WHERE id='t-0009'").get().c, 1, '快照应含老数据');
        assert.equal(backup.prepare("SELECT COUNT(*) AS c FROM sqlite_master WHERE type='table' AND name='schema_migrations'").get().c, 0, '快照应是迁移前状态');
      } finally { backup.close(); }
    } finally { db.close(); }
  });

  console.log('');
  console.log('[6] 真实 bus.db 的字节副本能升级（不打开也不修改真实文件）');
  const realDb = path.join(BUS_DIR, 'bus.db');
  const copyFile = path.join(dir, 'real-copy.db');
  if (!fs.existsSync(realDb)) {
    skip('真实 bus.db 可正常打开', '本机没有 bus.db');
  } else {
    for (const suffix of ['', '-wal', '-shm']) {
      if (fs.existsSync(realDb + suffix)) { try { fs.copyFileSync(realDb + suffix, copyFile + suffix); } catch (error) { /* ignore */ } }
    }
    // 三文件指纹（WAL 模式下只看主文件是假绿）+ 逻辑计数
    const realPrint = fingerprint(realDb);
    console.log('  真实库指纹: ' + describe(realPrint) + ' tables=' + JSON.stringify(realPrint.tables && { tasks: realPrint.tables.tasks, schema_migrations: realPrint.tables.schema_migrations }));
    const copyBefore = fingerprint(copyFile);
    let copy = new DatabaseSync(copyFile);
    let healthy = false;
    try { healthy = copy.prepare('PRAGMA integrity_check').get().integrity_check === 'ok'; } catch (error) { healthy = false; }
    if (!healthy) {
      copy.close();
      skip('真实 bus.db 可正常打开', '复制瞬间被并发写打散（WAL 文件拷贝不保证一致），不在断言里假装通过');
    } else {
      try {
        const result = migrateDb(copy);
        assert.equal(copy.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
        assert.equal(copy.prepare('SELECT COUNT(*) AS c FROM schema_migrations').get().c, PLAN.length);
        assert.ok(Array.isArray(result.applied));
        // 真实库可能已被某个进程迁移过（行会落在 -wal 里，主文件字节不变）：
        // 只有本次真的有待执行版本时才要求快照，否则要求"没有待执行版本"这件事自证。
        if (result.applied.length > 0) assert.ok(result.snapshot && fs.existsSync(result.snapshot), '真实库副本有待执行版本却没留快照: ' + result.snapshot + ' / ' + result.snapshot_error);
        else assert.equal(result.snapshot, null);
        // 升级只应动台账，不该动业务数据：逐表行数比对（逻辑计数，不是字节）
        const copyAfter = fingerprint(copyFile);
        assert.equal(copyAfter.version, PLAN.length, '版本未记全: ' + describe(copyAfter));
        assert.equal(copyAfter.tables.schema_migrations, PLAN.length);
        for (const table of Object.keys(copyBefore.tables || {})) {
          if (table === 'schema_migrations') continue;
          assert.equal(copyAfter.tables[table], copyBefore.tables[table], '表 ' + table + ' 行数变了：' + copyBefore.tables[table] + ' → ' + copyAfter.tables[table]);
        }
        // 升级会合法地改变 schema_migrations 版本：真实库可能停在旧版本（常驻进程未升级），
        // 所以只比业务表行数，再单独断言版本「只增不减」。
        for (const table of Object.keys(realPrint.tables || {})) {
          if (table === 'schema_migrations') continue;
          assert.equal(copyAfter.tables[table], realPrint.tables[table], '表 ' + table + ' 与真实库不一致：' + describe(realPrint) + ' vs ' + describe(copyAfter));
        }
        assert.ok(copyAfter.version >= realPrint.version, '升级后版本不该倒退: ' + describe(realPrint) + ' vs ' + describe(copyAfter));
        console.log('  PASS 副本升级后三文件指纹: ' + describe(copyAfter));
        assert.ok(copy.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='tasks'").get(), 'tasks 表不存在');
        assert.ok(columns(copy, 'tasks').includes('needs_human') && columns(copy, 'agent_credentials').includes('state'));
        passed += 1;
        console.log('PASS 真实 bus.db 的字节副本可以升级（真实文件未被打开或修改）');
      } finally { copy.close(); }
    }
  }

  console.log('');
  console.log('[7] 指纹工具 + "空跑迁移一个字节都不写"');
  check('fingerprint 给出三文件哈希与逻辑计数', () => {
    const db = new DatabaseSync(path.join(dir, 'fp-a.db'));
    try { db.exec('CREATE TABLE t(a INTEGER PRIMARY KEY)'); db.exec('INSERT INTO t DEFAULT VALUES'); } finally { db.close(); }
    const print = fingerprint(path.join(dir, 'fp-a.db'));
    assert.ok(print.main && /^[0-9a-f]{64}$/.test(print.main.sha256), describe(print));
    assert.equal(print.wal, null, '关闭后不该留 -wal');
    assert.equal(print.tables.t, 1);
    assert.equal(print.integrity, 'ok');
    assert.equal(print.version, null);
  });
  check('无待执行版本时再跑 migrateDb 不改动任何字节（三文件 + 逻辑计数全等）', () => {
    const file = path.join(dir, 'noop.db');
    let db = new DatabaseSync(file);
    try { migrateDb(db); } finally { db.close(); }
    const before = fingerprint(file);
    db = new DatabaseSync(file);
    try { assert.deepEqual(migrateDb(db).applied, []); } finally { db.close(); }
    const after = fingerprint(file);
    assert.ok(sameFingerprint(before, after), '空跑居然改了库：' + describe(before) + ' → ' + describe(after));
  });

  console.log('');
  console.log('[8] 升级前快照失败 → 默认拒绝启动（含逃生舱）');
  const guardDir = path.join(dir, 'guard');
  const guardFile = path.join(guardDir, 'upgrade.db');
  let guardVersions = null;
  check('快照写不出去时抛 migration_snapshot_required 且不做任何 DDL', () => {
    fs.mkdirSync(guardDir, { recursive: true });
    const db = new DatabaseSync(guardFile);
    try {
      migrateDb(db);
      db.prepare('DELETE FROM schema_migrations WHERE version >= 6').run();
      guardVersions = db.prepare('SELECT COUNT(*) AS c FROM schema_migrations').get().c;
    } finally { db.close(); }
    // 让 migrations-backups 变成普通文件：mkdirSync 必然失败 → 快照失败
    fs.writeFileSync(path.join(guardDir, 'migrations-backups'), 'not a dir');
    const db2 = new DatabaseSync(guardFile);
    let thrown = null;
    try { migrateDb(db2); } catch (error) { thrown = error; }
    try {
      assert.ok(thrown, '应当拒绝启动');
      assert.equal(thrown.code, 'migration_snapshot_required');
      assert.ok(String(thrown.message).includes(ALLOW_NO_SNAPSHOT_ENV), String(thrown.message));
      assert.equal(db2.prepare('SELECT COUNT(*) AS c FROM schema_migrations').get().c, guardVersions, '拒绝前不该写台账');
      assert.equal(db2.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
    } finally { db2.close(); }
  });
  check(ALLOW_NO_SNAPSHOT_ENV + '=1 时放行，并把 snapshot_error 带回来', () => {
    const db = new DatabaseSync(guardFile);
    process.env[ALLOW_NO_SNAPSHOT_ENV] = '1';
    try {
      const result = migrateDb(db);
      assert.deepEqual(result.applied, PLAN.map(function (p) { return p.version; }).filter(function (v) { return v >= 6; }));
      assert.equal(result.snapshot, null);
      assert.ok(result.snapshot_error, '应当带出失败原因');
      assert.equal(db.prepare('SELECT COUNT(*) AS c FROM schema_migrations').get().c, PLAN.length);
    } finally { delete process.env[ALLOW_NO_SNAPSHOT_ENV]; db.close(); }
  });

  console.log('');
  console.log('PASS ' + passed + '   FAIL 0' + (skipped ? '   SKIP ' + skipped : ''));
} finally {
  fs.rmSync(dir, { recursive: true, force: true });
}
