#!/usr/bin/env node
import assert from "node:assert/strict";
import test from "node:test";
import { createGatewayClient, GatewayRequestError, toAiSdkMessages } from "../src/gateway/gateway-client.mjs";
import { createTestRuntime, run } from "./test-runtime.mjs";

/** 验证 OpenAI-compatible 多模态消息转换为 AI SDK v7 FilePart。 */
function testAiSdkMessageConversion() {
  const messages = toAiSdkMessages([
    { role: "system", content: "系统规则" },
    {
      role: "user",
      content: [
        { type: "text", text: "分析图片" },
        { type: "image_url", image_url: { url: "https://example.com/image.png" } },
        { type: "image_url", image_url: { url: "data:image/png;base64,YQ==" } },
      ],
    },
  ]);

  assert.deepEqual(messages[0], { role: "system", content: "系统规则" });
  assert.equal(messages[1].content[0].type, "text");
  assert.equal(messages[1].content[1].type, "file");
  assert.equal(messages[1].content[1].mediaType, "image");
  assert.equal(messages[1].content[1].data.url.toString(), "https://example.com/image.png");
  assert.equal(messages[1].content[2].data.url.toString(), "data:image/png;base64,YQ==");
}

test("gateway client converts text and image_url message parts", testAiSdkMessageConversion);

/** 验证非法消息在 Gateway Client 边界稳定映射为 400，而不是静默改写或上抛 502。 */
function testAiSdkMessageValidation() {
  assert.throws(() => toAiSdkMessages(null), isInvalidMessageError);
  assert.throws(
    () => toAiSdkMessages([{ role: "unknown", content: "hello" }]),
    isInvalidMessageError,
  );
  assert.throws(
    () => toAiSdkMessages([{ role: "assistant", content: [{ type: "text", text: "hello" }] }]),
    isInvalidMessageError,
  );
}

test("gateway client rejects invalid messages with status 400", testAiSdkMessageValidation);

/** 判断异常是否为消息边界产生的 400 GatewayRequestError。 */
function isInvalidMessageError(error) {
  return error instanceof GatewayRequestError && error.status === 400;
}

/** 验证 AI SDK 请求体和返回值保持现有 GatewayClient 契约。 */
async function testAiSdkProtocolMapping() {
  const requests = [];
  const fetchImplementation = createFakeFetch(requests, handleSuccessfulGatewayRequest);
  const client = createGatewayClient({
    baseUrl: "http://gateway.test",
    model: "chat-default",
    apiKey: "test-key",
    fetchImplementation,
  });
  const responseFormat = {
    type: "json_schema",
    json_schema: {
      name: "memory_delta",
      strict: true,
      schema: { type: "object", additionalProperties: false, properties: {} },
    },
  };

  const result = await client.chatCompletions({
    messages: [
      { role: "system", content: "系统规则一" },
      { role: "system", content: "系统规则二" },
      {
        role: "user",
        content: [
          { type: "text", text: "分析图片" },
          { type: "image_url", image_url: { url: "https://example.com/image.png" } },
          { type: "image_url", image_url: { url: "data:image/png;base64,YQ==" } },
        ],
      },
    ],
    temperature: 0.2,
    maxCompletionTokens: 321,
    responseFormat,
  });

  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, "http://gateway.test/v1/chat/completions");
  assert.equal(requests[0].headers.get("authorization"), "Bearer test-key");
  assert.equal(requests[0].body.model, "chat-default");
  assert.equal(requests[0].body.temperature, 0.2);
  assert.equal(requests[0].body.max_completion_tokens, 321);
  assert.equal("max_tokens" in requests[0].body, false);
  assert.deepEqual(requests[0].body.response_format, responseFormat);
  assert.deepEqual(requests[0].body.messages.slice(0, 2), [
    { role: "system", content: "系统规则一" },
    { role: "system", content: "系统规则二" },
  ]);
  assert.equal(requests[0].body.messages[2].content[1].type, "image_url");
  assert.equal(requests[0].body.messages[2].content[1].image_url.url, "https://example.com/image.png");
  assert.equal(requests[0].body.messages[2].content[2].image_url.url, "data:image/png;base64,YQ==");
  assert.equal(result.model, "resolved-upstream-model");
  assert.equal(result.choices[0].message.content, "adapter response");
  assert.equal(result.choices[0].finish_reason, "stop");
  assert.deepEqual(result.usage, {
    prompt_tokens: 17,
    completion_tokens: 5,
    total_tokens: 22,
  });
  assert.equal(result.resilience.attemptCount, 1);
  assert.equal(result.resilience.attempts[0].status, "completed");
}

