#!/usr/bin/env node
import assert from "node:assert/strict";
import test from "node:test";
import { APICallError } from "ai";
import { z } from "zod";
import { createGatewayClient, GatewayRequestError, toAiSdkMessages } from "../src/gateway/gateway-client.mjs";
import { createToolRegistry } from "../src/tools/tool-registry.mjs";
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
    {
      role: "assistant",
      content: [
        { type: "tool-call", toolCallId: "weather-call-recovery", toolName: "get_weather", input: { location: "深圳" } },
      ],
    },
    {
      role: "tool",
      content: [
        {
          type: "tool-result",
          toolCallId: "weather-call-recovery",
          toolName: "get_weather",
          output: { type: "json", value: { status: "success", temperature: 26 } },
        },
      ],
    },
  ]);

  assert.deepEqual(messages[0], { role: "system", content: "系统规则" });
  assert.equal(messages[1].content[0].type, "text");
  assert.equal(messages[1].content[1].type, "file");
  assert.equal(messages[1].content[1].mediaType, "image");
  assert.equal(messages[1].content[1].data.url.toString(), "https://example.com/image.png");
  assert.equal(messages[1].content[2].data.url.toString(), "data:image/png;base64,YQ==");
  assert.equal(messages[2].content[0].type, "tool-call");
  assert.equal(messages[2].content[0].toolCallId, "weather-call-recovery");
  assert.equal(messages[3].content[0].type, "tool-result");
  assert.deepEqual(messages[3].content[0].output.value, { status: "success", temperature: 26 });
}

test("gateway client converts text and image_url message parts", testAiSdkMessageConversion);

/** 验证非法消息在 Gateway Client 边界稳定映射为 400，而不是静默改写或上抛 502。 */
function testAiSdkMessageValidation() {
  // 调用无消息转换，验证缺失消息数组被拒绝。
  assert.throws(() => toAiSdkMessages(null), isInvalidMessageError);
  assert.throws(
    // 调用未知角色转换，验证角色白名单边界。
    () => toAiSdkMessages([{ role: "unknown", content: "hello" }]),
    isInvalidMessageError,
  );
  assert.throws(
    // 调用含非法 assistant 图片分段的转换，验证角色内容契约。
    () => toAiSdkMessages([{ role: "assistant", content: [{ type: "image_url", image_url: { url: "https://example.com/a.png" } }] }]),
    isInvalidMessageError,
  );
  assert.throws(
    // 调用缺少 output 的工具结果转换，验证工具消息完整性。
    () => toAiSdkMessages([{ role: "tool", content: [{ type: "tool-result", toolCallId: "call-1" }] }]),
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

/** 验证图片模型经 LiteLLM 标准端点调用，并固定单次尝试与通用尺寸参数。 */
async function testAiSdkImageGenerationMapping() {
  const requests = [];
  /** 返回图片模型目录或一张有效 1x1 PNG 的 OpenAI-compatible 图片结果。 */
  function handleImageGenerationRequest(request) {
    if (request.url.endsWith("/v1/models")) {
      return jsonResponse({ data: [{ id: "chat-default" }, { id: "image-default" }] });
    }
    return jsonResponse({
      data: [{
        b64_json: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
      }],
    });
  }
  const client = createGatewayClient({
    baseUrl: "http://gateway.test",
    model: "chat-default",
    imageModel: "image-default",
    apiKey: "test-key",
    fetchImplementation: createFakeFetch(requests, handleImageGenerationRequest),
  });

  const result = await client.generateImages({
    prompt: "一枚放在白色桌面的红色印章",
    size: "1024x1024",
  });

  const imageRequest = requests[1];
  assert.equal(requests.length, 2);
  assert.equal(requests[0].url, "http://gateway.test/v1/models");
  assert.equal(imageRequest.url, "http://gateway.test/v1/images/generations");
  assert.equal(imageRequest.body.model, "image-default");
  assert.equal(imageRequest.body.n, 1);
  assert.equal(imageRequest.body.size, "1024x1024");
  assert.equal(result.images.length, 1);
  assert.equal(result.images[0].mediaType, "image/png");
  assert.ok(result.images[0].bytes.length > 0);
  assert.equal(result.usage.generated_images, 1);
  assert.equal(result.resilience.maxAttempts, 1);
  assert.equal(result.resilience.attemptCount, 1);
  assert.equal(result.resilience.retryBoundaryCrossed, true);
}

test("gateway client generates images through LiteLLM without automatic retries", testAiSdkImageGenerationMapping);

/** 验证图片编辑通过 LiteLLM Responses 工具端点，并携带唯一受控源图。 */
async function testResponsesImageEditingMapping() {
  const requests = [];
  const sourceBytes = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
    "base64",
  );
  /** 返回模型目录或混合输出中的一张有效 1x1 PNG Responses 编辑结果。 */
  function handleImageEditingRequest(request) {
    if (request.url.endsWith("/v1/models")) {
      return jsonResponse({ data: [{ id: "chat-default" }, { id: "image-default" }, { id: "edit-default" }] });
    }
    return jsonResponse({
      id: "resp-image-edit",
      status: "completed",
      output: [
        { type: "reasoning", id: "reasoning-1", summary: [] },
        {
          type: "image_generation_call",
          id: "image-call-1",
          status: "completed",
          result: sourceBytes.toString("base64"),
        },
      ],
      usage: { input_tokens: 21, output_tokens: 9, total_tokens: 30 },
    });
  }
  const client = createGatewayClient({
    baseUrl: "http://gateway.test",
    model: "chat-default",
    imageModel: "image-default",
    imageEditModel: "edit-default",
    apiKey: "test-key",
    fetchImplementation: createFakeFetch(requests, handleImageEditingRequest),
  });

  const result = await client.editImages({
    prompt: "保留构图并改成蓝色水彩风格",
    sourceImages: [{ bytes: sourceBytes, mediaType: "image/png" }],
    size: "1024x1024",
  });
  const imageRequest = requests[1];
  const requestBody = imageRequest.body;
  const inputContent = requestBody.input[0].content;

  assert.equal(requests.length, 2);
  assert.equal(requests[0].url, "http://gateway.test/v1/models");
  assert.equal(imageRequest.url, "http://gateway.test/v1/responses");
  assert.equal(imageRequest.headers.get("authorization"), "Bearer test-key");
  assert.equal(requestBody.model, "edit-default");
  assert.equal(requestBody.store, false);
  assert.deepEqual(requestBody.tools, [{ type: "image_generation", action: "edit", size: "1024x1024" }]);
  assert.deepEqual(requestBody.tool_choice, { type: "image_generation" });
  assert.equal(Object.hasOwn(requestBody, "max_tool_calls"), false);
  assert.deepEqual(inputContent[0], { type: "input_text", text: "保留构图并改成蓝色水彩风格" });
  assert.equal(inputContent[1].type, "input_image");
  assert.equal(inputContent[1].image_url, `data:image/png;base64,${sourceBytes.toString("base64")}`);
  assert.equal(result.images.length, 1);
  assert.equal(result.images[0].mediaType, "image/png");
  assert.deepEqual(result.images[0].bytes, sourceBytes);
  assert.deepEqual(result.usage, {
    input_tokens: 21,
    output_tokens: 9,
    total_tokens: 30,
    generated_images: 1,
  });
  assert.equal(result.resilience.operation, "model.image.edit");
  assert.equal(result.resilience.maxAttempts, 1);
  assert.equal(result.resilience.attemptCount, 1);
}

test("gateway client edits one controlled image through LiteLLM Responses", testResponsesImageEditingMapping);

/** 验证 Responses 编辑拒绝非法、多图片和上游错误结果，且不泄漏 provider 原始正文。 */
async function testResponsesImageEditingResultGuards() {
  const sourceBytes = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
    "base64",
  );
  const invalidClient = createResponsesEditingClient({
    output: [{ type: "image_generation_call", status: "completed", result: "%%%=" }],
  });
  await assert.rejects(
    invalidClient.editImages({ prompt: "编辑图片", sourceImages: [{ bytes: sourceBytes, mediaType: "image/png" }] }),
    isInvalidResponsesImageResult,
  );

  const multipleClient = createResponsesEditingClient({
    output: [
      { type: "image_generation_call", status: "completed", result: sourceBytes.toString("base64") },
      { type: "image_generation_call", status: "completed", result: sourceBytes.toString("base64") },
    ],
  });
  await assert.rejects(
    multipleClient.editImages({ prompt: "编辑图片", sourceImages: [{ bytes: sourceBytes, mediaType: "image/png" }] }),
    isMultipleResponsesImageResult,
  );

  const deniedClient = createResponsesEditingClient({
    error: { code: "access_denied", message: "provider secret should stay hidden" },
  }, 403);
  await assert.rejects(
    deniedClient.editImages({ prompt: "编辑图片", sourceImages: [{ bytes: sourceBytes, mediaType: "image/png" }] }),
    isSanitizedResponsesProviderError,
  );
}

