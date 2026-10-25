import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const UI_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'ui');
const assetCache = new Map();

// 静态资源只从 bus/ui 下按白名单读取（不拼路径、不接受外部传入的相对路径）。
function uiAsset(name) {
  if (!assetCache.has(name)) assetCache.set(name, fs.readFileSync(path.join(UI_DIR, name), 'utf8'));
  return assetCache.get(name);
}

export function uiAssetVersion(name) {
  return crypto.createHash('sha256').update(uiAsset(name)).digest('hex').slice(0, 12);
}

// 回滚开关：AGENTBUS_UI_INLINE=1（或 options.inlineAssets=true）时回到「CSS 内联在 HTML 里」的旧产物。
// 本阶段不删旧路径：两种模式都由同一份 bus/ui/*.css 生成，内联产物与抽离前逐字节一致。
export function uiInlineMode(options) {
  if (options && options.inlineAssets !== undefined) return options.inlineAssets === true;
  return String(process.env.AGENTBUS_UI_INLINE || '') === '1';
}

// 第 14 项第 3 阶段：默认加载 ES module 入口 bus/ui/main.mjs（api/state/views/components 拆开）；
// 回滚模式（AGENTBUS_UI_INLINE=1）内联第 2 阶段的单文件 app.js —— 它已冻结，不再随新功能演进。
function scriptTag(name, options) {
  if (uiInlineMode(options)) return '<script>' + uiAsset('app.js') + '</script>';
  return '<script type="module" src="/ui/main.mjs?v=' + uiAssetVersion('main.mjs') + '"></script>';
}

function styleTag(name, options) {
  if (uiInlineMode(options)) return '<style>' + uiAsset(name) + '</style>';
  return '<link rel="stylesheet" href="/ui/' + name + '?v=' + uiAssetVersion(name) + '">';
}
function attr(s) {
  return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
}

