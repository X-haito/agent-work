#!/usr/bin/env node
import assert from 'node:assert/strict';
import { isRelevantMessage, routeMessages, canAutoAccept } from './message-routing.mjs';

let passed = 0;
function check(value, message) {
  assert.ok(value, message);
  passed++;
}

const tasks = new Map([
  ['T-open', { id: 'T-open', status: 'open' }],
  ['T-proposed', { id: 'T-proposed', status: 'proposed' }],
]);
const getTask = function (id) { return tasks.get(id) || null; };
const lead = { agent: 'codex/main', isLead: true, mine: new Set(), getTask: getTask };
const claude = { agent: 'claude/main', isLead: false, mine: new Set(['T-mine']), getTask: getTask };
const dsh = { agent: 'dsh/main', isLead: false, mine: new Set(), getTask: getTask };

const directQuestion = { kind: 'question', sender: 'claude/main', recipient: 'codex/main', thread: 'T-q' };
check(isRelevantMessage(directQuestion, lead), '定向问题应唤醒接收方');
check(!isRelevantMessage(directQuestion, dsh), '定向问题不应唤醒其他 Worker');

const threadQuestion = { kind: 'question', sender: 'claude/main', recipient: 'thread:T-q', thread: 'T-q' };
check(isRelevantMessage(threadQuestion, lead), 'thread 问题应交给 Lead');
check(!isRelevantMessage(threadQuestion, claude), 'thread 问题不应广播唤醒 Worker');

check(isRelevantMessage({ kind: 'task.progress', recipient: 'thread:T-mine', thread: 'T-mine' }, claude), 'owner 应收到自己的进展');
check(!isRelevantMessage({ kind: 'task.progress', recipient: 'thread:T-other', thread: 'T-other' }, claude), 'owner 不应收到无关进展');

check(isRelevantMessage({ kind: 'task.new', sender: 'codex/main', recipient: 'claude/main', thread: 'T-open' }, claude), 'open task.new 应唤醒目标 Worker');
check(!isRelevantMessage({ kind: 'task.new', sender: 'codex/main', recipient: 'claude/main', thread: 'T-proposed' }, claude), 'proposed task.new 不应唤醒 Worker');
check(isRelevantMessage({ kind: 'task.new', sender: 'human', recipient: 'codex/main', thread: 'T-user' }, lead), 'Human 新需求应进入 Lead 规划');

const compacted = routeMessages([
  { seq: 1, kind: 'task.review', recipient: 'codex/main', thread: 'T-state' },
  { seq: 2, kind: 'task.failed', recipient: 'codex/main', thread: 'T-state' },
], lead);
check(compacted.length === 1 && compacted[0].seq === 2, '同任务状态只保留最新一条');

const progress = routeMessages([
  { seq: 3, kind: 'task.progress', recipient: 'thread:T-mine', thread: 'T-mine' },
  { seq: 4, kind: 'task.progress', recipient: 'thread:T-mine', thread: 'T-mine' },
], claude);
check(progress.length === 1 && progress[0].seq === 4, '同任务进展只保留最新一条');

const policy = { economics: { auto_accept: ['mechanical', 'tests', 'docs'] } };
const clean = {
  status: 'review', cost_class: 'tests', needs_human: 0,
  redline: '[]', grants: '[]', extra_dirs: '[]',
  guard: JSON.stringify({ ok: true, hard: [] }),
};
check(canAutoAccept(clean, policy), '干净的低风险 review 应自动验收');
check(!canAutoAccept({ ...clean, cost_class: 'architectural' }, policy), '未配置的成本档不能自动验收');
check(!canAutoAccept({ ...clean, needs_human: 1 }, policy), 'needs_human 不能自动验收');
check(!canAutoAccept({ ...clean, redline: '["fs:delete"]' }, policy), '红线任务不能自动验收');
check(!canAutoAccept({ ...clean, guard: JSON.stringify({ ok: false, hard: ['scope'] }) }, policy), '守卫失败不能自动验收');

console.log('smoke-routing: ' + passed + ' passed');
