// 任务台账页（第 14 项第 3 阶段）。
// 渲染函数只吃 state / 入参并返回 HTML 字符串，**不发请求**；
// 需要刷新或请求时通过 runtime / 注入的 api 模块，因此可在 Node 里用最小 DOM 桩直接单测。
import { q, qa, esc, fmt, num, statusLabel, toast, split, statuses, redlineNames} from '../components/dom.mjs';
import { taskCost, guardBadges, redlineList, canRelease, setDirty, showTerminal, runtime, state, dirty} from '../state.mjs';
import { api } from '../api.mjs';
import { openDialog, closeDialog } from '../components/dialog.mjs';
import { renderNetworkGrants, collectNetworkGrants } from './settings.mjs';
import { dash } from './projects.mjs';

var reviewStatusNames={pending:'待认领',active:'评审中',completed:'已完成',changes_requested:'要求修改',escalated:'已升级',superseded:'已被取代'};
var mergeStatusNames={proposed:'待批准',approved:'已批准',merging:'合并中',merged:'已合并',failed:'失败',cancelled:'已取消'};

function renderTasks(){var project=q('#task-project'),selected=project.value,projects=Array.from(new Set(state.tasks.map(function(t){return t.project}))).sort();project.innerHTML='<option value="">全部项目</option>'+projects.map(function(p){return '<option value="'+esc(p)+'">'+esc(p)+'</option>'}).join('');project.value=selected;var sel=q('#task-status');if(!sel.dataset.ready){sel.innerHTML='<option value="">全部状态</option>'+statuses.map(function(s){return '<option value="'+s+'">'+statusLabel(s)+'</option>'}).join('');sel.dataset.ready='1'}var term=['done','failed','declined','cancelled'],search=q('#task-search').value.toLowerCase(),filter=sel.value;var rows=state.tasks.filter(function(t){if(!showTerminal&&term.indexOf(t.status)>=0)return false;if(filter&&t.status!==filter)return false;if(project.value&&t.project!==project.value)return false;if(search&&([t.id,t.title,t.target,t.owner,t.project].join(' ').toLowerCase().indexOf(search)<0))return false;return true});q('#task-count').textContent='显示 '+rows.length+' / '+state.tasks.length;q('#task-rows').innerHTML=rows.map(function(t){var c=taskCost(t.id),total=c.total||c.t||0;return '<tr><td data-label="任务"><div class="task-title">'+esc(t.title)+'</div><div class="task-sub mono">'+esc(t.id)+' · v'+t.version+'</div>'+guardBadges(t)+'</td><td data-label="状态"><span class="badge '+esc(t.status)+'">'+esc(statusLabel(t.status))+'</span></td><td data-label="执行者">'+esc(t.owner||t.target||'—')+'</td><td data-label="项目">'+esc(t.project)+(state.project_registry&&!state.project_registry.some(function(p){return p.id===t.project&&p.registered})?' <span class="badge proposed">未登记</span>':'')+'</td><td data-label="Token"><div class="task-token">'+num(total)+'<small>入 '+num(c.in)+' · 出 '+num(c.out)+'</small></div></td><td data-label="档位">'+esc(t.cost_class)+'</td><td data-label="更新">'+fmt(t.updated_at)+'</td><td data-label="操作"><button class="btn small" data-edit="'+esc(t.id)+'">查看</button></td></tr>'}).join('');q('#task-empty').hidden=rows.length>0;qa('[data-edit]').forEach(function(b){b.onclick=function(){openTask(b.dataset.edit)}})}

function fillTargets(select,blank){var ids=Object.keys(state.policy.agents||{});select.innerHTML=(blank?'<option value="">不指定（公开任务）</option>':'')+ids.map(function(id){return '<option value="'+esc(id)+'">'+esc(id)+'</option>'}).join('')}

