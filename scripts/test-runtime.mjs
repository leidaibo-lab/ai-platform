#!/usr/bin/env node
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { GatewayRequestError, createGatewayClient } from "../src/gateway/gateway-client.mjs";
import { createChatRuntime } from "../src/runtime/chat-runtime.mjs";
import { createConversationCoordinator } from "../src/runtime/conversation-coordinator.mjs";
import { createContextPlanner } from "../src/runtime/context-planner.mjs";
import { estimateMessagesTokens } from "../src/runtime/context-budget.mjs";
import { createMemoryManager, selectCompactionRange } from "../src/runtime/memory-manager.mjs";
import { createRunEventSink } from "../src/runtime/run-event-sink.mjs";
import { createRunIntentRouter, resolveIntentCandidates } from "../src/runtime/run-intent-router.mjs";
import { ConversationStoreError, createConversationStore } from "../src/storage/conversation-store.mjs";
import { createToolRegistry } from "../src/tools/tool-registry.mjs";
import { createWeatherToolDefinition } from "../src/tools/weather-tool.mjs";

const contextOptions = {
  maxContextTokens: 800,
  reservedOutputTokens: 120,
  safetyTokens: 80,
  highWatermarkRatio: 0.75,
  lowWatermarkRatio: 0.45,
  hardWatermarkRatio: 0.9,
};

/**
 * 创建使用内存 SQLite 的完整 Runtime 测试装配。
 *
 * @param {object} [options] - 可选测试依赖。
 * @param {object} [options.gatewayClient] - 替换默认脚本模型的 Gateway。
 * @param {object} [options.chainTracer] - 替换默认 Null Object 的 ChainTracer。
 * @param {object} [options.toolRegistry] - 替换默认空工具目录。
 * @param {object} [options.intentRouter] - 替换默认结构化意图路由器。
 * @param {object} [options.coordinator] - 替换默认会话串行协调器。
 * @returns {object} 可供单元测试或 fixture runner 使用的 Runtime 装配。
 */
function createTestRuntime({
  gatewayClient = createScriptedGateway(),
  chainTracer,
  toolRegistry,
  intentRouter,
  coordinator = createConversationCoordinator(),
} = {}) {
  const store = createConversationStore({ databasePath: ":memory:" });
  const contextPlanner = createContextPlanner({
    store,
    gatewayClient,
    contextOptions,
    systemPrompt: "测试助手",
  });
  const memoryManager = createMemoryManager({ store, gatewayClient, contextOptions });
  const runtime = createChatRuntime({
    gatewayClient,
    contextOptions,
    store,
    coordinator,
    contextPlanner,
    memoryManager,
    chainTracer,
    toolRegistry,
    intentRouter,
  });
  return { store, gatewayClient, contextPlanner, memoryManager, runtime };
}

/** 创建可复现结构化记忆提取和问答的脚本化 Gateway。 */
function createScriptedGateway() {
  return {
    model: "scripted-test-model",
    /** 返回与本地估算一致的确定性 token 数。 */
    async countTokens({ messages }) {
      return { tokens: estimateMessagesTokens(messages), source: "scripted", model: this.model };
    },
    /** 对结构化请求生成 MemoryDelta，对普通请求根据 active 记忆回答。 */
    async chatCompletions({ messages, outputSchema }) {
      if (outputSchema) return buildScriptedMemoryResponse(messages, this.model);
      const memoryText = messages
        .filter(isSystemMessage)
        .map(getMessageContent)
        .join("\n");
      const question = String(messages.at(-1)?.content || "");
      let content = "已收到";
      if (question.includes("当前项目最终使用什么数据库")) {
        content = memoryText.includes("current-project.database=PostgreSQL") ? "PostgreSQL" : "无法确认";
      }
      return {
        model: this.model,
        usage: { prompt_tokens: estimateMessagesTokens(messages), completion_tokens: 8 },
        choices: [{ message: { content } }],
      };
    },
  };
}

/** 创建会执行一次 get_weather AI SDK 工具并返回最终文本的脚本化 Gateway。 */
function createToolCallingGateway() {
  return {
    model: "tool-test-model",
    /** 返回 Context Planner 使用的确定性 token 数。 */
    async countTokens({ messages }) {
      return { tokens: estimateMessagesTokens(messages), source: "scripted", model: this.model };
    },
    /** 模拟 AI SDK Core 多步生成选择天气工具、获得 ToolResult 后生成最终回答。 */
    async chatCompletions({ messages, outputSchema, tools, toolsContext, requiredToolName, onTextDelta }) {
      if (outputSchema) return buildScriptedMemoryResponse(messages, this.model);
      assert.ok(tools?.get_weather);
      assert.equal(requiredToolName, "get_weather");
      const output = await tools.get_weather.execute(
        { location: "深圳", date: "today" },
        { toolCallId: "weather-call-1", messages, context: toolsContext.get_weather },
      );
      assert.equal(output.status, "success");
      const content = "深圳当前 26°C，数据时间 2026-07-30T20:15，来源 Open-Meteo。";
      if (typeof onTextDelta === "function") await onTextDelta(content);
      return {
        model: this.model,
        usage: { prompt_tokens: estimateMessagesTokens(messages), completion_tokens: 16 },
        choices: [{ message: { content } }],
      };
    },
  };
}

/** 创建断言普通对话不暴露受管工具集合的脚本化 Gateway。 */
function createNoToolExposureGateway() {
  return {
    model: "no-tool-exposure-model",
    /** 返回 Context Planner 使用的确定性 token 数。 */
    async countTokens({ messages }) {
      return { tokens: estimateMessagesTokens(messages), source: "scripted", model: this.model };
    },
    /** 确认未命中确定性路由时不把工具或执行上下文交给模型。 */
    async chatCompletions({ messages, outputSchema, tools, toolsContext, requiredToolName }) {
      if (outputSchema) return buildScriptedMemoryResponse(messages, this.model);
      assert.equal(tools, undefined);
      assert.equal(toolsContext, undefined);
      assert.equal(requiredToolName, null);
      return {
        model: this.model,
        usage: { prompt_tokens: estimateMessagesTokens(messages), completion_tokens: 8 },
        choices: [{ message: { content: "深圳是一座城市。" } }],
      };
    },
  };
}

/** 创建命中天气路由但故意不执行必需工具的脚本化 Gateway。 */
function createMissingRequiredToolGateway() {
  return {
    model: "missing-required-tool-model",
    /** 返回 Context Planner 使用的确定性 token 数。 */
    async countTokens({ messages }) {
      return { tokens: estimateMessagesTokens(messages), source: "scripted", model: this.model };
    },
    /** 返回未经 ToolResult 支撑的候选，用于验证 Runtime 独立拒绝。 */
    async chatCompletions({ messages, outputSchema, tools, toolsContext, requiredToolName, onTextDelta }) {
      if (outputSchema) return buildScriptedMemoryResponse(messages, this.model);
      assert.ok(tools?.get_weather);
      assert.ok(toolsContext?.get_weather);
      assert.equal(requiredToolName, "get_weather");
      await onTextDelta("深圳当前 26°C，来源 Open-Meteo。");
      return {
        model: this.model,
        usage: { prompt_tokens: estimateMessagesTokens(messages), completion_tokens: 12 },
        choices: [{ message: { content: "深圳当前 26°C，来源 Open-Meteo。" } }],
      };
    },
  };
}

/** 创建会执行一次失败天气工具并用安全 ToolResult 生成最终说明的脚本化 Gateway。 */
function createFailingToolGateway() {
  return {
    model: "tool-failure-test-model",
    /** 返回 Context Planner 使用的确定性 token 数。 */
    async countTokens({ messages }) {
      return { tokens: estimateMessagesTokens(messages), source: "scripted", model: this.model };
    },
    /** 模拟 AI SDK Core 多步生成接收失败 ToolResult 后继续生成用户可执行说明。 */
    async chatCompletions({ messages, outputSchema, tools, toolsContext, requiredToolName }) {
      if (outputSchema) return buildScriptedMemoryResponse(messages, this.model);
      assert.ok(tools?.get_weather);
      assert.equal(requiredToolName, "get_weather");
      const output = await tools.get_weather.execute(
        { location: "未知地点", date: "today" },
        { toolCallId: "weather-failure-call-1", messages, context: toolsContext.get_weather },
      );
      assert.equal(output.status, "error");
      assert.equal(output.error.code, "weather_query_failed");
      return {
        model: this.model,
        usage: { prompt_tokens: estimateMessagesTokens(messages), completion_tokens: 12 },
        choices: [{ message: { content: "天气查询失败，请稍后重试。" } }],
      };
    },
  };
}

/** 创建先完成天气工具、再按场景恢复或在已输出后失败的脚本化 Gateway。 */
function createStreamingToolRecoveryGateway({ outputBeforeFailure = false } = {}) {
  let generationCalls = 0;
  const gatewayClient = {
    model: "tool-recovery-stream-model",
    /** 返回 Context Planner 使用的确定性 token 数。 */
    async countTokens({ messages }) {
      return { tokens: estimateMessagesTokens(messages), source: "scripted", model: this.model };
    },
    /** 首次生成在工具落库后失败，第二次校验结构化续接并流式返回总结。 */
    async chatCompletions({
      messages,
      outputSchema,
      tools,
      toolsContext,
      requiredToolName,
      operation,
      onTextDelta,
    }) {
      if (outputSchema) return buildScriptedMemoryResponse(messages, this.model);
      generationCalls += 1;
      if (generationCalls === 1) {
        assert.ok(tools?.get_weather);
        assert.equal(requiredToolName, "get_weather");
        const output = await tools.get_weather.execute(
          { location: "深圳", date: "today" },
          { toolCallId: "weather-stream-recovery-call", messages, context: toolsContext.get_weather },
        );
        assert.equal(output.status, "success");
        if (outputBeforeFailure) await onTextDelta("已交付的部分回答");
        const error = new Error("scripted post-tool model failure");
        error.status = 503;
        error.resilience = buildPostToolBoundaryTrace(outputBeforeFailure);
        throw error;
      }

      assert.equal(tools, undefined);
      assert.equal(requiredToolName, undefined);
      assert.equal(operation, "model.tool_result_summary");
      const toolCallMessage = messages.find(isStructuredToolCallMessage);
      const toolResultMessage = messages.find(isStructuredToolResultMessage);
      assert.equal(toolCallMessage.content[0].toolCallId, "weather-stream-recovery-call");
      assert.equal(toolResultMessage.content[0].toolCallId, "weather-stream-recovery-call");
      assert.equal(toolResultMessage.content[0].output.type, "json");
      assert.equal(toolResultMessage.content[0].output.value.status, "success");
      await onTextDelta("深圳当前 26°C，");
      await onTextDelta("数据时间 2026-07-31T10:00，来源 Open-Meteo。");
      return {
        model: this.model,
        usage: { prompt_tokens: estimateMessagesTokens(messages), completion_tokens: 12, total_tokens: 42 },
        choices: [{ message: { content: "深圳当前 26°C，数据时间 2026-07-31T10:00，来源 Open-Meteo。" } }],
        resilience: {
          operation: "model.tool_result_summary",
          attemptCount: 1,
          outputStarted: true,
          retryBoundaryCrossed: false,
          attempts: [{ attempt: 1, status: "completed", stopReason: "completed" }],
        },
      };
    },
  };
  return {
    gatewayClient,
    /** 返回不含 MemoryDelta 的实际生成阶段次数。 */
    getGenerationCalls() {
      return generationCalls;
    },
  };
}

/** 构造工具后瞬时故障因不可重放边界停止的原始韧性证据。 */
function buildPostToolBoundaryTrace(outputStarted = false) {
  return {
    operation: "model.generate",
    attemptCount: 1,
    outputStarted,
    retryBoundaryCrossed: true,
    attempts: [
      {
        attempt: 1,
        status: "failed",
        errorType: "provider_unavailable",
        statusCode: 503,
        retryable: false,
        willRetry: false,
        stopReason: "retry-boundary-crossed",
      },
    ],
  };
}

/** 判断 Runtime 恢复消息是否为 AI SDK 结构化工具调用。 */
function isStructuredToolCallMessage(message) {
  return message.role === "assistant" && message.content?.[0]?.type === "tool-call";
}

/** 判断 Runtime 恢复消息是否为 AI SDK 结构化工具结果。 */
function isStructuredToolResultMessage(message) {
  return message.role === "tool" && message.content?.[0]?.type === "tool-result";
}

/** 返回 Runtime 工具生命周期事件的短类型。 */
function readToolEventType(event) {
  return event.type.slice("tool.".length);
}

