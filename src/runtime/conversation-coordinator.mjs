/**
 * 创建按 conversationId 串行执行 Run 的进程内协调器。
 *
 * 数据库乐观锁仍是跨进程正确性保障；该协调器只负责减少同一进程内的重复并发和乱序回答。
 *
 * @returns {{runExclusive: (conversationId: string, operation: () => Promise<unknown>, execution?: {abortSignal?: AbortSignal}) => Promise<unknown>}} 协调器 API。
 */
export function createConversationCoordinator() {
  const queues = new Map();

  return {
    /** 将同一会话的操作追加到串行 Promise 链；排队取消立即返回，但内部队列仍等待前序操作释放。 */
    async runExclusive(conversationId, operation, execution = {}) {
      const abortSignal = execution?.abortSignal;
      const previous = queues.get(conversationId) || Promise.resolve();
      let operationStarted = false;
      /** 前序操作结束后再次检查取消，已返回调用方的排队任务不得迟到执行。 */
      function executeQueuedOperation() {
        throwIfAborted(abortSignal);
        operationStarted = true;
        return operation();
      }
      // 前一个操作失败也必须释放队列，让后续 Run 可以继续。
      const current = previous.catch(ignorePreviousFailure).then(executeQueuedOperation);
      queues.set(conversationId, current);
      /** 只在真实队列节点结束后清理尾指针，调用方提前收到取消不能破坏串行性。 */
      function releaseQueueEntry() {
        if (queues.get(conversationId) === current) queues.delete(conversationId);
      }
      void current.then(releaseQueueEntry, releaseQueueEntry);
      /** 判断当前节点是否仍只在等待前序操作。 */
      function isQueued() {
        return !operationStarted;
      }
      return await settleOperationOrAbort(current, abortSignal, isQueued);
    },
  };
}

/** 忽略前序队列错误，错误已经由原调用方接收。 */
function ignorePreviousFailure() {}

/** 在不提前释放内部队列节点的前提下，让当前调用方即时收到排队取消。 */
function settleOperationOrAbort(operation, abortSignal, isQueued) {
  if (!abortSignal) return operation;
  if (abortSignal.aborted) return Promise.reject(readAbortReason(abortSignal));
  return new Promise(
    /** 同时观察队列结果和取消信号，并在首次结算后移除事件监听。 */
    (resolve, reject) => {
      let settled = false;
      /** 移除仍未触发的取消监听，避免已完成 Run 长期保留闭包。 */
      function cleanup() {
        abortSignal.removeEventListener("abort", rejectForAbort);
      }
      /** 只允许队列成功成为当前调用的首次结算结果。 */
      function resolveOperation(value) {
        if (settled) return;
        settled = true;
        cleanup();
        resolve(value);
      }
      /** 只允许队列失败成为当前调用的首次结算结果。 */
      function rejectOperation(error) {
        if (settled) return;
        settled = true;
        cleanup();
        reject(error);
      }
      /** 调用方取消时立即拒绝；内部 operation 仍留在队列中并会在执行前再次检查信号。 */
      function rejectForAbort() {
        if (!isQueued()) return;
        rejectOperation(readAbortReason(abortSignal));
      }
      abortSignal.addEventListener("abort", rejectForAbort, { once: true });
      operation.then(resolveOperation, rejectOperation);
    },
  );
}

/** 在队列操作即将执行时同步拒绝已取消信号。 */
function throwIfAborted(abortSignal) {
  if (abortSignal?.aborted) throw readAbortReason(abortSignal);
}

/** 读取调用方取消原因；没有显式原因时创建标准 AbortError。 */
function readAbortReason(abortSignal) {
  return abortSignal?.reason || new DOMException("Queued operation was aborted", "AbortError");
}
