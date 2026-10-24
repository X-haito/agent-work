# Agent Bus 使用指南

## 人工选择使用（默认关闭）

AgentBus 不应参与普通问答、单代理工作或其他团队工具管理的任务。仅在你明确选择交给 AgentBus 协作，并在本地控制台启用后使用。安装/注册 MCP 不等于启用总线。

在本目录运行 `node bus/board.mjs`，然后打开 **http://127.0.0.1:7400**。控制台提供启用、关闭接单、任务报告和退出看板程序入口。首次运行默认关闭；关闭后不再派发/认领新工作，在途任务允许续租并提交结果。任务报告按项目、状态和负责人筛选，展示证据摘要与失败原因。

“关闭 AgentBus”用于停止新增工作；“退出看板程序”用于关闭本地看板服务，不会强杀 Worker，也不会删除任务数据。MCP 客户端的注册/断开属于宿主设置；仅关闭总线不等于卸载或断开 MCP。

> 本机实际 MCP 实现入口为 `bus/bus-mcp.mjs`。下面旧章节中的自动执行说明只在 Human 已启用总线后适用；`global.dispatch_enabled` 是派发策略，与人工启停开关分别生效。

你的三个 AI —— **Codex**、**Claude Code**、**DSH** —— 共用一块任务黑板。
谁接了什么活、做到哪一步、需要谁拍板，三方和人看到的是同一份内容，延迟 1 秒内。

这份文档只讲**你怎么用、怎么改**。运行时只依赖 Node.js 内置模块，建议使用 Node.js 24 或更高版本。

---

## 你只需要做四个决定

其余都是细节。每个决定下面都写了：怎么改（命令 / 手改两种方式）、什么时候生效、怎么验证。

---

## 决定一：这个项目用哪种目录形态

| 形态 | 什么时候选它 | 你要付的代价 |
|---|---|---|
| **clone-per-agent**（默认） | 同一个仓库，但希望各方能同时干活、同时跑测试 | 交接要走「提交 → 对方拉取」，看不到对方正在改的文件 |
| **shared** | 接力太频繁：A 改完 B 必须马上在同一份文件上接着改 | 要排队，一次只能一方动；不能并行跑测试和构建 |
| **isolated** | 各管各的仓库，或者根本不是代码活（写文档、调研） | 没有交接，只靠任务层协调 |

**什么时候该换：**

- 现在是 clone-per-agent，但你一天要手动合并好几次 → **换 shared**
- 现在是 shared，但经常发现两个 agent 互相打断测试 / 构建 / 装依赖 → **换 clone-per-agent**
- 一个项目里既有"必须共享"又有"完全独立"的部分 → **拆成两个项目**，别混着配

### 怎么改

**命令方式（推荐）：**

```powershell
node bus project proj-alpha topology shared
node bus project proj-alpha add-agent claude/main
```

**手改方式** —— 打开 ```workspaces/proj-alpha/project.json```，把 topology 的值换掉：

```json
{ "id": "proj-alpha",
  "topology": "shared",
  "agents": ["codex/main", "claude/main", "dsh/main"] }
```

三个可选值：clone-per-agent、shared、isolated。

### 项目不一定在这个工作目录下

代码库放在磁盘任何位置都行，两条命令：

```powershell
node bus/cli.mjs add-project myproj D:\code\myproj   # 登记项目位置
node bus/cli.mjs init-project myproj                   # 生成 project.json
node bus/cli.mjs projects                              # 确认
```

或者直接手写 `bus/projects.json`：

```json
{ "projects": { "myproj": { "path": "D:/code/myproj" } } }
```

还有一层：`project.json` 里的 `root` 字段可以再覆盖一次实际代码目录 —— 适合"配置文件放一处、代码放另一处"的情况。

**关键**：agent 不需要知道这些。`bus_claim` 返回的 `workspace.cwd` 已经是算好的绝对路径，它照着去干活即可。

**生效时机**：拓扑在总线启动时扫描 —— **改完要重启对应的 agent 会话**。正在跑的任务不受影响，新任务生效。

**怎么验证**：```node bus status``` 看「项目」区块，确认 topology 已变。

---

## 决定二：要不要让 AI 自动接活

| 档位 | 你会看到什么 | 什么时候用 |
|---|---|---|
| **off**（默认） | 派过去的活只出现在看板「待批」列，你点接受它才开工 | 刚开始用；或你不在电脑前、不想它自作主张 |
| **propose** | AI 自动给出拆解方案，但**不动代码**，等你批准 | 想让 AI 帮你分工，但执行权握在自己手里 |
| **auto** | 直接认领开工 | 这类任务你已经完全信任 |

**推荐的推进路径**：全部 off 跑一周 → 挑一个方向改 propose 再跑一周 → 确实稳了，才对特定 agent 开 auto。

**三个常见组合：**

| 组合 | 怎么配 |
|---|---|
| 保守（出厂默认） | 三个都 off |
| 半自动 | 你亲自指挥的那个设 auto，另外两个保持 off |
| 全自动 | 三个都 auto，但把 max_open_from_agents 压到 2 |