/** 创建仅收集指定事件的 Runtime Sink，并按需启用文本流。 */
function createCollectingExecution(collector, { types, streamText = false, onSubscriberError } = {}) {
  const allowedTypes = types ? new Set(types) : null;
  return {
    eventSink: createRunEventSink({
      subscribers: [
        /** 按事件类型过滤后保存不可变 Runtime 事件快照。 */
        function collectEvent(event) {
          if (!allowedTypes || allowedTypes.has(event.type)) collector(event);
        },
      ],
      ...(onSubscriberError ? { onSubscriberError } : {}),
    }),
    streamText,
  };
}

/** 判断记录项是否为 Runtime 工具执行阶段。 */
function isToolExecutionSpan(span) {
  return span.name === "runtime.tool.execute";
}

/** 判断 SQLite 会话事件是否属于工具执行事实。 */
function isToolFactEvent(event) {
  return String(event.type || "").startsWith("tool.");
}

/** 判断 SQLite 会话事件是否为 Run 完成或失败终态。 */
function isRunTerminalEvent(event) {
  return ["run.completed", "run.failed"].includes(String(event.type || ""));
}

/** 判断易失 Runtime 事件是否声明 Run 已创建或幂等命中。 */
function isRunStartedEvent(event) {
  return event.type === "run.started";
}

/** 返回 SQLite 工具事实事件类型。 */
function readFactEventType(event) {
  return event.type;
}

/** 判断消息是否为系统消息。 */
function isSystemMessage(message) {
  return message.role === "system";
}

/** 返回消息纯文本内容。 */
function getMessageContent(message) {
  return String(message.content || "");
}

/** 根据待压缩消息中的明确事实生成可验证 MemoryDelta。 */
function buildScriptedMemoryResponse(messages, model) {
  const prompt = String(messages.at(-1)?.content || "");
  const marker = "新增消息：";
  const sourceMessages = JSON.parse(prompt.slice(prompt.lastIndexOf(marker) + marker.length).trim());
  const delta = buildScriptedDelta(sourceMessages);
  return {
    model,
    usage: { prompt_tokens: estimateMessagesTokens(messages), completion_tokens: 80 },
    output: delta,
    choices: [{ message: { content: JSON.stringify(delta) } }],
  };
}

/** 从脚本化测试消息提取可验证的事实、决策和任务。 */
function buildScriptedDelta(messages) {
  const upserts = [];
  const supersedes = [];
  for (const message of messages) {
    const text = String(message.content || "");
    if (text.includes("当前项目数据库使用 MySQL")) {
      upserts.push(memoryItem("fact", "current-project", "database", "MySQL", "", "high", message.id));
    }
    if (text.includes("更正：当前项目最终使用 PostgreSQL")) {
      supersedes.push({ type: "fact", entity: "current-project", key: "database", sourceMessageIds: [message.id] });
      upserts.push(memoryItem("fact", "current-project", "database", "PostgreSQL", "需要 pgvector", "critical", message.id));
      upserts.push(memoryItem("decision", "current-project", "database-choice", "PostgreSQL", "需要 pgvector", "high", message.id));
    }
    if (text.includes("Alpha 项目仍然使用 MySQL")) {
      upserts.push(memoryItem("fact", "alpha-project", "database", "MySQL", "", "normal", message.id));
    }
    if (text.includes("待办：补充 PostgreSQL 迁移脚本")) {
      upserts.push({
        ...memoryItem("task", "current-project", "migration-script", "补充 PostgreSQL 迁移脚本", "", "high", message.id),
        itemStatus: "pending",
      });
    }
  }
  return {
    upserts,
    supersedes,
    episode: {
      topic: "批次对话",
      summary: messages.map(getSourceContent).join("；").slice(0, 240),
      sourceMessageIds: messages.map(getSourceId),
    },
  };
}

/** 创建符合 MemoryDelta schema 的脚本化记忆项。 */
function memoryItem(type, entity, key, value, reason, priority, sourceMessageId) {
  return {
    type,
    entity,
    key,
    value,
    reason,
    itemStatus: "active",
    priority,
    sourceMessageIds: [sourceMessageId],
  };
}

/** 返回提取源消息正文。 */
function getSourceContent(message) {
  return String(message.content || "");
}

/** 返回提取源消息 ID。 */
function getSourceId(message) {
  return message.id;
}

/** 使用稳定幂等 ID 执行一次测试 Run。 */
async function run(runtime, conversationId, index, message, model) {
  return runtime.runConversation(conversationId, {
    requestId: `request-${index}`,
    clientMessageId: `client-${index}`,
    ...(model ? { model } : {}),
    message,
    imageUrls: [],
    documentUrls: [],
  });
}

