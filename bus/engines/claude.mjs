import { checkGrant, requiresStrongIsolation, launch } from './codex.mjs';
// networkIsolation=false：claude 子进程可以无视 HTTP_PROXY/HTTPS_PROXY 直接建连，
// 所以联网任务只能审计，无法强制，必须转 proposed + needs_human。
export function capabilities() {
  return {
    strongWriteIsolation: false,
    supportsAddDir: true,
    networkIsolation: false,
    notes: ['受限 permission-mode 不是 OS 强写隔离', 'networkIsolation=false：只能注入 HTTP(S)_PROXY 做审计，无法阻止 claude 子进程绕过代理直连'],
  };
}
export function planArgs(grant, prompt, opts = {}) {
  const roots = checkGrant(grant);
  if (requiresStrongIsolation(grant, opts.task)) throw new Error('engine_isolation_unsupported: 执行端不支持强隔离，隔离配置不可用');
  const args = ['-p', prompt, '--permission-mode', opts.permissionMode === 'plan' ? 'plan' : 'default', '--output-format', 'json'];
  if (roots.length > 1) args.push('--add-dir', ...roots.slice(1));
  return args;
}
export function spawnTask(grant, prompt, opts = {}) { return launch('claude', grant, planArgs(grant, prompt, opts), opts); }
