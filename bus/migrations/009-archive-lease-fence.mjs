// 第 10 项长尾：归档租约加单调递增 fence_token（第 1 条）。
// 加列是幂等的；真正的"旧 worker 不能提交"由 archive.mjs 在最终事务里复核 token 实现。
export default {
  version: 9,
  name: 'archive-lease-fence-token',
  tables: [['archive_leases', [['fence_token', 'INTEGER NOT NULL DEFAULT 0']]]],
};