const isDirectExecution = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isDirectExecution) {
// 验证会话隔离、幂等重放和服务端消息事实源。
test("conversation runs are persisted, isolated, and idempotent", async () => {
  const fixture = createTestRuntime();
  const first = fixture.runtime.createConversation();
  const second = fixture.runtime.createConversation();
  const response = await run(fixture.runtime, first.id, 1, "第一会话");
  const replay = await run(fixture.runtime, first.id, 1, "第一会话");

  assert.equal(response.replayed, false);
  assert.equal(replay.replayed, true);
  assert.equal(fixture.runtime.getConversation(first.id).messages.length, 2);
  assert.equal(fixture.runtime.getConversation(second.id).messages.length, 0);
  fixture.store.close();
});

// 验证同一会话的并发 Run 经过 Coordinator 后保持完整轮次顺序。
test("concurrent runs in one conversation are serialized", async () => {
  const fixture = createTestRuntime();
  const conversation = fixture.runtime.createConversation();
  await Promise.all([
    run(fixture.runtime, conversation.id, 1, "第一条并发输入"),
    run(fixture.runtime, conversation.id, 2, "第二条并发输入"),
  ]);

  const detail = fixture.runtime.getConversation(conversation.id);
  assert.deepEqual(detail.messages.map(getMessageRole), ["user", "assistant", "user", "assistant"]);
  assert.deepEqual(detail.messages.map(getDisplayContent), ["第一条并发输入", "已收到", "第二条并发输入", "已收到"]);
  fixture.store.close();
});

// 验证 Runtime 透传文本增量，同时只把完整助手消息持久化一次。
test("streamed runs emit deltas and persist one final assistant message", async () => {
  const fixture = createTestRuntime({ gatewayClient: createStreamingGateway() });
  const conversation = fixture.runtime.createConversation();
  const runEvents = [];
  const deltas = [];
  /** 收集 Runtime 创建的稳定 Run 身份。 */
  function collectRuntimeEvent(event) {
    runEvents.push(event);
    if (event.type === "text.delta") deltas.push(event.delta);
  }

  const response = await fixture.runtime.runConversation(
    conversation.id,
    {
      requestId: "stream-request-1",
      clientMessageId: "stream-client-1",
      message: "验证流式输出",
      imageUrls: [],
      documentUrls: [],
    },
    createCollectingExecution(collectRuntimeEvent, { types: ["run.started", "text.delta"], streamText: true }),
  );
  const detail = fixture.runtime.getConversation(conversation.id);

  assert.deepEqual(deltas, ["逐段", "回复"]);
  const startedEvent = runEvents.find(isRunStartedEvent);
  assert.equal(runEvents.filter(isRunStartedEvent).length, 1);
  assert.equal(startedEvent.runId, detail.latestRun.id);
  assert.equal(startedEvent.operation, "conversation.chat");
  assert.equal(response.content, "逐段回复");
  assert.deepEqual(detail.messages.map(getMessageRole), ["user", "assistant"]);
  assert.equal(detail.messages[1].displayContent, "逐段回复");
  assert.equal(detail.latestRun.resilience.outputStarted, true);
  fixture.store.close();
});

// 验证 Runtime 事件是有序不可变快照，失败订阅者不会改变执行和持久化终态。
test("run event subscribers are isolated from Runtime execution facts", async () => {
  const fixture = createTestRuntime({ gatewayClient: createStreamingGateway() });
  const conversation = fixture.runtime.createConversation();
  const observedTypes = [];
  const subscriberErrors = [];
  const eventSink = createRunEventSink({
    subscribers: [
      /** 尝试污染快照并在文本事件抛错，验证 Sink 同时提供不可变性和失败隔离。 */
      function failingObserver(event) {
        assert.throws(() => {
          event.type = "mutated";
        }, TypeError);
        if (event.type === "text.delta") throw new Error("scripted subscriber failure");
      },
      /** 记录第二个订阅者实际看到的稳定事件顺序。 */
      function collectObservedType(event) {
        observedTypes.push(event.type);
      },
    ],
    /** 保存脱离主链的订阅错误分类供测试断言。 */
    onSubscriberError(error, context) {
      subscriberErrors.push({ name: error.name, eventType: context.event.type });
    },
  });

  const response = await fixture.runtime.runConversation(
    conversation.id,
    {
      requestId: "isolated-events-request",
      clientMessageId: "isolated-events-message",
      message: "验证事件隔离",
    },
    { eventSink, streamText: true },
  );
  const detail = fixture.runtime.getConversation(conversation.id);

  assert.deepEqual(observedTypes, [
    "chain-trace.started",
    "run.started",
    "text.delta",
    "text.delta",
    "run.completed",
  ]);
  assert.deepEqual(subscriberErrors.map((error) => error.eventType), ["text.delta", "text.delta"]);
  assert.equal(response.content, "逐段回复");
  assert.equal(detail.latestRun.status, "completed");
  assert.equal(detail.messages.at(-1).displayContent, "逐段回复");
  fixture.store.close();
});

// 验证工具调用由 Runtime 持久化、交付和幂等重放，实时结果不进入 Memory。
test("read-only weather tool is persisted, streamed, and replayed without a second connector call", async () => {
  let connectorCalls = 0;
  const weatherConnector = {
    /** 返回固定天气事实并记录实际 Connector 调用次数。 */
    async getWeather() {
      connectorCalls += 1;
      return {
        schemaVersion: "weather.v1",
        location: { name: "深圳", admin1: "广东", country: "中国", timezone: "Asia/Shanghai" },
        forecast: { date: "2026-07-30", condition: { code: 3, label: "阴" }, temperature: { current: 26 } },
        observedAt: "2026-07-30T20:15",
        source: { name: "Open-Meteo", retrievedAt: "2026-07-30T20:16:00.000Z" },
      };
    },
  };
  const toolRegistry = createToolRegistry([createWeatherToolDefinition(weatherConnector)]);
  const gatewayClient = createToolCallingGateway();
  const fixture = createTestRuntime({ gatewayClient, toolRegistry });
  const conversation = fixture.runtime.createConversation();
  const toolEvents = [];
  /** 收集 Runtime 产生的真实工具阶段。 */
  function collectToolEvent(event) {
    toolEvents.push(event);
  }
  const input = {
    requestId: "weather-request-1",
    clientMessageId: "weather-client-1",
    message: "今天深圳天气",
    imageUrls: [],
    documentUrls: [],
  };

  const response = await fixture.runtime.runConversation(
    conversation.id,
    input,
    createCollectingExecution(collectToolEvent, { types: ["tool.started", "tool.completed", "tool.failed"] }),
  );
  const replay = await fixture.runtime.runConversation(conversation.id, input);
  const detail = fixture.runtime.getConversation(conversation.id);
  const factEvents = fixture.store.listEventsAfter(conversation.id);

  assert.equal(connectorCalls, 1);
  assert.equal(response.toolCalls.length, 1);
  assert.equal(response.toolCalls[0].status, "completed");
  assert.equal(response.toolCalls[0].source, "Open-Meteo");
  assert.equal(response.acceptance.status, "accepted");
  assert.equal(response.acceptance.policyVersion, "weather-answer.v1");
  assert.equal(replay.replayed, true);
  assert.equal(replay.toolCalls.length, 1);
  assert.equal(replay.acceptance.status, "accepted");
  assert.deepEqual(toolEvents.map(readToolEventType), ["started", "completed"]);
  assert.deepEqual(
    factEvents.filter(isToolFactEvent).map(readFactEventType),
    ["tool.started", "tool.completed"],
  );
  assert.equal(detail.latestRun.toolCalls[0].observedAt, "2026-07-30T20:15");
  assert.equal(detail.memory.items.length, 0);
  fixture.store.close();
});

// 验证普通输入不会把受管天气工具暴露给模型，也不会伪造系统验收结论。
test("ordinary chat keeps governed tools closed and acceptance unset", async () => {
  let connectorCalls = 0;
  const weatherConnector = {
    /** 普通对话不应进入该 Connector。 */
    async getWeather() {
      connectorCalls += 1;
      throw new Error("weather connector must remain closed");
    },
  };
  const toolRegistry = createToolRegistry([createWeatherToolDefinition(weatherConnector)]);
  const fixture = createTestRuntime({ gatewayClient: createNoToolExposureGateway(), toolRegistry });
  const conversation = fixture.runtime.createConversation();

  const response = await run(fixture.runtime, conversation.id, "ordinary-no-tool", "介绍一下深圳");
  const detail = fixture.runtime.getConversation(conversation.id);

  assert.equal(connectorCalls, 0);
  assert.equal(response.content, "深圳是一座城市。");
  assert.equal(response.acceptance, null);
  assert.equal(detail.latestRun.acceptance, null);
  assert.deepEqual(detail.latestRun.toolCalls, []);
  fixture.store.close();
});

// 验证确定性天气路由缺少 ToolResult 时，模型候选不能自行完成 Run 或流入渠道。
test("weather route rejects a candidate when the required ToolResult is missing", async () => {
  const weatherConnector = {
    /** 模型未提出工具调用时，该 Connector 不应被执行。 */
    async getWeather() {
      throw new Error("weather connector must not execute without a tool call");
    },
  };
  const toolRegistry = createToolRegistry([createWeatherToolDefinition(weatherConnector)]);
  const fixture = createTestRuntime({ gatewayClient: createMissingRequiredToolGateway(), toolRegistry });
  const conversation = fixture.runtime.createConversation();
  const deltas = [];
  /** 收集渠道实际收到的正文，拒绝路径应保持为空。 */
  function collectDelta(delta) {
    deltas.push(delta);
  }

  await assert.rejects(
    fixture.runtime.runConversation(
      conversation.id,
      {
        requestId: "weather-missing-result-request",
        clientMessageId: "weather-missing-result-message",
        message: "今天深圳天气",
        imageUrls: [],
        documentUrls: [],
      },
      createCollectingExecution((event) => collectDelta(event.delta), { types: ["text.delta"], streamText: true }),
    ),
    isAcceptanceRejection,
  );
  const detail = fixture.runtime.getConversation(conversation.id);

  assert.deepEqual(deltas, []);
  assert.deepEqual(detail.messages.map(getMessageRole), ["user"]);
  assert.equal(detail.latestRun.status, "failed");
  assert.equal(detail.latestRun.errorCode, "result_acceptance_rejected");
  assert.equal(detail.latestRun.acceptance.status, "rejected");
  assert.deepEqual(detail.latestRun.acceptance.reasonCodes, ["acceptance_result_missing"]);
  fixture.store.close();
});

// 验证 Run 完成事务提交后的渠道增量失败不会反向改写或误报执行终态。
test("accepted weather Run remains completed when post-commit text delivery fails", async () => {
  let connectorCalls = 0;
  let deliveryAttempts = 0;
  const weatherConnector = {
    /** 返回固定天气事实并记录 Connector 调用次数。 */
    async getWeather() {
      connectorCalls += 1;
      return {
        schemaVersion: "weather.v1",
        location: { name: "深圳", timezone: "Asia/Shanghai" },
        forecast: { date: "2026-07-30", temperature: { current: 26 } },
        observedAt: "2026-07-30T20:15",
        source: { name: "Open-Meteo", retrievedAt: "2026-07-30T20:16:00.000Z" },
      };
    },
  };
  const toolRegistry = createToolRegistry([createWeatherToolDefinition(weatherConnector)]);
  const fixture = createTestRuntime({ gatewayClient: createToolCallingGateway(), toolRegistry });
  const conversation = fixture.runtime.createConversation();
  const input = {
    requestId: "weather-delivery-failure-request",
    clientMessageId: "weather-delivery-failure-message",
    message: "今天深圳天气",
    imageUrls: [],
    documentUrls: [],
  };
  /** 模拟验收通过、Run 已提交后当前渠道连接关闭。 */
  function failAcceptedDelivery() {
    deliveryAttempts += 1;
    throw new Error("scripted channel delivery failure");
  }

  const response = await fixture.runtime.runConversation(
    conversation.id,
    input,
    createCollectingExecution(failAcceptedDelivery, { types: ["text.delta"], streamText: true }),
  );
  const replay = await fixture.runtime.runConversation(conversation.id, input);
  const detail = fixture.runtime.getConversation(conversation.id);
  const runEvents = fixture.store.listEventsAfter(conversation.id).filter(isRunTerminalEvent);

  assert.equal(deliveryAttempts, 1);
  assert.equal(connectorCalls, 1);
  assert.equal(response.acceptance.status, "accepted");
  assert.equal(replay.replayed, true);
  assert.equal(replay.content, response.content);
  assert.equal(detail.latestRun.status, "completed");
  assert.equal(detail.latestRun.errorCode, null);
  assert.deepEqual(detail.messages.map(getMessageRole), ["user", "assistant"]);
  assert.deepEqual(runEvents.map(readFactEventType), ["run.completed"]);
  fixture.store.close();
});

// 验证工具后模型失败的恢复阶段继续使用原文本回调，并且最终只落一条助手消息。
test("ToolResult summary recovery keeps streaming delivery and one final assistant message", async () => {
  let connectorCalls = 0;
  const weatherConnector = {
    /** 返回固定天气事实并记录恢复前唯一一次 Connector 调用。 */
    async getWeather() {
      connectorCalls += 1;
      return {
        schemaVersion: "weather.v1",
        location: { name: "深圳", timezone: "Asia/Shanghai" },
        forecast: { date: "2026-07-31", temperature: { current: 26 } },
        observedAt: "2026-07-31T10:00",
        source: { name: "Open-Meteo", retrievedAt: "2026-07-31T10:01:00.000Z" },
      };
    },
  };
  const scenario = createStreamingToolRecoveryGateway();
  const toolRegistry = createToolRegistry([createWeatherToolDefinition(weatherConnector)]);
  const fixture = createTestRuntime({ gatewayClient: scenario.gatewayClient, toolRegistry });
  const conversation = fixture.runtime.createConversation();
  const deltas = [];
  /** 收集恢复阶段通过 Runtime Event Port 发布的文本增量。 */
  function collectRecoveryDelta(delta) {
    deltas.push(delta);
  }

  const response = await fixture.runtime.runConversation(
    conversation.id,
    {
      requestId: "weather-stream-recovery-request",
      clientMessageId: "weather-stream-recovery-client",
      message: "今天深圳天气",
      imageUrls: [],
      documentUrls: [],
    },
    createCollectingExecution((event) => collectRecoveryDelta(event.delta), { types: ["text.delta"], streamText: true }),
  );
  const detail = fixture.runtime.getConversation(conversation.id);

  assert.equal(connectorCalls, 1);
  assert.equal(scenario.getGenerationCalls(), 2);
  assert.deepEqual(deltas, ["深圳当前 26°C，", "数据时间 2026-07-31T10:00，来源 Open-Meteo。"]);
  assert.equal(response.content, "深圳当前 26°C，数据时间 2026-07-31T10:00，来源 Open-Meteo。");
  assert.deepEqual(detail.messages.map(getMessageRole), ["user", "assistant"]);
  assert.equal(detail.latestRun.status, "completed");
  assert.equal(detail.latestRun.toolCalls[0].status, "completed");
  assert.equal(detail.latestRun.acceptance.status, "accepted");
  assert.equal(detail.latestRun.resilience.recovered, true);
  assert.equal(detail.latestRun.resilience.recovery.execution.outputStarted, true);
  fixture.store.close();
});

// 验证未验收天气候选不算渠道输出，失败后可由已提交 ToolResult 生成并交付新总结。
test("ToolResult summary recovery replaces withheld weather output with an accepted summary", async () => {
  let connectorCalls = 0;
  const weatherConnector = {
    /** 返回固定天气事实并记录唯一一次 Connector 调用。 */
    async getWeather() {
      connectorCalls += 1;
      return {
        schemaVersion: "weather.v1",
        location: { name: "深圳", timezone: "Asia/Shanghai" },
        forecast: { date: "2026-07-31", temperature: { current: 26 } },
        observedAt: "2026-07-31T10:00",
        source: { name: "Open-Meteo", retrievedAt: "2026-07-31T10:01:00.000Z" },
      };
    },
  };
  const scenario = createStreamingToolRecoveryGateway({ outputBeforeFailure: true });
  const toolRegistry = createToolRegistry([createWeatherToolDefinition(weatherConnector)]);
  const fixture = createTestRuntime({ gatewayClient: scenario.gatewayClient, toolRegistry });
  const conversation = fixture.runtime.createConversation();
  const deltas = [];
  /** 收集渠道实际收到的正文；验收前候选不得进入该数组。 */
  function collectOriginalDelta(delta) {
    deltas.push(delta);
  }

  const response = await fixture.runtime.runConversation(
    conversation.id,
    {
      requestId: "weather-post-output-failure-request",
      clientMessageId: "weather-post-output-failure-client",
      message: "今天深圳天气",
      imageUrls: [],
      documentUrls: [],
    },
    createCollectingExecution((event) => collectOriginalDelta(event.delta), { types: ["text.delta"], streamText: true }),
  );
  const detail = fixture.runtime.getConversation(conversation.id);

  assert.equal(connectorCalls, 1);
  assert.equal(scenario.getGenerationCalls(), 2);
  assert.deepEqual(deltas, ["深圳当前 26°C，", "数据时间 2026-07-31T10:00，来源 Open-Meteo。"]);
  assert.deepEqual(detail.messages.map(getMessageRole), ["user", "assistant"]);
  assert.equal(detail.latestRun.status, "completed");
  assert.equal(detail.latestRun.toolCalls[0].status, "completed");
  assert.equal(detail.latestRun.acceptance.status, "accepted");
  assert.equal(detail.latestRun.resilience.recovery.status, "completed");
  assert.equal(response.content, "深圳当前 26°C，数据时间 2026-07-31T10:00，来源 Open-Meteo。");
  fixture.store.close();
});

// 验证重启扫描不会猜测恢复一个尚无 completed ToolResult 的遗留 Run。
test("restart recovery fails a running Run without a stable ToolResult checkpoint", async () => {
  const fixture = createTestRuntime();
  const conversation = fixture.runtime.createConversation();
  const deadlineAt = Date.now() + 30_000;
  const started = fixture.store.startRun({
    conversationId: conversation.id,
    requestId: "restart-without-checkpoint-request",
    clientMessageId: "restart-without-checkpoint-message",
    content: "普通遗留请求",
    displayContent: "普通遗留请求",
    model: "scripted-test-model",
    operation: "conversation.chat",
    deadlineAt,
    chainTraceId: "restart-without-checkpoint-trace",
  });

  const report = await fixture.runtime.recoverInterruptedRuns();
  const detail = fixture.runtime.getConversation(conversation.id);

  assert.equal(report.scanned, 1);
  assert.equal(report.recovered, 0);
  assert.equal(report.failed, 1);
  assert.equal(report.outcomes[0].reasonCode, "run_stable_checkpoint_missing");
  assert.equal(detail.latestRun.id, started.run.id);
  assert.equal(detail.latestRun.status, "failed");
  assert.equal(detail.latestRun.errorCode, "run_recovery_unavailable");
  assert.equal(detail.latestRun.resilience.recovery.stopReason, "run_stable_checkpoint_missing");
  assert.deepEqual(detail.messages.map(getMessageRole), ["user"]);
  fixture.store.close();
});

// 验证工具失败收口为安全 ToolResult，同时保留完成回答和脱敏工具 Span。
test("weather tool failures remain safe, observable, and separate from model failures", async () => {
  const tracedSpans = [];
  const chainTracer = {
    /** 记录阶段名和安全属性，并直接执行测试操作。 */
    withSpan(name, attributes, operation) {
      tracedSpans.push({ name, attributes });
      return operation({
        /** 测试不需要记录动态属性。 */
        setAttribute() {},
        /** 测试不需要记录动态属性集合。 */
        setAttributes() {},
        /** 测试不需要记录错误事件。 */
        recordError() {},
        /** withSpan 自动收口，测试 Span 无需手动结束。 */
        end() {},
      });
    },
    /** 返回队列阶段使用的最小手动 Span。 */
    startSpan(name, attributes) {
      tracedSpans.push({ name, attributes });
      return {
        /** 测试不需要记录动态属性。 */
        setAttribute() {},
        /** 测试不需要记录动态属性集合。 */
        setAttributes() {},
        /** 测试不需要记录错误事件。 */
        recordError() {},
        /** 测试手动 Span 不持有外部资源。 */
        end() {},
      };
    },
  };
  const weatherConnector = {
    /** 模拟未知 Connector 异常，原始正文不得进入持久化或 Trace。 */
    async getWeather() {
      throw new Error("raw upstream weather response");
    },
  };
  const toolRegistry = createToolRegistry([createWeatherToolDefinition(weatherConnector)]);
  const gatewayClient = createFailingToolGateway();
  const fixture = createTestRuntime({ gatewayClient, toolRegistry, chainTracer });
  const conversation = fixture.runtime.createConversation();
  const toolEvents = [];
  /** 收集工具失败阶段，验证渠道只接收公开错误。 */
  function collectToolEvent(event) {
    toolEvents.push(event);
  }

  const response = await fixture.runtime.runConversation(
    conversation.id,
    {
      requestId: "weather-failure-request-1",
      clientMessageId: "weather-failure-client-1",
      message: "今天未知地点天气",
      imageUrls: [],
      documentUrls: [],
    },
    createCollectingExecution(collectToolEvent, { types: ["tool.started", "tool.completed", "tool.failed"] }),
  );
  const detail = fixture.runtime.getConversation(conversation.id);
  const toolSpan = tracedSpans.find(isToolExecutionSpan);

  assert.equal(response.content, "天气查询失败，请稍后重试。");
  assert.equal(response.toolCalls[0].status, "failed");
  assert.deepEqual(response.toolCalls[0].error, {
    code: "weather_query_failed",
    message: "天气查询未能完成，请稍后重试。",
    retryable: false,
  });
  assert.deepEqual(toolEvents.map(readToolEventType), ["started", "failed"]);
  assert.equal(detail.latestRun.status, "completed");
  assert.equal(toolSpan.attributes["ai.platform.capability_scenario_id"], "C4");
  assert.equal(toolSpan.attributes["gen_ai.tool.name"], "get_weather");
  assert.equal(typeof toolSpan.attributes["ai.platform.tool_call_id"], "string");
  assert.equal(JSON.stringify({ detail, toolEvents, toolSpan }).includes("raw upstream weather response"), false);
  fixture.store.close();
});

// 验证成功模型调用的逐尝试证据随同一个 Run 持久化并返回渠道。
test("completed runs persist model retry evidence", async () => {
  const fixture = createTestRuntime({ gatewayClient: createRetryTraceGateway() });
  const conversation = fixture.runtime.createConversation();
  const response = await run(fixture.runtime, conversation.id, 1, "验证重试证据");
  const detail = fixture.runtime.getConversation(conversation.id);

  assert.equal(response.resilience.attemptCount, 2);
  assert.equal(detail.lastRun.resilience.attempts[0].status, "failed");
  assert.equal(detail.lastRun.resilience.attempts[1].status, "completed");
  assert.equal(detail.messages.length, 2);
  fixture.store.close();
});

// 验证 Run 选择的模型别名同时进入 token counter、生成调用和完成事实。
test("runtime routes the selected model through planning and generation", async () => {
  const observations = [];
  const fixture = createTestRuntime({ gatewayClient: createModelSelectionGateway(observations) });
  const conversation = fixture.runtime.createConversation();

  const response = await run(fixture.runtime, conversation.id, 1, "验证模型选择", "chat-quality");
  const detail = fixture.runtime.getConversation(conversation.id);
  assert.deepEqual(observations, ["count:chat-quality", "generate:chat-quality"]);
  assert.equal(response.model, "chat-quality");
  assert.equal(detail.lastRun.model, "chat-quality");
  fixture.store.close();
});

// 验证 Runtime 在 Run 落库前按操作传播稳定能力错配，不创建用户消息或调用生成方法。
test("runtime rejects model capability mismatches before creating a run", async () => {
  const gatewayClient = createScriptedGateway();
  gatewayClient.imageModel = "image-default";
  /** 模拟 GatewayClient 拒绝含图对话使用未声明 vision 能力的别名。 */
  async function rejectVisionModel(requestedModel, requirements) {
    assert.equal(requirements.requiresVision, true);
    throw new GatewayRequestError("Model capability mismatch", 400, {
      code: "model_capability_mismatch",
      model: requestedModel,
      operation: "conversation.chat",
      requiredCapability: "vision",
    });
  }
  /** 模拟 GatewayClient 拒绝图片生成使用聊天模型别名。 */
  async function rejectImageModel(requestedModel, operation) {
    throw new GatewayRequestError("Model capability mismatch", 400, {
      code: "model_capability_mismatch",
      model: requestedModel,
      operation,
      requiredCapability: "imageGeneration",
    });
  }
  gatewayClient.resolveConversationModel = rejectVisionModel;
  gatewayClient.resolveImageModel = rejectImageModel;
  const fixture = createTestRuntime({ gatewayClient });
  const conversation = fixture.runtime.createConversation();

  await assert.rejects(
    fixture.runtime.runConversation(conversation.id, {
      requestId: "runtime-vision-capability-request",
      clientMessageId: "runtime-vision-capability-message",
      model: "chat-text",
      message: "这张图片是什么",
      imageUrls: ["data:image/png;base64,YQ=="],
    }),
    matchesVisionCapabilityMismatch,
  );
  await assert.rejects(
    fixture.runtime.runConversation(conversation.id, {
      operation: "image.generate",
      requestId: "runtime-image-capability-request",
      clientMessageId: "runtime-image-capability-message",
      model: "chat-default",
      message: "生成图片",
    }),
    matchesImageCapabilityMismatch,
  );
  assert.equal(fixture.runtime.getConversation(conversation.id).messages.length, 0);
  fixture.store.close();
});

/** 验证附件矩阵在分类模型调用前把图片副作用候选收敛到允许集合。 */
function testAutoIntentAttachmentCandidates() {
  assert.deepEqual(resolveIntentCandidates({ references: [], imageUrls: [], documentUrls: [] }), [
    "conversation.chat",
    "image.generate",
  ]);
  assert.deepEqual(resolveIntentCandidates(
    { references: [], imageUrls: [], documentUrls: [] },
    { activeImage: { assetId: "active-asset" } },
  ), ["conversation.chat", "image.generate", "image.edit"]);
  assert.deepEqual(resolveIntentCandidates({
    references: [{ type: "image_asset", assetId: "asset-1" }],
    imageUrls: [],
    documentUrls: [],
  }), ["conversation.chat", "image.edit"]);
  assert.deepEqual(resolveIntentCandidates({
    references: [],
    imageUrls: ["https://example.com/image.png"],
    documentUrls: [],
  }), ["conversation.chat"]);
  assert.deepEqual(resolveIntentCandidates({
    references: [
      { type: "image_asset", assetId: "asset-1" },
      { type: "image_asset", assetId: "asset-2" },
    ],
    imageUrls: [],
    documentUrls: [],
  }), ["conversation.chat"]);
}

test("auto intent candidates are constrained by attachment facts", testAutoIntentAttachmentCandidates);

/** 验证图片操作只有达到固定阈值才通过，非法候选和分类异常统一安全回退对话。 */
async function testStructuredIntentConfidenceGate() {
  const scriptedOutputs = [
    {
      operation: "image.generate",
      confidence: 0.8499,
      useActiveImage: false,
      relevantMessageIds: [],
    },
    {
      operation: "image.generate",
      confidence: 0.85,
      useActiveImage: false,
      relevantMessageIds: [],
    },
    {
      operation: "image.generate",
      confidence: 0.99,
      useActiveImage: false,
      relevantMessageIds: [],
    },
  ];
  const gatewayClient = {
    /** 按调用顺序返回结构化分类结果，第三项故意越过单图编辑候选。 */
    async chatCompletions() {
      return { output: scriptedOutputs.shift() };
    },
  };
  const router = createRunIntentRouter({ gatewayClient });
  const textInput = { message: "生成一张海报", references: [], imageUrls: [], documentUrls: [] };
  const editInput = {
    message: "把背景改成蓝色",
    references: [{ type: "image_asset", assetId: "asset-1" }],
    imageUrls: [],
    documentUrls: [],
  };

  const belowThreshold = await router.resolve(textInput);
  const atThreshold = await router.resolve(textInput);
  const outsideCandidate = await router.resolve(editInput);

  assert.equal(belowThreshold.operation, "conversation.chat");
  assert.equal(belowThreshold.source, "low-confidence-fallback");
  assert.equal(atThreshold.operation, "image.generate");
  assert.equal(atThreshold.source, "structured-classifier");
  assert.equal(outsideCandidate.operation, "conversation.chat");
  assert.equal(outsideCandidate.source, "classification-fallback");

  const failingRouter = createRunIntentRouter({
    gatewayClient: {
      /** 模拟分类模型或结构化解析不可用。 */
      async chatCompletions() {
        throw new Error("classifier unavailable");
      },
    },
  });
  assert.equal((await failingRouter.resolve(textInput)).operation, "conversation.chat");
}

test("structured intent routing gates image side effects at confidence 0.85", testStructuredIntentConfidenceGate);

/** 验证分类器可读取有界会话语境，但不能选择资产 ID、伪造证据或引用空正文。 */
async function testStructuredIntentUsesValidatedConversationContext() {
  const classifierInputs = [];
  const scriptedOutputs = [
    {
      operation: "image.edit",
      confidence: 0.96,
      useActiveImage: true,
      relevantMessageIds: ["message-2"],
    },
    {
      operation: "image.edit",
      confidence: 0.99,
      useActiveImage: true,
      relevantMessageIds: ["forged-message"],
    },
    {
      operation: "image.edit",
      confidence: 0.99,
      useActiveImage: true,
      relevantMessageIds: ["message-3"],
    },
    {
      operation: "image.edit",
      confidence: 0.99,
      useActiveImage: true,
      relevantMessageIds: ["message-4"],
    },
  ];
  const router = createRunIntentRouter({
    gatewayClient: {
      /** 保存分类器可见消息并按轮次返回结构化结果。 */
      async chatCompletions(input) {
        classifierInputs.push(input.messages);
        return { output: scriptedOutputs.shift() };
      },
    },
  });
  const input = {
    message: "继续处理并返回结果",
    references: [],
    imageUrls: [],
    documentUrls: [],
  };
  const routingContextSnapshot = {
    strategyVersion: "routing-context.v2",
    conversationVersion: 7,
    activeImage: {
      assetId: "private-active-asset",
      source: "edited",
      anchorMessageId: "message-2",
      anchorSeq: 2,
    },
    messages: [
      {
        id: "message-1",
        seq: 1,
        role: "user",
        displayContent: "把标题颜色调整得更醒目",
        runOperation: "image.edit",
        hasImageArtifact: false,
      },
      {
        id: "message-2",
        seq: 2,
        role: "assistant",
        displayContent: "已编辑 1 张图片",
        runOperation: "image.edit",
        hasImageArtifact: true,
      },
      {
        id: "message-3",
        seq: 3,
        role: "assistant",
        displayContent: "",
        runOperation: "conversation.chat",
        hasImageArtifact: false,
      },
      {
        id: "message-4",
        seq: 4,
        role: "user",
        displayContent: "这条历史正文不完整，不能驱动图片副作用",
        contentTruncated: true,
        runOperation: "conversation.chat",
        hasImageArtifact: false,
      },
    ],
    truncated: false,
  };

  const accepted = await router.resolve(input, { routingContextSnapshot });
  const rejected = await router.resolve(input, { routingContextSnapshot });
  const emptyEvidence = await router.resolve(input, { routingContextSnapshot });
  const truncatedEvidence = await router.resolve(input, { routingContextSnapshot });
  const classifierPayload = JSON.parse(classifierInputs[0][1].content);

  assert.equal(accepted.operation, "image.edit");
  assert.deepEqual(accepted.candidates, ["conversation.chat", "image.generate", "image.edit"]);
  assert.deepEqual(accepted.relevantMessageIds, ["message-2"]);
  assert.equal(accepted.contextVersion, 7);
  assert.equal(classifierPayload.activeImage.anchorMessageId, "message-2");
  assert.equal(JSON.stringify(classifierPayload).includes("private-active-asset"), false);
  assert.equal(rejected.operation, "conversation.chat");
  assert.equal(rejected.source, "invalid-context-evidence-fallback");
  assert.equal(rejected.useActiveImage, false);
  assert.equal(emptyEvidence.operation, "conversation.chat");
  assert.equal(emptyEvidence.source, "invalid-context-evidence-fallback");
  assert.deepEqual(emptyEvidence.relevantMessageIds, []);
  assert.equal(classifierPayload.recentMessages[3].contentTruncated, true);
  assert.equal(truncatedEvidence.operation, "conversation.chat");
  assert.equal(truncatedEvidence.source, "invalid-context-evidence-fallback");
  assert.deepEqual(truncatedEvidence.relevantMessageIds, []);
}

test(
  "structured intent routing rejects forged, empty, or truncated evidence",
  testStructuredIntentUsesValidatedConversationContext,
);

/** 验证路由投影只读取 committed 正文，并在分类前脱敏 URL 而不改写会话事实。 */
async function testRoutingSnapshotProjectsSafeCommittedHistory() {
  const store = createConversationStore({ databasePath: ":memory:" });
  try {
    const conversation = store.createConversation();
    const bareDocumentUrl = "https://docs.example.test/design/spec(section)?signature=synthetic-marker-a#part";
    const markdownDocumentUrl = "https://docs.example.test/guide_(draft)?token=synthetic-marker-b#chapter";
    const punctuatedDocumentUrl = "http://assets.example.test/export?key=synthetic-marker-c";
    const parenthesizedDocumentUrl = "https://assets.example.test/archive?key=synthetic-marker-d#result";
    const privateDataUrl = "data:image/png;base64,c3ludGhldGljLW1hcmtlci1k";
    const displayContent = [
      "保留这段普通正文",
      `参考文档：${bareDocumentUrl}，继续保留后续判断`,
      `Markdown：[设计说明](${markdownDocumentUrl})。继续保留链接后的说明`,
      `英文标点：${punctuatedDocumentUrl}, keep following text`,
      `外层括号：(${parenthesizedDocumentUrl}). keep closing punctuation`,
      `内联图片：![预览](${privateDataUrl})。继续保留图片后的说明`,
    ].join("\n");
    const started = store.startRun({
      conversationId: conversation.id,
      requestId: "routing-projection-request",
      clientMessageId: "routing-projection-message",
      content: displayContent,
      displayContent,
      operation: "conversation.chat",
    });
    store.cancelRun({
      conversationId: conversation.id,
      runId: started.run.id,
      partialContent: "这段中断输出不应参与后续意图判断",
      model: "scripted-test-model",
    });

    const snapshot = store.getRoutingContextSnapshot(conversation.id, { maxMessages: 1 });
    const detail = store.getConversation(conversation.id);
    const classifierCalls = [];
    const router = createRunIntentRouter({
      gatewayClient: {
        /** 保存结构化分类实际收到的消息，并返回无副作用的确定性决定。 */
        async chatCompletions(input) {
          classifierCalls.push(input.messages);
          return {
            output: {
              operation: "conversation.chat",
              confidence: 0.99,
              useActiveImage: false,
              relevantMessageIds: [],
            },
          };
        },
      },
    });
    await router.resolve(
      { message: "select the next operation", references: [], imageUrls: [], documentUrls: [] },
      { routingContextSnapshot: snapshot },
    );
    const classifierPayload = JSON.stringify(classifierCalls);

    assert.equal(snapshot.messages.length, 1);
    assert.equal(snapshot.messages[0].id, started.userMessage.id);
    assert.equal(snapshot.messages[0].displayContent, [
      "保留这段普通正文",
      "参考文档：[url]，继续保留后续判断",
      "Markdown：[设计说明]([url])。继续保留链接后的说明",
      "英文标点：[url], keep following text",
      "外层括号：([url]). keep closing punctuation",
      "内联图片：![预览]([data-url])。继续保留图片后的说明",
    ].join("\n"));
    assert.equal(snapshot.truncated, false);
    assert.equal(classifierPayload.includes("docs.example.test"), false);
    assert.equal(classifierPayload.includes("assets.example.test"), false);
    assert.equal(classifierPayload.includes("synthetic-marker"), false);
    assert.equal(classifierPayload.includes("c3ludGhldGljLW1hcmtlci1k"), false);
    assert.equal(classifierPayload.includes("[url]"), true);
    assert.equal(classifierPayload.includes("[data-url]"), true);
    assert.equal(detail.messages.length, 2);
    assert.equal(detail.messages[0].displayContent, displayContent);
    assert.equal(detail.messages[1].status, "interrupted");

    const longConversation = store.createConversation();
    const longContent = `前部旧指令-${"x".repeat(1001)}-尾部纠正结论`;
    store.startRun({
      conversationId: longConversation.id,
      requestId: "routing-long-content-request",
      clientMessageId: "routing-long-content-message",
      content: longContent,
      displayContent: longContent,
    });
    const truncatedSnapshot = store.getRoutingContextSnapshot(longConversation.id);
    assert.equal(truncatedSnapshot.messages[0].displayContent, "[message-content-truncated]");
    assert.equal(truncatedSnapshot.messages[0].contentTruncated, true);
    assert.equal(truncatedSnapshot.messages[0].displayContent.includes("前部旧指令"), false);
    assert.equal(truncatedSnapshot.messages[0].displayContent.includes("尾部纠正结论"), false);
    assert.equal(truncatedSnapshot.truncated, true);
  } finally {
    store.close();
  }
}

test(
  "routing snapshot excludes interrupted messages and redacts URLs before classification",
  testRoutingSnapshotProjectsSafeCommittedHistory,
);

/** 验证未知 operation 在创建 Run 或调用模型前被输入契约拒绝。 */
async function testUnsupportedRunOperation() {
  const fixture = createTestRuntime();
  try {
    const conversation = fixture.runtime.createConversation();
    await assert.rejects(
      fixture.runtime.runConversation(conversation.id, {
        operation: "unknown.operation",
        requestId: "unsupported-operation-request",
        clientMessageId: "unsupported-operation-message",
        message: "验证未知操作",
      }),
      /** 只接受输入层的稳定错误码。 */
      function matchesUnsupportedOperation(error) {
        return error?.payload?.code === "unsupported_run_operation";
      },
    );
    assert.equal(fixture.runtime.getConversation(conversation.id).messages.length, 0);
  } finally {
    fixture.store.close();
  }
}

test("runtime rejects unsupported operations before creating a Run", testUnsupportedRunOperation);

/** 验证 auto 请求由 Runtime 持久化真实 operation，完成态重放不会再次调用路由器。 */
async function testAutoRoutingPersistenceAndReplay() {
  let routingCalls = 0;
  const intentRouter = {
    /** 始终把当前无附件输入解析为普通对话，并记录分类次数。 */
    async resolve() {
      routingCalls += 1;
      return {
        operation: "conversation.chat",
        confidence: 0.94,
        source: "structured-classifier",
        candidates: ["conversation.chat", "image.generate"],
      };
    },
  };
  const fixture = createTestRuntime({ intentRouter });
  const conversation = fixture.runtime.createConversation();
  const input = {
    operation: "auto",
    requestId: "auto-routing-request",
    clientMessageId: "auto-routing-message",
    message: "解释一下 Runtime 的职责",
  };

  const first = await fixture.runtime.runConversation(conversation.id, input);
  const replay = await fixture.runtime.runConversation(conversation.id, input);
  const detail = fixture.runtime.getConversation(conversation.id);

  assert.equal(first.operation, "conversation.chat");
  assert.equal(replay.replayed, true);
  assert.equal(detail.latestRun.operation, "conversation.chat");
  assert.equal(routingCalls, 1);
  fixture.store.close();
}

test("auto routing persists the resolved operation and skips classification on replay", testAutoRoutingPersistenceAndReplay);

/** 验证分类期间会话版本变化会触发一次重新取快照，而不会用旧上下文创建 Run。 */
async function testAutoRoutingRetriesOneStaleContext() {
  const observedVersions = [];
  const intentRouter = {
    /** 记录每次分类读取的 Store 版本并返回无图片副作用的合法决定。 */
    async resolve(_input, execution = {}) {
      const version = execution.routingContextSnapshot.conversationVersion;
      observedVersions.push(version);
      return {
        schemaVersion: "run-intent-decision.v2",
        routerVersion: "runtime-intent.v2",
        operation: "conversation.chat",
        classifiedOperation: "conversation.chat",
        confidence: 0.93,
        threshold: 0.85,
        source: "structured-classifier",
        candidates: ["conversation.chat", "image.generate"],
        useActiveImage: false,
        relevantMessageIds: [],
        contextVersion: version,
        contextStrategyVersion: "routing-context.v2",
        contextTruncated: false,
      };
    },
  };
  const fixture = createTestRuntime({ intentRouter });
  try {
    const conversation = fixture.runtime.createConversation({ title: "初始标题" });
    const originalStartRun = fixture.store.startRun.bind(fixture.store);
    let startAttempts = 0;
    /** 首次创建前模拟另一个实例提交会话更新，使当前分类快照失效。 */
    function startRunAfterOneConcurrentChange(input) {
      startAttempts += 1;
      if (startAttempts === 1) {
        fixture.store.updateConversation(conversation.id, { title: "并发更新后的标题" });
      }
      return originalStartRun(input);
    }
    fixture.store.startRun = startRunAfterOneConcurrentChange;

    const result = await fixture.runtime.runConversation(conversation.id, {
      operation: "auto",
      requestId: "auto-stale-routing-request",
      clientMessageId: "auto-stale-routing-message",
      message: "解释当前会话上下文",
    });
    const detail = fixture.runtime.getConversation(conversation.id);

    assert.equal(result.operation, "conversation.chat");
    assert.equal(startAttempts, 2);
    assert.deepEqual(observedVersions, [conversation.version, conversation.version + 1]);
    assert.equal(detail.latestRun.intentDecision.contextVersion, conversation.version + 1);
    assert.equal(detail.latestRun.status, "completed");
  } finally {
    fixture.store.close();
  }
}

test("auto routing retries once when its conversation snapshot becomes stale", testAutoRoutingRetriesOneStaleContext);

/** 验证 auto 模式不接受浏览器模型选择或恢复关系，且不会创建 Run。 */
async function testAutoRoutingRejectsClientOwnedDecisions() {
  const fixture = createTestRuntime();
  const conversation = fixture.runtime.createConversation();
  await assert.rejects(
    fixture.runtime.runConversation(conversation.id, {
      operation: "auto",
      requestId: "auto-model-request",
      clientMessageId: "auto-model-message",
      model: "client-model",
      message: "生成一张图",
    }),
    /** 只接受 auto 模型注入的稳定输入错误。 */
    function matchesAutoModelRejection(error) {
      return error?.payload?.code === "auto_model_not_allowed";
    },
  );
  await assert.rejects(
    fixture.runtime.runConversation(conversation.id, {
      operation: "auto",
      requestId: "auto-recovery-request",
      clientMessageId: "auto-recovery-message",
      sourceRunId: "source-run",
      recoveryMode: "retry",
      message: "重试",
    }),
    /** 只接受 auto 恢复关系的稳定输入错误。 */
    function matchesAutoRecoveryRejection(error) {
      return error?.payload?.code === "auto_recovery_not_allowed";
    },
  );
  assert.equal(fixture.runtime.getConversation(conversation.id).messages.length, 0);
  fixture.store.close();
}

test("auto routing rejects client model selection and recovery lineage", testAutoRoutingRejectsClientOwnedDecisions);

/** 验证分类继承调用方取消，并以最多十秒子截止时间把非取消分类失败回退为对话。 */
async function testAutoRoutingCancellationAndDeadline() {
  let resolveRoutingStarted;
  // Promise executor 暴露分类器已经取得调用方取消信号的事实。
  const routingStarted = new Promise((resolve) => {
    resolveRoutingStarted = resolve;
  });
  const cancellingRouter = {
    /** 等待调用方取消后终止分类，不返回任何可落库 operation。 */
    async resolve(_input, execution) {
      resolveRoutingStarted();
      await waitForAbort(execution.abortSignal);
      throw execution.abortSignal.reason || new DOMException("Intent routing was aborted", "AbortError");
    },
  };
  const cancellingFixture = createTestRuntime({ intentRouter: cancellingRouter });
  const cancellingConversation = cancellingFixture.runtime.createConversation();
  const controller = new AbortController();
  const cancelledRun = cancellingFixture.runtime.runConversation(
    cancellingConversation.id,
    {
      operation: "auto",
      requestId: "auto-routing-cancel-request",
      clientMessageId: "auto-routing-cancel-message",
      message: "生成一张图片",
    },
    { abortSignal: controller.signal },
  );
  await routingStarted;
  controller.abort(new DOMException("Caller cancelled routing", "AbortError"));
  await assert.rejects(
    cancelledRun,
    /** 只接受调用方取消原因，不把分类取消改写为对话回退。 */
    function matchesRoutingCancellation(error) {
      return error?.name === "AbortError";
    },
  );
  assert.equal(cancellingFixture.runtime.getConversation(cancellingConversation.id).messages.length, 0);
  cancellingFixture.store.close();

  const gatewayClient = createScriptedGateway();
  const originalChatCompletions = gatewayClient.chatCompletions.bind(gatewayClient);
  let classificationCalls = 0;
  let routingBudgetMs = null;
  /** 让分类阶段确定性失败并记录 Runtime 分配的子截止时间，业务对话仍走原脚本实现。 */
  gatewayClient.chatCompletions = async function routeOrGenerate(input) {
    if (input.operation === "model.intent.classify") {
      classificationCalls += 1;
      routingBudgetMs = input.resilienceContext.deadlineAt - Date.now();
      throw new Error("intent classifier unavailable");
    }
    return originalChatCompletions(input);
  };
  const fallbackFixture = createTestRuntime({ gatewayClient });
  const fallbackConversation = fallbackFixture.runtime.createConversation();
  const fallback = await fallbackFixture.runtime.runConversation(fallbackConversation.id, {
    operation: "auto",
    requestId: "auto-routing-deadline-request",
    clientMessageId: "auto-routing-deadline-message",
    message: "请解释图片生成能力",
  });
  assert.equal(fallback.operation, "conversation.chat");
  assert.equal(classificationCalls, 1);
  assert.ok(routingBudgetMs > 0 && routingBudgetMs <= 10000);
  assert.equal(fallbackFixture.runtime.getConversation(fallbackConversation.id).latestRun.operation, "conversation.chat");
  fallbackFixture.store.close();
}

test("auto routing inherits cancellation and bounds the classifier deadline", testAutoRoutingCancellationAndDeadline);

/** 验证预取消请求在显式与单候选 auto 路径都不会创建 Run 或用户消息。 */
async function testPreCancelledRunsStayUnpersisted() {
  const fixture = createTestRuntime();
  try {
    const conversation = fixture.runtime.createConversation();
    const explicitController = new AbortController();
    explicitController.abort(new DOMException("Explicit request was cancelled", "AbortError"));
    await assert.rejects(
      fixture.runtime.runConversation(
        conversation.id,
        {
          requestId: "pre-cancelled-explicit-request",
          clientMessageId: "pre-cancelled-explicit-message",
          message: "不要创建显式 Run",
        },
        { abortSignal: explicitController.signal },
      ),
      isAbortError,
    );

    const autoController = new AbortController();
    autoController.abort(new DOMException("Auto request was cancelled", "AbortError"));
    await assert.rejects(
      fixture.runtime.runConversation(
        conversation.id,
        {
          operation: "auto",
          requestId: "pre-cancelled-auto-request",
          clientMessageId: "pre-cancelled-auto-message",
          message: "解释远程图片",
          imageUrls: ["https://example.com/reference.png"],
        },
        { abortSignal: autoController.signal },
      ),
      isAbortError,
    );

    assert.equal(fixture.store.findRunByRequestId(conversation.id, "pre-cancelled-explicit-request"), null);
    assert.equal(fixture.store.findRunByRequestId(conversation.id, "pre-cancelled-auto-request"), null);
    assert.equal(fixture.runtime.getConversation(conversation.id).messages.length, 0);
  } finally {
    fixture.store.close();
  }
}

test("pre-cancelled explicit and single-candidate auto requests create no Run", testPreCancelledRunsStayUnpersisted);

/** 验证分类器忽略取消并返回决定时，Runtime 仍让取消优先于策略和持久化。 */
async function testCancellationAfterIntentDecisionStaysUnpersisted() {
  const controller = new AbortController();
  const intentRouter = {
    /** 在返回合法决定前触发调用方取消，模拟不协作的分类实现。 */
    async resolve() {
      controller.abort(new DOMException("Routing result arrived after cancellation", "AbortError"));
      return {
        operation: "conversation.chat",
        confidence: 0.93,
        source: "structured-classifier",
        candidates: ["conversation.chat", "image.generate"],
      };
    },
  };
  const fixture = createTestRuntime({ intentRouter });
  try {
    const conversation = fixture.runtime.createConversation();
    await assert.rejects(
      fixture.runtime.runConversation(
        conversation.id,
        {
          operation: "auto",
          requestId: "cancelled-after-routing-request",
          clientMessageId: "cancelled-after-routing-message",
          message: "生成一张图片",
        },
        { abortSignal: controller.signal },
      ),
      isAbortError,
    );

    assert.equal(fixture.store.findRunByRequestId(conversation.id, "cancelled-after-routing-request"), null);
    assert.equal(fixture.runtime.getConversation(conversation.id).messages.length, 0);
  } finally {
    fixture.store.close();
  }
}

test("cancellation wins when an intent router returns after abort", testCancellationAfterIntentDecisionStaysUnpersisted);

/** 验证排队期间取消的后续请求在取得串行执行权后不会创建伪 Run。 */
async function testQueuedCancellationStaysUnpersisted() {
  let releaseFirstGeneration;
  let markFirstGenerationStarted;
  let markSecondQueued;
  // Promise executor 暴露首个模型调用已占用会话串行区的事实。
  const firstGenerationStarted = new Promise((resolve) => {
    markFirstGenerationStarted = resolve;
  });
  // Promise executor 让测试在明确时点释放首个模型调用。
  const firstGenerationGate = new Promise((resolve) => {
    releaseFirstGeneration = resolve;
  });
  // Promise executor 暴露第二个请求已经进入协调器队列的事实。
  const secondQueued = new Promise((resolve) => {
    markSecondQueued = resolve;
  });
  const gatewayClient = createScriptedGateway();
  const originalChatCompletions = gatewayClient.chatCompletions.bind(gatewayClient);
  let generationCalls = 0;
  /** 首个普通生成保持挂起，结构化调用和后续调用继续使用脚本实现。 */
  async function holdFirstGeneration(input) {
    if (!input.outputSchema) {
      generationCalls += 1;
      if (generationCalls === 1) {
        markFirstGenerationStarted();
        await firstGenerationGate;
      }
    }
    return originalChatCompletions(input);
  }
  gatewayClient.chatCompletions = holdFirstGeneration;
  const baseCoordinator = createConversationCoordinator();
  let coordinatorCalls = 0;
  const coordinator = {
    /** 委托真实协调器，并在第二次调用已同步入队后通知测试。 */
    async runExclusive(conversationId, operation, execution) {
      coordinatorCalls += 1;
      const pending = baseCoordinator.runExclusive(conversationId, operation, execution);
      if (coordinatorCalls === 2) markSecondQueued();
      return pending;
    },
  };
  const fixture = createTestRuntime({ gatewayClient, coordinator });
  const conversation = fixture.runtime.createConversation();
  const firstRun = fixture.runtime.runConversation(conversation.id, {
    requestId: "queue-owner-request",
    clientMessageId: "queue-owner-message",
    message: "占用会话队列",
  });
  let secondRun;
  try {
    await firstGenerationStarted;
    const controller = new AbortController();
    secondRun = fixture.runtime.runConversation(
      conversation.id,
      {
        requestId: "queue-cancelled-request",
        clientMessageId: "queue-cancelled-message",
        message: "排队后取消",
      },
      { abortSignal: controller.signal },
    );
    await secondQueued;
    controller.abort(new DOMException("Queued request was cancelled", "AbortError"));
    let cancellationTimer;
    const cancellationDeadline = new Promise(
      /** 排队取消必须在前序 Run 释放前返回，否则用有界失败阻止测试永久挂起。 */
      (_resolve, reject) => {
        cancellationTimer = setTimeout(
          /** 把未及时结算转换为明确回归错误。 */
          () => reject(new Error("queued cancellation did not settle promptly")),
          250,
        );
      },
    );
    try {
      await assert.rejects(Promise.race([secondRun, cancellationDeadline]), isAbortError);
    } finally {
      clearTimeout(cancellationTimer);
    }
    assert.equal(fixture.store.findRunByRequestId(conversation.id, "queue-cancelled-request"), null);
    releaseFirstGeneration();

    await firstRun;
    assert.equal(generationCalls, 1);
    assert.equal(fixture.store.findRunByRequestId(conversation.id, "queue-cancelled-request"), null);
    assert.equal(fixture.runtime.getConversation(conversation.id).messages.length, 2);
  } finally {
    releaseFirstGeneration();
    await Promise.allSettled([firstRun, secondRun].filter(Boolean));
    fixture.store.close();
  }
}

test("cancelling while queued creates no second Run", testQueuedCancellationStaysUnpersisted);

/** 验证三种恢复动作继承来源 operation，并且显式恢复不会再次调用智能分类器。 */
async function testRecoveryOperationsBypassIntentRouting() {
  let routingCalls = 0;
  const intentRouter = {
    /** 记录任何意外分类调用；显式恢复路径不应进入这里。 */
    async resolve() {
      routingCalls += 1;
      throw new Error("Recovery must not call the intent router");
    },
  };
  const fixture = createTestRuntime({ intentRouter });
  const conversation = fixture.runtime.createConversation();

  /** 创建一个指定请求的普通对话来源 Run。 */
  function startSourceRun(requestId, clientMessageId) {
    return fixture.store.startRun({
      conversationId: conversation.id,
      requestId,
      clientMessageId,
      content: requestId,
      displayContent: requestId,
      operation: "conversation.chat",
      model: fixture.gatewayClient.model,
    }).run;
  }

  const completedSource = startSourceRun("source-completed-request", "source-completed-message");
  fixture.store.completeRun({
    runId: completedSource.id,
    content: "已完成",
    displayContent: "已完成",
    usage: null,
    contextManifest: null,
    model: fixture.gatewayClient.model,
    resilience: null,
  });
  const failedSource = startSourceRun("source-failed-request", "source-failed-message");
  fixture.store.failRun(failedSource.id, new Error("source failed"));
  const cancelledSource = startSourceRun("source-cancelled-request", "source-cancelled-message");
  fixture.store.cancelRun({
    conversationId: conversation.id,
    runId: cancelledSource.id,
    model: fixture.gatewayClient.model,
  });

  const recoveryCases = [
    { mode: "retry", sourceRunId: failedSource.id },
    { mode: "regenerate", sourceRunId: completedSource.id },
    { mode: "continue", sourceRunId: cancelledSource.id },
  ];
  for (const recovery of recoveryCases) {
    const requestId = `recovery-${recovery.mode}-request`;
    await fixture.runtime.runConversation(conversation.id, {
      operation: "conversation.chat",
      requestId,
      clientMessageId: `recovery-${recovery.mode}-message`,
      sourceRunId: recovery.sourceRunId,
      recoveryMode: recovery.mode,
      message: `${recovery.mode} source response`,
    });
    const recovered = fixture.store.findRunByRequestId(conversation.id, requestId).run;
    assert.equal(recovered.operation, "conversation.chat");
    assert.equal(recovered.sourceRunId, recovery.sourceRunId);
    assert.equal(recovered.recoveryMode, recovery.mode);
    assert.equal(recovered.status, "completed");
  }
  assert.equal(routingCalls, 0);
  fixture.store.close();
}

test("run recovery modes inherit operation without intent reclassification", testRecoveryOperationsBypassIntentRouting);

/** 判断 Runtime 是否保留含图对话所需的 vision 能力分类。 */
function matchesVisionCapabilityMismatch(error) {
  return error?.status === 400 &&
    error?.payload?.code === "model_capability_mismatch" &&
    error.payload.requiredCapability === "vision" &&
    error.payload.operation === "conversation.chat";
}

/** 判断 Runtime 是否保留图片生成所需的能力分类。 */
function matchesImageCapabilityMismatch(error) {
  return error?.status === 400 &&
    error?.payload?.code === "model_capability_mismatch" &&
    error.payload.requiredCapability === "imageGeneration" &&
    error.payload.operation === "image.generate";
}

// 验证标题和归档是独立会话事实，取消归档不会重新打开已关闭会话。
test("conversation workspace updates title and archive state without reopening closed sessions", async () => {
  const fixture = createTestRuntime();
  const conversation = fixture.runtime.createConversation();

  const renamed = fixture.runtime.updateConversation(conversation.id, { title: "渠道体验验收" });
  assert.equal(renamed.title, "渠道体验验收");
  const archived = fixture.runtime.updateConversation(conversation.id, { archived: true });
  assert.ok(archived.archivedAt);
  await fixture.runtime.closeConversation(conversation.id);
  const restored = fixture.runtime.updateConversation(conversation.id, { archived: false });
  assert.equal(restored.archivedAt, null);
  assert.equal(restored.status, "closed");
  fixture.store.close();
});

// 验证重新生成创建带来源关系的新 Run，并拒绝与来源状态不匹配的恢复模式。
test("run recovery persists lineage and validates the source terminal state", async () => {
  const fixture = createTestRuntime();
  const conversation = fixture.runtime.createConversation();
  await run(fixture.runtime, conversation.id, 1, "原问题");
  const sourceRun = fixture.runtime.getConversation(conversation.id).latestRun;

  await assert.rejects(
    fixture.runtime.runConversation(conversation.id, {
      operation: "image.generate",
      requestId: "request-operation-tamper",
      clientMessageId: "client-operation-tamper",
      sourceRunId: sourceRun.id,
      recoveryMode: "regenerate",
      message: "把来源对话篡改成图片生成",
    }),
    isInvalidRunRecoverySource,
  );

  await fixture.runtime.runConversation(conversation.id, {
    requestId: "request-regenerate",
    clientMessageId: "client-regenerate",
    sourceRunId: sourceRun.id,
    recoveryMode: "regenerate",
    message: "原问题",
    imageUrls: [],
    documentUrls: [],
  });
  const recoveredRun = fixture.runtime.getConversation(conversation.id).latestRun;
  assert.equal(recoveredRun.sourceRunId, sourceRun.id);
  assert.equal(recoveredRun.recoveryMode, "regenerate");
  assert.notEqual(recoveredRun.requestId, sourceRun.requestId);

  await assert.rejects(
    fixture.runtime.runConversation(conversation.id, {
      requestId: "request-invalid-retry",
      clientMessageId: "client-invalid-retry",
      sourceRunId: recoveredRun.id,
      recoveryMode: "retry",
      message: "原问题",
      imageUrls: [],
      documentUrls: [],
    }),
    isInvalidRunRecoverySource,
  );
  fixture.store.close();
});

// 验证模型最终失败时保留用户消息，并把失败尝试证据写回原 Run。
test("failed runs persist model retry evidence without duplicate messages", async () => {
  const fixture = createTestRuntime({ gatewayClient: createRetryTraceGateway({ fail: true }) });
  const conversation = fixture.runtime.createConversation();

  await assert.rejects(run(fixture.runtime, conversation.id, 1, "验证失败证据"), isScriptedModelFailure);
  const detail = fixture.runtime.getConversation(conversation.id);
  assert.equal(detail.lastRun, null);
  assert.equal(detail.latestRun.status, "failed");
  assert.equal(detail.latestRun.resilience.attemptCount, 3);
  assert.equal(detail.latestRun.error, "模型服务暂时不可用");
  assert.equal(detail.latestRun.model, "retry-trace-model");
  assert.equal(detail.messages.length, 1);
  fixture.store.close();
});

// 验证既有 SQLite runs 表在启动时增量增加韧性证据列。
test("conversation store migrates retry evidence column for existing databases", () => {
  const temporaryDirectory = mkdtempSync(join(tmpdir(), "ai-platform-resilience-"));
  const databasePath = join(temporaryDirectory, "legacy.sqlite");
  let hasResilienceColumn = false;
  try {
    const legacyDatabase = new DatabaseSync(databasePath);
    legacyDatabase.exec("CREATE TABLE runs (id TEXT PRIMARY KEY)");
    legacyDatabase.close();

    const store = createConversationStore({ databasePath });
    store.close();
    const migratedDatabase = new DatabaseSync(databasePath);
    const columns = migratedDatabase.prepare("PRAGMA table_info(runs)").all();
    for (const column of columns) {
      if (column.name === "resilience_json") hasResilienceColumn = true;
    }
    assert.ok(columns.some(isSourceRunColumn));
    assert.ok(columns.some(isRecoveryModeColumn));
    migratedDatabase.close();
  } finally {
    rmSync(temporaryDirectory, { recursive: true, force: true });
  }
  assert.equal(hasResilienceColumn, true);
});

// 验证旧版完整 Run/Message 关系升级后保留外键，并允许 cancelled 状态与结构化引用。
test("conversation store migrates cancellation and references without breaking message run links", () => {
  const temporaryDirectory = mkdtempSync(join(tmpdir(), "ai-platform-cancel-migration-"));
  const databasePath = join(temporaryDirectory, "legacy.sqlite");
  try {
    const legacyDatabase = new DatabaseSync(databasePath);
    legacyDatabase.exec(`
      PRAGMA foreign_keys = ON;
      CREATE TABLE conversations (
        id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, user_id TEXT NOT NULL, title TEXT NOT NULL,
        status TEXT NOT NULL CHECK(status IN ('active', 'closed')), version INTEGER NOT NULL,
        memory_version INTEGER NOT NULL, summarized_through_seq INTEGER NOT NULL, next_seq INTEGER NOT NULL,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE TABLE runs (
        id TEXT PRIMARY KEY,
        conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
        request_id TEXT NOT NULL, user_message_id TEXT, assistant_message_id TEXT,
        status TEXT NOT NULL CHECK(status IN ('running', 'completed', 'failed')),
        model TEXT, usage_json TEXT, context_manifest_json TEXT, error TEXT,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
        UNIQUE(conversation_id, request_id)
      );
      CREATE TABLE messages (
        id TEXT PRIMARY KEY,
        conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
        seq INTEGER NOT NULL, client_message_id TEXT,
        run_id TEXT REFERENCES runs(id) ON DELETE SET NULL,
        role TEXT NOT NULL CHECK(role IN ('user', 'assistant')),
        content_json TEXT NOT NULL, display_content TEXT NOT NULL, status TEXT NOT NULL,
        usage_json TEXT, created_at TEXT NOT NULL,
        UNIQUE(conversation_id, seq), UNIQUE(conversation_id, client_message_id)
      );
      INSERT INTO conversations VALUES (
        'legacy-conversation', 'local', 'local-user', '旧会话', 'active', 1, 0, 0, 2,
        '2026-07-29T00:00:00.000Z', '2026-07-29T00:00:00.000Z'
      );
      INSERT INTO runs VALUES (
        'legacy-run', 'legacy-conversation', 'legacy-request', 'legacy-user', 'legacy-assistant',
        'completed', 'legacy-model', NULL, NULL, NULL,
        '2026-07-29T00:00:00.000Z', '2026-07-29T00:00:00.000Z'
      );
      INSERT INTO messages VALUES (
        'legacy-user', 'legacy-conversation', 1, 'legacy-client', 'legacy-run', 'user',
        '"旧问题"', '旧问题', 'committed', NULL, '2026-07-29T00:00:00.000Z'
      );
      INSERT INTO messages VALUES (
        'legacy-assistant', 'legacy-conversation', 2, NULL, 'legacy-run', 'assistant',
        '"旧回答"', '旧回答', 'committed', NULL, '2026-07-29T00:00:00.000Z'
      );
    `);
    legacyDatabase.close();

    const store = createConversationStore({ databasePath });
    const detail = store.getConversation("legacy-conversation");
    assert.deepEqual(detail.messages.map(getRunId), ["legacy-run", "legacy-run"]);
    assert.deepEqual(detail.messages.map(getReferences), [[], []]);
    store.close();

    const migratedDatabase = new DatabaseSync(databasePath);
    const runSql = migratedDatabase.prepare("SELECT sql FROM sqlite_master WHERE name = 'runs'").get().sql;
    const foreignKeyViolations = migratedDatabase.prepare("PRAGMA foreign_key_check").all();
    assert.match(runSql, /cancelled/);
    assert.deepEqual(foreignKeyViolations, []);
    migratedDatabase.close();
  } finally {
    rmSync(temporaryDirectory, { recursive: true, force: true });
  }
});

// 验证直接消息引用由服务端解析并写入 Manifest，渠道伪造正文不会进入模型上下文。
test("conversation message references use server facts and reject invalid sources", async () => {
  const gatewayClient = createCapturingGateway();
  const fixture = createTestRuntime({ gatewayClient });
  const conversation = fixture.runtime.createConversation();
  const otherConversation = fixture.runtime.createConversation();
  await run(fixture.runtime, conversation.id, 1, "服务端原始事实");
  await run(fixture.runtime, otherConversation.id, 1, "其他会话事实");
  const sourceMessages = fixture.runtime.getConversation(conversation.id).messages;
  const foreignMessage = fixture.runtime.getConversation(otherConversation.id).messages[0];

  const response = await fixture.runtime.runConversation(conversation.id, {
    requestId: "reference-request",
    clientMessageId: "reference-client",
    message: "基于引用回答",
    references: [
      { type: "conversation_message", messageId: sourceMessages[0].id, content: "渠道伪造正文" },
      { type: "conversation_message", messageId: sourceMessages[1].id },
    ],
  });
  const modelMessages = gatewayClient.requests.at(-1);
  const modelText = modelMessages.map(getMessageContent).join("\n");
  const persisted = fixture.runtime.getConversation(conversation.id).messages.at(-2);

  assert.match(modelText, /服务端原始事实/);
  assert.match(modelText, /测试回复/);
  assert.doesNotMatch(modelText, /渠道伪造正文/);
  assert.deepEqual(response.context.selected.referenceMessageIds, sourceMessages.map(getMessageId));
  assert.deepEqual(persisted.references, sourceMessages.map(toConversationMessageReference));
  await assert.rejects(
    fixture.runtime.runConversation(conversation.id, {
      requestId: "foreign-reference-request",
      clientMessageId: "foreign-reference-client",
      message: "跨会话引用",
      references: [{ type: "conversation_message", messageId: foreignMessage.id }],
    }),
    isInvalidMessageReference,
  );
  await assert.rejects(
    fixture.runtime.runConversation(conversation.id, {
      requestId: "unknown-reference-request",
      clientMessageId: "unknown-reference-client",
      message: "未知引用",
      references: [{ type: "document_chunk", messageId: sourceMessages[0].id }],
    }),
    isUnsupportedReferenceType,
  );
  fixture.store.close();
});

// 验证首个文本增量前取消不会创建空助手消息，且重复取消保持幂等。
test("cancelling before the first delta persists no assistant message", async () => {
  const controlled = createCancellableGateway();
  const fixture = createTestRuntime({ gatewayClient: controlled.gatewayClient });
  const conversation = fixture.runtime.createConversation();
  let runId = null;
  const runPromise = fixture.runtime.runConversation(
    conversation.id,
    { requestId: "cancel-empty-request", clientMessageId: "cancel-empty-client", message: "立即停止" },
    createCollectingExecution(
      /** 保存可供取消端点使用的 Run ID。 */
      (event) => {
        runId = event.runId;
      },
      { types: ["run.started"] },
    ),
  );
  await controlled.waitUntilGenerating;
  const firstCancellation = fixture.runtime.cancelConversationRun(conversation.id, runId);
  const result = await runPromise;
  const repeatedCancellation = fixture.runtime.cancelConversationRun(conversation.id, runId);
  const detail = fixture.runtime.getConversation(conversation.id);

  assert.equal(firstCancellation.run.status, "cancelled");
  assert.equal(result.cancelled, true);
  assert.equal(repeatedCancellation.run.status, "cancelled");
  assert.equal(controlled.getCallCount(), 1);
  assert.equal(detail.messages.length, 1);
  assert.equal(detail.latestRun.status, "cancelled");
  fixture.store.close();
});

// 验证调用方信号在 Run 已开始后仍由 Runtime 完成取消落库，而不是让协调器提前返回裸 AbortError。
test("caller cancellation after Run start waits for persisted cancellation", async () => {
  const controlled = createCancellableGateway();
  const fixture = createTestRuntime({ gatewayClient: controlled.gatewayClient });
  const conversation = fixture.runtime.createConversation();
  const controller = new AbortController();
  const execution = {
    ...createCollectingExecution(
      /** 当前测试只需要消费 Run 身份事件，取消由调用方信号触发。 */
      () => {},
      { types: ["run.started"] },
    ),
    abortSignal: controller.signal,
  };
  const runPromise = fixture.runtime.runConversation(
    conversation.id,
    { requestId: "caller-cancel-request", clientMessageId: "caller-cancel-message", message: "调用方停止" },
    execution,
  );

  await controlled.waitUntilGenerating;
  controller.abort(new DOMException("Caller cancelled active Run", "AbortError"));
  const result = await runPromise;
  const detail = fixture.runtime.getConversation(conversation.id);

  assert.equal(result.cancelled, true);
  assert.equal(detail.latestRun.status, "cancelled");
  assert.equal(detail.messages.length, 1);
  fixture.store.close();
});

// 验证增量后取消只落一条 interrupted 消息，默认排除但显式引用时进入上下文。
test("cancelling after a delta persists one explicitly referenceable interrupted message", async () => {
  const controlled = createCancellableGateway({ partialText: "部分回答" });
  const fixture = createTestRuntime({ gatewayClient: controlled.gatewayClient });
  const conversation = fixture.runtime.createConversation();
  let runId = null;
  const runPromise = fixture.runtime.runConversation(
    conversation.id,
    { requestId: "cancel-partial-request", clientMessageId: "cancel-partial-client", message: "生成后停止" },
    createCollectingExecution(
      /** 保存 Run ID，并消费文本增量以模拟 SSE 渠道。 */
      (event) => {
        if (event.type === "run.started") runId = event.runId;
      },
      { types: ["run.started", "text.delta"], streamText: true },
    ),
  );
  await controlled.waitUntilDelta;
  fixture.runtime.cancelConversationRun(conversation.id, runId);
  await runPromise;
  const interrupted = fixture.runtime.getConversation(conversation.id).messages.at(-1);

  await run(fixture.runtime, conversation.id, 2, "普通后续问题");
  const ordinaryContext = controlled.requests.at(-1).map(getMessageContent).join("\n");
  assert.doesNotMatch(ordinaryContext, /部分回答/);

  const referenced = await fixture.runtime.runConversation(conversation.id, {
    requestId: "reference-interrupted-request",
    clientMessageId: "reference-interrupted-client",
    message: "引用中断回答",
    references: [{ type: "conversation_message", messageId: interrupted.id }],
  });
  const referencedContext = controlled.requests.at(-1).map(getMessageContent).join("\n");
  const detail = fixture.runtime.getConversation(conversation.id);

  assert.equal(interrupted.status, "interrupted");
  assert.equal(interrupted.displayContent, "部分回答");
  assert.match(referencedContext, /role=assistant\/interrupted/);
  assert.match(referencedContext, /部分回答/);
  assert.deepEqual(referenced.context.selected.referenceMessageIds, [interrupted.id]);
  assert.equal(detail.messages.filter(isInterruptedMessage).length, 1);
  fixture.store.close();
});

// 验证用户纠正会废弃旧事实，Context Planner 只发送 active 最新值。
test("structured memory keeps the latest corrected fact", async () => {
  const fixture = createTestRuntime();
  const conversation = fixture.runtime.createConversation();
  await run(fixture.runtime, conversation.id, 1, "当前项目数据库使用 MySQL");
  await fixture.memoryManager.compactIfNeeded(conversation.id, { force: true });
  await run(fixture.runtime, conversation.id, 2, "更正：当前项目最终使用 PostgreSQL，因为需要 pgvector");
  await fixture.memoryManager.compactIfNeeded(conversation.id, { force: true });

  const detail = fixture.runtime.getConversation(conversation.id);
  const activeDatabase = detail.memory.items.find(isActiveCurrentDatabase);
  const supersededMysql = detail.memory.items.find(isSupersededMysql);
  assert.equal(activeDatabase.value, "PostgreSQL");
  assert.equal(activeDatabase.reason, "需要 pgvector");
  assert.ok(supersededMysql);
  assert.equal(detail.memoryCount, 2);
  fixture.store.close();
});

// 验证旧 memoryVersion 无法覆盖已提交的新记忆版本。
test("memory compare-and-set rejects stale compaction", async () => {
  const fixture = createTestRuntime();
  const conversation = fixture.runtime.createConversation();
  await run(fixture.runtime, conversation.id, 1, "当前项目数据库使用 MySQL");
  const first = await fixture.memoryManager.compactIfNeeded(conversation.id, { force: true });
  const stale = fixture.store.applyMemoryDelta({
    conversationId: conversation.id,
    expectedVersion: 0,
    expectedThroughSeq: 0,
    nextThroughSeq: 2,
    delta: { upserts: [], supersedes: [], episode: null },
    usage: null,
    model: "stale",
    promptVersion: "stale",
  });
  assert.equal(first.status, "compacted");
  assert.equal(stale.applied, false);
  fixture.store.close();
});

// 验证高低水位选择连续旧轮次并保留最近上下文。
test("compaction range preserves a recent low-watermark window", () => {
  const messages = [
    { role: "user", content: "a".repeat(80) },
    { role: "assistant", content: "b".repeat(80) },
    { role: "user", content: "c".repeat(80) },
    { role: "assistant", content: "d".repeat(80) },
  ];
  const selected = selectCompactionRange(messages, 90);
  assert.equal(selected.length, 2);
});

// 验证结束会话后新 Run 在存储边界被拒绝。
test("closed conversations reject new runs", async () => {
  const fixture = createTestRuntime();
  const conversation = fixture.runtime.createConversation();
  await run(fixture.runtime, conversation.id, 1, "当前项目数据库使用 MySQL");
  const closed = await fixture.runtime.closeConversation(conversation.id);
  assert.equal(closed.conversation.memoryCount, 1);
  await assert.rejects(
    run(fixture.runtime, conversation.id, 2, "结束后消息"),
    isConversationClosedError,
  );
  fixture.store.close();
});

// 验证唯一 Gateway Client 可构造，并保持 Runtime 依赖的稳定字段。
test("gateway client remains constructible", () => {
  const client = createGatewayClient({ baseUrl: "http://localhost:4000", model: "chat-default", apiKey: "test" });
  assert.equal(client.model, "chat-default");
});
}