test("gateway client rejects unsafe Responses image edit results", testResponsesImageEditingResultGuards);

/** 验证 Responses JSON 对无长度、伪小长度、chunked 和非法正文应用统一流式边界。 */
async function testResponsesImageEditingStreamGuards() {
  const sourceBytes = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
    "base64",
  );
  const successPayload = {
    output: [{
      type: "image_generation_call",
      status: "completed",
      result: sourceBytes.toString("base64"),
    }],
  };

  /** 返回没有 Content-Length 的正常分块 JSON，验证长度声明不是成功前提。 */
  function createNoContentLengthResponse() {
    return streamedResponse([
      new TextEncoder().encode(JSON.stringify(successPayload)),
    ]);
  }
  const noContentLengthClient = createResponsesEditingClientFromResponse(createNoContentLengthResponse);
  const normalResult = await noContentLengthClient.editImages({
    prompt: "编辑图片",
    sourceImages: [{ bytes: sourceBytes, mediaType: "image/png" }],
  });
  assert.deepEqual(normalResult.images[0].bytes, sourceBytes);

  const fakeLengthObservation = { cancelCount: 0 };
  /** 返回伪造极小 Content-Length、实际解压后超限的成功响应。 */
  function createFakeSmallLengthResponse() {
    return streamedResponse(createOversizedResponsesChunks(), {
      headers: { "Content-Encoding": "gzip", "Content-Length": "1" },
      observation: fakeLengthObservation,
    });
  }
  const fakeLengthClient = createResponsesEditingClientFromResponse(createFakeSmallLengthResponse);
  await assert.rejects(
    fakeLengthClient.editImages({
      prompt: "编辑图片",
      sourceImages: [{ bytes: sourceBytes, mediaType: "image/png" }],
    }),
    isResponsesPayloadTooLarge,
  );
  assert.equal(fakeLengthObservation.cancelCount, 1);

  const chunkedObservation = { cancelCount: 0 };
  /** 返回没有 Content-Length 的超限 chunked 失败响应，验证非 2xx 使用同一硬上限。 */
  function createOversizedChunkedErrorResponse() {
    return streamedResponse(createOversizedResponsesChunks(), {
      status: 503,
      headers: { "Transfer-Encoding": "chunked" },
      observation: chunkedObservation,
    });
  }
  const chunkedClient = createResponsesEditingClientFromResponse(createOversizedChunkedErrorResponse);
  await assert.rejects(
    chunkedClient.editImages({
      prompt: "编辑图片",
      sourceImages: [{ bytes: sourceBytes, mediaType: "image/png" }],
    }),
    isResponsesPayloadTooLarge,
  );
  assert.equal(chunkedObservation.cancelCount, 1);

  /** 返回包含敏感正文的非法成功 JSON，验证只暴露稳定解析错误。 */
  function createInvalidSuccessResponse() {
    return streamedResponse([
      new TextEncoder().encode('{"message":"provider secret"'),
    ]);
  }
  const invalidSuccessClient = createResponsesEditingClientFromResponse(createInvalidSuccessResponse);
  await assert.rejects(
    invalidSuccessClient.editImages({
      prompt: "编辑图片",
      sourceImages: [{ bytes: sourceBytes, mediaType: "image/png" }],
    }),
    isSanitizedInvalidResponsesPayload,
  );

  /** 返回包含敏感正文的非法失败 JSON，验证继续按 HTTP 状态返回脱敏 provider 错误。 */
  function createInvalidErrorResponse() {
    return streamedResponse([
      new TextEncoder().encode('{"message":"provider secret"'),
    ], { status: 502 });
  }
  const invalidErrorClient = createResponsesEditingClientFromResponse(createInvalidErrorResponse);
  await assert.rejects(
    invalidErrorClient.editImages({
      prompt: "编辑图片",
      sourceImages: [{ bytes: sourceBytes, mediaType: "image/png" }],
    }),
    isSanitizedMalformedResponsesProviderError,
  );
}

