#!/usr/bin/env node
// DSH 自动唤醒入口。执行逻辑与 Claude worker 共用，避免两套认领/续租/守卫规则漂移。
process.env.BUS_SUPERVISOR_ENGINE = 'dsh';
if (!process.env.AGENT_BUS_ID) process.env.AGENT_BUS_ID = 'dsh/main';
await import('./claude-supervisor.mjs');
