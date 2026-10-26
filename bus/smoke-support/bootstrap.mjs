// 测试 bootstrap（第 11 项第 3 条）：**先设环境，再动态 import 状态模块**。
// 为什么必须动态：ESM 的静态 import 会先于任何语句执行，模块层的 BUS_DIR / POLICY_PATH /
// LIFECYCLE_FILE 在 import 那一刻就定死了 —— task-67 的真实 lifecycle.json 就是这么被写的。
import { assertEnvironmentComplete } from './isolation-guard.mjs';
import { suiteEnv, allocatePort } from './env.mjs';

// 约定（第 11 项）：**新套件必须用本模块**；老套件沿用显式临时路径（S.openDb(tmp) / 自己设 BUS_*），
// 由 isolation-guard 的运行期守卫兜底。两者**不等价**：静态 import 会冻结模块层路径（LIFECYCLE_FILE 等），
// 守卫只能在"使用点"抓住它；bootstrap 从根上避免。
//
// 用法：const { store, adminConfig, consoleServer } = await bootstrap(tmpDir);
// 返回的模块保证是在隔离环境生效之后才载入的。
export async function bootstrap(dir, options) {
  const o = options || {};
  const port = o.port != null ? o.port : await allocatePort();
  const env = suiteEnv(dir, Object.assign({}, o, { port: port }));
  for (const key of Object.keys(env)) {
    if (env[key] === undefined) delete process.env[key];
    else process.env[key] = env[key];
  }
  if (o.assertComplete !== false) assertEnvironmentComplete(process.env);
  const store = await import('../store.mjs');
  const adminConfig = o.adminConfig === false ? null : await import('../admin-config.mjs');
  const consoleServer = o.consoleServer === false ? null : await import('../console-server.mjs');
  return { env: env, port: port, store: store, adminConfig: adminConfig, consoleServer: consoleServer };
}

// 只想拿环境、稍后自己 import 的场景。
export function prepareEnv(dir, options) {
  const port = (options && options.port) != null ? options.port : null;
  const env = suiteEnv(dir, Object.assign({}, options || {}, { port: port }));
  for (const key of Object.keys(env)) {
    if (env[key] === undefined) delete process.env[key];
    else process.env[key] = env[key];
  }
  return env;
}