test("gateway client bounds streamed Responses image edit payloads", testResponsesImageEditingStreamGuards);

/** 创建只处理模型目录和单次 JSON Responses 结果的 GatewayClient。 */
function createResponsesEditingClient(payload, status = 200) {
  /** 将既有测试载荷封装为一次标准 JSON Response。 */
  function createPayloadResponse() {
    return jsonResponse(payload, status);
  }
  return createResponsesEditingClientFromResponse(createPayloadResponse);
}

/** 创建接受自定义 Responses 流工厂的 GatewayClient，隔离模型目录请求。 */
function createResponsesEditingClientFromResponse(responseFactory) {
  /** 返回编辑模型目录或调用方指定的 Responses 结果。 */
  function handleResponsesRequest(request) {
    if (request.url.endsWith("/v1/models")) {
      return jsonResponse({ data: [{ id: "chat-default" }] });
    }
    return responseFactory();
  }
  return createGatewayClient({
    baseUrl: "http://gateway.test",
    model: "chat-default",
    imageEditModel: "chat-default",
    apiKey: "test-key",
    fetchImplementation: createFakeFetch([], handleResponsesRequest),
  });
}

/** 判断异常是否为非法 Responses 图片 Base64。 */
function isInvalidResponsesImageResult(error) {
  return error instanceof GatewayRequestError && error.data?.code === "invalid_image_edit_result";
}

/** 判断异常是否为一次编辑返回多个图片调用。 */
function isMultipleResponsesImageResult(error) {
  return error instanceof GatewayRequestError && error.data?.code === "multiple_image_edit_results";
}

/** 判断上游错误只保留短分类码且不包含原始正文。 */
function isSanitizedResponsesProviderError(error) {
  return error instanceof GatewayRequestError &&
    error.status === 403 &&
    error.data?.code === "image_edit_provider_error" &&
    error.data?.providerCode === "access_denied" &&
    !JSON.stringify(error.data).includes("provider secret");
}

/** 判断成功或失败 Responses 流超过解压后统一字节上限。 */
function isResponsesPayloadTooLarge(error) {
  return error instanceof GatewayRequestError &&
    error.status === 502 &&
    error.data?.code === "image_edit_response_too_large";
}

/** 判断成功响应的非法 JSON 被映射为不含正文的稳定错误。 */
function isSanitizedInvalidResponsesPayload(error) {
  return error instanceof GatewayRequestError &&
    error.status === 502 &&
    error.data?.code === "invalid_image_edit_response" &&
    !JSON.stringify(error.data).includes("provider secret");
}

/** 判断失败响应的非法 JSON 仍只暴露 HTTP 状态和平台 provider 错误分类。 */
function isSanitizedMalformedResponsesProviderError(error) {
  return error instanceof GatewayRequestError &&
    error.status === 502 &&
    error.data?.code === "image_edit_provider_error" &&
    error.data?.providerCode === undefined &&
    !JSON.stringify(error.data).includes("provider secret");
}

/** 验证 AI SDK `Output.object` 负责结构化输出请求、解析和 Standard Schema 校验。 */
async function testAiSdkStructuredOutputMapping() {
  const requests = [];
  /** 返回符合 MemoryDelta 最小 schema 的结构化模型响应。 */
  function handleStructuredRequest() {
    return jsonResponse({
      id: "chatcmpl-structured",
      created: 1720000000,
      model: "structured-model",
      choices: [
        {
          index: 0,
          message: { role: "assistant", content: '{"status":"ok"}' },
          finish_reason: "stop",
        },
      ],
      usage: { prompt_tokens: 12, completion_tokens: 4, total_tokens: 16 },
    });
  }
  const client = createGatewayClient({
    baseUrl: "http://gateway.test",
    model: "chat-default",
    apiKey: "test-key",
    fetchImplementation: createFakeFetch(requests, handleStructuredRequest),
  });
  const schema = z.object({ status: z.literal("ok") }).strict();

  const result = await client.chatCompletions({
    messages: [{ role: "user", content: "返回状态" }],
    outputSchema: { name: "status_result", description: "固定状态结果", schema },
  });

  assert.equal(requests[0].body.response_format.type, "json_schema");
  assert.equal(requests[0].body.response_format.json_schema.name, "status_result");
  assert.equal(requests[0].body.response_format.json_schema.schema.properties.status.const, "ok");
  assert.equal(requests[0].body.response_format.json_schema.schema.additionalProperties, false);
  assert.deepEqual(result.output, { status: "ok" });
  assert.equal(result.usage.total_tokens, 16);
}

test("gateway client uses AI SDK Output.object for structured output", testAiSdkStructuredOutputMapping);

/** 验证 `Output.object` 拒绝不符合 Standard Schema 的 provider 结果，且平台不会重试确定性解析错误。 */
async function testAiSdkStructuredOutputValidation() {
  const requests = [];
  /** 返回可解析但不符合枚举约束的 JSON，隔离验证 AI SDK schema 校验。 */
  function handleInvalidStructuredRequest() {
    return jsonResponse({
      id: "chatcmpl-invalid-structured",
      created: 1720000000,
      model: "structured-model",
      choices: [
        {
          index: 0,
          message: { role: "assistant", content: '{"status":"unexpected"}' },
          finish_reason: "stop",
        },
      ],
      usage: { prompt_tokens: 12, completion_tokens: 4, total_tokens: 16 },
    });
  }
  const client = createGatewayClient({
    baseUrl: "http://gateway.test",
    model: "chat-default",
    apiKey: "test-key",
    retryBaseDelayMs: 0,
    fetchImplementation: createFakeFetch(requests, handleInvalidStructuredRequest),
  });

  await assert.rejects(
    client.chatCompletions({
      messages: [{ role: "user", content: "返回状态" }],
      outputSchema: {
        name: "status_result",
        schema: z.object({ status: z.literal("ok") }).strict(),
      },
    }),
    isInvalidStructuredOutputError,
  );
  assert.equal(requests.length, 1);
}

