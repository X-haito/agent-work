// 管理控制台配置层：只处理白名单字段和已知 MCP 目标。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { BUS_DIR, POLICY_PATH } from './store.mjs';
import { KINDS } from './redline.mjs';
import { validateValidators, verifierCwd } from './verifier.mjs';
import { normalizeGrant, normalizeNetworkPolicy } from './network-policy.mjs';

const AGENT_RE = /^[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._-]*$/i;
const AUTONOMY = ['off', 'propose', 'auto'];
const COSTS = ['mechanical', 'tests', 'docs', 'standard', 'architectural', 'interface'];
const PERMISSIONS = ['dispatch', 'accept', 'merge', 'reassign'];
export const NETWORK_GRANT_LIMIT = 8;
const DSH_MCP_BEGIN = '# >>> agentbus managed entry >>>';
const DSH_MCP_END = '# <<< agentbus managed entry <<<';

function fail(message) {
  const e = new Error(message);
  e.statusCode = 400;
  throw e;
}
function bool(v, name) {
  if (typeof v !== 'boolean') fail(name + ' 必须是 true 或 false');
  return v;
}

function integer(v, name, min, max, nullable) {
  if (nullable && (v === null || v === '')) return null;
  const n = Number(v);
  if (!Number.isInteger(n) || n < min || n > max) fail(name + ' 必须是 ' + min + '–' + max + ' 的整数');
  return n;
}

function strings(v, name, allowed) {
  if (!Array.isArray(v)) fail(name + ' 必须是数组');
  const out = [];
  for (const item of v) {
    if (typeof item !== 'string' || !item.trim()) fail(name + ' 包含无效值');
    const s = item.trim();
    if (allowed && allowed.indexOf(s) < 0) fail(name + ' 包含不允许的值: ' + s);
    if (out.indexOf(s) < 0) out.push(s);
  }
  return out;
}

// policy.network：default 固定 deny；local_services 只放本地端口的精确白名单。
function networkPolicy(input) {
  const normalized = normalizeNetworkPolicy(input);
  if (!normalized.ok) fail('network 无效: ' + normalized.reason);
  return normalized.network;
}

// 任务字段 network_grants：[{ protocol, host, ports, purpose }]，逐项按网络白名单规范校验。
export function validateNetworkGrants(input) {
  if (input == null) return null;
  if (!Array.isArray(input)) fail('network_grants 必须是数组');
  if (input.length > NETWORK_GRANT_LIMIT) fail('network_grants 最多 ' + NETWORK_GRANT_LIMIT + ' 项');
  const out = [];
  for (const raw of input) {
    const normalized = normalizeGrant(raw);
    if (!normalized.ok) fail('network_grants 无效: ' + normalized.reason);
    out.push(normalized.grant);
  }
  return out;
}

function agentId(v, name, allowHuman) {
  if (allowHuman && v === 'human') return v;
  if (typeof v !== 'string' || !AGENT_RE.test(v)) fail(name + ' 不是合法 Agent ID');
  return v;
}