function renderIsolationNotice(t){
  var el=q('#task-isolation');
  if(!el)return;
  if(!t){el.hidden=true;el.innerHTML='';return}
  var iso=(t.guard&&t.guard.isolation)||null;
  if(!iso&&!(t.needs_human===1||t.needs_human===true)){el.hidden=true;el.innerHTML='';return}
  var reason=iso&&iso.reason?iso.reason:(t.needs_human?'needs_human':'unknown'),
      why=iso&&iso.message?iso.message:(t.decline_reason||''),
      next=iso&&iso.next_step?iso.next_step:'先跑 node bus/cli.mjs doctor --probe-engine 确认本机隔离能力，再决定装运行时 / 减少 grants / 等 Human 批准';
  el.hidden=false;
  el.innerHTML='<strong>执行端缺少可执行后端</strong>'+
    '<div class="help">原因（'+esc(reason)+'）：'+esc(why||'（未记录具体原因，见任务守卫事件）')+'</div>'+
    '<div class="help">下一步：'+esc(next)+'</div>'+
    (iso&&iso.provider?'<div class="help">provider='+esc(iso.provider)+' · verified='+(iso.verified?'true':'false')+(iso.probe_reason?' · probe.reason='+esc(iso.probe_reason):'')+'</div>':'');
}

function openTask(id){var t=id&&state.tasks.find(function(x){return x.id===id}),d=q('#task-dialog'),terminal=t&&['done','failed','declined','cancelled'].indexOf(t.status)>=0,started=t&&['open','proposed'].indexOf(t.status)<0,c=t?taskCost(t.id):null;fillTargets(q('#tf-target'),true);q('#task-project-options').innerHTML=(state.projects||[]).map(function(x){return '<option value="'+esc(x)+'">'}).join('');q('#tf-id').value=t?t.id:'';q('#tf-version').value=t?t.version:'';q('#tf-title').value=t?t.title:'';q('#tf-body').value=t?t.body||'':'';q('#tf-project').value=t?t.project:'default';q('#tf-target').value=t?t.target||'':'';q('#tf-cost').value=t?t.cost_class:'standard';q('#tf-subs').value=t?t.max_subagents:0;
    q('#tf-budget').value=t&&t.token_budget?t.token_budget:'';
    loadTaskArchive(t);q('#tf-scope').value=t?(t.write_scope||[]).join(String.fromCharCode(10)):'';renderTaskValidators(t?t.verify_id||'':'');q('#tf-frozen-spec').textContent=t?'冻结验证器：'+(t.verify_id||'无')+'；SHA-256：'+(t.verify_spec_hash||'无')+(t.verify_cmd?'；旧版待批命令：'+t.verify_cmd:''):'';q('#tf-extra').value=t?(t.extra_dirs||[]).join(String.fromCharCode(10)):'';q('#tf-grants').innerHTML=Object.keys(redlineNames).map(function(k){return '<option value="'+esc(k)+'" '+(t&&(t.grants||[]).indexOf(k)>=0?'selected':'')+'>'+esc(redlineNames[k])+' · '+esc(k)+'</option>'}).join('');renderNetworkGrants(t?t.network_grants:null);q('#tf-authorization').textContent=t?'实际授权：'+((t.grants||[]).join(', ')||'无')+'；额外目录：'+((t.extra_dirs||[]).join(', ')||'无')+'；红线命中原因：'+(redlineList(t.redline).join('、')||'无')+'；网络目标：'+((t.network_grants||[]).map(function(g){return g.protocol+'://'+g.host+':'+(g.ports||[]).join('/')}).join('、')||'无'):'尚未提交，暂无实际授权或红线命中记录';updateExtraNotice();q('#tf-proposed').checked=t&&t.status==='proposed';q('#tf-proposed-row').hidden=!!t;q('#task-dialog-title').textContent=t?t.id+' · '+statusLabel(t.status):'创建 / 派发任务';var usage=q('#task-usage');usage.hidden=!t;if(t){var total=c.total||c.t||0,agents=(c.agents||[]).map(function(a){return '<span class="usage-agent">'+esc(a.agent)+' · '+num(a.total)+'</span>'}).join('');usage.innerHTML='<div class="usage-head"><strong>Token 消耗</strong><span>按实际回报累计</span></div><div class="usage-grid"><div class="usage-item"><span>输入</span><strong>'+num(c.in)+'</strong></div><div class="usage-item"><span>输出</span><strong>'+num(c.out)+'</strong></div><div class="usage-item"><span>总计</span><strong>'+num(total)+'</strong></div></div><div class="usage-agents">'+(agents||'<span class="usage-agent">尚未报告消耗</span>')+'</div>'}qa('#task-form input,#task-form select,#task-form textarea').forEach(function(el){if(el.type!=='hidden')el.disabled=false});if(started){q('#tf-project').disabled=true;q('#tf-target').disabled=true;q('#tf-scope').disabled=true;q('#tf-verify').disabled=true;q('#tf-extra').disabled=true;q('#tf-grants').disabled=true}if(terminal){qa('#task-form input,#task-form select,#task-form textarea').forEach(function(el){if(el.type!=='hidden')el.disabled=true})}q('#save-task').hidden=!!terminal;q('#task-actions').hidden=!t;renderTaskActions(t);renderIsolationNotice(t);setDirty(true);openDialog(d, document.activeElement)}

