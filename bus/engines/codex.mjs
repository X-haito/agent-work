import path from 'node:path';
import { spawn } from 'node:child_process';

// networkIsolation=false 是事实陈述，不是待办：codex 子进程可以无视 HTTP_PROXY/HTTPS_PROXY 直接建连，
// 本机也没有 OS 级网络隔离，所以代理只能审计，不能强制。
export function capabilities() {
  return {
    strongWriteIsolation: true,
    supportsAddDir: true,
    networkIsolation: false,
    notes: [
      '固定 workspace-write；授权根由 --add-dir 显式传入',
      'networkIsolation=false：只能注入 HTTP(S)_PROXY 做审计，无法阻止 codex 子进程绕过代理直连',
    ],
  };
}

export const NETWORK_UNENFORCEABLE = '仅审计，无法强制隔离：执行端无法阻止子进程绕过代理直连，联网目标白名单无法强制执行';

// grant/task 上的 kind 既可能是数组也可能是 JSON 字符串，两种都要认。
function kindsOf(value) {
  if (Array.isArray(value)) return value;
  try {
    const parsed = JSON.parse(value || '[]');
    return Array.isArray(parsed) ? parsed : [String(value)];
  } catch { return [String(value)]; }
}

// network_grants 落库是 TEXT json；没带 grant 的联网任务一律不合格。
export function networkGrantsOf(task) {
  let raw = task && task.network_grants;
  if (typeof raw === 'string') { try { raw = JSON.parse(raw); } catch { return []; } }
  if (!Array.isArray(raw)) return [];
  return raw.filter(item => item && typeof item === 'object' && !Array.isArray(item) && typeof item.host === 'string' && Array.isArray(item.ports) && item.ports.length > 0);
}

// redline.mjs 只负责"可能联网"；是否允许联网由目标级 network_grants + Human 审批决定。
export function requiresNetwork(grant, task = {}) {
  const kinds = [grant && grant.redline, task.grants, task.redline].flatMap(kindsOf);
  return kinds.indexOf('net:egress') >= 0 || networkGrantsOf(task).length > 0;
}

function deferToHuman(S, db, task, owner, reason, message) {
  if (typeof S.deferExecutionTask !== 'function') return { ok: false, reason: 'execution_grant_api_unavailable', message: '缺少 deferExecutionTask；' + message, deferred: false };
  const deferred = S.deferExecutionTask(db, task.id, owner, message);
  return { ...deferred, ok: false, reason: deferred.ok ? reason : (deferred.reason || reason), message, deferred: deferred.ok === true };
}
export function checkGrant(grant) {
  if (!grant || !grant.grant_id || !Array.isArray(grant.roots) || !grant.roots.length || grant.roots.some(root => !path.isAbsolute(root))) throw new Error('execution_grant_invalid: 缺少有效授权根');
  return grant.roots;
}
export function requiresStrongIsolation(grant, task = {}) {
  let extra = task.extra_dirs;
  if (typeof extra === 'string') { try { extra = JSON.parse(extra); } catch { return true; } }
  const kinds = [grant.redline, task.grants, task.redline].flatMap(kindsOf);
  return grant.roots.length > 1 || Boolean(extra && extra.length) || kinds.some(kind => /^(fs:delete|cfg:edit)$/.test(kind));
}
// 准入顺序：先判网络能力，再判写隔离能力。
// 联网任务只有 networkIsolation===true 的执行端才允许启动；当前三个引擎都是 false，
// 所以联网任务永远落到 proposed + needs_human，不会被"白名单"名义放行。
export function admitTask(S, db, task, owner, engine, grant) {
  const caps = engine.capabilities() || {};
  if (requiresNetwork(grant, task)) {
    if (caps.networkIsolation !== true) return deferToHuman(S, db, task, owner, 'engine_network_isolation_unsupported', NETWORK_UNENFORCEABLE);
    if (!networkGrantsOf(task).length) {
      return deferToHuman(S, db, task, owner, 'network_grants_missing', '联网任务缺少目标级 network_grants：需要 Human 先批准具体协议/主机/端口');
    }
  }
  if (caps.strongWriteIsolation || !requiresStrongIsolation(grant, task)) return { ok: true };
  return deferToHuman(S, db, task, owner, 'engine_isolation_unsupported', '执行端不支持强隔离：隔离配置不可用，extra_dirs、删除或配置授权需要 Human 处理');
}
export function planArgs(grant, prompt, opts = {}) {
  const roots = checkGrant(grant);
  const args = ['exec', '--skip-git-repo-check', '-s', 'workspace-write', '-C', roots[0], '--json'];
  for (const root of roots.slice(1)) args.push('--add-dir', root);
  args.push(prompt);
  return args;
}
export function launch(engine, grant, args, opts = {}) {
  if (!Number.isFinite(Date.parse(grant.expires_at)) || Date.parse(grant.expires_at) <= Date.now()) throw new Error('execution_grant_expired');
  if (opts.dryRun) return Promise.resolve({ ok: true, code: 0, out: '', err: '', engine, args, dry: true });
  return new Promise(resolve => {
    if (opts.signal?.aborted) return resolve({ ok: false, code: -1, out: '', err: 'execution_aborted', engine });
    const runner = opts.runner || { cmd: engine, prefix: [] };
    // 代理只通过环境变量注入：能力不足时不会走到这里（联网任务已被转待批）。
    const env = opts.env ? Object.assign({}, process.env, opts.env) : process.env;
    let child;
    try { child = spawn(runner.cmd, (runner.prefix || []).concat(args), { cwd: grant.roots[0], stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, detached: process.platform !== 'win32', env }); }
    catch (error) { return resolve({ ok: false, code: -1, out: '', err: String(error), engine }); }
    let out = '', err = '', stopped = false;
    const stop = () => {
      stopped = true;
      if (process.platform === 'win32' && child.pid) { const killer = spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true }); killer.on('error', () => { try { child.kill(); } catch {} }); }
      else { try { process.kill(-child.pid, 'SIGKILL'); } catch { try { child.kill('SIGKILL'); } catch {} } }
    };
    opts.signal?.addEventListener('abort', stop, { once: true });
    const timer = setTimeout(stop, opts.timeoutMs || 30 * 60 * 1000);
    const finish = code => { clearTimeout(timer); opts.signal?.removeEventListener('abort', stop); resolve({ ok: code === 0 && !stopped, code: stopped ? -1 : code, out, err, engine }); };
    child.stdout.on('data', data => { out += data.toString(); });
    child.stderr.on('data', data => { err += data.toString(); });
    child.on('error', error => { err += String(error); finish(-1); });
    child.on('close', finish);
  });
}
export function spawnTask(grant, prompt, opts = {}) { return launch('codex', grant, planArgs(grant, prompt, opts), opts); }