export function validatePolicy(input, options) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) fail('策略必须是对象');
  const rawAgents = input.agents;
  if (!rawAgents || typeof rawAgents !== 'object' || Array.isArray(rawAgents) || !Object.keys(rawAgents).length) {
    fail('至少需要一个 Agent');
  }

  const agents = {};
  for (const id of Object.keys(rawAgents)) {
    agentId(id, 'Agent ID', false);
    const a = rawAgents[id] || {};
    const autonomy = String(a.autonomy || 'off');
    if (AUTONOMY.indexOf(autonomy) < 0) fail(id + '.autonomy 无效');
    const targets = strings(a.may_dispatch_to || [], id + '.may_dispatch_to');
    for (const target of targets) {
      if (target !== '*' && !Object.prototype.hasOwnProperty.call(rawAgents, target)) fail(id + ' 的派发目标不存在: ' + target);
    }
    agents[id] = {
      autonomy: autonomy,
      may_dispatch_to: targets,
      max_open_from_agents: integer(a.max_open_from_agents == null ? 0 : a.max_open_from_agents, id + '.max_open_from_agents', 0, 10),
      max_concurrent: integer(a.max_concurrent == null ? 1 : a.max_concurrent, id + '.max_concurrent', 1, 5),
      capabilities: strings(a.capabilities || [], id + '.capabilities'),
    };
    if (a.scope_allowlist != null) agents[id].scope_allowlist = strings(a.scope_allowlist, id + '.scope_allowlist');
  }

  const lead = agentId(input.lead, 'lead', true);
  if (lead !== 'human' && !agents[lead]) fail('Lead 不在 Agent 列表中: ' + lead);
  const allowedPrincipals = Object.keys(agents).concat(['human']);
  const permissions = {};
  for (const key of PERMISSIONS) permissions[key] = strings((input.permissions || {})[key] || [], 'permissions.' + key, allowedPrincipals);
  if (options && options.syncLeadPermissions) {
    permissions.dispatch = lead === 'human' ? ['human'] : [lead];
    permissions.accept = lead === 'human' ? ['human'] : [lead, 'human'];
    permissions.merge = ['human'];
    permissions.reassign = lead === 'human' ? ['human'] : [lead];
  }

  const g = input.global || {};
  const e = input.economics || {};
  // redline 决定哪些红线必须由人类批；漏掉它会让 savePolicy 把用户改过的白名单抹掉
  const rl = input.redline || {};
  return {
    lead: lead,
    redline: {
      human_only: strings(rl.human_only == null ? KINDS.slice() : rl.human_only, 'redline.human_only', KINDS),
    },
    permissions: permissions,
    global: {
      dispatch_enabled: bool(g.dispatch_enabled !== false, 'global.dispatch_enabled'),
      max_dispatch_depth: integer(g.max_dispatch_depth == null ? 2 : g.max_dispatch_depth, 'global.max_dispatch_depth', 1, 5),
      max_chain_len: integer(g.max_chain_len == null ? 3 : g.max_chain_len, 'global.max_chain_len', 1, 10),
      rate_per_agent_per_hour: integer(g.rate_per_agent_per_hour == null ? 20 : g.rate_per_agent_per_hour, 'global.rate_per_agent_per_hour', 1, 1000),
      require_credentials: bool(g.require_credentials === true, 'global.require_credentials'),
    },
    network: networkPolicy(input.network),
    economics: {
      lead_may_read_files: bool(e.lead_may_read_files === true, 'economics.lead_may_read_files'),
      lead_may_write_code: bool(e.lead_may_write_code === true, 'economics.lead_may_write_code'),
      lead_wake_on: strings(e.lead_wake_on || [], 'economics.lead_wake_on'),
      report_max_lines: integer(e.report_max_lines == null ? 40 : e.report_max_lines, 'economics.report_max_lines', 10, 500),
      report_no_raw_diff: bool(e.report_no_raw_diff !== false, 'economics.report_no_raw_diff'),
      auto_accept: strings(e.auto_accept || [], 'economics.auto_accept', COSTS),
      require_verify_cmd: bool(e.require_verify_cmd === undefined ? false : e.require_verify_cmd, 'economics.require_verify_cmd'),
      peer_review: strings(e.peer_review || [], 'economics.peer_review', COSTS),
      lead_review: strings(e.lead_review || [], 'economics.lead_review', COSTS),
      max_rounds_per_task: integer(e.max_rounds_per_task == null ? 2 : e.max_rounds_per_task, 'economics.max_rounds_per_task', 1, 10),
      max_changed_files: integer(e.max_changed_files == null ? 20 : e.max_changed_files, 'economics.max_changed_files', 1, 10000),
      max_subagents: integer(e.max_subagents == null ? 0 : e.max_subagents, 'economics.max_subagents', 0, 5),
      review_timeout_min: integer(e.review_timeout_min == null ? 30 : e.review_timeout_min, 'economics.review_timeout_min', 1, 10080),
      daily_token_budget: integer(e.daily_token_budget, 'economics.daily_token_budget', 1, 1000000000, true),
    },
    agents: agents,
  };
}

