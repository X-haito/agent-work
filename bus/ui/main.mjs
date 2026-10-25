// 看板入口（第 14 项第 3 阶段）：负责启动、导航、整体刷新与轮询；页面渲染都在 views/*.mjs。
// 这里是**唯一**有顶层副作用（DOM 事件绑定、轮询）的地方，并且被 document 守卫，Node 里可以安全 import 做单元测试。
import { q, qa, fmt, names, toast } from './components/dom.mjs';
import { state, dirty, stopped, showTerminal, setState, setDirty, setStopped, setShowTerminal, runtime } from './state.mjs';
import { api, setCsrf } from './api.mjs';
import { renderOverview } from './views/overview.mjs';
import { renderTasks, renderArchiveSummary, loadReviews, loadMerges, loadBudget, bind as bindTasks } from './views/tasks.mjs';
import { renderProjects, renderRetentionLayers, bind as bindProjects } from './views/projects.mjs';
import { renderPolicy, renderMcp, renderRuntime, bind as bindSettings } from './views/settings.mjs';
import { loadReports, bind as bindReports } from './views/reports.mjs';

export function boot() {
  let pollTimer = null;
  function go(page){if(!names[page])page='overview';qa('.nav button').forEach(function(b){b.classList.toggle('active',b.dataset.page===page)});qa('.page').forEach(function(p){p.classList.toggle('active',p.id==='page-'+page)});q('#crumb').textContent=names[page];location.hash=page==='overview'?'':page;if(page==='reports')loadReports()}
  qa('.nav button').forEach(function(b){b.onclick=function(){go(b.dataset.page)}});qa('[data-go-tasks]').forEach(function(b){b.onclick=function(){go('tasks')}});q('#refresh').onclick=function(){load(true)};
  function exitBoard(){setStopped(true);clearInterval(pollTimer);q('#bus-status').textContent='看板已退出';q('#fresh').textContent='已停止同步';qa('button').forEach(function(b){b.disabled=true});toast('看板程序已退出；运行中任务不受影响')}
  q('#console-shutdown').setAttribute('title','关闭本看板服务；不影响 AgentBus 启停状态与运行中任务');
  q('#console-shutdown').onclick=async function(){if(this.dataset.busy)return;this.dataset.busy='1';this.disabled=true;try{await api('/api/console/shutdown',{method:'POST',body:{}});exitBoard()}catch(e){delete this.dataset.busy;this.disabled=false;var msg=String(e&&e.message||e);if(/Failed to fetch|NetworkError|已退出|没有这个接口|ECONNREFUSED/.test(msg)){exitBoard();return}toast('退出失败：'+msg,true)}};
  function renderAll(){renderProjects();renderRuntime();renderOverview();renderArchiveSummary();renderRetentionLayers();renderTasks();renderPolicy();renderMcp();q('#fresh').textContent='同步 '+fmt(state.server_time);if(location.hash==='#reports')loadReports();loadBudget();loadReviews();loadMerges()}
  async function load(force){if(stopped)return;if(dirty&&!force)return;try{setState(await api('/api/state'));renderAll()}catch(e){toast('无法读取总线：'+e.message,true)}}
  document.addEventListener('input',function(e){if(e.target.closest('#page-policy')||e.target.closest('#page-mcp')||e.target.closest('#project-form')||e.target.closest('#validators-form'))setDirty(true)});window.addEventListener('hashchange',function(){go(location.hash.slice(1)||'overview')});go(location.hash.slice(1)||'overview');load(true);pollTimer=setInterval(function(){if(!document.hidden)load(false)},5000);
  // 各 view 的事件绑定集中在这里调用一次（模块 import 阶段不碰 DOM）。
  bindTasks();
  bindProjects();
  bindSettings();
  bindReports();
  // views 通过 runtime 回调 main，避免 views ↔ main 的循环依赖。
  runtime.load = load;
  runtime.go = go;
  setCsrf(document.body.dataset.csrf || '');
}

if (typeof document !== 'undefined') boot();
