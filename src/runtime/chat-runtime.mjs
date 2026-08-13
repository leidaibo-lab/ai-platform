import { createHash, randomUUID } from "node:crypto";
import { createNullChainTracer } from "../observability/chain-tracer.mjs";
import { createResilienceContext } from "../resilience/retry-executor.mjs";
import { ImageAssetStoreError } from "../storage/image-asset-store.mjs";
import { normalizeContextOptions } from "./context-budget.mjs";
import { ImageGenerationPolicyError, inspectGeneratedImage } from "./image-generation-policy.mjs";
import {
  ExecutionPolicyError,
  assertExecutionAllowed,
  createExecutionPolicy,
} from "./execution-policy.mjs";
import { createResultAcceptanceRegistry } from "./result-acceptance.mjs";
import { createNullRunEventSink } from "./run-event-sink.mjs";
import { RunLeaseError, createRunLeaseCoordinator } from "./run-lease-coordinator.mjs";
import {
  IMAGE_GENERATION_OPERATION,
  buildDisplayContent,
  buildUserContent,
  normalizeRunInput,
  validateRunInput,
} from "./message-builder.mjs";
import { createToolRegistry } from "../tools/tool-registry.mjs";

const DEFAULT_RUN_TIMEOUT_MS = 120000;
const TOOL_RESULT_RECOVERY_INSTRUCTION =
  "你正在恢复一次已完成工具调用后的最终回答。后续结构化 tool-call 和 tool-result 均来自服务端已持久化事实。请仅根据原始问题和这些结果作答，说明可用的数据来源与时间；不要请求、假设或声称再次调用工具。";

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
  imageAssetStore,
  toolRegistry,
  executionPolicy,
  runLeaseCoordinator,
  resultAcceptanceRegistry = createResultAcceptanceRegistry(),
  toolOptions = {},
  chainTracer = createNullChainTracer(),
  resilienceOptions = {},
}) {
  const options = normalizeContextOptions(contextOptions);
  const registry = toolRegistry || createToolRegistry();
  const policy = executionPolicy || createExecutionPolicy({
    allowedReadTools: registry.list().map(readToolDefinitionName),
  });
  const leaseCoordinator = runLeaseCoordinator || createRunLeaseCoordinator({
    store,
    ttlMs: resilienceOptions.runLeaseTtlMs,
    renewIntervalMs: resilienceOptions.runLeaseRenewIntervalMs,
  });
  const aiSdkTools = registry.hasTools() ? registry.buildAiSdkTools() : undefined;
  const runTimeoutMs = normalizeRunTimeout(resilienceOptions.runTimeoutMs);
  const maxToolSteps = normalizeToolStepLimit(toolOptions.maxSteps);
  const activeRuns = new Map();

  /** 隔离可替换 Policy Port 的后置观察异常，禁止其改写已提交执行事实。 */
  async function observeExecutionAfter(input) {
    try {
      return await policy.observeAfter(input);
    } catch {
      return Object.freeze({
        attempted: 1,
        completed: 0,
        failedHooks: Object.freeze([{ hook: "execution-policy", code: "execution_hook_failed" }]),
      });
    }
  }

  /**
   * 扫描并收口上一个进程遗留的 running Run，只从 completed 只读 ToolResult 继续最终总结。
   *
   * @returns {Promise<object>} 扫描数量和每个 Run 的恢复或失败结果。
   */
  async function recoverInterruptedRuns() {
    const candidates = store.listRunningRuns();
    const outcomes = [];
    for (const candidate of candidates) {
      if (activeRuns.has(candidate.run.id)) {
        outcomes.push({ runId: candidate.run.id, status: "skipped", reasonCode: "run_owned_by_current_process" });
        continue;
      }
      const leaseResult = leaseCoordinator.acquire({
        runId: candidate.run.id,
        conversationId: candidate.run.conversationId,
      });
      if (!leaseResult.acquired) {
        outcomes.push({
          runId: candidate.run.id,
          status: "skipped",
          reasonCode: leaseResult.reasonCode || "lease_held",
        });
        continue;
      }
      const outcome = await coordinator.runExclusive(
        candidate.run.conversationId,
        /** 在会话串行边界内重新确认并恢复单个遗留 Run。 */
        () => recoverInterruptedRun(candidate, leaseResult.handle),
      );
      outcomes.push(outcome);
    }
    return {
      scanned: candidates.length,
      recovered: outcomes.filter(isRecoveredOutcome).length,
      failed: outcomes.filter(isFailedRecoveryOutcome).length,
      skipped: outcomes.filter(isSkippedRecoveryOutcome).length,
      outcomes,
    };
  }

  /** 从原 Run 身份、用户消息和 ToolResult 恢复一个无工具最终总结阶段。 */
  async function recoverInterruptedRun(candidate, leaseHandle) {
    const eligibility = classifyRestartRecovery(candidate, registry, resultAcceptanceRegistry);
    if (!eligibility.eligible) {
      const error = createRestartRecoveryError(candidate.run, eligibility);
      store.failRun(candidate.run.id, error, leaseHandle.credentials);
      leaseHandle.stop();
      return { runId: candidate.run.id, status: "failed", reasonCode: eligibility.reasonCode };
    }

    const run = candidate.run;
    const deadlineAt = Date.parse(run.deadlineAt);
    const resilienceContext = createResilienceContext({
      traceId: run.chainTraceId,
      requestId: run.requestId,
      conversationId: run.conversationId,
      runId: run.id,
      deadlineAt,
      stage: "run.restart-recovery",
      lastCommittedStage: "tool-result-committed",
      idempotencyKey: run.requestId,
      outputStarted: false,
      retryBoundaryCrossed: false,
    });
    const controller = new AbortController();
    const activeRun = {
      conversationId: run.conversationId,
      controller,
      partialText: "",
      contextManifest: null,
      model: run.model,
      operation: run.operation,
      resilienceContext,
    };
    activeRuns.set(run.id, activeRun);

    try {
      const referencedMessages = store.resolveMessageReferences(
        run.conversationId,
        candidate.userMessage.references || [],
      );
      let plan = await contextPlanner.plan({
        conversationId: run.conversationId,
        currentMessageId: candidate.userMessage.id,
        currentContent: candidate.userMessage.content,
        currentDisplayContent: candidate.userMessage.displayContent,
        referencedMessages,
        resilienceContext,
        model: run.model,
      });
      if (plan.manifest.hardLimitReached) {
        await memoryManager.compactIfNeeded(run.conversationId, {
          force: true,
          excludeSeq: candidate.userMessage.seq,
          resilienceContext,
        });
        plan = await contextPlanner.plan({
          conversationId: run.conversationId,
          currentMessageId: candidate.userMessage.id,
          currentContent: candidate.userMessage.content,
          currentDisplayContent: candidate.userMessage.displayContent,
          referencedMessages,
          resilienceContext,
          model: run.model,
        });
      }
      activeRun.contextManifest = plan.manifest;
      const recovered = await gatewayClient.chatCompletions({
        messages: buildToolResultRecoveryMessages(plan.messages, candidate.toolCalls),
        model: run.model,
        maxCompletionTokens: options.reservedOutputTokens,
        resilienceContext,
        operation: "model.tool_result_summary",
        abortSignal: controller.signal,
      });
      const candidateContent = recovered?.choices?.[0]?.message?.content || "";
      const acceptance = resultAcceptanceRegistry.evaluate({
        candidateContent,
        toolCalls: candidate.toolCalls,
      });
      const runRecovered = acceptance?.status === "accepted";
      const recoveryResilience = buildRestartRecoveryResilience({
        recoveryResilience: recovered?.resilience,
        runRecovered,
        executionStatus: "completed",
      });
      if (!acceptance || acceptance.status !== "accepted") {
        const error = createAcceptanceRejectionError(acceptance, run.model);
        store.rejectRun({
          runId: run.id,
          acceptance: acceptance || createMissingAcceptanceResult(candidate.toolCalls),
          error,
          resilience: recoveryResilience,
          lease: leaseHandle.credentials,
        });
        leaseHandle.stop();
        return {
          runId: run.id,
          status: "failed",
          reasonCode: "result_acceptance_rejected",
          acceptance: acceptance || null,
          model: recovered?.model || run.model,
          usage: recovered?.usage || null,
        };
      }

      const completed = store.completeRun({
        runId: run.id,
        content: candidateContent,
        displayContent: candidateContent || "(空响应)",
        usage: recovered?.usage || null,
        contextManifest: plan.manifest,
        model: recovered?.model || run.model,
        resilience: recoveryResilience,
        acceptance,
        lease: leaseHandle.credentials,
      });
      leaseHandle.stop();
      if (plan.manifest.highWatermarkReached) memoryManager.schedule(run.conversationId);
      return {
        runId: run.id,
        status: "recovered",
        reasonCode: "tool_result_summary_recovered",
        acceptance: completed.acceptance,
        model: completed.run.model,
        usage: completed.run.usage,
      };
    } catch (error) {
      const publicError = toRuntimeExecutionError(error, run.model);
      publicError.resilience = buildRestartRecoveryResilience({
        recoveryResilience: error?.resilience || publicError.resilience,
        runRecovered: false,
        executionStatus: "failed",
      });
      if (!isRunLeaseLoss(error)) store.failRun(run.id, publicError, leaseHandle.credentials);
      return {
        runId: run.id,
        status: "failed",
        reasonCode: publicError.payload?.code || "run_recovery_failed",
      };
    } finally {
      leaseHandle.stop();
      if (activeRuns.get(run.id) === activeRun) activeRuns.delete(run.id);
    }
  }

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
        ? buildCancellationResilience(
            ownedActive.resilienceContext,
            ownedActive.partialText.length > 0,
            ownedActive.operation === IMAGE_GENERATION_OPERATION ? "model.image.generate" : "model.generate",
          )
        : null,
      lease: ownedActive?.leaseHandle?.credentials || null,
    });
    return { ...cancelled, conversation: store.getConversation(conversationId) };
  }

  return {
    recoverInterruptedRuns,

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

    /** 更新会话标题或归档状态，活动 Run 期间拒绝改变工作台位置。 */
    updateConversation(conversationId, body = {}) {
      if (hasActiveRunForConversation(activeRuns, conversationId)) {
        throw new RuntimeInputError({ error: "Conversation has an active Run", code: "conversation_run_active" }, 409);
      }
      const hasTitle = Object.prototype.hasOwnProperty.call(body, "title");
      const hasArchived = Object.prototype.hasOwnProperty.call(body, "archived");
      if (!hasTitle && !hasArchived) {
        throw new RuntimeInputError({ error: "title or archived is required", code: "invalid_conversation_update" });
      }
      const title = hasTitle ? String(body.title || "").trim() : undefined;
      if (hasTitle && (!title || title.length > 80 || /[\r\n\0]/.test(title))) {
        throw new RuntimeInputError({ error: "title must contain 1 to 80 valid characters", code: "invalid_conversation_title" });
      }
      if (hasArchived && typeof body.archived !== "boolean") {
        throw new RuntimeInputError({ error: "archived must be a boolean", code: "invalid_conversation_archive" });
      }
      return store.updateConversation(conversationId, {
        ...(hasTitle ? { title } : {}),
        ...(hasArchived ? { archived: body.archived } : {}),
      });
    },

    cancelConversationRun,

    /**
     * 串行执行一次会话 Run，先落用户消息，再调用模型并持久化助手结果。
     *
     * @param {string} conversationId - 目标会话 ID。
     * @param {unknown} body - 当前 Run 请求体。
     * @param {object} [execution] - 当前调用的输出模式和事件端口，不包含渠道协议细节。
     * @param {import("./run-event-sink.mjs").RunEventSink} [execution.eventSink] - 接收有序 Runtime 生命周期事件。
     * @param {boolean} [execution.streamText=false] - 是否消费模型文本流并发布易失 `text.delta` 事件。
     * @param {AbortSignal} [execution.abortSignal] - 可选调用方取消信号。
     * @returns {Promise<object>} 回复、会话状态、usage 和 Context Manifest。
     */
    async runConversation(conversationId, body, execution = {}) {
      const input = normalizeRunInput(body);
      const validationError = validateRunInput(input);
      if (validationError) throw new RuntimeInputError(validationError);
      const runExecution = normalizeRunExecution(execution);
      const runPolicyContext = createRunPolicyContext({ conversationId, input });
      const runPolicyDecision = await policy.evaluateBefore(runPolicyContext);
      try {
        assertExecutionAllowed(runPolicyDecision);
      } catch (error) {
        throw toRuntimePolicyError(error);
      }
      const selectedModel = await resolveRunModel(gatewayClient, input.model, input.operation);
      const chainTraceId = randomUUID();
      let currentChainTraceId = chainTraceId;
      const deadlineAt = Date.now() + runTimeoutMs;
      let currentRunId = null;

      /** 发布不依赖渠道协议的 Runtime 生命周期事件；Sink 负责隔离具体订阅者异常。 */
      async function publishRunEvent(type, payload = {}) {
        return runExecution.eventSink.publish({
          ...payload,
          type,
          conversationId,
          requestId: input.requestId,
          chainTraceId: currentChainTraceId,
          runId: currentRunId,
        });
      }

      await publishRunEvent("chain-trace.started");
      const queueSpan = chainTracer.startSpan("runtime.queue", {
        ...buildTraceAttributes({ chainTraceId, requestId: input.requestId, conversationId }),
      });

      // 同一会话必须按提交顺序生成回复，避免第二个 Run 看不到第一个 Run 的结果。
      return coordinator.runExclusive(conversationId, async () => {
        queueSpan.end();
        const referencedMessages = store.resolveMessageReferences(conversationId, input.references);
        const content = buildUserContent(input);
        const displayContent = buildDisplayContent(input);
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
              sourceRunId: input.sourceRunId || null,
              recoveryMode: input.recoveryMode || null,
              operation: input.operation,
              deadlineAt,
              chainTraceId,
            }),
        );
        const effectiveChainTraceId = started.run.chainTraceId || started.run.resilience?.traceId || chainTraceId;
        currentChainTraceId = effectiveChainTraceId;
        currentRunId = started.run.id;
        if (started.replayed) {
          await publishRunEvent("run.started", { status: started.run.status, replayed: true });
          const replayed = replayRun(started, store.getConversation(conversationId));
          await publishRunEvent("run.completed", {
            replayed: true,
            operation: replayed.operation,
            model: replayed.model,
            acceptanceStatus: replayed.acceptance?.status || null,
          });
          return replayed;
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
        const leaseResult = leaseCoordinator.acquire({ runId, conversationId, abortController: controller });
        if (!leaseResult.acquired) throw createRunLeaseContentionError(leaseResult);
        const leaseHandle = leaseResult.handle;
        const abortSignal = combineAbortSignals(controller.signal, runExecution.abortSignal);
        const activeRun = {
          conversationId,
          controller,
          partialText: "",
          contextManifest: null,
          model: selectedModel,
          operation: input.operation,
          resilienceContext,
          leaseHandle,
        };
        activeRuns.set(runId, activeRun);
        const traceAttributes = buildTraceAttributes({
          chainTraceId: effectiveChainTraceId,
          requestId: input.requestId,
          conversationId,
          runId,
        });
        const requiredToolName = registry.resolveRequiredTool({ message: input.message });
        const runTools = requiredToolName && aiSdkTools
          ? { [requiredToolName]: aiSdkTools[requiredToolName] }
          : undefined;
        const acceptanceRequired = resultAcceptanceRegistry.requiresTool(requiredToolName);
        const pendingTextDeltas = [];
        let runTerminalObserved = false;

        /** 对当前 Run 的单个已提交终态执行一次后置观察；重复收口不会重复触发 Hook。 */
        async function observeRunTerminal(outcome) {
          if (runTerminalObserved) return null;
          runTerminalObserved = true;
          return observeExecutionAfter({
            context: { ...runPolicyContext, runId },
            policyDecision: runPolicyDecision,
            outcome,
          });
        }

        /** 将已持久化工具阶段发布为不含输入和完整结果的安全事件。 */
        async function emitToolEvent(type, toolCall) {
          await publishRunEvent(`tool.${type}`, {
            toolCallId: toolCall.toolCallId,
            toolName: toolCall.toolName,
            title: registry.get(toolCall.toolName)?.title || toolCall.toolName,
            status: toolCall.status,
            source: toolCall.source,
            observedAt: toolCall.observedAt,
            error: toolCall.error,
          });
        }

        /** 在 Runtime 权限、事实、Trace 和取消边界内执行一个 AI SDK 工具调用。 */
        async function executeRegisteredTool(definition, toolInput, toolExecutionOptions = {}) {
          throwIfAborted(abortSignal);
          const toolCallId = String(toolExecutionOptions.toolCallId || randomUUID());
          const toolPolicyContext = createToolPolicyContext({
            conversationId,
            runId,
            requestId: input.requestId,
            definition,
          });
          const toolPolicyDecision = await policy.evaluateBefore(toolPolicyContext);
          try {
            assertExecutionAllowed(toolPolicyDecision);
          } catch (error) {
            throw toRuntimePolicyError(error);
          }
          leaseHandle.assertOwned();
          const startedTool = store.startToolCall({
            conversationId,
            runId,
            toolCallId,
            toolName: definition.name,
            input: toolInput,
            operationKey: `tool:${toolCallId}`,
            idempotencyKey: `${runId}:tool:${toolCallId}`,
            effect: definition.effect,
            riskLevel: definition.riskLevel || "low",
            policyDecision: toolPolicyDecision,
            lease: leaseHandle.credentials,
          });
          if (startedTool.replayed && startedTool.status === "completed") return startedTool.output;
          if (startedTool.replayed && startedTool.status === "failed") {
            return { status: "error", error: startedTool.error };
          }
          await emitToolEvent("started", startedTool);
          const toolSignal = combineAbortSignals(abortSignal, toolExecutionOptions.abortSignal);
          try {
            const data = await chainTracer.withSpan(
              "runtime.tool.execute",
              {
                ...traceAttributes,
                "ai.platform.capability_scenario_id": "C4",
                "gen_ai.tool.name": definition.name,
                "ai.platform.tool_call_id": toolCallId,
              },
              /** 调用固定 allowlist 中的 Connector，不允许模型控制外部目标。 */
              () => definition.execute(toolInput, { abortSignal: toolSignal }),
            );
            const output = { status: "success", data };
            leaseHandle.assertOwned();
            const completedTool = store.completeToolCall({
              runId,
              toolCallId,
              output,
              source: data?.source?.name || null,
              observedAt: data?.observedAt || data?.source?.retrievedAt || null,
              lease: leaseHandle.credentials,
            });
            await emitToolEvent("completed", completedTool);
            await observeExecutionAfter({
              context: toolPolicyContext,
              policyDecision: toolPolicyDecision,
              outcome: { status: "completed", operationId: completedTool.operationId },
            });
            return output;
          } catch (error) {
            if (leaseHandle.lostError || isRunLeaseLoss(error)) {
              throw leaseHandle.lostError || error;
            }
            const cancelled = isCancellationError(error, toolSignal);
            const publicError = cancelled
              ? { code: "tool_cancelled", message: "工具调用已取消。", retryable: false }
              : mapPublicToolError(definition, error);
            if (isRunLeaseLoss(error)) throw error;
            const failedTool = store.failToolCall({
              runId,
              toolCallId,
              ...publicError,
              lease: leaseHandle.credentials,
            });
            await emitToolEvent("failed", failedTool);
            await observeExecutionAfter({
              context: toolPolicyContext,
              policyDecision: toolPolicyDecision,
              outcome: {
                status: cancelled ? "cancelled" : "failed",
                errorCode: publicError.code,
                operationId: failedTool.operationId,
              },
            });
            if (cancelled) throw error;
            return { status: "error", error: publicError };
          }
        }

        try {
          await publishRunEvent("run.started", { status: started.run.status, replayed: false });
          throwIfAborted(abortSignal);
          if (input.operation === IMAGE_GENERATION_OPERATION) {
            if (!imageAssetStore || typeof gatewayClient?.generateImages !== "function") {
              throw new RuntimeExecutionError({
                error: "图片生成能力未配置",
                detail: "当前 Runtime 尚未装配图片模型或图片资产存储。",
                action: "请配置图片模型别名与资产目录后重试。",
                code: "image_generation_unavailable",
                retryable: false,
                model: selectedModel,
              }, 503);
            }
            const generated = await chainTracer.withSpan(
              "runtime.image.generate",
              {
                ...traceAttributes,
                "ai.platform.capability_scenario_id": "C2",
                "ai.platform.image.size": input.imageOptions.size,
              },
              /** 通过 GatewayClient 单次调用图片模型，不把提示词写入 Trace。 */
              () => gatewayClient.generateImages({
                prompt: input.message,
                model: selectedModel,
                size: input.imageOptions.size,
                resilienceContext,
                abortSignal,
              }),
            );
            const storedAssets = [];
            let assetsCommitted = false;
            try {
              for (const generatedImage of generated.images || []) {
                throwIfAborted(abortSignal);
                const inspected = inspectGeneratedImage(generatedImage.bytes, generatedImage.mediaType);
                const assetId = randomUUID();
                const stored = await imageAssetStore.write({
                  assetId,
                  bytes: inspected.bytes,
                  mediaType: inspected.mediaType,
                });
                storedAssets.push({
                  assetId,
                  storageKey: stored.storageKey,
                  mediaType: inspected.mediaType,
                  sizeBytes: inspected.sizeBytes,
                  width: inspected.width,
                  height: inspected.height,
                  sha256: createHash("sha256").update(inspected.bytes).digest("hex"),
                });
              }
              if (storedAssets.length === 0) {
                throw new ImageGenerationPolicyError("图片模型没有返回可用图片", "image_generation_empty", 502);
              }
              throwIfAborted(abortSignal);
              const completed = await chainTracer.withSpan(
                "storage.complete_image_run",
                {
                  ...traceAttributes,
                  "ai.platform.image.count": storedAssets.length,
                },
                /** 原子登记图片元数据、消息引用和 Run 完成状态。 */
                () => {
                  leaseHandle.assertOwned();
                  return store.completeImageRun({
                    runId,
                    assets: storedAssets,
                    displayContent: `已生成 ${storedAssets.length} 张图片`,
                    usage: generated.usage || null,
                    model: generated.model || selectedModel,
                    resilience: generated.resilience || null,
                    lease: leaseHandle.credentials,
                  });
                },
              );
              leaseHandle.stop();
              assetsCommitted = true;
              await observeRunTerminal({ status: "completed" });
              for (const artifact of completed.artifacts || []) {
                await publishRunEvent("artifact.created", { artifact });
              }
              const result = {
                operation: input.operation,
                content: completed.assistantMessage.displayContent,
                artifacts: completed.artifacts || [],
                usage: completed.run.usage,
                model: completed.run.model,
                context: null,
                resilience: completed.run.resilience,
                toolCalls: [],
                conversation: store.getConversation(conversationId),
                replayed: false,
              };
              await publishRunEvent("run.completed", {
                replayed: false,
                operation: result.operation,
                model: result.model,
                acceptanceStatus: null,
              });
              return result;
            } catch (error) {
              if (!assetsCommitted) await cleanupImageAssets(imageAssetStore, storedAssets);
              if (error && typeof error === "object" && !error.resilience && generated.resilience) {
                error.resilience = generated.resilience;
              }
              throw error;
            }
          }
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

          /** 累积服务端已生成正文，并把允许交付的增量发布为易失 Runtime 事件。 */
          async function handleTextDelta(delta) {
            if (abortSignal.aborted) return;
            const text = String(delta || "");
            if (text.length === 0) return;
            if (acceptanceRequired) {
              pendingTextDeltas.push(text);
              return;
            }
            activeRun.partialText += text;
            await publishRunEvent("text.delta", { delta: text });
          }

          const allToolsContext = runTools ? registry.buildAiSdkToolsContext(executeRegisteredTool) : undefined;
          const toolsContext = runTools
            ? { [requiredToolName]: allToolsContext[requiredToolName] }
            : undefined;
          let data;
          try {
            data = await gatewayClient.chatCompletions({
              messages: plan.messages,
              model: selectedModel,
              maxCompletionTokens: options.reservedOutputTokens,
              resilienceContext,
              operation: "model.generate",
              tools: runTools,
              toolsContext,
              requiredToolName,
              maxToolSteps,
              onTextDelta: runExecution.streamText ? handleTextDelta : undefined,
              abortSignal,
            });
          } catch (error) {
            const completedToolCalls = store.listToolCalls(runId).filter(isCompletedToolCall);
            if (!shouldRecoverToolResultSummary(error, completedToolCalls, activeRun.partialText)) throw error;
            pendingTextDeltas.length = 0;
            const originalResilience = error.resilience;
            data = await chainTracer.withSpan(
              "runtime.tool_result_summary.recover",
              {
                ...traceAttributes,
                "ai.platform.tool_result.count": completedToolCalls.length,
              },
              /** 使用 SQLite 工具事实做无工具模型续接，恢复阶段不得再次进入 Connector。 */
              async () => {
                try {
                  const recovered = await gatewayClient.chatCompletions({
                    messages: buildToolResultRecoveryMessages(plan.messages, completedToolCalls),
                    model: selectedModel,
                    maxCompletionTokens: options.reservedOutputTokens,
                    resilienceContext,
                    operation: "model.tool_result_summary",
                    onTextDelta: runExecution.streamText ? handleTextDelta : undefined,
                    abortSignal,
                  });
                  return {
                    ...recovered,
                    resilience: buildToolResultRecoveryResilience(
                      originalResilience,
                      recovered.resilience,
                      true,
                    ),
                  };
                } catch (recoveryError) {
                  throw attachToolResultRecoveryFailure(recoveryError, originalResilience);
                }
              },
            );
          }
          const assistantContent = data?.choices?.[0]?.message?.content || "";
          const toolCalls = store.listToolCalls(runId);
          const acceptance = resultAcceptanceRegistry.evaluate({
            candidateContent: assistantContent,
            toolCalls,
          });
          const effectiveAcceptance = acceptanceRequired && !acceptance
            ? createMissingAcceptanceResult(toolCalls)
            : acceptance;
          if (effectiveAcceptance && effectiveAcceptance.status !== "accepted") {
            const rejectionError = createAcceptanceRejectionError(effectiveAcceptance, selectedModel);
            store.rejectRun({
              runId,
              acceptance: effectiveAcceptance,
              error: rejectionError,
              resilience: data?.resilience || null,
              lease: leaseHandle.credentials,
            });
            leaseHandle.stop();
            await observeRunTerminal({
              status: "failed",
              errorCode: rejectionError.payload?.code || "result_acceptance_rejected",
            });
            throw rejectionError;
          }
          const completed = await chainTracer.withSpan(
            "storage.complete_run",
            traceAttributes,
            /** 原子持久化助手消息、usage、Context Manifest 和 Run 完成状态。 */
            () =>
              {
                leaseHandle.assertOwned();
                return store.completeRun({
                  runId,
                  content: assistantContent,
                  displayContent: assistantContent || "(空响应)",
                  usage: data?.usage || null,
                  contextManifest: plan.manifest,
                  model: data?.model || selectedModel,
                  resilience: data?.resilience || null,
                  acceptance: effectiveAcceptance,
                  lease: leaseHandle.credentials,
                });
              },
          );
          leaseHandle.stop();
          await observeRunTerminal({ status: "completed" });
          if (effectiveAcceptance?.status === "accepted") {
            await releaseAcceptedCandidate({
              chainTracer,
              traceAttributes,
              publishRunEvent,
              pendingTextDeltas,
              candidateContent: assistantContent,
            });
          }
          if (plan.manifest.highWatermarkReached) memoryManager.schedule(conversationId);

          const result = {
            content: completed.assistantMessage.displayContent,
            usage: completed.run.usage,
            model: completed.run.model,
            context: completed.run.contextManifest,
            resilience: completed.run.resilience,
            toolCalls,
            acceptance: completed.acceptance,
            conversation: store.getConversation(conversationId),
            replayed: false,
          };
          await publishRunEvent("run.completed", {
            replayed: false,
            operation: input.operation,
            model: result.model,
            acceptanceStatus: result.acceptance?.status || null,
          });
          return result;
        } catch (error) {
          const leaseLoss = leaseHandle.lostError || (isRunLeaseLoss(error) ? error : null);
          if (leaseLoss) {
            await publishRunEvent("run.error", {
              errorCode: leaseLoss.code || "run_lease_lost",
              status: 409,
            });
            throw toRuntimeLeaseError(leaseLoss);
          }
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
                    buildCancellationResilience(
                      resilienceContext,
                      activeRun.partialText.length > 0,
                      input.operation === IMAGE_GENERATION_OPERATION ? "model.image.generate" : "model.generate",
                    ),
                  lease: leaseHandle.credentials,
                }),
            );
            leaseHandle.stop();
            await observeRunTerminal({ status: "cancelled" });
            const result = buildCancelledRunResponse(cancelled, store.getConversation(conversationId));
            await publishRunEvent("run.cancelled", {
              operation: result.operation,
              partialOutput: Boolean(result.content),
            });
            return result;
          }
          const publicError = toRuntimeExecutionError(error, selectedModel);
          await chainTracer.withSpan(
            "storage.fail_run",
            traceAttributes,
            /** 持久化失败状态，但不把原始错误响应写入 Trace 属性。 */
            () => store.failRun(runId, publicError, leaseHandle.credentials),
          );
          leaseHandle.stop();
          await observeRunTerminal({
            status: "failed",
            errorCode: publicError.payload?.code || "runtime_execution_failed",
          });
          await publishRunEvent("run.error", {
            errorCode: publicError.payload?.code || "runtime_execution_failed",
            status: publicError.status,
          });
          throw publicError;
        } finally {
          activeRun.leaseHandle?.stop();
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

/** 将可选执行配置收敛为 Runtime 自有事件端口和流消费开关。 */
function normalizeRunExecution(execution) {
  const input = execution && typeof execution === "object" ? execution : {};
  const eventSink = input.eventSink || createNullRunEventSink();
  if (typeof eventSink.publish !== "function") throw new TypeError("run eventSink.publish must be a function");
  if (input.abortSignal !== undefined && !(input.abortSignal instanceof AbortSignal)) {
    throw new TypeError("run abortSignal must be an AbortSignal");
  }
  return Object.freeze({
    eventSink,
    streamText: Boolean(input.streamText),
    abortSignal: input.abortSignal,
  });
}

/** 返回 Tool Registry 公开定义中的稳定工具名。 */
function readToolDefinitionName(definition) {
  return definition.name;
}

/** 构造不含正文或附件的 Run 前置策略上下文。 */
function createRunPolicyContext({ conversationId, input }) {
  return {
    kind: "run",
    operation: input.operation,
    effect: input.operation === IMAGE_GENERATION_OPERATION ? "write" : "read",
    riskLevel: input.operation === IMAGE_GENERATION_OPERATION ? "medium" : "low",
    known: ["conversation.chat", IMAGE_GENERATION_OPERATION].includes(input.operation),
    conversationId,
    requestId: input.requestId,
  };
}

/** 构造不含工具输入的 Tool 前置策略上下文。 */
function createToolPolicyContext({ conversationId, runId, requestId, definition }) {
  return {
    kind: "tool",
    operation: "tool.execute",
    toolName: definition.name,
    effect: definition.effect || "unknown",
    riskLevel: definition.riskLevel || (definition.effect === "read" ? "low" : "high"),
    known: true,
    conversationId,
    runId,
    requestId,
  };
}

/** 将 Policy 的稳定非 allow 结论映射为不暴露规则内部结构的 Runtime 错误。 */
function toRuntimePolicyError(error) {
  if (!(error instanceof ExecutionPolicyError)) throw error;
  const decision = error.policyDecision?.decision || "deny";
  const requiresConfirmation = decision === "confirmation_required";
  return new RuntimeExecutionError(
    {
      error: requiresConfirmation ? "操作需要确认" : "操作未通过执行策略",
      detail: requiresConfirmation
        ? "当前操作可能产生外部副作用，尚未获得明确确认。"
        : "当前版本的执行策略没有允许该操作。",
      action: requiresConfirmation ? "请完成确认后再发起操作。" : "请检查操作类型或平台策略配置。",
      code: error.code || "execution_denied",
      policy: error.policyDecision?.policy || null,
      policyVersion: error.policyDecision?.policyVersion || null,
      reasonCodes: error.policyDecision?.reasonCodes || ["operation_unknown"],
      retryable: decision === "defer",
    },
    requiresConfirmation ? 409 : 403,
    error,
  );
}

/** 为新 Run 取得 lease 失败构造可重试且不泄露 owner 的公开错误。 */
function createRunLeaseContentionError(result) {
  return new RuntimeExecutionError(
    {
      error: "运行正在由其他实例处理",
      detail: "当前 Run 的执行租约尚未释放。",
      action: "请使用原 requestId 查询或稍后重试。",
      code: result.reasonCode || "lease_held",
      retryable: true,
    },
    409,
  );
}

/** 判断异常是否表示当前 Runtime 已失去 owner 或 fencing token。 */
function isRunLeaseLoss(error) {
  return error instanceof RunLeaseError || [
    "run_lease_lost",
    "run_lease_expired",
    "stale_fencing_token",
    "stale_lease_owner",
    "lease_released",
  ].includes(String(error?.code || ""));
}

/** 将租约丢失映射为不改写旧 Run 的公开冲突错误。 */
function toRuntimeLeaseError(error) {
  return new RuntimeExecutionError(
    {
      error: "当前实例已失去运行所有权",
      detail: "RunLease 已过期、被接管或 fencing token 已失效。",
      action: "请使用原 requestId 查询由新实例提交的最终状态。",
      code: String(error?.code || "run_lease_lost"),
      retryable: true,
    },
    409,
    error,
  );
}

/** 判断当前 Runtime 实例是否仍拥有指定会话的活动 Run。 */
function hasActiveRunForConversation(activeRuns, conversationId) {
  for (const run of activeRuns.values()) {
    if (run.conversationId === conversationId) return true;
  }
  return false;
}

/** 解析 Run 模型别名，并把目录校验异常转换为渠道安全错误。 */
async function resolveRunModel(gatewayClient, requestedModel, operation) {
  try {
    if (operation === IMAGE_GENERATION_OPERATION && typeof gatewayClient?.resolveImageModel === "function") {
      return await gatewayClient.resolveImageModel(requestedModel);
    }
    if (operation === IMAGE_GENERATION_OPERATION) {
      return String(requestedModel || gatewayClient?.imageModel || "image-default");
    }
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

  if (error instanceof ImageGenerationPolicyError) {
    payload = {
      error: "图片生成结果无效",
      detail: "图片模型返回的结果未通过平台格式、大小或尺寸校验。",
      action: "请检查图片模型兼容性后重试。",
      code: error.code,
      retryable: false,
      model: modelLabel,
    };
  } else if (error instanceof ImageAssetStoreError) {
    payload = {
      error: "图片资产保存失败",
      detail: "图片已经生成，但未能保存为可访问的会话资产。",
      action: "请检查图片资产目录权限与空间后重新发起生成。",
      code: error.code,
      retryable: false,
      model: modelLabel,
    };
  } else if (errorType === "authorization" || statusCode === 401 || statusCode === 403 || /invalid_api_key|unauthorized|forbidden/.test(rawMessage)) {
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
  const recoveryAttempt = readLastFailedAttemptFromTrace(resilience?.recovery?.execution);
  if (resilience?.recovery?.status === "failed" && recoveryAttempt) return recoveryAttempt;
  return readLastFailedAttemptFromTrace(resilience);
}

/** 从单段韧性证据中倒序读取最后一个失败尝试。 */
function readLastFailedAttemptFromTrace(resilience) {
  const attempts = Array.isArray(resilience?.attempts) ? resilience.attempts : [];
  for (let index = attempts.length - 1; index >= 0; index -= 1) {
    if (attempts[index]?.status === "failed") return attempts[index];
  }
  return null;
}

/** 判断工具事实是否已成功提交，可作为模型总结恢复的可信输入。 */
function isCompletedToolCall(toolCall) {
  return toolCall?.status === "completed" && toolCall.output !== null && toolCall.output !== undefined;
}

/** 只允许未交付正文的工具后瞬时失败进入自动总结恢复。 */
function shouldRecoverToolResultSummary(error, completedToolCalls, partialText) {
  if (!Array.isArray(completedToolCalls) || completedToolCalls.length === 0) return false;
  if (String(partialText || "").length > 0) return false;
  if (error?.resilience?.retryBoundaryCrossed !== true) return false;
  return readLastFailedAttemptFromTrace(error.resilience)?.stopReason === "retry-boundary-crossed";
}

/** 从原上下文和 SQLite ToolResult 构造 AI SDK 原生工具调用与结果续接消息。 */
function buildToolResultRecoveryMessages(messages, completedToolCalls) {
  const recoveryMessages = [{ role: "system", content: TOOL_RESULT_RECOVERY_INSTRUCTION }, ...messages];
  for (const toolCall of completedToolCalls) {
    recoveryMessages.push(
      {
        role: "assistant",
        content: [
          {
            type: "tool-call",
            toolCallId: toolCall.toolCallId,
            toolName: toolCall.toolName,
            input: toolCall.input,
          },
        ],
      },
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: toolCall.toolCallId,
            toolName: toolCall.toolName,
            output: { type: "json", value: toolCall.output },
          },
        ],
      },
    );
  }
  return recoveryMessages;
}

