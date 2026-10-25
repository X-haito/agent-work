// DOM 与格式化助手（第 14 项第 3 阶段：从 app.js 拆出）。
// 只依赖 document，不依赖任何状态；可以放心被 view 与 main 共用。
export const statuses = ['open', 'proposed', 'claimed', 'in_progress', 'review', 'done', 'failed', 'declined', 'cancelled'];
export const statusNames = { open: '待认领', proposed: '待批准', claimed: '已认领', in_progress: '执行中', review: '待验收', done: '已完成', failed: '失败', declined: '已拒绝', cancelled: '已取消' };
export const names = { overview: '运行总览', tasks: '任务台账', reports: '任务报告', projects: '项目管理', policy: '调度策略', mcp: 'MCP 接入' };
export const redlineNames = { 'dep:install': '装依赖', 'fs:delete': '删除文件', 'git:risky': 'git 危险操作', 'cfg:edit': '改规则文件', 'net:egress': '出网', 'wide:change': '大范围改动' };

let toastTimer = null;

function q(s){return document.querySelector(s)} function qa(s){return Array.prototype.slice.call(document.querySelectorAll(s))}
function esc(v){return String(v==null?'':v).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;')}
function fmt(v){if(!v)return '—';var d=new Date(v);return d.toLocaleString('zh-CN',{month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit'})}
function num(v){return Number(v||0).toLocaleString('zh-CN')} function statusLabel(v){return statusNames[v]||v}
function csv(v){return (v||[]).join(', ')} function split(v){return String(v||'').replaceAll('，',',').replaceAll(String.fromCharCode(10),',').split(',').map(function(x){return x.trim()}).filter(Boolean)}
function toast(msg,error){var el=q('#toast');el.textContent=msg;el.className='toast show'+(error?' error':'');clearTimeout(toastTimer);toastTimer=setTimeout(function(){el.className='toast'},3500)}

export { q, qa, esc, fmt, num, statusLabel, toast, csv, split };
