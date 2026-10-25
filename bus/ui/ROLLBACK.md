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