/** 在顶层保留原失败，并附加成功或失败的无工具恢复执行证据。 */
function buildToolResultRecoveryResilience(originalResilience, recoveryResilience, recovered) {
  return {
    ...(originalResilience || {}),
    recovered: Boolean(recovered),
    recovery: {
      reason: "tool-result-summary",
      status: recovered ? "completed" : "failed",
      execution: recoveryResilience || null,
    },
  };
}

/** 为恢复异常附加组合韧性证据，供既有失败映射和 Store 原样持久化。 */
function attachToolResultRecoveryFailure(error, originalResilience) {
  const failure = error instanceof Error ? error : new Error("ToolResult summary recovery failed");
  failure.resilience = buildToolResultRecoveryResilience(originalResilience, error?.resilience, false);
  return failure;
}

/** 区分恢复阶段是否执行完毕，以及整个 Run 是否最终被系统接受。 */
function buildRestartRecoveryResilience({ recoveryResilience, runRecovered, executionStatus }) {
  return {
    recovered: Boolean(runRecovered),
    recovery: {
      reason: "process-restart-after-tool-result",
      status: executionStatus === "completed" ? "completed" : "failed",
      execution: recoveryResilience || null,
    },
  };
}

/**
 * 根据持久化 Run 与 ToolCall 事实判断是否允许进程重启恢复。
 *
 * @param {object} candidate - Store 返回的完整 running Run 事实。
 * @param {object} registry - 服务端工具 allowlist。
 * @param {object} acceptanceRegistry - 结果验收策略注册表。
 * @returns {{eligible: boolean, reasonCode: string}} 恢复资格和稳定原因码。
 */