function renderTaskActions(t){var wrap=q('#task-action-buttons');if(!t){wrap.innerHTML='';return}var arr=[];if(t.status==='proposed')arr.push(['accept','批准','primary'],['decline','拒绝','danger']);if(t.status==='review')arr.push(['complete','验收完成','primary']);if(canRelease(t))arr.push(['override','人类放行','danger']);if(['done','failed','declined','cancelled'].indexOf(t.status)<0){arr.push(['reassign','改派','']);arr.push(['cancel','取消任务','danger'])}wrap.innerHTML=arr.map(function(x){return '<button type="button" class="btn '+x[2]+'" data-action="'+x[0]+'">'+x[1]+'</button>'}).join('');qa('[data-action]').forEach(function(b){b.onclick=function(){taskAction(t,b.dataset.action)}})}

async function taskAction(t,action){try{var body={action:action,version:t.version};if(action==='override'){if(!confirm('放行 '+t.id+' ？（只有人类能放行红线任务，这次决定会写进 guard_events）'))return;var note=prompt('放行说明（写入 guard_events）','人类在控制台放行');if(note===null)return;body.note=note||'人类在控制台放行'}if(action==='decline'||action==='cancel'){var reason=prompt(action==='decline'?'拒绝理由':'取消理由');if(reason===null)return;body.reason=reason}if(action==='reassign'){var target=prompt('改派给哪个 Agent？',t.target||'');if(target===null)return;body.target=target}var r=await api('/api/tasks/'+encodeURIComponent(t.id)+'/actions',{method:'POST',body:body});closeDialog(q('#task-dialog'));dirty=false;toast(action==='override'?(r&&r.message||'已放行，记录在 guard_events'):('任务 '+t.id+' 已更新'));await load(true)}catch(e){toast(e.message,true)}}

function renderTaskValidators(selected){var p=(state.project_registry||[]).find(function(p){return p.id===q('#tf-project').value}),validators=p&&p.validators||{},ids=Object.keys(validators),el=q('#tf-verify');el.innerHTML='<option value="">不使用验证器</option>'+ids.map(function(id){return '<option value="'+esc(id)+'">'+esc(id)+' · '+esc(validators[id].command)+'</option>'}).join('');if(selected&&!ids.includes(selected))el.innerHTML+='<option value="'+esc(selected)+'">'+esc(selected)+'（冻结记录，当前配置中不存在）</option>';el.value=selected||'';q('#tf-verify-help').textContent=ids.length?'使用已登记验证器，创建任务时冻结配置与哈希。':'此项目没有验证器，请先到项目页配置。'}

function updateExtraNotice(){q('#tf-extra-notice').hidden=!q('#tf-extra').value.trim()}

