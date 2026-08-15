#!/usr/bin/env node
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createChatRuntime } from "../src/runtime/chat-runtime.mjs";
import { createConversationCoordinator } from "../src/runtime/conversation-coordinator.mjs";
import { createContextPlanner } from "../src/runtime/context-planner.mjs";
import { createExecutionPolicy } from "../src/runtime/execution-policy.mjs";
import { createMemoryManager } from "../src/runtime/memory-manager.mjs";
import { createConversationStore } from "../src/storage/conversation-store.mjs";

const CONTEXT_OPTIONS = Object.freeze({
  maxContextTokens: 800,
  reservedOutputTokens: 120,
  safetyTokens: 80,
  highWatermarkRatio: 0.75,
  lowWatermarkRatio: 0.45,
  hardWatermarkRatio: 0.9,
});

const ALLOW_POLICY_DECISION = Object.freeze({
  decision: "allow",
  policy: "execution-policy",
  policyVersion: "execution-policy.v1",
  reasonCodes: Object.freeze(["operation_allowed"]),
  evaluatedAt: "2026-08-13T00:00:00.000Z",
  hookErrors: Object.freeze([]),
});

test("execution policy is versioned, restrictive, and isolates after hooks", testExecutionPolicy);
test("runtime preserves a committed Run when a custom after hook throws", testRuntimeAfterHookIsolation);
test("completed Run replay bypasses changed policy and concurrent duplicate execution", testRuntimeReplayBeforePolicy);
test("operation journal is idempotent and keeps ToolCall projection atomic", testOperationJournal);
test("SQLite RunLease coordinates owners and rejects stale fencing tokens", testRunLeaseAndFencing);

/** 验证默认策略、前置 Hook 只能收紧以及后置 Hook 失败隔离。 */
async function testExecutionPolicy() {
  const fixedClock = createFixedClock("2026-08-13T00:00:00.000Z");
  const policy = createExecutionPolicy({
    allowedReadTools: ["get_weather"],
    clock: fixedClock,
    afterHooks: [recordAfterObservation, failAfterObservation],
  });
  const chat = await policy.evaluateBefore(createRunPolicyContext("conversation.chat"));
  const unknown = await policy.evaluateBefore(createRunPolicyContext("unknown.operation", false));
  const sideEffect = await policy.evaluateBefore({
    kind: "operation",
    operation: "ticket.create",
    effect: "write",
    riskLevel: "high",
    known: true,
  });
  const weather = await policy.evaluateBefore({
    kind: "tool",
    operation: "tool.execute",
    toolName: "get_weather",
    effect: "read",
    riskLevel: "low",
    known: true,
  });

  assert.equal(chat.decision, "allow");
  assert.equal(chat.policyVersion, "execution-policy.v1");
  assert.deepEqual(chat.reasonCodes, ["run_operation_allowed"]);
  assert.equal(chat.evaluatedAt, "2026-08-13T00:00:00.000Z");
  assert.deepEqual(unknown.reasonCodes, ["operation_unknown"]);
  assert.equal(unknown.decision, "deny");
  assert.deepEqual(sideEffect.reasonCodes, ["side_effect_confirmation_required"]);
  assert.equal(sideEffect.decision, "confirmation_required");
  assert.equal(weather.decision, "allow");

  const restrictedPolicy = createExecutionPolicy({ beforeHooks: [denyConversationRun], clock: fixedClock });
  const restricted = await restrictedPolicy.evaluateBefore(createRunPolicyContext("conversation.chat"));
  assert.equal(restricted.decision, "deny");
  assert.deepEqual(restricted.reasonCodes, ["maintenance_window"]);

  const observation = await policy.observeAfter({
    context: createRunPolicyContext("conversation.chat"),
    policyDecision: chat,
    outcome: { status: "completed" },
  });
  assert.equal(observation.attempted, 2);
  assert.equal(observation.completed, 1);
  assert.deepEqual(observation.failedHooks, [
    { hook: "failAfterObservation", code: "execution_hook_failed" },
  ]);
}