function classifyRestartRecovery(candidate, registry, acceptanceRegistry) {
  const run = candidate?.run;
  if (!run || run.status !== "running") return ineligibleRecovery("run_not_running");
  if (run.operation !== "conversation.chat") return ineligibleRecovery("run_operation_not_recoverable");
  if (!candidate.userMessage || candidate.assistantMessage) return ineligibleRecovery("run_message_state_not_recoverable");
  if (!run.deadlineAt || !Number.isFinite(Date.parse(run.deadlineAt))) {
    return ineligibleRecovery("run_recovery_metadata_missing");
  }
  if (Date.parse(run.deadlineAt) <= Date.now()) return ineligibleRecovery("run_recovery_deadline_exceeded");
  if (!run.chainTraceId || !run.model) return ineligibleRecovery("run_recovery_metadata_missing");
  if (!Array.isArray(candidate.toolCalls) || candidate.toolCalls.length === 0) {
    return ineligibleRecovery("run_stable_checkpoint_missing");
  }
  for (const toolCall of candidate.toolCalls) {
    if (toolCall.status !== "completed" || toolCall.output == null) {
      return ineligibleRecovery("tool_result_not_completed");
    }
    const definition = registry.get(toolCall.toolName);
    if (!definition || definition.effect !== "read") return ineligibleRecovery("tool_not_safely_recoverable");
    if (!acceptanceRegistry.requiresTool(toolCall.toolName)) {
      return ineligibleRecovery("tool_acceptance_policy_missing");
    }
  }
  return { eligible: true, reasonCode: "tool_result_checkpoint_available" };
}

