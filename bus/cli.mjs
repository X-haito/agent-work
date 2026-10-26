#!/usr/bin/env node
// 人用的 CLI:
//   node bus/cli.mjs status | board | agents | cost | projects
//   node bus/cli.mjs add-project <id> <绝对路径>
//   node bus/cli.mjs init-project <id>
import crypto from 'node:crypto';
import * as ProjectRegistry from './project-registry.mjs';
import fs from 'node:fs';
import path from 'node:path';
import * as S from './store.mjs';
import * as Creds from './auth.mjs';
import * as AdminConfig from './admin-config.mjs';
import * as Archive from './archive.mjs';
import * as EngineReport from './isolation/engine-report.mjs';
import * as FilePerm from './platform/file-permissions.mjs';
import * as Retention from './archive-retention.mjs';
import * as LogInventory from './log-inventory.mjs';
import { runMergeRequest } from './merge-worker.mjs';
import { repoState } from './merge-runner.mjs';

const cmd = process.argv[2] || 'status';

// 懒加载：以前 db/policy 在模块顶层就打开真实库，导致本文件不可被 import 测试。
// 用 Proxy 保持所有既有调用点（db.prepare(...) / policy.permissions...）不变。
let openedDb = null;
function getDb() {
  if (!openedDb) openedDb = S.openDb(process.env.BUS_DB || undefined);
  return openedDb;
}
const db = new Proxy({}, {
  get: function (target, prop) {
    const value = getDb()[prop];
    return typeof value === 'function' ? value.bind(getDb()) : value;
  },
});
let loadedPolicy = null;
function getPolicy() {
  if (!loadedPolicy) loadedPolicy = S.loadPolicy();
  return loadedPolicy;
}
const policy = new Proxy({}, { get: function (target, prop) { return getPolicy()[prop]; } });

// 只有被 node 直接执行时才跑命令；被 import 时（测试）不执行任何东西。
function invokedDirectly() {
  try {
    const entry = process.argv[1];
    if (!entry) return false;
    return path.resolve(entry) === path.resolve(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
  } catch (error) { return false; }
}

function pad(s, n) {
  s = String(s == null ? '' : s);
  let w = 0;
  for (const ch of s) w += ch.charCodeAt(0) > 127 ? 2 : 1;
  while (w < n) { s += ' '; w += 1; }
  return s;
}

function readRegistry() {
  try { return JSON.parse(fs.readFileSync(path.join(S.BUS_DIR, 'projects.json'), 'utf8')); }
  catch (e) { return { projects: {} }; }
}

function status() {
  const args = process.argv.slice(3);
  if (args.indexOf('--lifecycle') >= 0 || args.indexOf('--component') >= 0 || args.indexOf('--json') >= 0) return lifecycleStatus();
  console.log('Lead: ' + (policy.lead || '(未设置)'));
  console.log('权限: ' + Object.keys(policy.permissions).map(function (k) {
    const list = policy.permissions[k] || [];
    return k + '=' + (list.length ? list.join('/') : '(未设置)');
  }).join('  '));
  console.log('');
  console.log(pad('Agent', 18) + pad('档位', 8) + pad('并发', 6) + pad('可被派活来自', 24) + '能力');
  console.log('-'.repeat(90));
  for (const id of Object.keys(policy.agents)) {
    const a = policy.agents[id];
    console.log(pad(id, 18) + pad(a.autonomy, 8) + pad(a.max_concurrent, 6) +
      pad((a.may_dispatch_to || []).join(',') || '(无)', 24) + (a.capabilities || []).join(','));
  }
  const g = policy.global || {};
  console.log('');
  console.log('总闸: dispatch_enabled=' + g.dispatch_enabled + '  递归上限=' + g.max_dispatch_depth + '  限速=' + g.rate_per_agent_per_hour + '/h');
  const e = policy.economics || {};
  console.log('省钱: Lead可读文件=' + e.lead_may_read_files + '  Lead可写代码=' + e.lead_may_write_code +
    '  回报上限=' + e.report_max_lines + '行  免验收=' + (e.auto_accept || []).join('/'));
}

function board() {
  S.reapLeases(db);
  const tasks = S.listTasks(db, {});
  if (!tasks.length) { console.log('（没有未结束的任务）'); return; }
  console.log(pad('ID', 8) + pad('状态', 13) + pad('owner', 14) + pad('档', 13) + pad('标题', 34) + '来源');
  console.log('-'.repeat(108));
  for (const t of tasks) {
    console.log(pad(t.id, 8) + pad(t.status, 13) + pad(t.owner || '-', 14) +
      pad(t.cost_class, 13) + pad(t.title, 34) + (t.origin || ''));
  }
  const c = S.costSummary(db, policy.lead);
  console.log('');
  console.log('累计 token: ' + c.total + '  Lead占比: ' + (c.lead_ratio * 100).toFixed(1) + '%');
}

function agents() {
  const a = S.listAgents(db);
  if (!a.length) { console.log('（没有 agent 上报过心跳 —— 说明还没有 MCP 进程连上来）'); return; }
  console.log(pad('Agent', 18) + pad('状态', 10) + pad('活跃任务', 10) + '最后心跳');
  for (const x of a) console.log(pad(x.agent_id, 18) + pad(x.status, 10) + pad(x.active_tasks, 10) + x.last_seen);
}

function cost() {
  const c = S.costSummary(db, policy.lead);
  console.log('总 token: ' + c.total);
  console.log('Lead token: ' + c.lead + ' (' + (c.lead_ratio * 100).toFixed(1) + '%)');
  console.log(c.lead_ratio > 0.5 ? '> 50%: 失控，等于用最贵的模型做最便宜的事'
    : c.lead_ratio > 0.2 ? '20-50%: 偏高，Lead 在干不该干的活'
    : '< 20%: 健康');
  console.log('');
  for (const r of c.by_agent) console.log('  ' + pad(r.agent, 18) + r.in + ' in / ' + r.out + ' out');
}

// 第 7 项第 2 条：projects adopt —— 只调 store.adoptProject，拒绝原因原样透出（含 next_step）。
function projectsAdopt() {
  const args = process.argv.slice(3);
  const value = function (name) {
    const i = args.indexOf('--' + name);
    if (i >= 0 && args[i + 1] && String(args[i + 1]).slice(0, 2) !== '--') return args[i + 1];
    const eq = args.filter(function (a) { return a.indexOf('--' + name + '=') === 0; })[0];
    return eq ? eq.slice(name.length + 3) : null;
  };
  const jsonOut = args.indexOf('--json') >= 0;
  const legacy = value('legacy');
  const nextId = value('id');
  const targetPath = value('path');
  if (!legacy || !nextId || !targetPath) {
    const usage = { ok: false, reason: 'adopt_args_missing', message: '用法: node bus/cli.mjs projects adopt --legacy <旧项目> --id <新项目> --path <绝对路径>' };
    if (jsonOut) console.log(JSON.stringify(usage, null, 2)); else console.log(usage.message);
    process.exitCode = 2;
    return;
  }
  let result;
  try {
    result = S.adoptProject(db, policy, { legacy: legacy, id: nextId, path: targetPath, actor: 'human', registry: process.env.BUS_PROJECTS || undefined });
  } catch (error) {
    // registry 写失败等异常在 store 里会抛（事务已回滚）：原样报出来，不假装成功。
    result = { ok: false, reason: 'adopt_failed', message: String((error && error.message) || error) };
  }
  if (jsonOut) {
    console.log(JSON.stringify(result, null, 2));
    if (result.ok !== true) process.exitCode = 1;
    return;
  }
  if (result.ok !== true) {
    console.log('迁移被拒: ' + result.reason);
    console.log('  ' + (result.message || ''));
    if (result.active_tasks != null) console.log('  active 任务: ' + result.active_tasks);
    if (result.next_step) console.log('  下一步: ' + result.next_step);
    process.exitCode = 1;
    return;
  }
  console.log('迁移完成');
  console.log('  旧项目: ' + result.migration.legacy + (result.migration.tasks ? '' : ''));
  console.log('  新项目: ' + result.migration.next + '  →  ' + result.migration.path);
  console.log('  任务迁移: ' + result.tasks_migrated + ' 个');
  console.log('  台账: project_migrations ' + result.migration.id + '（actor ' + result.migration.actor + '）');
  console.log('  registry: ' + result.registry_file);
  if (result.next_step) console.log('  下一步: ' + result.next_step);
}

// 第 7 项第 3 条：项目维度归档入口。**复用** archive 的 buildPlan/applyArchive，
// 不自己实现删除逻辑——那是唯一有「先聚合核对总和再删」保证的路径。
async function projectsArchiveOrphan() {
  const args = process.argv.slice(3);
  const value = function (name) {
    const i = args.indexOf('--' + name);
    if (i >= 0 && args[i + 1] && String(args[i + 1]).slice(0, 2) !== '--') return args[i + 1];
    return null;
  };
  const jsonOut = args.indexOf('--json') >= 0;
  const project = value('project');
  const confirm = value('confirm');
  if (!project) {
    const usage = { ok: false, reason: 'usage', message: '用法: node bus/cli.mjs projects archive-orphan --project <id> [--dry-run] [--confirm <plan_hash>] [--json]' };
    if (jsonOut) console.log(JSON.stringify(usage, null, 2)); else console.log(usage.message);
    process.exitCode = 2; return;
  }
  const rows = (function () {
    try {
      return db.prepare('SELECT id, status, project FROM tasks WHERE project = ?').all(String(project));
    } catch (error) { return []; }
  })();
  const activeRows = rows.filter(function (r) { return ACTIVE_STATUSES.indexOf(r.status) >= 0; });
  if (activeRows.length) {
    const refused = { ok: false, reason: 'active_tasks_present', project: project, active: activeRows.length,
      active_task_ids: activeRows.map(function (r) { return r.id; }).slice(0, 50),
      message: '项目还有 ' + activeRows.length + ' 个 active 任务：先改派/完成/取消，再归档' };
    if (jsonOut) console.log(JSON.stringify(refused, null, 2));
    else { console.log('拒绝: ' + refused.message); for (const id of refused.active_task_ids) console.log('  - ' + id); }
    process.exitCode = 1; return;
  }
  const plan = Archive.buildPlan(db, policy, { project: project });
  const projectTaskIds = new Set(rows.map(function (r) { return r.id; }));
  const inPlan = (plan.tables.tasks.ids || []).filter(function (id) { return projectTaskIds.has(id); });
  const outside = (plan.tables.tasks.ids || []).filter(function (id) { return !projectTaskIds.has(id); });
  const summary = {
    ok: true, project: project, dry_run: confirm == null,
    project_tasks: rows.length, project_tasks_in_plan: inPlan.length, project_task_ids: inPlan.slice(0, 50),
    plan_hash: plan.plan_hash,
    scope: plan.scope,
    plan_counts: { tasks: (plan.tables.tasks.ids || []).length, outside_project: outside.length,
      messages: plan.tables.messages.candidates, guard_events: plan.tables.guard_events.candidates,
      token_usage: plan.tables.token_usage.candidates },
  };
  if (confirm == null) {
    if (jsonOut) { console.log(JSON.stringify(summary, null, 2)); return; }
    console.log('项目归档 dry-run（只含本项目 ' + project + ' 的计划，不自己删）');
    console.log('  项目: ' + project + ' · 任务 ' + rows.length + '（本项目进入计划 ' + inPlan.length + '）');
    console.log('  计划 hash: ' + plan.plan_hash);
    console.log('  计划范围: 项目 ' + project + '（scope 参与 plan_hash）· 任务 ' + summary.plan_counts.tasks +
      ' · 消息 ' + summary.plan_counts.messages + ' · 守卫事件 ' + summary.plan_counts.guard_events +
      ' · 用量 ' + summary.plan_counts.token_usage + '；不属于本项目的候选 ' + outside.length + '（应为 0）');
    if (inPlan.length) for (const id of inPlan.slice(0, 20)) console.log('    - ' + id);
    console.log('');
    console.log('确认执行（只归档本项目）: node bus/cli.mjs projects archive-orphan --project ' + project + ' --confirm ' + plan.plan_hash);
    return;
  }
  const applied = Archive.applyArchive(db, policy, plan, { confirm: confirm, project: project });
  const result = Object.assign({}, summary, { dry_run: false, applied: applied });
  if (jsonOut) { console.log(JSON.stringify(result, null, 2)); if (!applied.ok) process.exitCode = 1; return; }
  if (!applied.ok) { console.log('归档被拒: ' + applied.reason); console.log('  ' + JSON.stringify(applied).slice(0, 300)); process.exitCode = 1; return; }
  console.log('归档完成（archive.applyArchive）: 任务 ' + (applied.deleted && applied.deleted.tasks != null ? applied.deleted.tasks : '?') + ' · 计划 ' + plan.plan_hash);
  if (outside.length) console.log('提醒: 本次全局计划同时覆盖了不属于 ' + project + ' 的 ' + outside.length + ' 个任务（保留策略是全局的）。');
}

function projects() {
  if (process.argv[3] === 'adopt') { projectsAdopt(); return; }
  if (process.argv[3] === 'archive-orphan') { return projectsArchiveOrphan(); }
  const reg = readRegistry();
  const ids = Object.keys(reg.projects || {});
  if (!ids.length) { console.log('（还没有登记任何项目）'); return; }
  for (const id of ids) {
    const p = reg.projects[id].path;
    const hasCfg = fs.existsSync(path.join(p, 'project.json'));
    console.log(pad(id, 20) + pad(p, 46) + (hasCfg ? '✓' : '✗ 缺 project.json'));
  }
}

function addProject() {
  const id = process.argv[3];
  const p = process.argv[4];
  if (!id || !p) { console.log('用法: node bus/cli.mjs add-project <项目id> <项目绝对路径>'); return; }
  const abs = path.resolve(p);
  if (!fs.existsSync(abs)) { console.log('路径不存在: ' + abs); return; }
  const reg = readRegistry();
  reg.projects = reg.projects || {};
  reg.projects[id] = { path: abs.split('\\').join('/') };
  fs.writeFileSync(path.join(S.BUS_DIR, 'projects.json'), JSON.stringify(reg, null, 2) + '\n');
  console.log('已登记 ' + id + ' -> ' + reg.projects[id].path);
  if (!fs.existsSync(path.join(abs, 'project.json'))) {
    console.log('提醒: 该目录没有 project.json，将用默认拓扑 clone-per-agent。');
    console.log('      可执行: node bus/cli.mjs init-project ' + id);
  }
}

function initProject() {
  const id = process.argv[3];
  if (!id) { console.log('用法: node bus/cli.mjs init-project <项目id>'); return; }
  const reg = readRegistry();
  const hit = reg.projects && reg.projects[id];
  if (!hit) { console.log('请先执行 add-project ' + id + ' <路径>'); return; }
  const cfgPath = path.join(hit.path, 'project.json');
  if (fs.existsSync(cfgPath)) { console.log('已存在: ' + cfgPath); return; }
  const cfg = {
    id: id,
    topology: 'clone-per-agent',
    root: hit.path,
    agents: ['dsh/main', 'codex/main', 'claude/main'],
    branch_policy: 'agent/{agent}/{task}',
  };
  fs.mkdirSync(hit.path, { recursive: true });
  fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2) + '\n');
  console.log('已生成 ' + cfgPath);
}

