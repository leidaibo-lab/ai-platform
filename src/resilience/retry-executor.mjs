import { setTimeout as delay } from "node:timers/promises";

/**
 * @typedef {object} ResilienceContext
 * @property {string|null} traceId - 跨阶段关联标识。
 * @property {string|null} requestId - 渠道幂等请求标识。
 * @property {string|null} conversationId - 会话标识。
 * @property {string|null} runId - Runtime Run 标识。
 * @property {number} deadlineAt - 整个 Run 或独立操作共享的绝对截止时间戳。
 * @property {string|null} stage - 当前执行阶段。
 * @property {string|null} lastCommittedStage - 最近已持久化的稳定阶段。
 * @property {string|null} idempotencyKey - 当前操作复用的幂等键。
 * @property {boolean} outputStarted - 是否已经向调用方交付有效输出。
 * @property {boolean} retryBoundaryCrossed - 是否已进入不可安全重放整段任务的执行阶段。
 */

/**
 * @typedef {object} RetryPolicy
 * @property {string} operation - 当前重试操作名称。
 * @property {number} maxAttempts - 包含首次调用的最大尝试次数。
 * @property {(error: unknown, input: object) => boolean} shouldRetry - 判断错误是否允许重试。
 * @property {(error: unknown, input: object) => number} calculateBackoffMs - 返回下一次尝试前的等待毫秒数。
 * @property {(error: unknown) => object} describeError - 返回不含敏感正文的错误分类。
 */

/**
 * @typedef {object} RetryAttemptTrace
 * @property {number} attempt - 从 1 开始的当前阶段尝试序号。
 * @property {string} startedAt - ISO 格式尝试开始时间。
 * @property {number} durationMs - 当前尝试耗时。
 * @property {"completed"|"failed"} status - 当前尝试结果。
 * @property {string|null} errorType - 脱敏错误分类。
 * @property {number|null} statusCode - 可用时记录的 HTTP 状态。
 * @property {boolean} retryable - 当前错误与重放边界是否允许平台自动重试。
 * @property {boolean} willRetry - 次数与截止时间是否允许继续尝试。
 * @property {number} backoffMs - 实际计划执行的退避时间。
 * @property {string} stopReason - 完成、重试或终止原因。
 */

/**
 * @typedef {object} RetryTrace
 * @property {string|null} traceId - 跨阶段关联标识。
 * @property {string|null} requestId - 渠道幂等请求标识。
 * @property {string|null} conversationId - 会话标识。
 * @property {string|null} runId - Runtime Run 标识。
 * @property {string} operation - 当前操作名称。
 * @property {number} maxAttempts - 最大尝试次数。
 * @property {number} attemptCount - 已执行尝试次数。
 * @property {string} deadlineAt - ISO 格式绝对截止时间。
 * @property {string|null} stage - 当前执行阶段。
 * @property {string|null} lastCommittedStage - 最近已提交的稳定阶段。
 * @property {string|null} idempotencyKey - 当前操作幂等键。
 * @property {boolean} outputStarted - 是否已经交付有效输出。
 * @property {boolean} retryBoundaryCrossed - 是否已进入不可安全重放整段任务的执行阶段。
 * @property {RetryAttemptTrace[]} attempts - 按执行顺序保存的逐尝试证据。
 */

export class RetryExecutionError extends Error {
  /** 保存最终原始错误和完整逐尝试证据，供调用层映射稳定错误契约。 */
  constructor(cause, resilience) {
    super(cause?.message || "Retry execution failed", { cause });
    this.name = "RetryExecutionError";
    this.resilience = resilience;
  }
}

export class RetryDeadlineError extends Error {
  /** 表示操作在发起下一次外部调用前已经耗尽共享截止时间。 */
  constructor() {
    super("Retry deadline exceeded");
    this.name = "RetryDeadlineError";
  }
}

/**
 * 创建只读韧性上下文，保证同一 Run 的身份、截止时间和恢复边界保持一致。
 *
 * @param {Partial<ResilienceContext> & {deadlineAt: number}} input - Run 或独立操作的恢复信息。
 * @returns {ResilienceContext} 规范化且冻结的韧性上下文。
 */