/** 创建统一的不可恢复分类结果。 */
function ineligibleRecovery(reasonCode) {
  return { eligible: false, reasonCode };
}

/** 把遗留 Run 的不可恢复分类映射为持久化公开错误。 */
function createRestartRecoveryError(run, eligibility) {
  const deadlineExceeded = eligibility.reasonCode === "run_recovery_deadline_exceeded";
  const error = new RuntimeExecutionError(
    {
      error: deadlineExceeded ? "运行恢复时限已耗尽" : "运行无法从当前状态恢复",
      detail: deadlineExceeded
        ? "服务重启时原 Run 的绝对截止时间已经耗尽。"
        : "服务重启后没有找到可证明安全的只读稳定提交点。",
      action: "请使用新的幂等标识重新发起请求。",
      code: deadlineExceeded ? "run_recovery_deadline_exceeded" : "run_recovery_unavailable",
      recoveryReasonCode: eligibility.reasonCode,
      retryable: true,
      model: run?.model || null,
    },
    deadlineExceeded ? 504 : 409,
  );
  error.resilience = {
    recovered: false,
    recovery: {
      reason: "process-restart",
      status: "failed",
      stopReason: eligibility.reasonCode,
      execution: null,
    },
  };
  return error;
}

/** 将 rejected AcceptanceResult 映射为不携带模型候选正文的 Runtime 错误。 */
function createAcceptanceRejectionError(acceptance, model) {
  return new RuntimeExecutionError(
    {
      error: "模型结果未通过系统验收",
      detail: "候选回答缺少与已持久化工具事实匹配的关键证据。",
      action: "请稍后重试；持续失败时检查模型提示和结果验收规则。",
      code: "result_acceptance_rejected",
      acceptanceReasonCodes: acceptance?.reasonCodes || ["acceptance_result_missing"],
      retryable: true,
      model: String(model || "所选模型"),
    },
    502,
  );
}