### 怎么改

**命令方式（推荐）：**

```powershell
node bus preset conservative          # 一键切整套（conservative / team / auto）
node bus set claude autonomy propose  # 只改一个 agent
node bus set claude may_dispatch_to codex,dsh
```

**手改方式** —— 打开 ```bus/policy.json```，改 agents 下面那个对象：

```json
{ "agents": {
    "claude/main": {
      "autonomy": "propose",
      "may_dispatch_to": ["codex/main", "dsh/main"],
      "max_open_from_agents": 2,
      "max_concurrent": 1,
      "scope_allowlist": ["src/**"]
    }
} }
```

**两道门槛必须一起改**，只改一个不会生效（这是故意的）：

1. ```autonomy``` —— 它要不要自动干
2. ```may_dispatch_to``` —— 谁有资格给它派活（默认为空，等于没人能派）

**生效时机**：policy.json 每次派活时重读，**改完立即生效**，不用重启。

**怎么验证**：```node bus status``` 会打出每个 agent 的当前档位和授权名单；或者让任意 agent 调 ```bus_online```。

### 派活还要过三关

配额（同时接几个自动任务）、递归深度（最多派两层）、总闸（dispatch_enabled）。

两种结果要分清：

- **未授权 / 递归超限 → 直接拒绝**（这类不该发生）
- **配额满 / 总闸关 / 对方是 off 档 → 降级成「待批」**，任务照样可见，你审批后照常执行

所以默认配置下派活不会被拒绝，只会停在待批 —— 这正是「能力常在、默认不自动执行」。

**建议把每个 Worker 的 max_concurrent 设成 1**（同一时间只干一个活）。这一条最朴素，却把「按负载派活」实现了八成，也避免一个 AI 抢五个活只做一件的积压。

---

## 决定三：谁来当 Lead

Lead 是拆任务、派活、验收、合并、仲裁的那个人。**当前默认 Codex，但随时可以换成任何一个，包括你自己。**

| 候选 | 为什么适合 | 代价 |
|---|---|---|
| **Codex**（当前默认） | 推理扎实，能跑无头会话 | 没有入站唤醒，必须挂 supervisor |
| **Claude Code** | 唤醒机制最强：能被反复叫醒、能在回合中拦截 | 只有命令行，看全局得靠问它 |
| **DSH** | 可用官方 headless profile 自动执行，也能在桌面查看会话 | 自动接单需要运行 `dsh-supervisor.mjs` |
| **你自己** | 最可控，AI 只出方案不落地 | 你必须全程在场 |

**权限是分开的，别捆在一个人身上：**

| 权限 | 管什么 | 默认给 |
|---|---|---|
| 派活 | 拆任务、派给别人 | Lead |
| 验收 | 判断别人干得对不对 | Lead，可下放给交叉评审者 |
| 合并 | 合进主干 | 建议保留给你自己 |
| 仲裁 | 改派、打回、拍板 | 只有 Lead |

### 怎么改

**命令方式（推荐）：**

```powershell
node bus lead claude          # 换 Lead
node bus grant accept claude  # 把验收权也下放给 claude
```

**手改方式** —— 打开 ```bus/policy.json``` 顶层：

```json
{ "lead": "codex/main",
  "permissions": {
    "dispatch": ["codex/main"],
    "accept":   ["codex/main", "human"],
    "merge":    ["human"],
    "reassign": ["codex/main"]
  } }
```

```lead``` 可填：dsh/main、claude/main、codex/main、human。
```permissions``` 里每一项都是数组，写能执行该动作的 id；填 ```human``` 表示只有你能做。

**生效时机**：Lead 与权限在总线启动时读取 —— **改完要重启总线**（```node bus restart```）。

**怎么验证**：```node bus status``` 顶部会显示当前 Lead 和四项权限的实际归属。

**一条硬约束**：一个项目只能有一个 Lead，不要搞双 Lead（会互相覆盖决策）。不同项目可以用不同 Lead，在各自的 project.json 里写 ```lead``` 就会覆盖全局值。

---

## 决定四：活儿怎么分才省钱

贵的模型（Lead）token 单价可能是便宜模型的十几倍。省钱的唯一办法是：**让贵的只做贵的，别让它干能派下去的活。**

### 分工表

| 任务类型 | 谁做 | 谁验收 | 为什么 |
|---|---|---|---|
| 架构设计、接口定义 | Lead | 你 | 一旦错了，下游全错 |
| 任务拆解 | Lead，**只拆一次** | — | 反复拆解是最大的浪费 |
| 冲突仲裁、打回决策 | Lead | 你 | 必须有人拍板 |
| 多文件实现（要一致性） | 中级 Worker | Lead | 需要跨文件判断 |
| 单文件实现（有 stub） | 低级 Worker | 同伴交叉评审 | 边界清晰 |
| 机械改动（重命名 / 格式化 / 加日志） | 低级 Worker | **自动**（测试通过即接受） | 可机器判定 |
| 写测试、写文档、补注释 | 低级 Worker | **自动** | 低风险、有标准 |