function renderArchiveSummary(){
  var a=state.archive,el=q('#archive-summary');
  if(!el)return;
  if(!a||typeof a!=='object'){el.hidden=true;el.innerHTML='';return}
  var p=a.pending_candidates||{},um=(a.unmanaged&&typeof a.unmanaged==='object')?a.unmanaged:null,
    umHtml=um?'<h3>不可归属的过期行（无归档凭据）</h3><ul class="report-evidence">'+
      '<li>孤儿消息 '+dash(um.messages)+' 条</li><li>孤儿守卫事件 '+dash(um.guard_events)+' 条</li>'+
      '<li>等待所属任务归档 '+dash(um.deferred_messages)+' 条消息 · '+dash(um.deferred_guard_events)+' 条守卫事件</li></ul>'+
      '<p class="help">'+(um.prune_unmanaged?'retention.prune_unmanaged=1：允许删除孤儿行（它们没有 JSONL 凭据）':'retention.prune_unmanaged=0：孤儿行只上报，永不删除')+'</p>':'';
  el.hidden=false;
  el.innerHTML='<div class="panel"><h2>归档与保留</h2>'+
    '<p class="report-copy">最近归档 '+(a.last_archived_at?esc(fmt(a.last_archived_at)):'—')+
      ' · daily 汇总 '+dash(a.token_usage_daily_rows)+' 行 · 任务归档 '+dash(a.task_archives_rows)+' 条</p>'+
    '<h3>待清理候选（按保留期阈值）</h3><ul class="report-evidence">'+
      '<li>消息 '+dash(p.messages)+' 条</li><li>守卫事件 '+dash(p.guard_events)+' 条</li>'+
      '<li>原始 Token 用量 '+dash(p.token_usage)+' 条</li><li>日志文件 '+dash(p.logs)+' 个</li></ul>'+
    umHtml+
    '<p class="help">报告与成本读 daily 汇总 + 未归档 raw 用量，去重口径在 store 内，归档前后数字一致；原始日志只在引用任务已归档且哈希匹配时才删除。</p></div>';
}

async function loadTaskArchive(t){
  var row=q('#tf-archive-row'),box=q('#tf-archive');
  if(!row||!box)return;
  row.hidden=true;box.textContent='';
  if(!t)return;
  try{
    var r=await api('/api/tasks/'+encodeURIComponent(t.id)+'/archive');
    // 迟到响应保护：先点 A 再点 B 时，A 的响应不能画进 B 的弹窗。
    if(r&&r.task_id&&r.task_id!==t.id)return;
    // 端点不可用 ≠ 没有归档：宁可显示「读取失败」，也不要把「不知道」画成「没有」。
    if(!r||r.available===false){row.hidden=false;box.textContent='读取失败：无法确认归档状态（服务端未提供归档查询）';return}
    var a=r&&r.archive;
    if(!a){row.hidden=true;box.textContent='';return}
    row.hidden=false;
    box.textContent='主体已归档，证据摘要保留 · 归档路径 '+String(a.archive_path||'—')+
      ' · 归档时间 '+String(a.archived_at||'—')+
      ' · sha256 '+String(a.sha256||'—')+' · '+String(a.bytes==null?'—':a.bytes)+' 字节';
  }catch(e){row.hidden=false;box.textContent='读取失败：无法确认归档状态（'+String((e&&e.message)||e)+'）'}
}

function reviewStatusLabel(v){return reviewStatusNames[v]||v||'-'}

async function loadReviews(){
  try{
    var r=await api('/api/reviews?open=1');
    var el=q('#review-queue');
    var list=(r&&r.reviews)||[];
    if(!r||r.available===false||!list.length){el.hidden=true;return}
    el.hidden=false;
    var now=Date.parse(r.now||new Date().toISOString());
    el.innerHTML='<div class="panel"><h2>评审队列（'+list.length+'）</h2><ul class="report-evidence">'+list.map(function(v){
      var wait=v.created_at?Math.max(0,Math.round((now-Date.parse(v.created_at))/60000)):null;
      return '<li><strong>'+esc(v.task_id)+'</strong> · 路由 '+esc(v.route||'-')+' · 状态 '+esc(reviewStatusLabel(v.status))+' · 评审人 '+esc(v.reviewer||'待认领')+(wait==null?'':' · 已等 '+wait+' 分钟')+'<div class="report-meta">'+esc(v.task_title||'')+'</div></li>';
    }).join('')+'</ul></div>';
  }catch(e){q('#review-queue').hidden=true}
}

function mergeStatusLabel(v){return mergeStatusNames[v]||v||'-'}