/** 为理论上缺失的验收器构造可持久化拒绝事实，避免把未验收结果写成完成。 */
function createMissingAcceptanceResult(toolCalls) {
  return {
    policy: "runtime-result",
    policyVersion: "runtime-result.v1",
    status: "rejected",
    reasonCodes: ["acceptance_result_missing"],
    evidence: {
      toolCallIds: toolCalls.map(readToolCallId).filter(Boolean),
      toolNames: [...new Set(toolCalls.map(readToolName).filter(Boolean))],
    },
    evaluatedAt: new Date().toISOString(),
  };
}

/** 验收通过后按原顺序发布暂存增量；没有增量时由最终结果承载正文。 */
async function publishAcceptedCandidate(publishRunEvent, pendingDeltas, candidateContent) {
  const report = { subscriberCount: 0, deliveredCount: 0, failedCount: 0 };
  if (typeof publishRunEvent !== "function" || (pendingDeltas.length === 0 && !candidateContent)) return report;
  for (const delta of pendingDeltas) {
    const published = await publishRunEvent("text.delta", { delta });
    report.subscriberCount = Math.max(report.subscriberCount, published.subscriberCount);
    report.deliveredCount += published.deliveredCount;
    report.failedCount += published.failedCount;
  }
  return report;
}

/**
 * 在 Run 完成事实提交后释放已验收正文；订阅失败只记录观察阶段，不反向改写执行终态。
 *
 * @param {object} input - 已验收正文和当前追踪依赖。
 * @returns {Promise<void>}
 */
