// 测试隔离合同（第 11 项）：**运行期**拒绝访问真实状态，而不是靠人记得设环境变量。
// 这轮我们踩过三次「测试以为自己隔离了」：真实 bus.db、BUS_LIFECYCLE、BUS_DB 懒加载。
// 这条守卫是唯一能自动拦住第四次的东西：AGENTBUS_TEST_GUARD=1 时，任何指向真实仓库状态的路径解析都立即抛错。
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const BUS_ROOT = path.resolve(HERE, '..');

// 真实仓库状态（只读常量，供守卫与套件比对）。
export const REAL_STATE = Object.freeze({
  db: path.join(BUS_ROOT, 'bus.db'),
  policy: path.join(BUS_ROOT, 'policy.json'),
  projects: path.join(BUS_ROOT, 'projects.json'),
  lifecycle: path.join(BUS_ROOT, 'lifecycle.json'),
  logs: path.join(BUS_ROOT, 'logs'),
});

const KIND_ENV = {
  db: 'BUS_DB',
  policy: 'BUS_POLICY_PATH',
  projects: 'BUS_PROJECTS',
  lifecycle: 'BUS_LIFECYCLE',
};

export class IsolationError extends Error {
  constructor(kind, resolved, hint) {
    const env = KIND_ENV[kind] || kind.toUpperCase();
    super('测试隔离被破坏：' + kind + ' 指向真实仓库状态 ' + resolved + '\n' +
      '  AGENTBUS_TEST_GUARD=1 下禁止在测试进程里读写真实状态。\n' +
      '  修法：在测试 bootstrap 里把 ' + env + ' 设到临时目录（见 bus/smoke-support/env.mjs 的 suiteEnv）。' +
      (hint ? '\n  ' + hint : ''));
    this.name = 'IsolationError';
    this.kind = kind;
    this.resolved = resolved;
    this.env = env;
  }
}

export function guardEnabled() {
  return process.env.AGENTBUS_TEST_GUARD === '1';
}

function normalize(p) {
  try { return path.resolve(String(p)); } catch (error) { return null; }
}

// 判定某个解析后的路径是否命中"真实状态"：本体、-wal/-shm、或（logs）目录内。
export function hitsRealState(kind, resolved) {
  const real = REAL_STATE[kind];
  if (!real || !resolved) return false;
  const target = normalize(resolved);
  const base = normalize(real);
  if (!target || !base) return false;
  if (kind === 'db') return target === base || target === base + '-wal' || target === base + '-shm';
  if (kind === 'logs') return target === base || target.indexOf(base + path.sep) === 0;
  return target === base;
}

// 所有状态模块在"解析出自己的路径"那一刻调用它。
export function assertIsolated(kind, resolved, hint) {
  if (!guardEnabled()) return resolved;
  if (hitsRealState(kind, resolved)) throw new IsolationError(kind, normalize(resolved), hint);
  return resolved;
}

// 一次性体检：把当前进程环境里的四个路径都过一遍（bootstrap 与隔离审计套件都用它）。
export function auditEnv(env) {
  const e = env || process.env;
  const findings = [];
  const check = function (kind, value, envName) {
    if (value == null || value === '') findings.push({ kind: kind, env: envName, status: 'missing' });
    else if (hitsRealState(kind, value)) findings.push({ kind: kind, env: envName, status: 'real_state', value: normalize(value) });
    else findings.push({ kind: kind, env: envName, status: 'ok', value: normalize(value) });
  };
  check('db', e.BUS_DB, 'BUS_DB');
  check('policy', e.BUS_POLICY_PATH, 'BUS_POLICY_PATH');
  check('projects', e.BUS_PROJECTS, 'BUS_PROJECTS');
  check('lifecycle', e.BUS_LIFECYCLE, 'BUS_LIFECYCLE');
  return findings;
}

// fail closed：缺任何一个都必须拒绝（"忘了设"与"设成真的"同样危险）。
export function assertEnvironmentComplete(env) {
  const e = env || process.env;
  const findings = auditEnv(e);
  const bad = findings.filter(function (f) { return f.status !== 'ok'; });
  if (!bad.length) return findings;
  const missing = bad.filter(function (f) { return f.status === 'missing'; }).map(function (f) { return f.env; });
  const real = bad.filter(function (f) { return f.status === 'real_state'; }).map(function (f) { return f.env + '=' + f.value; });
  const err = new Error('测试环境不完整（fail closed）：' +
    (missing.length ? '缺少 ' + missing.join(', ') + ' ' : '') +
    (real.length ? '指向真实状态 ' + real.join(' ') : '') +
    '\n  用 bus/smoke-support/env.mjs 的 suiteEnv(dir) 生成完整环境。');
  err.name = 'IsolationError';
  err.findings = findings;
  throw err;
}
