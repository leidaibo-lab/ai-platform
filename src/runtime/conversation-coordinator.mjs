/**
 * 创建按 conversationId 串行执行 Run 的进程内协调器。
 *
 * 数据库乐观锁仍是跨进程正确性保障；该协调器只负责减少同一进程内的重复并发和乱序回答。
 *
 * @returns {{runExclusive: (conversationId: string, operation: () => Promise<unknown>) => Promise<unknown>}} 协调器 API。
 */
export function createConversationCoordinator() {
  const queues = new Map();

  return {
    /** 将同一会话的操作追加到串行 Promise 链，不阻塞其他会话。 */
    async runExclusive(conversationId, operation) {
      const previous = queues.get(conversationId) || Promise.resolve();
      // 前一个操作失败也必须释放队列，让后续 Run 可以继续。
      const current = previous.catch(ignorePreviousFailure).then(operation);
      queues.set(conversationId, current);
      try {
        return await current;
      } finally {
        if (queues.get(conversationId) === current) queues.delete(conversationId);
      }
    },
  };
}

/** 忽略前序队列错误，错误已经由原调用方接收。 */
function ignorePreviousFailure() {}