async function releaseAcceptedCandidate({
  chainTracer,
  traceAttributes,
  publishRunEvent,
  pendingTextDeltas,
  candidateContent,
}) {
  const span = chainTracer.startSpan("runtime.accepted_candidate.release", {
    ...traceAttributes,
    "ai.platform.run.status": "completed",
  });
  try {
    const report = await publishAcceptedCandidate(publishRunEvent, pendingTextDeltas, candidateContent);
    span.setAttribute("ai.platform.event.publish.status", report.failedCount > 0 ? "failed" : "completed");
  } catch (error) {
    span.recordError(error, { "ai.platform.event.publish.status": "failed" });
  } finally {
    span.end();
  }
}

/** 返回恢复报告中的 Run ID。 */
function readToolCallId(toolCall) {
  return String(toolCall?.toolCallId || "");
}

/** 返回恢复报告中的稳定工具名。 */
function readToolName(toolCall) {
  return String(toolCall?.toolName || "");
}

/** 判断启动恢复结果已经完成原 Run。 */
function isRecoveredOutcome(outcome) {
  return outcome.status === "recovered";
}

/** 判断启动恢复结果已明确收口失败。 */
function isFailedRecoveryOutcome(outcome) {
  return outcome.status === "failed";
}

/** 判断启动恢复候选仍由当前进程拥有而被跳过。 */
function isSkippedRecoveryOutcome(outcome) {
  return outcome.status === "skipped";
}

