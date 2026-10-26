// 项目注册表读取（第 8 项）：**只读文件，不依赖 store**。
// 存在的意义就是解开 admin-config ↔ store 的循环依赖：评审指派需要"项目允许哪些 agent"，
// 而那条信息只在 projects.json / project.json 里，不值得为了它把 store 拉进来。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// 默认 registry 就是本模块旁边的 projects.json（不 import store，避免回到循环依赖）。
const BUS_DIR = path.dirname(fileURLToPath(import.meta.url));
export const DEFAULT_REGISTRY_FILE = path.join(BUS_DIR, 'projects.json');
export function registryFile(explicit) {
  return explicit || process.env.BUS_PROJECTS || DEFAULT_REGISTRY_FILE;
}

export const REGISTRY_VERSION = 1;

function asArray(value) {
  if (Array.isArray(value)) return value.map(function (x) { return String(x); }).filter(Boolean);
  if (typeof value === 'string') return value.split(',').map(function (x) { return x.trim(); }).filter(Boolean);
  return [];
}

// 读 registry：任何异常都退化成空表（评审指派不能因为配置文件坏了就崩），但把原因带出来。
export function readRegistry(file) {
  const target = file ? String(file) : null;
  if (!target) return { projects: {}, file: null, ok: false, reason: 'no_registry_path' };
  let raw = null;
  try { raw = JSON.parse(fs.readFileSync(target, 'utf8')); }
  catch (error) {
    return { projects: {}, file: target, ok: false, reason: fs.existsSync(target) ? 'registry_unreadable' : 'registry_missing' };
  }
  const projects = raw && typeof raw.projects === 'object' && raw.projects ? raw.projects : {};
  return { projects: projects, file: target, ok: true, reason: null };
}

// 读项目的 project.json（可选）：返回 {ok, manifest, reason}，不抛。
export function readProjectManifest(dir) {
  if (!dir) return { ok: false, reason: 'no_project_path', manifest: null };
  const file = path.join(String(dir), 'project.json');
  if (!fs.existsSync(file)) return { ok: false, reason: 'manifest_missing', manifest: null, file: file };
  try {
    const manifest = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!manifest || typeof manifest !== 'object') return { ok: false, reason: 'manifest_not_object', manifest: null, file: file };
    return { ok: true, reason: null, manifest: manifest, file: file };
  } catch (error) {
    return { ok: false, reason: 'manifest_invalid_json', manifest: null, file: file };
  }
}

// 项目声明的 agent 列表：project.json 优先（可热更新），其次 registry 条目里的 agents。
export function projectAgentIds(entry, manifest) {
  const fromManifest = asArray(manifest && (manifest.agents || manifest.agent_ids));
  if (fromManifest.length) return fromManifest;
  return asArray(entry && (entry.agents || entry.agent_ids));
}

// 项目资格解析（第 8 项第 2 条）：pool = policy agents ∩ project agents ∩ online − owner − lead。
// 返回 {eligible, reason, detail}：reason 非空表示"没有合格候选"，调用方应保留 pending 并升级 Human。
export function eligibleAgents(input) {
  const o = input || {};
  const policy = o.policy || {};
  const task = o.task || {};
  const project = String(task.project || '');
  const registry = o.registry || { projects: {}, ok: true };
  const online = asArray(o.online);
  const lead = policy.lead || null;
  const configured = Object.keys(policy.agents || {});

  if (!registry.ok) return { eligible: [], reason: 'registry_unavailable', detail: registry.reason || null, project: project };
  const entry = (registry.projects || {})[project] || null;
  if (!entry) return { eligible: [], reason: 'project_unregistered', detail: '项目未在 registry 登记: ' + project, project: project };

  const manifest = readProjectManifest(entry.path).manifest;
  const projectAgents = projectAgentIds(entry, manifest);
  if (!projectAgents.length) return { eligible: [], reason: 'project_agents_empty', detail: '项目没有声明参与 Agent: ' + project, project: project };
  if (!online.length) return { eligible: [], reason: 'no_online_worker', detail: '当前没有在线 Worker', project: project };

  const excluded = [];
  const eligible = [];
  for (const agent of projectAgents) {
    if (agent === 'human') { excluded.push({ agent: agent, why: 'human' }); continue; }
    if (lead && agent === lead) { excluded.push({ agent: agent, why: 'lead' }); continue; }
    if (task.owner && agent === task.owner) { excluded.push({ agent: agent, why: 'owner' }); continue; }
    if (configured.length && configured.indexOf(agent) < 0) { excluded.push({ agent: agent, why: 'not_in_policy' }); continue; }
    if (online.indexOf(agent) < 0) { excluded.push({ agent: agent, why: 'offline' }); continue; }
    eligible.push(agent);
  }
  if (!eligible.length) return { eligible: [], reason: 'no_eligible_candidate', detail: '项目内的 Agent 都被排除（owner/lead/离线/未在策略登记）', excluded: excluded, project: project };
  return { eligible: eligible, reason: null, excluded: excluded, project: project, project_agents: projectAgents };
}

