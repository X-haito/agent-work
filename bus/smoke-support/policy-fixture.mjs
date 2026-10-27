// 套件基线策略：优先用运行时的 bus/policy.json，缺失时退回 bus/policy.example.json。
// CI 里 policy.json 不存在（它是 gitignored 的运行时配置），直接 copy 会 ENOENT —— 这已经
// 让三个套件在 CI 上红过一次。任何"需要一个可用 policy"的测试都应该走这里。
import fs from 'node:fs';
import path from 'node:path';

export function policySource(busDir) {
  const dir = busDir || path.join(path.dirname(new URL(import.meta.url).pathname).replace(/^\//, ''), '..');
  const real = path.join(dir, 'policy.json');
  if (fs.existsSync(real)) return real;
  const example = path.join(dir, 'policy.example.json');
  if (fs.existsSync(example)) return example;
  throw new Error('找不到 policy.json 或 policy.example.json: ' + dir);
}

export function writePolicyFixture(target, busDir) {
  fs.copyFileSync(policySource(busDir), target);
  return target;
}
