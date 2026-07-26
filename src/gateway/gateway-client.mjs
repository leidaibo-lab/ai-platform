import { APICallError, generateText } from "ai";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { GatewayRequestError } from "./gateway-contract.mjs";
import { createLiteLlmManagementClient } from "./litellm-management-client.mjs";

const DEFAULT_REQUEST_TIMEOUT_MS = 120000;
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
 * @param {number} [options.timeoutMs=120000] - 单次模型生成超时毫秒数。
 * @param {typeof fetch} [options.fetchImplementation] - 可选 fetch 注入，供协议测试使用。
 * @param {object} [dependencies] - 可替换的 AI SDK 依赖，供单元测试隔离 SDK 行为。
 * @returns {import("./gateway-contract.mjs").GatewayClient} 供 Runtime 使用的统一客户端。
 */
export function createGatewayClient(
  {
    baseUrl,
    model,
    apiKey,
    timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
    fetchImplementation = fetch,
  },
  {
    generateTextImplementation = generateText,
    createProvider = createOpenAICompatible,
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
    countTokens: managementClient.countTokens,

    /**
     * 通过 AI SDK 生成文本，并映射回现有 OpenAI-compatible 响应结构。
     *
     * @param {object} input - Runtime 的模型生成参数。
     * @param {Array<object>} input.messages - OpenAI-compatible 消息列表。
     * @param {number} [input.temperature] - 可选采样温度。
     * @param {number} [input.maxCompletionTokens] - 模型输出硬上限。
     * @param {object} [input.responseFormat] - 需要原样转发给 LiteLLM 的结构化输出约束。
     * @param {AbortSignal} [input.abortSignal] - 可选外部取消信号。
     * @returns {Promise<object>} 与既有 Runtime 契约等价的 chat completions 结果。
     */
    async chatCompletions({
      messages,
      temperature,
      maxCompletionTokens,
      responseFormat,
      abortSignal,
    }) {
      try {
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
        const requestModel = provider.chatModel(modelAlias);
        const result = await generateTextImplementation({
          model: requestModel,
          messages: toAiSdkMessages(messages),
          allowSystemInMessages: true,
          ...(temperature === undefined ? {} : { temperature }),
          ...(maxCompletionTokens === undefined ? {} : { maxOutputTokens: maxCompletionTokens }),
          maxRetries: 0,
          timeout: timeoutMs,
          ...(abortSignal === undefined ? {} : { abortSignal }),
        });
        return mapGenerateTextResult(result, modelAlias);
      } catch (error) {
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

/** 将 AI SDK 与网络异常转换为现有 GatewayRequestError。 */
function mapAiSdkError(error, abortSignal) {
  if (error instanceof GatewayRequestError) return error;
  if (APICallError.isInstance(error)) {
    const data = readApiErrorData(error);
    return withCause(
      new GatewayRequestError(
        readGatewayErrorMessage(data, error.message),
        error.statusCode || 502,
        data,
      ),
      error,
    );
  }
  if (abortSignal?.aborted) {
    return withCause(new GatewayRequestError("Gateway request was aborted", 499, { error: "Request aborted" }), error);
  }
  if (error?.name === "TimeoutError" || error?.name === "AbortError") {
    return withCause(new GatewayRequestError("Gateway request timed out", 504, { error: "Request timed out" }), error);
  }
  return withCause(
    new GatewayRequestError(error?.message || "AI SDK model generation failed", 502, {
      error: "AI SDK model generation failed",
    }),
    error,
  );
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
