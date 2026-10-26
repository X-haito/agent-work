# AgentBus

AgentBus 是一个本地多 Agent 协作总线，让 Codex、Claude Code 和 DSH 共用任务状态、权限规则、执行证据与 Token 账本。

它解决的是协作问题，不替代模型本身：

- Lead 负责拆解、派发、验收和仲裁。
- Worker 自动认领、执行、自测并提交证据。
- Human 控制启停、红线审批和最终决策。
- 网页看板用于创建任务、调整 Lead/权限、管理项目和查看每个任务的 Token 消耗。

> AgentBus 默认关闭。只有 Human 在本地看板明确启用后，才允许派发和认领新任务。

## 功能

- 本地 stdio MCP，零第三方运行依赖
- SQLite 任务状态机、租约和并发认领
- Codex / Claude Code / DSH supervisor 自动唤醒
- 任务创建、编辑、改派、取消和验收
- 动态 Lead 与权限配置
- 危险操作事前审批和执行后文件审计
- 按任务、Agent、项目统计输入与输出 Token
- 定向消息路由、重复进展合并和低风险自动验收
- 仅监听 `127.0.0.1` 的管理看板

## 要求

- Node.js 24 或更高版本
- 至少安装一个执行端：Codex CLI、Claude Code 或 DSH；默认配置还需要一个非 Lead 的 Worker
- Windows 可直接使用 `start-board.cmd`；其他系统运行 Node 命令

## 快速开始

### 1. 获取代码并检查环境

```powershell
git clone git@github.com:X-haito/agent-work.git
cd agent-work
node --version
```

Node.js 应为 24 或更高版本。只需安装你实际使用的执行端，可用 `codex --version`、`claude --version` 或 `dsh --version` 检查。

默认 Lead 是 `codex/main`，Lead 不认领 Worker 任务。因此默认配置至少还要安装并启动 Claude Code 或 DSH。若只有 Codex，可先在看板把 Lead 改为 `human`，再把任务指派给 `codex/main`。

### 2. 启动看板

```powershell
node bus/board.mjs
```

