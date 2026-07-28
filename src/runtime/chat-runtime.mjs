import { randomUUID } from "node:crypto";
import { createResilienceContext } from "../resilience/retry-executor.mjs";
import { normalizeContextOptions } from "./context-budget.mjs";
import { buildDisplayContent, buildUserContent, normalizeRunInput, validateRunInput } from "./message-builder.mjs";
import { createToolRegistry } from "../tools/tool-registry.mjs";

const DEFAULT_RUN_TIMEOUT_MS = 120000;

export class RuntimeInputError extends Error {
  /**
   * 保存可直接返回给渠道层的 Runtime 错误载荷和 HTTP 状态码。
   *
   * @param {object} payload - Runtime 错误详情。
   * @param {number} [status=400] - 建议 HTTP 状态码。
   */
  constructor(payload, status = 400) {
    super(payload.error || "Invalid runtime input");
    this.name = "RuntimeInputError";
    this.status = status;
    this.payload = payload;
  }
}

/**
 * 装配会话生命周期、幂等 Run、上下文规划、模型调用和结构化记忆。
 *
 * @param {object} dependencies - Runtime 依赖。
 * @returns {object} Session / Run API。
 */
export function createChatRuntime({
  gatewayClient,
  contextOptions,
  store,
  coordinator,
  contextPlanner,
  memoryManager,
  toolRegistry,
  resilienceOptions = {},
}) {
  const options = normalizeContextOptions(contextOptions);
  const registry = toolRegistry || createToolRegistry();
  const runTimeoutMs = normalizeRunTimeout(resilienceOptions.runTimeoutMs);

  return {
    /** 创建由 Runtime 持久化的新会话。 */
    createConversation(body = {}) {
      return store.createConversation({ title: String(body.title || "新会话").trim() || "新会话" });
    },

    /** 列出当前租户本地会话。 */
    listConversations() {
      return store.listConversations();
    },

    /** 返回会话完整消息、记忆和版本状态。 */
    getConversation(conversationId) {
      return store.getConversation(conversationId);
    },

    /**
     * 串行执行一次会话 Run，先落用户消息，再调用模型并持久化助手结果。
     *
     * @param {string} conversationId - 目标会话 ID。
     * @param {unknown} body - 当前 Run 请求体。
     * @param {object} [delivery] - 可选运行状态和模型文本增量消费者。
     * @param {(input: object) => Promise<void>|void} [delivery.onRunStarted] - Run 创建或幂等命中通知。
     * @param {(delta: string) => Promise<void>|void} [delivery.onTextDelta] - 模型文本增量消费者。
     * @param {AbortSignal} [delivery.abortSignal] - 可选调用方取消信号。
     * @returns {Promise<object>} 回复、会话状态、usage 和 Context Manifest。
     */
    async runConversation(conversationId, body, delivery = {}) {
      const input = normalizeRunInput(body);
      const validationError = validateRunInput(input);
      if (validationError) throw new RuntimeInputError(validationError);
      const traceId = randomUUID();
      const deadlineAt = Date.now() + runTimeoutMs;

      // 同一会话必须按提交顺序生成回复，避免第二个 Run 看不到第一个 Run 的结果。
      return coordinator.runExclusive(conversationId, async () => {
        const content = buildUserContent(input);
        const displayContent = buildDisplayContent(input);
        registry.resolveToolIntent(input);
        const started = store.startRun({
          conversationId,
          requestId: input.requestId,
          clientMessageId: input.clientMessageId,
          content,
          displayContent,
        });
        if (typeof delivery.onRunStarted === "function") {
          await delivery.onRunStarted({ run: started.run, replayed: started.replayed });
        }

        if (started.replayed) return replayRun(started, store.getConversation(conversationId));
        const runId = started.run.id;
        const resilienceContext = createResilienceContext({
          traceId,
          requestId: input.requestId,
          conversationId,
          runId,
          deadlineAt,
          stage: "run",
          lastCommittedStage: "user-message-committed",
          idempotencyKey: input.requestId,
          outputStarted: false,
        });
        try {
          let plan = await contextPlanner.plan({
            conversationId,
            currentMessageId: started.userMessage.id,
            currentContent: content,
            currentDisplayContent: displayContent,
            resilienceContext,
          });
          if (plan.manifest.hardLimitReached) {
            await memoryManager.compactIfNeeded(conversationId, {
              force: true,
              excludeSeq: started.userMessage.seq,
              resilienceContext,
            });
            plan = await contextPlanner.plan({
              conversationId,
              currentMessageId: started.userMessage.id,
              currentContent: content,
              currentDisplayContent: displayContent,
              resilienceContext,
            });
          }

          const data = await gatewayClient.chatCompletions({
            messages: plan.messages,
            maxCompletionTokens: options.reservedOutputTokens,
            resilienceContext,
            operation: "model.generate",
            onTextDelta: delivery.onTextDelta,
            abortSignal: delivery.abortSignal,
          });
          const assistantContent = data?.choices?.[0]?.message?.content || "";
          const completed = store.completeRun({
            runId,
            content: assistantContent,
            displayContent: assistantContent || "(空响应)",
            usage: data?.usage || null,
            contextManifest: plan.manifest,
            model: data?.model || gatewayClient.model,
            resilience: data?.resilience || null,
          });
          if (plan.manifest.highWatermarkReached) memoryManager.schedule(conversationId);

          return {
            content: completed.assistantMessage.displayContent,
            usage: completed.run.usage,
            model: completed.run.model,
            context: completed.run.contextManifest,
            resilience: completed.run.resilience,
            conversation: store.getConversation(conversationId),
            replayed: false,
          };
        } catch (error) {
          store.failRun(runId, error);
          throw error;
        }
      });
    },

    /** 完成最终记忆 checkpoint 并关闭会话，关闭后拒绝新 Run。 */
    async closeConversation(conversationId) {
      return coordinator.runExclusive(conversationId, async () => {
        await memoryManager.flush(conversationId);
        let checkpoint = null;
        try {
          checkpoint = await memoryManager.compactIfNeeded(conversationId, { force: true });
        } catch (error) {
          checkpoint = { status: "failed", error: error.message };
        }
        return {
          conversation: store.closeConversation(conversationId),
          checkpoint,
        };
      });
    },
  };
}

/** 将完成的幂等 Run 恢复为标准响应；运行中或失败 Run 返回冲突。 */
function replayRun(result, conversation) {
  if (result.run.status !== "completed" || !result.assistantMessage) {
    throw new RuntimeInputError(
      { error: result.run.status === "running" ? "Run is already in progress" : result.run.error || "Run failed" },
      409,
    );
  }
  return {
    content: result.assistantMessage.displayContent,
    usage: result.run.usage,
    model: result.run.model,
    context: result.run.contextManifest,
    resilience: result.run.resilience,
    conversation,
    replayed: true,
  };
}

/** 将 Runtime 总时限规范为正数，避免配置错误产生无界或立即过期的 Run。 */
function normalizeRunTimeout(value) {
  const timeoutMs = Number(value);
  return Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : DEFAULT_RUN_TIMEOUT_MS;
}