test("gateway client rejects structured output that fails Standard Schema validation", testAiSdkStructuredOutputValidation);

/** 验证动态结构化输出即使携带工具也保留 Core 路径，不误用定义级 `ToolLoopAgent.output`。 */
async function testStructuredToolCallUsesCorePath() {
  let agentGenerateCalls = 0;
  let coreInput = null;
  /** 创建只记录误调用的 Agent，正常路径不应执行其 generate。 */
  function createToolLoopAgent() {
    return {
      /** 记录错误分流，便于断言结构化工具请求没有进入 Agent。 */
      async generate() {
        agentGenerateCalls += 1;
        throw new Error("structured tool call must use generateText");
      },
    };
  }
  /** 返回带结构化结果的确定性 Core 响应，并保留最终调用参数。 */
  async function generateTextImplementation(input) {
    coreInput = input;
    return {
      text: '{"status":"ok"}',
      output: { status: "ok" },
      finishReason: "stop",
      usage: { inputTokens: 8, outputTokens: 3, totalTokens: 11 },
      finalStep: {
        finishReason: "stop",
        response: { id: "structured-tool", modelId: "chat-default", timestamp: new Date(1720000000000) },
      },
    };
  }
  const tools = { get_weather: { description: "查询天气" } };
  /** 提供不会实际执行的测试工具上下文。 */
  function ignoreToolExecution() {}
  const toolsContext = { get_weather: { executeTool: ignoreToolExecution } };
  const client = createGatewayClient(
    {
      baseUrl: "http://gateway.test",
      model: "chat-default",
      apiKey: "test-key",
      fetchImplementation: createFakeFetch([], handleSuccessfulGatewayRequest),
    },
    { createToolLoopAgent, generateTextImplementation },
  );

  const result = await client.chatCompletions({
    messages: [{ role: "user", content: "返回天气状态" }],
    tools,
    toolsContext,
    requiredToolName: "get_weather",
    outputSchema: { name: "status_result", schema: z.object({ status: z.literal("ok") }).strict() },
  });

  assert.equal(agentGenerateCalls, 0);
  assert.equal(coreInput.tools, tools);
  assert.equal(coreInput.toolsContext, toolsContext);
  assert.equal(typeof coreInput.prepareStep, "function");
  assert.ok(coreInput.output);
  assert.deepEqual(result.output, { status: "ok" });
}

test("gateway client keeps tools with dynamic structured output on the Core path", testStructuredToolCallUsesCorePath);

/** 判断异常是否为只执行一次的 AI SDK 结构化输出校验失败。 */
function isInvalidStructuredOutputError(error) {
  return (
    error instanceof GatewayRequestError &&
    error.status === 502 &&
    error.resilience?.attemptCount === 1 &&
    error.resilience.attempts[0].retryable === false
  );
}