function credentials() {
  const action = process.argv[3] || 'list';
  const target = process.argv[4];
  if (action === 'list') {
    const rows = db.prepare('SELECT agent_id,token_hash,created_at,expires_at,revoked_at,last_used_at FROM agent_credentials ORDER BY agent_id, rowid DESC').all();
    if (!rows.length) { console.log('还没有任何 AgentBus 凭据。用: node bus/cli.mjs credentials rotate <codex|claude|dsh>'); return; }
    for (const r of rows) {
      const state = r.revoked_at ? 'revoked' : (r.expires_at && Date.parse(r.expires_at) <= Date.now() ? 'expired' : 'active');
      console.log(pad(r.agent_id, 18) + pad(state, 9) + r.created_at + '  used=' + (r.last_used_at || '-') + '  ' + String(r.token_hash).slice(0, 8) + '…');
    }
    return;
  }
  if (action === 'revoke') {
    if (!target) { console.log('用法: node bus/cli.mjs credentials revoke <agent或客户端>'); return; }
    const agent = ['codex', 'claude', 'dsh'].indexOf(target) >= 0 ? target + '/main' : target;
    const r = Creds.revokeCredential(db, agent);
    Creds.logAudit(db, { actor: 'human', auth_method: 'local-cli', action: 'credentials.revoke', resource: { agent: agent }, result: String(r.revoked) });
    console.log('已撤销 ' + r.revoked + ' 条有效凭据: ' + agent);
    return;
  }
  if (action === 'rotate') {
    const client = target || 'codex';
    const isClient = ['codex', 'claude', 'dsh'].indexOf(client) >= 0;
    const agent = isClient ? client + '/main' : client;
    if (!isClient) {
      // 非客户端身份没有配置文件可写：直接轮换并打印一次
      const rotated = Creds.rotateCredential(db, agent);
      if (!rotated.ok) { console.log('轮换失败: ' + rotated.reason + ' ' + (rotated.message || '')); return; }
      console.log('新凭据（只显示这一次）: ' + rotated.token);
      console.log('把它写入该 Agent 的 AGENT_BUS_TOKEN 环境变量；旧凭据宽限到 ' + rotated.grace_until);
    } else {
      // 分阶段轮换：pending → 写临时文件 → 重新解析核对 → rename → 激活；任一步失败恢复原文件字节
      const profiles = AdminConfig.readMcpProfiles();
      const current = profiles.find(function (x) { return x.id === client; });
      const realPath = current && current.path;
      if (!realPath) { console.log('找不到 ' + client + ' 的配置文件路径，已中止（未改动任何凭据）'); return; }
      const rotated = Creds.rotateStagedCredential(db, {
        agentId: agent,
        realPath: realPath,
        serialize: function (target, token) {
          return AdminConfig.writeMcpProfileTo(client, { enabled: true, agent: agent, token: token }, target, { sourcePath: realPath });
        },
        verify: function (target, token) {
          let text = '';
          try { text = fs.readFileSync(target, 'utf8'); } catch (error) { return { ok: false, detail: 'unreadable' }; }
          if (text.indexOf(token) < 0) return { ok: false, detail: 'token_missing' };
          if (text.indexOf(agent) < 0) return { ok: false, detail: 'agent_missing' };
          if (text.indexOf('bus-mcp.mjs') < 0) return { ok: false, detail: 'server_path_missing' };
          if (client === 'claude') { try { const json = JSON.parse(text); if (!json.mcpServers || !json.mcpServers.agentbus) return { ok: false, detail: 'entry_missing' }; } catch (error) { return { ok: false, detail: 'json_broken' }; } }
          return { ok: true };
        },
      });
      if (!rotated.ok) {
        console.log('轮换失败，已回滚：' + rotated.reason + ' — ' + (rotated.message || ''));
        console.log('旧 token 仍然可用，新 token 未激活，配置文件字节未变。');
        Creds.logAudit(db, { actor: 'human', auth_method: 'local-cli', action: 'credentials.rotate_failed', resource: { agent: agent, reason: rotated.reason }, result: 'failed' });
        return;
      }
      console.log('已写入 ' + client + ' 配置: ' + realPath);
      console.log('新 token 已激活；旧 token 宽限至 ' + rotated.grace_until);
      const cleaned = Creds.revokeSuperseded(db, agent);
      if (cleaned.revoked) console.log('已撤销被取代的旧凭据 ' + cleaned.revoked + ' 条');
      console.log('需要重启对应客户端才会加载新凭据。');
    }
    Creds.logAudit(db, { actor: 'human', auth_method: 'local-cli', action: 'credentials.rotate', resource: { agent: agent }, result: 'ok' });
    return;
  }
  console.log('用法: node bus/cli.mjs credentials [list | rotate <codex|claude|dsh|agent> | revoke <agent>]');
}

// 二级保留（快照 + 任务归档包）：dry-run 出计划与 hash，--confirm <hash> 才真删。
//   node bus/cli.mjs archive-retention [--json]
//   node bus/cli.mjs archive-retention --confirm <plan_hash>
function archiveRetention() {
  const args = process.argv.slice(3);
  const jsonOut = args.indexOf('--json') >= 0;
  const confirmAt = args.indexOf('--confirm');
  const confirm = confirmAt >= 0 ? args[confirmAt + 1] : null;
  const targetDb = process.env.BUS_DB ? S.openDb(process.env.BUS_DB) : db;
  const built = Retention.buildPlan(targetDb, policy, {});
  if (!confirm) {
    if (jsonOut) { console.log(JSON.stringify({ dry_run: true, plan: built.plan }, null, 2)); return; }
    const p = built.plan;
    console.log('二级保留 dry-run（不删任何东西）');
    console.log('  策略: 快照 ' + p.policy.snapshot_days + ' 天 / 最少留 ' + p.policy.min_snapshots +
      ' 个 · 归档包 ' + p.policy.archive_bundle_days + ' 天 / 最少留 ' + p.policy.min_archive_bundles + ' 个');
    console.log('  快照目录: ' + p.dirs.snapshot_dir);
    console.log('  归档包目录: ' + p.dirs.bundle_dir);
    console.log('  候选: 快照 ' + p.snapshots.candidates.length + ' 个 · 归档包 ' + p.archive_bundles.candidates.length +
      ' 个 · 合计 ' + p.totals.candidates + ' 个 / ' + p.totals.bytes + ' 字节');
    for (const item of p.snapshots.candidates.concat(p.archive_bundles.candidates)) {
      console.log('    - [' + item.kind + '] ' + item.relative_path + '  ' + item.bytes + 'B  ' + item.mtime);
    }
    const keptRef = p.snapshots.kept.concat(p.archive_bundles.kept).filter(function (x) { return x.reason === 'referenced_by_task_archive'; });
    if (keptRef.length) console.log('  受引用保护（不删）: ' + keptRef.map(function (x) { return x.relative_path; }).join(', '));
    console.log('');
    console.log('确认执行: node bus/cli.mjs archive-retention --confirm ' + built.plan_hash);
    return;
  }
  const result = Retention.applyPlan(targetDb, policy, built.plan, { confirm: confirm, actor: 'human', auth_method: 'local-cli' });
  console.log(JSON.stringify(result, null, 2));
  if (!result.ok) process.exitCode = 1;
}

// 旧日志 inventory：只读扫描 + 可选 import（写 artifact_refs）。**永不删除文件**。
function logs() {
  const sub = process.argv[3] || 'inventory';
  if (sub !== 'inventory') {
    console.log('用法: node bus/cli.mjs logs inventory [--json] [--import]');
    process.exitCode = 1;
    return;
  }
  const jsonOut = process.argv.indexOf('--json') >= 0;
  const doImport = process.argv.indexOf('--import') >= 0;
  const targetDb = process.env.BUS_DB ? S.openDb(process.env.BUS_DB) : db;
  const inventory = LogInventory.buildInventory(targetDb, {});
  const importResult = doImport ? LogInventory.importInventory(targetDb, {}) : null;
  if (jsonOut) { console.log(JSON.stringify({ inventory: inventory, import: importResult }, null, 2)); return; }
  console.log('日志 inventory（只读，不删除任何文件）');
  console.log('  目录: ' + inventory.root);
  console.log('  扫描: ' + inventory.totals.files + ' 个文件 / ' + inventory.totals.bytes + ' 字节');
  console.log('  已登记(managed): ' + inventory.totals.managed + ' 个，其中哈希一致(verified) ' + inventory.totals.verified + ' 个');
  console.log('  可导入(high): ' + inventory.totals.importable + ' 个 · 待人工复核(medium): ' + inventory.totals.needs_review + ' 个');
  console.log('  无法归属(unmanaged_unknown): ' + inventory.totals.unmanaged + ' 个 / ' + inventory.totals.unmanaged_bytes + ' 字节 —— 保留原文件、不进 retention、无批量删除入口');
  if (inventory.import_suggestions.length) {
    console.log('');
    console.log('  导入建议（依据可审计）:');
    for (const row of inventory.import_suggestions.slice(0, 20)) {
      console.log('    + ' + row.relative_path + ' → ' + row.task_id + '  [' + row.confidence + '] ' + row.basis.detail);
    }
  }
  if (inventory.review_suggestions.length) {
    console.log('');
    console.log('  需要人工复核（单一来源，不自动归户）:');
    for (const row of inventory.review_suggestions.slice(0, 20)) {
      console.log('    ? ' + row.relative_path + (row.inferred_task_id ? ' → 疑似 ' + row.inferred_task_id : '') + '  [' + row.reason + '] ' + row.basis.detail);
    }
    if (inventory.review_suggestions.length > 20) console.log('    …还有 ' + (inventory.review_suggestions.length - 20) + ' 个（--json 看全部）');
  }
  if (inventory.unmanaged.length) {
    console.log('');
    console.log('  无法归属明细（保留原文件）:');
    for (const row of inventory.unmanaged.slice(0, 20)) {
      console.log('    ! ' + row.relative_path + '  ' + row.size + 'B  [' + row.confidence + '/' + row.reason + '] ' + row.basis.detail);
    }
    if (inventory.unmanaged.length > 20) console.log('    …还有 ' + (inventory.unmanaged.length - 20) + ' 个（--json 看全部）');
  }
  if (importResult) {
    console.log('');
    console.log('import: 新增引用 ' + importResult.totals.imported + ' 条 · 跳过 ' + importResult.totals.skipped +
      ' 条 · 失败 ' + importResult.totals.failed + ' 条 · unmanaged_unknown 仍为 ' + importResult.totals.unmanaged + ' 条（未写引用、未删除）');
    for (const f of importResult.failed.slice(0, 10)) console.log('    ! ' + f.relative_path + ' → ' + f.reason);
  }
}
// 升级（escalation）：查看未解除的升级，或由 Lead/Human 放行。
//   node bus/cli.mjs escalation list
//   node bus/cli.mjs escalation release <task_id> [--kind <kind>] [--note <text>] [--reset-rounds] [--actor human]
function escalation() {
  const sub = process.argv[3] || 'list';
  // 和 archive 一致：允许 BUS_DB 指向临时库（测试/演练不碰真实数据）。
  const targetDb = process.env.BUS_DB ? S.openDb(process.env.BUS_DB) : db;
  const flagValue = function (name) {
    const i = process.argv.indexOf('--' + name);
    return i >= 0 && process.argv[i + 1] && process.argv[i + 1].slice(0, 2) !== '--' ? process.argv[i + 1] : '';
  };
  if (sub === 'list') {
    const rows = targetDb.prepare(
      'SELECT e.task_id, e.kind, e.created_at, t.status, t.owner, t.title FROM task_escalations e ' +
      'LEFT JOIN tasks t ON t.id = e.task_id ORDER BY e.created_at DESC'
    ).all();
    if (!rows.length) { console.log('没有未解除的升级'); return; }
    console.log(pad('任务', 12) + pad('kind', 16) + pad('状态', 12) + pad('owner', 14) + pad('时间', 26) + '标题');
    console.log('-'.repeat(110));
    for (const row of rows) {
      console.log(pad(row.task_id, 12) + pad(row.kind, 16) + pad(row.status || '-', 12) + pad(row.owner || '-', 14) +
        pad(row.created_at || '-', 26) + (row.title || ''));
    }
    return;
  }
  if (sub === 'release') {
    const taskId = process.argv[4] && process.argv[4].slice(0, 2) !== '--' ? process.argv[4] : '';
    if (!taskId) {
      console.log('用法: node bus/cli.mjs escalation release <task_id> [--kind <kind>] [--note <text>] [--reset-rounds] [--actor human]');
      process.exitCode = 1;
      return;
    }
    const result = S.releaseEscalation(targetDb, policy, {
      taskId: taskId,
      kind: flagValue('kind') || null,
      note: flagValue('note'),
      resetRounds: process.argv.indexOf('--reset-rounds') >= 0,
      actor: flagValue('actor') || 'human',
      auth_method: 'local-cli',
    });
    console.log(JSON.stringify(result, null, 2));
    if (!result.ok) process.exitCode = 1;
    return;
  }
  console.log('用法: node bus/cli.mjs escalation [list | release <task_id> [--kind <kind>] [--note <text>] [--reset-rounds] [--actor <id>]]');
}