test("gateway client preserves LiteLLM request and response semantics", testAiSdkProtocolMapping);

/** 为成功协议测试返回 models、token counter 或 chat completions 响应。 */
function handleSuccessfulGatewayRequest(request) {
  if (request.url.endsWith("/v1/models")) {
    return jsonResponse({ data: [{ id: "chat-default" }] });
  }
  if (request.url.endsWith("/utils/token_counter")) {
    return jsonResponse({ total_tokens: 29, model: "resolved-upstream-model" });
  }
  return jsonResponse({
    id: "chatcmpl-test",
    created: 1720000000,
    model: "resolved-upstream-model",
    choices: [
      {
        index: 0,
        message: { role: "assistant", content: "adapter response" },
        finish_reason: "stop",
      },
    ],
    usage: { prompt_tokens: 17, completion_tokens: 5, total_tokens: 22 },
  });
}

/** 验证平台在 AI SDK 内建重试关闭时，仍按统一预算重试 429 并保留尝试证据。 */
async function testPlatformRetriesRateLimit() {
  const requests = [];
  let attempts = 0;
  /** 前两次返回无等待限流错误，第三次返回成功结果。 */
  function handleRateLimitedRequest() {
    attempts += 1;
    if (attempts < 3) return jsonResponse({ error: "plain rate limit" }, 429, { "Retry-After-Ms": "0" });
    return handleSuccessfulGatewayRequest({ url: "http://gateway.test/v1/chat/completions" });
  }
  const client = createGatewayClient({
    baseUrl: "http://gateway.test",
    model: "chat-default",
    apiKey: "test-key",
    retryBaseDelayMs: 0,
    fetchImplementation: createFakeFetch(requests, handleRateLimitedRequest),
  });

  const result = await client.chatCompletions({ messages: [{ role: "user", content: "hello" }] });
  assert.equal(requests.length, 3);
  assert.equal(result.resilience.attemptCount, 3);
  assert.deepEqual(result.resilience.attempts.map(readAttemptStatus), ["failed", "failed", "completed"]);
  assert.equal(result.resilience.attempts[0].errorType, "rate_limit");
}

test("gateway client owns retry budget while AI SDK retries stay disabled", testPlatformRetriesRateLimit);

/** 验证 GatewayClient 逐段交付 AI SDK 文本流，并在结束后恢复既有 completion 结果。 */
async function testGatewayStreamsTextDeltas() {
  const deltas = [];
  let sdkInput = null;
  /** 返回两个确定性文本增量和完整结果元数据。 */
  function streamTextImplementation(input) {
    sdkInput = input;
    return createStreamTextResult(streamValues("流式", "回复"));
  }
  /** 收集 Runtime 可见的文本增量。 */
  function collectDelta(delta) {
    deltas.push(delta);
  }
  const client = createGatewayClient(
    {
      baseUrl: "http://gateway.test",
      model: "chat-default",
      apiKey: "test-key",
    },
    { streamTextImplementation },
  );

  const result = await client.chatCompletions({
    messages: [{ role: "user", content: "hello" }],
    onTextDelta: collectDelta,
  });

  assert.deepEqual(deltas, ["流式", "回复"]);
  assert.equal(sdkInput.maxRetries, 0);
  assert.equal(result.choices[0].message.content, "流式回复");
  assert.equal(result.choices[0].finish_reason, "stop");
  assert.equal(result.resilience.attemptCount, 1);
  assert.equal(result.resilience.outputStarted, true);
}

test("gateway client streams text deltas and preserves the completion contract", testGatewayStreamsTextDeltas);

