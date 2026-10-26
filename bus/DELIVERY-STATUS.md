# 交付状态矩阵（由 smoke-docs 校验）

> 每一行都必须能被 `node bus/smoke-docs.mjs` 校验。
> **四列语义严格区分**：代码存在 ≠ 接线 ≠ 启用 ≠ 验证过。
> `enabled=yes` 的行，**开关列写的策略路径必须在 bus/policy.json 里真的开启**，这条由 smoke-docs 自动断言——
> 以后没人能把"代码完成"改写成"已启用"。
> 取值为 `yes` / `no` / `partial`；证据列写"套件 数字"或 `无`。
> 覆盖范围：dsh-todo-list.md 现存编号 **3–15（13 项）**；清单里没有 1、2 两项，本表不为不存在的条目编状态。

| 项 | 能力 | implemented | wired | enabled | verified | 开关 | 证据 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 3 | 执行隔离（claim→grant→快照→spawn，隔离 provider） | yes | yes | yes | no | global.dispatch_enabled | smoke-engines.mjs 30/0 |
| 4 | 机械验收来源（冻结验证器 + guard 快照） | yes | yes | yes | yes | always | smoke-verifier.mjs 13/0 |
| 5 | 身份认证与权限来源 | yes | yes | no | yes | global.require_credentials | smoke-auth.mjs 16/0 · smoke-enable-drill.mjs 19/0（临时环境演练：数据层拒绝 + 源码闸门，未走真实 MCP 进程） |
| 6 | 网络目标白名单（egress proxy + network_events） | yes | yes | no | no | network.default | smoke-network-policy.mjs 94/0 |
| 7 | 轮次 / 消息链 / 重试上限 | yes | yes | yes | yes | economics.max_rounds_per_task | smoke-limits.mjs 70/0 |
| 8 | Token 预算硬守卫（日预算 + 任务预算 + 预留） | yes | yes | no | no | economics.daily_token_budget | smoke-budget.mjs 67/0 · smoke-enable-drill.mjs 19/0（临时环境演练：预留会被夹住；未证明 supervisor 拒绝后不 spawn CLI） |
| 9 | 评审路由策略 | yes | yes | yes | yes | economics.peer_review | smoke-review-routing.mjs 58/0 |
| 10 | 数据保留与归档 | yes | yes | no | partial | retention.terminal_task_days | smoke-retention.mjs 99/0 · smoke-enable-drill.mjs 19/0（临时环境演练：开关打开后删数与计划精确相等） |
| 11 | 全局 Lead 与合并流程 | yes | yes | no | partial | permissions.merge | smoke-merge.mjs 34/0 |
| 12 | 安装 / 诊断 / 发布 | yes | yes | yes | partial | always | smoke-install.mjs 80/0 |
| 13 | MCP 协议兼容性 | yes | yes | yes | no | always | 无 |
| 14 | 看板前端拆分与可访问性 | yes | yes | yes | partial | always | smoke-ui-static.mjs 53/0 |
| 15 | 脏数据 / 配置漂移 / 运行维护（策略单一声明、迁移版本化） | yes | yes | yes | yes | always | smoke-policy-roundtrip.mjs 21/0 |

## 四列怎么读

- **implemented**：代码存在（有数据层或单元测试）。
- **wired**：生产路径真的会走到（MCP / CLI / 看板 / supervisor 至少一条），不是只有测试调用。
- **enabled**：**当前配置**下默认生效。开关列给出的策略路径此刻必须为真，否则本列只能是 `no`。
- **verified**：在当前仓库端到端跑出数字并被 smoke-docs 校验；`partial` 表示数据层/具名场景测过、真实环境那一环没跑。

## enabled=no / partial 的具体原因

- **3 执行隔离**：三引擎 adapter 能力一律由 `bus/isolation/provider.mjs` 的 probe 推导；本机没有可安全实测的 CLI、也没有容器运行时，`verified=false`，强隔离类任务（extra_dirs / 删除 / 配置授权）一律 fail-closed 到 `proposed + needs_human`。
- **5 认证**：`global.require_credentials=false`——凭据、审计、staged 轮换全部就位，但尚未强制 MCP 带凭据。
- **6 网络**：`network.default=deny` 是"默认关"，三个引擎 `networkIsolation=false`（无法阻止子进程绕过代理直连），联网任务停在 `proposed + needs_human`；`network_events` 只审计不强制，且不记 Authorization/Cookie/query。
- **8 预算**：`economics.daily_token_budget=null`、任务 `token_budget` 默认不设，数据层与 supervisor 硬门就绪但没有额度就不拦；端到端未验证。
- **10 归档**：`policy.retention` 全为 0（0 = 不清理），引擎、不可变计划、drain/lease、真实损坏库夹具都已测过，但默认不删任何东西。
- **11 合并**：`permissions.merge=[human]`，数据层与 Human 审批就绪，生产执行链路未接通（`runMerge` 只有测试在调）。
- **13 MCP**：本机 spawn 受限，`smoke-mcp.mjs` 判 SKIP——**SKIP 不是 PASS**，所以 verified=no。

## 三个阻塞项（等 Human，不是代码问题）

1. **LICENSE**：仓库根缺 LICENSE 文件，需 Human 决定许可类型后添加。
2. **`.github/workflows/`**：CI 工作流需要 Human 批准后才提交（涉及外部服务与凭据）。
3. **第 3/6 项真实 canary**：需要 Docker/Podman 才能把隔离 provider 从 `verified=false` 变成 `true`；`VERIFIED_REQUIREMENTS` 已写进 `bus/isolation/provider.mjs`，`node bus/cli.mjs doctor --probe-engine` 可随时复测。

## 关于"临时环境演练"证据

`smoke-enable-drill.mjs` 证明的是**机制开了有用**（临时 db + 临时 policy 下：预留被额度夹住 / human 无凭据被拒 / 归档删数与计划精确相等），
它**不构成** `verified=yes`——`verified` 的定义是"当前环境端到端跑通过"，而演练仍有两个明确缺口：

- 预算：只证明数据层会拒，**未证明 supervisor 拒绝后真的不 spawn CLI**（硬门的意义正在这一环）；
- 认证：只证明数据层 + 源码闸门，**未走真实 MCP 进程**。

把"临时演练通过"写成 `verified=yes`，就是"看起来绿了其实没测到"。所以这几行的 `verified` 保持 `no` / `partial`，只把演练写进证据列。

## 状态词

定义见 [README.md](../README.md) 的「状态词」一节；本表与 README 必须同时出现 implemented / wired / enabled / verified 四个词。

## 第 7 项：真实浏览器验收（待 CI 证据）

- 套件：`bus/smoke-browser.mjs`（零依赖 CDP，Chrome/Edge 自动探测，找不到就 SKIP）。
- 本机：沙箱禁止命名管道，Chrome/Edge 均无法启动 → 套件 SKIP（`sandbox_blocks_named_pipes`），**不伪装通过**。
- 通过标准：`node bus/smoke-browser.mjs --require-browser` 在能跑浏览器的环境全绿（SKIP 视为失败）。
- 回滚开关 `AGENTBUS_UI_INLINE` 与 `bus/ui/app.js`：**保留**，理由见 `bus/ui/ROLLBACK.md` 同名小节。
