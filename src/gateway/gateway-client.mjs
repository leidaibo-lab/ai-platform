import { APICallError, Output, ToolLoopAgent, generateImage, generateText, jsonSchema, stepCountIs, streamText } from "ai";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { z } from "zod";
import {
  RetryDeadlineError,
  RetryExecutionError,
  createResilienceContext,
  executeWithRetry,
} from "../resilience/retry-executor.mjs";
import { GatewayRequestError } from "./gateway-contract.mjs";
import { createLiteLlmManagementClient } from "./litellm-management-client.mjs";
import { createResponsesImageEditAdapter } from "./responses-image-edit-adapter.mjs";

const DEFAULT_REQUEST_TIMEOUT_MS = 120000;
const DEFAULT_MAX_ATTEMPTS = 3;
const DEFAULT_RETRY_BASE_DELAY_MS = 500;
const DEFAULT_RETRY_MAX_DELAY_MS = 5000;
const RETRYABLE_MODEL_STATUS_CODES = new Set([408, 429, 500, 502, 503, 504]);
const SUPPORTED_MESSAGE_ROLES = new Set(["system", "user", "assistant", "tool"]);
const MODEL_CAPABILITY_KEYS = ["chat", "vision", "imageGeneration", "imageEditing"];
const CONVERSATION_AGENT_CALL_OPTIONS_SCHEMA = z
  .object({
    model: z.string().min(1),
    tools: z.record(z.string(), z.custom(isAiSdkTool)),
    requiredToolName: z.string().min(1).nullable(),
    maxToolSteps: z.number().int().min(1).max(8),
    temperature: z.number().optional(),
    maxCompletionTokens: z.number().optional(),
    operation: z.string().min(1),
  })
  .strict();

export { GatewayRequestError } from "./gateway-contract.mjs";