async function loadMerges(){
  try{
    var r=await api('/api/merge-requests?open=1');
    var el=q('#merge-queue');
    var list=(r&&r.requests)||[];
    if(!r||r.available===false||!list.length){el.hidden=true;return}
    el.hidden=false;
    el.innerHTML='<div class="panel"><h2>合并队列（'+list.length+'）</h2><ul class="report-evidence">'+list.map(function(m){
      var approve=m.status==='proposed'?'<button class="btn" data-approve-merge="'+esc(m.id)+'" data-version="'+esc(m.version)+'">批准合并</button>':'';
      var execute=m.status==='approved'&&!m.needs_human?'<button class="btn" data-execute-merge="'+esc(m.id)+'">执行合并…</button>':'';
      var reconfirm=m.status==='approved'&&m.needs_human?'<button class="btn" data-reconfirm-merge="'+esc(m.id)+'">重新确认…</button>':'';
      var recover=m.status==='merging'?'<button class="btn" data-recover-merge="'+esc(m.id)+'" data-action="retry">重试</button><button class="btn small" data-recover-merge="'+esc(m.id)+'" data-action="fail">标记失败</button>':'';
      return '<li><strong>'+esc(m.project||'-')+'</strong> · '+esc(m.source_ref||'?')+' → '+esc(m.target_ref||'?')+' · '+esc(mergeStatusLabel(m.status))+' · 申请 '+esc(m.requested_by||'-')+' '+approve+' '+execute+' '+reconfirm+' '+recover+
      (m.needs_human?'<div class="notice">需要人工重新确认：'+esc(m.needs_human_reason||'（无原因）')+'</div>':'')+
      (m.error?'<div class="report-meta">失败原因：'+esc(m.error)+'</div>':'')+
      (m.status==='merging'?'<div class="report-meta">worker '+esc(m.worker_id||'-')+' · 起始 '+esc(m.started_at||'-')+' · 租约 '+esc(m.lease_until||'-')+'</div>':'')+
      '<div class="report-meta">任务 '+esc(m.task_ids_json||'-')+(m.merge_commit?' · commit '+esc(m.merge_commit):'')+'</div></li>';
    }).join('')+'</ul><p class="help">「批准」只改状态、不动 Git；点「执行合并…」会先展示二次确认（项目、两端 ref、任务、最新验证、分支与工作树），确认后由本机 worker 执行 git merge --no-ff。不包含 push、PR、rebase 或强推。</p></div>';
  }catch(e){q('#merge-queue').hidden=true}
}

async function confirmAndExecute(id){
  var pre;
  try{ pre=await api('/api/merge-requests/'+encodeURIComponent(id)+'/preflight'); }
  catch(err){ toast('无法生成二次确认: '+err.message,true); return; }
  if(!pre||pre.ok!==true){ toast('二次确认失败: '+((pre&&pre.reason)||'unknown'),true); return; }
  var p=pre.preflight,repo=p.repo||{},lines=[];
  lines.push('项目: '+p.request.project);
  lines.push('ref: '+p.request.source_ref+' → '+p.request.target_ref);
  lines.push('仓库: '+(repo.root||'—'));
  lines.push('分支: '+(repo.branch||'—')+'  HEAD '+String(repo.head||'—').slice(0,12));
  lines.push('工作树: '+(repo.worktree||'—')+(repo.in_merge?'（正在 merge 中）':''));
  for(var i=0;i<p.tasks.length;i++){var task=p.tasks[i];
    lines.push('任务 '+task.task_id+' · '+String(task.status)+' · 验证 '+(task.verification_ok?('OK '+String(task.verify_run_id||'').slice(0,16)):('不通过('+String(task.verification_reason||'')+')')));}
  lines.push('');
  lines.push('快照 hash: '+String(pre.preflight_hash||'').slice(0,16)+'…');
  if(!confirm('确认执行合并？\\n\\n'+lines.join('\\n'))){ return; }
  toast('执行中…');
  try{
    var res=await api('/api/merge-requests/'+encodeURIComponent(id)+'/execute',{method:'POST',body:{preflight_hash:pre.preflight_hash}});
    var ok=!!(res&&res.ok);
    toast(ok?('已合并 '+String((res.merge_request&&res.merge_request.merge_commit)||'').slice(0,8)):('合并未完成: '+String((res&&res.reason)||'failed')),!ok);
    loadMerges();
  }catch(err){ toast(err.message,true); }
}