/** 为成功协议测试返回 models、token counter 或 chat completions 响应。 */
function handleSuccessfulGatewayRequest(request) {
  if (request.url.endsWith("/v1/models")) {
    return jsonResponse({ data: [{ id: "chat-default" }, { id: "chat-quality" }, { id: "chat-default" }, { id: "" }] });
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
  assert.equal(typeof sdkInput.onError, "function");
  assert.equal(result.choices[0].message.content, "流式回复");
  assert.equal(result.choices[0].finish_reason, "stop");
  assert.equal(result.resilience.attemptCount, 1);
  assert.equal(result.resilience.outputStarted, true);
}

test("gateway client streams text deltas and preserves the completion contract", testGatewayStreamsTextDeltas);

/** 验证存在工具时 GatewayClient 使用可复用 ToolLoopAgent，并通过 call options 动态装配当前 Run。 */
async function testGatewayUsesReusableToolLoopAgent() {
  let agentSettings = null;
  let agentCall = null;
  let preparedCall = null;
  let agentFactoryCalls = 0;
  let receivedStepLimit = null;
  const deltas = [];
  /** 创建记录 Agent 定义和调用参数的测试 Agent，并返回确定性文本流。 */
  function createToolLoopAgent(settings) {
    agentFactoryCalls += 1;
    agentSettings = settings;
    return {
      /** 记录动态调用，并执行真实 prepareCall 以验证最终 Agent 设置。 */
      async stream(input) {
        agentCall = input;
        preparedCall = await settings.prepareCall({ ...settings, ...input });
        return createStreamTextResult(streamValues("天气", "已查询"));
      },
    };
  }
  /** 记录 GatewayClient 使用的 AI SDK 多步停止上限。 */
  function stepCountIsImplementation(limit) {
    receivedStepLimit = limit;
    return { limit };
  }
  /** 收集 Agent 最终回答文本增量。 */
  function collectDelta(delta) {
    deltas.push(delta);
  }
  const tools = { get_weather: { description: "查询天气" } };
  /** 提供不会实际执行的测试工具上下文。 */
  function ignoreToolExecution() {}
  const toolsContext = { get_weather: { executeTool: ignoreToolExecution } };
  const client = createGatewayClient(
    {
      baseUrl: "http://gateway.test",
      model: "chat-default",
      apiKey: "test-key",
      fetchImplementation: createFakeFetch([], handleSuccessfulGatewayRequest),
    },
    {
      createToolLoopAgent,
      stepCountIsImplementation,
    },
  );

  const result = await client.chatCompletions({
    messages: [{ role: "user", content: "今天深圳天气" }],
    tools,
    toolsContext,
    requiredToolName: "get_weather",
    maxToolSteps: 4,
    onTextDelta: collectDelta,
  });

  const validatedOptions = await agentSettings.callOptionsSchema["~standard"].validate(agentCall.options);
  assert.equal(validatedOptions.issues, undefined);
  assert.equal(agentFactoryCalls, 1);
  assert.equal(agentSettings.id, "ai-platform-conversation");
  assert.equal(agentSettings.maxRetries, 0);
  assert.equal(preparedCall.tools, tools);
  assert.equal(agentCall.toolsContext, toolsContext);
  assert.equal(typeof agentCall.onError, "function");
  assert.deepEqual(preparedCall.stopWhen, { limit: 4 });
  assert.deepEqual(agentSettings.prepareStep({ stepNumber: 0, runtimeContext: preparedCall.runtimeContext }), {
    activeTools: ["get_weather"],
    toolChoice: { type: "tool", toolName: "get_weather" },
  });
  assert.deepEqual(agentSettings.prepareStep({ stepNumber: 1, runtimeContext: preparedCall.runtimeContext }), {
    toolChoice: "auto",
  });
  assert.equal(receivedStepLimit, 4);
  assert.equal(agentCall.messages[0].content, "今天深圳天气");
  assert.deepEqual(deltas, ["天气", "已查询"]);
  assert.equal(result.choices[0].message.content, "天气已查询");
}

test("gateway client uses a reusable ToolLoopAgent when Runtime provides tools", testGatewayUsesReusableToolLoopAgent);

/** 验证真实 ToolLoopAgent 首步强制工具，执行结果后第二步恢复自动生成。 */
async function testRealToolLoopAgentRoutesRequiredWeatherTool() {
  const requests = [];
  let toolExecutions = 0;
  /** 为模型目录和两步 chat completions 返回 OpenAI-compatible 响应。 */
  function handleToolLoopRequest(request) {
    if (request.url.endsWith("/v1/models")) return jsonResponse({ data: [{ id: "chat-default" }] });
    const chatRequests = requests.filter(isChatRequest);
    if (chatRequests.length === 1) {
      return jsonResponse({
        id: "chatcmpl-tool-call",
        created: 1720000000,
        model: "tool-model",
        choices: [
          {
            index: 0,
            message: {
              role: "assistant",
              content: null,
              tool_calls: [
                {
                  id: "weather-call-real-agent",
                  type: "function",
                  function: { name: "get_weather", arguments: '{"location":"深圳","date":"today"}' },
                },
              ],
            },
            finish_reason: "tool_calls",
          },
        ],
        usage: { prompt_tokens: 20, completion_tokens: 5, total_tokens: 25 },
      });
    }
    return jsonResponse({
      id: "chatcmpl-tool-answer",
      created: 1720000001,
      model: "tool-model",
      choices: [
        {
          index: 0,
          message: { role: "assistant", content: "深圳当前 26°C，来源 Open-Meteo。" },
          finish_reason: "stop",
        },
      ],
      usage: { prompt_tokens: 30, completion_tokens: 10, total_tokens: 40 },
    });
  }
  const registry = createToolRegistry([
    {
      name: "get_weather",
      title: "实时天气",
      description: "查询今天或明天的实时天气。",
      effect: "read",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["location"],
        properties: { location: { type: "string" }, date: { type: "string", enum: ["today", "tomorrow"] } },
      },
      /** 返回固定 ToolResult，并记录真实 Core 多步生成的执行次数。 */
      async execute(input) {
        toolExecutions += 1;
        return { location: input.location, temperature: 26, source: "Open-Meteo" };
      },
    },
  ]);
  const tools = registry.buildAiSdkTools();
  /** 直接执行测试定义，生产环境由 Runtime 包装持久化和 Trace。 */
  async function executeTool(definition, input, options) {
    return definition.execute(input, options);
  }
  const toolsContext = registry.buildAiSdkToolsContext(executeTool);
  const client = createGatewayClient({
    baseUrl: "http://gateway.test",
    model: "chat-default",
    apiKey: "test-key",
    fetchImplementation: createFakeFetch(requests, handleToolLoopRequest),
  });

  const result = await client.chatCompletions({
    messages: [{ role: "user", content: "今天深圳天气" }],
    tools,
    toolsContext,
    requiredToolName: "get_weather",
  });
  const chatBodies = requests.filter(isChatRequest).map(getRequestBody);

  assert.equal(toolExecutions, 1);
  assert.equal(chatBodies.length, 2);
  assert.deepEqual(chatBodies[0].tool_choice, { type: "function", function: { name: "get_weather" } });
  assert.equal(chatBodies[0].tools[0].function.name, "get_weather");
  assert.equal(chatBodies[1].tool_choice, "auto");
  assert.equal(chatBodies[1].messages.some(isWeatherToolResultMessage), true);
  assert.equal(result.choices[0].message.content, "深圳当前 26°C，来源 Open-Meteo。");
}

test("real ToolLoopAgent forces the routed weather tool only on the first step", testRealToolLoopAgentRoutesRequiredWeatherTool);