export function createResilienceContext(input) {
  const deadlineAt = Number(input?.deadlineAt);
  if (!Number.isFinite(deadlineAt)) throw new TypeError("resilience deadlineAt must be a finite timestamp");
  return Object.freeze({
    traceId: normalizeOptionalString(input.traceId),
    requestId: normalizeOptionalString(input.requestId),
    conversationId: normalizeOptionalString(input.conversationId),
    runId: normalizeOptionalString(input.runId),
    deadlineAt,
    stage: normalizeOptionalString(input.stage),
    lastCommittedStage: normalizeOptionalString(input.lastCommittedStage),
    idempotencyKey: normalizeOptionalString(input.idempotencyKey),
    outputStarted: Boolean(input.outputStarted),
    retryBoundaryCrossed: Boolean(input.retryBoundaryCrossed),
  });
}

/**
 * 按调用方策略执行一个可重试操作，并生成不包含业务正文的逐尝试证据。
 * Strategy 模式把通用尝试循环与各阶段的错误分类、退避和幂等边界分离。
 *
 * @param {object} input - 执行上下文、策略、任务和可替换时钟依赖。
 * @param {ResilienceContext} input.context - 共享韧性上下文。
 * @param {RetryPolicy} input.policy - 当前操作的重试策略。
 * @param {(attempt: object) => Promise<unknown>} input.task - 执行单次外部调用的任务。
 * @param {() => number} [input.nowImplementation=Date.now] - 可替换时钟，供确定性测试使用。
 * @param {(delayMs: number, input: object) => Promise<void>} [input.sleepImplementation] - 可替换退避等待。
 * @param {AbortSignal} [input.abortSignal] - 调用方取消信号。
 * @returns {Promise<{value: unknown, resilience: object}>} 成功结果和完整尝试证据。
 * @throws {RetryExecutionError} 达到终止条件时保留最后错误和尝试证据。
 */
export async function executeWithRetry({
  context,
  policy,
  task,
  nowImplementation = Date.now,
  sleepImplementation = waitForRetry,
  abortSignal,
}) {
  validateRetryInput(context, policy, task);
  const attempts = [];
  let outputStarted = context.outputStarted;
  let retryBoundaryCrossed = context.retryBoundaryCrossed;

  /** 标记当前操作已经产生不可静默重放的有效输出。 */
  function markOutputStarted() {
    outputStarted = true;
  }

  /** 标记当前操作已进入不可安全重放整段任务的阶段。 */
  function markRetryBoundaryCrossed() {
    retryBoundaryCrossed = true;
  }

  for (let attempt = 1; attempt <= policy.maxAttempts; attempt += 1) {
    if (abortSignal?.aborted) {
      throw new RetryExecutionError(
        abortSignal.reason || createAbortError(),
        buildRetryTrace(context, policy, attempts, { outputStarted, retryBoundaryCrossed }),
      );
    }

    const startedAt = nowImplementation();
    const remainingMs = Math.floor(context.deadlineAt - startedAt);
    if (remainingMs <= 0) {
      throw new RetryExecutionError(
        new RetryDeadlineError(),
        buildRetryTrace(context, policy, attempts, { outputStarted, retryBoundaryCrossed }),
      );
    }

    try {
      const value = await task({
        attempt,
        maxAttempts: policy.maxAttempts,
        deadlineAt: context.deadlineAt,
        remainingMs,
        markOutputStarted,
        markRetryBoundaryCrossed,
      });
      const endedAt = nowImplementation();
      attempts.push({
        attempt,
        startedAt: new Date(startedAt).toISOString(),
        durationMs: Math.max(0, endedAt - startedAt),
        status: "completed",
        errorType: null,
        statusCode: null,
        retryable: false,
        willRetry: false,
        backoffMs: 0,
        stopReason: "completed",
      });
      return {
        value,
        resilience: buildRetryTrace(context, policy, attempts, { outputStarted, retryBoundaryCrossed }),
      };
    } catch (error) {
      const endedAt = nowImplementation();
      const description = policy.describeError(error);
      const retryableByPolicy = policy.shouldRetry(error, { attempt, context, description });
      const retryable = !outputStarted && !retryBoundaryCrossed && retryableByPolicy;
      const requestedBackoffMs = normalizeDelay(policy.calculateBackoffMs(error, { attempt, context, description }));
      const remainingAfterAttemptMs = Math.floor(context.deadlineAt - endedAt);
      const hasAnotherAttempt = attempt < policy.maxAttempts;
      const hasBackoffBudget = remainingAfterAttemptMs > requestedBackoffMs;
      const willRetry = retryable && hasAnotherAttempt && hasBackoffBudget;
      const attemptTrace = {
        attempt,
        startedAt: new Date(startedAt).toISOString(),
        durationMs: Math.max(0, endedAt - startedAt),
        status: "failed",
        errorType: String(description.errorType || "unknown"),
        statusCode: Number.isFinite(description.statusCode) ? Number(description.statusCode) : null,
        retryable,
        willRetry,
        backoffMs: willRetry ? requestedBackoffMs : 0,
        stopReason: selectStopReason({
          retryableByPolicy,
          outputStarted,
          retryBoundaryCrossed,
          hasAnotherAttempt,
          hasBackoffBudget,
        }),
      };
      attempts.push(attemptTrace);

      if (!willRetry) {
        throw new RetryExecutionError(
          error,
          buildRetryTrace(context, policy, attempts, { outputStarted, retryBoundaryCrossed }),
        );
      }

      try {
        await sleepImplementation(requestedBackoffMs, { abortSignal });
      } catch (sleepError) {
        attemptTrace.willRetry = false;
        attemptTrace.backoffMs = 0;
        attemptTrace.stopReason = "cancelled";
        throw new RetryExecutionError(
          sleepError,
          buildRetryTrace(context, policy, attempts, { outputStarted, retryBoundaryCrossed }),
        );
      }
    }
  }

  throw new RetryExecutionError(
    new Error("Retry attempts exhausted"),
    buildRetryTrace(context, policy, attempts, { outputStarted, retryBoundaryCrossed }),
  );
}