### 四条硬规则（这四条直接决定你花多少钱）

1. **Lead 不写代码、不读大文件。** Lead 的消耗九成来自"读整个仓库"和"改代码试错"，这两个动作单价最高。
2. **Worker 回报不许带完整 diff。** 只带：改了哪些文件、增删几行、测试结果、有没有阻塞、有没有需要你决策的事。超过 40 行直接拒绝。
3. **不要每完成一个任务就唤醒 Lead。** Lead 一次规划出整张任务依赖图就退场，只在三种时候被叫回来：契约冲突、重试超限、跨模块决策。否则每唤醒一次，它都要重读一遍上下文。
4. **能自动验收的绝不人工验收。** 测试通过 + 没动范围外的文件 = 自动接受。机械任务不需要 Lead 点头。

### 拆解粒度：这里有个权衡

- 拆得太**粗** → 弱模型看不懂，返工，总成本反而更高
- 拆得太**细** → Lead 花在拆解上的钱，超过省下来的钱

**正解：拆到「有一个能自动验证的验收标准」为止，不再往下拆。**
有了验收标准，弱模型就能自己迭代，也不需要 Lead 反复介入 —— 这才是真正的省钱点。

### 怎么改

**命令方式：**

```powershell
node bus economics preset lean          # 推荐：激进省钱
node bus set-project proj-alpha cost_mode lean   # 按项目切 lean / balanced / quality
```

**手改方式** —— 打开 ```bus/policy.json```，加一个 economics 段：

```json
{ "economics": {
    "lead_may_read_files": false,
    "lead_may_write_code": false,
    "lead_plans_once": true,
    "lead_wake_on": ["contract_conflict", "retry_exceeded", "cross_module_decision"],
    "report_max_lines": 40,
    "report_no_raw_diff": true,
    "auto_accept": ["mechanical", "tests", "docs"],
    "peer_review": ["standard"],
    "lead_review": ["architectural", "interface"],
    "max_rounds_per_task": 2,
    "daily_token_budget": null
} }
```

**生效时机**：立即生效，不用重启。

**怎么验证**：```node bus/cli.mjs cost```

### 怎么知道有没有效果

只看一个指标：**Lead 的 token 占总消耗的比例**。

系统从通信链路上降耗，而不是压缩必要输出：长背景放文档，任务卡只派一次；`bus_update` 是唯一状态事件；问题只唤醒决策人；原始日志落文件；验收消息自带任务快照，避免 Lead 再查一次；命中 `auto_accept` 的干净低风险任务由 supervisor 直接收尾。

| 比例 | 含义 |
|---|---|
| < 20% | 健康 |
| 20% – 50% | 偏高，Lead 在干不该干的活 |
| > 50% | 失控，等于用最贵的模型做最便宜的事 |

### 按项目看账（含"未分配"）

看板总览页现在同时给出三层数字：

1. **总计**——全部 token、Lead 占比；
2. **按项目**——每个项目各自的 token、任务数、Lead 占比，按消耗降序；
3. **未分配（无任务）**——`token_usage.task_id` 为空、或对应任务已不存在的那部分消耗。

第三项是最该盯的：它代表**没挂在任何任务上的空转开销**（Lead 重读上下文、临时排查、无任务的会话）。整理本项目账本时实测为 **75.2%**，而项目内 proj-demo 的 Lead 占比只有 26.5%——说明全局偏高主要来自空转，不是项目执行本身。

分账口径：按 `tasks.project` 归组，未分配单列且不并入任何项目；项目合计 + 未分配 = 总计（看板有守恒断言）。

### 项目管理

看板「项目」页（`/#projects`）可以直接创建项目，不必再手改 `bus/projects.json`：

- **新建**：填 id、路径（可留空）、拓扑、参与 agent。路径留空则自动用 `workspaces/<id>`。
- **路径语义**：`store.resolveProjectDir()` 优先使用登记里的 `path`，`workspaceFor()` 再从**该目录**读 `project.json` 决定拓扑与工作目录。所以登记显式路径时，`project.json` 会写进那个目录（返回的 `config_path` 就显示实际位置）。
- **删除**：仅解除登记，并清理 AgentBus 生成的 `project.json`；项目目录与你自己放进去的文件保留。该项目下还有任务时拒绝删除并报告数量，`default` 不可删。
- **未登记项目**：历史任务里出现的、但不在 `projects.json` 的项目会列出并标「未登记」——这类名字通常是自由填写留下的脏数据（本项目实测存在一个以绝对路径命名的项目）。

所有写操作仅 Human 可执行，且走原子写 + 时间戳备份 + 独占锁。

### 强制机器验收

`policy.json` → `economics.require_verify_cmd`：

