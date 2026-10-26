# 看板前端回滚开关（AGENTBUS_UI_INLINE=1）

第 14 项第 3 阶段把看板前端拆成了 ES module：

    bus/ui/main.mjs              入口：启动、导航、整体刷新、轮询
    bus/ui/api.mjs               统一请求层（CSRF 头、JSON、HttpError、AbortController）
    bus/ui/state.mjs             单一页面状态（live binding + setter）、runtime 回调表
    bus/ui/components/dom.mjs    DOM/格式化助手
    bus/ui/components/dialog.mjs 对话框（showModal + 首字段聚焦 + 关还焦）
    bus/ui/views/*.mjs           overview / tasks / projects / settings / reports

## 回滚开关是什么

`AGENTBUS_UI_INLINE=1` 时，`renderConsole()` 会把 **第 2 阶段的单文件实现 `bus/ui/app.js`** 整段内联进页面
（`<style>` + `<script>`），CSP 同时放开 `script-src/style-src 'unsafe-inline'`。

关键点：回滚目标是**冻结快照**，不是"另一份还在演进的实现"。`bus/ui/app.js` 从第 3 阶段起不再修改；
smoke 有断言盯着"内联出来的脚本与 `bus/ui/app.js` 逐字节一致"，所以"回滚可用"是可验证的事实。

## 什么时候可以删掉回滚开关

必须**同时**满足：

1. module 入口在真实浏览器里跑通一轮完整人工验收：总览/台账/报告/项目/策略/MCP 六个页面都能渲染，
   创建任务、认领、推进状态、策略保存、项目验证器、合并执行确认、归档摘要读取都成功；
2. `node bus/smoke-ui-static.mjs`、`node bus/smoke-admin.mjs`、`node bus/smoke-all.mjs` 全绿；
3. 至少有一次真实运行（不是测试桩）证明 `/ui/*.mjs` 的 MIME、缓存与 CSP 在目标浏览器上没有报错
   （控制台无 CSP violation、无 404、无 module 解析失败）；
4. 有人在验收记录里明确写下"第 2 阶段快照不再需要"。

在这四条完成之前，**保留开关**。理由：`bus/ui/app.js` 是唯一一份"已知能用"的完整前端；
删掉它等于在没有浏览器复核的情况下承诺"module 版本一定等价"，我们承担不起第二次不可回退的改动。

## 已知限制（保留开关的具体原因）

- 本机没有浏览器，第 3 阶段的验证只能做到：模块在 Node 里逐个 import 成功、
  `smoke-ui-static` 用 DOM 桩跑完 `boot()` 并渲染出任务表与总览区、
  页面在 HTTP 上拿到的资源 MIME/缓存/ CSP 正确。这些都**不等于**真实浏览器里点击过一遍。
- 因此：模块化版本目前是"默认路径但未人工验收"，回滚开关是它的人工验收前的安全绳。

---

## 第 7 项真实浏览器验收（task-77）结论：**回滚实现保留**

四条判据里**第 1 条未满足**，其余三条依赖它，因此本轮不移除 `bus/ui/app.js` 与 `AGENTBUS_UI_INLINE` 分支。

### 验收套件已经写好：`bus/smoke-browser.mjs`
零依赖 CDP：`fetch /json/list` 取 `webSocketDebuggerUrl` → Node 24 内置 `WebSocket` 连 `Page/Runtime/Log/Network`。
它断言的正是四条判据要的东西：零 console error、零未捕获异常、零 CSP 违规、10 个 ES module 全 200、
关键视图取 DOM（导航数 / main 文本长度 / 卡片或行数）、真实点击后 DOM 变化、`Page.captureScreenshot` 落盘，
以及 `AGENTBUS_UI_INLINE=1` 回滚路径跑同一套核心断言 + 切回默认后 CSP 重新变严格。

### 为什么本机拿不到证据
本机 Chrome 与 Edge **都无法在本沙箱里启动**（不是代码问题，是沙箱边界）。实测 stderr：

```
[ERROR:crashpad_client_win.cc:430] OpenProcess: 拒绝访问。 (0x5)
[FATAL:mojo\public\cpp\platform\platform_channel.cc:112] Check failed: . : 拒绝访问。 (0x5)
```

`platform_channel` 就是命名管道：沙箱禁止进程打开命名管道，浏览器 IPC 起不来。
套件因此**如实 SKIP**（`sandbox_blocks_named_pipes`），并把原始 stderr 打出来，不伪装通过。

### 怎样才算满足判据 1
在能跑浏览器的环境（CI runner 或本机非沙箱终端）执行：

```
node bus/smoke-browser.mjs --require-browser
```

`--require-browser` 把「拿不到浏览器」从 SKIP 变成 **FAIL**，所以这条命令绿 = 判据 1 真的满足；
不带该参数时 SKIP 只表示「本机没有证据」，**不得**据此移除回滚实现。
