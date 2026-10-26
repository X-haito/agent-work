// 项目注册表读取（第 8 项）：**只读文件，不依赖 store**。
// 存在的意义就是解开 admin-config ↔ store 的循环依赖：评审指派需要"项目允许哪些 agent"，
// 而那条信息只在 projects.json / project.json 里，不值得为了它把 store 拉进来。
import fs from 'node:fs';
import path from 'node:path';

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
