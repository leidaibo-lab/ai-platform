// ADR: docs/decisions/2026-10-13-pi-agent-isolated-comparison.md
// Adapter 模式：仅在 PoC 内替换文本/工具引擎，业务事实、治理和结构化/图片路径仍归平台。
import { Agent } from "@earendil-works/pi-agent-core";
import { createModels, createProvider } from "@earendil-works/pi-ai";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import { z } from "zod";
import { GatewayRequestError } from "../../src/gateway/gateway-contract.mjs";
import { createResilienceContext, executeWithRetry, RetryExecutionError } from "../../src/resilience/retry-executor.mjs";

/**
 * @typedef {object} PiPocOptions
 * @property {object} baseClient - 原 GatewayClient；继续拥有目录、结构化和图片调用。
 * @property {typeof fetch} fetchImplementation - 与基线共用的 HTTP fixture，不访问真实 provider。
 * @property {string} apiKey - 仅测试假 key。
 * @property {number} [maxAttempts=2] - 两引擎相同的平台尝试上限。
 * 工具 schema 来自现有 ToolSet；工具执行仍调用 Runtime toolsContext，不保存第二份事实。
 */

/**
 * 创建实验专用 Gateway Adapter，不由正式启动入口引用。
 * @param {PiPocOptions} options - 显式测试依赖。
 * @returns {object} 保持原 Port 的混合客户端。
 */
export function createPiGateway({ baseClient, fetchImplementation, apiKey, maxAttempts = 2 }) {
  const models = createModels();
  const model = {
    id: baseClient.model, name: "PoC platform alias", api: "openai-completions", provider: "platform-poc",
    baseUrl: `${baseClient.baseUrl}/v1`, reasoning: false, input: ["text"],
    contextWindow: 32768, maxTokens: 4096,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    compat: { supportsDeveloperRole: false, maxTokensField: "max_completion_tokens" },
  };
  models.setProvider(createProvider({
    id: "platform-poc", models: [model], api: openAICompletionsApi(),
    auth: { apiKey: {
      name: "PoC fake key",
      /** 只提供显式注入的假网关凭据，不读取宿主 OAuth 或环境 key。 */
      resolve: async () => ({ auth: { apiKey } }),
    } },
  }));
  return {
    ...baseClient,
    /**
     * 将文本调用交给 Pi；动态结构化输出保留原 SDK，避免手写解析。
     * @param {object} input - 原 GatewayClient 请求。
     * @returns {Promise<object>} 原 completion 及平台韧性证据。
     */
    async chatCompletions(input) {
      if (input.outputSchema || input.responseFormat) return baseClient.chatCompletions(input);
      const selectedModel = await baseClient.resolveConversationModel(input.model);
      const context = createResilienceContext({ ...input.resilienceContext,
        deadlineAt: input.resilienceContext?.deadlineAt ?? Date.now() + 10000, stage: input.operation });
      const policy = {
        operation: input.operation || "model.generate", maxAttempts,
        /** 只重试已脱敏的瞬时 provider 失败。 */
        shouldRetry: (error) => error.retryable === true,
        /** 确定性 fixture 不需要退避等待。 */
        calculateBackoffMs: () => 0,
        /** 尝试证据不保存 provider 原始正文。 */
        describeError: (error) => ({ errorType: error.data?.code || "pi_failed", statusCode: error.status }),
      };
      try {
        const result = await executeWithRetry({ context, policy, abortSignal: input.abortSignal,
          /** 每次尝试创建独立 Agent；禁止会话状态跨 Run 泄漏。 */
          task: (attempt) => executePiAttempt({ input, attempt, model: { ...model, id: selectedModel }, models, fetchImplementation }),
        });
        return { ...result.value, resilience: result.resilience };
      } catch (error) {
        if (!(error instanceof RetryExecutionError)) throw error;
        const failure = error.cause;
        failure.resilience = error.resilience;
        throw failure;
      }
    },
  };
}