// 孤儿过期行（无归档凭据）默认不删：plan 与 CLI 输出都要单列，避免"看起来已经清干净了"
function unmanagedLine(plan, deleted) {
  const u = (plan && plan.unmanaged) || {};
  const pruned = Number(plan && plan.prune_unmanaged) === 1;
  const head = deleted
    ? '本次删除孤儿行 ' + (deleted.unmanaged_messages || 0) + ' 条消息 / ' + (deleted.unmanaged_guard_events || 0) + ' 条守卫事件；'
    : '';
  return head + '不可归属（无归档凭据）: 消息 ' + (u.messages || 0) + ' 条 · 守卫事件 ' + (u.guard_events || 0) + ' 条 — '
    + (pruned ? 'retention.prune_unmanaged=1，允许删除' : '默认不删除（retention.prune_unmanaged=0，只上报）')
    + '；等待所属任务归档: 消息 ' + (u.deferred_messages || 0) + ' 条 · 守卫事件 ' + (u.deferred_guard_events || 0) + ' 条';
}

// archive --dry-run 只输出计划；--confirm <plan_hash> 才真正清理（hash 必须与本次计划一致）
// 第 4 项阶段 C：archive readiness —— 快照 → integrity_check → dry-run，只报告，绝不 apply
function archiveReadinessCommand() {
  const args = process.argv.slice(3);
  const jsonOut = args.indexOf('--json') >= 0;
  // 未指定 --archive-dir 时 archiveReadiness 自己落临时目录：readiness 绝不往仓库写东西。
  const dirAt = args.indexOf('--archive-dir');
  const report = Archive.archiveReadiness(db, policy, dirAt >= 0 ? { archiveDir: args[dirAt + 1] } : {});
  if (jsonOut) { console.log(JSON.stringify(report, null, 2)); return; }
  console.log('归档 readiness（三步，只读；不会 apply、不会改 retention）');
  for (const step of report.steps) console.log('  [' + (step.ok ? 'ok' : 'FAIL') + '] ' + step.step + (step.detail ? ' — ' + JSON.stringify(step.detail).slice(0, 200) : ''));
  console.log('  计划: ' + JSON.stringify(report.steps[2].detail.counts));
  console.log('  applies_nothing=' + report.applies_nothing + ' · retention=' + report.retention_unchanged);
  if (report.snapshot_dir) console.log('  快照目录: ' + report.snapshot_dir + '（临时目录，仓库未写入）');
  console.log('  下一步: ' + report.next_step);
  if (!report.ready) process.exitCode = 1;
}

function archive() {
  const args = process.argv.slice(3);
  if (args[0] === 'readiness') { archiveReadinessCommand(); return; }
  const confirmAt = args.indexOf('--confirm');
  const confirm = confirmAt >= 0 ? args[confirmAt + 1] : null;
  const targetDb = process.env.BUS_DB ? S.openDb(process.env.BUS_DB) : db;
  const plan = Archive.buildPlan(targetDb, policy, {});
  if (!confirm) {
    console.log(JSON.stringify({ dry_run: true, plan: plan }, null, 2));
    console.log('');
    console.log(unmanagedLine(plan, null));
    console.log('确认执行: node bus/cli.mjs archive --confirm ' + plan.plan_hash);
    return;
  }
  const result = Archive.applyArchive(targetDb, policy, plan, { confirm: confirm });
  console.log(JSON.stringify(result, null, 2));
  console.log('');
  console.log(unmanagedLine(plan, result.ok ? result.deleted : null));
  if (!result.ok) process.exitCode = 1;
}

// 认证就绪检查（第 5 项第 12 条）：三个已启用客户端都要有 active 凭据 + 配置文件 ACL 合格。
// 不 ready 时**禁止**把 require_credentials 置 true —— 这里只负责判定，卡点在 admin-config.validatePolicy。
// 第 9 项：项目 registry 上线门禁。一次列出**所有**不合格项目，逐条给修复命令；有 error 就是 fail-closed。
function doctorProjectReadiness() {
  const jsonOut = process.argv.indexOf('--json') >= 0;
  const PR = ProjectRegistry;
  const audit = PR.auditProjects(db, policy, { online: null });
  if (jsonOut) {
    console.log(JSON.stringify(audit, null, 2));
    if (!audit.ok) process.exitCode = 1;
    return;
  }
  console.log('项目 readiness（registry: ' + (audit.file || '未配置') + '）');
  console.log('  项目 ' + audit.totals.projects + ' 个 · error ' + audit.totals.errors + ' · warning ' + audit.totals.warnings);
  for (const project of audit.projects) {
    const mark = project.status === 'error' ? 'FAIL' : (project.status === 'warning' ? 'WARN' : 'OK  ');
    console.log('  [' + mark + '] ' + project.id + (project.path ? '  ' + project.path : ''));
    if (project.agents && project.agents.length) console.log('        agents: ' + project.agents.join(', '));
    const reviewers = (project.reviewers || []).filter(function (r) { return r.reviewers.length; });
    if (reviewers.length) console.log('        潜在 reviewer: ' + reviewers.map(function (r) { return (r.owner || '-') + ' → ' + r.reviewers.join('/'); }).join(' · '));
  }
  if (audit.findings.length) {
    console.log('');
    for (const f of audit.findings) {
      console.log('  ' + (f.level === 'error' ? 'ERROR' : 'WARN ') + ' [' + f.code + ']' + (f.project ? ' ' + f.project + '：' : ' ') + f.message);
      if (f.fix) console.log('        修法: ' + f.fix);
    }
  }
  if (!audit.ok) {
    console.log('');
    console.log('项目 registry 未就绪（fail-closed）：先处理上面的 ERROR 再启动或打包。');
    process.exitCode = 1;
    return;
  }
  console.log('');
  console.log('就绪：所有 active 项目都有绝对路径、合法 agent 和至少一个非 Lead、非 owner 的潜在 reviewer。');
}

function doctorAuthReadiness() {
  const profiles = AdminConfig.readMcpProfiles();
  const readiness = S.authReadiness(db, {
    profiles: profiles,
    verify: FilePerm.verify,
    requireCredentials: policy.global && policy.global.require_credentials === true,
  });
  console.log(JSON.stringify(readiness, null, 2));
  if (!readiness.ready) {
    console.log('');
    console.log('未就绪，禁止把 global.require_credentials 置为 true。先处理上面的 blockers。');
    process.exitCode = 1;
    return;
  }
  console.log('');
  console.log('就绪：可以执行三步启用的第 2 步（策略切到 require_credentials=true），然后重启并逐个 bus_status 验证。');
}

// 合并（第 11 项第 9/12 条）：preflight 只读展示二次确认内容；run 才真正执行合并。
//   node bus/cli.mjs merge preflight <request-id> [--json]
//   node bus/cli.mjs merge run <request-id> [--expect-preflight <hash>] [--json]
async function merge() {
  // CLI 和 store 一样认 BUS_PROJECTS（测试/演练可指向临时 registry，不碰真实注册表）。
  const projectOptions = process.env.BUS_PROJECTS ? { path: process.env.BUS_PROJECTS } : undefined;
  const sub = process.argv[3] || '';
  const requestId = process.argv[4] && process.argv[4].slice(0, 2) !== '--' ? process.argv[4] : '';
  const jsonOut = process.argv.indexOf('--json') >= 0;
  const expectAt = process.argv.indexOf('--expect-preflight');
  const expectPreflight = expectAt >= 0 ? process.argv[expectAt + 1] : null;
  const targetDb = process.env.BUS_DB ? S.openDb(process.env.BUS_DB) : db;
  if (!requestId) {
    console.log('用法: node bus/cli.mjs merge [preflight|run] <request-id> [--expect-preflight <hash>] [--json]');
    process.exitCode = 1;
    return;
  }
  if (sub === 'preflight' || sub === '') {
    const mr = S.getMergeRequest(targetDb, requestId);
    const repo = mr ? await repoState({ project: mr.project, projectOptions: projectOptions }) : null;
    const pre = S.mergePreflight(targetDb, policy, requestId, { repo: repo });
    if (jsonOut) { console.log(JSON.stringify({ repo: repo, preflight: pre }, null, 2)); if (!pre.ok) process.exitCode = 1; return; }
    if (!pre.ok) { console.log('无法生成二次确认: ' + pre.reason + ' ' + (pre.message || '')); process.exitCode = 1; return; }
    const p = pre.preflight;
    console.log('二次确认（执行前请逐项核对）');
    console.log('  请求: ' + p.request.id + '  状态 ' + p.request.status + '  version ' + p.request.version);
    console.log('  项目: ' + p.request.project + '  仓库 ' + ((p.repo && p.repo.root) || '—'));
    console.log('  ref : ' + p.request.source_ref + ' → ' + p.request.target_ref);
    console.log('  分支: ' + ((p.repo && p.repo.branch) || '—') + '  HEAD ' + String((p.repo && p.repo.head) || '—').slice(0, 12));
    console.log('  工作树: ' + ((p.repo && p.repo.worktree) || '—') + (p.repo && p.repo.in_merge ? '（正在 merge 中）' : ''));
    for (const t of p.tasks) {
      console.log('  任务 ' + t.task_id + '  status=' + t.status + '  frozen=' + String(t.verify_spec_hash || '—').slice(0, 12) +
        '  验证 ' + (t.verification_ok ? 'OK ' + String(t.verify_run_id || '').slice(0, 16) : '不通过(' + t.verification_reason + ')'));
    }
    console.log('  快照 hash: ' + pre.preflight_hash);
    console.log('');
    console.log('确认执行: node bus/cli.mjs merge run ' + requestId + ' --expect-preflight ' + pre.preflight_hash);
    return;
  }
  if (sub === 'status') {
    const state = S.mergeExecutionState(targetDb, requestId, {});
    console.log(jsonOut ? JSON.stringify(state, null, 2) : [
      '请求 ' + requestId + '  status=' + state.status,
      '  worker=' + (state.worker_id || '—') + '  started=' + (state.started_at || '—') + '  lease=' + (state.lease_until || '—') + (state.lease_expired ? '（已过期）' : ''),
      '  needs_human=' + (state.needs_human ? '1：' + (state.needs_human_reason || '') : '0'),
      '  approved_preflight=' + (state.approved_preflight || '—'),
      '  error=' + (state.error || '—'),
      '  log=' + (state.log_path || '—'),
    ].join('\n'));
    if (!state.ok) process.exitCode = 1;
    return;
  }
  if (sub === 'recover') {
    // 崩溃遗留（merging）：Human 决定重试还是标记失败。重试前先确认仓库里没有未完成的 merge。
    const doRetry = process.argv.indexOf('--retry') >= 0;
    const doFail = process.argv.indexOf('--fail') >= 0;
    if (doRetry === doFail) { console.log('用法: node bus/cli.mjs merge recover <request-id> --retry|--fail'); process.exitCode = 1; return; }
    const mr = S.getMergeRequest(targetDb, requestId);
    if (!mr) { console.log('没有这个合并请求: ' + requestId); process.exitCode = 1; return; }
    if (doFail) {
      const snapshot = S.mergeExecutionState(targetDb, requestId, {});
      const result = S.finishMerge(targetDb, requestId, { status: 'failed', error: 'Human 判定为崩溃遗留' }, S.getMergeRequest(targetDb, requestId).version);
      console.log(JSON.stringify({ action: 'fail', state: snapshot, result: result }, null, 2));
      if (!result.ok) process.exitCode = 1;
      return;
    }
    const repo = await repoState({ project: mr.project, projectOptions: projectOptions });
    const result = S.resetMergeForRetry(targetDb, requestId, 'human', { inMerge: !!(repo && repo.in_merge), note: 'cli recover --retry' });
    console.log(JSON.stringify({ action: 'retry', repo_in_merge: !!(repo && repo.in_merge), result: result }, null, 2));
    if (!result.ok) process.exitCode = 1;
    return;
  }
  if (sub === 'run') {
    const result = await runMergeRequest(targetDb, policy, requestId, { expectPreflight: expectPreflight || null, actor: 'human', projectOptions: projectOptions });
    console.log(JSON.stringify(result, null, 2));
    if (!result.ok) process.exitCode = 1;
    return;
  }
  console.log('用法: node bus/cli.mjs merge [preflight|run|status|recover] <request-id> [--expect-preflight <hash>] [--retry|--fail] [--json]');
  process.exitCode = 1;
}
// ---------- 安装与诊断（第 12 项第 1/2/3 条） ----------
// 版本号单一来源：package.json。MCP serverInfo 与看板 API 也应读这里（它们不在本卡 scope，见交付说明）。
export function readPackage() {
  const file = path.join(S.BUS_DIR, '..', 'package.json');
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (error) { return { name: 'agentbus', version: '0.0.0', error: String((error && error.message) || error) }; }
}
export function readVersion() { return String(readPackage().version || '0.0.0'); }

