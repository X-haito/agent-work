// 单一页面状态（第 14 项第 3 阶段）。
// state / dirty / stopped / showTerminal 都是 **live binding**：别的模块 import 进来读到的永远是当前值，
// 但只能通过 setter 改（ESM 里给 import 进来的绑定赋值会直接报错，这是好事：状态只有一个写入口）。
import { esc, num, redlineNames } from './components/dom.mjs';

export let state = null;
export let dirty = false;
export let stopped = false;
export let showTerminal = false;
export function setState(next) { state = next; }
export function setDirty(v) { dirty = !!v; }
export function setStopped(v) { stopped = !!v; }
export function setShowTerminal(v) { showTerminal = !!v; }
export function isDirty() { return dirty; }
// main 在启动时把自己的 load() 注册进来，view 不用为了"刷新"去 import main（否则就是循环依赖）。
export const runtime = { load: function () {}, go: function () {}, dialog: null };

function redlineList(v){return (Array.isArray(v)?v:[]).map(function(k){return redlineNames[k]||String(k)})}
function canRelease(t){return !!t&&t.status==='failed'}
function guardBadges(t){var out=[];redlineList(t.redline).forEach(function(x){out.push('<span class="badge redline" title="红线违规：'+esc(x)+'">'+esc(x)+'</span>')});if(t.needs_human)out.push('<span class="badge human" title="'+(t.escalated_at?('升级于 '+esc(t.escalated_at)):'等待人类处理')+'">需人审</span>');if(Number(t.changed_files||0)>20)out.push('<span class="badge files">改动 '+num(t.changed_files)+' 文件</span>');return out.length?'<div class="badges">'+out.join('')+'</div>':''}
function taskCost(id){return ((state.cost||{}).by_task||[]).find(function(x){return x.task_id===id})||{in:0,out:0,total:0,t:0,agents:[]}}
function onlineMap(){var m={};(state.agents||[]).forEach(function(a){m[a.agent_id]=a});return m}

export { redlineList, canRelease, guardBadges, taskCost, onlineMap };
