#!/usr/bin/env node
// 第 3 项：unmanaged 历史日志的可审计盘点与导入。
// 铁律：能唯一确认的补引用；无法确认的保留（unmanaged_unknown，不进 retention，没有批量删除入口）。
// 本套件全程临时 logs 目录 + 临时库，并在结尾用指纹证明真实 bus/logs 与 bus.db 未变。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as S from './store.mjs';
import * as Logs from './log-inventory.mjs';
import { fingerprint, sameContent, describe } from './smoke-support/db-fingerprint.mjs';

const REAL_DB = path.join(S.BUS_DIR, 'bus.db');
const REAL_LOGS = path.join(S.BUS_DIR, 'logs');
const dbBefore = fingerprint(REAL_DB);
const logsBefore = (function () {
  try { return fs.readdirSync(REAL_LOGS).sort().join('|'); } catch (e) { return null; }
})();

let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  PASS  ' + name); }
  else { fail++; console.log('  FAIL  ' + name + (extra === undefined ? '' : '  -> ' + JSON.stringify(extra).slice(0, 300))); }
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'agentbus-logs-'));
const logsDir = path.join(tmp, 'logs');
fs.mkdirSync(logsDir, { recursive: true });
const db = S.openDb(path.join(tmp, 'bus.db'));
S.setRuntimeState(db, 'human', true);
const t1 = S.createTask(db, { title: '日志任务一', status: 'open', project: 'default' });
const t2 = S.createTask(db, { title: '日志任务二', status: 'open', project: 'default' });

// 造一批文件（路径/内容两个来源都要能构造出来）
fs.writeFileSync(path.join(logsDir, t1.id + '-run.log'), 'hello ' + t1.id);
fs.writeFileSync(path.join(logsDir, 'copy-of-' + t2.id + '.log'), 'body without id');
fs.writeFileSync(path.join(logsDir, 'report.log'), 'analysis mentions ' + t2.id + ' once');
fs.writeFileSync(path.join(logsDir, 'mixed.log'), t1.id + ' and ' + t2.id);
fs.writeFileSync(path.join(logsDir, 'notask.log'), 'nothing here');
fs.writeFileSync(path.join(logsDir, t1.id + '-conflict.log'), 'belongs to ' + t2.id);
fs.writeFileSync(path.join(logsDir, 'blob.bin'), Buffer.from([0, 1, 2, 3]));
fs.writeFileSync(path.join(logsDir, 'ghost-' + 't-zzzz9' + '.log'), 'x');

console.log('[1] 每个文件都给 inferred_task_id / basis / confidence（可审计）');
const inv = Logs.buildInventory(db, { logsDir: logsDir });
const byName = {};
for (const e of inv.entries) byName[e.relative_path] = e;
ok('每个条目都有 path/size/mtime/sha256', inv.entries.every(function (e) { return e.path && typeof e.size === 'number' && e.mtime && /^[0-9a-f]{64}$/.test(String(e.sha256)); }));
ok('每个条目都有 inferred_task_id/basis/confidence 三个字段',
  inv.entries.every(function (e) { return ('inferred_task_id' in e) && e.basis && typeof e.basis.detail === 'string' && typeof e.confidence === 'string'; }),
  inv.entries.filter(function (e) { return !e.basis; }).map(function (e) { return e.relative_path; }));
ok('basis 写明来源与证据（signals 里能查到路径/内容两侧的 id）',
  inv.entries.every(function (e) { return e.basis.source && e.basis.signals && (('path' in e.basis.signals) || ('content' in e.basis.signals)); }));

console.log('');
console.log('[2] 分类：路径+内容一致才 high；单一来源 medium；冲突/多个/不存在一律 unknown');
const named = byName[t1.id + '-run.log'];
ok('路径与内容一致的 → high 且可导入', named && named.confidence === 'high' && named.importable === true && named.inferred_task_id === t1.id, named && named.confidence);
const copyOf = byName['copy-of-' + t2.id + '.log'];
// 目录结构里唯一命中 task id 且内容无冲突 —— 这是 lead 认可的"唯一确认"来源之一，允许导入（high）
ok('只有路径证据但唯一且内容无冲突 → high 且可导入', copyOf && copyOf.confidence === 'high' && copyOf.importable === true && copyOf.inferred_task_id === t2.id, copyOf && copyOf.confidence);
ok('basis 里写明是"路径+内容"两个来源、内容侧为空', copyOf && copyOf.basis.source === 'path+content' && copyOf.basis.signals.content.ids.length === 0);
const report = byName['report.log'];
ok('只有内容提到某个 task → medium（"提到"≠"属于"），不导入', report && report.confidence === 'medium' && report.importable === false && report.reason === 'content_only', report && report.reason);
const mixed = byName['mixed.log'];
ok('出现多个 task id → none，绝不猜', mixed && mixed.confidence === 'none' && mixed.reason === 'ambiguous_task_ids' && mixed.inferred_task_id === null, mixed && mixed.reason);
const notask = byName['notask.log'];
ok('没有任何 id → none', notask && notask.confidence === 'none' && notask.reason === 'no_reliable_link');
const conflict = byName[t1.id + '-conflict.log'];
ok('路径指向 A、内容指向 B → 冲突，不归户', conflict && conflict.reason === 'conflicting_signals' && conflict.inferred_task_id === null && conflict.confidence === 'medium', conflict && conflict.reason);
const blob = byName['blob.bin'];
ok('二进制不猜归属', blob && blob.confidence === 'none' && blob.reason === 'binary_no_link', blob && blob.reason);
const ghost = inv.entries.filter(function (e) { return e.relative_path.indexOf('t-zzzz9') >= 0; })[0];
ok('认出的 task 不存在 → task_missing，不归户', ghost && ghost.reason === 'task_missing' && ghost.confidence === 'none', ghost && ghost.reason);