/** 验证可替换 Policy Port 自身抛错时也不能把已提交 Run 改写为失败。 */
async function testRuntimeAfterHookIsolation() {
  let afterCalls = 0;
  const executionPolicy = {
    /** 对测试中的普通 Run 返回稳定允许决定。 */
    async evaluateBefore() {
      return ALLOW_POLICY_DECISION;
    },
    /** 模拟第三方后置策略端口不可用。 */
    async observeAfter() {
      afterCalls += 1;
      throw new Error("intentional after hook failure");
    },
  };
  const fixture = createRuntimeFixture({ executionPolicy });
  try {
    const conversation = fixture.runtime.createConversation({ title: "Hook 隔离" });
    const result = await fixture.runtime.runConversation(conversation.id, {
      requestId: "hook-isolation-request",
      clientMessageId: "hook-isolation-message",
      message: "验证后置 Hook 隔离",
    });

    assert.equal(result.content, "治理测试完成");
    assert.equal(fixture.runtime.getConversation(conversation.id).latestRun.status, "completed");
    assert.equal(afterCalls, 1);
  } finally {
    fixture.close();
  }
}

/** 验证已提交幂等事实优先于当前策略，并发相同请求也只执行一次策略与模型。 */
async function testRuntimeReplayBeforePolicy() {
  let denyNewRuns = false;
  let beforeCalls = 0;
  const executionPolicy = {
    /** 按测试开关允许或拒绝新 Run，并记录真实前置策略调用次数。 */
    async evaluateBefore() {
      beforeCalls += 1;
      return denyNewRuns
        ? {
            ...ALLOW_POLICY_DECISION,
            decision: "deny",
            reasonCodes: ["maintenance_window"],
          }
        : ALLOW_POLICY_DECISION;
    },
    /** 当前测试不装配后置策略观察器。 */
    async observeAfter() {
      return { attempted: 0, completed: 0, failedHooks: [] };
    },
  };
  const chainTracer = createRecordingChainTracer();
  const fixture = createRuntimeFixture({ executionPolicy, chainTracer });
  try {
    const conversation = fixture.runtime.createConversation({ title: "幂等优先" });
    const input = {
      requestId: "policy-replay-request",
      clientMessageId: "policy-replay-message",
      message: "验证完成态重放",
    };
    const first = await fixture.runtime.runConversation(conversation.id, input);
    denyNewRuns = true;
    const replay = await fixture.runtime.runConversation(conversation.id, input);

    assert.equal(first.replayed, false);
    assert.equal(replay.replayed, true);
    assert.equal(replay.content, first.content);
    assert.equal(beforeCalls, 1);
    assert.equal(fixture.gatewayClient.getCompletionCalls(), 1);

    denyNewRuns = false;
    const duplicateInput = {
      requestId: "concurrent-policy-replay-request",
      clientMessageId: "concurrent-policy-replay-message",
      message: "验证并发幂等",
    };
    const duplicateEventStreams = [[], []];
    const [concurrentFirst, concurrentSecond] = await Promise.all([
      fixture.runtime.runConversation(
        conversation.id,
        duplicateInput,
        { eventSink: createCollectingEventSink(duplicateEventStreams[0]) },
      ),
      fixture.runtime.runConversation(
        conversation.id,
        duplicateInput,
        { eventSink: createCollectingEventSink(duplicateEventStreams[1]) },
      ),
    ]);
    const duplicateResults = [concurrentFirst, concurrentSecond];
    const persistedDuplicate = fixture.store.findRunByRequestId(conversation.id, duplicateInput.requestId).run;

    assert.deepEqual(duplicateResults.map(readReplayFlag).sort(), [false, true]);
    assert.equal(beforeCalls, 2);
    assert.equal(fixture.gatewayClient.getCompletionCalls(), 2);
    assert.equal(persistedDuplicate.status, "completed");
    assert.equal(fixture.runtime.getConversation(conversation.id).messages.length, 4);
    for (const events of duplicateEventStreams) {
      assert.deepEqual(events.map(readRunEventType), ["chain-trace.started", "run.started", "run.completed"]);
      assert.deepEqual([...new Set(events.map(readRunEventChainTraceId))], [persistedDuplicate.chainTraceId]);
    }
    const duplicateQueueSpans = chainTracer.queueSpans.filter(
      // 同一 requestId 的首次执行与并发重放都必须改写为持久化业务 Chain ID。
      (span) => span.attributes["ai.platform.request_id"] === duplicateInput.requestId,
    );
    assert.equal(duplicateQueueSpans.length, 2);
    assert.equal(duplicateQueueSpans.every(isEndedSpan), true);
    assert.deepEqual(
      [...new Set(duplicateQueueSpans.map(readSpanChainTraceId))],
      [persistedDuplicate.chainTraceId],
    );
  } finally {
    fixture.close();
  }
}