export function atomicWrite(file, content) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backup = file + '.bak-' + stamp;
  const temp = file + '.tmp-' + process.pid + '-' + Date.now();
  fs.writeFileSync(temp, content, { encoding: 'utf8', mode: 0o600 });
  let hadFile = false;
  try {
    hadFile = fs.existsSync(file);
    if (hadFile) fs.renameSync(file, backup);
    fs.renameSync(temp, file);
    return { path: file, backup: hadFile ? backup : null };
  } catch (e) {
    try { if (fs.existsSync(temp)) fs.unlinkSync(temp); } catch (ignore) {}
    try { if (hadFile && !fs.existsSync(file) && fs.existsSync(backup)) fs.renameSync(backup, file); } catch (ignore) {}
    throw e;
  }
}

function readNetworkSection(file) {
  try {
    const json = JSON.parse(fs.readFileSync(file, 'utf8'));
    return json && typeof json === 'object' && !Array.isArray(json) ? json.network : null;
  } catch (error) { return null; }
}

export function savePolicy(input, options) {
  const opts = options || {};
  const file = opts.path || POLICY_PATH;
  // 调用方（例如看板策略页）可能不提交 network 段：沿用文件里的旧值，否则保存策略会把白名单抹掉。
  let payload = input;
  if (input && typeof input === 'object' && !Array.isArray(input) && input.network == null) {
    const previous = readNetworkSection(file);
    if (previous != null) payload = Object.assign({}, input, { network: previous });
  }
  const policy = validatePolicy(payload, opts);
  const result = atomicWrite(file, JSON.stringify(policy, null, 2) + '\n');
  return { policy: policy, backup: result.backup };
}

const PROJECT_ID_RE = /^[a-z0-9][a-z0-9._-]{1,40}$/i;
const PROJECT_TOPOLOGIES = ['clone-per-agent', 'shared', 'isolated'];

function projectOptions(options) {
  const opts = options || {};
  return { registry: opts.path || path.join(BUS_DIR, 'projects.json'),
    workspaceRoot: opts.workspaceRoot || path.resolve(BUS_DIR, '..', 'workspaces') };
}

export function readProjectsRegistry(options) {
  const file = projectOptions(options).registry;
  let registry;
  try { registry = JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (e) {
    if (e.code === 'ENOENT') return { projects: {} };
    fail('项目登记文件无法读取或 JSON 无效: ' + e.message);
  }
  if (!registry || typeof registry !== 'object' || Array.isArray(registry) ||
      !registry.projects || typeof registry.projects !== 'object' || Array.isArray(registry.projects)) {
    fail('项目登记文件必须包含 projects 对象');
  }
  return registry;
}

function projectId(id) {
  if (typeof id !== 'string' || !PROJECT_ID_RE.test(id)) fail('项目 id 必须为 2–41 位字母、数字、点、下划线或连字符，并以字母或数字开头');
  return id;
}

function projectError(message, status) {
  const error = new Error(message);
  error.statusCode = status;
  throw error;
}

function withProjectRegistry(options, action) {
  const opts = projectOptions(options);
  fs.mkdirSync(path.dirname(opts.registry), { recursive: true });
  const lockPath = opts.registry + '.lock';
  let lock;
  try { lock = fs.openSync(lockPath, 'wx', 0o600); }
  catch (e) {
    if (e.code === 'EEXIST') projectError('项目登记正在更新，请稍后重试', 409);
    throw e;
  }
  try { return action(readProjectsRegistry(options), opts); }
  finally { fs.closeSync(lock); fs.unlinkSync(lockPath); }
}

export function validateProjectValidators(input) { return validateValidators(input); }

export function createProject(input, options) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) fail('项目必须是对象');
  const id = projectId(input.id);
  const explicitPath = input.path !== undefined && !(typeof input.path === 'string' && !input.path.trim());
  const target = explicitPath ? input.path : path.resolve(projectOptions(options).workspaceRoot, id);
  if (typeof target !== 'string' || !path.isAbsolute(target)) fail('项目 path 必须是绝对路径');
  if (explicitPath) {
    let directory;
    try { directory = fs.statSync(target); } catch (e) { fail('项目 path 目录不存在或无法访问'); }
    if (!directory.isDirectory()) fail('项目 path 必须是已存在的目录');
  }
  const topology = input.topology === undefined ? 'clone-per-agent' : input.topology;
  if (PROJECT_TOPOLOGIES.indexOf(topology) < 0) fail('项目 topology 必须为 clone-per-agent、shared 或 isolated');
  const agents = input.agents === undefined ? [] : input.agents;
  if (!Array.isArray(agents) || agents.some(function (agent) { return typeof agent !== 'string' || !AGENT_RE.test(agent); })) {
    fail('项目 agents 必须为形如 codex/main 的字符串数组');
  }
  const validators = validateProjectValidators(input.validators);
  if (explicitPath) for (const spec of Object.values(validators)) verifierCwd(spec, target);
  const project = { path: path.normalize(target), topology, agents: agents.slice() };
  return withProjectRegistry(options, function (registry, opts) {
    if (Object.keys(registry.projects).some(function (existing) { return existing.toLowerCase() === id.toLowerCase(); })) {
      projectError('项目 id 已登记: ' + id, 409);
    }
    const configFile = path.join(project.path, 'project.json');
    atomicWrite(configFile, JSON.stringify({ id, root: project.path, topology, agents: project.agents, validators, managed_by: 'agentbus' }, null, 2) + '\n');
    registry.projects[id] = project;
    atomicWrite(opts.registry, JSON.stringify(registry, null, 2) + '\n');
    return { ok: true, id, project, config_path: configFile };
  });
}