- `true` 时，**属于 `economics.auto_accept` 类别**（默认 mechanical/tests/docs）的任务必须填写非空 `verify_cmd`，否则 `dispatch` 与 `createHumanTask` 直接拒绝（`reason: verify_cmd_required`），不会创建任务卡；
- 其他类别（standard/architectural/interface）不受影响，仍走人工/Lead 复核；
- 缺省 `false`，避免影响既有流程。

目的是把验收成本从"Lead 读输出判断"转移到"命令跑完自动判定"。本仓库当前已设为 `true`。看板「调度策略」页有对应开关。

### 三个烧钱的反模式

- ❌ 让 Lead 自己试错改代码（改—跑—再改，每一次都是高单价）
- ❌ 任务粒度太粗就派下去（弱模型要自己先想一遍，等于花便宜的钱干贵的活，还干得差）
- ❌ 失败无限重试（默认 2 次就升级，别让它硬扛 10 轮）

---

## 红线：哪些事必须你点头

前面四个决定管"怎么协作"，这一节管"哪些事 AI 不许自己决定"。

### 两类：硬拦 和 只标记

| 类型 | 你会在看板上看到什么 | 你能做什么 |
|---|---|---|
| **派活时就命中红线** | 卡片直接落在「待批」列，标注中文徽标（装依赖 / 删除文件 / git 危险操作 / 改规则文件 / 出网） | 只有你能点批准。Lead 点会被拒（`redline_human_only`） |
| **执行完发现越权** | 卡片变「失败」，带 `guard(...)` 原因，并给你发一条 `redline.blocked` | 误判的话点「人类放行」，把它拉回待验收 |
| **只是改动面大（>20 文件）** | 卡片正常进「待验收」，多一个「需人审」标记 | Lead 判不了 done，只能你点 |
| **干净** | 没有徽标 | 不打扰你 |

### 认定红线的八类动作

**必须人类批准**：装依赖、删文件、git 危险操作、改规则文件、出网。

判定看两处，缺一都可能漏：

1. **派活时扫任务卡文字** —— 卡里出现 `npm install`、`rm -rf`、`git push`、`curl`、`RULES.md` 这类字样，就转「待批」
2. **执行完比对文件快照** —— 执行前后各扫一次工作目录，看真的增了/改了/删了什么

第 2 条是必需的：文字扫描只能抓"写在卡上的"，抓不到"临时起意"。实测过一次会话退出码 0、报告说成功、实际删了文件——只有快照比对能发现。

### 三条要记住的

**① 文字扫描不认识"我在讨论而不是执行"。** 卡里写「先确认有没有 npm install」也会命中。宁可多问你一次。

**② 批准 = 给授权，但只给这一次。** 你点批准的瞬间，这张卡的红线种类写进 `grants`；下一张卡要重新声明。不存在"批准过一次以后都通行"。

**③ 能放行的人不能是被管的那个。** 放行、批红线、判 done —— 这三个动作只有 `human` 能做，Lead 和 Worker 都不行。所以也不要让 agent 有办法改 `RULES.md` 或 `policy.json`，否则它就能给自己发权限。

### 怎么改这些规则

| 想改什么 | 改哪里 |
|---|---|
| 哪些动作算红线 | `policy.json` → `redline.human_only`（可填：dep:install / fs:delete / git:risky / cfg:edit / net:egress） |
| 超过几个文件算大改动 | `policy.json` → `economics.max_changed_files`，默认 20 |
| 一张卡能开几个子代理 | `policy.json` → `economics.max_subagents`，默认 0（禁止） |
| review 多久没人验收就提醒 | `policy.json` → `economics.review_timeout_min`，默认 30 分钟 |

**注意**：把某一类从 `redline.human_only` 里删掉，等于允许 Lead 批它。这是放宽，不是关闭——判定逻辑还在，只是批准门槛降了一级。

不该改的别改：这四个字段控制的是"谁能给自己发权限"，改错了前面所有审批都归零。

---

## 配置总表（一页查表）