/** 创建工具后模型失败场景，并允许测试选择无工具恢复成功或持续失败。 */
function createPostToolRecoveryScenario({ recoveryFails = false } = {}) {
  const requests = [];
  let connectorCalls = 0;

  /** 首步返回工具调用，原 Agent 后续步骤返回 503，无工具恢复按场景返回成功或失败。 */
  function handlePostToolModelFailure(request) {
    if (request.url.endsWith("/utils/token_counter")) {
      return jsonResponse({ total_tokens: 24, model: "tool-boundary-model" });
    }
    const hasToolResult = request.body.messages.some(isToolResultMessage);
    const hasToolSet = Array.isArray(request.body.tools) && request.body.tools.length > 0;
    if (hasToolResult && hasToolSet) {
      return jsonResponse({ error: { message: "temporary post-tool model failure" } }, 503);
    }
    if (hasToolResult) {
      if (recoveryFails) {
        return jsonResponse({ error: { message: "temporary recovery model failure" } }, 503);
      }
      return jsonResponse({
        id: "chatcmpl-tool-recovered",
        created: 1720000001,
        model: "tool-boundary-model",
        choices: [
          {
            index: 0,
            message: { role: "assistant", content: "深圳当前 26°C，数据时间 2026-07-31T10:00，来源 Open-Meteo。" },
            finish_reason: "stop",
          },
        ],
        usage: { prompt_tokens: 28, completion_tokens: 9, total_tokens: 37 },
      });
    }
    return jsonResponse({
      id: "chatcmpl-tool-boundary",
      created: 1720000000,
      model: "tool-boundary-model",
      choices: [
        {
          index: 0,
          message: {
            role: "assistant",
            content: null,
            tool_calls: [
              {
                id: "weather-call-retry-boundary",
                type: "function",
                function: { name: "get_weather", arguments: '{"location":"深圳","date":"today"}' },
              },
            ],
          },
          finish_reason: "tool_calls",
        },
      ],
      usage: { prompt_tokens: 20, completion_tokens: 5, total_tokens: 25 },
    });
  }

  const toolRegistry = createToolRegistry([
    {
      name: "get_weather",
      title: "实时天气",
      description: "查询今天或明天的实时天气。",
      effect: "read",
      inputSchema: z
        .object({ location: z.string().min(1), date: z.enum(["today", "tomorrow"]).default("today") })
        .strict(),
      /** 将明确天气输入固定路由到当前只读工具。 */
      matchesInput() {
        return true;
      },
      /** 模拟 Connector 返回带来源和观测时间的稳定 ToolResult。 */
      async execute(input) {
        connectorCalls += 1;
        return {
          schemaVersion: "weather.v1",
          location: { name: input.location, timezone: "Asia/Shanghai" },
          forecast: { date: "2026-07-31", temperature: { current: 26 } },
          observedAt: "2026-07-31T10:00",
          source: { name: "Open-Meteo", retrievedAt: "2026-07-31T10:01:00.000Z" },
        };
      },
    },
  ]);
  const gatewayClient = createGatewayClient({
    baseUrl: "http://gateway.test",
    model: "chat-default",
    apiKey: "test-key",
    retryBaseDelayMs: 0,
    fetchImplementation: createFakeFetch(requests, handlePostToolModelFailure),
  });
  return {
    gatewayClient,
    requests,
    toolRegistry,
    /** 返回真实 Connector 执行次数，供成功和失败路径断言。 */
    getConnectorCalls() {
      return connectorCalls;
    },
  };
}

/** 验证工具后模型瞬时错误从持久化 ToolResult 恢复，且不重放 Connector。 */
async function testRuntimeRecoversSummaryFromPersistedToolResult() {
  const scenario = createPostToolRecoveryScenario();
  const fixture = createTestRuntime(scenario);
  const conversation = fixture.runtime.createConversation();

  const response = await run(fixture.runtime, conversation.id, "tool-boundary", "今天深圳天气");
  const detail = fixture.runtime.getConversation(conversation.id);
  const chatRequests = scenario.requests.filter(isChatRequest);
  const recoveryRequest = chatRequests[2].body;
  const recoveredToolMessage = recoveryRequest.messages.find(isToolResultMessage);

  assert.equal(scenario.getConnectorCalls(), 1);
  assert.equal(chatRequests.length, 3);
  assert.equal(Array.isArray(recoveryRequest.tools), false);
  assert.equal(recoveryRequest.messages.some(isWeatherRecoveryToolCallMessage), true);
  assert.equal(recoveredToolMessage.tool_call_id, "weather-call-retry-boundary");
  assert.equal(JSON.parse(recoveredToolMessage.content).status, "success");
  assert.equal(detail.latestRun.status, "completed");
  assert.equal(detail.latestRun.toolCalls.length, 1);
  assert.equal(detail.latestRun.toolCalls[0].status, "completed");
  assert.equal(detail.latestRun.toolCalls[0].source, "Open-Meteo");
  assert.equal(detail.messages.length, 2);
  assert.equal(response.content, "深圳当前 26°C，数据时间 2026-07-31T10:00，来源 Open-Meteo。");
  assert.equal(detail.latestRun.resilience.recovered, true);
  assert.equal(detail.latestRun.resilience.retryBoundaryCrossed, true);
  assert.equal(detail.latestRun.resilience.attempts[0].stopReason, "retry-boundary-crossed");
  assert.equal(detail.latestRun.resilience.recovery.status, "completed");
  assert.equal(detail.latestRun.resilience.recovery.execution.operation, "model.tool_result_summary");
  assert.equal(detail.latestRun.resilience.recovery.execution.attemptCount, 1);
  fixture.store.close();
}

test(
  "runtime recovers the final summary from persisted ToolResult without replaying the connector",
  testRuntimeRecoversSummaryFromPersistedToolResult,
);

/** 验证无工具恢复耗尽预算后 Run 失败，同时保留两段证据且不重复 Connector。 */
async function testRuntimeFailsAfterToolResultSummaryRecoveryExhaustsBudget() {
  const scenario = createPostToolRecoveryScenario({ recoveryFails: true });
  const fixture = createTestRuntime(scenario);
  const conversation = fixture.runtime.createConversation();

  await assert.rejects(
    run(fixture.runtime, conversation.id, "tool-recovery-failure", "今天深圳天气"),
    isToolResultRecoveryFailure,
  );
  const detail = fixture.runtime.getConversation(conversation.id);
  const chatRequests = scenario.requests.filter(isChatRequest);

  assert.equal(scenario.getConnectorCalls(), 1);
  assert.equal(chatRequests.length, 5);
  assert.equal(chatRequests.slice(2).every(hasNoToolSet), true);
  assert.equal(detail.latestRun.status, "failed");
  assert.equal(detail.latestRun.toolCalls[0].status, "completed");
  assert.equal(detail.latestRun.resilience.recovered, false);
  assert.equal(detail.latestRun.resilience.attempts[0].stopReason, "retry-boundary-crossed");
  assert.equal(detail.latestRun.resilience.recovery.status, "failed");
  assert.equal(detail.latestRun.resilience.recovery.execution.attemptCount, 3);
  fixture.store.close();
}

test(
  "runtime fails with both resilience traces when ToolResult summary recovery exhausts its budget",
  testRuntimeFailsAfterToolResultSummaryRecoveryExhaustsBudget,
);

/** 判断恢复阶段最终失败是否保留原边界和三次无工具尝试证据。 */
function isToolResultRecoveryFailure(error) {
  return (
    error?.payload?.code === "model_provider_unavailable" &&
    error?.resilience?.attemptCount === 1 &&
    error.resilience.retryBoundaryCrossed === true &&
    error.resilience.recovery?.status === "failed" &&
    error.resilience.recovery.execution?.attemptCount === 3
  );
}

