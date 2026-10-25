// 隔离 provider 抽象（第 3 项第 9/11 条 + 第 6 项第 10/11 条）
//
// 核心原则：capability 不能自述，只能由**实测过的 probe 结果**推导。
// 本机没有可安全实测的 CLI、也没有容器运行时，所以这里所有 provider 的
// verified 都是 false——这不是没写完，而是当前环境的真实结论：
//   · host-native 没有 OS 级写/网络边界（能做的只有 grant roots + 事后快照 + 代理审计）；
//   · container 接口完整，但检测不到 docker/podman 时必须 fail-closed，绝不假装能隔离。
//
// 变成 verified=true 需要的环境见 VERIFIED_REQUIREMENTS。
import fs from 'node:fs';
import path from 'node:path';

export const PROBE_VERSION = 1;
export const HOST_NATIVE = 'host-native';
export const CONTAINER = 'container';

// probe 结果的有效期：升级 CLI / 换 provider 之后旧 probe 必须失效（第 3 项第 9 条）
export const PROBE_TTL_MS = 24 * 60 * 60 * 1000;

// 每种拒绝原因的"下一步该做什么"——UI/CLI 共用同一份文案，避免两处说法不一致。
// 原则：说清"你需要做什么"，不说"需要人工"。
export const NEXT_STEPS = {
  probe_missing: '先跑 node bus/cli.mjs doctor --probe-engine 建立隔离证据；没有证据就不能给强隔离类任务发 grant',
  probe_not_verified: '本机隔离未验证：安装 Docker/Podman 后重跑 doctor --probe-engine；或在任务上去掉 extra_dirs / fs:delete / cfg:edit 授权',
  probe_stale: '隔离证据已过期：重跑 node bus/cli.mjs doctor --probe-engine 刷新（升级 CLI 或换 provider 后必须重测）',
  engine_isolation_unsupported: '把任务改成单根、不带 extra_dirs / 删除 / 配置授权后重新派发；或安装可验证的容器隔离后端再跑 doctor --probe-engine',
  network_isolation_unavailable: '安装容器运行时并让 doctor --probe-engine 通过（否则无法强制网络白名单）；或去掉 network_grants 改成离线任务。注：Human 批准名单不等于能在无法强制隔离的执行端上放行',
  network_grants_missing: '先补齐具体协议/主机/端口的 network_grants，等 Human 批准后再派发',
  no_container_runtime: '安装 Docker 或 Podman，然后重跑 doctor --probe-engine；没有运行时就只能把任务改成离线任务',
  canary_not_executed: '提供 canary 运行器并实际执行写/网络探针；只有运行时不算有隔离',
  canary_results_below_expectation: 'canary 没达标（越界写入没被挡住 / 直连没被挡住）：检查容器参数与网络策略后重测',
};

export function nextStepFor(reason) {
  return NEXT_STEPS[reason] || '先跑 doctor --probe-engine 确认本机隔离能力，再决定是装运行时、减少 grants，还是等 Human 批准';
}

// probe 新鲜度：没 tested_at / 超期 / probe_version 不一致都算过期
export function probeFreshness(probe, options) {
  const o = options || {};
  const now = o.now ? new Date(o.now).getTime() : Date.now();
  const ttl = Number.isFinite(o.ttlMs) && o.ttlMs > 0 ? o.ttlMs : PROBE_TTL_MS;
  if (!probe) return { ok: false, reason: 'probe_missing' };
  if (probe.probe_version !== PROBE_VERSION) return { ok: false, reason: 'probe_stale', detail: { why: 'probe_version_mismatch', expected: PROBE_VERSION, got: probe.probe_version } };
  const tested = Date.parse(String(probe.tested_at || ''));
  if (!Number.isFinite(tested)) return { ok: false, reason: 'probe_stale', detail: { why: 'tested_at_missing' } };
  if (now - tested > ttl) return { ok: false, reason: 'probe_stale', detail: { why: 'expired', age_ms: now - tested, ttl_ms: ttl } };
  return { ok: true, age_ms: now - tested };
}

export const VERIFIED_REQUIREMENTS = [
  'container: 安装可用的 docker 或 podman，且当前用户能跑非特权容器',
  'container: 提供 canary 运行器（在容器内实际执行写/网络探针），probe 才可能给出 verified=true',
  'host-native: 不存在——没有 OS 沙箱时它永远不可能 verified=true，只能 fail-closed',
  'probe 结果与 engine/provider 版本绑定：升级 CLI 或改 probe 版本后必须重新实测',
];

const NETWORK_UNENFORCEABLE = '仅审计，无法强制隔离：执行端无法阻止子进程绕过代理直连';
const WRITE_UNENFORCEABLE = '无 OS 级写隔离：边界只有 grant roots 准入 + 执行后快照，无法阻止越界写入';

function nowIso() { return new Date().toISOString(); }