/** 验证首个文本增量前的瞬时错误仍可由平台统一预算重试。 */
async function testGatewayRetriesBeforeFirstTextDelta() {
  const deltas = [];
  let attempts = 0;
  /** 第一次在输出前超时，第二次返回有效文本流。 */
  function streamTextImplementation() {
    attempts += 1;
    return createStreamTextResult(attempts === 1 ? failBeforeOutput() : streamValues("恢复成功"));
  }
  /** 收集重试成功后的唯一文本增量。 */
  function collectDelta(delta) {
    deltas.push(delta);
  }
  const client = createGatewayClient(
    {
      baseUrl: "http://gateway.test",
      model: "chat-default",
      apiKey: "test-key",
      retryBaseDelayMs: 0,
    },
    { streamTextImplementation },
  );

  const result = await client.chatCompletions({
    messages: [{ role: "user", content: "hello" }],
    onTextDelta: collectDelta,
  });

  assert.equal(attempts, 2);
  assert.deepEqual(deltas, ["恢复成功"]);
  assert.equal(result.resilience.attemptCount, 2);
  assert.deepEqual(result.resilience.attempts.map(readAttemptStatus), ["failed", "completed"]);
  assert.equal(result.resilience.outputStarted, true);
}

test("gateway client retries a stream failure before the first text delta", testGatewayRetriesBeforeFirstTextDelta);

/** 验证已经交付文本后发生瞬时错误时立即失败，避免把两次回答拼接到一起。 */
async function testGatewayDoesNotRetryAfterTextDelta() {
  const deltas = [];
  let attempts = 0;
  /** 返回先产生文本、随后超时的模型流。 */
  function streamTextImplementation() {
    attempts += 1;
    return createStreamTextResult(failAfterOutput("部分回复"));
  }
  /** 收集失败前已交付的文本。 */
  function collectDelta(delta) {
    deltas.push(delta);
  }
  const client = createGatewayClient(
    {
      baseUrl: "http://gateway.test",
      model: "chat-default",
      apiKey: "test-key",
      retryBaseDelayMs: 0,
    },
    { streamTextImplementation },
  );

  await assert.rejects(
    client.chatCompletions({
      messages: [{ role: "user", content: "hello" }],
      onTextDelta: collectDelta,
    }),
    isPostOutputStreamError,
  );
  assert.equal(attempts, 1);
  assert.deepEqual(deltas, ["部分回复"]);
}

test("gateway client does not retry after the first text delta", testGatewayDoesNotRetryAfterTextDelta);

/** 验证参数类 400 错误不会进入平台自动重试。 */
async function testPlatformDoesNotRetryPermanentError() {
  const requests = [];
  /** 始终返回参数错误。 */
  function handleBadRequest() {
    return jsonResponse({ error: "invalid request" }, 400);
  }
  const client = createGatewayClient({
    baseUrl: "http://gateway.test",
    model: "chat-default",
    apiKey: "test-key",
    retryBaseDelayMs: 0,
    fetchImplementation: createFakeFetch(requests, handleBadRequest),
  });

  await assert.rejects(
    client.chatCompletions({ messages: [{ role: "user", content: "hello" }] }),
    isPermanentGatewayError,
  );
  assert.equal(requests.length, 1);
}

test("gateway client does not retry permanent API errors", testPlatformDoesNotRetryPermanentError);

/** 判断异常是否为只尝试一次的永久网关错误。 */
function isPermanentGatewayError(error) {
  return (
    error instanceof GatewayRequestError &&
    error.status === 400 &&
    error.resilience?.attemptCount === 1 &&
    error.resilience.attempts[0].retryable === false
  );
}

/** 创建与 AI SDK StreamTextResult 最小兼容的测试结果。 */
function createStreamTextResult(textStream) {
  return {
    textStream,
    usage: Promise.resolve({ inputTokens: 9, outputTokens: 3, totalTokens: 12 }),
    finishReason: Promise.resolve("stop"),
    response: Promise.resolve({
      id: "stream-test",
      modelId: "resolved-stream-model",
      timestamp: new Date("2026-07-28T00:00:00.000Z"),
    }),
  };
}

/** 依次产生调用方给定的文本增量。 */
async function* streamValues(...values) {
  for (const value of values) yield value;
}

/** 在产生首个文本增量前模拟模型流超时。 */
async function* failBeforeOutput() {
  throw new DOMException("timed out before output", "TimeoutError");
}