export function saveProjectValidators(id, validators, options) {
  projectId(id);
  const clean = validateProjectValidators(validators);
  return withProjectRegistry(options, function (registry) {
    const key = Object.keys(registry.projects).find(existing => existing.toLowerCase() === id.toLowerCase());
    if (!key) projectError('项目未登记: ' + id, 404);
    const target = registry.projects[key].path;
    if (typeof target !== 'string' || !path.isAbsolute(target)) fail('登记项目路径无效');
    for (const spec of Object.values(clean)) verifierCwd(spec, target);
    const configFile = path.join(target, 'project.json');
    let config;
    try { config = JSON.parse(fs.readFileSync(configFile,'utf8')); } catch (error) { fail('无法读取项目配置: '+error.message); }
    const result = atomicWrite(configFile,JSON.stringify({...config,validators:clean},null,2)+String.fromCharCode(10));
    return {ok:true,id:key,validators:clean,config_path:configFile,backup:result.backup};
  });
}

export function deleteProject(id, options) {
  projectId(id);
  if (id.toLowerCase() === 'default') fail('不能删除 default 项目');
  return withProjectRegistry(options, function (registry, opts) {
    const key = Object.keys(registry.projects).find(function (existing) { return existing.toLowerCase() === id.toLowerCase(); });
    if (!key) projectError('项目未登记: ' + id, 404);
    const project = registry.projects[key];
    const configFile = project && typeof project.path === 'string' && path.isAbsolute(project.path) ? path.join(project.path, 'project.json') : null;
    let generated = false;
    if (configFile && fs.existsSync(configFile)) {
      try {
        const config = JSON.parse(fs.readFileSync(configFile, 'utf8'));
        generated = config.managed_by === 'agentbus' && config.id === key && path.resolve(config.root || '') === path.resolve(project.path);
      } catch (e) {}
    }
    delete registry.projects[key];
    atomicWrite(opts.registry, JSON.stringify(registry, null, 2) + '\n');
    if (generated) fs.unlinkSync(configFile);
    return { ok: true };
  });
}

function targetPaths(homeDir) {
  const home = homeDir || os.homedir();
  return {
    codex: path.join(process.env.CODEX_HOME || path.join(home, '.codex'), 'config.toml'),
    claude: path.join(home, '.claude.json'),
    // Home patch applies after every profile layer, so one entry covers Desktop and headless runs.
    dsh: path.join(home, '.dsh', 'cordis.patch.yml'),
  };
}

