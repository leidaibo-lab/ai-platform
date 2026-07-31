#!/usr/bin/env node
import assert from "node:assert/strict";
import test from "node:test";
import {
  RetryExecutionError,
  createResilienceContext,
  executeWithRetry,
} from "../src/resilience/retry-executor.mjs";

/** 验证通用执行器在同一截止时间内局部重试，并保留全部尝试证据。 */
async function testRetryExecutorCompletesWithinSharedDeadline() {
  let now = 1000;
  let calls = 0;
  const sleeps = [];
  const context = createResilienceContext({
    traceId: "trace-1",
    requestId: "request-1",
    conversationId: "conversation-1",
    runId: "run-1",
    deadlineAt: 2000,
    lastCommittedStage: "user-message-committed",
    idempotencyKey: "request-1",
  });

  /** 返回确定性测试时钟。 */
  function nowImplementation() {
    return now;
  }

  /** 记录退避并推进确定性测试时钟。 */
  async function sleepImplementation(delayMs) {
    sleeps.push(delayMs);
    now += delayMs;
  }

  /** 前两次模拟 503，第三次返回成功结果。 */
  async function task() {
    calls += 1;
    now += 10;
    if (calls < 3) throw createStatusError(503);
    return "completed";
  }

  const execution = await executeWithRetry({
    context,
    policy: createTestPolicy({ maxAttempts: 3, backoffMs: 20 }),
    task,
    nowImplementation,
    sleepImplementation,
  });

  assert.equal(execution.value, "completed");
  assert.equal(calls, 3);
  assert.deepEqual(sleeps, [20, 20]);
  assert.equal(execution.resilience.attemptCount, 3);
  assert.deepEqual(execution.resilience.attempts.map(readAttemptStatus), ["failed", "failed", "completed"]);
  assert.equal(execution.resilience.runId, "run-1");
}

test("retry executor preserves one context across local attempts", testRetryExecutorCompletesWithinSharedDeadline);

/** 验证任务越过显式重试边界后，瞬时错误也不会重放整段执行。 */
async function testRetryExecutorStopsAfterRetryBoundary() {
  let calls = 0;
  const context = createResilienceContext({ deadlineAt: 2000 });

  /** 模拟先进入不可重放阶段，随后返回可重试的服务端错误。 */
  async function task({ markRetryBoundaryCrossed }) {
    calls += 1;
    markRetryBoundaryCrossed();
    throw createStatusError(503);
  }

  /** 保持测试尝试始终处于共享截止时间内。 */
  function nowImplementation() {
    return 1000;
  }

  await assert.rejects(
    executeWithRetry({
      context,
      policy: createTestPolicy({ maxAttempts: 3, backoffMs: 0 }),
      task,
      nowImplementation,
    }),
    isRetryBoundaryStoppedRetry,
  );
  assert.equal(calls, 1);
}

test("retry executor does not replay a task after its retry boundary", testRetryExecutorStopsAfterRetryBoundary);

/** 验证剩余时间不足以完成退避时停止，不把每次尝试重新赋予完整超时。 */
async function testRetryExecutorStopsAtDeadline() {
  let now = 1000;
  const context = createResilienceContext({ deadlineAt: 1050 });

  /** 返回确定性测试时钟。 */
  function nowImplementation() {
    return now;
  }

  /** 消耗大部分总预算后返回瞬时错误。 */
  async function task() {
    now += 40;
    throw createStatusError(503);
  }

  await assert.rejects(
    executeWithRetry({
      context,
      policy: createTestPolicy({ maxAttempts: 3, backoffMs: 20 }),
      task,
      nowImplementation,
    }),
    isDeadlineStoppedRetry,
  );
}

test("retry executor stops when the shared deadline cannot cover backoff", testRetryExecutorStopsAtDeadline);

/** 创建仅供执行器测试使用的状态码策略。 */
function createTestPolicy({ maxAttempts, backoffMs }) {
  return {
    operation: "test.operation",
    maxAttempts,
    shouldRetry: isServerError,
    calculateBackoffMs: createFixedBackoff(backoffMs),
    describeError: describeStatusError,
  };
}

/** 判断错误是否为测试允许重试的服务端错误。 */
function isServerError(error) {
  return Number(error?.status) >= 500;
}

/** 创建返回固定退避时间的测试策略函数。 */
function createFixedBackoff(backoffMs) {
  /** 返回固定退避时间。 */
  function fixedBackoff() {
    return backoffMs;
  }
  return fixedBackoff;
}

/** 把测试错误转换为可持久化分类。 */
function describeStatusError(error) {
  return { errorType: "provider_unavailable", statusCode: error.status };
}

/** 创建带 HTTP 状态的测试错误。 */
function createStatusError(status) {
  const error = new Error(`HTTP ${status}`);
  error.status = status;
  return error;
}

/** 判断执行器是否因共享截止时间不足而停止第一次重试。 */
function isDeadlineStoppedRetry(error) {
  return (
    error instanceof RetryExecutionError &&
    error.resilience.attemptCount === 1 &&
    error.resilience.attempts[0].stopReason === "deadline"
  );
}

/** 判断执行器是否因不可重放边界在首次错误后停止。 */
function isRetryBoundaryStoppedRetry(error) {
  return (
    error instanceof RetryExecutionError &&
    error.resilience.attemptCount === 1 &&
    error.resilience.outputStarted === false &&
    error.resilience.retryBoundaryCrossed === true &&
    error.resilience.attempts[0].retryable === false &&
    error.resilience.attempts[0].stopReason === "retry-boundary-crossed"
  );
}

/** 返回尝试状态，供顺序断言复用。 */
function readAttemptStatus(attempt) {
  return attempt.status;
}
