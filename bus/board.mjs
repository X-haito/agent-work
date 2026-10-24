#!/usr/bin/env node
// 看板服务：把 bus.db 里的任务投影成网页，并提供审批入口。零依赖。
// 看板只是"视图" —— 删掉它，数据仍在 bus.db 里，重启即恢复。
// 用法: node bus/board.mjs [--port 7400] [--actor human]
import http from 'node:http';
import { URL } from 'node:url';
import * as S from './store.mjs';
import { startConsole } from './console-server.mjs';

const USE_LEGACY_BOARD = process.env.AGENTBUS_LEGACY_BOARD === '1';
if (!USE_LEGACY_BOARD) {
  const portIndex = process.argv.indexOf('--port');
  const actorIndex = process.argv.indexOf('--actor');
  startConsole({
    port: portIndex >= 0 && process.argv[portIndex + 1] ? Number(process.argv[portIndex + 1]) : 7400,
    actor: actorIndex >= 0 && process.argv[actorIndex + 1] ? process.argv[actorIndex + 1] : 'human',
  });
} else {

function argOf(name, def) {
  const i = process.argv.indexOf('--' + name);
  if (i >= 0 && process.argv[i + 1]) return process.argv[i + 1];
  return def;
}

const PORT = Number(argOf('port', 7400));
const ACTOR = argOf('actor', 'human');
const db = S.openDb();

function esc(s) {
  return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function snapshot() {
  try { S.reapLeases(db); } catch (e) {}
  const policy = S.loadPolicy();
  const tasks = db.prepare(
    'SELECT id,title,project,status,owner,origin,dispatched_by,cost_class,write_scope,updated_at FROM tasks ' +
    "WHERE status NOT IN ('cancelled') ORDER BY id DESC LIMIT 200"
  ).all();
  return { tasks: tasks, agents: S.listAgents(db), cost: S.costSummary(db, policy.lead), policy: policy };
}

const STATUS_COLOR = {
  open: '#1f6feb', proposed: '#d29922', claimed: '#8957e5', in_progress: '#238636',
  review: '#0969da', done: '#2ea043', failed: '#da3633', declined: '#6e7681',
};

const CSS = [
  'body{background:#0d1117;color:#c9d1d9;font:14px/1.5 ui-sans-serif,system-ui,sans-serif;margin:0;padding:24px}',
  'h1{font-size:16px;margin:0 0 4px}h1 small{color:#8b949e;font-weight:400;font-size:12px}',
  '.banner{background:#1f6feb33;border:1px solid #1f6feb;border-radius:6px;padding:8px 12px;margin:12px 0;color:#79c0ff}',
  'table{width:100%;border-collapse:collapse;margin-top:16px;font-size:13px}',
  'th{text-align:left;color:#8b949e;font-weight:500;border-bottom:1px solid #21262d;padding:6px 8px}',
  'td{border-bottom:1px solid #161b22;padding:7px 8px;vertical-align:middle}',
  '.id{color:#8b949e;font-family:ui-monospace,Consolas,monospace}',
  '.title{max-width:520px}.dim{color:#6e7681;font-size:12px}',
  '.pill{padding:1px 8px;border-radius:10px;color:#fff;font-size:12px;white-space:nowrap}',
  '.chip{display:inline-block;background:#161b22;border:1px solid #21262d;border-radius:6px;padding:2px 8px;margin-right:6px;font-size:12px}',
  'button{background:#238636;color:#fff;border:0;border-radius:6px;padding:3px 10px;cursor:pointer;font-size:12px}',
  'button.no{background:#30363d}',
  '.bar{display:flex;gap:24px;flex-wrap:wrap;margin-top:10px;color:#8b949e;font-size:12px}',
].join('');

function taskRow(t) {
  let actions = '';
  if (t.status === 'proposed') {
    const id = encodeURIComponent(t.id);
    actions = '<form method="POST" action="/accept?id=' + id + '" style="display:inline"><button>接受</button></form>' +
      '<form method="POST" action="/decline?id=' + id + '" style="display:inline"><button class="no">拒绝</button></form>';
  }
  return '<tr>' +
    '<td class="id">' + esc(t.id) + '</td>' +
    '<td><span class="pill" style="background:' + (STATUS_COLOR[t.status] || '#484f58') + '">' + esc(t.status) + '</span></td>' +
    '<td>' + esc(t.owner || '—') + '</td>' +
    '<td>' + esc(t.cost_class) + '</td>' +
    '<td class="title">' + esc(t.title) + '</td>' +
    '<td class="dim">' + esc(t.origin) + '</td>' +
    '<td>' + actions + '</td>' +
    '</tr>';
}

function render(msg) {
  const s = snapshot();
  const rows = s.tasks.map(taskRow).join('');
  const agentRows = s.agents.map(function (a) {
    return '<span class="chip">' + esc(a.agent_id) + ' · ' + esc(a.status) + ' · 手上 ' + a.active_tasks + '</span>';
  }).join('');
  const ratio = (s.cost.lead_ratio * 100).toFixed(1);
  const health = s.cost.lead_ratio > 0.5 ? '失控' : s.cost.lead_ratio > 0.2 ? '偏高' : '健康';

  const head = '<!doctype html><html lang="zh"><head><meta charset="utf-8">' +
    '<meta http-equiv="refresh" content="3"><title>Agent Bus</title>' +
    '<style>' + CSS + '</style></head><body>';
  const title = '<h1>Agent Bus <small>看板只是视图，账本在 bus.db</small></h1>';
  const banner = msg ? '<div class="banner">' + esc(msg) + '</div>' : '';
  const bar1 = '<div class="bar"><span>Lead: ' + esc(s.policy.lead) + '</span>' +
    '<span>总闸: ' + (s.policy.global.dispatch_enabled ? '开' : '关') + '</span>' +
    '<span>token: ' + s.cost.total + ' · Lead 占比 ' + ratio + '%（' + health + '）</span>' +
    '<span>操作身份: ' + esc(ACTOR) + '</span></div>';
  const bar2 = '<div class="bar">' + (agentRows || '<span>暂无 agent 心跳</span>') + '</div>';
  const table = '<table><thead><tr><th>ID</th><th>状态</th><th>Owner</th><th>档</th><th>标题</th><th>来源</th><th></th></tr></thead>' +
    '<tbody>' + (rows || '<tr><td colspan="7" class="dim">还没有任务</td></tr>') + '</tbody></table>';
  return head + title + banner + bar1 + bar2 + table + '</body></html>';
}

function actAndRedirect(pathname, id, res) {
  const policy = S.loadPolicy();
  const isAccept = pathname === '/accept';
  const r = isAccept
    ? S.accept(db, ACTOR, id, policy.permissions.accept)
    : S.decline(db, ACTOR, id, '人类在看板上拒绝', policy.permissions.accept);
  const text = (r.ok ? (isAccept ? '已批准 ' : '已拒绝 ') : '失败: ') + id + (r.ok ? '' : ' — ' + r.message);
  res.writeHead(302, { location: '/?msg=' + encodeURIComponent(text) });
  res.end();
}

const server = http.createServer(function (req, res) {
  const u = new URL(req.url, 'http://localhost');
  try {
    if (u.pathname === '/api/tasks') {
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify(snapshot().tasks, null, 2));
      return;
    }
    if (req.method === 'POST' && (u.pathname === '/accept' || u.pathname === '/decline')) {
      actAndRedirect(u.pathname, u.searchParams.get('id'), res);
      return;
    }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(render(u.searchParams.get('msg')));
  } catch (e) {
    res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' });
    res.end(String(e && e.stack || e));
  }
});

server.on('error', function (e) {
  if (e && e.code === 'EADDRINUSE') {
    process.stderr.write('[board] 端口 ' + PORT + ' 已被占用。换个端口: node bus/board.mjs --port 7401\n');
    process.exit(2);
  }
  process.stderr.write('[board] 启动失败: ' + (e && e.message || e) + '\n');
  process.exit(1);
});

S.reapLeases(db, true);
server.listen(PORT, '127.0.0.1', function () {
  process.stderr.write('[board] http://127.0.0.1:' + PORT + '  actor=' + ACTOR + '\n');
});
}
