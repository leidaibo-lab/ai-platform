const DEFAULT_POLL_MS = 500;
const DEFAULT_NOT_FOUND_MS = 15000;
const DEFAULT_STALLED_MS = 135000;
const TERMINAL_RUN_STATUSES = new Set(["completed", "failed", "cancelled"]);

/** 返回系统当前时间，作为可由测试替换的轮询时钟 Port。 */
function readCurrentTime() {
  return Date.now();
}

/** 等待下一次事实查询，默认使用浏览器短定时器。 */
function waitForPoll(delayMs) {
  return new Promise(
    // Promise executor 只负责建立一次可控的短轮询间隔。
    (resolve) => setTimeout(resolve, delayMs),
  );
}

/** 默认忽略轮询快照，供不需要阶段渲染的调用方复用协调器。 */
function ignoreSnapshot() {}

/** 默认忽略长时间运行通知，协调器仍会继续查询最终事实。 */
function ignoreStalledRun() {}

/** 判断 Run 状态是否已经形成不可逆的服务端终止事实。 */
export function isTerminalRunStatus(status) {
  return TERMINAL_RUN_STATUSES.has(status);
}

/** 从会话公开的最近 Run 中按 requestId 读取事实，不按列表位置猜测当前请求。 */
export function findRunByRequestId(detail, requestId) {
  for (const run of [detail?.latestRun, detail?.lastRun]) {
    if (run?.requestId === requestId) return run;
  }
  return null;
}

/**
 * 在 POST SSE 终止事实丢失后持续轮询同一 requestId。
 * 长时间运行只触发一次提示，不会停止协调或释放幂等发送门禁。
 *
 * @param {string} conversationId - Run 所属会话。
 * @param {string} requestId - 原始幂等标识。
 * @param {object} options - 事实读取、页面生命周期、阶段回调与可测试时钟。
 * @returns {Promise<{state: string, detail: object|null, run: object|null}>} 最终、确认未创建或组件放弃状态。
 */
export async function waitForRunTerminalFact(conversationId, requestId, {
  readConversation,
  shouldContinue,
  onSnapshot = ignoreSnapshot,
  onStalled = ignoreStalledRun,
  now = readCurrentTime,
  wait = waitForPoll,
  pollMs = DEFAULT_POLL_MS,
  notFoundMs = DEFAULT_NOT_FOUND_MS,
  stalledMs = DEFAULT_STALLED_MS,
}) {
  if (typeof readConversation !== "function") {
    throw new TypeError("A conversation reader is required");
  }
  if (typeof shouldContinue !== "function") {
    throw new TypeError("A reconciliation lifecycle guard is required");
  }
  const startedAt = now();
  let lastDetail = null;
  let lastRun = null;
  let observedRun = false;
  let stalledNotified = false;
  while (shouldContinue()) {
    let readSucceeded = false;
    try {
      lastDetail = await readConversation(conversationId);
      lastRun = findRunByRequestId(lastDetail, requestId);
      readSucceeded = true;
      observedRun ||= Boolean(lastRun);
      onSnapshot(lastDetail, lastRun);
      if (lastRun && isTerminalRunStatus(lastRun.status)) {
        return { state: lastRun.status, detail: lastDetail, run: lastRun };
      }
    } catch {
      // 临时读取失败不改变原 Run 状态，也不能作为“未创建”的证据。
    }
    const elapsedMs = now() - startedAt;
    if (readSucceeded && !observedRun && !lastRun && elapsedMs >= notFoundMs) {
      return { state: "not-found", detail: lastDetail, run: null };
    }
    if (!stalledNotified && elapsedMs >= stalledMs) {
      stalledNotified = true;
      onStalled({ detail: lastDetail, run: lastRun, elapsedMs });
    }
    await wait(Math.max(0, Number(pollMs) || 0));
  }
  return { state: "abandoned", detail: lastDetail, run: lastRun };
}