async function recoverMerge(id,action){
  var label=action==='retry'?'把这次合并重置为已批准，等待重新执行？':'把这次合并标记为失败？';
  if(!confirm(label)){ return; }
  try{
    var res=await api('/api/merge-requests/'+encodeURIComponent(id)+'/recover',{method:'POST',body:{action:action}});
    toast(res&&res.ok?('已'+ (action==='retry'?'重置为待执行':'标记失败')):('操作失败: '+String((res&&res.reason)||'failed')),!(res&&res.ok));
    loadMerges();
  }catch(err){ toast(err.message,true); }
}

async function reconfirmMerge(id){
  var pre=null;
  try{ pre=await api('/api/merge-requests/'+encodeURIComponent(id)+'/preflight'); }
  catch(err){ toast('无法生成二次确认: '+err.message,true); return; }
  if(!pre||pre.ok!==true){ toast('二次确认失败: '+String((pre&&pre.reason)||'unknown'),true); return; }
  var repo=pre.preflight.repo||{};
  var msg='重新确认这次合并？\\n\\n项目: '+pre.preflight.request.project+'\\nref: '+pre.preflight.request.source_ref+' → '+pre.preflight.request.target_ref+
    '\\n分支: '+String(repo.branch||'—')+'  HEAD '+String(repo.head||'—').slice(0,12)+'\\n工作树: '+String(repo.worktree||'—')+
    '\\n快照 hash: '+String(pre.preflight_hash||'').slice(0,16)+'…';
  if(!confirm(msg)){ return; }
  try{
    var res=await api('/api/merge-requests/'+encodeURIComponent(id)+'/confirm',{method:'POST',body:{preflight_hash:pre.preflight_hash}});
    toast(res&&res.ok?'已重新确认，可以执行合并':('确认失败: '+String((res&&res.reason)||'failed')),!(res&&res.ok));
    loadMerges();
  }catch(err){ toast(err.message,true); }
}

async function loadBudget(){
  try{
    var r=await api('/api/budget');
    var el=q('#budget-panel');
    if(!r||r.available===false){el.hidden=true;return}
    el.hidden=false;
    var used=Number(r.used||0),res=Number(r.reserved||0),lim=r.limit==null?null:Number(r.limit);
    var pct=lim?Math.min(100,Math.round((used+res)/lim*100)):0;
    var agents=(r.by_agent||[]).map(function(a){return '<li>'+esc(a.agent)+' · 已用 '+num(a.used||0)+'</li>'}).join('');
    var projects=(r.by_project||[]).map(function(p){return '<li>'+esc(p.project)+' · 已用 '+num(p.used||0)+'</li>'}).join('');
    el.innerHTML='<div class="panel"><h2>Token 预算 · '+esc(r.day_key||'')+'（'+esc(r.timezone||'UTC')+'）</h2>'+
      '<p class="report-copy">'+(lim==null?'未启用日预算（daily_token_budget 为空）':'上限 '+num(lim)+' · 已用 '+num(used)+' · 已预留 '+num(res)+' · 剩余 '+num(r.remaining==null?0:r.remaining)+'（'+pct+'%）')+'</p>'+
      (agents?'<h3>按 Agent</h3><ul class="report-evidence">'+agents+'</ul>':'')+
      (projects?'<h3>按项目</h3><ul class="report-evidence">'+projects+'</ul>':'')+
      '<p class="help">调额只影响单个任务，一次批准不等于永久关闭预算。</p></div>';
  }catch(e){q('#budget-panel').hidden=true}
}