/** 验证 Operation 状态机、unknown 回读门禁及 ToolCall 的事务投影。 */
function testOperationJournal() {
  const store = createConversationStore({ databasePath: ":memory:" });
  try {
    const { conversationId, runId } = startStoreRun(store, "operation-journal");
    const planInput = {
      conversationId,
      runId,
      operationKey: "external:ticket:create",
      idempotencyKey: "ticket-create-idempotency-key",
      kind: "operation",
      toolName: null,
      effect: "external",
      riskLevel: "high",
      policyDecision: ALLOW_POLICY_DECISION,
      input: { ticketId: "T-100" },
    };
    const planned = store.planOperation(planInput);
    const replayedPlan = store.planOperation(planInput);

    assert.equal(planned.replayed, false);
    assert.equal(replayedPlan.replayed, true);
    assert.equal(replayedPlan.operation.id, planned.operation.id);
    assert.equal(planned.operation.status, "planned");
    assert.equal(planned.operation.policyVersion, "execution-policy.v1");

    const started = store.startOperation({ operationId: planned.operation.id, externalRequestId: "ext-100" });
    const replayedStart = store.startOperation({ operationId: planned.operation.id, externalRequestId: "ext-100" });
    assert.equal(started.operation.attempt, 1);
    assert.equal(replayedStart.replayed, true);

    const unknown = store.markOperationUnknown({ operationId: planned.operation.id });
    assert.equal(unknown.operation.status, "unknown");
    assert.throws(
      createCompleteUnknownOperation(store, planned.operation.id),
      hasStoreCode("operation_readback_required"),
    );
    assert.throws(
      createFailUnknownOperation(store, planned.operation.id),
      hasStoreCode("operation_readback_required"),
    );
    const completed = store.completeOperation({
      operationId: planned.operation.id,
      result: { accepted: true },
      readback: { ticketId: "T-100", status: "created" },
    });
    assert.equal(completed.operation.status, "completed");

    assert.throws(
      createConflictingToolProjection(store, { conversationId, runId }),
      hasStoreCode("operation_idempotency_conflict"),
    );
    assert.equal(store.listToolCalls(runId).length, 0);

    const toolCallInput = {
      conversationId,
      runId,
      toolCallId: "weather-call-governance",
      toolName: "get_weather",
      input: { location: "深圳", date: "today" },
      policyDecision: ALLOW_POLICY_DECISION,
    };
    const toolCall = store.startToolCall(toolCallInput);
    const replayedToolCall = store.startToolCall(toolCallInput);
    assert.equal(replayedToolCall.replayed, true);
    assert.equal(replayedToolCall.operation.id, toolCall.operation.id);
    const completedToolCall = store.completeToolCall({
      runId,
      toolCallId: toolCallInput.toolCallId,
      output: { status: "success", data: { temperature: 31 } },
      source: "Open-Meteo",
      observedAt: "2026-08-13T10:00:00+08:00",
    });
    assert.equal(completedToolCall.status, "completed");
    assert.equal(completedToolCall.operation.status, "completed");
    assert.equal(store.listOperations(runId).length, 2);
  } finally {
    store.close();
  }
}