| 想改什么 | 字段 | 哪个文件 | 可选值 | 默认 | 生效 |
|---|---|---|---|---|---|
| 项目目录形态 | topology | workspaces/<项目>/project.json | clone-per-agent / shared / isolated | clone-per-agent | 重启 agent 会话 |
| 项目里有哪些 agent | agents | 同上 | 数组 | 全部 | 重启 |
| 项目自己的 Lead | lead | 同上 | agent id / human | 继承全局 | 重启 |
| 要不要自动接活 | autonomy | bus/policy.json → agents.<id> | off / propose / auto | off | 立即 |
| 谁可以给它派活 | may_dispatch_to | 同上 | 数组，或 ["*"] | [] | 立即 |
| 同时接几个自动任务 | max_open_from_agents | 同上 | 0–10 | 0 | 立即 |
| 同时进行几个任务 | max_concurrent | 同上 | 1–5 | 1 | 立即 |
| 能改哪些文件 | scope_allowlist | 同上 | 路径数组 | 全部 | 下一条派活 |
| 派活总闸 | dispatch_enabled | policy.json → global | true / false | true | 立即 |
| 最多派几层 | max_dispatch_depth | 同上 | 1–3 | 2 | 立即 |
| 每小时最多派几条 | rate_per_agent_per_hour | 同上 | 数字 | 20 | 立即 |
| 谁是 Lead | lead | policy.json → 顶层 | agent id / human | codex/main | 每轮重读 |
| 四项权限归谁 | permissions | 同上 | 见决定三 | 全给 Lead | 重启总线 |
| Lead 能不能读文件 | lead_may_read_files | policy.json → economics | true / false | false | 立即 |
| Lead 能不能写代码 | lead_may_write_code | 同上 | true / false | false | 立即 |
| 哪些任务免验收 | auto_accept | 同上 | cost_class 数组 | mechanical/tests/docs | 立即 |
| Worker 回报多少行 | report_max_lines | 同上 | 20–200 | 40 | 立即 |
| 一次派活最多几轮 | max_rounds_per_task | 同上 | 1–5 | 2 | 立即 |
| 每日 token 预算 | daily_token_budget | 同上 | 数字 / null | null | 立即 |
| 一张卡能开几个子代理 | max_subagents | 任务卡（Lead 填） | 0–5 | 0 | 下次认领 |
| **实际生效的子代理上限** | economics.max_subagents | policy.json → economics | 0–5 | 0 | 立即 |
| **哪些动作算红线** | redline.human_only | policy.json → 顶层 | 五种 kind 的数组 | 全部五种 | 立即 |
| **超过几个文件算大改动** | economics.max_changed_files | policy.json → economics | 1–10000 | 20 | 立即 |
| **review 多久没人验收就升级** | economics.review_timeout_min | policy.json → economics | 1–10080 | 30 | 立即 |

一句话记：**project.json 改完重启会话，policy.json 改完立即生效。**

---

## 像三个人做同一个项目那样用

三个 AI 要像三个人一样协作，靠的不是人更多，而是下面四件事都成立。

**① 角色固定，不能三个一样的抢活**

Lead 拆解、派活、验收、合并、仲裁；Worker 只认领、实现、自测、提交。
**Worker 之间不直接互相派活** —— 减少协商成本，也避免互相踢皮球。

**② 先冻结契约，再并行**

这是能不能并行的唯一前提，也是最容易被跳过、后果最严重的一步。开工前必须先定下并冻结：

- 文件归属：谁拥有哪些目录和文件
- 接口：函数签名、参数、返回类型
- 数据：结构、字段、错误码
- 验收标准：怎么算做完了

落地方式：**直接写 stub**（interface + 空实现 + throw TODO），比写文档有效得多 —— AI 会照着签名实现。

契约文件必须**只读共享**：三个 clone 里各有一份同步副本，任何一方要改契约，必须先问 Lead，不能自己动。否则契约漂移，三份代码合不起来。

**③ 任务必须自带三样**

每个任务要写清：**验收标准 / 涉及哪些文件 / 依赖谁（blocked_by）**。
粒度标准：**一个 AI 一次会话能干完**。太大必然失控，太小则调度开销吃掉收益。
有依赖的任务不要提前派出去 —— Worker 拿到发现干不了，就白费一轮。

**拆的时候就要保证互不影响**（解耦）

三条同时成立才算解耦：文件范围不相交、没有依赖关系、共同依赖的接口契约已冻结。
只满足前两条是假解耦 —— 文件不重叠，但一方改了签名，另一方照样编译不过。

最快的判定法：**能不能给两张卡各写一条互不影响的测试？** 必须一起跑才成立的，就是没解耦。

拆不开的时候别硬拆，按这个顺序退：

- 边界只差一点 → 把公共部分抽成契约文件，指定一个人维护
- 有依赖 → 串行，别并行
- 要改同一文件的不同部分 → 合并成一张卡
- 根本切不开 → 一个人做，另一个人评审（评审比并行便宜，还不冲突）

**按接口边界拆，不要按功能点拆。** 功能点天然耦合（一个登录要同时动 UI + API + DB），接口边界天然解耦。

解耦真正的收益不是"能并行"，是**缩小返工半径** —— 一张卡做错了，影响范围就只有那张卡。

**④ 交接和验收要有硬规范**

- 每个 Worker 一条 agent/<id>/<task> 分支 → 干完 push → 报告 branch + commit
- **Lead 合并前必须跑测试**，Worker 说"我干完了"不算数
- **永远不要让两个未合并的分支互相 rebase** —— 灾难多半出在这里
- 任务完成要带证据：测试输出、diff 摘要、截图。缺了直接打回

**⑤ 两条沟通纪律**

- 只问选择题：「X 和 Y，我倾向 X，因为…，选哪个」，不问"这个该怎么做"
- 每轮一个 status 心跳：在哪个任务、到哪一步、有没有被阻塞

---

## 完整流程

这条链路是端到端自动的，只有第一步需要你说话：