/** 通过工具专属映射生成安全错误，未知实现不透传原始异常正文。 */
function mapPublicToolError(definition, error) {
  if (typeof definition?.toPublicError === "function") {
    const mapped = definition.toPublicError(error);
    if (mapped?.code && mapped?.message) {
      return {
        code: String(mapped.code),
        message: String(mapped.message),
        retryable: Boolean(mapped.retryable),
      };
    }
  }
  return {
    code: "tool_execution_failed",
    message: "工具执行未能完成。",
    retryable: false,
  };
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
    operation: result.run.operation,
    content: result.assistantMessage.displayContent,
    artifacts: result.artifacts || [],
    usage: result.run.usage,
    model: result.run.model,
    context: result.run.contextManifest,
    resilience: result.run.resilience,
    toolCalls: result.toolCalls || [],
    acceptance: result.acceptance || null,
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
    operation: result.run.operation,
    artifacts: result.artifacts || [],
    usage: result.run.usage,
    model: result.run.model,
    context: result.run.contextManifest,
    resilience: result.run.resilience,
    toolCalls: result.toolCalls || [],
    acceptance: result.acceptance || null,
    conversation,
    replayed: false,
  };
}

/** 清理尚未进入 SQLite 稳定事实的图片二进制，清理失败不覆盖原始 Run 错误。 */
async function cleanupImageAssets(imageAssetStore, assets) {
  for (const asset of assets) {
    try {
      await imageAssetStore.delete(asset.storageKey);
    } catch {
      // 原始生成或事务错误优先返回；残留文件由后续资产清理任务处理。
    }
  }
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
function buildCancellationResilience(context, outputStarted, operation = "model.generate") {
  return {
    traceId: context.traceId,
    requestId: context.requestId,
    conversationId: context.conversationId,
    runId: context.runId,
    operation,
    attemptCount: 0,
    deadlineAt: new Date(context.deadlineAt).toISOString(),
    stage: "model.generate",
    lastCommittedStage: context.lastCommittedStage,
    idempotencyKey: context.idempotencyKey,
    outputStarted,
    retryBoundaryCrossed: context.retryBoundaryCrossed,
    stopReason: "cancelled",
    attempts: [],
  };
}

/** 将 Runtime 总时限规范为正数，避免配置错误产生无界或立即过期的 Run。 */
function normalizeRunTimeout(value) {
  const timeoutMs = Number(value);
  return Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : DEFAULT_RUN_TIMEOUT_MS;
}

/** 将 Runtime 工具步骤上限限制为 1 到 8，默认四步避免无界调用。 */
function normalizeToolStepLimit(value) {
  const steps = Number(value);
  return Number.isInteger(steps) && steps >= 1 && steps <= 8 ? steps : 4;
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