/**
 * 创建 Runtime 到 LiteLLM 的唯一模型网关客户端。
 * Facade 模式把 AI SDK 模型生成、Responses 图片编辑 Adapter 和 LiteLLM 管理端点组合为稳定 GatewayClient Port。
 *
 * @param {object} options - LiteLLM 连接和模型配置。
 * @param {string} options.baseUrl - LiteLLM Proxy 根地址，不包含 `/v1`。
 * @param {string} options.model - Runtime 使用的 LiteLLM 模型别名。
 * @param {string} [options.imageModel="image-default"] - Runtime 使用的 LiteLLM 图片模型别名。
 * @param {string} [options.imageEditModel=options.model] - Runtime 使用的 Responses 图片编辑模型别名。
 * @param {{chat?: string[], vision?: string[], imageGeneration?: string[], imageEditing?: string[]}} [options.modelCapabilities] - 服务端声明的模型能力分组；不从 `/v1/models` 猜测。
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
    imageModel = "image-default",
    imageEditModel = model,
    modelCapabilities,
    apiKey,
    timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
    maxAttempts = DEFAULT_MAX_ATTEMPTS,
    retryBaseDelayMs = DEFAULT_RETRY_BASE_DELAY_MS,
    retryMaxDelayMs = DEFAULT_RETRY_MAX_DELAY_MS,
    fetchImplementation = fetch,
  },
  {
    generateImageImplementation = generateImage,
    generateTextImplementation = generateText,
    streamTextImplementation = streamText,
    stepCountIsImplementation = stepCountIs,
    createToolLoopAgent = createToolLoopAgentInstance,
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
  const imageModelAlias = String(imageModel || "image-default").trim() || "image-default";
  const imageEditModelAlias = String(imageEditModel || modelAlias).trim() || modelAlias;
  const configuredModelCapabilities = normalizeModelCapabilities(modelCapabilities, {
    chat: [modelAlias],
    vision: [modelAlias],
    imageGeneration: [imageModelAlias],
    imageEditing: [imageEditModelAlias],
  });
  const key = apiKey || "sk-local-admin-key";
  const conversationProvider = createProvider({
    name: "litellm",
    baseURL: `${gatewayRootUrl}/v1`,
    apiKey: key,
    fetch: fetchImplementation,
    supportedUrls: getSupportedUrls,
    transformRequestBody: createAgentRequestBodyTransformer(),
  });
  const imageProvider = createProvider({
    name: "litellm-image",
    baseURL: `${gatewayRootUrl}/v1`,
    apiKey: key,
    fetch: fetchImplementation,
  });
  const responsesImageEditAdapter = createResponsesImageEditAdapter({
    baseUrl: `${gatewayRootUrl}/v1`,
    apiKey: key,
    fetchImplementation,
  });
  const conversationAgent = createToolLoopAgent({
    id: "ai-platform-conversation",
    model: conversationProvider.chatModel(modelAlias),
    allowSystemInMessages: true,
    maxRetries: 0,
    callOptionsSchema: CONVERSATION_AGENT_CALL_OPTIONS_SCHEMA,
    prepareCall: createConversationAgentCallPreparer({ conversationProvider, stepCountIsImplementation }),
    prepareStep: prepareConversationAgentStep,
  });

  /**
   * 执行一次有副作用的图片模型请求，统一生成/编辑的别名、截止时间、取消和无重试证据。
   *
   * @param {object} input - 图片请求和稳定执行边界。
   * @returns {Promise<object>} 图片字节、最小 usage 和单次尝试证据。
   */
  async function executeImageRequest({
    prompt,
    sourceImages = [],
    model: requestedModel,
    size = "1024x1024",
    operation,
    resilienceContext,
    abortSignal,
  }) {
    const selectedModel = await resolveConfiguredImageModel(
      managementClient,
      configuredModelCapabilities,
      requestedModel,
      operation,
    );
    const context = createResilienceContext({
      ...(resilienceContext || {}),
      deadlineAt: resilienceContext?.deadlineAt ?? nowImplementation() + timeoutMs,
      stage: operation,
    });
    const policy = createImageGenerationRetryPolicy(operation);

    /** 执行唯一一次图片模型调用；发起请求即越过不可静默重试边界。 */
    async function generateImageAttempt({ remainingMs, markRetryBoundaryCrossed }) {
      markRetryBoundaryCrossed();
      const effectiveSignal = combineAbortSignalWithTimeout(abortSignal, remainingMs);
      try {
        if (operation === "model.image.edit") {
          const result = await responsesImageEditAdapter.editImage({
            model: selectedModel,
            prompt,
            sourceImage: sourceImages[0],
            size,
            abortSignal: effectiveSignal,
          });
          return { model: selectedModel, ...result };
        }
        const result = await generateImageImplementation({
          model: imageProvider.imageModel(selectedModel),
          prompt: String(prompt || ""),
          n: 1,
          size,
          maxRetries: 0,
          abortSignal: effectiveSignal,
        });
        return {
          model: selectedModel,
          images: result.images.map(mapGeneratedImage),
          usage: mapImageUsage(result.usage, result.images.length),
          warnings: Array.isArray(result.warnings) ? result.warnings.length : 0,
        };
      } catch (error) {
        throw mapAiSdkError(error, abortSignal?.aborted ? abortSignal : undefined, nowImplementation());
      }
    }

    try {
      const execution = await executeWithRetry({
        context,
        policy,
        task: generateImageAttempt,
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
      throw mapAiSdkError(error, abortSignal, nowImplementation());
    }
  }

  return {
    baseUrl: gatewayRootUrl,
    gatewayBaseUrl: managementClient.gatewayBaseUrl,
    model: modelAlias,
    imageModel: imageModelAlias,
    imageEditModel: imageEditModelAlias,
    defaultModels: {
      "conversation.chat": modelAlias,
      "image.generate": imageModelAlias,
      "image.edit": imageEditModelAlias,
    },
    modelCapabilities: copyModelCapabilities(configuredModelCapabilities),
    /** 返回模型网关可达性和可见能力交集，不公开真实上游模型。 */
    async status() {
      const gatewayStatus = await managementClient.status();
      return {
        ...gatewayStatus,
        imageModel: imageModelAlias,
        imageEditModel: imageEditModelAlias,
        defaultModels: {
          "conversation.chat": modelAlias,
          "image.generate": imageModelAlias,
          "image.edit": imageEditModelAlias,
        },
        modelCapabilities: filterVisibleModelCapabilities(
          configuredModelCapabilities,
          gatewayStatus.models,
        ),
      };
    },
    listModels: managementClient.listModels,
    resolveModel: managementClient.resolveModel,
    /** 按纯文本或视觉输入要求校验对话模型，不把目录可见性当作能力证据。 */
    async resolveConversationModel(requestedModel, { requiresVision = false } = {}) {
      return resolveConfiguredConversationModel(
        managementClient,
        configuredModelCapabilities,
        requestedModel,
        requiresVision,
      );
    },
    /** 按图片生成或编辑操作校验模型；默认图片别名由服务端配置拥有。 */
    async resolveImageModel(requestedModel, operation = "image.generate") {
      return resolveConfiguredImageModel(
        managementClient,
        configuredModelCapabilities,
        requestedModel,
        operation,
      );
    },
    countTokens: managementClient.countTokens,

    /**
     * 通过 AI SDK 图片模型接口经 LiteLLM 生成图片，固定关闭 SDK 和平台自动重试。
     *
     * @param {object} input - 规范化图片生成请求。
     * @param {string} input.prompt - 用户可见提示词。
     * @param {string} [input.model] - 平台图片模型别名。
     * @param {string} [input.size="1024x1024"] - 平台白名单内尺寸。
     * @param {import("../resilience/retry-executor.mjs").ResilienceContext} [input.resilienceContext] - Run 共享截止时间。
     * @param {AbortSignal} [input.abortSignal] - Runtime 取消信号。
     * @returns {Promise<object>} 图片字节、最小 usage 和无重试证据。
     */
    async generateImages({
      prompt,
      model: requestedModel,
      size = "1024x1024",
      resilienceContext,
      abortSignal,
    }) {
      return executeImageRequest({
        prompt,
        model: requestedModel,
        size,
        operation: "model.image.generate",
        resilienceContext,
        abortSignal,
      });
    },

    /**
     * 通过 Responses 图片工具经 LiteLLM 编辑一张受控源图，固定关闭自动重试。
     *
     * @param {object} input - 规范化图片编辑请求。
     * @param {string} input.prompt - 用户可见编辑指令。
     * @param {Array<{bytes: Uint8Array|Buffer, mediaType: string}>} input.sourceImages - 已校验源图片。
     * @param {string} [input.model] - 平台图片模型别名。
     * @param {string} [input.size="1024x1024"] - 平台白名单内尺寸。
     * @param {import("../resilience/retry-executor.mjs").ResilienceContext} [input.resilienceContext] - Run 共享截止时间。
     * @param {AbortSignal} [input.abortSignal] - Runtime 取消信号。
     * @returns {Promise<object>} 编辑图片字节、最小 usage 和无重试证据。
     */
    async editImages({
      prompt,
      sourceImages,
      model: requestedModel,
      size = "1024x1024",
      resilienceContext,
      abortSignal,
    }) {
      if (!Array.isArray(sourceImages) || sourceImages.length !== 1) {
        throw new GatewayRequestError(
          "Image editing requires exactly one source image",
          400,
          { code: "image_edit_source_required" },
        );
      }
      return executeImageRequest({
        prompt,
        sourceImages,
        model: requestedModel,
        size,
        operation: "model.image.edit",
        resilienceContext,
        abortSignal,
      });
    },

    /**
     * 通过 AI SDK 生成文本，并映射回现有 OpenAI-compatible 响应结构。
     *
     * @param {object} input - Runtime 的模型生成参数。
     * @param {Array<object>} input.messages - OpenAI-compatible 消息列表。
     * @param {string} [input.model] - 当前 Run 选择的 LiteLLM 模型别名。
     * @param {number} [input.temperature] - 可选采样温度。
     * @param {number} [input.maxCompletionTokens] - 模型输出硬上限。
     * @param {object} [input.responseFormat] - 兼容既有调用的 LiteLLM 原始结构化输出约束。
     * @param {{name?: string, description?: string, schema: object}} [input.outputSchema] - AI SDK `Output.object` 结构化输出约束；优先传入带本地校验的 Standard Schema。
     * @param {Record<string, object>} [input.tools] - Runtime allowlist 生成的 AI SDK 只读工具集合。
     * @param {Record<string, object>} [input.toolsContext] - AI SDK 按工具名校验的服务端执行上下文。
     * @param {string} [input.requiredToolName] - 确定性任务路由要求首步调用的 allowlist 工具名。
     * @param {number} [input.maxToolSteps=4] - 单次 AI SDK 多步工具生成的模型步骤上限。
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
      outputSchema,
      tools,
      toolsContext,
      requiredToolName,
      maxToolSteps = 4,
      resilienceContext,
      operation = "model.generate",
      onTextDelta,
      abortSignal,
    }) {
      const modelMessages = toAiSdkMessages(messages);
      const selectedModel = await resolveConfiguredConversationModel(
        managementClient,
        configuredModelCapabilities,
        requestedModel,
        modelMessagesRequireVision(modelMessages),
      );
      const output = createStructuredOutput(outputSchema);
      const useConversationAgent = shouldUseConversationAgent({ tools, outputSchema, responseFormat });
      let requestModel = null;
      if (!useConversationAgent) {
        const provider = createProvider({
          name: "litellm",
          baseURL: `${gatewayRootUrl}/v1`,
          apiKey: key,
          fetch: fetchImplementation,
          supportsStructuredOutputs: outputSchema !== undefined && outputSchema !== null,
          supportedUrls: getSupportedUrls,
          transformRequestBody: createRequestBodyTransformer({
            maxCompletionTokens,
            responseFormat,
          }),
        });
        requestModel = provider.chatModel(selectedModel);
      }
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
      async function generateAttempt({ attempt, remainingMs, markOutputStarted, markRetryBoundaryCrossed }) {
        const telemetryInput = createAiSdkTelemetryInput(context, attempt, operation);
        try {
          if (useConversationAgent) {
            return await executeConversationAgentAttempt({
              agent: conversationAgent,
              modelMessages,
              selectedModel,
              tools,
              toolsContext,
              requiredToolName,
              maxToolSteps,
              temperature,
              maxCompletionTokens,
              operation,
              remainingMs,
              abortSignal,
              onTextDelta,
              markOutputStarted,
              markRetryBoundaryCrossed,
              runtimeContext: telemetryInput.runtimeContext,
            });
          }
          const toolLoopInput = createToolLoopInput({
            tools,
            toolsContext,
            requiredToolName,
            maxToolSteps,
            stepCountIsImplementation,
          });
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
              markRetryBoundaryCrossed,
              streamTextImplementation,
              fallbackModel: selectedModel,
              output,
              toolLoopInput,
              ...telemetryInput,
            });
          }
          const result = await generateTextImplementation({
            model: requestModel,
            messages: modelMessages,
            allowSystemInMessages: true,
            ...(temperature === undefined ? {} : { temperature }),
            ...(maxCompletionTokens === undefined ? {} : { maxOutputTokens: maxCompletionTokens }),
            ...(output ? { output } : {}),
            ...toolLoopInput,
            onToolExecutionStart: markRetryBoundaryCrossed,
            maxRetries: 0,
            timeout: Math.max(1, remainingMs),
            ...(abortSignal === undefined ? {} : { abortSignal }),
            ...telemetryInput,
          });
          return mapGenerateTextResult(result, selectedModel, Boolean(output));
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

/** 按服务端声明的 chat/vision 能力解析对话别名，并继续复用目录授权校验。 */
async function resolveConfiguredConversationModel(
  managementClient,
  modelCapabilities,
  requestedModel,
  requiresVision,
) {
  const candidate = String(requestedModel || managementClient.model).trim() || managementClient.model;
  const selectedModel = await managementClient.resolveModel(candidate);
  assertModelCapability(candidate, modelCapabilities, "chat", "conversation.chat");
  if (requiresVision) assertModelCapability(candidate, modelCapabilities, "vision", "conversation.chat");
  return selectedModel;
}

/** 按显式图片操作解析模型别名，并继续复用 LiteLLM 目录授权校验。 */
async function resolveConfiguredImageModel(managementClient, modelCapabilities, requestedModel, operation) {
  const capability = operation === "model.image.edit" || operation === "image.edit"
    ? "imageEditing"
    : "imageGeneration";
  const configuredModels = modelCapabilities[capability];
  const candidate = String(requestedModel || configuredModels[0] || "").trim();
  const selectedModel = await managementClient.resolveModel(candidate);
  assertModelCapability(candidate, modelCapabilities, capability, normalizeImageOperation(operation));
  return selectedModel;
}

/** 当模型不属于当前操作能力分组时返回稳定 400，不触发任何模型生成端点。 */
function assertModelCapability(model, modelCapabilities, capability, operation) {
  if (model && modelCapabilities[capability].includes(model)) return;
  throw new GatewayRequestError("Model capability mismatch", 400, {
    error: "Model capability mismatch",
    code: "model_capability_mismatch",
    model: model || "unknown",
    requiredCapability: capability,
    operation,
  });
}

/** 把 GatewayClient 能力策略规范为固定四组去重别名，缺失分组使用当前稳定默认值。 */
function normalizeModelCapabilities(value, defaults) {
  const source = value && typeof value === "object" && !Array.isArray(value) ? value : {};
  const result = {};
  for (const capability of MODEL_CAPABILITY_KEYS) {
    const candidates = Array.isArray(source[capability]) ? source[capability] : defaults[capability];
    result[capability] = normalizeModelAliases(candidates);
  }
  return result;
}

/** 返回能力策略副本，避免状态调用方修改 GatewayClient 内部集合。 */
function copyModelCapabilities(modelCapabilities) {
  const result = {};
  for (const capability of MODEL_CAPABILITY_KEYS) {
    result[capability] = [...modelCapabilities[capability]];
  }
  return result;
}

/** 只公开同时由服务端声明且在本次 LiteLLM 目录中可见的别名。 */
function filterVisibleModelCapabilities(modelCapabilities, visibleModels) {
  const visible = new Set(normalizeModelAliases(visibleModels));
  const result = {};
  for (const capability of MODEL_CAPABILITY_KEYS) {
    const compatible = [];
    for (const model of modelCapabilities[capability]) if (visible.has(model)) compatible.push(model);
    result[capability] = compatible;
  }
  return result;
}

/** 将任意别名数组整理为保持声明顺序的唯一非空字符串。 */
function normalizeModelAliases(value) {
  const result = [];
  const seen = new Set();
  for (const model of Array.isArray(value) ? value : []) {
    const normalized = String(model || "").trim();
    if (normalized && !seen.has(normalized)) {
      seen.add(normalized);
      result.push(normalized);
    }
  }
  return result;
}

/** 判断已校验的 AI SDK 消息是否包含图片 FilePart，从而要求 vision 能力。 */
function modelMessagesRequireVision(messages) {
  for (const message of messages) {
    if (!Array.isArray(message?.content)) continue;
    for (const part of message.content) {
      if (part?.type === "file" && String(part?.mediaType || "").startsWith("image")) return true;
    }
  }
  return false;
}

/** 把内部模型操作名收敛为 Runtime 稳定 operation。 */
function normalizeImageOperation(operation) {
  return operation === "model.image.edit" || operation === "image.edit" ? "image.edit" : "image.generate";
}

/** 把 AI SDK GeneratedFile 复制为不依赖 SDK 对象生命周期的稳定二进制结果。 */
function mapGeneratedImage(image) {
  return {
    bytes: Buffer.from(image.uint8Array),
    mediaType: String(image.mediaType || "application/octet-stream").toLowerCase(),
  };
}

/** 将图片模型用量映射为可持久化且不含 provider 元数据的稳定字段。 */
function mapImageUsage(usage, generatedImages) {
  return {
    input_tokens: normalizeOptionalUsageNumber(usage?.inputTokens),
    output_tokens: normalizeOptionalUsageNumber(usage?.outputTokens),
    total_tokens: normalizeOptionalUsageNumber(usage?.totalTokens),
    generated_images: generatedImages,
  };
}

/** 将可选 usage 数值限制为非负有限值或 null。 */
function normalizeOptionalUsageNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : null;
}

/** 创建图片生成/编辑专用单次尝试策略，任何错误都不得自动重发付费请求。 */
function createImageGenerationRetryPolicy(operation) {
  return {
    operation,
    maxAttempts: 1,
    /** 图片模型副作用失败始终不进入自动重试。 */
    shouldRetry() {
      return false;
    },
    /** 图片模型副作用无退避，因为最多只允许一次模型尝试。 */
    calculateBackoffMs() {
      return 0;
    },
    describeError: describeGatewayError,
  };
}

/** 将 Runtime 取消信号与本次图片模型剩余时限组合为单一 AbortSignal。 */
function combineAbortSignalWithTimeout(abortSignal, remainingMs) {
  const timeoutSignal = AbortSignal.timeout(Math.max(1, remainingMs));
  return abortSignal ? AbortSignal.any([abortSignal, timeoutSignal]) : timeoutSignal;
}

/** 声明 LiteLLM 可原样接收的图片 URL，阻止 AI SDK 在 Runtime 侧提前下载。 */
function getSupportedUrls() {
  return {
    "image/*": [/^https?:\/\//i, /^data:image\//i],
  };
}

/** 将 OpenAI-compatible 消息与 Runtime 结构化工具续接消息转换为 AI SDK v7 ModelMessage。 */
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
    if (typeof message?.content !== "string" || message.role === "tool") {
      throw new GatewayRequestError("Model message content must be text or content parts", 400, {
        error: "Invalid model message content",
      });
    }
    return { role: message.role, content: String(message.content || "") };
  }
  if (message.role === "user") {
    return { role: message.role, content: message.content.map(toAiSdkUserContentPart) };
  }
  if (message.role === "assistant") {
    return { role: message.role, content: message.content.map(toAiSdkAssistantContentPart) };
  }
  if (message.role === "tool") {
    return { role: message.role, content: message.content.map(toAiSdkToolContentPart) };
  }
  throw new GatewayRequestError("Content parts are not supported for system messages", 400, {
    error: "Invalid model message content",
    role: message.role,
  });
}

/** 将文本或 OpenAI `image_url` part 转换为 AI SDK v7 content part。 */
function toAiSdkUserContentPart(part) {
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

/** 校验 Runtime 构造的 assistant 文本或工具调用 part，并复制为 AI SDK 消息。 */
function toAiSdkAssistantContentPart(part) {
  if (part?.type === "text") return { type: "text", text: String(part.text || "") };
  if (part?.type === "tool-call" && part.toolCallId && part.toolName && part.input !== undefined) {
    return {
      type: "tool-call",
      toolCallId: String(part.toolCallId),
      toolName: String(part.toolName),
      input: part.input,
    };
  }
  throw new GatewayRequestError("Unsupported assistant message content", 400, {
    error: "Invalid structured assistant message",
    type: part?.type || "unknown",
  });
}

/** 校验持久化 ToolResult 的结构化消息，并保持工具调用关联字段。 */
function toAiSdkToolContentPart(part) {
  if (part?.type !== "tool-result" || !part.toolCallId || !part.toolName) {
    throw new GatewayRequestError("Unsupported tool message content", 400, {
      error: "Invalid structured tool message",
      type: part?.type || "unknown",
    });
  }
  const output = part.output;
  if (!isSupportedToolResultOutput(output)) {
    throw new GatewayRequestError("Unsupported tool result output", 400, {
      error: "Invalid structured tool result",
      type: output?.type || "unknown",
    });
  }
  return {
    type: "tool-result",
    toolCallId: String(part.toolCallId),
    toolName: String(part.toolName),
    output,
  };
}

/** 判断工具结果是否属于 AI SDK v7 支持且当前可安全续接的 JSON 或文本形态。 */
function isSupportedToolResultOutput(output) {
  if (!output || typeof output !== "object") return false;
  if (["json", "text", "error-json", "error-text"].includes(output.type)) {
    return Object.hasOwn(output, "value");
  }
  return output.type === "execution-denied";
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

/** 为可复用对话 Agent 把 AI SDK 的输出上限字段转换为当前 LiteLLM 契约。 */
function createAgentRequestBodyTransformer() {
  /** 仅在 AI SDK 实际发送输出上限时改写字段，避免注入未配置值。 */
  function transformRequestBody(body) {
    if (body.max_tokens === undefined) return body;
    const transformed = { ...body, max_completion_tokens: body.max_tokens };
    delete transformed.max_tokens;
    return transformed;
  }
  return transformRequestBody;
}

/** 创建 ToolLoopAgent 实例的默认工厂，并为协议测试保留可替换边界。 */
function createToolLoopAgentInstance(settings) {
  return new ToolLoopAgent(settings);
}

/** 判断对象是否可作为 AI SDK 工具定义进入动态 Agent call options。 */
function isAiSdkTool(value) {
  return value !== null && typeof value === "object";
}

/**
 * 创建可复用对话 Agent 的按调用配置器，动态选择 LiteLLM 模型、工具和步骤预算。
 * `output` 不在此动态切换，结构化一次性任务继续走 Core 函数路径。
 */
function createConversationAgentCallPreparer({ conversationProvider, stepCountIsImplementation }) {
  /** 校验当前工具路由并将调用选项转换为 ToolLoopAgent 的实际生成设置。 */
  function prepareConversationAgentCall({ options, ...settings }) {
    validateRequiredToolName(options.requiredToolName, options.tools);
    return {
      ...settings,
      model: conversationProvider.chatModel(options.model),
      tools: options.tools,
      stopWhen: stepCountIsImplementation(options.maxToolSteps),
      temperature: options.temperature,
      maxOutputTokens: options.maxCompletionTokens,
      runtimeContext: {
        ...(settings.runtimeContext || {}),
        requiredToolName: options.requiredToolName || undefined,
      },
      telemetry: createAiSdkTelemetryOptions(options.operation),
    };
  }
  return prepareConversationAgentCall;
}

/** 在对话 Agent 首步应用确定性工具路由，后续步骤恢复模型自动选择。 */
function prepareConversationAgentStep({ stepNumber, runtimeContext }) {
  return selectRequiredToolStep(stepNumber, runtimeContext?.requiredToolName);
}

/** 判断当前请求是否属于 ToolLoopAgent 负责的纯文本工具型对话。 */
function shouldUseConversationAgent({ tools, outputSchema, responseFormat }) {
  return hasAgentTools(tools) && outputSchema == null && responseFormat == null;
}

/** 使用可复用 ToolLoopAgent 执行一次工具型对话，并映射回稳定 GatewayClient 契约。 */
async function executeConversationAgentAttempt({
  agent,
  modelMessages,
  selectedModel,
  tools,
  toolsContext,
  requiredToolName,
  maxToolSteps,
  temperature,
  maxCompletionTokens,
  operation,
  remainingMs,
  abortSignal,
  onTextDelta,
  markOutputStarted,
  markRetryBoundaryCrossed,
  runtimeContext,
}) {
  const call = {
    messages: modelMessages,
    options: {
      model: selectedModel,
      tools,
      requiredToolName: requiredToolName ? String(requiredToolName) : null,
      maxToolSteps: normalizeToolStepLimit(maxToolSteps),
      temperature,
      maxCompletionTokens,
      operation,
    },
    runtimeContext,
    ...(toolsContext === undefined ? {} : { toolsContext }),
    timeout: Math.max(1, remainingMs),
    onToolExecutionStart: markRetryBoundaryCrossed,
    ...(abortSignal === undefined ? {} : { abortSignal }),
  };
  if (typeof onTextDelta !== "function") {
    const result = await agent.generate(call);
    return mapGenerateTextResult(result, selectedModel);
  }
  // v7 AgentStreamParameters 未公开 onError，但 ToolLoopAgent 会把该选项透传给底层 streamText。
  const result = await agent.stream({ ...call, onError: suppressAiSdkStreamErrorLogging });
  return consumeTextStreamResult({
    result,
    onTextDelta,
    markOutputStarted,
    fallbackModel: selectedModel,
  });
}

/** 将平台结构化 schema 适配为 AI SDK v7 `Output.object`，未配置时保持普通文本生成。 */
function createStructuredOutput(outputSchema) {
  if (outputSchema === undefined || outputSchema === null) return null;
  if (!isPlainObject(outputSchema) || !isPlainObject(outputSchema.schema)) {
    throw new GatewayRequestError("outputSchema.schema must be a schema object", 400, {
      error: "Invalid structured output schema",
      code: "invalid_output_schema",
    });
  }
  return Output.object({
    schema: toAiSdkSchema(outputSchema.schema),
    ...(outputSchema.name ? { name: String(outputSchema.name) } : {}),
    ...(outputSchema.description ? { description: String(outputSchema.description) } : {}),
  });
}

/** 保留 Zod 等 Standard Schema 的本地校验器；原始 JSON Schema 只用于兼容透传。 */
function toAiSdkSchema(schema) {
  return isStandardSchema(schema) ? schema : jsonSchema(schema);
}

/** 判断 schema 是否实现 Standard Schema v1 校验协议。 */
function isStandardSchema(schema) {
  return typeof schema?.["~standard"]?.validate === "function";
}

/** 将 AI SDK `generateText` 结果映射为现有 chat completions 结果。 */
function mapGenerateTextResult(result, fallbackModel, includeOutput = false) {
  const response = result?.finalStep?.response || {};
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
        finish_reason: mapFinishReason(result?.finishReason ?? result?.finalStep?.finishReason),
      },
    ],
    usage: mapUsage(result?.usage),
    ...(includeOutput ? { output: result?.output } : {}),
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
  markRetryBoundaryCrossed,
  streamTextImplementation,
  fallbackModel,
  output,
  toolLoopInput,
  telemetry,
  runtimeContext,
}) {
  const result = await streamTextImplementation({
    model: requestModel,
    messages: modelMessages,
    allowSystemInMessages: true,
    ...(temperature === undefined ? {} : { temperature }),
    ...(maxCompletionTokens === undefined ? {} : { maxOutputTokens: maxCompletionTokens }),
    ...(output ? { output } : {}),
    ...toolLoopInput,
    onToolExecutionStart: markRetryBoundaryCrossed,
    maxRetries: 0,
    timeout: Math.max(1, remainingMs),
    ...(abortSignal === undefined ? {} : { abortSignal }),
    onError: suppressAiSdkStreamErrorLogging,
    telemetry,
    runtimeContext,
  });
  return consumeTextStreamResult({
    result,
    onTextDelta,
    markOutputStarted,
    fallbackModel,
    includeOutput: Boolean(output),
  });
}