1. **你在 Lead（Codex）对话框里给任务** —— 随便怎么说
2. **Lead 拆分并派出去** —— 它调 ```bus_dispatch```，一个任务粒度 = 一次会话能干完
3. **被指派的 worker 自动被唤醒** —— 守护进程轮询到属于自己的 ```open``` 任务，立刻认领
4. **执行前后自动比对文件快照** —— 越权的活到这一步就被拦下，判失败并通知你（见「红线」一节）
5. **worker 干完自动提交验收** —— 任务进 ```review```，回报同时发给 Lead
6. **只有 Lead 验收通过才变 done** —— 不通过就打回并说明缺什么，可以再来一轮；标了「需人审」的卡 Lead 判不了
7. **你随时看板和配置** —— 不用参与中间过程

### 要起的四个进程

```powershell
node bus/board.mjs                  # 看板：配置 + 看状态
node bus/codex-supervisor.mjs --daemon   # Lead 的自动回合：验收、仲裁
node bus/claude-supervisor.mjs --daemon  # Worker 的自动唤醒
node bus/dsh-supervisor.mjs --daemon     # DSH Worker 的自动唤醒
```

**交互式会话和守护进程不会抢消息。** 它们共用 ```codex/main``` 这个身份，但守护进程有自己的游标（```codex/main#codex-sup```），
所以你在对话框里聊的同时，后台的自动验收照常进行。

### 三条必须知道的限制

**① 自动验收依据的是任务卡，不是你对话里的上下文。**
你在对话框里跟 Codex 说的细节，无头回合看不到。所以**把验收标准写进任务卡**——这也是任务卡必须有验收标准的原因。

**② DSH 自动接单依赖官方 CLI。**
`dsh-supervisor.mjs` 使用 DSH 的 `headless` profile：发现定向给 `dsh/main` 的 `open` 任务后自动认领、启动一次无头 Session、续租并回报。桌面应用是否打开不影响这条链路；如果本机找不到 `dsh` 命令，supervisor 会明确报错而不会假装已执行。

**③ Codex 没有入站 hook。**
Claude 有 Stop hook 能原地注入消息，Codex 没有。所以 Codex 的"被唤醒"只能靠守护进程起一个**新的**无头会话，
而不是打断你正在聊的那个。这决定了 ① 的限制。

---

## 第一次上手

先在本地控制台手动启用，并明确让会话使用 AgentBus，再进行以下操作（普通会话不要自动执行）：

1. **看谁在忙** —— 让它调 bus_online
2. **派一个活** —— 说「给 claude 派个活：把登录页的错误提示改掉」
3. **看进展** —— 说「列一下当前任务板」，或直接打开看板
   http://127.0.0.1:7400 （看板也在这里审批）

---

## 看板是什么

看板是**管理入口**，但不是账本。

- 真正的账本在 ```bus/bus.db``` 的 tasks 表，三个 agent 读写的是它 —— **它们不看看板**
- 看板由总线数据实时投影出来，**删掉也能完整重建**
- 任务创建、派发、编辑、改派、审批和取消都通过服务端守卫写回账本
- 策略修改会校验后原子写入 ```policy.json```，覆盖前自动生成时间戳备份
- MCP 页面只修改 Codex / Claude Code 配置中的 ```agentbus``` 条目，不展示或覆盖其他 MCP 密钥

### 看板上你能看到什么

| 能看到 | 看不到 |
|---|---|
| 这张卡谁建的、谁认领的、现在什么状态 | 它们此刻在做什么（在读哪个文件、在想什么） |
| 改了哪些文件、增删几行、测试通过没 | 逐句的思考过程 |
| 卡住时的提问、需要你拍板的点 | 终端里的完整输出 |
| 谁在线、手上几个活、卡了多久 | —— |

**阶段状态通过 `bus_update` 更新**；仅在出现新阻塞或必须决策时额外发送消息，详细日志写文件并附路径，不逐句直播。
报得越细，烧的 token 越多 —— 默认取「节点级」可见，不取「逐句级」。这是刻意的取舍。

想知道某个 agent 正在干什么，去开它自己的窗口；看板回答的是"进展到哪了"，不是"正在做什么"。

一张卡大概长这样：

```
┌──────────────────────────────────────────────┐
│ t-0007  登录页错误提示                        │
│ 状态 进行中    认领 claude/main    已 12 分钟 │
│ 范围 src/auth/**      来源 人派活→dsh 拆解    │
│ ───────────── 最新回报 ─────────────          │
│ 改 src/auth/error.tsx   +42/-8               │
│ 测试 18 通过 / 0 失败                         │
└──────────────────────────────────────────────┘
```

不想开网页也行，终端里打同一张表：

```powershell
node bus board
```

---

## 日常四件事

**派活** —— 说清「给谁 / 做什么 / 改哪些文件」。对方是 off 档的话会先进「待批」。

**看进度** —— 打开看板，或在任一 agent 里问「任务板现在什么情况」。

**审批** —— 看板「待批」列里等你点头的就是。拒绝时可以写理由，会回传给派活方。