/** 使用两个 SQLite 连接验证 lease 竞争、过期接管、续租、释放和旧 token 拒绝。 */
function testRunLeaseAndFencing() {
  const directory = mkdtempSync(join(tmpdir(), "ai-platform-governance-"));
  const databasePath = join(directory, "governance.sqlite");
  const mutableClock = createMutableClock("2026-08-13T00:00:00.000Z");
  const firstStore = createConversationStore({ databasePath, clock: mutableClock.now });
  const secondStore = createConversationStore({ databasePath, clock: mutableClock.now });
  try {
    const { conversationId, runId } = startStoreRun(firstStore, "lease-fencing");
    const ownerOne = firstStore.acquireRunLease({
      runId,
      conversationId,
      ownerId: "runtime-owner-1",
      ttlMs: 1000,
    });
    const blockedOwner = secondStore.acquireRunLease({
      runId,
      conversationId,
      ownerId: "runtime-owner-2",
      ttlMs: 1000,
    });
    assert.equal(ownerOne.acquired, true);
    assert.equal(ownerOne.lease.fencingToken, 1);
    assert.equal(blockedOwner.acquired, false);
    assert.equal(blockedOwner.reasonCode, "lease_held");

    assert.throws(
      createCompetingRun(secondStore, conversationId),
      hasStoreCode("conversation_run_active"),
    );

    const planned = firstStore.planOperation({
      conversationId,
      runId,
      operationKey: "lease-protected-operation",
      idempotencyKey: "lease-protected-idempotency",
      kind: "operation",
      effect: "external",
      riskLevel: "high",
      policyDecision: ALLOW_POLICY_DECISION,
      input: { target: "external-system" },
      lease: leaseCredentials(ownerOne.lease),
    });
    firstStore.startOperation({
      operationId: planned.operation.id,
      lease: leaseCredentials(ownerOne.lease),
    });

    mutableClock.advanceBy(1001);
    const ownerTwo = secondStore.acquireRunLease({
      runId,
      conversationId,
      ownerId: "runtime-owner-2",
      ttlMs: 1000,
    });
    assert.equal(ownerTwo.acquired, true);
    assert.equal(ownerTwo.lease.fencingToken, 2);
    assert.throws(
      createStaleOperationWrite(firstStore, planned.operation.id, ownerOne.lease),
      hasStoreCode("stale_fencing_token"),
    );

    const unknown = secondStore.markOperationUnknown({
      operationId: planned.operation.id,
      lease: leaseCredentials(ownerTwo.lease),
    });
    assert.equal(unknown.operation.status, "unknown");
    const renewed = secondStore.renewRunLease({
      runId,
      ownerId: ownerTwo.lease.ownerId,
      fencingToken: ownerTwo.lease.fencingToken,
      ttlMs: 2000,
    });
    assert.ok(Date.parse(renewed.leaseExpiresAt) > Date.parse(ownerTwo.lease.leaseExpiresAt));
    secondStore.completeOperation({
      operationId: planned.operation.id,
      result: { status: "created" },
      readback: { status: "created" },
      lease: leaseCredentials(renewed),
    });
    secondStore.completeRun({
      runId,
      content: "完成",
      displayContent: "完成",
      usage: null,
      contextManifest: null,
      model: "governance-test-model",
      resilience: null,
      lease: leaseCredentials(renewed),
    });
    assert.ok(firstStore.getRunLease(runId).releasedAt);
    assert.throws(
      createStaleTerminalWrite(firstStore, runId, ownerOne.lease),
      hasStoreCode("stale_fencing_token"),
    );

    const secondRun = startStoreRun(firstStore, "lease-release");
    const releasable = firstStore.acquireRunLease({
      ...secondRun,
      ownerId: "runtime-owner-3",
      ttlMs: 1000,
    });
    const released = firstStore.releaseRunLease({
      runId: secondRun.runId,
      ...leaseCredentials(releasable.lease),
    });
    assert.equal(released.released, true);
    const reacquired = secondStore.acquireRunLease({
      ...secondRun,
      ownerId: "runtime-owner-4",
      ttlMs: 1000,
    });
    assert.equal(reacquired.lease.fencingToken, 2);
  } finally {
    firstStore.close();
    secondStore.close();
    rmSync(directory, { recursive: true, force: true });
  }
}

/** 创建普通 Run 策略上下文。 */
function createRunPolicyContext(operation, known = true) {
  return {
    kind: "run",
    operation,
    effect: "read",
    riskLevel: "low",
    known,
    conversationId: "conversation-policy-test",
    requestId: "request-policy-test",
  };
}

/** 返回固定 Date 的策略测试时钟。 */
function createFixedClock(timestamp) {
  /** 每次返回同一个有效时间的新实例。 */
  function fixedClock() {
    return new Date(timestamp);
  }
  return fixedClock;
}

/** 前置 Hook 将已允许的普通对话收紧为拒绝。 */
function denyConversationRun() {
  return { decision: "deny", reasonCodes: ["maintenance_window"] };
}