// 文本配置的指纹：uninstall 靠它判断「用户改过没有」，改过就停手、绝不覆盖整份配置。
function fileDigest(file) {
  try { return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex'); }
  catch (error) { return null; }
}

export function examplePolicyPath() { return path.join(S.BUS_DIR, 'policy.example.json'); }

// 示例策略里以 _ 开头的键只是给人看的说明，复制成 policy.json 时去掉（运行时策略保持纯净）。
export function readExamplePolicy() {
  const raw = JSON.parse(fs.readFileSync(examplePolicyPath(), 'utf8'));
  const clean = {};
  for (const key of Object.keys(raw)) { if (key.charAt(0) === '_') continue; clean[key] = raw[key]; }
  return clean;
}

function installPaths(options) {
  const o = options || {};
  const root = path.resolve(o.root || S.BUS_DIR);
  return {
    root: root,
    dbPath: path.resolve(o.dbPath || path.join(root, 'bus.db')),
    registryPath: path.resolve(o.registryPath || path.join(root, 'projects.json')),
    policyPath: path.resolve(o.policyPath || path.join(root, 'policy.json')),
    manifestPath: path.resolve(o.manifestPath || path.join(root, 'install-manifest.json')),
    lifecycleFile: path.resolve(o.lifecycleFile || path.join(root, 'lifecycle.json')),
    homeDir: o.homeDir ? path.resolve(o.homeDir) : undefined,
  };
}

// install-manifest.json：将来 uninstall 的**唯一**依据。init 的每一步都写进来。
function readManifest(file) {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!parsed || typeof parsed !== 'object') return null;
    return { version: 1, steps: Array.isArray(parsed.steps) ? parsed.steps : [], files: parsed.files && typeof parsed.files === 'object' ? parsed.files : {} };
  } catch (error) { return null; }
}

function writeManifest(file, manifest) {
  manifest.updated_at = new Date().toISOString();
  AdminConfig.atomicWrite(file, JSON.stringify(manifest, null, 2) + '\n');
  return file;
}

function manifestStep(manifest, entry) {
  const key = entry.id + '|' + (entry.path || '');
  const kept = manifest.steps.filter(function (s) { return (s.id + '|' + (s.path || '')) !== key; });
  kept.push(entry);
  manifest.steps = kept;
  if (entry.path && entry.kind) {
    const prev = manifest.files[entry.path];
    const digest = entry.kind === 'database' ? null : fileDigest(entry.path);
    manifest.files[entry.path] = Object.assign({ kind: entry.kind, first_seen_at: prev ? prev.first_seen_at : entry.at }, prev || {}, {
      kind: entry.kind, last_action: entry.action, last_result: entry.result, backup: entry.backup || (prev && prev.backup) || null,
      sha256: digest || (prev && prev.sha256) || null,
    });
  }
}

// agentbus init：创建运行目录/数据库/projects registry，再复用既有 managed-block 写法配置 MCP。
// 每一步都进 manifest；已存在且启用的 MCP 配置**保持不变**（不覆盖用户改动）。
export function runInit(options) {
  const o = options || {};
  const paths = installPaths(o);
  const now = function () { return new Date().toISOString(); };
  const manifest = readManifest(paths.manifestPath) || { version: 1, steps: [], files: {} };
  manifest.agentbus_version = readVersion();
  const steps = [];
  function record(entry) {
    const withAt = Object.assign({ at: now() }, entry);
    manifestStep(manifest, withAt);
    steps.push(withAt);
    return withAt;
  }
  // 1) 运行目录
  const hadDir = fs.existsSync(paths.root);
  fs.mkdirSync(paths.root, { recursive: true });
  record({ id: 'run_dir', action: 'mkdir', path: paths.root, result: hadDir ? 'existed' : 'created', kind: 'directory' });
  // 2) 数据库（openDb 会建表并跑迁移）
  const hadDb = fs.existsSync(paths.dbPath);
  let schemaVersion = null;
  try {
    const handle = S.openDb(paths.dbPath);
    try { schemaVersion = Number((handle.prepare('SELECT MAX(version) AS v FROM schema_migrations').get() || {}).v) || 0; } catch (e) { schemaVersion = null; }
    handle.close();
  } catch (error) {
    record({ id: 'database', action: 'open', path: paths.dbPath, result: 'failed', kind: 'database', detail: String((error && error.message) || error) });
    return { ok: false, reason: 'database_open_failed', message: String((error && error.message) || error), steps: steps, manifest_path: writeManifest(paths.manifestPath, manifest) };
  }
  record({ id: 'database', action: 'create', path: paths.dbPath, result: hadDb ? 'existed' : 'created', kind: 'database', schema_version: schemaVersion });
  // 3) projects registry
  const hadRegistry = fs.existsSync(paths.registryPath);
  if (!hadRegistry) {
    AdminConfig.atomicWrite(paths.registryPath, JSON.stringify({ projects: {} }, null, 2) + '\n');
  }
  record({ id: 'project_registry', action: 'create', path: paths.registryPath, result: hadRegistry ? 'existed' : 'created', kind: 'registry' });
  // 4) 策略文件：不替用户编造，缺失时只记录并给修复命令
  const hadPolicy = fs.existsSync(paths.policyPath);
  let policyResult = hadPolicy ? 'existed' : 'created';
  let policyDetail = null;
  if (!hadPolicy) {
    try {
      AdminConfig.atomicWrite(paths.policyPath, JSON.stringify(readExamplePolicy(), null, 2) + '\n');
      policyDetail = '从 policy.example.json 复制（默认示例，请按需修改）';
    } catch (error) {
      policyResult = 'missing';
      policyDetail = '复制示例策略失败: ' + String((error && error.message) || error);
    }
  }
  record({ id: 'policy', action: hadPolicy ? 'check' : 'copy_example', path: paths.policyPath, result: policyResult,
    kind: policyResult === 'missing' ? null : 'policy', detail: policyDetail,
    fix: policyResult === 'missing' ? '手工创建 bus/policy.json（可参考 bus/policy.example.json）' : null });
  // 5) MCP 配置：已有且启用的保持原样；缺失或禁用才写
  let profiles = [];
  try { profiles = AdminConfig.readMcpProfiles({ homeDir: paths.homeDir }) || []; } catch (error) { profiles = []; }
  for (const profile of profiles) {
    if (profile.enabled === true && profile.exists === true) {
      record({ id: 'mcp', action: 'keep', path: profile.path, result: 'kept', kind: 'mcp-config', client: profile.id });
      continue;
    }
    try {
      const saved = AdminConfig.saveMcpProfile(profile.id, { enabled: true, agent: profile.agent }, { homeDir: paths.homeDir });
      record({ id: 'mcp', action: 'write', path: (saved.profile && saved.profile.path) || profile.path, result: 'written', kind: 'mcp-config',
        client: profile.id, backup: saved.backup || null, acl_ok: !!(saved.acl && saved.acl.ok === true) });
    } catch (error) {
      record({ id: 'mcp', action: 'write', path: profile.path, result: 'failed', kind: 'mcp-config', client: profile.id, detail: String((error && error.message) || error) });
    }
  }
  const manifestPath = writeManifest(paths.manifestPath, manifest);
  const failed = steps.filter(function (s) { return s.result === 'failed'; });
  return { ok: failed.length === 0, reason: failed.length ? 'partial_failure' : null, version: manifest.agentbus_version,
    paths: paths, steps: steps, manifest_path: manifestPath, manifest: manifest };
}
// ---------- doctor：只诊断，不修改；每项都给具体修复命令 ----------
const MIN_NODE_MAJOR = 24;
const BOARD_PORT = Number(process.env.AGENTBUS_PORT || 7400);

function checkNodeVersion() {
  const major = Number(String(process.versions.node).split('.')[0]);
  return { id: 'node_version', title: 'Node 版本', status: major >= MIN_NODE_MAJOR ? 'ok' : 'fail',
    detail: 'v' + process.versions.node + '（要求 >= ' + MIN_NODE_MAJOR + '）',
    fix: major >= MIN_NODE_MAJOR ? null : '安装 Node ' + MIN_NODE_MAJOR + '+ 后重开终端：https://nodejs.org/ （nvm install 24）' };
}

// 三个 CLI 探测：只扫 PATH（不执行外部程序，避免诊断本身产生副作用/权限请求）。
function checkAgentClis(env) {
  const pathVar = String((env && env.PATH) || process.env.PATH || '');
  const dirs = pathVar.split(path.delimiter).filter(Boolean);
  const wanted = ['codex', 'claude', 'dsh'];
  const found = {};
  for (const name of wanted) {
    found[name] = dirs.some(function (dir) {
      return ['', '.cmd', '.exe', '.ps1'].some(function (ext) { try { return fs.existsSync(path.join(dir, name + ext)); } catch (e) { return false; } });
    });
  }
  const missing = wanted.filter(function (n) { return !found[n]; });
  return { id: 'agent_clis', title: '三个 Agent CLI 探测（PATH 扫描）', status: missing.length === 0 ? 'ok' : 'warn',
    detail: wanted.map(function (n) { return n + '=' + (found[n] ? 'found' : 'missing'); }).join(' '),
    fix: missing.length ? '把缺失的 CLI 装好或加进 PATH：' + missing.join(', ') + '（确认后重跑 agentbus doctor）' : null };
}

async function checkPort(port) {
  const net = await import('node:net');
  return new Promise(function (resolve) {
    const socket = net.connect({ host: '127.0.0.1', port: port });
    let done = false;
    function finish(inUse, detail) {
      if (done) return;
      done = true;
      try { socket.destroy(); } catch (e) {}
      resolve({ id: 'board_port', title: '看板端口 ' + port, status: inUse ? 'warn' : 'ok', detail: detail,
        fix: inUse ? '端口已被占用（可能看板已在跑）。查看：netstat -ano | findstr :' + port + '；换端口：AGENTBUS_PORT=7401 agentbus start' : null });
    }
    socket.setTimeout(600, function () { finish(false, '连接超时，视为空闲'); });
    socket.on('connect', function () { finish(true, '127.0.0.1:' + port + ' 已有服务在监听'); });
    socket.on('error', function (error) { finish(false, '空闲（' + String((error && error.code) || 'no listener') + '）'); });
  });
}

