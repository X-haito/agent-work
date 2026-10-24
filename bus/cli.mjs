#!/usr/bin/env node
// 人用的 CLI:
//   node bus/cli.mjs status | board | agents | cost | projects
//   node bus/cli.mjs add-project <id> <绝对路径>
//   node bus/cli.mjs init-project <id>
import fs from 'node:fs';
import path from 'node:path';
import * as S from './store.mjs';
import * as Creds from './auth.mjs';
import * as AdminConfig from './admin-config.mjs';

const cmd = process.argv[2] || 'status';
const db = S.openDb();
const policy = S.loadPolicy();

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
  console.log('Lead: ' + (policy.lead || '(未设置)'));
  console.log('权限: ' + Object.keys(policy.permissions).map(function (k) {
    return k + '=' + (policy.permissions[k] || []).join('/');
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

function projects() {
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
    const rotated = Creds.rotateCredential(db, agent);
    if (!rotated.ok) { console.log('轮换失败: ' + rotated.reason + ' ' + (rotated.message || '')); return; }
    if (!isClient) {
      console.log('新凭据（只显示这一次）: ' + rotated.token);
      console.log('把它写入该 Agent 的 AGENT_BUS_TOKEN 环境变量；旧凭据宽限到 ' + rotated.grace_until);
    } else {
      const saved = AdminConfig.saveMcpProfile(client, { enabled: true, agent: agent, token: rotated.token });
      console.log('已写入 ' + client + ' 配置: ' + saved.profile.path);
      console.log('备份: ' + (saved.backup || '(无)') + '；宽限至 ' + rotated.grace_until);
      const cleaned = Creds.revokeSuperseded(db, agent);
      console.log('已撤销被取代的旧凭据 ' + cleaned.revoked + ' 条');
      console.log('需要重启对应客户端才会加载新凭据。');
    }
    Creds.logAudit(db, { actor: 'human', auth_method: 'local-cli', action: 'credentials.rotate', resource: { agent: agent }, result: 'ok' });
    return;
  }
  console.log('用法: node bus/cli.mjs credentials [list | rotate <codex|claude|dsh|agent> | revoke <agent>]');
}

const TABLE = {
  status: status, board: board, agents: agents, cost: cost,
  projects: projects, 'add-project': addProject, 'init-project': initProject,
  credentials: credentials,
};

if (TABLE[cmd]) TABLE[cmd]();
else console.log('用法: node bus/cli.mjs [status|board|agents|cost|projects|add-project|init-project|credentials]');