export { createScriptedGateway, createTestRuntime, run };

/** 判断是否为当前项目 active 数据库事实。 */
function isActiveCurrentDatabase(item) {
  return item.status === "active" && item.entity === "current-project" && item.key === "database";
}

/** 判断是否为已废弃的 MySQL 事实。 */
function isSupersededMysql(item) {
  return item.status === "superseded" && item.value === "MySQL";
}

/** 判断异常是否为关闭会话拒绝新 Run。 */
function isConversationClosedError(error) {
  return error instanceof ConversationStoreError && error.code === "conversation_closed";
}

/** 判断异常是否为恢复模式与来源 Run 状态不匹配。 */
function isInvalidRunRecoverySource(error) {
  return error instanceof ConversationStoreError && error.code === "invalid_run_recovery_source";
}

/** 判断迁移列是否为来源 Run ID。 */
function isSourceRunColumn(column) {
  return column.name === "source_run_id";
}

/** 判断迁移列是否为恢复模式。 */
function isRecoveryModeColumn(column) {
  return column.name === "recovery_mode";
}

/** 返回持久化消息角色，供顺序断言复用。 */
function getMessageRole(message) {
  return message.role;
}

/** 返回持久化消息展示内容，供顺序断言复用。 */
function getDisplayContent(message) {
  return message.displayContent;
}