/** 消费 AI SDK v7 标准事件流，并忽略已由 Runtime 记录的工具分块。 */
async function consumeTextStreamResult({ result, onTextDelta, markOutputStarted, fallbackModel, includeOutput = false }) {
  let text = "";
  const hasEventStream = result.stream !== undefined;
  const stream = result.stream ?? result.textStream;
  for await (const part of stream) {
    if (hasEventStream && part?.type === "error") throw part.error;
    const delta = hasEventStream ? (part?.type === "text-delta" ? part.text : "") : part;
    if (!delta) continue;
    markOutputStarted();
    text += delta;
    await onTextDelta(delta);
  }
  const [usage, finalStep, output] = await Promise.all([
    result.usage,
    resolveStreamFinalStep(result),
    includeOutput ? result.output : undefined,
  ]);
  return mapGenerateTextResult({ text, usage, finalStep, output }, fallbackModel, includeOutput);
}

/** 读取 AI SDK v7 `finalStep`，统一获得最终 finish reason、响应和性能信息。 */
async function resolveStreamFinalStep(result) {
  return result.finalStep;
}

/** 判断 Runtime 是否提供至少一个工具，空对象继续走既有纯文本链路。 */
function hasAgentTools(tools) {
  return Boolean(tools && typeof tools === "object" && Object.keys(tools).length > 0);
}

