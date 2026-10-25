import { checkGrant, requiresStrongIsolation, launch } from './codex.mjs';
import * as Isolation from '../isolation/provider.mjs';

// 能力由 probe 推导，不自述（第 3 项第 9 条）。受限 permission-mode 不是 OS 强写隔离，
// 本机也没有可用容器运行时 → 两个隔离能力都是 false。
export function capabilities(options = {}) {
  const isolated = Isolation.resolveCapability(options);
  return Object.assign({}, isolated.capability, {
    engine: 'claude',
    supportsAddDir: true,
    mechanisms: ['受限 permission-mode + --add-dir（不是 OS 级写隔离）'],
    notes: (isolated.probe.notes || []).concat([
      'strongWriteIsolation / networkIsolation 由 probe 推导，adapter 不自述',
      '受限 permission-mode 不是 OS 强写隔离',
      'networkIsolation=false：只能注入 HTTP(S)_PROXY 做审计，无法阻止 claude 子进程绕过代理直连',
    ]),
  });
}
export function planArgs(grant, prompt, opts = {}) {
  const roots = checkGrant(grant);
  if (requiresStrongIsolation(grant, opts.task)) throw new Error('engine_isolation_unsupported: 执行端不支持强隔离，隔离配置不可用');
  const args = ['-p', prompt, '--permission-mode', opts.permissionMode === 'plan' ? 'plan' : 'default', '--output-format', 'json'];
  if (roots.length > 1) args.push('--add-dir', ...roots.slice(1));
  return args;
}
export function spawnTask(grant, prompt, opts = {}) { return launch('claude', grant, planArgs(grant, prompt, opts), opts); }