/** 返回消息关联 Run ID，供迁移后外键关系断言使用。 */
function getRunId(message) {
  return message.runId;
}

/** 返回消息结构化引用，供迁移和持久化断言使用。 */
function getReferences(message) {
  return message.references;
}

/** 返回消息稳定 ID。 */
function getMessageId(message) {
  return message.id;
}

/** 将消息映射为当前 C1 稳定引用对象。 */
function toConversationMessageReference(message) {
  return { type: "conversation_message", messageId: message.id };
}

/** 判断错误是否为跨会话或不存在的消息引用。 */
function isInvalidMessageReference(error) {
  return error instanceof ConversationStoreError && error.code === "invalid_message_reference";
}

/** 判断错误是否为当前契约尚未开放的引用类型。 */
function isUnsupportedReferenceType(error) {
  return error?.payload?.code === "unsupported_reference_type";
}

/** 判断消息是否为取消后保存的中断助手消息。 */
function isInterruptedMessage(message) {
  return message.status === "interrupted";
}

/** 创建记录每次模型上下文的确定性 Gateway。 */
function createCapturingGateway() {
  const requests = [];
  return {
    model: "capturing-test-model",
    requests,
    /** 返回固定 token 数，避免引用测试依赖真实管理端点。 */
    async countTokens() {
      return { tokens: 10, source: "scripted", model: this.model };
    },
    /** 记录服务端构造的模型消息并返回固定回复。 */
    async chatCompletions({ messages }) {
      requests.push(messages);
      return {
        model: this.model,
        usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 },
        choices: [{ message: { content: "测试回复" } }],
      };
    },
  };
}