/** 判断恢复请求没有携带任何可执行 ToolSet。 */
function hasNoToolSet(request) {
  return !Array.isArray(request.body.tools);
}

/** 判断 OpenAI-compatible 消息是否重建了指定天气工具调用。 */
function isWeatherRecoveryToolCallMessage(message) {
  return (
    message.role === "assistant" &&
    message.tool_calls?.[0]?.id === "weather-call-retry-boundary" &&
    message.tool_calls[0].function?.name === "get_weather"
  );
}

/** 判断模型请求消息中是否已回填任意工具结果。 */
function isToolResultMessage(message) {
  return message.role === "tool";
}

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

/** 验证 AI SDK 标准事件流中的原始 API 错误不会被文本流包装成通用 502。 */
async function testGatewayPreservesEventStreamApiError() {
  const apiError = new APICallError({
    message: "INVALID_API_KEY provider secret",
    url: "http://gateway.test/v1/chat/completions",
    requestBodyValues: {},
    statusCode: 401,
    data: { error: { message: "INVALID_API_KEY provider secret" } },
  });
  /** 返回包含原始鉴权错误事件的 AI SDK 标准事件流。 */
  function streamTextImplementation() {
    return createEventStreamResult(streamParts({ type: "error", error: apiError }));
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
      // 空增量消费者强制走流式分支，错误仍应保留 AI SDK 分类。
      onTextDelta: () => {},
    }),
    isAuthorizationGatewayError,
  );
}

test("gateway client preserves API errors from the AI SDK event stream", testGatewayPreservesEventStreamApiError);

/** 判断异常是否为保留一次尝试证据的 401 鉴权错误。 */
function isAuthorizationGatewayError(error) {
  return (
    error instanceof GatewayRequestError &&
    error.status === 401 &&
    error.resilience?.attemptCount === 1 &&
    error.resilience.attempts[0].errorType === "authorization"
  );
}

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
    finalStep: Promise.resolve({
      finishReason: "stop",
      response: {
        id: "stream-test",
        modelId: "resolved-stream-model",
        timestamp: new Date("2026-07-28T00:00:00.000Z"),
      },
    }),
  };
}

/** 创建使用标准事件流的最小 AI SDK 流式结果。 */
function createEventStreamResult(stream) {
  return {
    stream,
    usage: Promise.resolve({ inputTokens: 0, outputTokens: 0, totalTokens: 0 }),
    finalStep: Promise.resolve({ finishReason: "error", response: {} }),
  };
}

/** 依次产生调用方给定的文本增量。 */
async function* streamValues(...values) {
  for (const value of values) yield value;
}

/** 依次产生 AI SDK 标准流事件。 */
async function* streamParts(...parts) {
  for (const part of parts) yield part;
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
  const count = await client.countTokens({
    model: "chat-quality",
    messages: [{ role: "user", content: "hello" }],
  });
  assert.equal(status.ok, true);
  assert.equal(status.gatewayBaseUrl, "http://gateway.test/v1");
  assert.deepEqual(status.models, ["chat-default", "chat-quality"]);
  assert.deepEqual(status.modelCapabilities, {
    chat: ["chat-default"],
    vision: ["chat-default"],
    imageGeneration: [],
    imageEditing: ["chat-default"],
  });
  assert.deepEqual(status.defaultModels, {
    "conversation.chat": "chat-default",
    "image.generate": "image-default",
    "image.edit": "chat-default",
  });
  assert.deepEqual(count, { tokens: 29, source: "litellm", model: "resolved-upstream-model" });
  assert.equal(requests[1].body.model, "chat-quality");
  assert.deepEqual(requests.map(getRequestPath), ["/v1/models", "/utils/token_counter"]);

  const emptyDirectoryClient = createGatewayClient({
    baseUrl: "http://gateway.test",
    model: "chat-default",
    apiKey: "test-key",
    fetchImplementation: createFakeFetch([], handleEmptyModelDirectory),
  });
  const emptyStatus = await emptyDirectoryClient.status();
  assert.equal(emptyStatus.ok, true);
  assert.deepEqual(emptyStatus.models, []);
  assert.deepEqual(emptyStatus.modelCapabilities, {
    chat: [],
    vision: [],
    imageGeneration: [],
    imageEditing: [],
  });
}

test("gateway client retains LiteLLM status and token counter", testAiSdkManagementEndpoints);

/** 模拟网关可达但当前 key 没有任何可见模型。 */
function handleEmptyModelDirectory(request) {
  if (request.url.endsWith("/v1/models")) return jsonResponse({ data: [] });
  return handleSuccessfulGatewayRequest(request);
}

/** 验证当前 key 可见的非默认别名可用于单次生成，未知别名在 GatewayClient 边界拒绝。 */
async function testPerRunModelSelection() {
  const requests = [];
  const client = createGatewayClient({
    baseUrl: "http://gateway.test",
    model: "chat-default",
    modelCapabilities: {
      chat: ["chat-default", "chat-quality"],
      vision: ["chat-default"],
    },
    apiKey: "test-key",
    fetchImplementation: createFakeFetch(requests, handleSuccessfulGatewayRequest),
  });
  await client.status();
  await client.chatCompletions({
    model: "chat-quality",
    messages: [{ role: "user", content: "hello" }],
  });

  const chatRequest = requests.find(isChatRequest);
  assert.equal(chatRequest.body.model, "chat-quality");
  await assert.rejects(
    client.chatCompletions({ model: "chat-hidden", messages: [{ role: "user", content: "hello" }] }),
    isUnsupportedModelError,
  );
}

test("gateway client routes a gateway-visible model per run", testPerRunModelSelection);