function parseJsonString(raw) {
  try { return JSON.parse(raw); } catch (e) { return null; }
}

function codexEntry(file) {
  if (!fs.existsSync(file)) return { enabled: false, command: 'node', args: [] };
  const text = fs.readFileSync(file, 'utf8');
  const lines = text.split(/\r?\n/);
  let active = false;
  const entry = { enabled: false, command: 'node', args: [] };
  for (const line of lines) {
    const h = line.trim().match(/^\[([^\]]+)\]$/);
    if (h) { active = h[1] === 'mcp_servers.agentbus'; if (active) entry.enabled = true; continue; }
    if (!active) continue;
    const command = line.match(/^\s*command\s*=\s*("(?:[^"\\]|\\.)*")\s*$/);
    if (command) entry.command = parseJsonString(command[1]) || 'node';
    const args = line.match(/^\s*args\s*=\s*(\[.*\])\s*$/);
    if (args) entry.args = parseJsonString(args[1]) || [];
  }
  return entry;
}

function claudeEntry(file) {
  if (!fs.existsSync(file)) return { enabled: false, command: 'node', args: [] };
  const json = JSON.parse(fs.readFileSync(file, 'utf8'));
  const entry = json.mcpServers && json.mcpServers.agentbus;
  return entry ? { enabled: true, command: entry.command || 'node', args: Array.isArray(entry.args) ? entry.args : [] }
    : { enabled: false, command: 'node', args: [] };
}

function dshEntry(file) {
  if (!fs.existsSync(file)) return { enabled: false, command: 'node', args: [] };
  const text = fs.readFileSync(file, 'utf8');
  const start = text.indexOf(DSH_MCP_BEGIN);
  const end = text.indexOf(DSH_MCP_END, start + DSH_MCP_BEGIN.length);
  if (start < 0 || end < 0) return { enabled: false, command: 'node', args: [] };
  const block = text.slice(start, end + DSH_MCP_END.length);
  const command = block.match(/^\s*command:\s*['"]?([^'"\r\n]+)['"]?\s*$/m);
  const args = block.match(/^\s*args:\s*(\[[^\r\n]*\])\s*$/m);
  return {
    enabled: true,
    command: command ? command[1].trim() : 'node',
    args: args ? (parseJsonString(args[1]) || []) : [],
  };
}

function publicProfile(id, file, entry, supported, reason) {
  const args = entry.args || [];
  const i = args.indexOf('--agent');
  return {
    id: id,
    supported: supported,
    reason: reason || null,
    path: file || null,
    exists: file ? fs.existsSync(file) : false,
    enabled: entry.enabled === true,
    command: entry.command || 'node',
    server_path: args[0] || path.join(BUS_DIR, 'bus-mcp.mjs').split('\\').join('/'),
    agent: i >= 0 && args[i + 1] ? args[i + 1] : id + '/main',
    env_keys: [],
  };
}

export function readMcpProfiles(options) {
  const targets = targetPaths(options && options.homeDir);
  return [
    publicProfile('codex', targets.codex, codexEntry(targets.codex), true),
    publicProfile('claude', targets.claude, claudeEntry(targets.claude), true),
    publicProfile('dsh', targets.dsh, dshEntry(targets.dsh), true),
  ];
}

function withoutTomlSections(text, names) {
  const wanted = new Set(names);
  const lines = text.split(/\r?\n/);
  const out = [];
  let skip = false;
  for (const line of lines) {
    const h = line.trim().match(/^\[([^\]]+)\]$/);
    if (h) skip = wanted.has(h[1]);
    if (!skip) out.push(line);
  }
  return out.join('\n').replace(/\s+$/, '') + '\n';
}

