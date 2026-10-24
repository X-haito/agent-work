#!/usr/bin/env node
// Claude Code hooks 实现。用法（配在 .claude/settings.json）:
//   node bus/hook.mjs start | beat | stop | end
// 约定：exit 2 = 把 stderr 内容注入上下文并继续本回合；exit 0 = 正常结束。
import * as S from './store.mjs';

const AGENT = process.env.AGENT_BUS_ID || 'claude/main';
const MODE = process.argv[2] || 'beat';
const WAIT_MS = Number(process.env.BUS_HOOK_WAIT_MS || 8000);

let MAX_LINES = 40;
try { MAX_LINES = S.loadPolicy().economics.report_max_lines || 40; } catch (e) {}

function readStdin() {
  return new Promise(function (resolve) {
    if (process.stdin.isTTY) return resolve({});
    let buf = '';
    let done = false;
    const finish = function () { if (!done) { done = true; try { resolve(JSON.parse(buf || '{}')); } catch (e) { resolve({}); } } };
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', function (d) { buf += d; });
    process.stdin.on('end', finish);
    process.stdin.on('error', finish);
    setTimeout(finish, 800);
  });
}

function format(msgs) {
  const lines = msgs.slice(0, MAX_LINES).map(function (m) {
    const refs = m.refs ? ' refs=' + m.refs : '';
    return '- [' + m.kind + '] from ' + m.sender + ' seq=' + m.seq + refs + ': ' + String(m.body).slice(0, 300);
  });
  if (msgs.length > MAX_LINES) lines.push('- …还有 ' + (msgs.length - MAX_LINES) + ' 条');
  return lines.join('\n');
}

async function main() {
  await readStdin();
  const db = S.openDb(process.env.BUS_DB);
  if (!S.getRuntimeState(db).enabled) return 0;

  if (MODE === 'start') { S.heartbeat(db, AGENT, 'idle'); return 0; }
  if (MODE === 'end') { S.heartbeat(db, AGENT, 'offline'); return 0; }

  if (MODE === 'beat') {
    S.heartbeat(db, AGENT, 'busy');
    const r = await S.waitFor(db, AGENT, undefined, 0);
    if (r.messages.length) {
      process.stderr.write('【Agent Bus 新消息】\n' + format(r.messages) + '\n');
      return 2;
    }
    return 0;
  }

  if (MODE === 'stop') {
    S.heartbeat(db, AGENT, 'idle');
    const r = await S.waitFor(db, AGENT, undefined, WAIT_MS);
    if (r.messages.length) {
      process.stderr.write('【Agent Bus 新消息，处理完再收工】\n' + format(r.messages) + '\n');
      return 2;
    }
    return 0;
  }

  return 0;
}

main().then(function (code) { process.exit(code); }).catch(function (e) {
  // hook 自身出错绝不能卡住 Claude 的主流程
  process.stderr.write('[agent-bus hook] ' + (e && e.message || e) + '\n');
  process.exit(0);
});