**介入** —— 觉得走偏了，把任务打回，或扔一条 note 给对应 agent。
被派活的一方永远有拒绝权，拒绝会带理由返回，不会静默丢掉。

---

## 现在能跑到哪一步

| 部分 | 状态 |
|---|---|
| 总线本体（MCP server + SQLite + 五道守卫 + 状态机 + 成本记账） | **已完成**，48 项逻辑测试全绿 |
| 红线门禁（事前扫描 + 批准即授权 + 事后快照核对） | **已完成**，62 项测试全绿 |
| 人用 CLI（status / board / agents / cost） | **已完成** |
| Codex / Claude Code 接入 | ✅ 两边都已注册并连通 |
| Claude Code 推醒（hook.mjs） | ✅ 实测四种模式 |
| Codex 推醒（codex-supervisor.mjs） | ✅ 真实跑通一次 |
| 网页管理控制台（board.mjs） | ✅ 任务管理、策略设置、MCP 配置和审批均可用 |

## 把总线接到 Claude Code

一条命令：

```powershell
claude mcp add --scope user agentbus -- node C:/path/to/agent-work/bus/bus-mcp.mjs --agent claude/main
```

验证：在 Claude Code 里让它调 ```bus_online```，能返回自己的身份就通了。

#### 可选：让它自动接手新消息

默认 Claude Code 只在你说话时才动。配上 Stop hook 之后，回合结束前它会先问一次总线，有新消息就直接接着干——这才是真正的"实时"。

在项目的 `.claude/settings.json` 里加：

```json
{ "hooks": {
  "SessionStart": [{ "hooks": [{ "type": "command", "command": "node C:/path/to/agent-work/bus/hook.mjs start" }] }],
  "PostToolUse":  [{ "hooks": [{ "type": "command", "command": "node C:/path/to/agent-work/bus/hook.mjs beat"  }] }],
  "Stop":         [{ "hooks": [{ "type": "command", "command": "node C:/path/to/agent-work/bus/hook.mjs stop"  }] }],
  "SessionEnd":   [{ "hooks": [{ "type": "command", "command": "node C:/path/to/agent-work/bus/hook.mjs end"   }] }]
} }
```

原理只有一条：**hook 以 exit 2 退出时，Claude Code 会把它的 stderr 注入上下文并继续本回合。**
所以「没消息 exit 0 收工，有消息 exit 2 接着干」。

已验证：无消息 exit 0 / 有消息 exit 2 并打印内容 / 消费后不再重复。
等待时长默认 8 秒，可用环境变量 `BUS_HOOK_WAIT_MS` 调。

---

## 把总线接到 Codex

编辑 ```~/.codex/config.toml```，加一段：

```toml
[mcp_servers.agentbus]
command = "node"
args = ["C:/path/to/agent-work/bus/bus-mcp.mjs", "--agent", "codex/main"]
```

## 让 Codex 自动干活（supervisor）

Codex 没有 Claude 那样的 hook，靠一个外壳进程补上"被叫醒"的能力：

```powershell
node bus/codex-supervisor.mjs --once      # 跑一轮就退出
node bus/codex-supervisor.mjs             # 最多 3 轮
node bus/codex-supervisor.mjs --dry-run   # 只打印将要执行的命令和 prompt，不认领不执行
node bus/codex-supervisor.mjs --fake      # 不真调 codex，只验证管道
node bus/codex-supervisor.mjs --print-bin # 看它解析到了哪个 codex 可执行文件
```

每轮做的事：扫待办任务 → 认领 → 起一个 ```codex exec``` 会话 → 把结果写成回报 → 任务进「待验收」。
没活也没新消息就退出，**不空转消耗额度**。

**跑在 Lead 身份下时它不认领待办**——Lead 的活是拆解派活和验收，不是抢工作者的任务。

**Windows 上有个坑**：```spawn('codex')``` 会 ENOENT，因为 npm 装的是 .cmd 垫片，Node 出于安全拒绝执行。
supervisor 会自动按「显式指定 → 原生 exe → 垫片指向的 js → PATH」解析，用 ```--print-bin``` 可以看它选了哪个。

**实测一次真实运行的消耗**：输入 39031 / 输出 286 token。
输入大头是 Codex 每回合都要加载的上下文——其中包含总线注册的 12 个工具定义。
如果觉得贵，可以把不常用的工具从 ```bus-mcp.mjs``` 里裁掉。

原始事件流会存到 ```bus/logs/``` 备查（不入库，避免 Lead 上下文被 JSON 灌满）。

## 让 DSH 自动干活（supervisor）

DSH 使用官方的一次性 `headless` profile，输出采用 NDJSON，任务 token 会写入总线 usage 表：

```powershell
node bus/dsh-supervisor.mjs --once
node bus/dsh-supervisor.mjs --daemon
node bus/dsh-supervisor.mjs --fake --once
node bus/dsh-supervisor.mjs --print-bin
```

