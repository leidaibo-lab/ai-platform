import { APICallError, generateText, streamText } from "ai";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import {
  RetryDeadlineError,
  RetryExecutionError,
  createResilienceContext,
  executeWithRetry,
} from "../resilience/retry-executor.mjs";
import { GatewayRequestError } from "./gateway-contract.mjs";
import { createLiteLlmManagementClient } from "./litellm-management-client.mjs";

const DEFAULT_REQUEST_TIMEOUT_MS = 120000;
const DEFAULT_MAX_ATTEMPTS = 3;
const DEFAULT_RETRY_BASE_DELAY_MS = 500;
const DEFAULT_RETRY_MAX_DELAY_MS = 5000;
const RETRYABLE_MODEL_STATUS_CODES = new Set([408, 429, 500, 502, 503, 504]);
const SUPPORTED_MESSAGE_ROLES = new Set(["system", "user", "assistant"]);

export { GatewayRequestError } from "./gateway-contract.mjs";

/**
 * 创建 Runtime 到 LiteLLM 的唯一模型网关客户端。
 * Facade 模式把 AI SDK 模型生成和 LiteLLM 管理端点组合为稳定 GatewayClient Port。
 *
 * @param {object} options - LiteLLM 连接和模型配置。
 * @param {string} options.baseUrl - LiteLLM Proxy 根地址，不包含 `/v1`。
 * @param {string} options.model - Runtime 使用的 LiteLLM 模型别名。
 * @param {string} options.apiKey - LiteLLM master key 或 virtual key。
 * @param {number} [options.timeoutMs=120000] - 未传 Run 截止时间时使用的模型调用总预算。
 * @param {number} [options.maxAttempts=3] - 包含首次调用的最大模型尝试次数。
 * @param {number} [options.retryBaseDelayMs=500] - 指数退避基础毫秒数。
 * @param {number} [options.retryMaxDelayMs=5000] - 单次平台退避上限毫秒数。
 * @param {typeof fetch} [options.fetchImplementation] - 可选 fetch 注入，供协议测试使用。
 * @param {object} [dependencies] - 可替换的 AI SDK、时钟和等待依赖，供单元测试隔离外部行为。
 * @returns {import("./gateway-contract.mjs").GatewayClient} 供 Runtime 使用的统一客户端。
 */
