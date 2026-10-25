// Pure message-routing helpers shared by all supervisors.
// Keep routing deterministic so irrelevant bus traffic never starts a model turn.

export function refTaskId(message) {
  const m = message || {};
  if (m.thread) return m.thread;
  if (!m.refs) return null;
  try {
    const refs = typeof m.refs === 'string' ? JSON.parse(m.refs) : m.refs;
    return refs && refs.task ? String(refs.task) : null;
  } catch (e) { return null; }
}

// 上限类事件：任务已到轮次上限，或消息链已到长度上限。
// 它们是"机器已经判定停手"的信号，只给 Lead 与 Human，绝不能唤醒 worker 再起一圈。
export const ESCALATION_KINDS = ['retry_exceeded', 'chain_limit'];

export function isEscalationKind(message) {
  const kind = String((message && message.kind) || '');
  return ESCALATION_KINDS.indexOf(kind) >= 0;
}

function isThreadRecipient(value) {
  return typeof value === 'string' && value.indexOf('thread:') === 0;
}

export function isRelevantMessage(message, context) {
  const m = message || {};
  const ctx = context || {};
  const agent = ctx.agent;
  const isLead = ctx.isLead === true;
  const mine = ctx.mine instanceof Set ? ctx.mine : new Set(ctx.mine || []);
  const getTask = typeof ctx.getTask === 'function' ? ctx.getTask : function () { return null; };

  // 升级事件先判：它们的 recipient 可能写着 worker、thread 也可能正是 worker 自己的任务，
  // 走到下面的分支就会被当成"点名给我"而白起一次模型回合。Lead 永远要看到，worker 永远不。
  if (isEscalationKind(m)) return isLead;

  // Direct messages are for exactly one node. task.new to a Worker is useful only
  // while the referenced card is actually open; proposed/stale cards must not wake it.
  if (m.recipient === agent) {
    if (m.kind !== 'task.new') return true;
    if (isLead && m.sender === 'human') return true;
    const id = refTaskId(m);
    const task = id ? getTask(id) : null;
    return !!task && task.status === 'open';
  }

  // A question without an explicit agent target is a decision request for Lead,
  // not an invitation to wake every Worker that can see the thread.
  if (m.kind === 'question') {
    return isLead && (m.recipient === 'broadcast' || m.recipient === '*' || isThreadRecipient(m.recipient));
  }

  // Owners receive state/evidence updates for their own task, but not unrelated chatter.
  if (m.thread && mine.has(m.thread)) {
    return ['answer', 'note', 'status', 'handoff', 'task.progress', 'task.cancelled'].indexOf(m.kind) >= 0;
  }

  // Lead wakes only for decisions and terminal review outcomes.
  if (isLead && ['task.review', 'task.failed', 'task.declined'].indexOf(m.kind) >= 0) return true;
  if (isLead && m.kind === 'task.new' && m.sender === 'human') return true;
  return false;
}

export function compactMessages(messages) {
  const rows = Array.isArray(messages) ? messages : [];
  const seen = new Set();
  const out = [];
  for (let i = rows.length - 1; i >= 0; i--) {
    const m = rows[i];
    const task = refTaskId(m);
    let key = null;
    if (task && ['task.review', 'task.failed', 'task.declined', 'task.cancelled', 'task.done'].indexOf(m.kind) >= 0) {
      key = 'state:' + task;
    } else if (task && m.kind === 'task.progress') {
      key = 'progress:' + task;
    }
    if (key && seen.has(key)) continue;
    if (key) seen.add(key);
    out.push(m);
  }
  return out.reverse();
}

export function routeMessages(messages, context) {
  return compactMessages((messages || []).filter(function (m) { return isRelevantMessage(m, context); }));
}

function listOf(value) {
  if (Array.isArray(value)) return value;
  if (!value) return [];
  try {
    const parsed = JSON.parse(String(value));
    return Array.isArray(parsed) ? parsed : [];
  } catch (e) { return []; }
}

export function canAutoAccept(task, policy) {
  if (!task || task.status !== 'review' || Number(task.needs_human) === 1) return false;
  const auto = policy && policy.economics && Array.isArray(policy.economics.auto_accept)
    ? policy.economics.auto_accept : [];
  if (auto.indexOf(task.cost_class) < 0) return false;
  if (listOf(task.redline).length || listOf(task.grants).length || listOf(task.extra_dirs).length) return false;
  let guard = task.guard;
  if (typeof guard === 'string') { try { guard = JSON.parse(guard); } catch (e) { return false; } }
  return !!guard && guard.truncated !== true && guard.ok === true && Array.isArray(guard.hard) && guard.hard.length === 0;
}