/** 为需要动态 Output 的 Core 特殊路径构造工具、上下文、停止条件和首步路由设置。 */
function createToolLoopInput({ tools, toolsContext, requiredToolName, maxToolSteps, stepCountIsImplementation }) {
  if (!hasAgentTools(tools)) return {};
  const prepareStep = createRequiredToolStepRouter(requiredToolName, tools);
  return {
    tools,
    ...(toolsContext === undefined ? {} : { toolsContext }),
    stopWhen: stepCountIsImplementation(normalizeToolStepLimit(maxToolSteps)),
    ...(prepareStep ? { prepareStep } : {}),
  };
}

/** 仅在首个模型步骤强制确定性路由工具，ToolResult 回填后恢复自动选择以生成最终回答。 */
function createRequiredToolStepRouter(requiredToolName, tools) {
  if (!requiredToolName) return null;
  const toolName = validateRequiredToolName(requiredToolName, tools);
  /** 根据 AI SDK stepNumber 只约束首步，避免每一步重复强制同一工具。 */
  function routeRequiredTool({ stepNumber }) {
    return selectRequiredToolStep(stepNumber, toolName);
  }
  return routeRequiredTool;
}

/** 校验确定性路由目标属于当前服务端 ToolSet，并返回稳定工具名。 */
function validateRequiredToolName(requiredToolName, tools) {
  if (!requiredToolName) return null;
  const toolName = String(requiredToolName);
  if (!Object.hasOwn(tools || {}, toolName)) {
    throw new GatewayRequestError("Required tool is not registered", 400, {
      error: "Required tool is not registered",
      code: "required_tool_not_registered",
    });
  }
  return toolName;
}

/** 根据当前步骤返回确定性工具选择；无强制工具时不覆盖 Agent 默认设置。 */
function selectRequiredToolStep(stepNumber, requiredToolName) {
  if (!requiredToolName) return {};
  return stepNumber === 0
    ? { activeTools: [requiredToolName], toolChoice: { type: "tool", toolName: requiredToolName } }
    : { toolChoice: "auto" };
}

/** 将工具步骤上限限制为 1 到 8，当前 Runtime 默认使用 4。 */
function normalizeToolStepLimit(value) {
  const number = Number(value);
  return Number.isInteger(number) && number >= 1 && number <= 8 ? number : 4;
}

/** 禁用 AI SDK 默认的原始错误控制台输出；异常仍由标准事件流交给 Runtime 安全映射。 */
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
    telemetry: createAiSdkTelemetryOptions(operation),
  };
}

/** 创建不记录业务正文、只关联安全 Runtime 标识的 AI SDK Telemetry 设置。 */
function createAiSdkTelemetryOptions(operation) {
  return {
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