/** 创建首个调用可由 AbortSignal 终止、后续调用正常完成的脚本化 Gateway。 */
function createCancellableGateway({ partialText = "" } = {}) {
  const requests = [];
  let callCount = 0;
  let resolveGenerating;
  let resolveDelta;
  // Promise executor 暴露首次模型调用开始事实。
  const waitUntilGenerating = new Promise((resolve) => {
    resolveGenerating = resolve;
  });
  // Promise executor 暴露首个文本增量已经交付的事实。
  const waitUntilDelta = new Promise((resolve) => {
    resolveDelta = resolve;
  });
  const gatewayClient = {
    model: "cancellable-test-model",
    /** 返回固定 token 数，避免取消测试依赖真实管理端点。 */
    async countTokens() {
      return { tokens: 10, source: "scripted", model: this.model };
    },
    /** 首次调用等待取消，之后记录上下文并返回固定回复。 */
    async chatCompletions({ messages, onTextDelta, abortSignal }) {
      callCount += 1;
      requests.push(messages);
      if (callCount > 1) {
        return {
          model: this.model,
          usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 },
          choices: [{ message: { content: "取消后的正常回复" } }],
        };
      }
      resolveGenerating();
      if (partialText && typeof onTextDelta === "function") await onTextDelta(partialText);
      resolveDelta();
      await waitForAbort(abortSignal);
      throw abortSignal.reason || new DOMException("Run was aborted", "AbortError");
    },
  };
  return {
    gatewayClient,
    requests,
    waitUntilGenerating,
    waitUntilDelta,
    /** 返回实际模型调用次数，验证取消未触发自动重试。 */
    getCallCount() {
      return callCount;
    },
  };
}