// ---------------------------------------------------------------- 第 9 项：上线门禁
// 项目 registry 的 readiness 审计。设计目标是"一次列出所有不合格项目"，而不是遇到第一个就抛。
// 分级：
//   error   —— 现在就会让派活/评审坏掉：registry 不可读或 schema 错、**有 active 任务的项目没登记**、
//              登记的路径不是绝对路径或不存在、声明了 policy 里不存在的 agent、项目没有潜在 reviewer
//              （非 Lead、非 owner —— 没有它，peer 评审会长期 pending）。
//   warning —— 现在不致命，但迟早要补：项目没声明任何 agent（等真有任务派过来就会没有 reviewer）。
import fsMod from 'node:fs';

const ACTIVE = ['open', 'proposed', 'claimed', 'in_progress', 'review'];

function activeProjects(db) {
  const out = new Map();
  let rows = [];
  try {
    rows = db.prepare('SELECT project, COUNT(*) AS c FROM tasks WHERE status IN (' + ACTIVE.map(function () { return '?'; }).join(',') + ') GROUP BY project').all(...ACTIVE);
  } catch (error) { rows = []; }
  for (const row of rows) out.set(String(row.project || ''), Number(row.c));
  return out;
}

// 潜在 reviewer：项目声明 ∩ policy agents ∩ 在线，且不是 Lead、不是 owner。
// 与 peerCandidateReport 同一口径（第 8 项），保证"门禁说有人"和"指派时真有人"是同一件事。
function reviewerAvailability(policy, projectAgents, online, owner) {
  const lead = policy.lead || null;
  const configured = Object.keys(policy.agents || {});
  const pool = projectAgents.filter(function (a) {
    return a !== 'human' && a !== lead && a !== owner &&
      (configured.length ? configured.indexOf(a) >= 0 : true) &&
      (online.length ? online.indexOf(a) >= 0 : true);
  });
  return pool;
}