function checkDatabase(paths) {
  if (!fs.existsSync(paths.dbPath)) {
    return { id: 'sqlite', title: 'SQLite 数据库', status: 'fail', detail: '数据库不存在: ' + paths.dbPath,
      fix: 'agentbus init   # 创建数据库与运行目录' };
  }
  try {
    const handle = S.openDb(paths.dbPath);
    let journal = null, writable = false, schemaVersion = null, integrity = null;
    try { journal = String((handle.prepare('PRAGMA journal_mode').get() || {}).journal_mode || ''); } catch (e) {}
    try { handle.exec('BEGIN IMMEDIATE'); handle.exec('ROLLBACK'); writable = true; } catch (e) { writable = false; }
    try { schemaVersion = Number((handle.prepare('SELECT MAX(version) AS v FROM schema_migrations').get() || {}).v) || 0; } catch (e) { schemaVersion = null; }
    try { integrity = String((handle.prepare('PRAGMA quick_check').get() || {}).quick_check || ''); } catch (e) {}
    handle.close();
    const walOk = journal.toLowerCase() === 'wal';
    const status = (writable && integrity === 'ok') ? (walOk ? 'ok' : 'warn') : 'fail';
    const fixes = [];
    if (!writable) fixes.push('数据库不可写：检查文件 ACL/只读属性（takeown /f ' + paths.dbPath + ' /a；或换目录）');
    if (integrity !== 'ok') fixes.push('完整性检查未通过：先用 sqlite3 "' + paths.dbPath + '" \'PRAGMA integrity_check;\' 备份后处理');
    if (!walOk) fixes.push('未启用 WAL：确认没有别的进程锁住数据库，或删除 -wal/-shm 残留后重连');
    return { id: 'sqlite', title: 'SQLite 可写性与 WAL', status: status, detail: 'journal=' + (journal || '?') + ' writable=' + writable + ' quick_check=' + (integrity || '?'),
      fix: fixes.length ? fixes.join('；') : null, schema_version: schemaVersion };
  } catch (error) {
    return { id: 'sqlite', title: 'SQLite 可写性与 WAL', status: 'fail', detail: String((error && error.message) || error),
      fix: '数据库打不开：先备份 ' + paths.dbPath + '，再跑 agentbus doctor 看具体报错；必要时 agentbus init 重建（会保留原文件）' };
  }
}

function checkSchemaVersion(dbPath) {
  // doctor 只诊断：数据库不存在时绝不 openDb（openDb 会建文件，等于悄悄"修好"了）。
  if (!fs.existsSync(dbPath)) {
    return { id: 'schema_version', title: 'schema 版本', status: 'warn', detail: '数据库不存在，无法读取 schema 版本',
      fix: 'agentbus init   # 先创建数据库与运行目录' };
  }
  try {
    const handle = S.openDb(dbPath);
    let version = null;
    try { version = Number((handle.prepare('SELECT MAX(version) AS v FROM schema_migrations').get() || {}).v) || 0; } catch (e) { version = null; }
    handle.close();
    if (version == null) {
      return { id: 'schema_version', title: 'schema 版本', status: 'warn', detail: '没有 schema_migrations 表（版本化迁移尚未落地）',
        fix: '本次版本尚未引入 schema_migrations；保持在当前版本，等版本化迁移卡落地后重跑 doctor' };
    }
    return { id: 'schema_version', title: 'schema 版本', status: 'ok', detail: 'version=' + version, fix: null, version: version };
  } catch (error) {
    return { id: 'schema_version', title: 'schema 版本', status: 'fail', detail: String((error && error.message) || error), fix: '先修数据库（见 sqlite 项）' };
  }
}

function checkPolicy(paths) {
  if (!fs.existsSync(paths.policyPath)) {
    return { id: 'policy', title: '策略校验', status: 'fail', detail: '策略文件不存在: ' + paths.policyPath, fix: '按 README「调度策略」创建 bus/policy.json，然后重跑 agentbus doctor' };
  }
  try {
    const raw = JSON.parse(fs.readFileSync(paths.policyPath, 'utf8'));
    AdminConfig.validatePolicy(raw, {});
    const unknown = (AdminConfig.unknownPolicyPaths && AdminConfig.unknownPolicyPaths(raw)) || [];
    return { id: 'policy', title: '策略校验', status: unknown.length ? 'warn' : 'ok',
      detail: unknown.length ? '未知字段: ' + unknown.join(', ') : '通过 validatePolicy',
      fix: unknown.length ? '删掉这些未知字段或升级到支持它们的版本；看板保存一次策略也会给出同样提示' : null };
  } catch (error) {
    return { id: 'policy', title: '策略校验', status: 'fail', detail: String((error && error.message) || error),
      fix: '修 ' + paths.policyPath + ' 后重跑；字段边界见 bus/policy-schema.mjs' };
  }
}

function checkProjects(paths) {
  try {
    const registry = AdminConfig.readProjectsRegistry({ path: paths.registryPath });
    const entries = (registry && registry.projects) || {};
    const missing = [];
    for (const id of Object.keys(entries)) {
      const dir = entries[id] && entries[id].path;
      if (dir && !fs.existsSync(dir)) missing.push(id + ' → ' + dir);
    }
    return { id: 'projects', title: '项目路径', status: missing.length ? 'warn' : 'ok',
      detail: Object.keys(entries).length + ' 个项目' + (missing.length ? '，路径缺失: ' + missing.join('; ') : ''),
      fix: missing.length ? 'agentbus projects 查看；用看板「项目管理」重设路径或删除登记项' : null };
  } catch (error) {
    return { id: 'projects', title: '项目路径', status: 'fail', detail: String((error && error.message) || error), fix: '修复 ' + paths.registryPath + ' 的 JSON 后重跑' };
  }
}

function checkMcp(paths) {
  const profiles = AdminConfig.readMcpProfiles({ homeDir: paths.homeDir }) || [];
  const parts = [];
  let status = 'ok';
  for (const profile of profiles) {
    const exists = profile.exists === true;
    const enabled = profile.enabled === true;
    const acl = profile.path ? FilePerm.verify(profile.path) : { ok: false, detail: '无路径' };
    if (!exists) status = status === 'ok' ? 'warn' : status;
    if (exists && !enabled) status = status === 'ok' ? 'warn' : status;
    if (exists && acl.ok !== true) status = 'warn';
    parts.push(profile.id + '=' + (exists ? (enabled ? 'enabled' : 'disabled') : 'missing') + (exists && acl.ok !== true ? '(权限不严)' : ''));
  }
  return { id: 'mcp', title: 'MCP 配置', status: status, detail: parts.join(' ') || '没有可探测的客户端',
    fix: status === 'ok' ? null : 'agentbus init   # 会补齐缺失/禁用的 MCP 配置并保留既有内容；权限加固失败的机器见 agentbus doctor --auth-readiness' };
}

function checkCredentials(paths) {
  if (!fs.existsSync(paths.dbPath)) {
    return { id: 'credentials', title: '凭据与权限', status: 'warn', detail: '数据库不存在，无法检查凭据',
      fix: 'agentbus init   # 建库后再 agentbus credentials rotate <client>' };
  }
  try {
    const handle = S.openDb(paths.dbPath);
    let rows = [];
    try { rows = handle.prepare('SELECT agent_id, state, revoked_at, expires_at FROM agent_credentials').all(); } catch (e) { rows = []; }
    handle.close();
    const now = Date.now();
    const active = rows.filter(function (r) { return (!r.state || r.state === 'active') && !r.revoked_at && (!r.expires_at || Date.parse(r.expires_at) > now); });
    const acl = FilePerm.verify(paths.dbPath);
    return { id: 'credentials', title: '凭据与权限', status: rows.length === 0 ? 'warn' : (acl.ok === true ? 'ok' : 'warn'),
      detail: '凭据 ' + rows.length + ' 条（可用 ' + active.length + '）· 数据库 ACL ' + (acl.ok === true ? '已收紧' : '未收紧（' + acl.detail + '）'),
      fix: (rows.length === 0 ? 'agentbus credentials rotate codex（按需为每个客户端签发）' : null) || (acl.ok === true ? null : '在支持 ACL 的机器上跑 agentbus doctor --auth-readiness 并按其 blockers 处理') };
  } catch (error) {
    return { id: 'credentials', title: '凭据与权限', status: 'warn', detail: String((error && error.message) || error), fix: 'agentbus init 建库后重跑' };
  }
}

// 第 15 项第 9 条：共享文件被两个活跃任务同时写是红线（我们就是这么坏过三次的）。
function checkSharedFileOwners() {
  const active = activeTasks();
  const conflicts = sharedFileConflicts(active);
  if (!conflicts.length) {
    return { id: 'shared_files', title: '共享文件单一 owner', status: 'ok',
      detail: active.length + ' 个活跃任务，没有共享文件被两个任务同时写', fix: null };
  }
  return { id: 'shared_files', title: '共享文件单一 owner', status: 'warn',
    detail: conflicts.map(function (c) { return c.file + ' ← ' + c.tasks.join(','); }).join(' · '),
    fix: '把并行任务拆开：让其中一个先做（或把写共享文件的部分单独成卡）。共享清单: ' + SHARED_FILES.join(', ') };
}

function checkSupervisor(paths) {
  if (!fs.existsSync(paths.dbPath)) {
    return { id: 'supervisor', title: 'supervisor 心跳', status: 'warn', detail: '数据库不存在，无法检查心跳',
      fix: 'agentbus init 后启动 supervisor：node bus/claude-supervisor.mjs' };
  }
  try {
    const handle = S.openDb(paths.dbPath);
    let agents = [];
    try { agents = S.listAgents(handle) || []; } catch (e) { agents = []; }
    handle.close();
    const fresh = agents.filter(function (a) { const t = a.last_seen || a.updated_at; return t && (Date.now() - Date.parse(t) < 10 * 60000); });
    return { id: 'supervisor', title: 'supervisor 心跳', status: fresh.length ? 'ok' : 'warn',
      detail: agents.length + ' 个 agent，10 分钟内有心跳的 ' + fresh.length + ' 个',
      fix: fresh.length ? null : '启动 supervisor：node bus/claude-supervisor.mjs 或 node bus/codex-supervisor.mjs（MCP 客户端连上后也会心跳）' };
  } catch (error) {
    return { id: 'supervisor', title: 'supervisor 心跳', status: 'warn', detail: String((error && error.message) || error), fix: 'agentbus init 建库后重跑' };
  }
}

export async function runDoctor(options) {
  const o = options || {};
  const paths = installPaths(o);
  const checks = [];
  checks.push(checkNodeVersion());
  checks.push(checkAgentClis(o.env));
  checks.push(await checkPort(Number(o.port || BOARD_PORT)));
  checks.push(checkDatabase(paths));
  checks.push(checkSchemaVersion(paths.dbPath));
  checks.push(checkPolicy(paths));
  checks.push(checkProjects(paths));
  checks.push(checkMcp(paths));
  checks.push(checkCredentials(paths));
  checks.push(checkSharedFileOwners());
  checks.push(checkSupervisor(paths));
  const counts = { ok: 0, warn: 0, fail: 0 };
  for (const c of checks) counts[c.status] = (counts[c.status] || 0) + 1;
  return { ok: counts.fail === 0, version: readVersion(), paths: paths, checks: checks, counts: counts, exit_code: counts.fail ? 1 : 0 };
}
// agentbus doctor：默认跑结构化检查；--auth-readiness 保留原来的认证就绪检查（第 5 项）。
// 隔离探测（第 3 项第 9/10 条）：把三个引擎的 probe 结果摊开，并写清"要变成 verified 需要什么"。
// 不许把未验证写成通过：verified=false 时退出码 1，方便 CI/脚本判定。
function doctorProbeEngine() {
  const args = process.argv.slice(3);
  const jsonOut = args.indexOf('--json') >= 0;
  const report = EngineReport.reportEngines({});
  if (jsonOut) {
    console.log(JSON.stringify(report, null, 2));
    if (!report.verified) process.exitCode = 1;
    return;
  }
  console.log('隔离探测 probe · ' + report.note);
  for (const engine of report.engines) {
    console.log('  ' + pad(engine.engine, 7) + ' provider=' + pad(engine.provider, 12) +
      ' verified=' + pad(String(engine.verified), 6) + ' reason=' + engine.reason +
      ' · 写隔离=' + (engine.strongWriteIsolation ? 'true' : 'false') +
      ' 网络隔离=' + (engine.networkIsolation ? 'true' : 'false'));
    console.log('         下一步: ' + engine.next_step);
  }
  const runtime = report.runtime || {};
  console.log('  容器运行时: ' + (runtime.runtime ? runtime.runtime + ' @ ' + runtime.path : '未检测到 docker / podman'));
  console.log('  要变成 verified=true 需要:');
  for (const requirement of report.requirements) console.log('    - ' + requirement);
  console.log('');
  if (!report.verified) {
    console.log('结论: verified=false —— 本机隔离未验证，强隔离类任务（extra_dirs / 删除 / 配置授权 / 联网）会被拒发 grant。');
    process.exitCode = 1;
  } else {
    console.log('结论: verified=true —— 三个引擎的 probe 都通过。');
  }
}


