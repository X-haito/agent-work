# Changelog

本文件记录 AgentBus 的版本变更。版本号唯一来源是 `package.json`（`agentbus version` / MCP `serverInfo.version` / 看板 API 同源）。

## 1.0.0

首个可安装版本。安装、诊断、卸载与发布检查闭环。

### 安装与诊断

- 新增 `package.json`：`type: module`、`engines.node >= 24`、`bin.agentbus`、显式 `files` 白名单（不含数据库、日志、项目注册表、策略、工作区、备份与临时文件）。
- 新增 `agentbus init`：创建运行目录/数据库/projects registry，按 managed-block 写法配置 Codex/Claude/DSH 的 MCP，**每一步写 `install-manifest.json`**（创建/修改的文件、sha256、备份路径），重复执行幂等且不覆盖用户手改内容。
- 新增 `bus/policy.example.json`：`init` 在缺少 `policy.json` 时复制为正式策略（默认示例，需按需修改），全新安装后 `doctor` 不再有 FAIL。
- 新增 `agentbus doctor`：10 项结构化检查（Node 版本、Agent CLI、端口、SQLite 可写性与 WAL、schema 版本、策略、项目路径、MCP 配置与权限、凭据、supervisor 心跳），每项给出修复命令，**只诊断不修改**，支持 `--json` 与非零退出码。`--auth-readiness` 保留原认证就绪检查。
- 新增 `agentbus uninstall`：只删除 manifest 记录过的 managed block 与运行文件；文件在安装后被改过（sha256 不一致）则拒绝删除并提示；默认保留数据库与策略，`--purge-data --yes` 才清理。
- 新增 `agentbus start` / `agentbus version`。

### 发布

- 新增 `bus/release-check.mjs` 与 `agentbus release-check`：打包清单检查（`package.json files` 真实枚举 + 敏感文件规则）、`doctor --json`、全量 smoke、`npm pack --dry-run`（本机无 npm 时如实标 SKIP）。
- 新增本 CHANGELOG。

### 看板与前端

- 看板 CSS 抽出为 `bus/ui/styles.css` / `bus/ui/denied.css`，由白名单静态路由服务（MIME + nosniff + 内容 hash 长缓存）；`AGENTBUS_UI_INLINE=1` 可一键回到内联产物。CSP 已下发，`script-src` 的收紧留给下一阶段的脚本抽离。

### 合并与归档

- 合并执行链路打通：`merge-worker` + `agentbus merge preflight|run|status|recover`；runner 不再接受调用方传入的验证结论（只从库里读最新成功且 hash 匹配的 frozen verification）；`finishMerge` 为单条 CAS UPDATE。
- 二级保留（快照/归档包）与旧日志 inventory 上线，仍被 `task_archives` 引用的文件不可删除，不可归属日志只上报。

### 已知限制

- `LICENSE` 与 `.github/workflows` 尚未加入（需人工确认）。
- 第 13 项依赖（官方 MCP v2 / Zod v4）只在 `package.json` 的 `dependenciesReservedForItem13` 占位，未锁定版本。
- `npm pack` 检查依赖本机 npm；CI 环境应把它作为硬门禁。