/** 验证可见图片别名不能进入 Chat Completions，视觉输入还必须满足 vision 分组。 */
async function testConversationCapabilityGuards() {
  const requests = [];
  /** 只允许能力校验读取模型目录；任何生成请求都表示前置门禁失效。 */
  function handleCapabilityDirectoryRequest(request) {
    if (request.url.endsWith("/v1/models")) {
      return jsonResponse({ data: [{ id: "chat-default" }, { id: "chat-text" }, { id: "image-default" }] });
    }
    throw new Error(`Unexpected model generation request: ${request.url}`);
  }
  const client = createGatewayClient({
    baseUrl: "http://gateway.test",
    model: "chat-default",
    imageModel: "image-default",
    modelCapabilities: {
      chat: ["chat-default", "chat-text"],
      vision: ["chat-default"],
      imageGeneration: ["image-default"],
      imageEditing: ["image-default"],
    },
    apiKey: "test-key",
    fetchImplementation: createFakeFetch(requests, handleCapabilityDirectoryRequest),
  });

  await assert.rejects(
    client.chatCompletions({
      model: "image-default",
      messages: [{ role: "user", content: "解释这个问题" }],
    }),
    isModelCapabilityMismatch,
  );
  await assert.rejects(
    client.chatCompletions({
      model: "chat-text",
      messages: [{
        role: "user",
        content: [
          { type: "text", text: "这张图片是什么" },
          { type: "image_url", image_url: { url: "data:image/png;base64,YQ==" } },
        ],
      }],
    }),
    isVisionCapabilityMismatch,
  );
  assert.deepEqual(requests.map(getRequestPath), ["/v1/models"]);
}

test("gateway client rejects conversation and vision capability mismatches before generation", testConversationCapabilityGuards);

/** 验证不属于对应图片能力组的模型不能进入生成或 Responses 编辑端点。 */
async function testImageCapabilityGuards() {
  const requests = [];
  /** 只返回可见目录，能力错配不得继续触发任何图片端点。 */
  function handleCapabilityDirectoryRequest(request) {
    if (request.url.endsWith("/v1/models")) {
      return jsonResponse({ data: [{ id: "chat-default" }, { id: "image-default" }, { id: "edit-default" }] });
    }
    throw new Error(`Unexpected image generation request: ${request.url}`);
  }
  const client = createGatewayClient({
    baseUrl: "http://gateway.test",
    model: "chat-default",
    imageModel: "image-default",
    imageEditModel: "edit-default",
    modelCapabilities: {
      chat: ["chat-default"],
      vision: ["chat-default"],
      imageGeneration: ["image-default"],
      imageEditing: ["edit-default"],
    },
    apiKey: "test-key",
    fetchImplementation: createFakeFetch(requests, handleCapabilityDirectoryRequest),
  });
  const sourceBytes = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
    "base64",
  );

  await assert.rejects(
    client.generateImages({ model: "chat-default", prompt: "生成图片" }),
    isImageGenerationCapabilityMismatch,
  );
  await assert.rejects(
    client.editImages({
      model: "chat-default",
      prompt: "编辑图片",
      sourceImages: [{ bytes: sourceBytes, mediaType: "image/png" }],
    }),
    isImageEditingCapabilityMismatch,
  );
  assert.deepEqual(requests, []);
}

test("gateway client rejects capability-incompatible image models", testImageCapabilityGuards);

/** 判断异常是否为未知模型别名产生的稳定 400。 */
function isUnsupportedModelError(error) {
  return error instanceof GatewayRequestError && error.status === 400 && error.data?.code === "unsupported_model";
}

/** 判断错误是否为普通对话选择图片模型产生的稳定能力错配。 */
function isModelCapabilityMismatch(error) {
  return error instanceof GatewayRequestError &&
    error.status === 400 &&
    error.data?.code === "model_capability_mismatch" &&
    error.data?.requiredCapability === "chat";
}

/** 判断错误是否为含图对话使用纯文本模型产生的 vision 能力错配。 */
function isVisionCapabilityMismatch(error) {
  return error instanceof GatewayRequestError &&
    error.status === 400 &&
    error.data?.code === "model_capability_mismatch" &&
    error.data?.requiredCapability === "vision";
}

/** 判断错误是否为聊天模型不能用于图片生成。 */
function isImageGenerationCapabilityMismatch(error) {
  return error instanceof GatewayRequestError &&
    error.data?.code === "model_capability_mismatch" &&
    error.data?.operation === "image.generate";
}

/** 判断错误是否为聊天模型不能用于图片编辑。 */
function isImageEditingCapabilityMismatch(error) {
  return error instanceof GatewayRequestError &&
    error.data?.code === "model_capability_mismatch" &&
    error.data?.operation === "image.edit";
}

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

/** 判断 OpenAI-compatible 消息是否携带天气工具执行结果。 */
function isWeatherToolResultMessage(message) {
  return message.role === "tool" && message.tool_call_id === "weather-call-real-agent";
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
    const normalizedRequest = input instanceof Request ? input.clone() : new Request(url, init);
    const headers = new Headers(normalizedRequest.headers);
    const contentType = String(headers.get("content-type") || "");
    let body = null;
    if (/^multipart\/form-data\b/i.test(contentType)) {
      body = await normalizedRequest.formData();
    } else {
      const rawBody = await normalizedRequest.text();
      body = rawBody ? JSON.parse(rawBody) : null;
    }
    const request = {
      url,
      headers,
      body,
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

/** 创建由指定字节块组成的可取消 Response，用于验证真实网络分块边界。 */
function streamedResponse(chunks, { status = 200, headers = {}, observation = null } = {}) {
  let chunkIndex = 0;
  const stream = new ReadableStream({
    /** 按需发送下一个字节块，使 Adapter 必须通过 reader 累计实际响应体积。 */
    pull(controller) {
      if (chunkIndex >= chunks.length) {
        controller.close();
        return;
      }
      controller.enqueue(chunks[chunkIndex]);
      chunkIndex += 1;
    },
    /** 记录 Adapter 超限后是否主动取消未消费完的响应体。 */
    cancel() {
      if (observation) observation.cancelCount += 1;
    },
  });
  return new Response(stream, {
    status,
    headers: { "Content-Type": "application/json", ...headers },
  });
}

/** 创建 30 个复用的 1 MiB 字节块，在越界点后保留未消费数据以验证主动取消。 */
function createOversizedResponsesChunks() {
  const chunk = new Uint8Array(1024 * 1024);
  chunk.fill(0x20);
  return new Array(30).fill(chunk);
}

/** 返回尝试状态，供平台重试顺序断言复用。 */
function readAttemptStatus(attempt) {
  return attempt.status;
}