export function auditProjects(db, policy, options) {
  const o = options || {};
  const registry = o.registry || readRegistry(registryFile(o.file));
  const online = Array.isArray(o.online) ? o.online : null;
  const projects = [];
  const findings = [];
  const push = function (level, project, code, message, fix) {
    findings.push({ level: level, project: project, code: code, message: message, fix: fix || null });
  };

  // 1) registry 本身。**空安装不是错误**：刚跑完 init、还没有任何任务时，没有 registry 是正常的；
  //    一旦库里有任务（哪怕是已完成的），"找不到 registry"就意味着派活/评审没有归属信息可依 → 升级为 error。
  const taskCount = (function () { try { return Number(db.prepare('SELECT COUNT(*) AS c FROM tasks').get().c) || 0; } catch (error) { return 0; } })();
  if (!registry.ok) {
    push(taskCount > 0 ? 'error' : 'warning', null, registry.reason || 'registry_unavailable',
      '项目 registry 不可用（' + (registry.reason || 'unknown') + '）：' + String(registry.file || '(未配置路径)'),
      'node bus/cli.mjs projects adopt <project-id>  或修正 ' + String(registry.file || 'bus/projects.json'));
  }
  const regProjects = (registry.projects || {});
  if (registry.ok && (typeof regProjects !== 'object' || Array.isArray(regProjects))) {
    push('error', null, 'registry_schema', 'registry.projects 必须是对象', '把 projects 写成 { "<id>": { "path": "<绝对路径>" } }');
  }

  const actives = o.activeProjects instanceof Map ? o.activeProjects : activeProjects(db);
  const schemaKeys = new Set();
  for (const id of Object.keys(regProjects)) {
    const entry = regProjects[id] || {};
    schemaKeys.add(id);
    const projectFindings = [];
    const record = { id: id, registered: true, path: entry.path || null, agents: projectAgentIds(entry, null), status: 'ok', findings: projectFindings };
    projects.push(record);
    const before = findings.length;

    if (typeof entry !== 'object') {
      push('error', id, 'entry_not_object', '项目条目必须是对象', '写成 { "path": "<绝对路径>", "agents": ["<agent-id>"] }');
    }
    // 路径：必须绝对且存在（相对路径会让 worktree/校验器解析到意想不到的地方）
    if (!entry.path || typeof entry.path !== 'string') {
      push('error', id, 'path_missing', '项目没写 path', 'node bus/cli.mjs projects adopt ' + id);
    } else if (!path.isAbsolute(entry.path)) {
      push('error', id, 'path_not_absolute', 'path 不是绝对路径：' + entry.path, '改成绝对路径（' + path.resolve(entry.path) + '）');
    } else if (!fsMod.existsSync(entry.path)) {
      push('error', id, 'path_not_found', 'path 不存在：' + entry.path, '创建该目录，或把项目迁到现有路径后重新 adopt');
    }
    // 项目当前有没有 active 任务，决定下面几项是 error 还是 warning：
    // 没有在跑的任务时，"声明了 policy 以外的 agent"只是隐患，不是当下的破坏。
    const activeCount = actives.get(id) || 0;
    record.active_tasks = activeCount;
    // project.json 里声明的 agent（可选）
    const manifestInfo = entry.path ? readProjectManifest(entry.path) : { ok: false, manifest: null };
    const declared = projectAgentIds(entry, manifestInfo.manifest);
    record.agents = declared;
    const configured = Object.keys((policy && policy.agents) || {});
    const unknown = declared.filter(function (a) { return a !== 'human' && configured.indexOf(a) < 0; });
    if (unknown.length) {
      push(activeCount > 0 ? 'error' : 'warning', id, 'agent_not_in_policy', '声明了 policy 里不存在的 agent：' + unknown.join(', '),
        '在 policy.agents 里登记 ' + unknown.join(' / ') + '，或从项目声明里删掉');
    }
    // 潜在 reviewer：只在项目有 active 任务时才强制（没有任务时"没人可评审"不是问题）
    const owners = (function () {
      try { return db.prepare("SELECT DISTINCT owner FROM tasks WHERE project = ? AND status IN ('claimed','in_progress','review') AND owner IS NOT NULL").all(id).map(function (r) { return r.owner; }); }
      catch (error) { return []; }
    })();
    const candidates = [];
    for (const owner of (owners.length ? owners : [null])) {
      const available = reviewerAvailability(policy || {}, declared, online || [], owner);
      candidates.push({ owner: owner, reviewers: available });
    }
    record.reviewers = candidates;
    if (activeCount > 0 && !candidates.some(function (c) { return c.reviewers.length > 0; })) {
      push('error', id, 'no_potential_reviewer',
        '项目有 ' + activeCount + ' 个 active 任务，但没有"非 Lead、非 owner"的潜在 reviewer（声明 ' + (declared.length ? declared.join(',') : '无') + '）',
        'node bus/cli.mjs projects adopt ' + id + ' --agents <非 Lead 的 agent>（或在 project.json 里声明 agents）');
    }
    if (activeCount === 0 && !declared.length) {
      push('warning', id, 'agents_empty', '项目没声明 agents：现在没有 active 任务，但一旦有任务就会没有 reviewer',
        'node bus/cli.mjs projects adopt ' + id + ' --agents <agent-id>');
    }
    record.status = findings.length > before ? (findings.slice(before).some(function (f) { return f.level === 'error'; }) ? 'error' : 'warning') : 'ok';
  }

  // 2) 有 active 任务但没登记的项目：这正是"派了活却没人评审"的根源
  for (const [id, count] of actives) {
    if (id && schemaKeys.has(id)) continue;
    push('error', id || null, 'active_project_unregistered',
      '项目 ' + (id || '(空)') + ' 有 ' + count + ' 个 active 任务，但没在 registry 登记',
      'node bus/cli.mjs projects adopt ' + (id || '<project-id>'));
  }

  const errors = findings.filter(function (f) { return f.level === 'error'; });
  const warnings = findings.filter(function (f) { return f.level === 'warning'; });
  return {
    ok: errors.length === 0,
    file: registry.file || null,
    checked_at: new Date().toISOString(),
    projects: projects,
    findings: findings,
    errors: errors,
    warnings: warnings,
    totals: { projects: projects.length, errors: errors.length, warnings: warnings.length },
    fixes: errors.map(function (f) { return f.fix; }).filter(Boolean),
    online_agents: online,
  };
}