// ---------------------------------------------------------------- 生命周期（第 15 项第 10 条）
// 状态文件与看板共用一份：console-server 里的 lifecycle* 函数是唯一实现，这里只做 CLI 接线 + 进程操作。
async function lifecycleModule() { return import('./console-server.mjs'); }

// 第 9 项：启动前置门禁。registry 不合格就不启动，并把每条修法打出来。
function assertProjectReadiness(allowUnready) {
  if (allowUnready === true) return;
  const audit = ProjectRegistry.auditProjects(db, policy, {});
  if (audit.ok) return;
  console.error('拒绝启动：项目 registry 未就绪（fail-closed）');
  for (const f of audit.errors) {
    console.error('  ERROR [' + f.code + ']' + (f.project ? ' ' + f.project + '：' : ' ') + f.message);
    if (f.fix) console.error('        修法: ' + f.fix);
  }
  console.error('');
  console.error('先修上面这些（或临时用 agentbus start --allow-unready-projects），再启动看板。');
  process.exit(1);
}

function lifecycleArg(name) {
  const args = process.argv.slice(3);
  const i = args.indexOf('--' + name);
  if (i >= 0 && args[i + 1] && String(args[i + 1]).slice(0, 2) !== '--') return args[i + 1];
  const eq = args.filter(function (a) { return a.indexOf('--' + name + '=') === 0; })[0];
  return eq ? eq.slice(name.length + 3) : null;
}

function lifecycleTargets() {
  const raw = lifecycleArg('component') || 'all';
  if (String(raw) === 'all') return ['board', 'codex', 'claude', 'dsh'];
  const list = String(raw).split(',').map(function (x) { return x.trim(); }).filter(Boolean);
  const bad = list.filter(function (x) { return ['board', 'codex', 'claude', 'dsh'].indexOf(x) < 0; });
  if (bad.length) return { error: '未知组件: ' + bad.join(', ') + '（可选 board/codex/claude/dsh/all）' };
  return list;
}

async function lifecycleStatus() {
  const LC = await lifecycleModule();
  const jsonOut = process.argv.indexOf('--json') >= 0;
  const snapshot = LC.lifecycleSnapshot(db);
  if (jsonOut) { console.log(JSON.stringify(snapshot, null, 2)); return; }
  console.log('组件状态（lifecycle: ' + snapshot.file + '）');
  for (const c of snapshot.components) {
    const state = c.running ? (c.stale ? '运行中·记录陈旧' : '运行中') : '未运行';
    console.log('  ' + pad(c.component, 8) + pad(state, 18) + pad(c.version ? 'v' + c.version : '—', 10) +
      pad(c.pid ? 'pid ' + c.pid : '—', 12) + (c.started_at ? '启动于 ' + c.started_at : ''));
  }
  if (snapshot.cleared_now.length) console.log('\n已确认重启并自动清除: ' + snapshot.cleared_now.map(function (r) { return r.component; }).join(', '));
  if (!snapshot.restart_required.length) { console.log('\n没有待重启的组件。'); return; }
  console.log('\n需要重启（改动不会自动生效）:');
  for (const r of snapshot.restart_required) {
    console.log('  - ' + r.component + '：' + r.reason + '（' + r.created_at + '）');
    console.log('    命令: ' + r.command);
  }
}

// 端口占用检查：能 listen 就是空闲。失败立刻关闭，不留监听。
async function portFree(port) {
  const net = await import('node:net');
  return new Promise(function (resolve) {
    const server = net.createServer();
    server.once('error', function () { resolve(false); });
    server.once('listening', function () { server.close(function () { resolve(true); }); });
    try { server.listen(Number(port), '127.0.0.1'); } catch (e) { resolve(false); }
  });
}

async function lifecycleStart() {
  const LC = await lifecycleModule();
  const targets = lifecycleTargets();
  if (targets && targets.error) { console.log(targets.error); process.exitCode = 2; return; }
  if (targets.length !== 1 || targets[0] !== 'board') {
    console.log('start 只负责看板（board）。MCP 客户端由宿主启动：请在客户端里重启，或用 agentbus restart --component <客户端> 看命令。');
    process.exitCode = 2;
    return;
  }
  // 第 9 项：启动前置门禁（fail-closed）。不合格就不启动，避免"服务在跑但任务永远等不到评审"。
  assertProjectReadiness(process.argv.indexOf('--allow-unready-projects') >= 0);
  const state = LC.readLifecycle();
  const board = LC.componentState(state.components.board);
  if (board.running) {
    console.log('看板已在运行（pid ' + board.pid + '，启动于 ' + board.started_at + '）。要换一个新的请先 agentbus stop --component board。');
    process.exitCode = 1;
    return;
  }
  if (state.components.board && !board.running) {
    console.log('检测到残留 PID 记录（pid ' + state.components.board.pid + ' 已不存在）：先清理记录再启动。');
    LC.clearComponent('board');
  }
  const port = Number(process.env.AGENTBUS_PORT || 7400);
  if (!(await portFree(port))) {
    console.log('端口 ' + port + ' 已被占用：换端口（AGENTBUS_PORT=7401 agentbus start）或先停掉占用进程。');
    process.exitCode = 1;
    return;
  }
  const nonce = crypto.randomBytes(8).toString('hex');
  LC.recordComponent('board', { pid: process.pid, port: port, version: readVersion(), instance_nonce: nonce, started_at: new Date().toISOString(), control_endpoint: 'http://127.0.0.1:' + port });
  const cleanup = function () { try { LC.clearComponent('board'); } catch (e) {} };
  process.on('exit', cleanup);
  process.on('SIGINT', function () { cleanup(); process.exit(0); });
  process.on('SIGTERM', function () { cleanup(); process.exit(0); });
  return await start();
}

async function lifecycleStop() {
  const LC = await lifecycleModule();
  const targets = lifecycleTargets();
  if (targets && targets.error) { console.log(targets.error); process.exitCode = 2; return; }
  const state = LC.readLifecycle();
  let failures = 0;
  for (const name of targets) {
    const record = state.components[name];
    if (!record || !record.pid) { console.log(pad(name, 8) + '没有 PID 记录，什么都不做（不会是 PASS 也不报错，stop 是幂等的）'); continue; }
    const detail = LC.componentState(record);
    if (!detail.running) { console.log(pad(name, 8) + 'PID ' + record.pid + ' 已不存在，清理残留记录'); LC.clearComponent(name); continue; }
    // 只关我们自己记录过的进程；先用控制端点优雅退出，超时才 kill 这个 pid（绝不按进程名批量杀）。
    let graceful = false;
    if (record.control_endpoint) {
      try {
        const http = await import('node:http');
        await new Promise(function (resolve, reject) {
          const req = http.request(record.control_endpoint + '/api/console/shutdown', { method: 'POST', timeout: 2500, headers: { 'x-agentbus-request': '' } },
            function (res) { res.resume(); res.on('end', resolve); });
          req.on('timeout', function () { req.destroy(new Error('timeout')); });
          req.on('error', reject);
          req.end();
        });
        graceful = true;
      } catch (error) { graceful = false; }
    }
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline && LC.processAlive(record.pid)) {
      await new Promise(function (r) { setTimeout(r, 150); });
    }
    if (LC.processAlive(record.pid)) {
      try { process.kill(Number(record.pid)); console.log(pad(name, 8) + '优雅退出超时，已向 pid ' + record.pid + ' 发送终止信号'); }
      catch (error) { failures++; console.log(pad(name, 8) + '终止失败: ' + String((error && error.message) || error)); continue; }
      const killBy = Date.now() + 3000;
      while (Date.now() < killBy && LC.processAlive(record.pid)) await new Promise(function (r) { setTimeout(r, 100); });
    } else {
      console.log(pad(name, 8) + (graceful ? '已优雅退出' : '已退出') + '（pid ' + record.pid + '）');
    }
    if (LC.processAlive(record.pid)) { failures++; console.log(pad(name, 8) + '仍未退出，记录保留（pid ' + record.pid + '）'); continue; }
    LC.clearComponent(name);
  }
  if (failures) process.exitCode = 1;
}

async function lifecycleRestart() {
  const LC = await lifecycleModule();
  const targets = lifecycleTargets();
  if (targets && targets.error) { console.log(targets.error); process.exitCode = 2; return; }
  if (targets.indexOf('board') >= 0) {
    await lifecycleStop();
    if (process.exitCode) return;
    return await lifecycleStart();
  }
  // MCP 客户端不归我们启动：只提示该怎么重启，并保留 restart_required（重启后自动消失）。
  const state = LC.readLifecycle();
  for (const name of targets) {
    const marked = state.restart_required.some(function (r) { return r.component === name; });
    console.log(pad(name, 8) + 'MCP 客户端由宿主进程管理，无法从这里重启。请在对应客户端里重开 MCP 连接。');
    console.log('         ' + (marked ? '重启后这条 restart_required 会自动清除（心跳晚于改动时间即视为已重启）。' : '当前没有待重启标记。'));
  }
}


// ---------------------------------------------------------------- 第 15 项第 9 条：每任务独立 worktree
// 教训背景：我们因为「多个 Agent 同时改同一文件」坏过三次。因此这里除了建 worktree，还必须**主动报冲突**：
//   1) write_scope 重叠 → 列出冲突任务与重叠路径（警告，不阻断：有时是有意的）；
//   2) 共享文件（schema/migrations/policy/ui）被两个活跃任务同时写 → WARN（这类文件不该并行改）。
const SHARED_FILES = ['bus/schema.sql', 'bus/migrations/', 'bus/policy.json', 'bus/ui/', 'bus/console-server.mjs', 'bus/store.mjs'];
const ACTIVE_STATUSES = ['open', 'proposed', 'claimed', 'in_progress', 'review'];

function normalizeScopePath(p) {
  return String(p || '').replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+$/, '');
}
function scopeOverlap(a, b) {
  const x = normalizeScopePath(a), y = normalizeScopePath(b);
  if (!x || !y) return false;
  const dir = function (s) { return s.endsWith('/') ? s : s + '/'; };
  return x === y || dir(x).indexOf(dir(y)) === 0 || dir(y).indexOf(dir(x)) === 0;
}
function overlapWarnings(task, others) {
  const out = [];
  for (const other of others) {
    const hits = [];
    for (const mine of task.write_scope || []) {
      for (const theirs of other.write_scope || []) if (scopeOverlap(mine, theirs)) hits.push(normalizeScopePath(mine) + ' ↔ ' + normalizeScopePath(theirs));
    }
    if (hits.length) out.push({ task_id: other.id, title: other.title, overlaps: Array.from(new Set(hits)) });
  }
  return out;
}
// 共享文件被两个活跃任务同时写：这是"单 owner"红线，必须报出来（不阻断执行，但要在人眼前）。
function sharedFileConflicts(tasks) {
  const conflicts = [];
  for (const file of SHARED_FILES) {
    const owners = tasks.filter(function (t) {
      return (t.write_scope || []).some(function (s) { return scopeOverlap(s, file) || normalizeScopePath(s) === normalizeScopePath(file); });
    });
    if (owners.length > 1) conflicts.push({ file: file, tasks: owners.map(function (t) { return t.id; }) });
  }
  return conflicts;
}
function activeTasks() {
  try {
    const rows = db.prepare('SELECT id, title, status, owner, project, write_scope FROM tasks WHERE status IN (' + ACTIVE_STATUSES.map(function () { return '?'; }).join(',') + ')').all(...ACTIVE_STATUSES);
    return rows.map(function (r) {
      let scope = [];
      try { scope = JSON.parse(r.write_scope || '[]'); } catch (e) { scope = []; }
      return Object.assign({}, r, { write_scope: Array.isArray(scope) ? scope.map(String) : [] });
    });
  } catch (error) { return []; }
}
function taskRow(id) {
  try {
    const r = db.prepare('SELECT id, title, status, owner, project, write_scope FROM tasks WHERE id = ?').get(String(id));
    if (!r) return null;
    let scope = [];
    try { scope = JSON.parse(r.write_scope || '[]'); } catch (e) { scope = []; }
    return Object.assign({}, r, { write_scope: Array.isArray(scope) ? scope.map(String) : [] });
  } catch (error) { return null; }
}

