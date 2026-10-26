// 项目管理页（第 14 项第 3 阶段）。
// 渲染函数只吃 state / 入参并返回 HTML 字符串，**不发请求**；
// 需要刷新或请求时通过 runtime / 注入的 api 模块，因此可在 Node 里用最小 DOM 桩直接单测。
import { q, qa, esc, fmt, num, split, toast } from '../components/dom.mjs';
import { api } from '../api.mjs';
import { runtime, setDirty, state, dirty} from '../state.mjs';
import { openDialog, closeDialog } from '../components/dialog.mjs';

function validatorRow(id,spec){spec=spec||{};return '<div class="validator-row panel pad-12-mb-10"><div class="form-grid"><div class="field"><label>验证器 ID</label><input data-v="id" value="'+esc(id||'')+'" pattern="[a-z0-9._-]+" maxlength="100" required></div><div class="field"><label>执行程序</label><input data-v="command" value="'+esc(spec.command||'')+'" required placeholder="node"></div><div class="field wide"><label>参数（每行一个）</label><textarea data-v="args">'+esc((spec.args||[]).join(String.fromCharCode(10)))+'</textarea></div><div class="field"><label>项目内工作目录</label><input data-v="cwd" value="'+esc(spec.cwd||'.')+'" required></div><div class="field"><label>超时（毫秒）</label><input data-v="timeout_ms" type="number" min="1" max="600000" value="'+Number(spec.timeout_ms||600000)+'" required></div></div><button type="button" class="btn small danger" data-remove-validator>移除此验证器</button></div>'}

function addValidator(container,id,spec){container.insertAdjacentHTML('beforeend',validatorRow(id,spec));Array.from(container.querySelectorAll('[data-remove-validator]')).forEach(function(b){b.onclick=function(){b.closest('.validator-row').remove()}})}

function collectValidators(container){var validators={};Array.from(container.querySelectorAll('.validator-row')).forEach(function(row){function value(k){return row.querySelector('[data-v="'+k+'"]').value}var id=value('id');if(Object.prototype.hasOwnProperty.call(validators,id))throw new Error('验证器 ID 重复：'+id);validators[id]={command:value('command'),args:value('args')?value('args').split(String.fromCharCode(10)):[],cwd:value('cwd'),timeout_ms:Number(value('timeout_ms'))}});return validators}

function renderProjects(){var rows=state.project_registry||[],human=document.body.dataset.actor==='human',available=state.project_management===true;q('#project-create-panel').hidden=!human||!available;q('#project-unavailable').hidden=available;q('#project-list').innerHTML=rows.length?rows.map(function(p){var reason=!p.registered?'未登记项目不能删除':p.id.toLowerCase()==='default'?'default 项目不能删除':p.tasks?'仍有 '+p.tasks+' 项任务，不能删除':!human?'仅 Human 可删除':!available?'项目管理后端尚未可用':'';return '<article class="panel project-entry '+(p.registered?'':'unregistered')+'" data-project-id="'+esc(p.id)+'"><div class="project-entry-head"><div><h2>'+esc(p.id)+'</h2><span class="badge '+(p.registered?'done':'proposed')+'">'+(p.registered?'已登记':'未登记')+'</span></div><button class="btn danger small" data-delete-project="'+esc(p.id)+'" '+(reason?'disabled':'')+' title="'+esc(reason||'删除项目登记')+'">删除登记</button></div><div class="path">'+esc(p.path||'未登记项目路径')+'</div><div class="project-facts"><span>任务 <strong>'+num(p.tasks)+'</strong></span><span>Token <strong>'+ (p.tokens==null?'未提供':num(p.tokens))+'</strong></span><span>拓扑 <strong>'+esc(p.topology||'未登记')+'</strong></span><span>目录 <strong>'+(p.registered?(p.exists?'存在':'不存在'):'未登记')+'</strong></span></div><p class="help">参与 Agent：'+esc((p.agents||[]).join(', ')||'未指定')+'</p>'+(reason?'<p class="help">'+esc(reason)+'</p>':'')+'<p class="help">验证器：'+esc(Object.keys(p.validators||{}).join(', ')||'未配置')+'</p>'+(p.validators_error?'<p class="help">'+esc(p.validators_error)+'</p>':'')+(p.registered&&human?'<button class="btn small" data-edit-validators="'+esc(p.id)+'">编辑验证器</button>':'')+'</article>'}).join(''):'<div class="panel empty">尚无项目。登记一个已有目录以开始。</div>';qa('[data-edit-validators]').forEach(function(b){b.onclick=function(){var project=rows.find(function(p){return p.id===b.dataset.editValidators});q('#validators-project-id').value=project.id;q('#validators-title').textContent=project.id+' · 验证器';q('#project-edit-validators').innerHTML='';Object.keys(project.validators||{}).forEach(function(id){addValidator(q('#project-edit-validators'),id,project.validators[id])});q('#validators-result').textContent='';setDirty(true);openDialog(q('#validators-dialog'), b)}});qa('[data-delete-project]').forEach(function(b){b.onclick=async function(){if(!confirm('删除 '+b.dataset.deleteProject+' 的项目登记，并清理 AgentBus 生成的 project.json？项目目录与用户文件保留。'))return;try{await api('/api/projects/'+encodeURIComponent(b.dataset.deleteProject),{method:'DELETE',body:{}});toast('项目登记已删除');await load(true)}catch(e){toast(e.message,true)}}})}