// IsolationProbeResult（第 3 项第 9 条）：只记录"实测看到的结果"。
// null = 没测；true/false = 测到的实际结果（write_outside=false 表示越界写入被挡住了）。
function emptyProbe(provider, extra) {
  return Object.assign({
    provider: provider,
    probe_version: PROBE_VERSION,
    engine_version: null,
    tested_at: null,
    write_inside: null,
    write_outside: null,
    network_direct: null,
    network_via_proxy: null,
    verified: false,
    reason: 'canary_not_executed',
    notes: [],
  }, extra || {});
}

// capability 的唯一推导处：adapter 不许再自己写 strongWriteIsolation。
export function capabilitiesFromProbe(probe) {
  const p = probe || null;
  const verified = !!(p && p.verified === true);
  const writeOk = verified && p.write_inside === true && p.write_outside === false;
  const netOk = verified && p.network_direct === false && p.network_via_proxy === true;
  return {
    provider: p ? p.provider : 'none',
    probe_version: p ? p.probe_version : PROBE_VERSION,
    verified: verified,
    strongWriteIsolation: writeOk,
    networkIsolation: netOk,
    reason: p ? (p.reason || (verified ? 'verified' : 'unverified')) : 'probe_missing',
    notes: p && Array.isArray(p.notes) ? p.notes : [],
    probe: p,
  };
}

// 默认可执行文件探测：只查 PATH，不 spawn 任何进程（本机 spawn 受限，也避免副作用）
export function detectRuntime(options) {
  const o = options || {};
  const names = Array.isArray(o.runtimes) && o.runtimes.length ? o.runtimes : ['docker', 'podman'];
  const which = typeof o.which === 'function' ? o.which : defaultWhich;
  const searched = [];
  for (const name of names) {
    const found = which(name);
    searched.push({ name: name, path: found || null });
    if (found) return { runtime: name, path: found, searched: searched };
  }
  return { runtime: null, path: null, searched: searched };
}

export function defaultWhich(name) {
  const dirs = String(process.env.PATH || '').split(path.delimiter).filter(Boolean);
  const suffixes = process.platform === 'win32' ? ['.exe', '.cmd', '.bat', ''] : [''];
  for (const dir of dirs) {
    for (const suffix of suffixes) {
      const candidate = path.join(dir, name + suffix);
      try { if (fs.statSync(candidate).isFile()) return candidate; } catch (error) { /* 继续找 */ }
    }
  }
  return null;
}

function mountsFor(task, grant, options) {
  const o = options || {};
  const roots = Array.isArray(grant && grant.roots) ? grant.roots : [];
  const targets = [];
  for (const root of roots) {
    const value = String(root || '');
    if (value && path.isAbsolute(value) && value.split(/[\\\\/]/).indexOf('..') < 0) {
      const mount = { source: value, target: o.containerWorkdir || '/workspace', mode: 'rw' };
      if (!targets.some(function (m) { return m.source === mount.source; })) targets.push(mount);
    }
  }
  return targets;
}

function requiresNetwork(task, grant) {
  let grants = task && task.network_grants;
  if (typeof grants === 'string') { try { grants = JSON.parse(grants); } catch (error) { grants = []; } }
  const hasGrant = Array.isArray(grants) && grants.length > 0;
  const redline = [grant && grant.redline, task && task.grants, task && task.redline].flatMap(function (value) {
    if (Array.isArray(value)) return value;
    try { const parsed = JSON.parse(value || '[]'); return Array.isArray(parsed) ? parsed : [String(value)]; } catch (error) { return [String(value)]; }
  });
  return hasGrant || redline.indexOf('net:egress') >= 0;
}

function hostNativeProvider(options) {
  const o = options || {};
  void o;
  return {
    name: HOST_NATIVE,
    probe: function () {
      // 无 canary 可用：如实返回 null 字段，而不是填 true/false 冒充测过
      return emptyProbe(HOST_NATIVE, {
        reason: 'no_os_sandbox',
        notes: [WRITE_UNENFORCEABLE, NETWORK_UNENFORCEABLE, 'approved 配置不等于隔离：grant roots 只是准入，越界写入只能事后发现'],
      });
    },
    capabilities: function () { return capabilitiesFromProbe(this.probe()); },
    // 带网络授权的任务在 host-native 上一律 fail-closed，停在 needs_human
    wrap: function (task, grant) {
      if (requiresNetwork(task, grant)) {
        return { ok: false, provider: HOST_NATIVE, reason: 'network_isolation_unavailable', needs_human: true, message: NETWORK_UNENFORCEABLE };
      }
      return {
        ok: true,
        provider: HOST_NATIVE,
        verified: false,
        exec: { mode: 'host-process', env: {}, mounts: [], warning: WRITE_UNENFORCEABLE },
      };
    },
  };
}