项目根目录的 `AGENTS.md` 会由 DSH 自动加载；supervisor 已完成认领时，任务提示会要求 DSH 不再重复操作总线。
`bus/dsh-supervisor.patch.yml` 只在无头任务中启用现有 DSH 登录态，并关闭交互式 MCP 客户端；认领、续租和回报由 supervisor 统一处理。

## 看板（网页）

不用敲命令也能管理任务、策略和 MCP 接入：

```powershell
node bus/board.mjs               # 默认 http://127.0.0.1:7400
node bus/board.mjs --port 7400   # 换端口
```

- 每 5 秒增量刷新状态，不再整页闪烁
- 创建公开任务或定向派发给指定 Agent
- 编辑任务说明、成本档位、写作用域和子代理上限；任务开始后锁定结构性字段
- 批准、拒绝、改派、验收和取消任务
- 修改 Lead、四项权限、派发守卫、Agent 自治/配额、成本与评审策略
- 管理 Codex / Claude Code / DSH 的 AgentBus MCP 身份与启停；写入前自动备份，保存后需重启客户端
- ```/api/state``` 返回完整控制台快照，```/api/tasks``` 保留为任务 JSON 接口
- 写接口要求页面令牌、自定义请求头和同源校验；服务仍只监听 ```127.0.0.1```

**看板是视图不是账本**：把进程 kill 掉，数据全在 bus.db 里，重启即恢复。
想换掉这个网页也随时可以，DSH 的 GUI 或者别的什么都能接，只要读 ```/api/tasks```。

## 自己验证总线是否正常

```powershell
node bus/smoke.mjs       # 逻辑层：守卫、状态机、幂等、成本       48 项
node bus/smoke-mcp.mjs   # 传输层：握手、工具清单、真实调用       14 项
node bus/smoke-e2e.mjs   # 端到端：派活→认领→验收               20 项
node bus/smoke-admin.mjs # 管理层：任务编辑、策略、CSRF          81 项
node bus/smoke-guard.mjs # 红线与守卫：分类、授权、审计、升级     62 项
node bus/smoke-routing.mjs # 通信层：定向唤醒、合并、自动验收     16 项
node bus/smoke-cost.mjs  # 成本归集与自动验收门槛               17 项
node bus/smoke-project.mjs # 项目登记、路径与并发安全             16 项
node bus/smoke-runtime.mjs # 人工启停与 drain 状态               14 项
node bus/smoke-supervisor-evidence.mjs # supervisor 验收证据       4 项
node bus/cli.mjs status  # 看策略快照
node bus/cli.mjs board   # 看任务板
```

全部跑一遍：```292 项断言```。

---

## 出问题先看这里

| 症状 | 原因 | 修法 |
|---|---|---|
| 沙箱报 grantWrite / Win32 5 | 工作区 ACL 不让改 | 给仓库目录授予当前账户写权限，并确认任务 write_scope 配置正确 |
| 改了 project.json 没反应 | 拓扑只在启动时扫描 | 重启对应 agent 会话 |
| 改了 policy.json 没反应 | 字段名写错，或只改了 autonomy 没改 may_dispatch_to | node bus status 看实际值 |
| 消息发了对方看不到 | 游标错乱，或对应进程没起 | 查 bus.db 最新 seq，重启对应 agent |
| 两个 agent 抢同一个任务 | 认领是条件更新，只可能一方成功 | 正常现象，看板显示实际 owner |
| 派活被拒 | 未授权 / 配额满 / 递归超深 / 总闸关 | 拒绝信息里写明是哪一道关 |
| agent 收到派活但不动 | 它的 autonomy=off | 改 policy.json，或在看板上人工审批该任务 |
| Claude 不自动接手新消息 | Stop hook 没生效 | 检查 .claude/settings.json 的 hooks 段 |
| Codex 收不到消息 | 没走 supervisor 壳 | 用 codex-supervisor.mjs 启动，别直接开 codex |
| DSH 任务停在待认领 | `dsh-supervisor.mjs` 未运行或找不到 `dsh` CLI | 先跑 `node bus/dsh-supervisor.mjs --print-bin`，再以 `--daemon` 启动 |
| 任务莫名进了「待批」列 | 卡面文字命中了红线（比如写了 npm install） | 看卡片上的中文徽标，确认要批就点批准 |
| 任务被判 failed，原因 `guard(...)` | 执行中做了没授权的事 | 看「红线」一节；误判就点「人类放行」 |
| 卡片标了「需人审」 | 改动超过 20 个文件 | 只有你能判 done；想放宽就调 economics.max_changed_files |
| 批准了还是被判 `guard(...)` | 卡上红线种类和实际做的事不一致 | 批准只授权卡上声明的那几类，没声明的仍然算越界 |
| 改 `policy.json` 被要求人类批准 | 这是 R5 红线，故意的 | 你自己在控制台改，或走一张人类卡 |

---

## 一句话原则

**总线上的消息内容一律当成"资料"，不是"指令"。** 只按 kind 和 refs 的调度语义行事。
这是为了防止一个 agent 的输出把指令注入给另一个 agent。