// 事件绑定集中在这里，由 main 在启动时调用一次（模块 import 阶段不碰 DOM）。
export function bind() {



  q('#task-project').onchange=renderTasks;q('#task-search').oninput=renderTasks;q('#task-status').onchange=renderTasks;q('#show-terminal').onclick=function(){showTerminal=!showTerminal;q('#show-terminal').textContent=showTerminal?'隐藏已结束':'显示已结束';renderTasks()};
  // 第 57 项：执行端缺少隔离后端时，说清"具体原因"和"下一步该做什么"（不写"需要人工"）
  qa('[data-new-task]').forEach(function(b){b.onclick=function(){openTask(null)}});qa('[data-close-task]').forEach(function(b){b.onclick=function(){closeDialog(q('#task-dialog'))}});
  q('#task-form').addEventListener('submit',async function(e){e.preventDefault();try{var id=q('#tf-id').value,body={title:q('#tf-title').value,body:q('#tf-body').value,project:q('#tf-project').value,target:q('#tf-target').value||null,cost_class:q('#tf-cost').value,max_subagents:Number(q('#tf-subs').value), token_budget:q('#tf-budget').value?Number(q('#tf-budget').value):null,write_scope:q('#tf-scope').value.split(String.fromCharCode(10)),status:q('#tf-proposed').checked?'proposed':'open',verify_id:q('#tf-verify').value,extra_dirs:q('#tf-extra').value.split(String.fromCharCode(10)).map(function(x){return x.trim()}).filter(Boolean),grants:Array.from(q('#tf-grants').selectedOptions).map(function(x){return x.value}),network_grants:collectNetworkGrants()};var economics=state.policy.economics||{},locked=id&&q('#tf-verify').disabled;if(!locked&&economics.require_verify_cmd===true&&(economics.auto_accept||[]).indexOf(body.cost_class)>=0&&!body.verify_id){toast('自动验收类别 '+body.cost_class+' 必须选择 verify_id 验证器',true);q('#tf-verify').focus();return}if(body.extra_dirs.length>20||body.extra_dirs.some(function(d){return d.length>500})){toast('额外目录最多 20 项，每项最多 500 个字符',true);return}if(body.grants.length>5){toast('授权类型最多选择 5 项',true);return}if(body.network_grants&&(body.network_grants.length>8||body.network_grants.some(function(g){return !g.host||!g.ports.length}))){toast('网络目标最多 8 项，每项需要域名与至少一个端口',true);return}if(body.extra_dirs.length)body.status='proposed';if(locked){delete body.verify_id;delete body.extra_dirs;delete body.grants;delete body.network_grants}if(!body.network_grants||!body.network_grants.length)delete body.network_grants;if(id)body.version=Number(q('#tf-version').value);await api(id?'/api/tasks/'+encodeURIComponent(id):'/api/tasks',{method:id?'PATCH':'POST',body:body});closeDialog(q('#task-dialog'));dirty=false;toast(id?'任务已保存':'任务已创建');await load(true)}catch(err){toast(err.message,true)}});q('#task-dialog').addEventListener('close',function(){dirty=false});
  // 执行前的二次确认：把 preflight 摊开给人核对，然后把 preflight_hash 一起交给服务端重算比对。
  // 崩溃遗留与 needs_human 的人工处置：重试（回到 approved）、标记失败、重新确认（冻结新快照）。
  document.addEventListener('click',async function(ev){
    var recoverBtn=ev.target.closest('[data-recover-merge]');
    if(recoverBtn){ recoverBtn.disabled=true; try{ await recoverMerge(recoverBtn.dataset.recoverMerge,recoverBtn.dataset.action); } finally { recoverBtn.disabled=false; } return; }
    var confirmBtn=ev.target.closest('[data-reconfirm-merge]');
    if(confirmBtn){ confirmBtn.disabled=true; try{ await reconfirmMerge(confirmBtn.dataset.reconfirmMerge); } finally { confirmBtn.disabled=false; } return; }
    var execBtn=ev.target.closest('[data-execute-merge]');
    if(execBtn){ execBtn.disabled=true; try{ await confirmAndExecute(execBtn.dataset.executeMerge); } finally { execBtn.disabled=false; } return; }
    var btn=ev.target.closest('[data-approve-merge]');
    if(!btn)return;
    btn.disabled=true;
    try{ await api('/api/merge-requests/'+encodeURIComponent(btn.dataset.approveMerge)+'/approve',{method:'POST',body:{version:Number(btn.dataset.version)}}); toast('已批准（还需点「执行合并…」才会真的合并）'); loadMerges(); }
    catch(err){ toast(err.message,true); btn.disabled=false; }
  });
  q('#tf-extra').addEventListener('input',updateExtraNotice);
  q('#tf-project').addEventListener('change',function(){renderTaskValidators('')});
}

export { renderTasks, fillTargets, renderIsolationNotice, openTask, renderTaskActions, taskAction, renderTaskValidators, updateExtraNotice, renderArchiveSummary, loadTaskArchive, reviewStatusLabel, loadReviews, mergeStatusLabel, loadMerges, confirmAndExecute, recoverMerge, reconfirmMerge, loadBudget };