export function createGatewayClient(
  {
    baseUrl,
    model,
    apiKey,
    timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
    maxAttempts = DEFAULT_MAX_ATTEMPTS,
    retryBaseDelayMs = DEFAULT_RETRY_BASE_DELAY_MS,
    retryMaxDelayMs = DEFAULT_RETRY_MAX_DELAY_MS,
    fetchImplementation = fetch,
  },
  {
    generateTextImplementation = generateText,
    streamTextImplementation = streamText,
    createProvider = createOpenAICompatible,
    nowImplementation = Date.now,
    sleepImplementation,
    randomImplementation = Math.random,
  } = {},
) {
  const managementClient = createLiteLlmManagementClient({
    baseUrl,
    model,
    apiKey,
    fetchImplementation,
  });
  const gatewayRootUrl = managementClient.baseUrl;
  const modelAlias = managementClient.model;
  const key = apiKey || "sk-local-admin-key";

  return {
    baseUrl: gatewayRootUrl,
    gatewayBaseUrl: managementClient.gatewayBaseUrl,
    model: modelAlias,
    status: managementClient.status,
    listModels: managementClient.listModels,
    resolveModel: managementClient.resolveModel,
    countTokens: managementClient.countTokens,

    /**
     * 通过 AI SDK 生成文本，并映射回现有 OpenAI-compatible 响应结构。
     *
     * @param {object} input - Runtime 的模型生成参数。
     * @param {Array<object>} input.messages - OpenAI-compatible 消息列表。
     * @param {string} [input.model] - 当前 Run 选择的 LiteLLM 模型别名。
     * @param {number} [input.temperature] - 可选采样温度。
     * @param {number} [input.maxCompletionTokens] - 模型输出硬上限。
     * @param {object} [input.responseFormat] - 需要原样转发给 LiteLLM 的结构化输出约束。
     * @param {import("../resilience/retry-executor.mjs").ResilienceContext} [input.resilienceContext] - Runtime 共享截止时间和幂等边界。
     * @param {string} [input.operation="model.generate"] - 写入逐尝试证据的操作名称。
     * @param {(delta: string) => Promise<void>|void} [input.onTextDelta] - 模型文本增量消费者；存在时启用 AI SDK 文本流。
     * @param {AbortSignal} [input.abortSignal] - 可选外部取消信号。
     * @returns {Promise<object>} 与既有 Runtime 契约等价的 chat completions 结果。
     */
    async chatCompletions({
      messages,
      model: requestedModel,
      temperature,
      maxCompletionTokens,
      responseFormat,
      resilienceContext,
      operation = "model.generate",
      onTextDelta,
      abortSignal,
    }) {
      const selectedModel = await managementClient.resolveModel(requestedModel);
      const provider = createProvider({
        name: "litellm",
        baseURL: `${gatewayRootUrl}/v1`,
        apiKey: key,
        fetch: fetchImplementation,
        supportedUrls: getSupportedUrls,
        transformRequestBody: createRequestBodyTransformer({
          maxCompletionTokens,
          responseFormat,
        }),
      });
      const requestModel = provider.chatModel(selectedModel);
      const modelMessages = toAiSdkMessages(messages);
      const context = createResilienceContext({
        ...(resilienceContext || {}),
        deadlineAt: resilienceContext?.deadlineAt ?? nowImplementation() + timeoutMs,
        stage: operation,
      });
      const retryPolicy = createModelRetryPolicy({
        operation,
        maxAttempts,
        retryBaseDelayMs,
        retryMaxDelayMs,
        randomImplementation,
      });

      /** 执行一次 AI SDK 模型调用，并把 SDK 内建重试固定为关闭。 */
      async function generateAttempt({ attempt, remainingMs, markOutputStarted }) {
        const telemetryInput = createAiSdkTelemetryInput(context, attempt, operation);
        try {
          if (typeof onTextDelta === "function") {
            return await streamGenerateAttempt({
              requestModel,
              modelMessages,
              temperature,
              maxCompletionTokens,
              remainingMs,
              abortSignal,
              onTextDelta,
              markOutputStarted,
              streamTextImplementation,
              fallbackModel: selectedModel,
              ...telemetryInput,
            });
          }
          const result = await generateTextImplementation({
            model: requestModel,
            messages: modelMessages,
            allowSystemInMessages: true,
            ...(temperature === undefined ? {} : { temperature }),
            ...(maxCompletionTokens === undefined ? {} : { maxOutputTokens: maxCompletionTokens }),
            maxRetries: 0,
            timeout: Math.max(1, remainingMs),
            ...(abortSignal === undefined ? {} : { abortSignal }),
            ...telemetryInput,
          });
          return mapGenerateTextResult(result, selectedModel);
        } catch (error) {
          throw mapAiSdkError(error, abortSignal, nowImplementation());
        }
      }

      try {
        const execution = await executeWithRetry({
          context,
          policy: retryPolicy,
          task: generateAttempt,
          nowImplementation,
          sleepImplementation,
          abortSignal,
        });
        return { ...execution.value, resilience: execution.resilience };
      } catch (error) {
        if (error instanceof RetryExecutionError) {
          const gatewayError = mapAiSdkError(error.cause, abortSignal, nowImplementation());
          gatewayError.resilience = error.resilience;
          throw gatewayError;
        }
        throw mapAiSdkError(error, abortSignal);
      }
    },
  };
}