function containerProvider(options) {
  const o = options || {};
  return {
    name: CONTAINER,
    probe: function (opts) {
      const detected = detectRuntime(Object.assign({}, o, opts));
      if (!detected.runtime) {
        return emptyProbe(CONTAINER, {
          reason: 'no_container_runtime',
          detail: { searched: detected.searched, path_env: String(process.env.PATH || '').slice(0, 400) },
          notes: ['容器隔离 provider 接口完整，但本机检测不到 docker/podman，必须 fail-closed'],
        });
      }
      const canary = (opts && opts.canary) || o.canary;
      if (typeof canary !== 'function') {
        // 有运行时 ≠ 有隔离：没跑 canary 之前只能是未验证
        return emptyProbe(CONTAINER, {
          reason: 'canary_not_executed',
          detail: { runtime: detected.runtime, runtime_path: detected.path, searched: detected.searched },
          notes: ['检测到容器运行时，但没有 canary 运行器：不跑实测就不给 verified'],
        });
      }
      let measured = null;
      try { measured = canary({ provider: CONTAINER, runtime: detected.runtime, runtime_path: detected.path }); }
      catch (error) { return emptyProbe(CONTAINER, { reason: 'canary_failed', detail: { runtime: detected.runtime, error: String((error && error.message) || error) } }); }
      const m = measured || {};
      const verified = m.write_inside === true && m.write_outside === false && m.network_direct === false && m.network_via_proxy === true;
      return emptyProbe(CONTAINER, {
        engine_version: m.engine_version || null,
        tested_at: m.tested_at || nowIso(),
        write_inside: m.write_inside === true ? true : m.write_inside === false ? false : null,
        write_outside: m.write_outside === true ? true : m.write_outside === false ? false : null,
        network_direct: m.network_direct === true ? true : m.network_direct === false ? false : null,
        network_via_proxy: m.network_via_proxy === true ? true : m.network_via_proxy === false ? false : null,
        verified: verified,
        reason: verified ? 'verified' : 'canary_results_below_expectation',
        detail: { runtime: detected.runtime, runtime_path: detected.path, expected: 'write_inside=true, write_outside=false, network_direct=false, network_via_proxy=true' },
      });
    },
    capabilities: function () { return capabilitiesFromProbe(this.probe()); },
    wrap: function (task, grant, opts) {
      const cfg = Object.assign({}, o, opts || {});
      const probe = this.probe(opts);
      if (!probe.verified) {
        const reason = probe.reason === 'no_container_runtime' ? 'no_container_runtime' : 'isolation_unverified';
        return {
          ok: false, provider: CONTAINER, reason: reason, needs_human: true, probe: probe,
          message: probe.reason === 'no_container_runtime'
            ? '缺少可执行后端：需要安装 Docker 或 Podman，或把任务改成离线任务'
            : '隔离未验证（canary 未通过），不能据此启动任务',
        };
      }
      const mounts = mountsFor(task, grant, cfg);
      if (!mounts.length) return { ok: false, provider: CONTAINER, reason: 'grant_roots_missing', needs_human: true };
      const wantsNetwork = requiresNetwork(task, grant);
      const network = wantsNetwork ? (cfg.taskNetwork || 'agentbus-task-net') : 'none';
      const runtime = (probe.detail && probe.detail.runtime) || cfg.runtime || 'docker';
      const image = cfg.image || 'agentbus/task:latest';
      const user = cfg.user || '65534:65534';
      const argv = [
        'run', '--rm',
        '--user', user,
        '--read-only',
        '--tmpfs', '/tmp:rw,noexec,nosuid,size=256m',
        '--cap-drop', 'ALL',
        '--security-opt', 'no-new-privileges',
        '--network', network,
      ];
      const seen = new Set();
      for (const mount of mounts) {
        if (seen.has(mount.source)) continue;
        seen.add(mount.source);
        argv.push('-v', mount.source + ':' + mount.target + ':rw');
      }
      argv.push('-w', mounts[0].target, image);
      return {
        ok: true, provider: CONTAINER, verified: true, runtime: runtime,
        exec: {
          mode: 'container',
          runtime: runtime,
          argv: argv,
          mounts: mounts,
          network: network,
          env: wantsNetwork && cfg.proxyUrl ? { HTTP_PROXY: cfg.proxyUrl, HTTPS_PROXY: cfg.proxyUrl } : {},
          readOnlyRoot: true,
          privileged: false,
        },
      };
    },
  };
}

export function providerNamed(name, options) {
  if (name === CONTAINER) return containerProvider(options);
  if (name === HOST_NATIVE) return hostNativeProvider(options);
  throw new Error('isolation_provider_unknown: ' + String(name));
}

export function providers(options) {
  return { 'host-native': providerNamed(HOST_NATIVE, options), container: providerNamed(CONTAINER, options) };
}

// adapter 统一入口：拿到 probe 结果 + 由它推导的 capability（不含任何自述布尔）
export function resolveCapability(options) {
  const o = options || {};
  const name = o.provider || HOST_NATIVE;
  const provider = providerNamed(name, o);
  const probe = o.probe || provider.probe(o);
  return { provider: provider, probe: probe, capability: capabilitiesFromProbe(probe) };
}

export { NETWORK_UNENFORCEABLE, WRITE_UNENFORCEABLE };