/** 成功观察一次后置执行事实。 */
function recordAfterObservation() {}

/** 模拟后置观察器失败，错误正文不得进入策略报告。 */
function failAfterObservation() {
  throw new Error("sensitive hook failure");
}

/** 返回并发结果的幂等重放标记，供稳定排序断言使用。 */
function readReplayFlag(result) {
  return result.replayed;
}

/** 返回 Runtime 事件类型，供有序生命周期断言使用。 */
function readRunEventType(event) {
  return event.type;
}

/** 返回 Runtime 事件的业务 Chain ID。 */
function readRunEventChainTraceId(event) {
  return event.chainTraceId;
}

/** 返回记录 Span 的最终业务 Chain ID。 */
function readSpanChainTraceId(span) {
  return span.attributes["ai.platform.chain_trace_id"];
}

/** 判断手动记录的 Span 已执行结束收口。 */
function isEndedSpan(span) {
  return span.ended;
}

/** 创建只收集不可变 Runtime 事件的测试 Sink。 */
function createCollectingEventSink(events) {
  return {
    /** 按调用顺序保存事件并返回稳定投递报告。 */
    async publish(event) {
      events.push(event);
      return { subscriberCount: 1, deliveredCount: 1, failedCount: 0 };
    },
  };
}

/** 创建只记录手动 queue Span 属性与结束状态的最小 ChainTracer。 */
function createRecordingChainTracer() {
  const queueSpans = [];
  const nullSpan = {
    /** 测试不记录自动 Span 单属性。 */
    setAttribute() {},
    /** 测试不记录自动 Span 多属性。 */
    setAttributes() {},
    /** 测试不记录自动 Span 错误。 */
    recordError() {},
    /** 自动 Span 生命周期由 withSpan 直接委托。 */
    end() {},
  };
  return {
    queueSpans,
    /** 直接执行自动 Span 回调，只保留业务行为。 */
    withSpan(_name, _attributes, operation) {
      return operation(nullSpan);
    },
    /** 记录 queue Span 可变属性，验证结束前身份修正。 */
    startSpan(name, attributes) {
      const span = { name, attributes: { ...attributes }, ended: false };
      queueSpans.push(span);
      return {
        /** 覆盖单个 Span 属性。 */
        setAttribute(key, value) {
          span.attributes[key] = value;
        },
        /** 合并多个 Span 属性。 */
        setAttributes(values) {
          Object.assign(span.attributes, values);
        },
        /** 当前测试不需要错误事件。 */
        recordError() {},
        /** 标记手动 Span 已结束。 */
        end() {
          span.ended = true;
        },
      };
    },
  };
}

/** 创建不依赖模型网络的最小 Runtime 装配。 */
function createRuntimeFixture({ executionPolicy, chainTracer }) {
  const gatewayClient = createGovernanceGateway();
  const store = createConversationStore({ databasePath: ":memory:" });
  const coordinator = createConversationCoordinator();
  const contextPlanner = createContextPlanner({
    store,
    gatewayClient,
    contextOptions: CONTEXT_OPTIONS,
    systemPrompt: "治理测试助手",
  });
  const memoryManager = createMemoryManager({ store, gatewayClient, contextOptions: CONTEXT_OPTIONS });
  const runtime = createChatRuntime({
    gatewayClient,
    contextOptions: CONTEXT_OPTIONS,
    store,
    coordinator,
    contextPlanner,
    memoryManager,
    executionPolicy,
    chainTracer,
  });
  return {
    runtime,
    store,
    gatewayClient,
    /** 释放内存 SQLite。 */
    close() {
      store.close();
    },
  };
}

/** 创建固定回答的 Runtime 治理测试 Gateway。 */
function createGovernanceGateway() {
  let completionCalls = 0;
  return {
    model: "governance-test-model",
    /** 返回普通生成调用次数，结构化记忆调用不计入当前治理断言。 */
    getCompletionCalls() {
      return completionCalls;
    },
    /** 返回固定 token 计数。 */
    async countTokens() {
      return { tokens: 10, source: "scripted", model: this.model };
    },
    /** 返回固定完成结果。 */
    async chatCompletions({ outputSchema } = {}) {
      if (!outputSchema) completionCalls += 1;
      return {
        model: this.model,
        usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 },
        choices: [{ message: { content: "治理测试完成" } }],
      };
    },
  };
}

