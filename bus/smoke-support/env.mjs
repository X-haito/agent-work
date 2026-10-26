// 测试环境工厂（第 11 项第 1/4 条）：一个套件 = 一个独立临时目录 + 全套状态变量 + 一个动态端口。
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { BUS_ROOT } from './isolation-guard.mjs';

// 允许 listen(0)，禁止写死端口：父进程先拿到空闲端口再传下去。
export function allocatePort() {
  return new Promise(function (resolve, reject) {
    const server = net.createServer();
    const done = function (port) { server.close(function () { resolve(port); }); };
    server.once('error', reject);
    server.listen(0, '127.0.0.1', function () { done(server.address().port); });
  });
}

export async function allocatePorts(count) {
  const ports = [];
  for (let i = 0; i < Math.max(1, Number(count) || 1); i++) ports.push(await allocatePort());
  return ports;
}

// 子进程环境：HOME/状态文件/生命周期/端口/守卫全部指向这个临时目录。
export function suiteEnv(dir, options) {
  const o = options || {};
  const env = Object.assign({}, o.base || process.env);
  env.HOME = dir;
  env.USERPROFILE = dir;
  env.TMPDIR = o.tmpDir || env.TMPDIR;
  env.TEMP = env.TMPDIR || env.TEMP;
  // 目标目录可能还不存在，模块会在第一次 open/load 时读到真实文件而失败 —— 这里先建好并铺一份基线。
  fs.mkdirSync(dir, { recursive: true });
  env.BUS_DB = path.join(dir, 'bus.db');
  env.BUS_PROJECTS = path.join(dir, 'projects.json');
  env.BUS_POLICY_PATH = path.join(dir, 'policy.json');
  env.BUS_LIFECYCLE = path.join(dir, 'lifecycle.json');
  // 基线种子：策略与 registry 从仓库复制一份到临时目录（只读基线，写操作全部落在临时目录）。
  // 这样"注入全套变量"不等于"变量指向不存在的文件"，套件不必为了能启动而复述一遍路径逻辑。
  if (o.seed !== false) {
    const seedPolicy = path.join(BUS_ROOT, 'policy.json');
    const seedProjects = path.join(BUS_ROOT, 'projects.json');
    try { if (!fs.existsSync(env.BUS_POLICY_PATH)) fs.copyFileSync(seedPolicy, env.BUS_POLICY_PATH); } catch (error) { /* 没有真实策略就留空 */ }
    try { if (!fs.existsSync(env.BUS_PROJECTS)) fs.writeFileSync(env.BUS_PROJECTS, fs.existsSync(seedProjects) ? fs.readFileSync(seedProjects) : '{"projects":{}}\n'); } catch (error) {}
  }
  if (o.port != null) env.AGENTBUS_TEST_PORT = String(o.port);
  if (o.guard !== false) env.AGENTBUS_TEST_GUARD = '1';
  // HOME 换了以后 git 读不到 ~/.gitconfig：给个身份，否则依赖 git 的套件会假失败。
  env.GIT_AUTHOR_NAME = 'smoke-all';
  env.GIT_AUTHOR_EMAIL = 'smoke-all@localhost';
  env.GIT_COMMITTER_NAME = 'smoke-all';
  env.GIT_COMMITTER_EMAIL = 'smoke-all@localhost';
  delete env.AGENT_BUS_TOKEN;
  delete env.AGENT_BUS_ID;
  return env;
}

export const STATE_ENV_NAMES = ['BUS_DB', 'BUS_PROJECTS', 'BUS_POLICY_PATH', 'BUS_LIFECYCLE', 'AGENTBUS_TEST_GUARD'];