打开 [http://127.0.0.1:7400](http://127.0.0.1:7400)，在看板中：

1. 登记项目；
2. 配置 AgentBus MCP；
3. 确认 Lead 和 Agent 权限；
4. 点击“启用 AgentBus”。

Windows 也可以双击 `start-board.cmd`，它默认使用 7401 端口。

如果使用 `start-board.cmd`，打开的是 [http://127.0.0.1:7401](http://127.0.0.1:7401)；直接运行 `node bus/board.mjs` 时使用 7400。

### 3. 启动需要的 supervisor

```powershell
node bus/codex-supervisor.mjs --daemon
node bus/claude-supervisor.mjs --daemon
node bus/dsh-supervisor.mjs --daemon
```

只启动已经安装并准备使用的执行端，不要求三个全部运行。启动成功后，看板“在线 Agent”中会出现对应身份。不要把任务指派给当前 Lead；Lead supervisor 不会认领 Worker 任务。

当前 Lead 只处理拆解、派发、验收与仲裁，不会抢 Worker 的任务。修改 `bus/policy.json` 中的 `lead` 后，各 supervisor 会在下一轮自动读取。

### 4. 创建任务

在看板“任务”页填写：

- 标题和要求
- 项目
- 指派 Agent
- 成本档位
- 写入范围
- 子代理上限

保存后，目标 supervisor 会自动唤醒对应 Agent。涉及删除、依赖安装、危险 Git、受保护配置或外网访问的任务会进入待批状态。

首次验证建议选择 `standard`，写入范围只填项目内的相对路径。当前网页还不能填写 `verify_cmd`、`extra_dirs` 和细粒度授权；默认开启 `require_verify_cmd` 时，`mechanical`、`tests`、`docs` 三类任务会因缺少 `verify_cmd` 被拒绝。完整字段支持已列入 [dsh-todo-list.md](dsh-todo-list.md)。

## 安装、诊断与版本（第 12 项）

`package.json` 是**版本号唯一来源**（`agentbus version` 直接读它；MCP `serverInfo.version` 与看板 API 待第 13 项接入后同样引用这一处）。包名 `agentbus`，`bin` 指向 `bus/cli.mjs`，要求 Node >= 24。

```powershell
node bus/cli.mjs init      # 建运行目录 + 数据库 + projects registry，并按 managed-block 写法配置 MCP
node bus/cli.mjs doctor    # 只诊断、不改任何东西；每项给修复命令；--json 输出结构化结果
node bus/cli.mjs start     # 启动看板并打印一次性登录链接（仅本次启动有效）
node bus/cli.mjs version   # 版本号（--json 附带 node 版本）
```

`init` 的**每一步**都写进 `bus/install-manifest.json`（创建/修改的文件、sha256、备份路径、结果、时间），它是 `uninstall` 的唯一依据：

- 已存在且启用的 MCP 配置记为 `kept`，不会覆盖你手改过的内容；
- 缺少 `policy.json` 时从 `bus/policy.example.json` 复制一份（**默认策略示例，请按需修改**；复制时会去掉以 `_` 开头的说明字段）；
- 重复执行是幂等的：同一路径在 manifest 里只保留一条最新记录。

```powershell
node bus/cli.mjs uninstall                # 只移除 manifest 记录过的 managed block；数据库/策略保留
node bus/cli.mjs uninstall --purge-data --yes   # 连数据库与策略一起删（缺 --yes 会先列出待删文件）
node bus/cli.mjs release-check            # 打包清单 + doctor + 全量 smoke + npm pack 检查
```


`doctor` 覆盖 Node 版本、三个 Agent CLI（**只扫 PATH，不执行外部程序**）、看板端口占用、SQLite 可写性与 WAL、schema 版本、策略校验、项目路径、MCP 配置与权限、凭据、supervisor 心跳。任何 FAIL 都会让退出码为 1。它**从不自动修改**任何东西——数据库不存在时也不会顺手建一个。

### 发布包不含什么

`package.json` 的 `files` 是显式白名单，只打包 `bus/**/*.mjs`、`bus/schema.sql`、`bus/ui/*.css`、`README.md`、`package.json`。**不会**打包运行数据：`bus.db`（及 `-wal/-shm`）、`bus/logs/`、`bus/projects.json`、`bus/policy.json`、`bus/workspaces/`、`install-manifest.json`、`*.bak-*`、`*.tmp-*`。`bus/smoke-install.mjs` 会按这份白名单真实枚举一次仓库文件，确认上述敏感项一个都没被带进去。

> 第 13 项要接入的官方 MCP v2 与 Zod v4 在 `package.json` 的 `dependenciesReservedForItem13` 里**只占位不写假版本号**；真正锁定版本在接入那张卡里做。
## MCP 手动配置

通常直接在看板“MCP 配置”页操作。需要手动配置时，将示例路径替换为仓库绝对路径。

Codex `~/.codex/config.toml`：

```toml
[mcp_servers.agentbus]
command = "node"
args = ["C:/path/to/agent-work/bus/bus-mcp.mjs", "--agent", "codex/main"]
```

Claude Code：

```powershell
claude mcp add --scope user agentbus -- node C:/path/to/agent-work/bus/bus-mcp.mjs --agent claude/main
```

DSH 的交互式 MCP 配置由看板写入；无头任务使用 `bus/dsh-supervisor.patch.yml`，认领、续租和状态回报由 supervisor 负责。

## 工作流

```text
Human 创建需求
  → Lead 拆解并 bus_dispatch
  → Worker supervisor 自动唤醒并认领
  → Worker 执行、测试、提交证据
  → guard / verify_cmd 自动检查
  → 自动验收，或 Lead / Human 审核
  → Lead 向用户合并汇报
```

通信遵循六层分离：

```text
长背景 → 文档
任务要求 → 简短结构化派单
过程进展 → 状态更新
详细日志 → 文件
Agent 结果 → 证据摘要
用户输出 → Lead 合并汇报
```

## 安全边界

以下操作默认需要 Human 批准：

- 删除文件或目录
- 安装或升级依赖
- `git push`、`git rebase`、`git reset --hard`、强制推送
- 修改 `RULES.md`、`bus/policy.json`、`projects.json`、`schema.sql`
- 工作目录外写入
- 命令级识别到的外网访问

Supervisor 会在执行前后比较文件快照。越权修改会使任务失败；改动面过大则标记为必须人审。详细规则见 [RULES.md](RULES.md)。

## 主要文件

| 文件 | 作用 |
|---|---|
| `bus/bus-mcp.mjs` | MCP stdio 服务 |
| `bus/store.mjs` | SQLite 状态机与守卫 |
| `bus/console-server.mjs` | 看板 API |
| `bus/board-ui.mjs` | 看板界面 |
| `bus/*-supervisor.mjs` | Agent 自动唤醒与执行 |
| `bus/policy.json` | Lead、权限、自治和成本策略 |
| [AGENTS.md](AGENTS.md) | Agent 运行协议 |
| [RULES.md](RULES.md) | 权限、安全和验收规则 |
| [dsh-todo-list.md](dsh-todo-list.md) | 待完成工作与实现框架 |

运行产生的 `bus.db`、日志、项目注册表和工作区不会进入 Git。

## 验证

全量回归只有一个入口（自动发现并运行 `bus/smoke*.mjs`，数字以运行时输出为准，本文不再手写）：

```powershell
node bus/smoke-all.mjs            # 人读汇总
node bus/smoke-all.mjs --json     # 机器读汇总
node bus/smoke-all.mjs --strict   # CI 用：需要管道/端口的套件被跳过也算失败
```

依赖管道 stdio 或端口的套件在受限环境会记为 `SKIP + reason`，不会算成通过。

也可以运行：

```powershell
node bus/cli.mjs status
node bus/cli.mjs agents
node bus/cli.mjs board
node bus/cli.mjs cost
```


## 状态词

文档里只用这四个词描述能力，禁止用「已完成/已启用」这类模糊说法代替其中任何一个：

| 词 | 含义 |
| --- | --- |
| `implemented` | 代码存在，且有数据层/单元测试 |
| `wired` | MCP / CLI / 看板三条入口里至少一条真的会走到这段代码 |
| `enabled` | 默认配置下真的会生效（策略开关打开、阈值非 0、有执行路径） |
| `verified` | 有自动化测试在当前仓库跑出数字，并被 `bus/smoke-docs.mjs` 校验 |

当前四项能力的四词矩阵与证据见 [bus/DELIVERY-STATUS.md](bus/DELIVERY-STATUS.md)。**四项的 `enabled` 都是 `false`**：
预算（`daily_token_budget` 未配置）、认证（`require_credentials=false`）、归档（`retention` 全 0）、合并（只允许 Human 发起、runner 未接线）。

数字（工具数、套件数、断言数、端口、Lead）一律以运行时导出为准，本文不手写：

```powershell
node bus/smoke-docs.mjs --print-facts   # 打印运行时事实，供文档引用
node bus/smoke-docs.mjs                 # 校验文档与运行时一致
```

## 当前限制

AgentBus 仍是本地优先的早期版本。身份认证、严格执行隔离、预算硬限制、配置字段完整落地、MCP 标准化返回和发布流程仍需完善，详见 [dsh-todo-list.md](dsh-todo-list.md)。


### 测试隔离合同（第 11 项）

- **新套件必须用 `bus/smoke-support/bootstrap.mjs`**：先 `assertEnvironmentComplete` 再动态 `import()` 状态模块。
- 老套件沿用显式临时路径（`S.openDb(tmp)` / 自己设 `BUS_*`），由运行期守卫兜底。
- 两种写法**不等价**：静态 import 会冻结模块层路径（`LIFECYCLE_FILE` 等），守卫会在使用点抛错；bootstrap 从根上避免这件事。
- `AGENTBUS_TEST_GUARD=1` 下，任何指向真实 `bus.db` / `policy.json` / `projects.json` / `lifecycle.json` 的解析都立即抛 `IsolationError`。
- **套件级 SKIP**：某一步在本机确实做不到时，套件打印 `SKIP_SUITE: <reason>` 并以 0 退出；
  `smoke-all` 会把它记成 `skipped`（不是 `passed`），`--strict` / `--profile ci` / `--require` 下视为失败。
  断言级 SKIP 只是少几条断言，套件级 SKIP 会让整棵树看起来是绿的——两者都必须显式可见。
- 套件环境由 `bus/smoke-support/env.mjs` 的 `suiteEnv(dir,{port})` 生成：独立临时目录 + 四个状态变量 + 动态端口（`listen(0)`，禁止写死）。
## 许可证

本项目使用 **Apache License 2.0**，全文见仓库根目录的 [`LICENSE`](./LICENSE)。

- 允许商用、修改、分发、私用，并附带专利授权；
- 分发时须保留版权与许可声明，修改过的文件须注明「已修改」；
- 附带免责声明，不提供任何担保。

`package.json` 的 `files` 白名单已包含 `LICENSE`，`npm pack` 产物会带上它。

