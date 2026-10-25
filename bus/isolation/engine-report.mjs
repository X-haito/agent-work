// doctor --probe-engine 的逻辑层（CLI 只负责打印，测试直接断言这份报告）
// 诚实标注：本机没有可安全实测的 CLI / 容器运行时，所以 verified 一定是 false。
import * as Iso from './provider.mjs';
import * as Codex from '../engines/codex.mjs';
import * as Claude from '../engines/claude.mjs';
import * as Dsh from '../engines/dsh.mjs';

export const REPORT_VERSION = 1;

export function reportEngines(options) {
  const o = options || {};
  const probes = {
    'host-native': Iso.providerNamed(Iso.HOST_NATIVE, o).probe(o),
    container: Iso.providerNamed(Iso.CONTAINER, o).probe(o),
  };
  const engineList = [['codex', Codex], ['claude', Claude], ['dsh', Dsh]];
  const engines = engineList.map(function (pair) {
    const name = pair[0];
    const caps = pair[1].capabilities(o);
    return {
      engine: name,
      provider: caps.provider,
      probe_version: caps.probe_version,
      verified: caps.verified === true,
      strongWriteIsolation: caps.strongWriteIsolation === true,
      networkIsolation: caps.networkIsolation === true,
      reason: caps.reason,
      next_step: Iso.nextStepFor(caps.reason),
      probe: caps.probe,
    };
  });
  const detected = Iso.detectRuntime(o);
  return {
    report_version: REPORT_VERSION,
    generated_at: new Date().toISOString(),
    verified: engines.every(function (e) { return e.verified === true; }),
    engines: engines,
    probes: probes,
    runtime: { runtime: detected.runtime, path: detected.path, searched: detected.searched },
    requirements: Iso.VERIFIED_REQUIREMENTS,
    note: engines.every(function (e) { return e.verified === true; })
      ? 'verified=true'
      : 'verified=false —— 本机隔离未验证；下面的 requirements 是变成 verified=true 的条件',
  };
}