// git 调用走 fd 重定向（本机禁管道 stdio），并把 safe.directory 一起带上，不动全局配置。
async function gitRun(args, cwd) {
  const cp = await import('node:child_process');
  const osMod = await import('node:os');
  const fsMod = fs;
  const pathMod = path;
  const dir = fsMod.mkdtempSync(pathMod.join(osMod.tmpdir(), 'agentbus-git-'));
  const outFile = pathMod.join(dir, 'out.txt'), errFile = pathMod.join(dir, 'err.txt');
  const fdOut = fsMod.openSync(outFile, 'w'), fdErr = fsMod.openSync(errFile, 'w');
  const child = cp.spawn('git', ['-c', 'safe.directory=*'].concat(args), { cwd: cwd, stdio: ['ignore', fdOut, fdErr], windowsHide: true, shell: false });
  return new Promise(function (resolve) {
    child.on('close', function (code) {
      fsMod.closeSync(fdOut); fsMod.closeSync(fdErr);
      const stdout = fsMod.readFileSync(outFile, 'utf8');
      const stderr = fsMod.readFileSync(errFile, 'utf8');
      fsMod.rmSync(dir, { recursive: true, force: true });
      resolve({ code: code, stdout: stdout, stderr: stderr });
    });
    child.on('error', function (error) {
      try { fsMod.closeSync(fdOut); fsMod.closeSync(fdErr); } catch (e) {}
      resolve({ code: -1, stdout: '', stderr: String(error && error.message || error) });
    });
  });
}

function worktreeRoot(repo) {
  return path.join(repo, '.worktrees');
}
function projectRepoOf(task) {
  try {
    const registry = AdminConfig.readProjectsRegistry({ path: process.env.BUS_PROJECTS || path.join(S.BUS_DIR, 'projects.json') });
    const entry = (registry.projects || {})[task.project];
    if (entry && entry.path && fs.existsSync(entry.path)) return entry.path;
  } catch (error) { /* 没登记就回落到 BUS_DIR 的上一级 */ }
  return path.resolve(S.BUS_DIR, '..');
}

// worktree create：幂等；未认领/不存在拒绝；建完报重叠与共享文件冲突（警告不阻断）。
async function runWorktreeCreate(options) {
  const o = options || {};
  const task = taskRow(o.taskId);
  if (!task) return { ok: false, reason: 'task_not_found', message: '任务不存在: ' + o.taskId };
  if (!task.owner) return { ok: false, reason: 'task_not_claimed', message: '任务还没被认领（owner 为空），先 bus_claim 再建 worktree' };
  const repo = o.repo || projectRepoOf(task);
  const base = o.base || 'main';
  const target = path.join(worktreeRoot(repo), String(task.id));
  const branch = 'task/' + task.id;
  const others = activeTasks().filter(function (t) { return t.id !== task.id; });
  const warnings = {
    scope_overlaps: overlapWarnings(task, others),
    // 报**当前**所有共享文件冲突（不只与本任务相关的）：这是全局健康信号，人一眼就能看到谁和谁撞了。
    shared_file_conflicts: sharedFileConflicts([task].concat(others)),
  };
  if (fs.existsSync(path.join(target, '.git')) || fs.existsSync(target)) {
    return { ok: true, reason: 'already_exists', worktree: target, branch: branch, repo: repo, warnings: warnings };
  }
  fs.mkdirSync(worktreeRoot(repo), { recursive: true });
  const added = await gitRun(['worktree', 'add', '-b', branch, target, base], repo);
  if (added.code !== 0) {
    return { ok: false, reason: 'git_worktree_add_failed', message: String(added.stderr || added.stdout || '').slice(0, 500), repo: repo, worktree: target, base: base };
  }
  return { ok: true, reason: 'created', worktree: target, branch: branch, repo: repo, warnings: warnings };
}

async function runWorktreeList(options) {
  const o = options || {};
  const repo = o.repo || path.resolve(S.BUS_DIR, '..');
  const listed = await gitRun(['worktree', 'list', '--porcelain'], repo);
  if (listed.code !== 0) return { ok: false, reason: 'git_failed', message: String(listed.stderr || '').slice(0, 400) };
  // Windows CI：临时目录是 8.3 短名（RUNNER~1），而 git 报长名（runneradmin）；
  // 同时 porcelain 输出是 CRLF。两边都归一化后再做前缀比较，否则列表恒为空。
  const canon = function (value) {
    const raw = String(value == null ? '' : value).trim();
    try { return fs.realpathSync.native(raw); } catch (e) { try { return fs.realpathSync(raw); } catch (e2) { return raw; } }
  };
  const norm = function (value) { return canon(value).replace(/\\/g, '/').toLowerCase(); };
  const root = norm(worktreeRoot(repo));
  const entries = [];
  let current = null;
  for (const line of String(listed.stdout).split(/\r?\n/)) {
    if (line.indexOf('worktree ') === 0) { current = { path: line.slice('worktree '.length).trim() }; entries.push(current); }
    else if (current && line.indexOf('branch ') === 0) current.branch = line.slice('branch '.length).trim().replace('refs/heads/', '');
    else if (current && line.trim() === 'bare') current.bare = true;
  }
  const ours = entries.filter(function (e) { return norm(e.path).indexOf(root) === 0; });
  return { ok: true, repo: repo, root: worktreeRoot(repo), worktrees: ours, all_count: entries.length };
}

// remove：工作树脏（有未提交改动/未跟踪文件）就拒绝，**绝不 --force**。
async function runWorktreeRemove(options) {
  const o = options || {};
  const repo = o.repo || path.resolve(S.BUS_DIR, '..');
  const target = path.join(worktreeRoot(repo), String(o.taskId));
  if (!fs.existsSync(target)) return { ok: false, reason: 'worktree_not_found', message: '没有这个 worktree: ' + target };
  const status = await gitRun(['status', '--porcelain'], target);
  if (status.code !== 0) return { ok: false, reason: 'git_failed', message: String(status.stderr || '').slice(0, 400) };
  const dirty = String(status.stdout).split('\n').map(function (l) { return l.trim(); }).filter(Boolean);
  if (dirty.length) return { ok: false, reason: 'worktree_dirty', message: '工作树有未提交内容，拒绝删除（不会 --force）', dirty: dirty.slice(0, 20), worktree: target };
  const removed = await gitRun(['worktree', 'remove', target], repo);
  if (removed.code !== 0) return { ok: false, reason: 'git_worktree_remove_failed', message: String(removed.stderr || '').slice(0, 400), worktree: target };
  return { ok: true, reason: 'removed', worktree: target, branch: 'task/' + o.taskId, note: '分支保留（合并/清理由 Human 决定）' };
}

function worktreeCmd() {
  const args = process.argv.slice(3);
  const jsonOut = args.indexOf('--json') >= 0;
  const sub = args[0];
  const value = function (name) {
    const i = args.indexOf('--' + name);
    if (i >= 0 && args[i + 1] && String(args[i + 1]).slice(0, 2) !== '--') return args[i + 1];
    return null;
  };
  const taskId = args[1] && args[1].slice(0, 2) !== '--' ? args[1] : null;
  const run = async function () {
    if (sub === 'create') {
      if (!taskId) return { ok: false, reason: 'usage', message: '用法: node bus/cli.mjs worktree create <task-id> [--base main] [--repo <路径>] [--json]' };
      return await runWorktreeCreate({ taskId: taskId, base: value('base') || 'main', repo: value('repo') });
    }
    if (sub === 'list' || sub === undefined) return await runWorktreeList({ repo: value('repo') });
    if (sub === 'remove') {
      if (!taskId) return { ok: false, reason: 'usage', message: '用法: node bus/cli.mjs worktree remove <task-id> [--repo <路径>]' };
      return await runWorktreeRemove({ taskId: taskId, repo: value('repo') });
    }
    return { ok: false, reason: 'usage', message: '用法: node bus/cli.mjs worktree create|list|remove <task-id> [--base main] [--repo <路径>] [--json]' };
  };
  return run().then(function (result) {
    if (jsonOut) { console.log(JSON.stringify(result, null, 2)); }
    else {
      if (result.ok) {
        if (result.reason === 'created') console.log('已创建 worktree: ' + result.worktree + '（分支 ' + result.branch + '，base ' + result.base + '）');
        else if (result.reason === 'already_exists') console.log('worktree 已存在（幂等）: ' + result.worktree + '（分支 ' + result.branch + '）');
        else if (result.reason === 'removed') console.log('已删除 worktree: ' + result.worktree + '；' + (result.note || ''));
        else if (result.worktrees) {
          if (!result.worktrees.length) console.log('没有本仓库管理的 worktree（目录 ' + result.root + '）');
          for (const w of result.worktrees) console.log('  ' + pad(String(w.branch || '?'), 24) + w.path);
        }
      } else {
        console.log('失败: ' + result.reason);
        console.log('  ' + (result.message || ''));
        if (result.dirty) for (const d of result.dirty) console.log('    未提交: ' + d);
        process.exitCode = 1;
      }
      const warn = result.warnings || {};
      if (warn.scope_overlaps && warn.scope_overlaps.length) {
        console.log('');
        console.log('WARN write_scope 与以下活跃任务重叠（可能是有意的，也可能撞车）:');
        for (const w of warn.scope_overlaps) console.log('  - ' + w.task_id + '（' + (w.title || '') + '）：' + w.overlaps.join(', '));
      }
      if (warn.shared_file_conflicts && warn.shared_file_conflicts.length) {
        console.log('');
        console.log('WARN 共享文件同时被多个活跃任务写（应单 owner）:');
        for (const c of warn.shared_file_conflicts) console.log('  - ' + c.file + ' ← ' + c.tasks.join(', '));
      }
    }
  });
}

// 第 7 项第 1 条：孤儿项目只诊断、不改数据。绝对路径形式的旧项目 legacy_path 会标出来，
// 但历史任务照常可读——「不再用于新任务」是 adopt/表单的事，不是删数据。
function doctorOrphanProjects() {
  const args = process.argv.slice(3);
  const jsonOut = args.indexOf('--json') >= 0;
  let report;
  try {
    report = S.orphanProjects(db, { registry: process.env.BUS_PROJECTS || undefined });
  } catch (error) {
    console.log(JSON.stringify({ ok: false, reason: 'orphan_scan_failed', message: String((error && error.message) || error) }, null, 2));
    process.exitCode = 1;
    return;
  }
  // default 是保留项目：store 的 next_step 是通用文案（会建议 adopt），但对 default 一定是 default_reserved。
  // 这里不改 store 的字段，只补一个 adoptable 布尔，免得把人指去做必然被拒的操作。
  const annotated = Object.assign({}, report, {
    orphans: report.orphans.map(function (o) { return Object.assign({}, o, { adoptable: o.project !== 'default' }); }),
  });
  if (jsonOut) { console.log(JSON.stringify(Object.assign({ ok: true }, annotated), null, 2)); return; }
  console.log('孤儿项目诊断（只读，不改任何数据）');
  console.log('registry: ' + report.registry_file);
  console.log('项目总数 ' + report.projects + ' · 孤儿 ' + report.orphans.length + ' · default 任务 ' + report.default_tasks);
  if (!report.orphans.length) { console.log('\n没有孤儿项目：tasks.project 全部在 registry 里。'); return; }
  for (const o of report.orphans) {
    console.log('');
    console.log('  ' + o.project + (o.legacy_path ? '  [legacy_path]' : ''));
    console.log('    任务 ' + o.tasks + '（active ' + o.active_tasks + '）· Token ' + o.tokens + ' · 可迁移: ' + (o.project === 'default' ? '否（default 是保留项目）' : '是'));
    console.log('    下一步: ' + (o.project === 'default'
      ? '保留项目：不提供迁移或删除；只允许查看与按统一归档计划归档 terminal 任务'
      : o.next_step));
  }
  if (report.registered_unused && report.registered_unused.length) console.log('\n已登记但没有任务的项目: ' + report.registered_unused.join(', '));
  console.log('\n提示: 迁移用 node bus/cli.mjs projects adopt --legacy <旧> --id <新> --path <绝对路径>');
}