function withoutDshManagedBlock(text) {
  const start = text.indexOf(DSH_MCP_BEGIN);
  if (start < 0) return text.replace(/\s+$/, '') + '\n';
  const end = text.indexOf(DSH_MCP_END, start + DSH_MCP_BEGIN.length);
  if (end < 0) fail('DSH AgentBus 配置标记不完整，请先修复 cordis.patch.yml');
  return (text.slice(0, start) + text.slice(end + DSH_MCP_END.length)).replace(/\s+$/, '') + '\n';
}

function dshManagedBlock(script, agent, token) {
  const envBlock = token
    ? '        env:\n' +
      '          AGENT_BUS_ID: ' + JSON.stringify(agent) + '\n' +
      '          AGENT_BUS_TOKEN: ' + JSON.stringify(token) + '\n'
    : '';
  return DSH_MCP_BEGIN + '\n' +
    '- insert:\n' +
    '    - id: agentbus\n' +
    '      name: "@deepseek-ai/dsh-mcp-client"\n' +
    '      config:\n' +
    '        transport: stdio\n' +
    '        serverName: agentbus\n' +
    '        command: node\n' +
    '        args: ' + JSON.stringify([script, '--agent', agent]) + '\n' +
    envBlock +
    DSH_MCP_END + '\n';
}

function validateMcpInput(input) {
  if (!input || typeof input !== 'object') fail('MCP 配置无效');
  const enabled = input.enabled !== false;
  const agent = agentId(input.agent, 'MCP Agent ID', false);
  if (agent === 'human') fail('human 永不签发 MCP 凭据');
  let token = null;
  if (input.token != null) {
    if (typeof input.token !== 'string' || !/^[a-f0-9]{64}$/.test(input.token)) fail('MCP 凭据格式无效（应为 64 位十六进制）');
    token = input.token;
  }
  return { enabled: enabled, agent: agent, token: token };
}

export function saveMcpProfile(client, input, options) {
  const cfg = validateMcpInput(input);
  const targets = targetPaths(options && options.homeDir);
  const file = targets[client];
  if (!file || (client !== 'codex' && client !== 'claude' && client !== 'dsh')) fail('不支持的 MCP 客户端: ' + client);
  const script = path.join(BUS_DIR, 'bus-mcp.mjs').split('\\').join('/');
  let content;
  if (client === 'codex') {
    const current = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
    content = withoutTomlSections(current, ['mcp_servers.agentbus', 'mcp_servers.agentbus.env']);
    if (cfg.enabled) {
      content += '\n# Agent Bus —— Codex / Claude Code / DSH 共用的任务总线\n' +
        '[mcp_servers.agentbus]\ncommand = "node"\nargs = ' + JSON.stringify([script, '--agent', cfg.agent]) + '\n';
      if (cfg.token) {
        content += '[mcp_servers.agentbus.env]\n' +
          'AGENT_BUS_ID = ' + JSON.stringify(cfg.agent) + '\n' +
          'AGENT_BUS_TOKEN = ' + JSON.stringify(cfg.token) + '\n';
      }
    }
  } else if (client === 'claude') {
    const json = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : {};
    json.mcpServers = json.mcpServers || {};
    if (cfg.enabled) {
      const env = {};
      if (cfg.token) { env.AGENT_BUS_ID = cfg.agent; env.AGENT_BUS_TOKEN = cfg.token; }
      json.mcpServers.agentbus = { type: 'stdio', command: 'node', args: [script, '--agent', cfg.agent], env: env };
    }
    else delete json.mcpServers.agentbus;
    content = JSON.stringify(json, null, 2) + '\n';
  } else {
    const current = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
    content = withoutDshManagedBlock(current);
    if (cfg.enabled) content += '\n' + dshManagedBlock(script, cfg.agent, cfg.token);
  }
  const result = atomicWrite(file, content);
  // 配置文件含凭据，尽量收到仅当前用户可读；Windows 上 chmod 基本无效，需 ACL helper 才能完全落实
  try { fs.chmodSync(file, 0o600); } catch (e) {}
  const profile = readMcpProfiles(options).find(function (x) { return x.id === client; });
  return { profile: profile, backup: result.backup, restart_required: true };
}
