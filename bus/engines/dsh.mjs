import { checkGrant, requiresStrongIsolation, launch } from './codex.mjs';
import * as Isolation from '../isolation/provider.mjs';

// 能力由 probe 推导，不自述（第 3 项第 9 条）。现有 patch 只关 MCP，
// 既没有 OS 级写隔离也不拦直连 → 两个隔离能力都是 false。
export function capabilities(options = {}) {
  const isolated = Isolation.resolveCapability(options);
  return Object.assign({}, isolated.capability, {
    engine: 'dsh',
    supportsAddDir: false,
    mechanisms: ['现有 patch 仅关闭 MCP，未提供强写隔离；仅允许非敏感单根任务'],
    notes: (isolated.probe.notes || []).concat([
      'strongWriteIsolation / networkIsolation 由 probe 推导，adapter 不自述',
      '现有 patch 仅关闭 MCP，未提供强写隔离；仅允许非敏感单根任务',
      'networkIsolation=false：只能注入 HTTP(S)_PROXY 做审计，无法阻止 dsh 子进程绕过代理直连',
    ]),
  });
}
export function planArgs(grant, prompt, opts = {}) {
  checkGrant(grant);
  if (requiresStrongIsolation(grant, opts.task)) throw new Error('engine_isolation_unsupported: 执行端不支持强隔离，隔离配置不可用');
  if (!opts.profile || !opts.patch) throw new Error('dsh_configuration_missing: 需要 profile 和 patch');
  return ['--profile', opts.profile, '--patch', opts.patch, '--json', prompt];
}
export function spawnTask(grant, prompt, opts = {}) { return launch('dsh', grant, planArgs(grant, prompt, opts), opts); }