/** 单次 Pi 调用负责消息、工具、流事件转换；截止时间与取消绑定到同一 Agent。 */
async function executePiAttempt({ input, attempt, model, models, fetchImplementation }) {
  const signal = AbortSignal.any([AbortSignal.timeout(attempt.remainingMs), ...(input.abortSignal ? [input.abortSignal] : [])]);
  const messages = convertMessages(input.messages);
  const tools = [];
  for (const [name, tool] of Object.entries(input.tools || {})) {
    tools.push({ name, label: name, description: tool.description,
      parameters: z.toJSONSchema(tool.inputSchema),
      /** 双重校验后通过原工具执行器回到 Runtime 的 journal、Policy 和 ToolResult。 */
      async execute(toolCallId, args, abortSignal) {
        const parsed = tool.inputSchema.parse(args);
        const value = await tool.execute(parsed, { toolCallId, abortSignal, messages: input.messages,
          context: input.toolsContext[name] });
        return { content: [{ type: "text", text: JSON.stringify(value) }], details: undefined };
      },
    });
  }
  let requests = 0;
  let hookFailure = null;
  let httpStatus = null;
  /** 仅记录 HTTP 状态，不在错误证据中保存 provider 正文或请求头。 */
  async function observeFetch(url, options) {
    const response = await fetchImplementation(url, options);
    httpStatus = response.status;
    return response;
  }
  const agent = new Agent({
    initialState: { model, tools, messages,
      systemPrompt: input.messages.filter(isSystem).map(readContent).join("\n") },
    toolExecution: "sequential",
    /** 每步关闭 provider 内建重试；由平台统一预算，首步强制命中工具。 */
    streamFn(currentModel, currentContext, options) {
      if (signal.aborted) throw signal.reason;
      requests += 1;
      if (requests > (input.maxToolSteps || 4)) throw publicError("pi_step_limit", false);
      return models.streamSimple(currentModel, currentContext, { ...options, signal,
        fetch: observeFetch, maxRetries: 0, temperature: input.temperature,
        maxTokens: input.maxCompletionTokens,
        /** Pi 的通用 ToolChoice 只有 auto/none；通过 OpenAI payload 适配首步指定工具。 */
        onPayload(payload) {
          if (requests === 1 && input.requiredToolName) payload.tool_choice = {
            type: "function", function: { name: input.requiredToolName } };
          return payload;
        },
      });
    },
    /** 在任何 Connector 执行前标记不可整段重放边界。 */
    async beforeToolCall() { attempt.markRetryBoundaryCrossed(); },
  });
  /** 将取消传播到 Pi 自身循环，不能仅取消等待者。 */
  function abortAgent() { agent.abort(); }
  signal.addEventListener("abort", abortAgent, { once: true });
  /** 交付增量；Pi 会隔离订阅者异常，所以宿主显式捕获并让调用失败。 */
  async function forwardEvent(event) {
    if (event.type !== "message_update" || event.assistantMessageEvent.type !== "text_delta" || !input.onTextDelta) return;
    try {
      attempt.markOutputStarted();
      await input.onTextDelta(event.assistantMessageEvent.delta);
    } catch (error) { hookFailure = error; agent.abort(); }
  }
  const unsubscribe = agent.subscribe(forwardEvent);
  try {
    await agent.continue();
    if (hookFailure) throw publicError("pi_delivery_failed", false);
    if (signal.aborted) throw publicError("pi_cancelled", false);
    const replies = agent.state.messages.filter(isAssistant);
    const last = replies.at(-1);
    if (!last || last.stopReason === "error") {
      const retryable = httpStatus === null || [408, 429, 500, 502, 503, 504].includes(httpStatus);
      throw publicError("pi_provider_failed", retryable, httpStatus && httpStatus >= 400 ? httpStatus : 502);
    }
    if (last.stopReason === "aborted") throw publicError("pi_cancelled", false);
    const content = last.content.filter(isText).map(readText).join("");
    const usage = { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };
    for (const reply of replies) {
      usage.prompt_tokens += (reply.usage?.input || 0) + (reply.usage?.cacheRead || 0) + (reply.usage?.cacheWrite || 0);
      usage.completion_tokens += reply.usage?.output || 0;
      usage.total_tokens += reply.usage?.totalTokens || 0;
    }
    return { model: model.id, choices: [{ index: 0, message: { role: "assistant", content },
      finish_reason: last.stopReason === "length" ? "length" : "stop" }], usage };
  } finally { unsubscribe(); signal.removeEventListener("abort", abortAgent); }
}

/** 转换本轮平台消息，包括 SQLite ToolResult 的无工具恢复历史。 */
function convertMessages(messages) {
  const result = [];
  for (const message of messages) {
    if (message.role === "system") continue;
    if (message.role === "user" && typeof message.content === "string") {
      result.push({ role: "user", content: message.content, timestamp: Date.now() });
    } else if (message.role === "assistant") {
      const content = typeof message.content === "string" ? [{ type: "text", text: message.content }] : message.content.map(convertCall);
      result.push({ role: "assistant", content, api: "openai-completions", provider: "platform-poc",
        model: "poc-chat", stopReason: "stop", timestamp: Date.now(),
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } });
    } else if (message.role === "tool") {
      for (const part of message.content) result.push({ role: "toolResult", toolCallId: part.toolCallId,
        toolName: part.toolName, content: [{ type: "text", text: JSON.stringify(part.output.value) }],
        isError: false, timestamp: Date.now() });
    } else throw publicError("pi_poc_unsupported_message", false);
  }
  return result;
}
/** 仅支持本项目恢复消息中的原生工具调用，其他多模态类型显式拒绝。 */
function convertCall(part) {
  if (part.type !== "tool-call") throw publicError("pi_poc_unsupported_message", false);
  return { type: "toolCall", id: part.toolCallId, name: part.toolName, arguments: part.input };
}
/** 创建不含 provider 正文、key 或 URL 的实验公开错误。 */
function publicError(code, retryable, status = 502) {
  const error = new GatewayRequestError(code, status, { code });
  error.retryable = retryable;
  return error;
}
/** 查询系统消息。 */
function isSystem(message) { return message.role === "system"; }
/** 提取系统正文。 */
function readContent(message) { return message.content; }
/** 查询助手消息。 */
function isAssistant(message) { return message.role === "assistant"; }
/** 查询文本结果分段。 */
function isText(part) { return part.type === "text"; }
/** 提取结果文本。 */
function readText(part) { return part.text; }