console.log('');
console.log('[3] unmanaged_unknown：保留原文件、不进 retention、无批量删除入口');
const unknownNames = inv.unmanaged_unknown.map(function (e) { return e.relative_path; });
ok('混合/无 id/冲突/二进制/不存在 全部进 unmanaged_unknown',
  ['mixed.log', 'notask.log', 'blob.bin'].every(function (n) { return unknownNames.indexOf(n) >= 0; }), unknownNames);
ok('unmanaged_unknown 一律 retention_eligible=false', inv.unmanaged_unknown.every(function (e) { return e.retention_eligible === false; }));
ok('unmanaged_unknown 一律 importable=false', inv.unmanaged_unknown.every(function (e) { return e.importable === false; }));
ok('模块里没有删除能力（无 unlink/rm/rmSync，也没有 prune-unmanaged 导出）',
  !/unlinkSync|fs\.unlink|fs\.rmSync|\brm\(/.test(fs.readFileSync(new URL('./log-inventory.mjs', import.meta.url), 'utf8')) &&
  typeof Logs.pruneUnmanaged === 'undefined' && typeof Logs.deleteFile === 'undefined');
ok('文件都还在（一个都没删）', unknownNames.every(function (n) { return fs.existsSync(path.join(logsDir, n)); }));

console.log('');
console.log('[4] import：只写引用表，且写之前重新校验大小与哈希');
const imported = Logs.importInventory(db, { logsDir: logsDir });
ok('只导入 high 的那两份（路径+内容一致 / 路径唯一且内容无冲突）', imported.totals.imported === 2 && imported.imported.every(function (x) { return ['t-0001', 't-0002'].indexOf(x.task_id) >= 0; }), imported.imported);
ok('导入记录里带 basis（可审计）', imported.imported[0] && imported.imported[0].basis && imported.imported[0].basis.detail);
const ref = db.prepare('SELECT task_id, sha256, size FROM artifact_refs WHERE relative_path=?').get(t1.id + '-run.log');
ok('artifact_refs 写入了 task_id/sha256/size', !!ref && ref.task_id === t1.id && String(ref.sha256).length === 64 && Number(ref.size) > 0, ref);
ok('medium/none 的文件一条引用都没写（只有 2 条 high 的引用）',
  Number(db.prepare('SELECT COUNT(*) AS c FROM artifact_refs').get().c) === 2, db.prepare('SELECT COUNT(*) AS c FROM artifact_refs').get());
ok('unmanaged_unknown 数量不受 import 影响', imported.totals.unmanaged === inv.unmanaged_unknown.length, imported.totals.unmanaged);

console.log('');
console.log('[5] 重复 import 与"盘点后文件被改动"');
const again = Logs.importInventory(db, { logsDir: logsDir });
ok('重复 import 幂等：第二次没有新增引用', again.totals.imported === 0, again.totals);
ok('重复 import 不会写出重复引用（总数仍是 2）', Number(db.prepare('SELECT COUNT(*) AS c FROM artifact_refs').get().c) === 2);
ok('已导入的文件第二次变成 managed/verified（不再算"可导入"）', (function () {
  const inv2 = Logs.buildInventory(db, { logsDir: logsDir });
  const e = inv2.entries.filter(function (x) { return x.relative_path === t1.id + '-run.log'; })[0];
  return e && e.status === 'managed' && e.verified === true && e.importable === false;
})());

// 盘点之后改文件：先把 inv 拿到，再改内容，再 import → 必须拒绝并说明 changed_since_scan
const target = path.join(logsDir, t2.id + '-run.log');
fs.writeFileSync(target, 'first version ' + t2.id);
// 先盘点（此时文件是 high、可导入），再改磁盘内容 —— 这正是"盘点后文件变了"的场景
const staleInv = Logs.buildInventory(db, { logsDir: logsDir });
const staleEntry = staleInv.entries.filter(function (e) { return e.relative_path === t2.id + '-run.log'; })[0];
fs.writeFileSync(target, 'second version ' + t2.id + ' (changed after scan)');
// 用**过期盘点结果**去 import：写入前重新校验哈希，必须拒绝
const changed = Logs.importInventory(db, { logsDir: logsDir, inventory: staleInv });
ok('盘点后文件变化 → 拒绝写入（changed_since_scan）',
  changed.failed.some(function (f) { return f.reason === 'changed_since_scan'; }), { imported: changed.totals.imported, failed: changed.failed });
ok('拒绝信息里同时给出盘点值与当前值',
  changed.failed.filter(function (f) { return f.reason === 'changed_since_scan'; })[0].scanned.sha256 !==
  changed.failed.filter(function (f) { return f.reason === 'changed_since_scan'; })[0].current.sha256);
ok('变动的那份没有被写进引用表', !db.prepare('SELECT 1 AS ok FROM artifact_refs WHERE relative_path=?').get(t2.id + '-run.log'));

const fakeOld = { relative_path: t2.id + '-run.log', path: target, size: staleEntry.size, sha256: staleEntry.sha256, inferred_task_id: t2.id, importable: true };
ok('旧条目里的 sha256 与当前文件不同（这就是 changed_since_scan 的由来）',
  fakeOld.sha256 !== Logs.buildInventory(db, { logsDir: logsDir }).entries.filter(function (e) { return e.relative_path === t2.id + '-run.log'; })[0].sha256);

console.log('');
console.log('[6] 已登记但哈希不符：不当作可信，也不进 retention');
const tracked = path.join(logsDir, t1.id + '-run.log');
db.prepare('INSERT OR REPLACE INTO artifact_refs(task_id,kind,relative_path,sha256,size) VALUES(?,?,?,?,?)').run(t1.id, 'log', t1.id + '-run.log', 'deadbeef'.repeat(8), 12);
fs.writeFileSync(tracked, 'content changed after ref');
const afterTamper = Logs.buildInventory(db, { logsDir: logsDir });
const tampered = afterTamper.entries.filter(function (e) { return e.relative_path === t1.id + '-run.log'; })[0];
ok('引用哈希与文件不符 → reason=hash_mismatch', tampered && tampered.reason === 'hash_mismatch', tampered && tampered.reason);
ok('哈希不符时 confidence 降为 low（不是 verified）', tampered && tampered.confidence === 'low', tampered && tampered.confidence);
ok('哈希不符的文件 retention_eligible=false（避免按过期引用被清）', tampered && tampered.retention_eligible === false, tampered && tampered.retention_eligible);
ok('哈希不符会写进 basis 信号里（两侧 sha256 都能看到）',
  tampered && tampered.basis.signals.artifact_refs.sha256 && tampered.basis.signals.current.sha256 && tampered.basis.signals.artifact_refs.sha256 !== tampered.basis.signals.current.sha256);

console.log('');
console.log('[7] 路径逃逸与符号链接一律跳过');
const outside = path.join(tmp, 'outside.log');
fs.writeFileSync(outside, 'outside ' + t1.id);
const linkPath = path.join(logsDir, 'link-to-outside.log');
let linkMade = false;
try { fs.symlinkSync(outside, linkPath); linkMade = true; } catch (e) { linkMade = false; }
const escInv = Logs.buildInventory(db, { logsDir: logsDir });
const skipped = escInv.skipped.map(function (s) { return s.reason; });
ok('符号链接被记 skipped（不移除、不跟随）', !linkMade || skipped.indexOf('symlink') >= 0, skipped);
ok('被跳过的文件没有出现在 entries 里', !escInv.entries.some(function (e) { return e.relative_path === 'link-to-outside.log'; }));
ok('skipped 带明确 reason', escInv.skipped.every(function (s) { return typeof s.reason === 'string' && s.reason.length > 0; }), escInv.skipped);

console.log('');
console.log('[8] 真实目录与真实库未被改动');
ok('真实 bus/logs 目录条目未变', (function () {
  try { return fs.readdirSync(REAL_LOGS).sort().join('|') === logsBefore; } catch (e) { return logsBefore === null; }
})());
ok('真实 bus.db 逻辑内容未变', sameContent(dbBefore, fingerprint(REAL_DB)), describe(dbBefore));

try { db.close(); } catch (e) {}
try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (e) {}
console.log('');
console.log('==================================');
console.log('PASS ' + pass + '   FAIL ' + fail);
process.exitCode = fail ? 1 : 0;