/** 等待 AbortSignal 终止；已取消信号立即返回。 */
function waitForAbort(signal) {
  if (signal.aborted) return Promise.resolve();
  // Promise executor 把一次 AbortSignal 事件桥接为测试等待结果。
  return new Promise((resolve) => {
    /** 收到一次取消后结束测试等待。 */
    function handleAbort() {
      resolve();
    }
    signal.addEventListener("abort", handleAbort, { once: true });
  });
}

/** 只接受标准 AbortError，避免把普通 Runtime 失败误判为取消。 */
function isAbortError(error) {
  return error?.name === "AbortError";
}

/** 创建返回成功或最终失败重试证据的脚本化 Gateway。 */
function createRetryTraceGateway({ fail = false } = {}) {
  const resilience = buildRetryTraceFixture(fail ? "failed" : "completed");
  return {
    model: "retry-trace-model",
    /** 返回固定 token 数，避免测试依赖真实管理端点。 */
    async countTokens() {
      return { tokens: 10, source: "scripted", model: this.model };
    },
    /** 返回或抛出携带同一 Run 尝试证据的模型结果。 */
    async chatCompletions() {
      if (fail) {
        const error = new Error("scripted model failure");
        error.resilience = resilience;
        throw error;
      }
      return {
        model: this.model,
        usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 },
        choices: [{ message: { content: "重试后成功" } }],
        resilience,
      };
    },
  };
}