/** 校验重试执行器所需的不变量，避免无界循环或缺失恢复上下文。 */
function validateRetryInput(context, policy, task) {
  if (!context || !Number.isFinite(context.deadlineAt)) throw new TypeError("retry context deadlineAt is required");
  if (!policy?.operation) throw new TypeError("retry policy operation is required");
  if (!Number.isInteger(policy.maxAttempts) || policy.maxAttempts < 1) {
    throw new TypeError("retry policy maxAttempts must be a positive integer");
  }
  if (typeof policy.shouldRetry !== "function" || typeof policy.calculateBackoffMs !== "function") {
    throw new TypeError("retry policy decision functions are required");
  }
  if (typeof policy.describeError !== "function" || typeof task !== "function") {
    throw new TypeError("retry policy describeError and task are required");
  }
}

/** 构造可持久化的重试证据，并复制尝试记录避免调用方反向修改内部状态。 */
function buildRetryTrace(
  context,
  policy,
  attempts,
  {
    outputStarted = context.outputStarted,
    retryBoundaryCrossed = context.retryBoundaryCrossed,
  } = {},
) {
  const attemptCopies = [];
  for (const attempt of attempts) attemptCopies.push({ ...attempt });
  return {
    traceId: context.traceId,
    requestId: context.requestId,
    conversationId: context.conversationId,
    runId: context.runId,
    operation: policy.operation,
    maxAttempts: policy.maxAttempts,
    attemptCount: attemptCopies.length,
    deadlineAt: new Date(context.deadlineAt).toISOString(),
    stage: context.stage,
    lastCommittedStage: context.lastCommittedStage,
    idempotencyKey: context.idempotencyKey,
    outputStarted,
    retryBoundaryCrossed,
    attempts: attemptCopies,
  };
}

/** 根据错误可重试性、次数和时间预算返回稳定的停止原因。 */
function selectStopReason({
  retryableByPolicy,
  outputStarted,
  retryBoundaryCrossed,
  hasAnotherAttempt,
  hasBackoffBudget,
}) {
  if (!retryableByPolicy) return "not-retryable";
  if (outputStarted) return "output-started";
  if (retryBoundaryCrossed) return "retry-boundary-crossed";
  if (!hasAnotherAttempt) return "max-attempts";
  if (!hasBackoffBudget) return "deadline";
  return "retrying";
}

/** 把策略返回的退避值限制为非负整数，避免异常计时输入。 */
function normalizeDelay(value) {
  const delayMs = Number(value);
  return Number.isFinite(delayMs) && delayMs > 0 ? Math.floor(delayMs) : 0;
}

/** 把可选标识统一转换为非空字符串或 null。 */
function normalizeOptionalString(value) {
  const normalized = String(value || "").trim();
  return normalized || null;
}

/** 使用支持 AbortSignal 的 Node 计时器等待下一次尝试。 */
async function waitForRetry(delayMs, { abortSignal } = {}) {
  await delay(delayMs, undefined, abortSignal ? { signal: abortSignal } : undefined);
}

/** 创建未提供具体取消原因时使用的标准 AbortError。 */
function createAbortError() {
  return new DOMException("Retry execution was aborted", "AbortError");
}
