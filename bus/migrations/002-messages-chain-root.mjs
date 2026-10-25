// 第 12 项第 5 条：版本化迁移步骤 002（第 7 项：消息链根，用于跨 hop 追踪整条链路）。
export default {
  version: 2,
  name: 'messages-chain-root',
  tables: [['messages', [['chain_root', 'TEXT']]]],
};
