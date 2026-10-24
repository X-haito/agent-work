# AgentBus 规则

本文是 Human 与 Agent 共用的规则来源。`bus/policy.json` 保存可调参数；两者冲突时，以本文的安全边界为准。

## 1. 角色与权限

| 角色 | 职责 | 不做 |
|---|---|---|
| Human | 启停总线、设置规则、批准红线、最终决策 | 不负责日常执行 |
| Lead | 拆解、派发、验收、仲裁、合并汇报 | 不抢 Worker 任务，不写业务代码 |
| Worker | 认领、实现、自测、提交证据 | 不自行验收，不绕过 Lead 扩大范围 |

Lead 由 `policy.json.lead` 决定，默认是 `codex/main`，可在看板修改。

四项权限：

| 权限 | 含义 | 默认 |
|---|---|---|
| `dispatch` | 创建和派发任务 | Lead |
| `accept` | 批准普通待批任务、验收 review | Lead + Human |
| `merge` | 合入主干的决策权 | Human |
| `reassign` | 改派和仲裁 | Lead |

红线任务、`needs_human=1` 的任务以及人类放行操作只能由 Human 处理。

## 2. 运行开关与主流程

AgentBus 默认关闭。关闭后：

- 不允许创建、派发、认领、批准或改派新任务；
- 已在执行的任务可以续租、提交结果并进入排空状态；
- 看板、报告和历史数据仍可读取。

启用后的主流程：

```text
Human 创建需求
  → Lead 用 bus_dispatch 拆成任务卡
  → 普通任务进入 open；红线任务进入 proposed
  → Worker supervisor 唤醒并 bus_claim
  → Worker 执行、自测、提交证据到 review
  → guard 和 verify_cmd 检查
  → 自动验收，或 Lead / Human 判定 done / failed
  → Lead 合并用户汇报
```

## 3. 状态机

| 从 | 到 | 执行者与条件 |
|---|---|---|
| — | `open` | Human 创建或 Lead 派发，且无红线、接收方允许自动接单 |
| — | `proposed` | 命中红线、自治关闭、配额满或派发总闸关闭 |
| `proposed` | `open` | Human 或有批准权的 Agent；红线只能 Human |
| `open` | `claimed` | 目标 Worker 条件认领成功，写入范围不冲突 |
| `claimed` | `in_progress` | owner |
| `in_progress` | `review` | owner，附执行证据 |
| `review` | `done` | 自动验收、Lead 或 Human |
| `review` | `failed` | Lead 或 Human，写明原因 |
| `claimed` / `in_progress` | `open` | 租约过期自动回收 |
| 非终态 | `cancelled` | Human 或有验收权的 Agent |

状态迁移由 `bus/store.mjs` 强制，不能只靠消息声明完成。

## 4. 通信规则

```text
长背景 → 项目文档
任务要求 → 一次结构化派单
过程进展 → bus_update
详细日志 → 文件路径
Agent 结果 → 证据摘要
用户输出 → Lead 合并汇报
```

- `question` 必须定向给当前 Lead 或实际决策人；广播问题只由 Lead 处理。
- `bus_update` 已自动产生状态事件，不再发送同义的 `task.progress` / `task.done`。
- 重复状态与进展在模型启动前合并。
- Worker 的 `task.new` 只用于唤醒 supervisor，不额外消耗“确认收到”回合。
- 详细日志和完整 diff 不进入 Agent 消息；消息只包含路径和证据摘要。
- 低风险、守卫通过且命中 `economics.auto_accept` 的任务由 supervisor 自动验收。

## 5. 安全与审批

### 永不允许

- 上传、输出或提交凭据、Token、私钥和证书；
- 未授权修改生产环境配置或数据；
- 绕过状态机直接篡改 `bus.db`；
- 伪造测试或验收证据。

### 必须由 Human 批准

| 类型 | 示例 | 守卫 kind |
|---|---|---|
| 工作目录外写入 | `extra_dirs` | 路径授权 |
| 删除文件或目录 | `rm -rf`、`Remove-Item`、`git rm` | `fs:delete` |
| 危险 Git | `push`、`rebase`、`reset --hard`、强推 | `git:risky` |
| 安装或升级依赖 | `npm install`、`pip install`、`cargo add` | `dep:install` |
| 修改保护配置 | `RULES.md`、`policy.json`、`projects.json`、`schema.sql` | `cfg:edit` |
| 外网访问 | `curl`、`wget`、`scp` | `net:egress` |

批准按任务、按次生效，并写入 `grants`；不会变成永久权限。

### 执行后审计

Supervisor 在执行前后比较工作目录与批准目录的文件快照：

- 未授权删除、依赖变更、保护配置变更 → `failed` + `redline.blocked`；
- 改动文件超过 `economics.max_changed_files` → `needs_human=1`；
- 守卫通过 → 进入 `review` 或自动验收。

快照看不到范围之外的写入、不落盘的网络动作和远端 Git 操作，因此执行隔离与网络白名单仍列在 [dsh-todo-list.md](dsh-todo-list.md)。

## 6. 验收证据

Worker 提交 review 时至少提供：

- 改动了哪些文件；
- 测试命令和结果；
- 生成的产物或日志路径；
- 剩余阻塞与需要的决策。

验收顺序：

1. guard 检查越权和改动范围；
2. 存在 `verify_cmd` 时执行机械验收；
3. 满足安全条件的低风险任务自动验收；
4. 其余任务由 Lead 或 Human 核对证据。

模型进程退出码为 0 不等于任务完成。证据不足应判失败并指出缺少内容。

## 7. 并发与成本

- 认领使用条件更新，同一任务只能有一个 owner。
- 定向任务不能被其他 Agent 抢走。
- `write_scope` 重叠时拒绝并发认领。
- Supervisor 持续续租；过期任务自动退回 `open`。
- 待机、无关消息、重复状态和 Worker 唤醒信号不得启动模型。
- Token 按实际消耗 Agent、任务和项目记账，不按任务 owner 猜测。
- Lead Token 占比用于发现 Lead 是否承担了过多执行工作，不是输出长度限制。

## 8. 主要配置

| 目的 | 字段 |
|---|---|
| 当前 Lead | `lead` |
| 派发、验收、合并、改派权限 | `permissions.*` |
| 派发总闸、深度、速率 | `global.*` |
| Agent 自治、配额、并发、能力 | `agents.<id>.*` |
| 自动验收类别 | `economics.auto_accept` |
| 自动验收是否强制 `verify_cmd` | `economics.require_verify_cmd` |
| 审计文件数阈值 | `economics.max_changed_files` |
| review 超时升级 | `economics.review_timeout_min` |
| 子代理上限 | `economics.max_subagents` |
| 证据摘要行数 | `economics.report_max_lines` |

`policy.json` 由 supervisor 每轮重读。尚未真正执行的配置字段和实现建议统一记录在 [dsh-todo-list.md](dsh-todo-list.md)，不在本规则中宣称已生效。