function dash(v){return v==null?'—':num(v)}

function renderRetentionLayers(){
  var el=q('#retention-layers');
  if(!el)return;
  var r=state.archive_retention,lg=state.logs_inventory;
  if(!r&&!lg){el.hidden=true;el.innerHTML='';return}
  var cfg=(r&&r.config)||{};
  var snap=(r&&r.snapshots)||null,bun=(r&&r.archive_bundles)||null;
  var bytes=function(v){if(v==null)return '—';if(v<1024)return v+' B';if(v<1048576)return (v/1024).toFixed(1)+' KB';if(v<1073741824)return (v/1048576).toFixed(1)+' MB';return (v/1073741824).toFixed(2)+' GB'};
  var when=function(v){return v?esc(fmt(v)):'—'};
  var unmanagedList=(lg&&lg.unmanaged_sample&&lg.unmanaged_sample.length)
    ? '<ul class="report-evidence">'+lg.unmanaged_sample.map(function(x){
        return '<li><code>'+esc(x.relative_path)+'</code> · '+bytes(x.size)+' · 置信 '+esc(x.confidence||'—')+' · '+esc(x.reason||'—')+(x.basis_detail?' · '+esc(x.basis_detail):'')+'</li>';
      }).join('')+'</ul>'
    : '<p class="help">没有不可归属的日志'+(lg&&lg.truncated?'（本样本已截断，详见 logs inventory）':'')+'</p>';
  el.hidden=false;
  el.innerHTML='<div class="panel"><h2>二级保留与旧日志</h2>'+
    '<h3>策略</h3><ul class="report-evidence">'+
      '<li>快照保留天数 '+dash(cfg.snapshot_days)+' · 最少保留 '+dash(cfg.min_snapshots)+' 个</li>'+
      '<li>归档包保留天数 '+dash(cfg.archive_bundle_days)+' · 最少保留 '+dash(cfg.min_archive_bundles)+' 个</li></ul>'+
    '<h3>文件</h3><ul class="report-evidence">'+
      '<li>数据库快照 '+dash(snap&&snap.count)+' 个 · '+bytes(snap&&snap.bytes)+' · 最新 '+when(snap&&snap.newest)+' · 最早 '+when(snap&&snap.oldest)+'</li>'+
      '<li>任务归档包 '+dash(bun&&bun.count)+' 个 · '+bytes(bun&&bun.bytes)+' · 最新 '+when(bun&&bun.newest)+' · 最早 '+when(bun&&bun.oldest)+'</li></ul>'+
    '<h3>日志归属</h3><p class="report-copy">扫描 '+dash(lg&&lg.scanned)+' 个 · 可归属 '+dash(lg&&lg.managed)+
      ' 个 · 不可归属 '+dash(lg&&lg.unmanaged)+' 个（'+bytes(lg&&lg.unmanaged_bytes)+'）</p>'+unmanagedList+
    '<p class="help">二级保留同样要 dry-run + plan hash + Human 确认；仍被 task_archives 引用的文件不可删除。不可归属（unmanaged）的日志只上报，永不删除。</p></div>';
}

// 事件绑定集中在这里，由 main 在启动时调用一次（模块 import 阶段不碰 DOM）。
export function bind() {
  q('#project-create-add-validator').onclick=function(){addValidator(q('#project-create-validators'))};q('#project-edit-add-validator').onclick=function(){addValidator(q('#project-edit-validators'))};q('#validators-close').onclick=function(){closeDialog(q('#validators-dialog'));dirty=false};q('#validators-form').addEventListener('submit',async function(e){e.preventDefault();try{var result=await api('/api/projects/'+encodeURIComponent(q('#validators-project-id').value)+'/validators',{method:'PUT',body:{validators:collectValidators(q('#project-edit-validators'))}});q('#validators-result').textContent='验证器已保存：'+result.config_path;dirty=false;await load(true)}catch(err){q('#validators-result').textContent=err.message;toast(err.message,true)}});
  q('#project-form').addEventListener('submit',async function(e){e.preventDefault();var result=q('#project-result'),button=q('#project-create-submit');button.disabled=true;try{var created=await api('/api/projects',{method:'POST',body:{id:q('#pf-id').value,path:q('#pf-path').value.trim()||undefined,topology:q('#pf-topology').value,agents:split(q('#pf-agents').value),validators:collectValidators(q('#project-create-validators'))}});result.textContent='项目已创建，配置位置：'+(created.config_path||created.project.path+'/project.json');q('#project-form').reset();q('#project-create-validators').innerHTML='';dirty=false;await load(true)}catch(err){result.textContent=err.message;toast(err.message,true)}finally{button.disabled=false}});
  // 二级保留 + 旧日志：只读展示。字段缺失一律显示「—」，不拿 0 冒充（0 和「没这项」是两件事）。
  // 归档概况只显示 /api/state 里 store 给的数：拿不到就整块隐藏，不编数字。
}

export { validatorRow, addValidator, collectValidators, renderProjects, dash, renderRetentionLayers };