// 会话缺失或 Origin 不合时的 403 页面：只回显稳定错误码与服务端提示，绝不回显 token。
export function renderDenied(options) {
  const DENIED_STYLE_TAG = styleTag('denied.css', options);
  const opts = options || {};
  const code = attr(opts.code || 'forbidden');
  const hint = attr(opts.hint || '请使用看板启动时在终端打印的一次性登录链接。');
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>需要登录 · Agent Bus</title>
  ${DENIED_STYLE_TAG}
</head>
<body><div class="card">
  <h1>看板会话无效</h1>
  <p>这个控制台只接受带会话 cookie 的本机访问。请用启动时终端打印的一次性登录链接打开看板。</p>
  <p>错误码：<code>${code}</code></p>
  <p>${hint}</p>
</div></body>
</html>`;
}

export function renderConsole(options) {
  const STYLE_TAG = styleTag('styles.css', options);
  const SCRIPT_TAG = scriptTag('app.js', options);
  const csrf = attr(options.csrf);
  const actor = attr(options.actor);
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>Agent Bus 控制台</title>
  ${STYLE_TAG}
</head>
<body data-csrf="${csrf}" data-actor="${actor}">
  <div class="shell">
    <aside class="sidebar">
      <div class="brand"><div class="brand-mark">A/B</div><div class="brand-copy"><strong>AGENT BUS</strong><span>CONTROL ROOM</span></div></div>
      <nav class="nav" aria-label="主导航">
        <button class="active" data-page="overview"><span class="nav-code">00</span>总览</button>
        <button data-page="tasks"><span class="nav-code">01</span>任务</button>
        <button data-page="projects"><span class="nav-code">P</span>项目</button>
        <button data-page="reports"><span class="nav-code">R</span>任务报告</button>
        <button data-page="policy"><span class="nav-code">02</span>策略</button>
        <button data-page="mcp"><span class="nav-code">03</span>MCP</button>
      </nav>
      <div class="side-foot">操作身份<br><b>${actor}</b></div>
    </aside>
    <main>
      <header class="topbar"><div class="crumb" id="crumb">运行总览</div><div class="top-actions"><span class="fresh" id="fresh">正在连接…</span><span class="live unavailable" id="bus-status" role="status">正在读取状态</span><button class="btn small" id="refresh">刷新</button></div></header>
      <div class="content">
        <section class="panel bus-controls" aria-label="AgentBus 运行控制"><div><h2 id="bus-control-title">AgentBus 运行状态</h2><p id="bus-control-copy">正在读取运行状态…</p></div><div class="button-row"><button class="btn primary" id="bus-toggle" disabled>启用 AgentBus</button><button class="btn ghost" id="console-shutdown">退出看板程序</button></div></section>
        <section class="page active" id="page-overview">
          <div class="page-head"><div><div class="eyebrow">Live operations</div><h1>协作调度台</h1><p>从一个 Lead 出发，掌握任务流向、执行状态与每项工作的 Token 成本。</p></div><button class="btn primary" data-new-task>＋ 创建任务</button></div>
          <section id="project-cost" hidden aria-label="项目 Token 消耗"></section>
          <section id="budget-panel" hidden aria-label="Token 预算"></section>
          <section id="review-queue" hidden aria-label="评审队列"></section>
          <section id="merge-queue" hidden aria-label="合并队列"></section>
          <section id="archive-summary" hidden aria-label="归档与保留"></section>
          <section id="retention-layers" hidden aria-label="二级保留与旧日志"></section>
          <div class="panel topology"><div class="topology-head"><h2>指挥链路</h2><span id="dispatch-state">—</span></div><div class="rail" id="topology-rail"></div></div>
          <div class="metric-grid" id="metrics"></div>
          <div class="overview-grid">
            <div class="panel"><div class="panel-head"><h2>最近任务</h2><button class="btn ghost small" data-go-tasks>查看全部</button></div><div class="feed" id="recent-tasks"></div></div>
            <div class="panel health"><div class="panel-head pad-b12"><h2>Lead 成本占比</h2></div><div id="health"></div></div>
          </div>
        </section>
        <section class="page" id="page-tasks">
          <div class="page-head"><div><div class="eyebrow">Task ledger</div><h1>任务台账</h1><p>创建、定向派发、编辑和验收任务。结构性字段在任务开始后自动锁定。</p></div><button class="btn primary" data-new-task>＋ 创建 / 派发</button></div>
          <div class="toolbar"><div class="search"><input id="task-search" placeholder="搜索标题、ID、Agent"></div><select id="task-project" aria-label="按项目筛选任务" class="mw-190"><option value="">全部项目</option></select><select id="task-status" class="mw-170"><option value="">全部状态</option></select><button class="btn" id="show-terminal">显示已结束</button><span class="task-count" id="task-count">—</span></div>
          <div class="panel tasks-wrap"><table class="tasks cards"><thead><tr><th>ID / 标题</th><th>状态</th><th>目标 / Owner</th><th>项目</th><th>Token</th><th>档位</th><th>更新时间</th><th></th></tr></thead><tbody id="task-rows"></tbody></table><div class="empty" id="task-empty" hidden>没有符合条件的任务。尝试清除筛选，或创建一项新任务。</div></div>
        </section>
        <section class="page" id="page-projects">
          <div class="page-head"><div><div class="eyebrow">Project registry</div><h1>项目</h1><p>管理项目路径、协作拓扑和参与 Agent。历史任务中未登记的项目会保留在列表中。</p></div></div>
          <p class="notice" id="project-unavailable" hidden>项目管理后端尚未可用，当前只能查看项目。</p>
          <div class="panel" id="project-create-panel" hidden><div class="panel-head"><h2>新建项目</h2></div><form id="project-form" class="settings-body"><div class="form-grid"><div class="field"><label for="pf-id">项目 ID</label><input id="pf-id" required pattern="[a-zA-Z0-9][a-zA-Z0-9._-]{1,40}" maxlength="41" placeholder="my-project"></div><div class="field"><label for="pf-path">项目目录（可选，绝对路径）</label><input id="pf-path" placeholder="留空使用 workspaces/&lt;id&gt;"></div><div class="field"><label for="pf-topology">协作拓扑</label><select id="pf-topology"><option value="clone-per-agent">每个 Agent 独立副本</option><option value="shared">共享目录</option><option value="isolated">隔离工作区</option></select></div><div class="field"><label for="pf-agents">参与 Agent（可选，逗号分隔）</label><input id="pf-agents" placeholder="codex/main, claude/main"></div></div><div class="field wide mt-15"><span class="field-label">项目验证器</span><div id="project-create-validators"></div><button class="btn small" type="button" id="project-create-add-validator">添加验证器</button><p class="help">命令与参数分开保存，不经过 shell；参数每行一个，工作目录必须位于项目根内。</p></div><div class="button-row mt-15"><button class="btn primary" id="project-create-submit">创建项目</button></div><p class="help" id="project-result" role="status"></p></form></div>
          <dialog id="validators-dialog"><form id="validators-form"><div class="dialog-head"><h2 id="validators-title">项目验证器</h2><button class="icon-btn" id="validators-close" type="button" aria-label="关闭">×</button></div><div class="dialog-body"><input type="hidden" id="validators-project-id"><div id="project-edit-validators"></div><button class="btn" id="project-edit-add-validator" type="button">添加验证器</button><p class="help">修改仅影响新任务；已创建任务保留冻结配置，执行前会检查变更。</p><p id="validators-result" role="status" class="help"></p></div><div class="dialog-foot"><button class="btn primary" id="validators-save">保存验证器</button></div></form></dialog><div id="project-list" class="project-list" aria-live="polite"></div>
        </section>
        <section class="page" id="page-reports">
          <div class="page-head"><div><div class="eyebrow">Execution reports</div><h1>任务报告</h1><p>面向 Human 的执行记录：查看负责人、最近进度、测试证据与失败原因。长日志保留摘要与路径。</p></div></div>
          <div class="report-filters"><div class="field"><label for="report-project">项目</label><select id="report-project"><option value="">全部项目</option></select></div><div class="field"><label for="report-status">状态</label><select id="report-status"><option value="">全部状态</option></select></div><div class="field"><label for="report-owner">负责人</label><select id="report-owner"><option value="">全部负责人</option></select></div><button class="btn" id="report-clear">清除筛选</button></div>
          <p class="report-message" id="report-count" role="status">正在读取报告…</p><div class="report-list" id="report-list" aria-live="polite"></div>
        </section>
        <section class="page" id="page-policy">
          <div class="page-head"><div><div class="eyebrow">Policy engine</div><h1>调度策略</h1><p>修改 Lead、权限、派发守卫和 Agent 自治等级。保存前服务端会完整校验。</p></div><button class="btn primary" id="save-policy">保存策略</button></div>
          <div class="notice">各字段按标注阶段生效；标有“待第 N 项接线”的字段尚未参与运行。切换 Lead 时默认同步核心权限。</div>
          <div class="settings-layout"><nav class="panel settings-index"><a href="#policy-lead">Lead 与权限</a><a href="#policy-global">派发守卫</a><a href="#policy-agents">Agent 设置</a><a href="#policy-network">网络白名单</a><a href="#policy-economics">成本与评审</a></nav><div class="settings-stack">
            <section class="panel" id="policy-lead"><div class="panel-head"><h2>Lead 与权限</h2></div><div class="settings-body"><div class="form-grid"><div class="field"><label for="policy-lead-select">当前 Lead</label><select id="policy-lead-select"></select></div><div class="field"><label>&nbsp;</label><label class="check"><input type="checkbox" id="sync-lead" checked> 切换时同步核心权限</label></div></div><div class="permission-grid mt-15" id="permission-grid"></div></div></section>
            <section class="panel" id="policy-global"><div class="panel-head"><h2>派发守卫</h2></div><div class="settings-body"><div class="switch-row"><div class="switch-copy"><strong>派发总闸</strong><span>关闭后新派发进入待批状态</span></div><input type="checkbox" id="g-enabled"></div><div class="form-grid mt-14"><div class="field"><label for="g-depth">最大派发深度</label><input type="number" id="g-depth" min="1" max="5"></div><div class="field"><label for="g-chain">最大消息链长度</label><input type="number" id="g-chain" min="1" max="10"></div><div class="field"><label for="g-rate">每 Agent 每小时派发</label><input type="number" id="g-rate" min="1" max="1000"></div></div></div></section>
            <section class="panel" id="policy-agents"><div class="panel-head"><h2>Agent 设置</h2><small>自治、配额、能力和下游</small></div><div class="settings-body"><div class="agent-grid" id="agent-grid"></div></div></section>
            <section class="panel" id="policy-registry-extra" hidden><div class="panel-head"><h2>其他策略字段</h2><small>只读生效说明</small></div><div class="settings-body" id="policy-registry-extra-list"></div></section>
            <section class="panel" id="policy-network"><div class="panel-head"><h2>网络白名单</h2><small>默认拒绝，按目标授权</small></div><div class="settings-body"><div class="form-grid"><div class="field"><label for="network-default">默认策略</label><input id="network-default" value="deny" readonly><div class="help">固定为 deny：没有 network_grants 授权的目标一律拒绝。</div></div></div><div class="field wide mt-14"><span class="field-label">本地服务（localhost 精确端口）</span><div id="network-services"></div><button class="btn small" type="button" id="network-add-service">添加本地端口</button><p class="help">只按端口精确放行 loopback；公网 grant 不会顺带放行 localhost，RFC1918 与云元数据地址一律拒绝。</p></div></div></section>
            <section class="panel" id="policy-economics"><div class="panel-head"><h2>成本与评审</h2></div><div class="settings-body"><div id="economics-switches"></div><div class="form-grid mt-14"><div class="field"><label for="e-lines">Worker 回报上限（行）</label><input type="number" id="e-lines" min="10" max="500"></div><div class="field"><label for="e-rounds">每任务最大轮次</label><input type="number" id="e-rounds" min="1" max="10"></div><div class="field"><label for="e-budget">每日 Token 预算（留空不限）</label><input type="number" id="e-budget" min="1"></div><div class="field"><label for="e-auto">免验收档位（逗号分隔）</label><input id="e-auto"></div><div class="field"><label for="e-peer">同级评审档位</label><input id="e-peer"></div><div class="field"><label for="e-lead-review">Lead 评审档位</label><input id="e-lead-review"></div></div></div></section>
          </div></div>
        </section>
        <section class="page" id="page-mcp">
          <div class="page-head"><div><div class="eyebrow">Connection registry</div><h1>MCP 接入</h1><p>管理各客户端的 AgentBus 注册。只修改 <code>agentbus</code> 条目，不读取或展示其他服务的密钥。</p></div></div>
          <div class="notice">保存后需要重启对应客户端会话。每次写入都会在原配置旁生成带时间戳的备份。</div>
          <div class="mcp-grid" id="mcp-grid"></div>
        </section>
      </div>
    </main>
  </div>
  <dialog id="task-dialog"><form method="dialog" id="task-form"><div class="dialog-head"><h2 id="task-dialog-title">创建任务</h2><div class="notice" id="task-isolation" hidden></div><button class="icon-btn" type="button" data-close-task aria-label="关闭">×</button></div><div class="dialog-body"><input type="hidden" id="tf-id"><input type="hidden" id="tf-version"><section class="usage-strip" id="task-usage" hidden></section><div class="form-grid"><div class="field wide"><label for="tf-title">标题</label><input id="tf-title" maxlength="200" required></div><div class="field wide"><label for="tf-body">说明 / 验收标准</label><textarea id="tf-body" maxlength="12000" placeholder="写清楚交付物、验收标准和依赖"></textarea></div><div class="field"><label for="tf-project">项目</label><input id="tf-project" list="task-project-options" value="default"><datalist id="task-project-options"></datalist></div><div class="field"><label for="tf-target">目标 Agent</label><select id="tf-target"></select></div><div class="field"><label for="tf-cost">成本档位</label><select id="tf-cost"><option>mechanical</option><option>tests</option><option>docs</option><option selected>standard</option><option>architectural</option><option>interface</option></select></div><div class="field"><label for="tf-subs">子代理上限</label><input type="number" id="tf-subs" min="0" max="5" value="0"></div>
<div class="field"><label for="tf-budget">任务 Token 预算</label><input type="number" id="tf-budget" min="1" placeholder="留空=只受日预算限制"><div class="help">调额只影响本任务；一次批准不等于永久关闭预算。</div></div><div class="field wide"><label for="tf-scope">写作用域</label><textarea id="tf-scope" placeholder="src/auth/**&#10;tests/auth/**"></textarea><div class="help">每行一个项目内相对路径或 glob；任务开始后不能修改。</div></div><div class="field wide"><label for="tf-verify">验证器</label><select id="tf-verify"><option value="">不使用验证器</option></select><div class="help" id="tf-verify-help">选择项目预先配置的验证器。</div><div class="help" id="tf-frozen-spec"></div></div><div class="field wide"><label for="tf-extra">额外目录（每行一个）</label><textarea id="tf-extra" placeholder="项目内相对路径或绝对路径"></textarea><div class="notice" id="tf-extra-notice" hidden>该任务将进入待批，需 Human 批准</div></div><div class="field wide"><label for="tf-grants">授权类型（多选，最多 5 项）</label><select id="tf-grants" multiple size="6"></select><div class="help">使用 Ctrl / Command 选择多项。实际授权与红线原因在下方展示。</div></div><div class="field wide"><span class="field-label">网络目标授权（network_grants）</span><div id="tf-network-grants"></div><button class="btn small" type="button" id="tf-add-network-grant">添加网络目标</button><div class="empty" id="tf-network-empty">未授权任何网络目标：需要联网的目标会被拒绝。</div><p class="help">每项写明 protocol / host / ports / purpose。仅审计，无法强制隔离：联网任务一律等 Human 批准。</p></div><div class="field wide"><span class="field-label">实际授权与红线命中原因</span><div class="notice" id="tf-authorization"></div></div><div class="field wide" id="tf-proposed-row"><label class="check"><input type="checkbox" id="tf-proposed"> 创建为待批任务</label></div><div class="field wide" id="tf-archive-row" hidden><span class="field-label">归档</span><div id="tf-archive"></div></div></div><div class="action-strip" id="task-actions" hidden><h3>任务操作</h3><div class="button-row" id="task-action-buttons"></div></div></div><div class="dialog-foot"><button class="btn" type="button" data-close-task>关闭</button><button class="btn primary" type="submit" value="default" id="save-task">保存任务</button></div></form></dialog>
  <div class="toast" id="toast" role="status" aria-live="polite" aria-atomic="true"></div>
  ${SCRIPT_TAG}
</body></html>`;
}
