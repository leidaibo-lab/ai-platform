import { randomUUID } from "node:crypto";
import { createNullChainTracer } from "../observability/chain-tracer.mjs";
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

/** Runtime 对渠道公开的安全执行错误，不携带 provider 原始响应正文。 */
export class RuntimeExecutionError extends Error {
  /**
   * @param {object} payload - 安全错误标题、原因、处理建议和分类。
   * @param {number} [status=500] - 对应模型或运行阶段的公开状态。
   * @param {unknown} [cause] - 仅供服务端诊断链使用的原始异常。
   */
  constructor(payload, status = 500, cause) {
    super(payload.error || "Runtime execution failed");
    this.name = "RuntimeExecutionError";
    this.status = status;
    this.payload = payload;
    this.cause = cause;
    this.resilience = cause?.resilience || null;
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
  chainTracer = createNullChainTracer(),
  resilienceOptions = {},
}) {
  const options = normalizeContextOptions(contextOptions);
  const registry = toolRegistry || createToolRegistry();
  const runTimeoutMs = normalizeRunTimeout(resilienceOptions.runTimeoutMs);
  const activeRuns = new Map();

  /**
   * 主动终止当前 Runtime 实例中的模型调用，并原子收口 Run 与可选部分消息。
   *
   * @param {string} conversationId - Run 所属会话。
   * @param {string} runId - 渠道从 run-started 获得的稳定 Run ID。
   * @returns {object} 当前 Run 终止事实和会话快照。
   */
  function cancelConversationRun(conversationId, runId) {
    const active = activeRuns.get(runId);
    const ownedActive = active?.conversationId === conversationId ? active : null;
    if (ownedActive && !ownedActive.controller.signal.aborted) {
      ownedActive.controller.abort(new DOMException("Run was cancelled by user", "AbortError"));
    }
    const cancelled = store.cancelRun({
      conversationId,
      runId,
      partialContent: ownedActive?.partialText || "",
      contextManifest: ownedActive?.contextManifest || null,
      model: ownedActive?.model || null,
      resilience: ownedActive
        ? buildCancellationResilience(ownedActive.resilienceContext, ownedActive.partialText.length > 0)
        : null,
    });
    return { ...cancelled, conversation: store.getConversation(conversationId) };
  }

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

    cancelConversationRun,

    /**
     * 串行执行一次会话 Run，先落用户消息，再调用模型并持久化助手结果。
     *
     * @param {string} conversationId - 目标会话 ID。
     * @param {unknown} body - 当前 Run 请求体。
     * @param {object} [delivery] - 可选运行状态和模型文本增量消费者。
     * @param {(input: object) => Promise<void>|void} [delivery.onRunStarted] - Run 创建或幂等命中通知。
     * @param {(input: object) => Promise<void>|void} [delivery.onChainTraceStarted] - 业务 Chain ID 创建通知。
     * @param {(delta: string) => Promise<void>|void} [delivery.onTextDelta] - 模型文本增量消费者。
     * @param {AbortSignal} [delivery.abortSignal] - 可选调用方取消信号。
     * @returns {Promise<object>} 回复、会话状态、usage 和 Context Manifest。
     */
    async runConversation(conversationId, body, delivery = {}) {
      const input = normalizeRunInput(body);
      const validationError = validateRunInput(input);
      if (validationError) throw new RuntimeInputError(validationError);
      const selectedModel = await resolveRunModel(gatewayClient, input.model);
      const chainTraceId = randomUUID();
      const deadlineAt = Date.now() + runTimeoutMs;
      if (typeof delivery.onChainTraceStarted === "function") {
        await delivery.onChainTraceStarted({ chainTraceId });
      }
      const queueSpan = chainTracer.startSpan("runtime.queue", {
        ...buildTraceAttributes({ chainTraceId, requestId: input.requestId, conversationId }),
      });

      // 同一会话必须按提交顺序生成回复，避免第二个 Run 看不到第一个 Run 的结果。
      return coordinator.runExclusive(conversationId, async () => {
        queueSpan.end();
        const referencedMessages = store.resolveMessageReferences(conversationId, input.references);
        const content = buildUserContent(input);
        const displayContent = buildDisplayContent(input);
        registry.resolveToolIntent(input);
        const started = await chainTracer.withSpan(
          "storage.start_run",
          buildTraceAttributes({ chainTraceId, requestId: input.requestId, conversationId }),
          /** 在独立存储阶段幂等创建 Run 和用户消息。 */
          () =>
            store.startRun({
              conversationId,
              requestId: input.requestId,
              clientMessageId: input.clientMessageId,
              content,
              displayContent,
              references: input.references,
              model: selectedModel,
            }),
        );
        const effectiveChainTraceId = started.run.resilience?.traceId || chainTraceId;
        if (started.replayed) {
          if (typeof delivery.onRunStarted === "function") {
            await delivery.onRunStarted({
              run: started.run,
              replayed: true,
              chainTraceId: effectiveChainTraceId,
            });
          }
          return replayRun(started, store.getConversation(conversationId));
        }

        const runId = started.run.id;
        const resilienceContext = createResilienceContext({
          traceId: effectiveChainTraceId,
          requestId: input.requestId,
          conversationId,
          runId,
          deadlineAt,
          stage: "run",
          lastCommittedStage: "user-message-committed",
          idempotencyKey: input.requestId,
          outputStarted: false,
        });
        const controller = new AbortController();
        const abortSignal = combineAbortSignals(controller.signal, delivery.abortSignal);
        const activeRun = {
          conversationId,
          controller,
          partialText: "",
          contextManifest: null,
          model: selectedModel,
          resilienceContext,
        };
        activeRuns.set(runId, activeRun);
        const traceAttributes = buildTraceAttributes({
          chainTraceId: effectiveChainTraceId,
          requestId: input.requestId,
          conversationId,
          runId,
        });
        try {
          if (typeof delivery.onRunStarted === "function") {
            await delivery.onRunStarted({
              run: started.run,
              replayed: false,
              chainTraceId: effectiveChainTraceId,
            });
          }
          throwIfAborted(abortSignal);
          let plan = await chainTracer.withSpan(
            "runtime.context.plan",
            traceAttributes,
            /** 规划上下文并把内部 Token 分段写入当前阶段 Span。 */
            async (span) => {
              const result = await contextPlanner.plan({
                conversationId,
                currentMessageId: started.userMessage.id,
                currentContent: content,
                currentDisplayContent: displayContent,
                referencedMessages,
                resilienceContext,
                model: selectedModel,
              });
              span.setAttributes(buildContextTokenAttributes(result.observability));
              return result;
            },
          );
          if (plan.manifest.hardLimitReached) {
            await chainTracer.withSpan(
              "runtime.memory.compact",
              traceAttributes,
              /** 在硬水位时同步压缩旧消息，并记录脱敏结果状态。 */
              async (span) => {
                const result = await memoryManager.compactIfNeeded(conversationId, {
                  force: true,
                  excludeSeq: started.userMessage.seq,
                  resilienceContext,
                });
                span.setAttribute("ai.platform.memory.compaction.status", result.status);
                return result;
              },
            );
            plan = await chainTracer.withSpan(
              "runtime.context.plan",
              { ...traceAttributes, "ai.platform.context.replanned": true },
              /** 压缩后重新规划上下文并刷新 Token 分段。 */
              async (span) => {
                const result = await contextPlanner.plan({
                  conversationId,
                  currentMessageId: started.userMessage.id,
                  currentContent: content,
                  currentDisplayContent: displayContent,
                  referencedMessages,
                  resilienceContext,
                  model: selectedModel,
                });
                span.setAttributes(buildContextTokenAttributes(result.observability));
                return result;
              },
            );
          }
          activeRun.contextManifest = plan.manifest;
          throwIfAborted(abortSignal);

          /** 累积服务端已交付正文，并继续把文本增量透传给当前渠道。 */
          async function handleTextDelta(delta) {
            if (abortSignal.aborted) return;
            const text = String(delta || "");
            if (text.length === 0) return;
            activeRun.partialText += text;
            await delivery.onTextDelta(text);
          }

          const data = await gatewayClient.chatCompletions({
            messages: plan.messages,
            model: selectedModel,
            maxCompletionTokens: options.reservedOutputTokens,
            resilienceContext,
            operation: "model.generate",
            onTextDelta: typeof delivery.onTextDelta === "function" ? handleTextDelta : undefined,
            abortSignal,
          });
          const assistantContent = data?.choices?.[0]?.message?.content || "";
          const completed = await chainTracer.withSpan(
            "storage.complete_run",
            traceAttributes,
            /** 原子持久化助手消息、usage、Context Manifest 和 Run 完成状态。 */
            () =>
              store.completeRun({
                runId,
                content: assistantContent,
                displayContent: assistantContent || "(空响应)",
                usage: data?.usage || null,
                contextManifest: plan.manifest,
                model: data?.model || selectedModel,
                resilience: data?.resilience || null,
              }),
          );
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
          if (isCancellationError(error, abortSignal)) {
            const cancelled = await chainTracer.withSpan(
              "storage.cancel_run",
              traceAttributes,
              /** 幂等收口主动取消，并只在已有文本增量时保存中断助手消息。 */
              () =>
                store.cancelRun({
                  conversationId,
                  runId,
                  partialContent: activeRun.partialText,
                  contextManifest: activeRun.contextManifest,
                  model: activeRun.model,
                  resilience:
                    error?.resilience ||
                    buildCancellationResilience(resilienceContext, activeRun.partialText.length > 0),
                }),
            );
            return buildCancelledRunResponse(cancelled, store.getConversation(conversationId));
          }
          const publicError = toRuntimeExecutionError(error, selectedModel);
          await chainTracer.withSpan(
            "storage.fail_run",
            traceAttributes,
            /** 持久化失败状态，但不把原始错误响应写入 Trace 属性。 */
            () => store.failRun(runId, publicError),
          );
          throw publicError;
        } finally {
          if (activeRuns.get(runId) === activeRun) activeRuns.delete(runId);
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

/** 解析 Run 模型别名，并把目录校验异常转换为渠道安全错误。 */
async function resolveRunModel(gatewayClient, requestedModel) {
  try {
    if (typeof gatewayClient?.resolveModel === "function") return await gatewayClient.resolveModel(requestedModel);
    return String(requestedModel || gatewayClient?.model || "chat-default");
  } catch (error) {
    throw toRuntimeExecutionError(error, requestedModel || gatewayClient?.model);
  }
}

/** 将模型或运行阶段异常映射为稳定、可执行且不包含原始响应正文的渠道错误。 */
function toRuntimeExecutionError(error, model) {
  if (error instanceof RuntimeExecutionError) return error;
  const lastAttempt = readLastFailedAttempt(error?.resilience);
  const statusCode = Number(error?.status ?? lastAttempt?.statusCode);
  const errorType = String(lastAttempt?.errorType || "");
  const rawMessage = String(error?.message || "").toLowerCase();
  const modelLabel = String(model || "所选模型");
  let payload;

  if (errorType === "authorization" || statusCode === 401 || statusCode === 403 || /invalid_api_key|unauthorized|forbidden/.test(rawMessage)) {
    payload = {
      error: "模型鉴权失败",
      detail: `${modelLabel} 的上游访问凭据无效或没有权限。`,
      action: "请检查模型服务凭据与模型访问权限后重试。",
      code: "model_authorization_failed",
      retryable: false,
      model: modelLabel,
    };
  } else if (errorType === "rate_limit" || statusCode === 429) {
    payload = {
      error: "模型服务限流",
      detail: `${modelLabel} 当前请求过于频繁或额度暂时受限。`,
      action: "请稍后重试，或切换到其他可用模型。",
      code: "model_rate_limited",
      retryable: true,
      model: modelLabel,
    };
  } else if (errorType === "timeout" || statusCode === 408 || statusCode === 504) {
    payload = {
      error: "模型响应超时",
      detail: `${modelLabel} 未在本次运行时限内返回完整结果。`,
      action: "可缩短输入后重试，或切换到其他可用模型。",
      code: "model_timeout",
      retryable: true,
      model: modelLabel,
    };
  } else if (errorType === "provider_unavailable" || statusCode >= 500) {
    payload = {
      error: "模型服务暂时不可用",
      detail: `${modelLabel} 的上游服务当前异常。`,
      action: "请稍后重试；持续失败时检查上游服务状态。",
      code: "model_provider_unavailable",
      retryable: true,
      model: modelLabel,
    };
  } else if (error?.data?.code === "unsupported_model" || /unsupported model alias/.test(rawMessage)) {
    payload = {
      error: "所选模型不可用",
      detail: `${modelLabel} 不在当前模型网关授权列表中。`,
      action: "请重新检测模型列表并选择可用模型。",
      code: "unsupported_model",
      retryable: false,
      model: modelLabel,
    };
  } else if (/context.*length|token.*limit|maximum context/.test(rawMessage)) {
    payload = {
      error: "上下文超过模型限制",
      detail: `${modelLabel} 无法接收当前长度的会话上下文。`,
      action: "请缩短输入、减少附件或新建会话后重试。",
      code: "model_context_limit",
      retryable: false,
      model: modelLabel,
    };
  } else if (errorType === "invalid_request" || (statusCode >= 400 && statusCode < 500)) {
    payload = {
      error: "模型无法处理当前请求",
      detail: `${modelLabel} 拒绝了当前输入或参数。`,
      action: "请调整输入内容、附件或模型后重试。",
      code: "model_invalid_request",
      retryable: false,
      model: modelLabel,
    };
  } else {
    payload = {
      error: "无法连接模型服务",
      detail: `${modelLabel} 的模型调用未能完成。`,
      action: "请检查模型网关与网络状态后重试。",
      code: "model_connection_failed",
      retryable: Boolean(error?.retryable),
      model: modelLabel,
    };
  }

  const publicStatus = Number.isFinite(statusCode) ? statusCode : 502;
  return new RuntimeExecutionError(payload, publicStatus, error);
}

/** 从逐尝试证据中读取最后一个失败分类，忽略成功尝试。 */
function readLastFailedAttempt(resilience) {
  const attempts = Array.isArray(resilience?.attempts) ? resilience.attempts : [];
  for (let index = attempts.length - 1; index >= 0; index -= 1) {
    if (attempts[index]?.status === "failed") return attempts[index];
  }
  return null;
}

/** 将完成的幂等 Run 恢复为标准响应；运行中或失败 Run 返回冲突。 */
function replayRun(result, conversation) {
  if (result.run.status !== "completed" || !result.assistantMessage) {
    const message =
      result.run.status === "running"
        ? "Run is already in progress"
        : result.run.status === "cancelled"
          ? "Run was cancelled"
          : result.run.error || "Run failed";
    throw new RuntimeInputError(
      { error: message },
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

/** 将已持久化的取消事实转换为原始 Run 请求可返回的稳定终止结果。 */
function buildCancelledRunResponse(result, conversation) {
  return {
    cancelled: true,
    run: result.run,
    assistantMessage: result.assistantMessage,
    content: result.assistantMessage?.displayContent || "",
    usage: result.run.usage,
    model: result.run.model,
    context: result.run.contextManifest,
    resilience: result.run.resilience,
    conversation,
    replayed: false,
  };
}

/** 合并 Runtime 主动取消与可选调用方信号，任一来源终止都向下游传播。 */
function combineAbortSignals(runtimeSignal, callerSignal) {
  return callerSignal ? AbortSignal.any([runtimeSignal, callerSignal]) : runtimeSignal;
}

/** 在进入耗时阶段前同步检查取消，避免已取消 Run 发起新的模型调用。 */
function throwIfAborted(signal) {
  if (signal.aborted) throw signal.reason || new DOMException("Run was aborted", "AbortError");
}

/** 判断错误是否来自 Runtime 或调用方取消，而不是普通模型失败。 */
function isCancellationError(error, signal) {
  return signal.aborted || Number(error?.status) === 499 || error?.name === "AbortError";
}

/** 构造取消端点可立即持久化且不包含业务正文的最小韧性证据。 */
function buildCancellationResilience(context, outputStarted) {
  return {
    traceId: context.traceId,
    requestId: context.requestId,
    conversationId: context.conversationId,
    runId: context.runId,
    operation: "model.generate",
    attemptCount: 0,
    deadlineAt: new Date(context.deadlineAt).toISOString(),
    stage: "model.generate",
    lastCommittedStage: context.lastCommittedStage,
    idempotencyKey: context.idempotencyKey,
    outputStarted,
    stopReason: "cancelled",
    attempts: [],
  };
}

/** 将 Runtime 总时限规范为正数，避免配置错误产生无界或立即过期的 Run。 */
function normalizeRunTimeout(value) {
  const timeoutMs = Number(value);
  return Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : DEFAULT_RUN_TIMEOUT_MS;
}

/** 生成所有 C1 业务 Span 共用的安全关联属性。 */
function buildTraceAttributes({ chainTraceId, requestId, conversationId, runId }) {
  return {
    "ai.platform.chain_trace_id": chainTraceId,
    "ai.platform.request_id": requestId,
    "ai.platform.conversation_id": conversationId,
    ...(runId ? { "ai.platform.run_id": runId } : {}),
    "ai.platform.scenario_id": "C1",
  };
}

/** 把 Planner 的内部 Token 分段转换为不含正文的数值属性。 */
function buildContextTokenAttributes(observability = {}) {
  const segments = observability.tokenSegments || {};
  return {
    "ai.platform.context.tokens.system": segments.system,
    "ai.platform.context.tokens.current_input": segments.currentInput,
    "ai.platform.context.tokens.references": segments.references,
    "ai.platform.context.tokens.memory": segments.memory,
    "ai.platform.context.tokens.episodes": segments.episodes,
    "ai.platform.context.tokens.history": segments.history,
    "ai.platform.context.tokens.total_input": segments.totalInput,
    "ai.platform.context.tokens.counted_total_input": observability.countedTotalInput,
    "ai.platform.context.token_counter": observability.tokenCounter,
  };
}
