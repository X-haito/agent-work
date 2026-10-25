// 数据库指纹（复用工具）：WAL 模式下"主文件哈希"证明不了任何事——
// 写入先进 -wal，主文件要等 checkpoint 才变。所以指纹 = 三个文件的字节哈希 + 逻辑内容计数。
//
// 用法：
//   import { fingerprint, sameFingerprint } from './smoke-support/db-fingerprint.mjs';
//   const before = fingerprint(dbPath);
//   ... 跑被测逻辑 ...
//   assert.ok(sameFingerprint(before, fingerprint(dbPath)), '数据库被改动了');
//
// 约定：
// - 文件哈希用 fs 读字节，不打开 sqlite（读之前的状态才可信）；
// - 逻辑计数用只读连接读 PRAGMA + 行数；只读打开可能顺手建出空的 -wal/-shm（SQLite 既有行为），
//   所以**先算文件哈希、再读逻辑计数**，返回的 main/wal/shm 反映的是打开之前的样子。
import fs from 'node:fs';
import crypto from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';

const SIDE_FILES = [
  ['main', ''],
  ['wal', '-wal'],
  ['shm', '-shm'],
];

function fileFingerprint(full) {
  try {
    const stat = fs.statSync(full);
    if (!stat.isFile()) return null;
    const bytes = fs.readFileSync(full);
    return {
      exists: true,
      bytes: stat.size,
      sha256: crypto.createHash('sha256').update(bytes).digest('hex'),
      mtime_ms: Math.round(stat.mtimeMs),
    };
  } catch (error) {
    return null;
  }
}

// 逻辑内容：每张业务表的行数 + 迁移版本 + 完整性
function logicalFingerprint(dbPath) {
  let conn = null;
  try {
    conn = new DatabaseSync(dbPath, { readOnly: true });
    const names = conn.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all().map(function (r) { return String(r.name); });
    const tables = {};
    for (const name of names) {
      try { tables[name] = Number(conn.prepare('SELECT COUNT(*) AS c FROM "' + name.replace(/"/g, '""') + '"').get().c) || 0; }
      catch (error) { tables[name] = null; }
    }
    let integrity = null;
    try { integrity = String(conn.prepare('PRAGMA integrity_check').get().integrity_check || ''); } catch (error) { integrity = 'error:' + String((error && error.message) || error); }
    let versions = [];
    if (names.indexOf('schema_migrations') >= 0) {
      try { versions = conn.prepare('SELECT version FROM schema_migrations ORDER BY version').all().map(function (r) { return Number(r.version); }); }
      catch (error) { versions = []; }
    }
    return {
      tables: tables,
      integrity: integrity,
      versions: versions,
      version: versions.length ? versions[versions.length - 1] : null,
    };
  } catch (error) {
    return { tables: null, integrity: 'unreadable:' + String((error && error.message) || error), versions: [], version: null };
  } finally {
    try { if (conn) conn.close(); } catch (error) { /* ignore */ }
  }
}

export function fingerprint(dbPath) {
  const target = String(dbPath);
  const out = { path: target, exists: fs.existsSync(target) };
  // 先文件、后逻辑：文件哈希必须是"打开之前"的状态
  for (const [key, suffix] of SIDE_FILES) out[key] = out.exists ? fileFingerprint(target + suffix) : null;
  const combined = crypto.createHash('sha256')
    .update([out.main, out.wal, out.shm].map(function (f) { return f ? f.sha256 : '-'; }).join('|'))
    .digest('hex');
  out.combined = combined;
  const logical = out.exists ? logicalFingerprint(target) : { tables: null, integrity: null, versions: [], version: null };
  out.tables = logical.tables;
  out.integrity = logical.integrity;
  out.versions = logical.versions;
  out.version = logical.version;
  return out;
}

// 字节级 + 逻辑级完全相同才算"没动过"
export function sameFingerprint(a, b) {
  if (!a || !b) return false;
  if (a.combined !== b.combined) return false;
  return JSON.stringify(a.tables) === JSON.stringify(b.tables) && a.version === b.version;
}

// 只在逻辑层比较（多进程/看板同时在写的时候，字节会动，但内容基线可比）
export function sameContent(a, b) {
  if (!a || !b) return false;
  return JSON.stringify(a.tables) === JSON.stringify(b.tables) && a.version === b.version;
}

// 一句话摘要，塞进断言失败信息里用
export function describe(f) {
  if (!f) return 'null';
  const file = function (x) { return x ? x.bytes + 'B/' + String(x.sha256).slice(0, 8) : 'none'; };
  return 'main=' + file(f.main) + ' wal=' + file(f.wal) + ' shm=' + file(f.shm) + ' version=' + String(f.version);
}