// 第 4 项阶段 A：预算基线（只报告；"存在未归属用量"是基线事实，不是错误 → 退出码 0）
function doctorBudgetReadiness() {
  const jsonOut = process.argv.indexOf('--json') >= 0;
  const report = Archive.budgetReadiness(db, policy);
  if (jsonOut) { console.log(JSON.stringify(report, null, 2)); return; }
  const pct = function (v) { return v == null ? '—' : (v * 100).toFixed(1) + '%'; };
  console.log('预算基线 readiness（只读，不改任何配置）');
  console.log('  归属率（主口径·按量加权）: ' + pct(report.attribution_rate_tokens) + '  分母 ' + report.denominators.tokens + ' tokens');
  console.log('  归属率（辅口径·按行数）  : ' + pct(report.attribution_rate_rows) + '  分母 ' + report.denominators.rows + ' 行');
  console.log('  历史未归属（legacy_unattributed）: ' + report.legacy_unattributed.rows + ' 行（只上报，不回填 task_id）');
  console.log('  开关: daily_token_budget=' + JSON.stringify(report.switches.daily_token_budget) + ' · default_turn_reserve=' + JSON.stringify(report.switches.default_turn_reserve) + ' · 带任务预算的任务 ' + report.switches.task_budget_tasks + ' 个');
  console.log('  结论: ' + report.verdict);
}

function doctor() {
  const args = process.argv.slice(3);
  if (args.indexOf('--auth-readiness') >= 0) { doctorAuthReadiness(); return; }
  if (args.indexOf('--project-readiness') >= 0) { doctorProjectReadiness(); return; }
  if (args.indexOf('--probe-engine') >= 0) { doctorProbeEngine(); return; }
  if (args.indexOf('--budget-readiness') >= 0) { doctorBudgetReadiness(); return; }
  if (args.indexOf('--orphan-projects') >= 0) { doctorOrphanProjects(); return; }
  const jsonOut = args.indexOf('--json') >= 0;
  const homeAt = args.indexOf('--home');
  const rootAt = args.indexOf('--root');
  const options = {
    root: rootAt >= 0 ? args[rootAt + 1] : undefined,
    homeDir: homeAt >= 0 ? args[homeAt + 1] : undefined,
    port: process.env.AGENTBUS_PORT || undefined,
  };
  return runDoctor(options).then(function (report) {
    if (jsonOut) { console.log(JSON.stringify(report, null, 2)); } else {
      console.log('agentbus doctor  v' + report.version);
      for (const c of report.checks) {
        const tag = c.status === 'ok' ? 'OK  ' : c.status === 'warn' ? 'WARN' : 'FAIL';
        console.log('  [' + tag + '] ' + c.title + ' — ' + c.detail);
        if (c.fix) console.log('         修复: ' + c.fix);
      }
      console.log('');
      console.log('小计: ok=' + report.counts.ok + ' warn=' + report.counts.warn + ' fail=' + report.counts.fail + '（doctor 只诊断，不会自动修改任何东西）');
    }
    process.exitCode = report.exit_code;
  });
}

// agentbus init：建运行目录/库/registry + 配 MCP，每一步写 install-manifest.json。
async function init() {
  const args = process.argv.slice(3);
  const jsonOut = args.indexOf('--json') >= 0;
  const homeAt = args.indexOf('--home');
  const rootAt = args.indexOf('--root');
  const result = runInit({ root: rootAt >= 0 ? args[rootAt + 1] : undefined, homeDir: homeAt >= 0 ? args[homeAt + 1] : undefined });
  // 第 15 项第 10 条：init 写过配置的客户端必须重启才生效 → 逐项写 restart_required（看板会在 UI 里列出来）。
  {
    const written = (result.steps || []).filter(function (s) { return s.id === 'mcp' && s.result === 'written'; });
    if (written.length) {
      const LCmod = await import('./console-server.mjs');
      for (const step of written) {
        try { LCmod.markRestartRequired(step.client, 'mcp_config_written_by_init', { required_hash: fileDigest(step.path), file: result.paths.lifecycleFile }); }
        catch (error) { /* 标记失败不影响安装结果，但会在输出里看到缺项 */ }
      }
      if (args.indexOf('--json') < 0) console.log('已标记需要重启: ' + written.map(function (s) { return s.client; }).join(', ') + '（重启后自动清除）');
    }
  }
  if (jsonOut) { console.log(JSON.stringify(result, null, 2)); } else {
    console.log('agentbus init  v' + (result.version || readVersion()));
    for (const step of result.steps) {
      console.log('  [' + step.result + '] ' + step.id + ' → ' + (step.path || '—') + (step.backup ? '（备份 ' + step.backup + '）' : ''));
    }
    console.log('');
    console.log('install-manifest: ' + result.manifest_path);
    if (!result.steps.some(function (s) { return s.id === 'mcp' && s.result === 'written'; })) console.log('MCP 配置均已存在且启用，未改写。');
    const policyStep = result.steps.filter(function (s) { return s.id === 'policy'; })[0];
    if (policyStep && policyStep.result === 'missing') {
      console.log('');
      console.log('下一步：安装器不会替你编造调度策略 —— 请按 README「调度策略」创建 ' + policyStep.path + '，然后跑 agentbus doctor 确认全部 OK。');
    }
  }
  if (!result.ok) process.exitCode = 1;
}

// agentbus start：起看板并打印一次性登录链接（会话 token 只出现在终端）。
async function start() {
  const args = process.argv.slice(3);
  const portAt = args.indexOf('--port');
  const port = Number(portAt >= 0 ? args[portAt + 1] : (process.env.AGENTBUS_PORT || BOARD_PORT));
  const CS = await import('./console-server.mjs');
  const server = CS.startConsole({ port: port, actor: 'human' });
  const bound = server.address() && server.address().port || port;
  console.log('已启动: http://127.0.0.1:' + bound + '/');
  if (server.agentBus.bootstrap.token) {
    console.log('一次性登录链接（仅本次启动有效）: http://127.0.0.1:' + bound + '/?token=' + server.agentBus.bootstrap.token);
  }
  const stop = function () { try { server.close(function () { process.exit(0); }); } catch (e) { process.exit(0); } };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
  return new Promise(function () { /* 保持进程存活直到收到信号 */ });
}

function version() {
  const jsonOut = process.argv.indexOf('--json') >= 0;
  const pkg = readPackage();
  if (jsonOut) { console.log(JSON.stringify({ name: pkg.name, version: pkg.version, node: process.versions.node }, null, 2)); return; }
  console.log((pkg.name || 'agentbus') + ' ' + pkg.version);
}
// agentbus uninstall：只动 install-manifest 记录过的东西；文件被用户改过就停手。
// 默认保留数据库/策略/registry（数据是用户的），只有 --purge-data + --yes 才删。
export function runUninstall(options) {
  const o = options || {};
  const paths = installPaths(o);
  const manifest = readManifest(paths.manifestPath);
  if (!manifest) {
    return { ok: false, reason: 'no_manifest', message: '没有 install-manifest.json：不确定哪些是 AgentBus 装的，拒绝猜测，请人工核对后清理' };
  }
  const removed = [], blocked = [], kept = [];
  const dataPaths = [paths.dbPath, paths.dbPath + '-wal', paths.dbPath + '-shm', paths.registryPath, paths.policyPath, paths.manifestPath];
  // 先做确认检查：被拒绝的调用不能有任何副作用（否则第二次调用会看到"文件已被改过"而误判）。
  if (o.purgeData === true && o.confirm !== true) {
    return { ok: false, reason: 'confirm_required', message: '--purge-data 会删除数据库与策略文件，必须再加 --yes 明确确认',
      would_delete: dataPaths.filter(function (p) { return fs.existsSync(p); }), removed: removed, blocked: blocked };
  }
  const profiles = AdminConfig.readMcpProfiles({ homeDir: paths.homeDir }) || [];
  for (const profile of profiles) {
    const file = profile.path;
    if (!file) continue;
    const rec = manifest.files[file];
    if (!rec || rec.kind !== 'mcp-config') continue;   // manifest 没记过的文件一律不碰
    const current = fileDigest(file);
    if (rec.sha256 && current && current !== rec.sha256) {
      blocked.push({ path: file, client: profile.id, reason: 'modified_since_install',
        detail: 'sha256 与安装时不一致（文件被改过），按约定不覆盖整份配置；请手工删除其中的 AgentBus managed block' });
      continue;
    }
    try {
      const saved = AdminConfig.saveMcpProfile(profile.id, { enabled: false, agent: profile.agent }, { homeDir: paths.homeDir });
      removed.push({ path: (saved.profile && saved.profile.path) || file, client: profile.id, action: 'mcp_managed_block_removed', backup: saved.backup || null });
    } catch (error) {
      blocked.push({ path: file, client: profile.id, reason: 'remove_failed', detail: String((error && error.message) || error) });
    }
  }
  if (o.purgeData === true) {
    for (const p of dataPaths) {
      if (!fs.existsSync(p)) continue;
      try { fs.rmSync(p); removed.push({ path: p, action: 'purged' }); }
      catch (error) { blocked.push({ path: p, reason: 'purge_failed', detail: String((error && error.message) || error) }); }
    }
  } else {
    for (const p of dataPaths) if (fs.existsSync(p)) kept.push(p);
  }
  return { ok: blocked.length === 0, reason: blocked.length ? 'partial' : null, removed: removed, blocked: blocked,
    kept_data: kept, manifest_path: paths.manifestPath };
}
function uninstall() {
  const args = process.argv.slice(3);
  const jsonOut = args.indexOf('--json') >= 0;
  const homeAt = args.indexOf('--home');
  const rootAt = args.indexOf('--root');
  const result = runUninstall({
    root: rootAt >= 0 ? args[rootAt + 1] : undefined,
    homeDir: homeAt >= 0 ? args[homeAt + 1] : undefined,
    purgeData: args.indexOf('--purge-data') >= 0,
    confirm: args.indexOf('--yes') >= 0,
  });
  if (jsonOut) { console.log(JSON.stringify(result, null, 2)); } else {
    console.log('agentbus uninstall');
    for (const item of result.removed) console.log('  [removed] ' + item.action + ' → ' + item.path + (item.backup ? '（备份 ' + item.backup + '）' : ''));
    for (const item of result.blocked) console.log('  [BLOCKED] ' + item.path + ' — ' + item.reason + '：' + (item.detail || ''));
    if (result.would_delete) { console.log(''); console.log('--purge-data 将删除以下文件（需再加 --yes）：'); for (const p of result.would_delete) console.log('  - ' + p); }
    if (result.kept_data && result.kept_data.length) { console.log(''); console.log('默认保留（数据是你的）：'); for (const p of result.kept_data) console.log('  - ' + p); }
    console.log('');
    console.log(result.ok ? '完成：AgentBus 的 managed block 已移除。' : '未完成：有文件被拒删，见上面的 BLOCKED。');
  }
  if (!result.ok) process.exitCode = 1;
}

async function releaseCheck() {
  const args = process.argv.slice(3);
  const mod = await import('./release-check.mjs');
  const report = await mod.runReleaseCheck({ skipSmoke: args.indexOf('--skip-smoke') >= 0 });
  if (args.indexOf('--json') >= 0) { console.log(JSON.stringify(report, null, 2)); } else {
    console.log('agentbus release-check  v' + report.version);
    for (const step of report.steps) {
      const tag = step.status === 'ok' ? 'OK  ' : step.status === 'warn' ? 'WARN' : step.status === 'skip' ? 'SKIP' : 'FAIL';
      console.log('  [' + tag + '] ' + step.title + ' — ' + step.detail);
      if (step.fix) console.log('         修复: ' + step.fix);
    }
    console.log('');
    console.log(report.ok ? '发布检查通过。' : '发布检查未通过：见 FAIL 项。');
  }
  process.exitCode = report.ok ? 0 : 1;
}
export { SHARED_FILES, scopeOverlap, sharedFileConflicts, activeTasks, runWorktreeCreate, runWorktreeList, runWorktreeRemove };

const TABLE = {
  status: status, board: board, agents: agents, cost: cost,
  projects: projects, 'add-project': addProject, 'init-project': initProject,
  credentials: credentials, archive: archive, doctor: doctor, escalation: escalation,
  init: init, start: lifecycleStart, version: version, uninstall: uninstall, 'release-check': releaseCheck,
  lifecycle: lifecycleStatus, stop: lifecycleStop, restart: lifecycleRestart, worktree: worktreeCmd,
  'archive-retention': archiveRetention, logs: logs, merge: merge,
};

// 有的子命令要做真实 git 合并（async），统一按 promise 处理，失败不吞。
if (invokedDirectly() && TABLE[cmd]) {
  Promise.resolve()
    .then(function () { return TABLE[cmd](); })
    .catch(function (error) {
      process.stderr.write('cli ' + cmd + ' 失败: ' + String((error && error.stack) || error) + '\n');
      process.exitCode = 1;
    });
}
else if (invokedDirectly()) console.log('用法: node bus/cli.mjs [init|doctor|start|version|status|board|agents|cost|projects|add-project|init-project|credentials|archive|doctor --auth-readiness|escalation list|release <task_id>|archive-retention [--confirm <hash>]|logs inventory]');
