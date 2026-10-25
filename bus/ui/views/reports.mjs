// 任务报告页（第 14 项第 3 阶段）。
// 渲染函数只吃 state / 入参并返回 HTML 字符串，**不发请求**；loadReports 由 main 触发。
import { q, esc, fmt, statusLabel } from '../components/dom.mjs';
import { api } from '../api.mjs';
import { stopped, state } from '../state.mjs';

let reportRequest = 0;

function reportOptions(id,items,label,labels){var el=q(id),selected=el.value;el.innerHTML='<option value="">'+label+'</option>'+items.map(function(v){return '<option value="'+esc(v)+'">'+esc(labels?statusLabel(v):v)+'</option>'}).join('');el.value=selected}
function renderReports(data){reportOptions('#report-project',data.filters.projects,'全部项目');reportOptions('#report-status',data.filters.statuses,'全部状态',true);reportOptions('#report-owner',data.filters.owners,'全部负责人');q('#report-count').textContent='显示 '+data.reports.length+' / '+data.total+' 项任务'+(data.total>data.limit?' · 仅展示最近 '+data.limit+' 项，请缩小筛选范围':'');q('#report-list').innerHTML=data.reports.length?data.reports.map(function(t){var evidence=t.test_evidence.map(function(e){return '<li>'+esc(e.test_evidence||e.summary)+(e.truncated?' <span class="muted">（摘要已截断）</span>':'')+'<div class="report-meta">'+esc(e.sender)+' · '+fmt(e.ts)+'</div></li>'}).join('');return '<article class="panel report-card '+esc(t.status)+'"><div class="report-title"><div><h2>'+esc(t.title)+'</h2><div class="report-meta"><span class="mono">'+esc(t.id)+'</span> · '+esc(t.project)+'<br>负责人：'+esc(t.owner||'未认领')+(t.target?' · 目标：'+esc(t.target):'')+' · 更新 '+fmt(t.updated_at)+'</div></div><span class="badge '+esc(t.status)+'">'+esc(statusLabel(t.status))+'</span></div><div class="report-sections"><section><h3>最近进度</h3><p class="report-copy">'+esc(t.progress)+(t.progress_truncated?'（摘要已截断）':'')+'</p></section><section><h3>测试证据</h3>'+(evidence?'<ul class="report-evidence">'+evidence+'</ul>':'<p class="report-copy muted">尚未提交测试证据</p>')+'</section></div>'+(t.failure_reason?'<div class="report-failure"><strong>失败 / 终止原因</strong><p class="report-copy">'+esc(t.failure_reason)+'</p></div>':'')+'<details><summary>日志路径与执行摘要（'+t.events.length+' 条）</summary>'+(t.log_paths.length?t.log_paths.map(function(p){return '<code class="report-log">'+esc(p)+'</code>'}).join(''):'<p class="report-copy muted">尚未报告日志路径</p>')+'<ol class="report-events">'+t.events.map(function(e){return '<li><div class="report-meta">'+fmt(e.ts)+' · '+esc(e.sender)+' · '+esc(e.kind)+'</div><p class="report-copy">'+esc(e.summary)+(e.truncated?'（摘要已截断）':'')+'</p></li>'}).join('')+'</ol>'+t.guard_events.map(function(e){return '<p class="report-copy">'+esc(e.kind)+' · '+esc(e.summary)+'</p>'}).join('')+'</details></article>'}).join(''):'<div class="panel empty">没有符合条件的任务报告。清除筛选后重试。</div>'}
async function loadReports(){if(stopped)return;var request=++reportRequest,params=new URLSearchParams();['project','status','owner'].forEach(function(k){var value=q('#report-'+k).value;if(value)params.set(k,value)});try{var data=await api('/api/reports?'+params);if(request===reportRequest)renderReports(data)}catch(e){if(request===reportRequest){q('#report-count').textContent='无法读取报告：'+e.message;q('#report-list').innerHTML=''}}}

// 事件绑定集中在这里，由 main 在启动时调用一次。
export function bind() {
  ['project','status','owner'].forEach(function(k){q('#report-'+k).onchange=loadReports});q('#report-clear').onclick=function(){['project','status','owner'].forEach(function(k){q('#report-'+k).value=''});loadReports()};
}

export { reportOptions, renderReports, loadReports };