/** 创建一条可供 Operation 和 Lease 测试复用的 running Run。 */
function startStoreRun(store, suffix) {
  const conversation = store.createConversation({ title: `治理测试-${suffix}` });
  const started = store.startRun({
    conversationId: conversation.id,
    requestId: `request-${suffix}`,
    clientMessageId: `message-${suffix}`,
    content: `输入-${suffix}`,
    displayContent: `输入-${suffix}`,
    model: "governance-test-model",
  });
  return { conversationId: conversation.id, runId: started.run.id };
}

/** 返回调用 completeOperation 的闭包，供 assert.throws 检查 unknown 门禁。 */
function createCompleteUnknownOperation(store, operationId) {
  /** 尝试在缺少 readback 时完成 unknown Operation。 */
  function completeUnknownOperation() {
    store.completeOperation({ operationId, result: { status: "unknown" } });
  }
  return completeUnknownOperation;
}

/** 返回调用 failOperation 的闭包，供 assert.throws 检查 unknown 门禁。 */
function createFailUnknownOperation(store, operationId) {
  /** 尝试在缺少 readback 时失败 unknown Operation。 */
  function failUnknownOperation() {
    store.failOperation({ operationId, code: "external_failed", message: "外部操作失败" });
  }
  return failUnknownOperation;
}

/** 构造会与既有 Operation 幂等事实冲突的 ToolCall 事务。 */
function createConflictingToolProjection(store, { conversationId, runId }) {
  /** 尝试用不同 Operation key 复用既有幂等键。 */
  function createProjectionConflict() {
    store.startToolCall({
      conversationId,
      runId,
      toolCallId: "conflicting-tool-call",
      toolName: "get_weather",
      input: { location: "深圳", date: "today" },
      operationKey: "tool:conflicting-tool-call",
      idempotencyKey: "ticket-create-idempotency-key",
      policyDecision: ALLOW_POLICY_DECISION,
    });
  }
  return createProjectionConflict;
}

/** 创建第二条同会话 Run，验证 Store 事务级并发约束。 */
function createCompetingRun(store, conversationId) {
  /** 尝试在同一会话已有 running Run 时创建下一条 Run。 */
  function startCompetingRun() {
    store.startRun({
      conversationId,
      requestId: "competing-request",
      clientMessageId: "competing-message",
      content: "并发输入",
      displayContent: "并发输入",
    });
  }
  return startCompetingRun;
}

/** 使用旧 owner/token 构造 Operation 写入。 */
function createStaleOperationWrite(store, operationId, lease) {
  /** 旧 owner 在接管后尝试写入未知状态。 */
  function writeWithStaleToken() {
    store.markOperationUnknown({ operationId, lease: leaseCredentials(lease) });
  }
  return writeWithStaleToken;
}

/** 使用旧 owner/token 构造终态 Run 回写，验证幂等分支不会掩盖 fencing 失效。 */
function createStaleTerminalWrite(store, runId, lease) {
  /** 旧 owner 在新 owner 完成 Run 后尝试写入失败终态。 */
  function writeTerminalWithStaleToken() {
    store.failRun(runId, new Error("stale owner failure"), leaseCredentials(lease));
  }
  return writeTerminalWithStaleToken;
}

/** 从 RunLease 事实中提取 Store 写入所需的最小凭证。 */
function leaseCredentials(lease) {
  return { ownerId: lease.ownerId, fencingToken: lease.fencingToken };
}

/** 创建两个 Store 共享的可推进时钟。 */
function createMutableClock(timestamp) {
  let nowMs = Date.parse(timestamp);
  return Object.freeze({
    /** 返回当前测试时间。 */
    now() {
      return new Date(nowMs);
    },
    /** 单调推进指定毫秒。 */
    advanceBy(milliseconds) {
      nowMs += milliseconds;
      return new Date(nowMs);
    },
  });
}

/** 返回只匹配稳定 ConversationStore 错误码的断言函数。 */
function hasStoreCode(expectedCode) {
  /** 检查异常的稳定 code。 */
  function matchesStoreCode(error) {
    return error?.code === expectedCode;
  }
  return matchesStoreCode;
}
