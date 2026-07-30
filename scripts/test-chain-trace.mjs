#!/usr/bin/env node
import assert from "node:assert/strict";
import test from "node:test";
import {
  BasicTracerProvider,
  BatchSpanProcessor,
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from "@opentelemetry/sdk-trace-base";
import { parseOtlpHeaders } from "../src/config/env.mjs";
import { createGatewayClient } from "../src/gateway/gateway-client.mjs";
import { createChainTracer } from "../src/observability/chain-tracer.mjs";
import { initializeOpenTelemetry } from "../src/observability/otel-runtime.mjs";
import { createTestRuntime } from "./test-runtime.mjs";
import { PocFanoutSpanExporter } from "./run-chain-trace-backend-poc.mjs";

const SENSITIVE_PROMPT = "prompt-secret-chain-trace";
const SENSITIVE_ANSWER = "answer-secret-chain-trace";
const SENSITIVE_IMAGE = "data:image/png;base64,c2VjcmV0LWltYWdl";
const SENSITIVE_DOCUMENT = "https://documents.example.test/private-chain-trace";
const SENSITIVE_ERROR = "provider-raw-secret-chain-trace";
const spanExporter = new InMemorySpanExporter();
const spanProcessor = new SimpleSpanProcessor(spanExporter);
const telemetryRuntime = initializeOpenTelemetry(
  {
    enabled: true,
    serviceName: "ai-platform-chain-trace-test",
    samplingRatio: 1,
  },
  { traceExporter: spanExporter, spanProcessor },
);
const chainTracer = telemetryRuntime.chainTracer;

test.after(shutdownTelemetry);

/** 所有测试完成后刷新并关闭全局 OTel Provider。 */
async function shutdownTelemetry() {
  await telemetryRuntime.shutdown();
}

/** 验证 JSON/SSE 共享 C1 Span 语义、业务关联字段和内部 Token 分段。 */
async function testJsonAndSseTraceShape() {
  spanExporter.reset();
  const gatewayClient = createObservedGateway({ handleChatRequest: createSuccessfulChatHandler() });
  const fixture = createTestRuntime({ gatewayClient, chainTracer });
  try {
    const jsonConversation = fixture.runtime.createConversation();
    const sseConversation = fixture.runtime.createConversation();
    const jsonRun = await observeRun(fixture.runtime, jsonConversation.id, createRunBody("json"), "json");
    const sseRun = await observeRun(fixture.runtime, sseConversation.id, createRunBody("sse"), "sse");
    await telemetryRuntime.forceFlush();
    const spans = spanExporter.getFinishedSpans();

    assert.equal(jsonRun.result.content, SENSITIVE_ANSWER);
    assert.deepEqual(sseRun.deltas, ["answer-secret-", "chain-trace"]);
    assertTraceContainsStages(spans, "json", jsonRun.runId);
    assertTraceContainsStages(spans, "sse", sseRun.runId);
    assertBusinessLookupAttributes(spans, jsonRun);
    assertTokenSegments(spans, jsonRun.otelTraceId);
    assertSensitiveValuesAbsent(spans);
  } finally {
    fixture.store.close();
  }
}

test("C1 JSON and SSE runs export one searchable redacted trace", testJsonAndSseTraceShape);

/** 验证平台重试产生多个 AI SDK 模型 Span，但始终归属于同一个 C1 根 Trace。 */
async function testRetryKeepsOneRootTrace() {
  spanExporter.reset();
  let attempts = 0;
  /** 首次返回可重试 503，第二次返回成功结果。 */
  function handleRetryRequest(request) {
    attempts += 1;
    if (attempts === 1) return jsonResponse({ error: { message: "temporary" } }, 503);
    return successfulChatResponse(request);
  }
  const gatewayClient = createObservedGateway({ handleChatRequest: handleRetryRequest, maxAttempts: 2 });
  const fixture = createTestRuntime({ gatewayClient, chainTracer });
  try {
    const conversation = fixture.runtime.createConversation();
    const observed = await observeRun(fixture.runtime, conversation.id, createRunBody("retry"), "json");
    await telemetryRuntime.forceFlush();
    const traceSpans = spansForTrace(spanExporter.getFinishedSpans(), observed.otelTraceId);
    const modelCalls = traceSpans.filter(isInvokeAgentSpan);

    assert.equal(attempts, 2);
    assert.equal(modelCalls.length, 2);
    assert.deepEqual(modelCalls.map(readModelAttempt).sort(), [1, 2]);
    assert.equal(new Set(modelCalls.map(readTraceId)).size, 1);
    assert.equal(observed.result.resilience.attemptCount, 2);
  } finally {
    fixture.store.close();
  }
}

test("model retries remain children of one C1 root trace", testRetryKeepsOneRootTrace);

/** 验证官方 AI SDK OTel 错误事件经过适配后不包含上游原始响应正文。 */
async function testFailedTraceRedactsProviderError() {
  spanExporter.reset();
  /** 始终返回包含敏感原始消息的服务端错误。 */
  function handleFailureRequest() {
    return jsonResponse({ error: { message: SENSITIVE_ERROR } }, 503);
  }
  const gatewayClient = createObservedGateway({ handleChatRequest: handleFailureRequest, maxAttempts: 1 });
  const fixture = createTestRuntime({ gatewayClient, chainTracer });
  try {
    const conversation = fixture.runtime.createConversation();
    await assert.rejects(
      observeRun(fixture.runtime, conversation.id, createRunBody("failed"), "json"),
      isGatewayFailure,
    );
    await telemetryRuntime.forceFlush();
    const spans = spanExporter.getFinishedSpans();

    assert.equal(spans.some(isFailedRootSpan), true);
    assertSensitiveValuesAbsent(spans);
    assert.equal(JSON.stringify(spans.map(toInspectableSpan)).includes(SENSITIVE_ERROR), false);
  } finally {
    fixture.store.close();
  }
}

test("failed model traces redact provider error bodies", testFailedTraceRedactsProviderError);

/** 验证幂等重放产生可检索根 Trace，但不会再次创建 AI SDK 模型调用。 */
async function testIdempotentReplaySkipsModelSpan() {
  spanExporter.reset();
  let attempts = 0;
  /** 记录实际模型调用次数并返回成功结果。 */
  function handleCountedRequest(request) {
    attempts += 1;
    return successfulChatResponse(request);
  }
  const gatewayClient = createObservedGateway({ handleChatRequest: handleCountedRequest });
  const fixture = createTestRuntime({ gatewayClient, chainTracer });
  try {
    const conversation = fixture.runtime.createConversation();
    const body = createRunBody("replay");
    const first = await observeRun(fixture.runtime, conversation.id, body, "json");
    const replay = await observeRun(fixture.runtime, conversation.id, body, "json");
    await telemetryRuntime.forceFlush();
    const replaySpans = spansForTrace(spanExporter.getFinishedSpans(), replay.otelTraceId);
    const replayRoot = replaySpans.find(isRootSpan);

    assert.equal(attempts, 1);
    assert.equal(first.result.replayed, false);
    assert.equal(replay.result.replayed, true);
    assert.equal(replayRoot.attributes["ai.platform.run.replayed"], true);
    assert.equal(replayRoot.attributes["ai.platform.chain_trace_id"], first.result.resilience.traceId);
    assert.equal(replaySpans.some(isInvokeAgentSpan), false);
  } finally {
    fixture.store.close();
  }
}

test("idempotent replay is traced without a second model call", testIdempotentReplaySkipsModelSpan);

/** 验证正式 OTLP protobuf Adapter 接收标准认证 header、Trace endpoint 和导出超时。 */
async function testFormalExporterConfiguration() {
  let exporterConfiguration = null;
  let sdkConfiguration = null;
  const exporter = createRecordingExporter();
  const processor = new SimpleSpanProcessor(exporter);

  /** 捕获正式 exporter 构造参数，同时避免测试发起网络请求。 */
  function createCapturedExporter(configuration) {
    exporterConfiguration = configuration;
    return exporter;
  }

  /** 捕获 NodeSDK 配置，但不替换当前测试文件已经注册的全局 Provider。 */
  function createCapturedNodeSdk(configuration) {
    sdkConfiguration = configuration;
    return {
      /** 测试生命周期不需要注册第二个全局 Provider。 */
      start() {},
      /** 测试 SDK 没有额外资源需要释放。 */
      async shutdown() {},
    };
  }

  const runtime = initializeOpenTelemetry(
    {
      enabled: true,
      endpoint: "http://phoenix.test:6006",
      headers: parseOtlpHeaders("authorization=Bearer%20system-key,x-scope=c1%2Ctrace"),
      timeoutMillis: 4321,
      serviceName: "ai-platform-chaintrace-formal-test",
      samplingRatio: 0.25,
    },
    {
      spanProcessor: processor,
      createTraceExporter: createCapturedExporter,
      createNodeSdk: createCapturedNodeSdk,
    },
  );

  try {
    assert.deepEqual(exporterConfiguration, {
      url: "http://phoenix.test:6006/v1/traces",
      headers: { authorization: "Bearer system-key", "x-scope": "c1,trace" },
      timeoutMillis: 4321,
    });
    assert.equal(sdkConfiguration.resource.attributes["service.name"], "ai-platform-chaintrace-formal-test");
    assert.equal(sdkConfiguration.spanProcessors[0], processor);
  } finally {
    await runtime.shutdown();
  }
}

test("formal OTLP exporter receives protobuf endpoint and server-side auth configuration", testFormalExporterConfiguration);

/** 验证异步 OTLP 导出失败只影响旁路刷新，不改写已经完成的业务 Run。 */
async function testExporterFailureDoesNotChangeRun() {
  let exportAttempts = 0;
  const failingExporter = {
    /** 明确返回导出失败，模拟超时、认证拒绝或 Phoenix 不可用。 */
    export(_spans, resultCallback) {
      exportAttempts += 1;
      resultCallback({ code: 1, error: new Error("test exporter unavailable") });
    },
    /** 测试导出器没有外部资源需要释放。 */
    async shutdown() {},
  };
  const processor = new BatchSpanProcessor(failingExporter, {
    scheduledDelayMillis: 60000,
    exportTimeoutMillis: 1000,
  });
  const provider = new BasicTracerProvider({ spanProcessors: [processor] });
  const isolatedChainTracer = createChainTracer({ tracer: provider.getTracer("chaintrace-failure-isolation-test") });
  const gatewayClient = createObservedGateway({ handleChatRequest: createSuccessfulChatHandler() });
  const fixture = createTestRuntime({ gatewayClient, chainTracer: isolatedChainTracer });

  try {
    const conversation = fixture.runtime.createConversation();
    const result = await fixture.runtime.runConversation(conversation.id, createRunBody("export-failure"));

    assert.equal(result.content, SENSITIVE_ANSWER);
    await assert.rejects(provider.forceFlush(), /test exporter unavailable/);
    assert.equal(exportAttempts > 0, true);
    assert.equal(fixture.runtime.getConversation(conversation.id).latestRun.status, "completed");
  } finally {
    fixture.store.close();
    await provider.shutdown();
  }
}

test("OTLP exporter failure does not change completed Run semantics", testExporterFailureDoesNotChangeRun);

/** 验证双后端 PoC 不会为不同候选重新生成 Trace 或 Span 批次。 */
async function testPocFanoutSharesOneSpanBatch() {
  const langfuse = createRecordingExporter();
  const phoenix = createRecordingExporter();
  const exporter = new PocFanoutSpanExporter([
    { name: "langfuse", exporter: langfuse },
    { name: "phoenix", exporter: phoenix },
  ]);
  const spans = [{ name: "c1.conversation.run" }];
  let result = null;

  // 收集 Composite 的最终状态，验证两个子导出器成功后才整体成功。
  exporter.export(spans, (exportResult) => {
    result = exportResult;
  });

  assert.equal(result?.code, 0);
  assert.equal(langfuse.batches[0], spans);
  assert.equal(phoenix.batches[0], spans);
  assert.deepEqual(exporter.getSucceededBackends(), ["langfuse", "phoenix"]);
  await exporter.shutdown();
}

test("backend PoC fans out the same readable span batch", testPocFanoutSharesOneSpanBatch);

/** 创建同步成功并保留批次对象引用的最小 SpanExporter。 */
function createRecordingExporter() {
  return {
    batches: [],
    /** 保存原批次对象，供同一 Trace 断言使用。 */
    export(spans, resultCallback) {
      this.batches.push(spans);
      resultCallback({ code: 0 });
    },
    /** 测试导出器没有外部资源需要释放。 */
    async shutdown() {},
  };
}

/** 创建使用真实 AI SDK 调用路径和可编排 fake LiteLLM 的 GatewayClient。 */
function createObservedGateway({ handleChatRequest, maxAttempts = 3 }) {
  return createGatewayClient({
    baseUrl: "http://gateway.test",
    model: "chat-default",
    apiKey: "test-key",
    maxAttempts,
    retryBaseDelayMs: 0,
    retryMaxDelayMs: 0,
    fetchImplementation: createFakeFetch(handleChatRequest),
  });
}

/** 创建同时支持 JSON 和 SSE 的成功模型响应处理器。 */
function createSuccessfulChatHandler() {
  /** 根据 AI SDK 请求的 stream 标志返回对应协议。 */
  function handleSuccessfulRequest(request) {
    return successfulChatResponse(request);
  }
  return handleSuccessfulRequest;
}

/** 返回成功的 OpenAI-compatible JSON 或 SSE 模型响应。 */
function successfulChatResponse(request) {
  if (request.body.stream) return streamingChatResponse();
  return jsonResponse({
    id: "chatcmpl-chain-trace",
    object: "chat.completion",
    created: 1785200000,
    model: "observed-model",
    choices: [
      {
        index: 0,
        message: { role: "assistant", content: SENSITIVE_ANSWER },
        finish_reason: "stop",
      },
    ],
    usage: { prompt_tokens: 21, completion_tokens: 6, total_tokens: 27 },
  });
}

/** 返回包含两个文本增量和 usage 的 OpenAI-compatible SSE 响应。 */
function streamingChatResponse() {
  const chunks = [
    buildStreamChunk("answer-secret-", null),
    buildStreamChunk("chain-trace", null),
    buildStreamChunk("", "stop", { prompt_tokens: 21, completion_tokens: 6, total_tokens: 27 }),
    "data: [DONE]\n\n",
  ];
  return new Response(chunks.join(""), {
    status: 200,
    headers: { "Content-Type": "text/event-stream; charset=utf-8" },
  });
}

/** 构造单个 OpenAI-compatible 流式响应块。 */
function buildStreamChunk(content, finishReason, usage) {
  return `data: ${JSON.stringify({
    id: "chatcmpl-chain-trace-stream",
    object: "chat.completion.chunk",
    created: 1785200000,
    model: "observed-model",
    choices: [{ index: 0, delta: content ? { content } : {}, finish_reason: finishReason }],
    ...(usage ? { usage } : {}),
  })}\n\n`;
}

/** 创建处理 models、token counter 和 chat completions 的 fake fetch。 */
function createFakeFetch(handleChatRequest) {
  /** 解析请求并按 LiteLLM 端点返回固定或脚本化结果。 */
  async function fakeFetch(input, init = {}) {
    const request = await normalizeFetchRequest(input, init);
    if (request.url.endsWith("/v1/models")) return jsonResponse({ data: [{ id: "chat-default" }] });
    if (request.url.endsWith("/utils/token_counter")) {
      return jsonResponse({ total_tokens: 31, model: "observed-model" });
    }
    if (request.url.endsWith("/v1/chat/completions")) return handleChatRequest(request);
    return jsonResponse({ error: "not found" }, 404);
  }
  return fakeFetch;
}

/** 把 Request 或 fetch init 规范为测试处理器使用的 URL 和 JSON body。 */
async function normalizeFetchRequest(input, init) {
  const url = input instanceof Request ? input.url : String(input);
  const rawBody = input instanceof Request ? await input.clone().text() : String(init.body || "");
  return { url, body: rawBody ? JSON.parse(rawBody) : null };
}

/** 创建测试 Run 输入，并包含正文、图片和文档脱敏样例。 */
function createRunBody(suffix) {
  return {
    requestId: `trace-request-${suffix}`,
    clientMessageId: `trace-message-${suffix}`,
    message: SENSITIVE_PROMPT,
    imageUrls: [SENSITIVE_IMAGE],
    documentUrls: [SENSITIVE_DOCUMENT],
  };
}

/** 在测试根 Span 内执行 Runtime，并模拟 JSON/SSE 最终渠道交付。 */
async function observeRun(runtime, conversationId, body, transport) {
  let otelTraceId = null;
  let runId = null;
  let chainTraceId = null;
  const deltas = [];
  const result = await chainTracer.withSpan(
    "c1.conversation.run",
    {
      "ai.platform.request_id": body.requestId,
      "ai.platform.conversation_id": conversationId,
      "ai.platform.scenario_id": "C1",
      "ai.platform.channel.transport": transport,
    },
    /** 在测试根 Span 中组合 Runtime 回调和最终交付阶段。 */
    async (rootSpan) => {
      try {
        const runtimeResult = await runtime.runConversation(conversationId, body, {
          /** 记录业务 Chain ID。 */
          onChainTraceStarted(input) {
            chainTraceId = input.chainTraceId;
            rootSpan.setAttribute("ai.platform.chain_trace_id", chainTraceId);
          },
          /** 记录 Run ID、重放状态和最终业务 Chain ID。 */
          onRunStarted(input) {
            runId = input.run.id;
            chainTraceId = input.chainTraceId || chainTraceId;
            rootSpan.setAttributes({
              "ai.platform.run_id": runId,
              "ai.platform.chain_trace_id": chainTraceId,
              "ai.platform.run.replayed": input.replayed,
            });
          },
          /** 仅为 SSE 测试收集文本增量。 */
          onTextDelta: transport === "sse" ? collectDelta : undefined,
        });
        rootSpan.setAttributes({
          "ai.platform.run.status": "completed",
          "ai.platform.run.replayed": runtimeResult.replayed,
        });
        await chainTracer.withSpan(
          `channel.${transport}.delivery`,
          {
            "ai.platform.request_id": body.requestId,
            "ai.platform.conversation_id": conversationId,
            "ai.platform.run_id": runId,
            "ai.platform.chain_trace_id": chainTraceId,
            "ai.platform.run.status": "completed",
          },
          /** 模拟最终载荷已经交付，但不把载荷写入 Span。 */
          () => undefined,
        );
        return runtimeResult;
      } catch (error) {
        rootSpan.setAttribute("ai.platform.run.status", "failed");
        rootSpan.recordError(error);
        await chainTracer.withSpan(
          `channel.${transport}.delivery`,
          {
            "ai.platform.request_id": body.requestId,
            "ai.platform.conversation_id": conversationId,
            ...(runId ? { "ai.platform.run_id": runId } : {}),
            ...(chainTraceId ? { "ai.platform.chain_trace_id": chainTraceId } : {}),
            "ai.platform.run.status": "failed",
          },
          /** 模拟错误事件已经交付，但不记录原始异常正文。 */
          () => undefined,
        );
        throw error;
      }
    },
  );
  await telemetryRuntime.forceFlush();
  const roots = spanExporter.getFinishedSpans().filter(isRootSpan);
  const root = roots.at(-1);
  otelTraceId = readTraceId(root);
  return { result, deltas, runId, chainTraceId, otelTraceId, requestId: body.requestId, conversationId };

  /** 收集当前 SSE Run 的文本增量。 */
  function collectDelta(delta) {
    deltas.push(delta);
  }
}

/** 断言某个渠道 Trace 包含 C1 必需阶段和 AI SDK GenAI Span。 */
function assertTraceContainsStages(spans, transport, runId) {
  let root = null;
  for (const span of spans) {
    if (
      isRootSpan(span) &&
      span.attributes["ai.platform.channel.transport"] === transport &&
      span.attributes["ai.platform.run_id"] === runId
    ) {
      root = span;
    }
  }
  assert.ok(root);
  const names = spansForTrace(spans, readTraceId(root)).map(readSpanName);
  for (const name of [
    "runtime.queue",
    "storage.start_run",
    "runtime.context.plan",
    "storage.complete_run",
    `channel.${transport}.delivery`,
  ]) {
    assert.equal(names.includes(name), true, `missing span: ${name}`);
  }
  assert.equal(names.some(isInvokeAgentName), true);
  assert.equal(names.some(isChatName), true);
}

/** 断言 requestId、conversationId、runId 和业务 Chain ID 可直接检索。 */
function assertBusinessLookupAttributes(spans, observed) {
  const traceSpans = spansForTrace(spans, observed.otelTraceId);
  const searchableSpans = [
    traceSpans.find(isRootSpan),
    traceSpans.find(isContextPlanSpan),
    traceSpans.find(isInvokeAgentSpan),
  ];
  for (const span of searchableSpans) {
    assert.equal(span.attributes["ai.platform.request_id"], observed.requestId);
    assert.equal(span.attributes["ai.platform.conversation_id"], observed.conversationId);
    assert.equal(span.attributes["ai.platform.run_id"], observed.runId);
    assert.equal(span.attributes["ai.platform.chain_trace_id"], observed.result.resilience.traceId);
  }
}

/** 断言 Context Planner Span 暴露数值 Token 分段但不扩大公开 Manifest。 */
function assertTokenSegments(spans, traceId) {
  const contextSpan = spansForTrace(spans, traceId).find(isContextPlanSpan);
  for (const name of ["system", "current_input", "memory", "episodes", "history", "total_input"]) {
    assert.equal(Number.isFinite(contextSpan.attributes[`ai.platform.context.tokens.${name}`]), true);
  }
  assert.equal(Number.isFinite(contextSpan.attributes["ai.platform.context.tokens.counted_total_input"]), true);
}

/** 扫描所有 Span 名称、属性、状态和事件，确保敏感样例完全缺席。 */
function assertSensitiveValuesAbsent(spans) {
  const serialized = JSON.stringify(spans.map(toInspectableSpan));
  for (const value of [SENSITIVE_PROMPT, SENSITIVE_ANSWER, SENSITIVE_IMAGE, SENSITIVE_DOCUMENT, SENSITIVE_ERROR]) {
    assert.equal(serialized.includes(value), false, `sensitive trace value detected: ${value}`);
  }
}

/** 把 ReadableSpan 收窄为安全扫描所需字段。 */
function toInspectableSpan(span) {
  return {
    name: span.name,
    attributes: span.attributes,
    status: span.status,
    events: span.events.map(readInspectableEvent),
  };
}

/** 返回 Span event 的名称和属性供脱敏扫描。 */
function readInspectableEvent(event) {
  return { name: event.name, attributes: event.attributes };
}

/** 返回属于指定 OTel trace_id 的全部 Span。 */
function spansForTrace(spans, traceId) {
  const selected = [];
  for (const span of spans) {
    if (readTraceId(span) === traceId) selected.push(span);
  }
  return selected;
}

/** 判断 Span 是否为 C1 根 Span。 */
function isRootSpan(span) {
  return span.name === "c1.conversation.run";
}

/** 判断 Span 是否为 AI SDK 一次 generateText/streamText 调用根 Span。 */
function isInvokeAgentSpan(span) {
  return span.name.startsWith("invoke_agent ");
}

/** 判断 Span 是否为 Context Planner 阶段。 */
function isContextPlanSpan(span) {
  return span.name === "runtime.context.plan";
}

/** 判断名称是否属于 AI SDK generateText/streamText 根 Span。 */
function isInvokeAgentName(name) {
  return name.startsWith("invoke_agent ");
}

/** 判断名称是否属于 AI SDK 模型推理 Span。 */
function isChatName(name) {
  return name.startsWith("chat ");
}

/** 判断根 Span 是否记录了失败状态。 */
function isFailedRootSpan(span) {
  return isRootSpan(span) && span.attributes["ai.platform.run.status"] === "failed";
}

/** 返回模型 Span 的平台重试序号。 */
function readModelAttempt(span) {
  return span.attributes["ai.platform.model.attempt"];
}

/** 返回 Span 名称。 */
function readSpanName(span) {
  return span.name;
}

/** 返回 Span 的 OTel trace_id。 */
function readTraceId(span) {
  return span.spanContext().traceId;
}

/** 判断失败是否已经过 GatewayClient 稳定映射。 */
function isGatewayFailure(error) {
  return error?.status === 503;
}

/** 创建带 JSON content type 的标准 Response。 */
function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}