/** 声明 LiteLLM 可原样接收的图片 URL，阻止 AI SDK 在 Runtime 侧提前下载。 */
function getSupportedUrls() {
  return {
    "image/*": [/^https?:\/\//i, /^data:image\//i],
  };
}

/** 将 OpenAI-compatible 消息数组转换为 AI SDK v7 ModelMessage。 */
export function toAiSdkMessages(messages) {
  if (!Array.isArray(messages) || messages.length === 0) {
    throw new GatewayRequestError("messages must be a non-empty array", 400, {
      error: "Invalid model messages",
    });
  }
  return messages.map(toAiSdkMessage);
}

/** 将单条 Runtime 消息转换为 AI SDK ModelMessage。 */
function toAiSdkMessage(message) {
  if (!SUPPORTED_MESSAGE_ROLES.has(message?.role)) {
    throw new GatewayRequestError("Unsupported model message role", 400, {
      error: "Unsupported model message role",
      role: message?.role || "unknown",
    });
  }
  if (!Array.isArray(message?.content)) {
    if (typeof message?.content !== "string") {
      throw new GatewayRequestError("Model message content must be text or content parts", 400, {
        error: "Invalid model message content",
      });
    }
    return { role: message.role, content: String(message.content || "") };
  }
  if (message.role !== "user") {
    throw new GatewayRequestError("Content parts are only supported for user messages", 400, {
      error: "Invalid model message content",
      role: message.role,
    });
  }
  return {
    role: message.role,
    content: message.content.map(toAiSdkContentPart),
  };
}

/** 将文本或 OpenAI `image_url` part 转换为 AI SDK v7 content part。 */
function toAiSdkContentPart(part) {
  if (part?.type === "text") return { type: "text", text: String(part.text || "") };
  if (part?.type === "image_url" && part.image_url?.url) {
    return {
      type: "file",
      mediaType: "image",
      data: { type: "url", url: new URL(part.image_url.url) },
    };
  }
  throw new GatewayRequestError("Unsupported model message content", 400, {
    error: "Unsupported model message content",
    type: part?.type || "unknown",
  });
}

/** 创建最终请求体转换器，保留现有 LiteLLM 字段语义。 */
function createRequestBodyTransformer({ maxCompletionTokens, responseFormat }) {
  /** 把 AI SDK 的 max_tokens 改回当前契约字段，并原样注入 response_format。 */
  function transformRequestBody(body) {
    const transformed = { ...body };
    if (maxCompletionTokens !== undefined) {
      delete transformed.max_tokens;
      transformed.max_completion_tokens = maxCompletionTokens;
    }
    if (responseFormat !== undefined) transformed.response_format = responseFormat;
    return transformed;
  }
  return transformRequestBody;
}

/** 将 AI SDK `generateText` 结果映射为现有 chat completions 结果。 */
function mapGenerateTextResult(result, fallbackModel) {
  const response = result?.finalStep?.response || result?.response || {};
  const timestamp = response.timestamp instanceof Date ? response.timestamp : new Date();
  return {
    id: response.id,
    object: "chat.completion",
    created: Math.floor(timestamp.getTime() / 1000),
    model: response.modelId || fallbackModel,
    choices: [
      {
        index: 0,
        message: { role: "assistant", content: result?.text || "" },
        finish_reason: mapFinishReason(result?.finishReason),
      },
    ],
    usage: mapUsage(result?.usage),
  };
}

/**
 * 消费一次 AI SDK 文本流，在首个非空增量前保留重试资格，并返回既有 completion 契约。
 *
 * @param {object} input - 当前流式尝试的模型、参数和增量回调。
 * @returns {Promise<object>} 完整模型结果，供 Runtime 最终一次性落库。
 */
async function streamGenerateAttempt({
  requestModel,
  modelMessages,
  temperature,
  maxCompletionTokens,
  remainingMs,
  abortSignal,
  onTextDelta,
  markOutputStarted,
  streamTextImplementation,
  fallbackModel,
  telemetry,
  runtimeContext,
}) {
  const result = await streamTextImplementation({
    model: requestModel,
    messages: modelMessages,
    allowSystemInMessages: true,
    ...(temperature === undefined ? {} : { temperature }),
    ...(maxCompletionTokens === undefined ? {} : { maxOutputTokens: maxCompletionTokens }),
    maxRetries: 0,
    timeout: Math.max(1, remainingMs),
    ...(abortSignal === undefined ? {} : { abortSignal }),
    onError: suppressAiSdkStreamErrorLogging,
    telemetry,
    runtimeContext,
  });
  let text = "";
  const hasFullStream = result.fullStream !== undefined && result.fullStream !== null;
  const stream = hasFullStream ? result.fullStream : result.textStream;
  for await (const part of stream) {
    if (hasFullStream && part?.type === "error") throw part.error;
    const delta = hasFullStream ? (part?.type === "text-delta" ? part.text : "") : part;
    if (!delta) continue;
    markOutputStarted();
    text += delta;
    await onTextDelta(delta);
  }
  const [usage, finishReason, response] = await Promise.all([
    result.usage,
    result.finishReason,
    result.response,
  ]);
  return mapGenerateTextResult({ text, usage, finishReason, response }, fallbackModel);
}

/** 禁用 AI SDK 默认的原始错误控制台输出；异常仍由 fullStream 交给 Runtime 安全映射。 */
function suppressAiSdkStreamErrorLogging() {}

/** 为一次平台重试尝试构造只包含安全业务 ID 的 AI SDK Telemetry 输入。 */
function createAiSdkTelemetryInput(context, attempt, operation) {
  const runtimeContext = {
    chainTraceId: context.traceId || undefined,
    requestId: context.requestId || undefined,
    conversationId: context.conversationId || undefined,
    runId: context.runId || undefined,
    attempt,
    scenarioId: "C1",
    operation,
  };
  return {
    runtimeContext,
    telemetry: {
      functionId: operation === "memory.compact" ? "c1.memory.compact" : "c1.model.generate",
      recordInputs: false,
      recordOutputs: false,
      includeRuntimeContext: {
        chainTraceId: true,
        requestId: true,
        conversationId: true,
        runId: true,
        attempt: true,
        scenarioId: true,
        operation: true,
      },
    },
  };
}

/** 把 AI SDK finish reason 转换为 OpenAI-compatible 命名。 */
function mapFinishReason(reason) {
  if (reason === "content-filter") return "content_filter";
  if (reason === "tool-calls") return "tool_calls";
  return reason || "other";
}

/** 保留 provider 原始 usage，并补齐 Runtime 依赖的 OpenAI token 字段。 */
function mapUsage(usage) {
  if (!usage) return null;
  const result = isPlainObject(usage.raw) ? { ...usage.raw } : {};
  if (Number.isFinite(usage.inputTokens)) result.prompt_tokens = usage.inputTokens;
  if (Number.isFinite(usage.outputTokens)) result.completion_tokens = usage.outputTokens;
  if (Number.isFinite(usage.totalTokens)) result.total_tokens = usage.totalTokens;
  return Object.keys(result).length > 0 ? result : null;
}

/** 将 AI SDK 与网络异常转换为现有 GatewayRequestError，并保留可执行的 Retry-After。 */
function mapAiSdkError(error, abortSignal, now = Date.now()) {
  if (error instanceof GatewayRequestError) return error;
  if (error instanceof RetryDeadlineError) {
    return markRetryable(
      withCause(new GatewayRequestError("Gateway request timed out", 504, { error: "Request timed out" }), error),
      false,
    );
  }
  if (APICallError.isInstance(error)) {
    const data = readApiErrorData(error);
    const gatewayError = withCause(
      new GatewayRequestError(
        readGatewayErrorMessage(data, error.message),
        error.statusCode || 502,
        data,
      ),
      error,
    );
    gatewayError.retryAfterMs = readRetryAfterMs(error.responseHeaders, now);
    return markRetryable(gatewayError, RETRYABLE_MODEL_STATUS_CODES.has(Number(gatewayError.status)));
  }
  if (abortSignal?.aborted) {
    return markRetryable(
      withCause(new GatewayRequestError("Gateway request was aborted", 499, { error: "Request aborted" }), error),
      false,
    );
  }
  if (error?.name === "TimeoutError" || error?.name === "AbortError") {
    return markRetryable(
      withCause(new GatewayRequestError("Gateway request timed out", 504, { error: "Request timed out" }), error),
      true,
    );
  }
  return markRetryable(
    withCause(
      new GatewayRequestError(error?.message || "AI SDK model generation failed", 502, {
        error: "AI SDK model generation failed",
      }),
      error,
    ),
    false,
  );
}

/** 创建模型阶段专属的错误重试、分类和指数退避策略。 */
function createModelRetryPolicy({ operation, maxAttempts, retryBaseDelayMs, retryMaxDelayMs, randomImplementation }) {
  const normalizedMaxAttempts = normalizePositiveInteger(maxAttempts, DEFAULT_MAX_ATTEMPTS);
  const baseDelayMs = normalizeNonNegativeNumber(retryBaseDelayMs, DEFAULT_RETRY_BASE_DELAY_MS);
  const maxDelayMs = normalizeNonNegativeNumber(retryMaxDelayMs, DEFAULT_RETRY_MAX_DELAY_MS);

  /** 优先遵守 Retry-After，否则使用带抖动的指数退避。 */
  function calculateBackoffMs(error, { attempt }) {
    if (Number.isFinite(error?.retryAfterMs) && error.retryAfterMs >= 0) return Math.floor(error.retryAfterMs);
    const exponential = Math.min(maxDelayMs, baseDelayMs * 2 ** Math.max(0, attempt - 1));
    return Math.floor(exponential * (0.5 + 0.5 * randomImplementation()));
  }

  return {
    operation: String(operation || "model.generate"),
    maxAttempts: normalizedMaxAttempts,
    shouldRetry: isRetryableModelError,
    calculateBackoffMs,
    describeError: describeGatewayError,
  };
}

/** 只允许瞬时网络、限流和服务端故障进入自动重试。 */
function isRetryableModelError(error) {
  if (typeof error?.retryable === "boolean") return error.retryable;
  return RETRYABLE_MODEL_STATUS_CODES.has(Number(error?.status));
}

/** 将网关错误转换为不包含请求正文和凭据的稳定分类。 */
function describeGatewayError(error) {
  const statusCode = Number(error?.status);
  let errorType = "network";
  if (statusCode === 429) errorType = "rate_limit";
  else if (statusCode === 408 || statusCode === 504) errorType = "timeout";
  else if (statusCode >= 500) errorType = "provider_unavailable";
  else if (statusCode === 499) errorType = "cancelled";
  else if (statusCode === 401 || statusCode === 403) errorType = "authorization";
  else if (statusCode >= 400) errorType = "invalid_request";
  return { errorType, statusCode: Number.isFinite(statusCode) ? statusCode : null };
}

/** 从 AI SDK 响应头读取毫秒或标准 Retry-After，并转换为等待毫秒数。 */
function readRetryAfterMs(responseHeaders, now) {
  const retryAfterMsHeader = readHeader(responseHeaders, "retry-after-ms");
  const retryAfterMs = Number(retryAfterMsHeader);
  if (retryAfterMsHeader !== null && retryAfterMsHeader !== "" && Number.isFinite(retryAfterMs) && retryAfterMs >= 0) {
    return Math.floor(retryAfterMs);
  }
  const retryAfter = readHeader(responseHeaders, "retry-after");
  if (!retryAfter) return null;
  const seconds = Number(retryAfter);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.floor(seconds * 1000);
  const dateMs = Date.parse(retryAfter);
  return Number.isFinite(dateMs) ? Math.max(0, dateMs - now) : null;
}

/** 兼容 Headers 和 AI SDK 的小写响应头对象。 */
function readHeader(headers, name) {
  if (headers && typeof headers.get === "function") return headers.get(name);
  return headers?.[name] ?? headers?.[name.toLowerCase()] ?? null;
}

/** 将尝试次数规范为正整数，无效配置回退默认值。 */
function normalizePositiveInteger(value, fallback) {
  const normalized = Number(value);
  return Number.isInteger(normalized) && normalized > 0 ? normalized : fallback;
}

/** 将退避配置规范为非负数，无效配置回退默认值。 */
function normalizeNonNegativeNumber(value, fallback) {
  const normalized = Number(value);
  return Number.isFinite(normalized) && normalized >= 0 ? normalized : fallback;
}

/** 按 Gateway Client 的优先级从 LiteLLM 错误载荷读取可读消息。 */
function readGatewayErrorMessage(data, fallback) {
  if (typeof data?.error?.message === "string" && data.error.message) return data.error.message;
  if (typeof data?.error === "string" && data.error) return data.error;
  if (typeof data?.message === "string" && data.message) return data.message;
  return fallback || "Gateway request failed";
}

/** 从 API 错误中读取可诊断数据，同时避免把请求体和凭据上抛。 */
function readApiErrorData(error) {
  if (error.data !== undefined) return error.data;
  return parseJson(error.responseBody);
}

/** 尝试解析响应错误 JSON，非 JSON 内容只保留为错误字符串。 */
function parseJson(value) {
  try {
    return value ? JSON.parse(value) : {};
  } catch {
    return { error: String(value || "Gateway request failed") };
  }
}

/** 判断值是否为可安全展开的普通对象。 */
function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

/** 给兼容错误补充原始异常 cause，并返回同一错误实例。 */
function withCause(gatewayError, cause) {
  gatewayError.cause = cause;
  return gatewayError;
}

/** 给统一网关错误补充平台重试判定，并返回同一错误实例。 */
function markRetryable(gatewayError, retryable) {
  gatewayError.retryable = Boolean(retryable);
  return gatewayError;
}