/** 先产生一个文本增量，再模拟模型流超时。 */
async function* failAfterOutput(value) {
  yield value;
  throw new DOMException("timed out after output", "TimeoutError");
}

/** 判断异常是否为输出已开始且明确停止重试的流式超时。 */
function isPostOutputStreamError(error) {
  return (
    error instanceof GatewayRequestError &&
    error.status === 504 &&
    error.resilience?.attemptCount === 1 &&
    error.resilience.outputStarted === true &&
    error.resilience.attempts[0].retryable === false
  );
}

/** 验证普通 SDK 或编程异常即使对外映射为 502，也不会被误判为瞬时故障。 */
async function testPlatformDoesNotRetryUnknownSdkError() {
  let attempts = 0;
  /** 模拟不带网络或 HTTP 瞬时故障语义的普通异常。 */
  async function throwUnknownError() {
    attempts += 1;
    throw new Error("unexpected sdk failure");
  }
  const client = createGatewayClient(
    {
      baseUrl: "http://gateway.test",
      model: "chat-default",
      apiKey: "test-key",
      retryBaseDelayMs: 0,
    },
    { generateTextImplementation: throwUnknownError },
  );

  await assert.rejects(
    client.chatCompletions({ messages: [{ role: "user", content: "hello" }] }),
    isUnknownSdkGatewayError,
  );
  assert.equal(attempts, 1);
}

test("gateway client does not retry unknown SDK errors mapped to 502", testPlatformDoesNotRetryUnknownSdkError);

/** 判断异常是否为只尝试一次且明确不可重试的未知 SDK 错误。 */
function isUnknownSdkGatewayError(error) {
  return (
    error instanceof GatewayRequestError &&
    error.status === 502 &&
    error.resilience?.attemptCount === 1 &&
    error.resilience.attempts[0].retryable === false
  );
}

/** 验证 SDK 超时和调用方取消映射为稳定的 GatewayRequestError 状态。 */
async function testAiSdkCancellationMapping() {
  let timeoutAttempts = 0;
  let abortAttempts = 0;
  /** 模拟 AI SDK 总超时。 */
  async function throwTimeout() {
    timeoutAttempts += 1;
    throw new DOMException("timed out", "TimeoutError");
  }
  /** 模拟调用方取消后 AI SDK 抛出的 AbortError。 */
  async function throwAbort() {
    abortAttempts += 1;
    throw new DOMException("aborted", "AbortError");
  }
  const baseOptions = {
    baseUrl: "http://gateway.test",
    model: "chat-default",
    apiKey: "test-key",
    retryBaseDelayMs: 0,
  };
  const timeoutClient = createGatewayClient(baseOptions, {
    generateTextImplementation: throwTimeout,
  });
  const abortClient = createGatewayClient(baseOptions, {
    generateTextImplementation: throwAbort,
  });
  const controller = new AbortController();
  controller.abort();

  await assert.rejects(
    timeoutClient.chatCompletions({ messages: [{ role: "user", content: "hello" }] }),
    isGatewayTimeoutError,
  );
  await assert.rejects(
    abortClient.chatCompletions({
      messages: [{ role: "user", content: "hello" }],
      abortSignal: controller.signal,
    }),
    isGatewayAbortError,
  );
  assert.equal(timeoutAttempts, 3);
  assert.equal(abortAttempts, 0);
}

test("gateway client maps timeout and caller cancellation", testAiSdkCancellationMapping);

/** 判断异常是否为 504 网关超时。 */
function isGatewayTimeoutError(error) {
  return error instanceof GatewayRequestError && error.status === 504 && error.resilience?.attemptCount === 3;
}

/** 判断异常是否为调用方取消状态。 */
function isGatewayAbortError(error) {
  return error instanceof GatewayRequestError && error.status === 499 && error.resilience?.attemptCount === 0;
}

/** 验证 Gateway Client 组合 LiteLLM 状态和 token counter 管理端点。 */
async function testAiSdkManagementEndpoints() {
  const requests = [];
  const client = createGatewayClient({
    baseUrl: "http://gateway.test",
    model: "chat-default",
    apiKey: "test-key",
    fetchImplementation: createFakeFetch(requests, handleSuccessfulGatewayRequest),
  });

  const status = await client.status();
  const count = await client.countTokens({ messages: [{ role: "user", content: "hello" }] });
  assert.equal(status.ok, true);
  assert.equal(status.gatewayBaseUrl, "http://gateway.test/v1");
  assert.deepEqual(count, { tokens: 29, source: "litellm", model: "resolved-upstream-model" });
  assert.deepEqual(requests.map(getRequestPath), ["/v1/models", "/utils/token_counter"]);
}