/** 创建记录 Context Planner 与 generation 模型别名的脚本化 Gateway。 */
function createModelSelectionGateway(observations) {
  return {
    model: "chat-default",
    /** 记录当前 Run 传给 token counter 的模型别名。 */
    async countTokens({ model }) {
      observations.push(`count:${model}`);
      return { tokens: 10, source: "scripted", model };
    },
    /** 记录当前 Run 传给生成调用的模型别名并返回同一模型事实。 */
    async chatCompletions({ model }) {
      observations.push(`generate:${model}`);
      return {
        model,
        usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 },
        choices: [{ message: { content: "模型选择已生效" } }],
      };
    },
  };
}

/** 创建逐段回调并返回单个完整结果的脚本化流式 Gateway。 */
function createStreamingGateway() {
  return {
    model: "streaming-test-model",
    /** 返回固定 token 数，避免测试依赖真实管理端点。 */
    async countTokens() {
      return { tokens: 10, source: "scripted", model: this.model };
    },
    /** 向 Runtime 交付两个文本增量，随后返回完整 completion。 */
    async chatCompletions({ onTextDelta }) {
      await onTextDelta("逐段");
      await onTextDelta("回复");
      return {
        model: this.model,
        usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 },
        choices: [{ message: { content: "逐段回复" } }],
        resilience: {
          operation: "model.generate",
          maxAttempts: 3,
          attemptCount: 1,
          outputStarted: true,
          attempts: [{ attempt: 1, status: "completed", retryable: false, willRetry: false }],
        },
      };
    },
  };
}

/** 构造不含业务正文的成功或失败模型尝试证据。 */
function buildRetryTraceFixture(finalStatus) {
  const attempts = [
    {
      attempt: 1,
      status: "failed",
      errorType: "provider_unavailable",
      statusCode: 503,
      retryable: true,
      willRetry: true,
      backoffMs: 500,
      stopReason: "retrying",
    },
  ];
  if (finalStatus === "completed") {
    attempts.push({
      attempt: 2,
      status: "completed",
      errorType: null,
      statusCode: null,
      retryable: false,
      willRetry: false,
      backoffMs: 0,
      stopReason: "completed",
    });
  } else {
    attempts.push(
      {
        attempt: 2,
        status: "failed",
        errorType: "provider_unavailable",
        statusCode: 503,
        retryable: true,
        willRetry: true,
        backoffMs: 1000,
        stopReason: "retrying",
      },
      {
        attempt: 3,
        status: "failed",
        errorType: "provider_unavailable",
        statusCode: 503,
        retryable: true,
        willRetry: false,
        backoffMs: 0,
        stopReason: "max-attempts",
      },
    );
  }
  return {
    operation: "model.generate",
    maxAttempts: 3,
    attemptCount: attempts.length,
    outputStarted: false,
    attempts,
  };
}

/** 判断异常是否为脚本化模型最终失败。 */
function isScriptedModelFailure(error) {
  return error?.message === "模型服务暂时不可用" && error?.payload?.code === "model_provider_unavailable";
}

/** 判断异常是否为系统结果验收拒绝，而不是普通模型或 Connector 失败。 */
function isAcceptanceRejection(error) {
  return error?.payload?.code === "result_acceptance_rejected";
}
