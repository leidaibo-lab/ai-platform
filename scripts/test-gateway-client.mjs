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

/** 验证 AI SDK API 错误映射为原有 GatewayRequestError 且不会自动重试。 */
async function testAiSdkErrorMapping() {
  const requests = [];
  /** 始终返回限流错误，供单次调用和状态码断言。 */
  function handleRateLimitedRequest() {
    return jsonResponse({ error: "plain rate limit" }, 429);
  }
  const client = createGatewayClient({
    baseUrl: "http://gateway.test",
    model: "chat-default",
    apiKey: "test-key",
    fetchImplementation: createFakeFetch(requests, handleRateLimitedRequest),
  });

  await assert.rejects(
    client.chatCompletions({ messages: [{ role: "user", content: "hello" }] }),
    isRateLimitGatewayError,
  );
  assert.equal(requests.length, 1);
}

test("gateway client maps API status without automatic retries", testAiSdkErrorMapping);

/** 判断异常是否为映射后的 429 GatewayRequestError。 */
function isRateLimitGatewayError(error) {
  return error instanceof GatewayRequestError && error.status === 429 && error.message === "plain rate limit";
}

/** 验证 SDK 超时和调用方取消映射为稳定的 GatewayRequestError 状态。 */
async function testAiSdkCancellationMapping() {
  /** 模拟 AI SDK 总超时。 */
  async function throwTimeout() {
    throw new DOMException("timed out", "TimeoutError");
  }
  /** 模拟调用方取消后 AI SDK 抛出的 AbortError。 */
  async function throwAbort() {
    throw new DOMException("aborted", "AbortError");
  }
  const baseOptions = {
    baseUrl: "http://gateway.test",
    model: "chat-default",
    apiKey: "test-key",
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
}

test("gateway client maps timeout and caller cancellation", testAiSdkCancellationMapping);

/** 判断异常是否为 504 网关超时。 */
function isGatewayTimeoutError(error) {
  return error instanceof GatewayRequestError && error.status === 504;
}

/** 判断异常是否为调用方取消状态。 */
function isGatewayAbortError(error) {
  return error instanceof GatewayRequestError && error.status === 499;
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

/** 创建带 JSON content type 的标准 Response。 */
function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}