test("gateway client retains LiteLLM status and token counter", testAiSdkManagementEndpoints);

/** 验证 Memory Manager 在 schema 400 后仍按原逻辑无 response_format 重试。 */
async function testStructuredMemoryFallback() {
  const requests = [];
  let structuredAttempts = 0;
  /** 为普通回复和结构化记忆提取返回脚本化响应。 */
  function handleMemoryGatewayRequest(request) {
    if (request.url.endsWith("/utils/token_counter")) {
      return jsonResponse({ total_tokens: 80, model: "memory-model" });
    }
    if (request.body.response_format) {
      structuredAttempts += 1;
      return jsonResponse({ error: { message: "response_format unsupported" } }, 400);
    }
    const isMemoryPrompt = request.body.messages.some(hasMemoryExtractorPrompt);
    return jsonResponse({
      id: "chatcmpl-memory",
      created: 1720000000,
      model: "memory-model",
      choices: [
        {
          index: 0,
          message: {
            role: "assistant",
            content: isMemoryPrompt
              ? JSON.stringify({ upserts: [], supersedes: [], episode: null })
              : "已收到",
          },
          finish_reason: "stop",
        },
      ],
      usage: { prompt_tokens: 20, completion_tokens: 5, total_tokens: 25 },
    });
  }

  const gatewayClient = createGatewayClient({
    baseUrl: "http://gateway.test",
    model: "chat-default",
    apiKey: "test-key",
    fetchImplementation: createFakeFetch(requests, handleMemoryGatewayRequest),
  });
  const fixture = createTestRuntime({ gatewayClient });
  const conversation = fixture.runtime.createConversation();
  await run(fixture.runtime, conversation.id, 1, "需要长期记忆的消息");
  const compacted = await fixture.memoryManager.compactIfNeeded(conversation.id, { force: true });

  assert.equal(compacted.status, "compacted");
  assert.equal(structuredAttempts, 1);
  const chatBodies = requests.filter(isChatRequest).map(getRequestBody);
  assert.equal(chatBodies.filter(hasResponseFormat).length, 1);
  assert.equal(chatBodies.at(-1).response_format, undefined);
  fixture.store.close();
}

test("structured memory keeps the existing 400 fallback", testStructuredMemoryFallback);

/** 判断模型请求是否包含 Memory Extractor 系统提示。 */
function hasMemoryExtractorPrompt(message) {
  return message.role === "system" && String(message.content || "").includes("结构化记忆提取器");
}

/** 判断记录是否为 chat completions 请求。 */
function isChatRequest(request) {
  return request.url.endsWith("/v1/chat/completions");
}

/** 返回记录的 JSON 请求体。 */
function getRequestBody(request) {
  return request.body;
}

/** 判断请求体是否包含 response_format。 */
function hasResponseFormat(body) {
  return body.response_format !== undefined;
}

/** 返回请求 URL 的 pathname。 */
function getRequestPath(request) {
  return new URL(request.url).pathname;
}

/** 创建记录请求并交给 handler 生成响应的 fake fetch。 */
function createFakeFetch(requests, handler) {
  /** 解析并记录一次 fetch 调用。 */
  async function fakeFetch(input, init = {}) {
    const url = input instanceof Request ? input.url : String(input);
    const headers = new Headers(input instanceof Request ? input.headers : init.headers);
    const rawBody = input instanceof Request ? await input.clone().text() : String(init.body || "");
    const request = {
      url,
      headers,
      body: rawBody ? JSON.parse(rawBody) : null,
    };
    requests.push(request);
    return handler(request);
  }
  return fakeFetch;
}

/** 创建带 JSON content type 和可选响应头的标准 Response。 */
function jsonResponse(body, status = 200, headers = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...headers },
  });
}

/** 返回尝试状态，供平台重试顺序断言复用。 */
function readAttemptStatus(attempt) {
  return attempt.status;
}
