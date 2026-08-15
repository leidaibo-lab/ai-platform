import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";

const RECOVERY_SOURCE_STATUS = Object.freeze({
  retry: "failed",
  regenerate: "completed",
  continue: "cancelled",
});
const ROUTING_CONTEXT_STRATEGY_VERSION = "routing-context.v2";
const ROUTING_CONTEXT_DEFAULT_MAX_MESSAGES = 12;
const ROUTING_CONTEXT_MAX_MESSAGES = 50;
const ROUTING_CONTEXT_MESSAGE_MAX_CHARS = 1000;
const ROUTING_CONTEXT_URL_PLACEHOLDER = "[url]";
const ROUTING_CONTEXT_DATA_URL_PLACEHOLDER = "[data-url]";
const ROUTING_CONTEXT_TRUNCATED_CONTENT_PLACEHOLDER = "[message-content-truncated]";
const ROUTING_URL_HARD_BOUNDARIES = new Set([
  "<", ">", "\"", "'", "`", "\\",
  "，", "。", "；", "！", "？", "、", "：",
  "（", "）", "【", "】", "《", "》", "「", "」", "『", "』",
]);
const ROUTING_URL_TRAILING_PUNCTUATION = new Set([".", ",", ";", "!", "?", ":"]);
const INTENT_DECISION_MAX_CANDIDATES = 8;
const INTENT_DECISION_MAX_EVIDENCE_MESSAGES = 12;
const INTENT_DECISION_OPERATIONS = Object.freeze([
  "conversation.chat",
  "image.generate",
  "image.edit",
]);
const INTENT_DECISION_SOURCES = Object.freeze([
  "attachment-constraint",
  "structured-classifier",
  "low-confidence-fallback",
  "classification-fallback",
  "invalid-candidate-fallback",
  "invalid-context-evidence-fallback",
]);

/**
 * @typedef {object} RoutingActiveImage
 * @property {string} assetId - 会话内受控图片资产 ID。
 * @property {string} source - 图片来源类型，如 uploaded、generated 或 edited。
 * @property {string} anchorMessageId - 最近一次把图片纳入会话事实的消息 ID。
 * @property {number} anchorSeq - 锚点消息的单调递增序号。
 * @property {string|null} originRunId - 锚点消息所属 Run。
 */

/**
 * @typedef {object} RoutingContextMessage
 * @property {string} id - 不可变消息 ID。
 * @property {number} seq - 会话内消息序号。
 * @property {'user'|'assistant'} role - 消息角色。
 * @property {string} displayContent - 已移除 URL 的完整有界正文，超限时只返回稳定占位符。
 * @property {boolean} contentTruncated - 原始安全正文是否超过单条消息预算。
 * @property {string} runOperation - 消息所属 Run 的真实 operation。
 * @property {boolean} hasImageArtifact - 消息是否锚定当前时刻可用的图片。
 */

/**
 * @typedef {object} RoutingContextSnapshot
 * @property {'routing-context.v2'} strategyVersion - 快照推导策略版本。
 * @property {string} conversationId - 会话 ID。
 * @property {number} conversationVersion - 分类读取时的会话乐观锁版本。
 * @property {RoutingActiveImage|null} activeImage - 从消息事实推导的当前工作图片。
 * @property {RoutingContextMessage[]} messages - 按 seq 升序排列的有界近期消息。
 * @property {boolean} truncated - 是否省略更早消息或裁剪了消息正文。
 */

export class ConversationStoreError extends Error {
  /**
   * 表示会话存储层可映射为 HTTP 响应的业务错误。
   *
   * @param {string} message - 可读错误信息。
   * @param {number} [status=400] - 建议 HTTP 状态码。
   * @param {string} [code="conversation_store_error"] - 稳定错误代码。
   */
  constructor(message, status = 400, code = "conversation_store_error") {
    super(message);
    this.name = "ConversationStoreError";
    this.status = status;
    this.code = code;
  }
}

/**
 * 创建 SQLite 会话事实源，统一管理会话、消息、Run、结构化记忆和事件日志。
 *
 * @param {object} options - 存储配置。
 * @param {string} options.databasePath - SQLite 文件路径或 `:memory:`。
 * @returns {object} Conversation Store API。
 */
export function createConversationStore({ databasePath, clock = createCurrentDate }) {
  if (databasePath !== ":memory:") mkdirSync(dirname(databasePath), { recursive: true });
  const database = new DatabaseSync(databasePath);
  const readCurrentDate = normalizeClock(clock);
  database.exec("PRAGMA journal_mode = WAL");
  database.exec("PRAGMA busy_timeout = 5000");
  migrate(database);

  return {
    /** 关闭 SQLite 连接，供测试和进程退出时释放资源。 */
    close() {
      database.close();
    },

    /** 创建 active 会话并写入可供多端订阅的创建事件。 */
    createConversation({ title = "新会话", tenantId = "local", userId = "local-user" } = {}) {
      const id = randomUUID();
      const now = new Date().toISOString();
      // 会话与创建事件必须在同一事务提交。
      withTransaction(database, () => {
        database
          .prepare(
            `INSERT INTO conversations (
              id, tenant_id, user_id, title, status, version, memory_version,
              summarized_through_seq, next_seq, created_at, updated_at
            ) VALUES (?, ?, ?, ?, 'active', 1, 0, 0, 0, ?, ?)`,
          )
          .run(id, tenantId, userId, title, now, now);
        insertEvent(database, id, "conversation.created", { conversationId: id, version: 1 });
      });
      return this.getConversation(id);
    },

    /** 按最近更新时间列出会话及其消息和记忆摘要。 */
    listConversations() {
      const rows = database
        .prepare(
          `SELECT c.*,
            (SELECT COUNT(*) FROM messages m WHERE m.conversation_id = c.id) AS message_count,
            (SELECT COUNT(*) FROM memory_items mi WHERE mi.conversation_id = c.id AND mi.status = 'active') AS memory_count
           FROM conversations c
           ORDER BY c.updated_at DESC`,
        )
        .all();
      return rows.map(mapConversationRow);
    },

    /** 返回会话、完整消息、结构化记忆和 Episode。 */
    getConversation(conversationId) {
      const conversation = getConversationOrThrow(database, conversationId);
      const messages = database
        .prepare("SELECT * FROM messages WHERE conversation_id = ? ORDER BY seq ASC")
        .all(conversationId);
      const mappedMessages = [];
      for (const message of messages) mappedMessages.push(mapMessageWithArtifacts(database, message));
      const memoryItems = database
        .prepare("SELECT * FROM memory_items WHERE conversation_id = ? ORDER BY updated_seq ASC, created_at ASC")
        .all(conversationId)
        .map(mapMemoryRow);
      const episodes = database
        .prepare("SELECT * FROM episode_summaries WHERE conversation_id = ? ORDER BY from_seq ASC")
        .all(conversationId)
        .map(mapEpisodeRow);
      const lastRunRow = database
        .prepare("SELECT * FROM runs WHERE conversation_id = ? AND status = 'completed' ORDER BY updated_at DESC, rowid DESC LIMIT 1")
        .get(conversationId);
      const latestRunRow = database
        .prepare("SELECT * FROM runs WHERE conversation_id = ? ORDER BY updated_at DESC, rowid DESC LIMIT 1")
        .get(conversationId);
      const activeImage = deriveActiveImage(database, conversationId, readCurrentDate());

      return {
        ...mapConversationRow(conversation),
        messageCount: mappedMessages.length,
        memoryCount: memoryItems.filter(isActiveMemoryRow).length,
        messages: mappedMessages,
        memory: {
          version: Number(conversation.memory_version),
          summarizedThroughSeq: Number(conversation.summarized_through_seq),
          items: memoryItems,
          episodes,
        },
        workingContext: {
          strategyVersion: ROUTING_CONTEXT_STRATEGY_VERSION,
          conversationVersion: Number(conversation.version),
          activeImage,
        },
        lastRun: lastRunRow ? mapRunWithToolCalls(database, lastRunRow) : null,
        latestRun: latestRunRow ? mapRunWithToolCalls(database, latestRunRow) : null,
      };
    },

    /**
     * 从已提交消息、Run 和可用图片资产推导有界路由快照，不把上传暂存区当作会话上下文。
     *
     * @param {string} conversationId - 路由目标会话。
     * @param {object} [options] - 路由窗口配置。
     * @param {number} [options.maxMessages=12] - 返回的最近消息上限。
     * @returns {RoutingContextSnapshot} 带会话版本、活动图片和近期消息的事实投影。
     */
    getRoutingContextSnapshot(
      conversationId,
      { maxMessages = ROUTING_CONTEXT_DEFAULT_MAX_MESSAGES } = {},
    ) {
      const conversation = getConversationOrThrow(database, conversationId);
      const limit = normalizeRoutingContextMessageLimit(maxMessages);
      const now = readCurrentDate();
      const rows = database
        .prepare(
          `SELECT m.*, r.operation AS run_operation
           FROM messages m
           LEFT JOIN runs r ON r.id = m.run_id
           WHERE m.conversation_id = ?
             AND m.status = 'committed'
           ORDER BY m.seq DESC
           LIMIT ?`,
        )
        .all(conversationId, limit);
      let contentTruncated = false;
      const messages = rows
        .reverse()
        .map(
          /** 将持久化消息收敛为分类器所需的最小有界事实。 */
          (row) => {
            const boundedContent = truncateRoutingMessage(row.display_content);
            if (boundedContent.truncated) contentTruncated = true;
            return {
              id: row.id,
              seq: Number(row.seq),
              role: row.role,
              displayContent: boundedContent.value,
              contentTruncated: boundedContent.truncated,
              runOperation: row.run_operation || "conversation.chat",
              hasImageArtifact: Boolean(findMessageImageAsset(database, row, now)),
            };
          },
        );
      const messageCount = Number(
        database
          .prepare(
            "SELECT COUNT(*) AS count FROM messages WHERE conversation_id = ? AND status = 'committed'",
          )
          .get(conversationId).count,
      );

      return {
        strategyVersion: ROUTING_CONTEXT_STRATEGY_VERSION,
        conversationId,
        conversationVersion: Number(conversation.version),
        activeImage: deriveActiveImage(database, conversationId, now),
        messages,
        truncated: contentTruncated || messageCount > rows.length,
      };
    },

    /** 原子更新会话标题或独立归档状态，不改变 active/closed 生命周期。 */
    updateConversation(conversationId, { title, archived } = {}) {
      // 事务回调把摘要更新与会话事件作为同一事实提交。
      return withTransaction(database, () => {
        const conversation = getConversationOrThrow(database, conversationId);
        const nextTitle = title === undefined ? conversation.title : String(title);
        const now = new Date().toISOString();
        const nextArchivedAt = archived === undefined ? conversation.archived_at : archived ? now : null;
        if (nextTitle === conversation.title && nextArchivedAt === conversation.archived_at) {
          return getConversationSummaryOrThrow(database, conversationId);
        }
        database
          .prepare(
            `UPDATE conversations
             SET title = ?, archived_at = ?, version = version + 1, updated_at = ?
             WHERE id = ?`,
          )
          .run(nextTitle, nextArchivedAt, now, conversationId);
        insertEvent(database, conversationId, "conversation.updated", {
          conversationId,
          titleChanged: nextTitle !== conversation.title,
          archivedChanged: nextArchivedAt !== conversation.archived_at,
        });
        return getConversationSummaryOrThrow(database, conversationId);
      });
    },

    /**
     * 按会话和幂等标识只读查询既有 Run，供 Runtime 在模型目录不可用时重放终止事实。
     *
     * @param {string} conversationId - Run 所属会话。
     * @param {string} requestId - 渠道稳定幂等标识。
     * @returns {object|null} 可重放的完整 Run 结果，缺失时返回 null。
     */
    findRunByRequestId(conversationId, requestId) {
      const row = database
        .prepare("SELECT * FROM runs WHERE conversation_id = ? AND request_id = ?")
        .get(conversationId, requestId);
      return row ? buildRunResult(database, row, true) : null;
    },

    /**
     * 幂等创建 Run 并先持久化用户消息；重复 requestId 返回已有 Run。
     *
     * @param {object} input - Run 和用户消息输入。
     * @returns {object} 新建或重放的 Run 状态。
     */
    startRun({
      conversationId,
      requestId,
      clientMessageId,
      content,
      displayContent,
      references = [],
      model = null,
      sourceRunId = null,
      recoveryMode = null,
      operation = "conversation.chat",
      deadlineAt = null,
      chainTraceId = null,
      intentDecision = null,
      expectedConversationVersion = null,
    }) {
      // Run、用户消息、序号和事件必须在同一事务创建。
      return withTransaction(database, () => {
        const existing = database
          .prepare("SELECT * FROM runs WHERE conversation_id = ? AND request_id = ?")
          .get(conversationId, requestId);
        if (existing) return buildRunResult(database, existing, true);

        const conversation = getConversationOrThrow(database, conversationId);
        if (
          expectedConversationVersion != null
          && Number(conversation.version) !== Number(expectedConversationVersion)
        ) {
          throw new ConversationStoreError(
            "Routing context is stale",
            409,
            "routing_context_stale",
          );
        }
        if (conversation.status !== "active") {
          throw new ConversationStoreError("Conversation is closed", 409, "conversation_closed");
        }
        const activeRun = database
          .prepare("SELECT id FROM runs WHERE conversation_id = ? AND status = 'running' LIMIT 1")
          .get(conversationId);
        if (activeRun) {
          throw new ConversationStoreError(
            "Conversation already has an active Run",
            409,
            "conversation_run_active",
          );
        }
        const duplicateMessage = database
          .prepare("SELECT id FROM messages WHERE conversation_id = ? AND client_message_id = ?")
          .get(conversationId, clientMessageId);
        if (duplicateMessage) {
          throw new ConversationStoreError("clientMessageId has already been used", 409, "duplicate_client_message");
        }
        validateRecoverySource(database, conversationId, sourceRunId, recoveryMode, operation);
        validateImageRunReferences(database, conversationId, operation, references);

        const runId = randomUUID();
        const messageId = randomUUID();
        const seq = Number(conversation.next_seq) + 1;
        const now = new Date().toISOString();
        const title = conversation.next_seq === 0 ? buildConversationTitle(displayContent) : conversation.title;
        const sanitizedIntentDecision = sanitizeIntentDecision(
          database,
          conversationId,
          intentDecision,
        );
        database
          .prepare(
            `INSERT INTO runs (
              id, conversation_id, request_id, source_run_id, recovery_mode,
              operation, status, model, deadline_at, chain_trace_id, intent_decision_json,
              created_at, updated_at
             ) VALUES (?, ?, ?, ?, ?, ?, 'running', ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            runId,
            conversationId,
            requestId,
            sourceRunId,
            recoveryMode,
            operation,
            model,
            normalizeIsoTimestamp(deadlineAt),
            nullableString(chainTraceId),
            jsonOrNull(sanitizedIntentDecision),
            now,
            now,
          );
        database
          .prepare(
            `INSERT INTO messages (
              id, conversation_id, seq, client_message_id, run_id, role,
              content_json, display_content, status, references_json, created_at
            ) VALUES (?, ?, ?, ?, ?, 'user', ?, ?, 'committed', ?, ?)`,
          )
          .run(
            messageId,
            conversationId,
            seq,
            clientMessageId,
            runId,
            JSON.stringify(content),
            displayContent,
            JSON.stringify(references),
            now,
          );
        database
          .prepare("UPDATE runs SET user_message_id = ? WHERE id = ?")
          .run(messageId, runId);
        database
          .prepare(
            `UPDATE conversations
             SET title = ?, next_seq = ?, version = version + 1, updated_at = ?
             WHERE id = ?`,
          )
          .run(title, seq, now, conversationId);
        if (sanitizedIntentDecision) {
          insertEvent(database, conversationId, "run.intent_resolved", {
            runId,
            ...sanitizedIntentDecision,
          });
        }
        insertEvent(database, conversationId, "message.created", { messageId, seq, role: "user" });
        return buildRunResult(database, database.prepare("SELECT * FROM runs WHERE id = ?").get(runId), false);
      });
    },

    /** 幂等登记一次模型生成的工具调用，并在同一事务创建关联 Operation。 */
    startToolCall({
      conversationId,
      runId,
      toolCallId,
      toolName,
      input,
      operationKey = `tool:${toolCallId}`,
      idempotencyKey = `${runId}:tool:${toolCallId}`,
      effect = "read",
      riskLevel = "low",
      policyDecision,
      lease = null,
    }) {
      // 事务回调原子校验 Run、去重工具调用并写入开始事件。
      return withTransaction(database, () => {
        const run = getRunOrThrow(database, runId);
        if (run.conversation_id !== conversationId || run.status !== "running") {
          throw new ConversationStoreError("Run is not active", 409, "run_not_active");
        }
        assertRunLease(database, runId, lease, readCurrentDate());
        const existing = database
          .prepare("SELECT * FROM tool_calls WHERE run_id = ? AND tool_call_id = ?")
          .get(runId, toolCallId);
        if (existing) {
          assertToolCallReplay(database, existing, {
            conversationId,
            runId,
            toolCallId,
            toolName,
            input,
            operationKey,
            idempotencyKey,
            effect,
            riskLevel,
            policyDecision,
          });
          return {
            ...mapToolCallRow(existing),
            operation: existing.operation_id ? mapOperationRow(getOperationOrThrow(database, existing.operation_id)) : null,
            replayed: true,
          };
        }
        const id = randomUUID();
        const now = readCurrentDate().toISOString();
        const operationResult = insertOperation(database, {
          conversationId,
          runId,
          operationKey,
          idempotencyKey,
          kind: "tool",
          toolName,
          effect,
          riskLevel,
          policyDecision,
          status: "running",
          input,
          attempt: 1,
          now,
        });
        if (operationResult.replayed) {
          throw new ConversationStoreError(
            "Operation exists without its ToolCall projection",
            409,
            "operation_projection_conflict",
          );
        }
        database
          .prepare(
            `INSERT INTO tool_calls (
              id, conversation_id, run_id, operation_id, tool_call_id, tool_name, status,
              input_json, started_at, updated_at
             ) VALUES (?, ?, ?, ?, ?, ?, 'running', ?, ?, ?)`,
          )
          .run(
            id,
            conversationId,
            runId,
            operationResult.operation.id,
            toolCallId,
            toolName,
            JSON.stringify(input),
            now,
            now,
          );
        insertEvent(database, conversationId, "operation.started", {
          runId,
          operationId: operationResult.operation.id,
          operationKey,
          kind: "tool",
          effect,
        });
        insertEvent(database, conversationId, "tool.started", {
          runId,
          operationId: operationResult.operation.id,
          toolCallId,
          toolName,
        });
        return {
          ...mapToolCallRow(database.prepare("SELECT * FROM tool_calls WHERE id = ?").get(id)),
          operation: operationResult.operation,
          replayed: false,
        };
      });
    },

    /** 将结构化 ToolResult、来源和数据时间原子保存为 completed 工具事实。 */
    completeToolCall({
      runId,
      toolCallId,
      output,
      source = null,
      observedAt = null,
      externalRequestId = null,
      readback = null,
      lease = null,
    }) {
      // 事务回调把工具结果与完成事件绑定为单一持久化事实。
      return withTransaction(database, () => {
        const row = getToolCallOrThrow(database, runId, toolCallId);
        assertRunLease(database, runId, lease, readCurrentDate());
        if (row.status === "completed") {
          return {
            ...mapToolCallRow(row),
            operation: row.operation_id ? mapOperationRow(getOperationOrThrow(database, row.operation_id)) : null,
          };
        }
        if (row.status !== "running") {
          throw new ConversationStoreError("Tool call is not active", 409, "tool_call_not_active");
        }
        const now = readCurrentDate().toISOString();
        const operation = row.operation_id
          ? completeOperationRow(database, getOperationOrThrow(database, row.operation_id), {
              result: output,
              readback,
              externalRequestId,
              now,
            })
          : null;
        database
          .prepare(
            `UPDATE tool_calls
             SET status = 'completed', output_json = ?, source_name = ?, observed_at = ?,
                 error_code = NULL, error_message = NULL, retryable = 0, updated_at = ?
             WHERE id = ?`,
          )
          .run(JSON.stringify(output), source, observedAt, now, row.id);
        insertEvent(database, row.conversation_id, "tool.completed", {
          runId,
          operationId: row.operation_id || null,
          toolCallId,
          toolName: row.tool_name,
          source,
          observedAt,
        });
        return {
          ...mapToolCallRow(database.prepare("SELECT * FROM tool_calls WHERE id = ?").get(row.id)),
          operation,
        };
      });
    },

    /** 以安全错误码和公开说明收口工具失败，不保存外部原始响应。 */
    failToolCall({
      runId,
      toolCallId,
      code,
      message,
      retryable = false,
      externalRequestId = null,
      lease = null,
    }) {
      // 事务回调把公开失败字段与工具失败事件原子提交。
      return withTransaction(database, () => {
        const row = getToolCallOrThrow(database, runId, toolCallId);
        assertRunLease(database, runId, lease, readCurrentDate());
        if (row.status !== "running") {
          return {
            ...mapToolCallRow(row),
            operation: row.operation_id ? mapOperationRow(getOperationOrThrow(database, row.operation_id)) : null,
          };
        }
        const now = readCurrentDate().toISOString();
        const operationStatus = code === "tool_cancelled" ? "cancelled" : "failed";
        const operation = row.operation_id
          ? failOperationRow(database, getOperationOrThrow(database, row.operation_id), {
              status: operationStatus,
              code,
              message,
              retryable,
              externalRequestId,
              now,
            })
          : null;
        database
          .prepare(
            `UPDATE tool_calls
             SET status = 'failed', error_code = ?, error_message = ?, retryable = ?, updated_at = ?
             WHERE id = ?`,
          )
          .run(String(code || "tool_execution_failed"), String(message || "工具执行失败。"), retryable ? 1 : 0, now, row.id);
        insertEvent(database, row.conversation_id, "tool.failed", {
          runId,
          operationId: row.operation_id || null,
          toolCallId,
          toolName: row.tool_name,
          code: String(code || "tool_execution_failed"),
          retryable: Boolean(retryable),
        });
        return {
          ...mapToolCallRow(database.prepare("SELECT * FROM tool_calls WHERE id = ?").get(row.id)),
          operation,
        };
      });
    },

    /** 按开始顺序返回一个 Run 的全部工具事实，供重放、API 和验收使用。 */
    listToolCalls(runId) {
      return listToolCallsForRun(database, runId);
    },

    /** 按创建顺序返回一个 Run 的 Operation 执行事实。 */
    listOperations(runId) {
      getRunOrThrow(database, runId);
      return listOperationsForRun(database, runId);
    },

    /** 返回单个 Operation；不存在时抛出稳定 404。 */
    getOperation(operationId) {
      return mapOperationRow(getOperationOrThrow(database, operationId));
    },

    /** 按策略决定幂等规划一个通用 Operation，不执行任何外部动作。 */
    planOperation(input) {
      return withTransaction(database, () => {
        const run = getRunOrThrow(database, input.runId);
        if (run.conversation_id !== input.conversationId || run.status !== "running") {
          throw new ConversationStoreError("Run is not active", 409, "run_not_active");
        }
        assertRunLease(database, run.id, input.lease, readCurrentDate());
        const policyDecision = normalizePolicyDecision(input.policyDecision);
        if (!["allow", "confirmation_required"].includes(policyDecision.decision)) {
          throw new ConversationStoreError(
            "Policy decision cannot create an executable Operation",
            409,
            "operation_policy_not_executable",
          );
        }
        const now = readCurrentDate().toISOString();
        const result = insertOperation(database, {
          ...input,
          policyDecision,
          status: policyDecision.decision === "allow" ? "planned" : "confirmation_required",
          attempt: 0,
          now,
        });
        if (!result.replayed) {
          insertEvent(database, input.conversationId, `operation.${result.operation.status}`, {
            runId: input.runId,
            operationId: result.operation.id,
            operationKey: result.operation.operationKey,
            kind: result.operation.kind,
            effect: result.operation.effect,
          });
        }
        return result;
      });
    },

    /** 将 planned Operation 进入 running 并增加一次执行尝试。 */
    startOperation({ operationId, externalRequestId = null, lease = null }) {
      return withTransaction(database, () => {
        const row = getOperationOrThrow(database, operationId);
        assertRunLease(database, row.run_id, lease, readCurrentDate());
        if (row.status === "running") return { operation: mapOperationRow(row), replayed: true };
        if (row.status !== "planned") {
          throw new ConversationStoreError("Operation cannot be started", 409, "operation_not_startable");
        }
        const now = readCurrentDate().toISOString();
        database
          .prepare(
            `UPDATE operations
             SET status = 'running', attempt = attempt + 1, external_request_id = COALESCE(?, external_request_id),
                 started_at = COALESCE(started_at, ?), updated_at = ?
             WHERE id = ?`,
          )
          .run(nullableString(externalRequestId), now, now, operationId);
        insertEvent(database, row.conversation_id, "operation.started", {
          runId: row.run_id,
          operationId,
          operationKey: row.operation_key,
          kind: row.kind,
          effect: row.effect,
        });
        return {
          operation: mapOperationRow(database.prepare("SELECT * FROM operations WHERE id = ?").get(operationId)),
          replayed: false,
        };
      });
    },

    /** 以结果和可选业务回读完成 Operation；unknown 只能凭 readback 收敛。 */
    completeOperation({ operationId, result, readback = null, externalRequestId = null, lease = null }) {
      return withTransaction(database, () => {
        const row = getOperationOrThrow(database, operationId);
        assertRunLease(database, row.run_id, lease, readCurrentDate());
        if (row.status === "completed") return { operation: mapOperationRow(row), replayed: true };
        const operation = completeOperationRow(database, row, {
          result,
          readback,
          externalRequestId,
          now: readCurrentDate().toISOString(),
        });
        return { operation, replayed: false };
      });
    },

    /** 以安全错误事实收口 Operation；unknown 只能凭 readback 证明失败。 */
    failOperation({
      operationId,
      code,
      message,
      retryable = false,
      readback = null,
      externalRequestId = null,
      lease = null,
    }) {
      return withTransaction(database, () => {
        const row = getOperationOrThrow(database, operationId);
        assertRunLease(database, row.run_id, lease, readCurrentDate());
        if (row.status === "failed") return { operation: mapOperationRow(row), replayed: true };
        const operation = failOperationRow(database, row, {
          status: "failed",
          code,
          message,
          retryable,
          readback,
          externalRequestId,
          now: readCurrentDate().toISOString(),
        });
        return { operation, replayed: false };
      });
    },

    /** 将无法证明外部结果的 running Operation 标记为 unknown，后续不得自动重放。 */
    markOperationUnknown({ operationId, code = "operation_result_unknown", externalRequestId = null, lease = null }) {
      return withTransaction(database, () => {
        const row = getOperationOrThrow(database, operationId);
        assertRunLease(database, row.run_id, lease, readCurrentDate());
        if (row.status === "unknown") return { operation: mapOperationRow(row), replayed: true };
        if (row.status !== "running") {
          throw new ConversationStoreError("Operation result cannot become unknown", 409, "operation_not_active");
        }
        const now = readCurrentDate().toISOString();
        database
          .prepare(
            `UPDATE operations
             SET status = 'unknown', external_request_id = COALESCE(?, external_request_id),
                 error_code = ?, error_message = '外部操作结果未知。', retryable = 0,
                 completed_at = ?, updated_at = ?
             WHERE id = ?`,
          )
          .run(nullableString(externalRequestId), String(code || "operation_result_unknown"), now, now, operationId);
        insertEvent(database, row.conversation_id, "operation.unknown", {
          runId: row.run_id,
          operationId,
          code: String(code || "operation_result_unknown"),
        });
        return {
          operation: mapOperationRow(database.prepare("SELECT * FROM operations WHERE id = ?").get(operationId)),
          replayed: false,
        };
      });
    },

    /** 只取消尚未执行或等待确认的 Operation，运行中副作用不得伪装为未发生。 */
    cancelOperation({ operationId, code = "operation_cancelled", lease = null }) {
      return withTransaction(database, () => {
        const row = getOperationOrThrow(database, operationId);
        assertRunLease(database, row.run_id, lease, readCurrentDate());
        if (row.status === "cancelled") return { operation: mapOperationRow(row), replayed: true };
        if (!["planned", "confirmation_required"].includes(row.status)) {
          throw new ConversationStoreError("Operation cannot be cancelled safely", 409, "operation_not_cancellable");
        }
        const operation = failOperationRow(database, row, {
          status: "cancelled",
          code,
          message: "操作已取消。",
          retryable: false,
          now: readCurrentDate().toISOString(),
        });
        return { operation, replayed: false };
      });
    },

    /** 原子取得 RunLease；未过期竞争返回 lease_held，过期接管递增 fencing token。 */
    acquireRunLease({ runId, conversationId, ownerId, ttlMs }) {
      return withTransaction(database, () => {
        const run = getRunOrThrow(database, runId);
        if (run.conversation_id !== conversationId || run.status !== "running") {
          throw new ConversationStoreError("Run is not active", 409, "run_not_active");
        }
        const normalizedOwnerId = requireStableIdentifier(ownerId, "ownerId");
        const normalizedTtlMs = normalizeLeaseTtl(ttlMs);
        const nowDate = readCurrentDate();
        const now = nowDate.toISOString();
        const existing = database.prepare("SELECT * FROM run_leases WHERE run_id = ?").get(runId);
        if (existing && isLeaseActive(existing, nowDate) && existing.owner_id !== normalizedOwnerId) {
          return { acquired: false, reasonCode: "lease_held", lease: mapRunLeaseRow(existing) };
        }

        if (existing && isLeaseActive(existing, nowDate) && existing.owner_id === normalizedOwnerId) {
          const leaseExpiresAt = new Date(nowDate.getTime() + normalizedTtlMs).toISOString();
          database
            .prepare("UPDATE run_leases SET lease_expires_at = ?, updated_at = ? WHERE run_id = ?")
            .run(leaseExpiresAt, now, runId);
          return {
            acquired: true,
            replayed: true,
            lease: mapRunLeaseRow(database.prepare("SELECT * FROM run_leases WHERE run_id = ?").get(runId)),
          };
        }

        const fencingToken = existing ? Number(existing.fencing_token) + 1 : 1;
        const acquiredAt = now;
        const leaseExpiresAt = new Date(nowDate.getTime() + normalizedTtlMs).toISOString();
        database
          .prepare(
            `INSERT INTO run_leases (
              run_id, conversation_id, owner_id, fencing_token, lease_expires_at,
              acquired_at, released_at, updated_at
             ) VALUES (?, ?, ?, ?, ?, ?, NULL, ?)
             ON CONFLICT(run_id) DO UPDATE SET
               owner_id = excluded.owner_id,
               fencing_token = excluded.fencing_token,
               lease_expires_at = excluded.lease_expires_at,
               acquired_at = excluded.acquired_at,
               released_at = NULL,
               updated_at = excluded.updated_at`,
          )
          .run(runId, conversationId, normalizedOwnerId, fencingToken, leaseExpiresAt, acquiredAt, now);
        insertEvent(database, conversationId, existing ? "run.lease_taken_over" : "run.lease_acquired", {
          runId,
          ownerId: normalizedOwnerId,
          fencingToken,
          leaseExpiresAt,
        });
        return {
          acquired: true,
          replayed: false,
          lease: mapRunLeaseRow(database.prepare("SELECT * FROM run_leases WHERE run_id = ?").get(runId)),
        };
      });
    },

    /** 使用匹配 owner/token 续租；旧 token、已释放或过期租约均被拒绝。 */
    renewRunLease({ runId, ownerId, fencingToken, ttlMs }) {
      return withTransaction(database, () => {
        const nowDate = readCurrentDate();
        const row = assertRunLease(
          database,
          runId,
          { ownerId, fencingToken },
          nowDate,
          { requireActive: true },
        );
        const leaseExpiresAt = new Date(nowDate.getTime() + normalizeLeaseTtl(ttlMs)).toISOString();
        database
          .prepare("UPDATE run_leases SET lease_expires_at = ?, updated_at = ? WHERE run_id = ?")
          .run(leaseExpiresAt, nowDate.toISOString(), runId);
        insertEvent(database, row.conversation_id, "run.lease_renewed", {
          runId,
          ownerId: row.owner_id,
          fencingToken: Number(row.fencing_token),
          leaseExpiresAt,
        });
        return mapRunLeaseRow(database.prepare("SELECT * FROM run_leases WHERE run_id = ?").get(runId));
      });
    },

    /** 释放当前 owner/token 但保留 fencing token 历史，防止 ABA 和旧 owner 回写。 */
    releaseRunLease({ runId, ownerId, fencingToken }) {
      return withTransaction(database, () => {
        const nowDate = readCurrentDate();
        const row = assertRunLease(
          database,
          runId,
          { ownerId, fencingToken },
          nowDate,
          { requireActive: false },
        );
        if (row.released_at) return { released: true, lease: mapRunLeaseRow(row) };
        const now = nowDate.toISOString();
        database
          .prepare("UPDATE run_leases SET released_at = ?, lease_expires_at = ?, updated_at = ? WHERE run_id = ?")
          .run(now, now, now, runId);
        insertEvent(database, row.conversation_id, "run.lease_released", {
          runId,
          ownerId: row.owner_id,
          fencingToken: Number(row.fencing_token),
        });
        return {
          released: true,
          lease: mapRunLeaseRow(database.prepare("SELECT * FROM run_leases WHERE run_id = ?").get(runId)),
        };
      });
    },

    /** 返回 Run 当前保存的 lease 事实；从未取得时返回 null。 */
    getRunLease(runId) {
      getRunOrThrow(database, runId);
      const row = database.prepare("SELECT * FROM run_leases WHERE run_id = ?").get(runId);
      return row ? mapRunLeaseRow(row) : null;
    },

    /** 返回全部遗留 running Run 及其消息、工具和验收事实，供启动恢复分类。 */
    listRunningRuns() {
      return database
        .prepare("SELECT * FROM runs WHERE status = 'running' ORDER BY created_at ASC, rowid ASC")
        .all()
        .map(
          /** 将每个遗留 Run 组合成恢复器可直接判定的完整事实。 */
          (run) => buildRunResult(database, run, false),
        );
    },

    /** 在同一事务中写入助手消息、usage、Context Manifest、韧性证据并完成 Run。 */
    completeRun({ runId, content, displayContent, usage, contextManifest, model, resilience, acceptance = null, lease = null }) {
      // 助手消息和完成状态必须在同一事务提交。
      return withTransaction(database, () => {
        const run = getRunOrThrow(database, runId);
        if (run.status === "completed") {
          assertTerminalReplayLease(database, runId, lease, readCurrentDate());
          return buildRunResult(database, run, true);
        }
        if (run.status !== "running") {
          throw new ConversationStoreError("Run is not active", 409, "run_not_active");
        }
        assertRunLease(database, runId, lease, readCurrentDate());
        const conversation = getConversationOrThrow(database, run.conversation_id);
        if (acceptance) persistAcceptanceResult(database, run, acceptance, "accepted");
        const messageId = randomUUID();
        const seq = Number(conversation.next_seq) + 1;
        const now = readCurrentDate().toISOString();
        database
          .prepare(
            `INSERT INTO messages (
              id, conversation_id, seq, run_id, role, content_json,
              display_content, status, usage_json, created_at
            ) VALUES (?, ?, ?, ?, 'assistant', ?, ?, 'committed', ?, ?)`,
          )
          .run(messageId, run.conversation_id, seq, runId, JSON.stringify(content), displayContent, jsonOrNull(usage), now);
        database
          .prepare(
            `UPDATE runs
             SET assistant_message_id = ?, status = 'completed', model = ?, usage_json = ?,
                 context_manifest_json = ?, resilience_json = ?, updated_at = ?
             WHERE id = ?`,
          )
          .run(
            messageId,
            model,
            jsonOrNull(usage),
            JSON.stringify(contextManifest),
            jsonOrNull(resilience),
            now,
            runId,
          );
        database
          .prepare("UPDATE conversations SET next_seq = ?, version = version + 1, updated_at = ? WHERE id = ?")
          .run(seq, now, run.conversation_id);
        releaseRunLeaseAfterTerminal(database, run, lease, now);
        insertEvent(database, run.conversation_id, "run.completed", { runId, messageId, seq, role: "assistant" });
        return buildRunResult(database, database.prepare("SELECT * FROM runs WHERE id = ?").get(runId), false);
      });
    },

    /**
     * 在同一事务中登记已写入二进制存储的图片元数据、消息引用并完成图片 Run。
     *
     * @param {object} input - 图片 Run 完成事实。
     * @returns {object} 已完成 Run、消息和图片产物。
     */
    completeImageRun({ runId, assets, displayContent, usage, model, resilience, lease = null }) {
      if (!Array.isArray(assets) || assets.length === 0) {
        throw new ConversationStoreError("Image Run requires at least one asset", 400, "image_asset_required");
      }
      /** 原子登记图片资产、助手消息和完成状态，任一步失败都不留下部分元数据。 */
      function commitImageRun() {
        const run = getRunOrThrow(database, runId);
        if (run.status === "completed") {
          assertTerminalReplayLease(database, runId, lease, readCurrentDate());
          return buildRunResult(database, run, true);
        }
        if (run.status !== "running" || !["image.generate", "image.edit"].includes(run.operation)) {
          throw new ConversationStoreError("Run is not an active image operation", 409, "run_not_active");
        }
        assertRunLease(database, runId, lease, readCurrentDate());
        const conversation = getConversationOrThrow(database, run.conversation_id);
        const messageId = randomUUID();
        const seq = Number(conversation.next_seq) + 1;
        const now = readCurrentDate().toISOString();
        const content = String(displayContent || `已生成 ${assets.length} 张图片`);
        database
          .prepare(
            `INSERT INTO messages (
              id, conversation_id, seq, run_id, role, content_json,
              display_content, status, usage_json, created_at
            ) VALUES (?, ?, ?, ?, 'assistant', ?, ?, 'committed', ?, ?)`,
          )
          .run(messageId, run.conversation_id, seq, runId, JSON.stringify(content), content, jsonOrNull(usage), now);

        let position = 0;
        for (const asset of assets) {
          database
            .prepare(
              `INSERT INTO image_assets (
                id, conversation_id, run_id, version, media_type, size_bytes, width, height,
                sha256, source, status, storage_key, created_at, expires_at
              ) VALUES (?, ?, ?, 1, ?, ?, ?, ?, ?, ?, 'available', ?, ?, NULL)`,
            )
            .run(
              asset.assetId,
              run.conversation_id,
              runId,
              asset.mediaType,
              asset.sizeBytes,
              asset.width,
              asset.height,
              asset.sha256,
              run.operation === "image.edit" ? "edited" : "generated",
              asset.storageKey,
              now,
            );
          database
            .prepare("INSERT INTO message_artifacts (message_id, asset_id, position) VALUES (?, ?, ?)")
            .run(messageId, asset.assetId, position);
          position += 1;
          insertEvent(database, run.conversation_id, "artifact.created", {
            runId,
            messageId,
            assetId: asset.assetId,
            mediaType: asset.mediaType,
          });
        }

        database
          .prepare(
            `UPDATE runs
             SET assistant_message_id = ?, status = 'completed', model = ?, usage_json = ?,
                 context_manifest_json = NULL, resilience_json = ?, updated_at = ?
             WHERE id = ?`,
          )
          .run(messageId, model, jsonOrNull(usage), jsonOrNull(resilience), now, runId);
        database
          .prepare("UPDATE conversations SET next_seq = ?, version = version + 1, updated_at = ? WHERE id = ?")
          .run(seq, now, run.conversation_id);
        releaseRunLeaseAfterTerminal(database, run, lease, now);
        insertEvent(database, run.conversation_id, "run.completed", { runId, messageId, seq, role: "assistant" });
        return buildRunResult(database, database.prepare("SELECT * FROM runs WHERE id = ?").get(runId), false);
      }
      return withTransaction(database, commitImageRun);
    },

    /**
     * 登记一张已写入 ImageAssetStore 的会话上传资产，不把物理 storageKey 暴露给渠道。
     *
     * @param {object} input - 会话 ID 与已校验图片资产元数据。
     * @returns {object} 可公开的稳定 image_asset 引用。
     */
    createImageAsset({ conversationId, asset }) {
      /** 原子登记上传资产元数据及对应会话事件。 */
      function registerUploadedAsset() {
        const conversation = getConversationOrThrow(database, conversationId);
        if (conversation.status !== "active") {
          throw new ConversationStoreError("Conversation is closed", 409, "conversation_closed");
        }
        const now = new Date().toISOString();
        database
          .prepare(
            `INSERT INTO image_assets (
              id, conversation_id, run_id, version, media_type, size_bytes, width, height,
              sha256, source, status, storage_key, created_at, expires_at
            ) VALUES (?, ?, NULL, 1, ?, ?, ?, ?, ?, 'uploaded', 'available', ?, ?, NULL)`,
          )
          .run(
            asset.assetId,
            conversationId,
            asset.mediaType,
            asset.sizeBytes,
            asset.width,
            asset.height,
            asset.sha256,
            asset.storageKey,
            now,
          );
        insertEvent(database, conversationId, "artifact.uploaded", {
          assetId: asset.assetId,
          mediaType: asset.mediaType,
        });
        return mapImageAssetRow(database.prepare("SELECT * FROM image_assets WHERE id = ?").get(asset.assetId));
      }
      return withTransaction(database, registerUploadedAsset);
    },

    /** 读取当前会话拥有的可用图片资产及内部 storageKey，越权与缺失统一返回 404。 */
    readImageAsset(conversationId, assetId) {
      getConversationOrThrow(database, conversationId);
      const row = getAvailableImageAssetOrThrow(database, conversationId, assetId);
      return { asset: mapImageAssetRow(row), storageKey: row.storage_key };
    },

    /** 将模型调用失败记录到 Run，同时保留已经落库的用户消息。 */
    failRun(runId, error, lease = null) {
      // 失败状态和事件必须在同一事务提交。
      return withTransaction(database, () => {
        const run = getRunOrThrow(database, runId);
        if (run.status !== "running") {
          assertTerminalReplayLease(database, runId, lease, readCurrentDate());
          return buildRunResult(database, run, false);
        }
        assertRunLease(database, runId, lease, readCurrentDate());
        const now = readCurrentDate().toISOString();
        database
          .prepare("UPDATE runs SET status = 'failed', error = ?, error_code = ?, resilience_json = ?, updated_at = ? WHERE id = ?")
          .run(
            String(error?.message || error || "Run failed"),
            readErrorCode(error),
            jsonOrNull(error?.resilience),
            now,
            runId,
          );
        releaseRunLeaseAfterTerminal(database, run, lease, now);
        insertEvent(database, run.conversation_id, "run.failed", { runId, code: readErrorCode(error) });
        return buildRunResult(database, database.prepare("SELECT * FROM runs WHERE id = ?").get(runId), false);
      });
    },

    /** 将 rejected AcceptanceResult 与 Run 失败状态原子提交，不保存模型候选正文。 */
    rejectRun({ runId, acceptance, error, resilience = null, lease = null }) {
      return withTransaction(database, () => {
        const run = getRunOrThrow(database, runId);
        if (run.status !== "running") {
          assertTerminalReplayLease(database, runId, lease, readCurrentDate());
          return buildRunResult(database, run, false);
        }
        assertRunLease(database, runId, lease, readCurrentDate());
        persistAcceptanceResult(database, run, acceptance, "rejected");
        const now = readCurrentDate().toISOString();
        database
          .prepare(
            `UPDATE runs
             SET status = 'failed', error = ?, error_code = ?, resilience_json = ?, updated_at = ?
             WHERE id = ?`,
          )
          .run(
            String(error?.message || error || "Run result was rejected"),
            readErrorCode(error) || "result_acceptance_rejected",
            jsonOrNull(resilience || error?.resilience),
            now,
            runId,
          );
        releaseRunLeaseAfterTerminal(database, run, lease, now);
        insertEvent(database, run.conversation_id, "acceptance.rejected", {
          runId,
          policy: acceptance.policy,
          policyVersion: acceptance.policyVersion,
          reasonCodes: acceptance.reasonCodes,
        });
        insertEvent(database, run.conversation_id, "run.failed", {
          runId,
          code: readErrorCode(error) || "result_acceptance_rejected",
        });
        return buildRunResult(database, database.prepare("SELECT * FROM runs WHERE id = ?").get(runId), false);
      });
    },

    /**
     * 原子取消指定会话中的运行中 Run，并按需持久化一条中断助手消息。
     *
     * @param {object} input - 取消目标和已交付的部分结果。
     * @returns {object} 当前终止状态；重复取消或完成竞态不会改写既有事实。
     */
    cancelRun({ conversationId, runId, partialContent = "", contextManifest, model, resilience, lease = null }) {
      // 事务回调把取消状态、可选助手消息与事件作为一个终止事实提交。
      return withTransaction(database, () => {
        const run = getRunOrThrow(database, runId);
        if (run.conversation_id !== conversationId) {
          throw new ConversationStoreError("Run not found", 404, "run_not_found");
        }
        if (run.status !== "running") {
          assertTerminalReplayLease(database, runId, lease, readCurrentDate());
          return buildRunResult(database, run, true);
        }
        assertRunLease(database, runId, lease, readCurrentDate());

        const text = String(partialContent || "");
        const conversation = getConversationOrThrow(database, conversationId);
        const now = readCurrentDate().toISOString();
        let messageId = null;
        let seq = null;
        if (text.length > 0) {
          messageId = randomUUID();
          seq = Number(conversation.next_seq) + 1;
          database
            .prepare(
              `INSERT INTO messages (
                id, conversation_id, seq, run_id, role, content_json,
                display_content, status, usage_json, created_at
              ) VALUES (?, ?, ?, ?, 'assistant', ?, ?, 'interrupted', NULL, ?)`,
            )
            .run(messageId, conversationId, seq, runId, JSON.stringify(text), text, now);
          database
            .prepare("UPDATE conversations SET next_seq = ?, version = version + 1, updated_at = ? WHERE id = ?")
            .run(seq, now, conversationId);
          insertEvent(database, conversationId, "message.created", {
            messageId,
            runId,
            seq,
            role: "assistant",
            status: "interrupted",
          });
        }

        database
          .prepare(
            `UPDATE runs
             SET assistant_message_id = ?, status = 'cancelled', model = ?,
                 context_manifest_json = ?, resilience_json = ?, error = NULL, updated_at = ?
             WHERE id = ?`,
          )
          .run(
            messageId,
            model || null,
            jsonOrNull(contextManifest),
            jsonOrNull(resilience),
            now,
            runId,
          );
        releaseRunLeaseAfterTerminal(database, run, lease, now);
        insertEvent(database, conversationId, "run.cancelled", {
          runId,
          messageId,
          ...(seq == null ? {} : { seq }),
        });
        return buildRunResult(database, database.prepare("SELECT * FROM runs WHERE id = ?").get(runId), false);
      });
    },

    /**
     * 从当前会话事实源解析直接消息引用，不接受渠道提交的引用正文。
     *
     * @param {string} conversationId - 当前会话 ID。
     * @param {Array<{type: string, messageId: string}>} references - 已通过类型校验的引用。
     * @returns {Array<object>} 与引用顺序一致的消息事实。
     */
    resolveMessageReferences(conversationId, references) {
      getConversationOrThrow(database, conversationId);
      const messages = [];
      for (const reference of references) {
        const row = database
          .prepare(
            `SELECT * FROM messages
             WHERE id = ? AND conversation_id = ? AND status IN ('committed', 'interrupted')`,
          )
          .get(reference.messageId, conversationId);
        if (!row) {
          throw new ConversationStoreError(
            "Referenced message is not available in this conversation",
            400,
            "invalid_message_reference",
          );
        }
        messages.push(mapMessageRow(row));
      }
      return messages;
    },

    /** 提供 Context Planner 所需的会话、消息、active 记忆和 Episode 快照。 */
    getContextSnapshot(conversationId) {
      const conversation = getConversationOrThrow(database, conversationId);
      return {
        conversation: mapConversationRow(conversation),
        messages: database
          .prepare("SELECT * FROM messages WHERE conversation_id = ? ORDER BY seq ASC")
          .all(conversationId)
          .map(mapMessageRow),
        memoryItems: database
          .prepare("SELECT * FROM memory_items WHERE conversation_id = ? AND status = 'active' ORDER BY updated_seq ASC")
          .all(conversationId)
          .map(mapMemoryRow),
        episodes: database
          .prepare("SELECT * FROM episode_summaries WHERE conversation_id = ? ORDER BY to_seq DESC")
          .all(conversationId)
          .map(mapEpisodeRow),
      };
    },

    /** 返回从当前压缩水位开始的连续原始消息和记忆版本快照。 */
    getCompactionSnapshot(conversationId) {
      const conversation = getConversationOrThrow(database, conversationId);
      const messages = database
        .prepare(
          "SELECT * FROM messages WHERE conversation_id = ? AND seq > ? AND status = 'committed' ORDER BY seq ASC",
        )
        .all(conversationId, conversation.summarized_through_seq)
        .map(mapMessageRow);
      const memoryItems = database
        .prepare("SELECT * FROM memory_items WHERE conversation_id = ? AND status = 'active' ORDER BY updated_seq ASC")
        .all(conversationId)
        .map(mapMemoryRow);
      return { conversation: mapConversationRow(conversation), messages, memoryItems };
    },

    /**
     * 通过 memoryVersion 和水位双条件 compare-and-set 原子提交 MemoryDelta。
     *
     * @returns {{applied: boolean, conversation?: object}} 冲突时 applied 为 false。
     */
    applyMemoryDelta({ conversationId, expectedVersion, expectedThroughSeq, nextThroughSeq, delta, usage, model, promptVersion }) {
      // CAS、水位、MemoryDelta、版本记录和事件共享同一事务。
      return withTransaction(database, () => {
        const now = new Date().toISOString();
        const update = database
          .prepare(
            `UPDATE conversations
             SET memory_version = memory_version + 1,
                 summarized_through_seq = ?, version = version + 1, updated_at = ?
             WHERE id = ? AND memory_version = ? AND summarized_through_seq = ?`,
          )
          .run(nextThroughSeq, now, conversationId, expectedVersion, expectedThroughSeq);
        if (Number(update.changes) !== 1) return { applied: false };

        for (const item of delta.supersedes) {
          database
            .prepare(
              `UPDATE memory_items SET status = 'superseded', superseded_at_seq = ?
               WHERE conversation_id = ? AND item_type = ? AND entity = ? AND memory_key = ? AND status = 'active'`,
            )
            .run(nextThroughSeq, conversationId, item.type, item.entity, item.key);
        }
        for (const item of delta.upserts) {
          database
            .prepare(
              `UPDATE memory_items SET status = 'superseded', superseded_at_seq = ?
               WHERE conversation_id = ? AND item_type = ? AND entity = ? AND memory_key = ? AND status = 'active'`,
            )
            .run(nextThroughSeq, conversationId, item.type, item.entity, item.key);
          database
            .prepare(
              `INSERT INTO memory_items (
                id, conversation_id, item_type, entity, memory_key, value_json, reason,
                item_status, status, priority, source_message_ids_json, updated_seq, created_at
              ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, ?, ?)`,
            )
            .run(
              randomUUID(),
              conversationId,
              item.type,
              item.entity,
              item.key,
              JSON.stringify(item.value),
              item.reason || "",
              item.itemStatus || "active",
              item.priority,
              JSON.stringify(item.sourceMessageIds),
              nextThroughSeq,
              now,
            );
        }
        if (delta.episode) {
          database
            .prepare(
              `INSERT OR REPLACE INTO episode_summaries (
                id, conversation_id, from_seq, to_seq, topic, summary, source_message_ids_json, created_at
              ) VALUES (
                COALESCE((SELECT id FROM episode_summaries WHERE conversation_id = ? AND from_seq = ? AND to_seq = ?), ?),
                ?, ?, ?, ?, ?, ?, ?
              )`,
            )
            .run(
              conversationId,
              expectedThroughSeq + 1,
              nextThroughSeq,
              randomUUID(),
              conversationId,
              expectedThroughSeq + 1,
              nextThroughSeq,
              delta.episode.topic,
              delta.episode.summary,
              JSON.stringify(delta.episode.sourceMessageIds),
              now,
            );
        }
        database
          .prepare(
            `INSERT INTO memory_versions (
              conversation_id, version, source_from_seq, source_to_seq,
              prompt_version, model, usage_json, delta_json, created_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            conversationId,
            expectedVersion + 1,
            expectedThroughSeq + 1,
            nextThroughSeq,
            promptVersion,
            model,
            jsonOrNull(usage),
            JSON.stringify(delta),
            now,
          );
        insertEvent(database, conversationId, "memory.updated", {
          memoryVersion: expectedVersion + 1,
          summarizedThroughSeq: nextThroughSeq,
        });
        return { applied: true, conversation: getConversationSummaryOrThrow(database, conversationId) };
      });
    },

    /** 将会话标记为 closed，后续 Run 将在存储边界被拒绝。 */
    closeConversation(conversationId) {
      // 关闭状态和事件必须在同一事务提交。
      return withTransaction(database, () => {
        const conversation = getConversationOrThrow(database, conversationId);
        if (conversation.status === "closed") return getConversationSummaryOrThrow(database, conversationId);
        const now = new Date().toISOString();
        database
          .prepare("UPDATE conversations SET status = 'closed', version = version + 1, updated_at = ? WHERE id = ?")
          .run(now, conversationId);
        insertEvent(database, conversationId, "conversation.closed", { conversationId });
        return getConversationSummaryOrThrow(database, conversationId);
      });
    },

    /** 返回指定事件游标之后的会话事件，供 SSE 多端增量同步。 */
    listEventsAfter(conversationId, afterId = 0, limit = 100) {
      return database
        .prepare(
          `SELECT * FROM conversation_events
           WHERE conversation_id = ? AND id > ? ORDER BY id ASC LIMIT ?`,
        )
        .all(conversationId, afterId, limit)
        .map(mapEventRow);
    },
  };
}

/** 创建当前 V0.6 会话、Run、记忆和事件表，并兼容升级既有 SQLite 事实源。 */
function migrate(database) {
  database.exec("PRAGMA foreign_keys = OFF");
  try {
    database.exec(`
      CREATE TABLE IF NOT EXISTS conversations (
      id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      title TEXT NOT NULL,
      status TEXT NOT NULL CHECK(status IN ('active', 'closed')),
      archived_at TEXT,
      version INTEGER NOT NULL,
      memory_version INTEGER NOT NULL,
      summarized_through_seq INTEGER NOT NULL,
      next_seq INTEGER NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
      CREATE TABLE IF NOT EXISTS runs (
      id TEXT PRIMARY KEY,
      conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
      request_id TEXT NOT NULL,
      source_run_id TEXT REFERENCES runs(id) ON DELETE SET NULL,
      recovery_mode TEXT,
      operation TEXT NOT NULL DEFAULT 'conversation.chat',
      user_message_id TEXT,
      assistant_message_id TEXT,
      status TEXT NOT NULL CHECK(status IN ('running', 'completed', 'cancelled', 'failed')),
      model TEXT,
      usage_json TEXT,
      context_manifest_json TEXT,
      resilience_json TEXT,
      error TEXT,
      error_code TEXT,
      deadline_at TEXT,
      chain_trace_id TEXT,
      intent_decision_json TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE(conversation_id, request_id)
    );
      CREATE TABLE IF NOT EXISTS messages (
      id TEXT PRIMARY KEY,
      conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
      seq INTEGER NOT NULL,
      client_message_id TEXT,
      run_id TEXT REFERENCES runs(id) ON DELETE SET NULL,
      role TEXT NOT NULL CHECK(role IN ('user', 'assistant')),
      content_json TEXT NOT NULL,
      display_content TEXT NOT NULL,
      status TEXT NOT NULL,
      usage_json TEXT,
      references_json TEXT NOT NULL DEFAULT '[]',
      created_at TEXT NOT NULL,
      UNIQUE(conversation_id, seq),
      UNIQUE(conversation_id, client_message_id)
    );
      CREATE TABLE IF NOT EXISTS memory_items (
      id TEXT PRIMARY KEY,
      conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
      item_type TEXT NOT NULL,
      entity TEXT NOT NULL,
      memory_key TEXT NOT NULL,
      value_json TEXT NOT NULL,
      reason TEXT NOT NULL,
      item_status TEXT NOT NULL,
      status TEXT NOT NULL CHECK(status IN ('active', 'superseded')),
      priority TEXT NOT NULL CHECK(priority IN ('critical', 'high', 'normal')),
      source_message_ids_json TEXT NOT NULL,
      updated_seq INTEGER NOT NULL,
      superseded_at_seq INTEGER,
      created_at TEXT NOT NULL
    );
      CREATE INDEX IF NOT EXISTS memory_active_idx
      ON memory_items(conversation_id, status, item_type, memory_key);
      CREATE TABLE IF NOT EXISTS memory_versions (
      conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
      version INTEGER NOT NULL,
      source_from_seq INTEGER NOT NULL,
      source_to_seq INTEGER NOT NULL,
      prompt_version TEXT NOT NULL,
      model TEXT,
      usage_json TEXT,
      delta_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      PRIMARY KEY(conversation_id, version)
    );
      CREATE TABLE IF NOT EXISTS episode_summaries (
      id TEXT PRIMARY KEY,
      conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
      from_seq INTEGER NOT NULL,
      to_seq INTEGER NOT NULL,
      topic TEXT NOT NULL,
      summary TEXT NOT NULL,
      source_message_ids_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      UNIQUE(conversation_id, from_seq, to_seq)
    );
      CREATE TABLE IF NOT EXISTS conversation_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
      event_type TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
      CREATE TABLE IF NOT EXISTS tool_calls (
      id TEXT PRIMARY KEY,
      conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
      run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
      operation_id TEXT REFERENCES operations(id) ON DELETE SET NULL,
      tool_call_id TEXT NOT NULL,
      tool_name TEXT NOT NULL,
      status TEXT NOT NULL CHECK(status IN ('running', 'completed', 'failed')),
      input_json TEXT NOT NULL,
      output_json TEXT,
      source_name TEXT,
      observed_at TEXT,
      error_code TEXT,
      error_message TEXT,
      retryable INTEGER NOT NULL DEFAULT 0,
      started_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE(run_id, tool_call_id)
    );
      CREATE INDEX IF NOT EXISTS tool_calls_run_idx ON tool_calls(run_id, started_at);
      CREATE TABLE IF NOT EXISTS operations (
      id TEXT PRIMARY KEY,
      conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
      run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
      operation_key TEXT NOT NULL,
      idempotency_key TEXT NOT NULL,
      kind TEXT NOT NULL CHECK(kind IN ('run', 'tool', 'operation')),
      tool_name TEXT,
      effect TEXT NOT NULL CHECK(effect IN ('read', 'write', 'external', 'unknown')),
      risk_level TEXT NOT NULL CHECK(risk_level IN ('low', 'medium', 'high', 'critical')),
      policy TEXT NOT NULL,
      policy_version TEXT NOT NULL,
      policy_decision TEXT NOT NULL CHECK(policy_decision IN ('allow', 'deny', 'confirmation_required', 'defer')),
      policy_reason_codes_json TEXT NOT NULL,
      status TEXT NOT NULL CHECK(status IN ('planned', 'running', 'completed', 'failed', 'unknown', 'confirmation_required', 'cancelled')),
      input_json TEXT NOT NULL,
      attempt INTEGER NOT NULL DEFAULT 0,
      external_request_id TEXT,
      result_json TEXT,
      readback_json TEXT,
      error_code TEXT,
      error_message TEXT,
      retryable INTEGER NOT NULL DEFAULT 0,
      started_at TEXT,
      completed_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE(conversation_id, idempotency_key),
      UNIQUE(run_id, operation_key)
    );
      CREATE INDEX IF NOT EXISTS operations_run_idx ON operations(run_id, created_at);
      CREATE INDEX IF NOT EXISTS operations_status_idx ON operations(status, updated_at);
      CREATE TABLE IF NOT EXISTS run_leases (
      run_id TEXT PRIMARY KEY REFERENCES runs(id) ON DELETE CASCADE,
      conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
      owner_id TEXT NOT NULL,
      fencing_token INTEGER NOT NULL CHECK(fencing_token > 0),
      lease_expires_at TEXT NOT NULL,
      acquired_at TEXT NOT NULL,
      released_at TEXT,
      updated_at TEXT NOT NULL
    );
      CREATE INDEX IF NOT EXISTS run_leases_expiry_idx ON run_leases(lease_expires_at);
      CREATE TABLE IF NOT EXISTS acceptance_results (
      run_id TEXT PRIMARY KEY REFERENCES runs(id) ON DELETE CASCADE,
      conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
      policy TEXT NOT NULL,
      policy_version TEXT NOT NULL,
      status TEXT NOT NULL CHECK(status IN ('accepted', 'rejected')),
      reason_codes_json TEXT NOT NULL,
      evidence_json TEXT NOT NULL,
      evaluated_at TEXT NOT NULL
    );
      CREATE TABLE IF NOT EXISTS image_assets (
      id TEXT PRIMARY KEY,
      conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
      run_id TEXT REFERENCES runs(id) ON DELETE CASCADE,
      version INTEGER NOT NULL,
      media_type TEXT NOT NULL,
      size_bytes INTEGER NOT NULL,
      width INTEGER NOT NULL,
      height INTEGER NOT NULL,
      sha256 TEXT NOT NULL,
      source TEXT NOT NULL,
      status TEXT NOT NULL CHECK(status IN ('available', 'blocked', 'expired')),
      storage_key TEXT NOT NULL UNIQUE,
      created_at TEXT NOT NULL,
      expires_at TEXT
    );
      CREATE INDEX IF NOT EXISTS image_assets_conversation_idx
      ON image_assets(conversation_id, created_at);
      CREATE TABLE IF NOT EXISTS message_artifacts (
      message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
      asset_id TEXT NOT NULL REFERENCES image_assets(id) ON DELETE CASCADE,
      position INTEGER NOT NULL,
      PRIMARY KEY(message_id, asset_id),
      UNIQUE(message_id, position)
    );
    `);
    ensureColumn(database, "runs", "resilience_json", "TEXT");
    ensureColumn(database, "messages", "references_json", "TEXT NOT NULL DEFAULT '[]'");
    migrateCancelledRunStatus(database);
    ensureColumn(database, "conversations", "archived_at", "TEXT");
    ensureColumn(database, "runs", "source_run_id", "TEXT REFERENCES runs(id) ON DELETE SET NULL");
    ensureColumn(database, "runs", "recovery_mode", "TEXT");
    ensureColumn(database, "runs", "operation", "TEXT NOT NULL DEFAULT 'conversation.chat'");
    ensureColumn(database, "runs", "error_code", "TEXT");
    ensureColumn(database, "runs", "deadline_at", "TEXT");
    ensureColumn(database, "runs", "chain_trace_id", "TEXT");
    ensureColumn(database, "runs", "intent_decision_json", "TEXT");
    ensureColumn(database, "tool_calls", "operation_id", "TEXT REFERENCES operations(id) ON DELETE SET NULL");
    migrateImageAssetRunOwnership(database);
    database.exec(
      "CREATE INDEX IF NOT EXISTS image_assets_conversation_idx ON image_assets(conversation_id, created_at)",
    );
    database.exec("CREATE INDEX IF NOT EXISTS conversations_archive_idx ON conversations(archived_at, updated_at DESC)");
  } finally {
    database.exec("PRAGMA foreign_keys = ON");
  }
  const violations = database.prepare("PRAGMA foreign_key_check").all();
  if (violations.length > 0) throw new Error("Conversation database migration produced invalid foreign keys");
}

/** 重建旧版 Run 与 Message 表，为 Run 状态约束加入 cancelled 并保留消息外键。 */
function migrateCancelledRunStatus(database) {
  const columns = database.prepare("PRAGMA table_info(runs)").all();
  if (!columns.some(isStatusColumn)) return;
  const table = database.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'runs'").get();
  if (/['"]cancelled['"]/i.test(String(table?.sql || ""))) return;

  // 事务回调重建关联表并一次性切换到支持 cancelled 的约束。
  withTransaction(database, () => {
    database.exec(`
      CREATE TABLE runs_next (
      id TEXT PRIMARY KEY,
      conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
      request_id TEXT NOT NULL,
      user_message_id TEXT,
      assistant_message_id TEXT,
      status TEXT NOT NULL CHECK(status IN ('running', 'completed', 'cancelled', 'failed')),
      model TEXT,
      usage_json TEXT,
      context_manifest_json TEXT,
      resilience_json TEXT,
      error TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE(conversation_id, request_id)
    );
    INSERT INTO runs_next (
      id, conversation_id, request_id, user_message_id, assistant_message_id,
      status, model, usage_json, context_manifest_json, resilience_json, error, created_at, updated_at
    ) SELECT
      id, conversation_id, request_id, user_message_id, assistant_message_id,
      status, model, usage_json, context_manifest_json, resilience_json, error, created_at, updated_at
    FROM runs;
    CREATE TABLE messages_next (
      id TEXT PRIMARY KEY,
      conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
      seq INTEGER NOT NULL,
      client_message_id TEXT,
      run_id TEXT REFERENCES runs(id) ON DELETE SET NULL,
      role TEXT NOT NULL CHECK(role IN ('user', 'assistant')),
      content_json TEXT NOT NULL,
      display_content TEXT NOT NULL,
      status TEXT NOT NULL,
      usage_json TEXT,
      references_json TEXT NOT NULL DEFAULT '[]',
      created_at TEXT NOT NULL,
      UNIQUE(conversation_id, seq),
      UNIQUE(conversation_id, client_message_id)
    );
    INSERT INTO messages_next (
      id, conversation_id, seq, client_message_id, run_id, role, content_json,
      display_content, status, usage_json, references_json, created_at
    ) SELECT
      id, conversation_id, seq, client_message_id, run_id, role, content_json,
      display_content, status, usage_json, references_json, created_at
    FROM messages;
    DROP TABLE messages;
    DROP TABLE runs;
    ALTER TABLE runs_next RENAME TO runs;
      ALTER TABLE messages_next RENAME TO messages;
    `);
  });
}

/** 重建图片资产与消息产物表，使上传资产可以在创建 Run 前拥有空 run_id。 */
function migrateImageAssetRunOwnership(database) {
  const columns = database.prepare("PRAGMA table_info(image_assets)").all();
  const runIdColumn = columns.find(isRunIdColumn);
  if (!runIdColumn || Number(runIdColumn.notnull) === 0) return;

  /** 原子重建资产及消息关联表，升级失败时完整保留旧表。 */
  function migrateImageAssetTables() {
    database.exec(`
      CREATE TABLE image_assets_next (
      id TEXT PRIMARY KEY,
      conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
      run_id TEXT REFERENCES runs(id) ON DELETE CASCADE,
      version INTEGER NOT NULL,
      media_type TEXT NOT NULL,
      size_bytes INTEGER NOT NULL,
      width INTEGER NOT NULL,
      height INTEGER NOT NULL,
      sha256 TEXT NOT NULL,
      source TEXT NOT NULL,
      status TEXT NOT NULL CHECK(status IN ('available', 'blocked', 'expired')),
      storage_key TEXT NOT NULL UNIQUE,
      created_at TEXT NOT NULL,
      expires_at TEXT
    );
      INSERT INTO image_assets_next (
        id, conversation_id, run_id, version, media_type, size_bytes, width, height,
        sha256, source, status, storage_key, created_at, expires_at
      ) SELECT
        id, conversation_id, run_id, version, media_type, size_bytes, width, height,
        sha256, source, status, storage_key, created_at, expires_at
      FROM image_assets;
      CREATE TABLE message_artifacts_next (
      message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
      asset_id TEXT NOT NULL REFERENCES image_assets_next(id) ON DELETE CASCADE,
      position INTEGER NOT NULL,
      PRIMARY KEY(message_id, asset_id),
      UNIQUE(message_id, position)
    );
      INSERT INTO message_artifacts_next (message_id, asset_id, position)
      SELECT message_id, asset_id, position FROM message_artifacts;
      DROP TABLE message_artifacts;
      DROP TABLE image_assets;
      ALTER TABLE image_assets_next RENAME TO image_assets;
      ALTER TABLE message_artifacts_next RENAME TO message_artifacts;
      CREATE INDEX image_assets_conversation_idx ON image_assets(conversation_id, created_at);
    `);
  }
  withTransaction(database, migrateImageAssetTables);
}

/** 判断 PRAGMA 表信息行是否表示 status 列。 */
function isStatusColumn(column) {
  return column.name === "status";
}

/** 判断 PRAGMA 表信息行是否表示 run_id 列。 */
function isRunIdColumn(column) {
  return column.name === "run_id";
}

/** 为既有 SQLite 数据库补充缺失列；表名、列名和定义只允许由迁移代码常量传入。 */
function ensureColumn(database, tableName, columnName, definition) {
  const columns = database.prepare(`PRAGMA table_info(${tableName})`).all();
  for (const column of columns) {
    if (column.name === columnName) return;
  }
  database.exec(`ALTER TABLE ${tableName} ADD COLUMN ${columnName} ${definition}`);
}

/** 在 BEGIN IMMEDIATE 事务中执行同步存储操作并统一回滚异常。 */
function withTransaction(database, operation) {
  database.exec("BEGIN IMMEDIATE");
  try {
    const result = operation();
    database.exec("COMMIT");
    return result;
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
}

/** 查询会话，不存在时抛出稳定的 404 业务错误。 */
function getConversationOrThrow(database, conversationId) {
  const row = database.prepare("SELECT * FROM conversations WHERE id = ?").get(conversationId);
  if (!row) throw new ConversationStoreError("Conversation not found", 404, "conversation_not_found");
  return row;
}

/** 查询包含消息和 active 记忆计数的会话摘要。 */
function getConversationSummaryOrThrow(database, conversationId) {
  const row = database
    .prepare(
      `SELECT c.*,
        (SELECT COUNT(*) FROM messages m WHERE m.conversation_id = c.id) AS message_count,
        (SELECT COUNT(*) FROM memory_items mi WHERE mi.conversation_id = c.id AND mi.status = 'active') AS memory_count
       FROM conversations c
       WHERE c.id = ?`,
    )
    .get(conversationId);
  if (!row) throw new ConversationStoreError("Conversation not found", 404, "conversation_not_found");
  return mapConversationRow(row);
}

/** 查询 Run，不存在时抛出稳定的 404 业务错误。 */
function getRunOrThrow(database, runId) {
  const row = database.prepare("SELECT * FROM runs WHERE id = ?").get(runId);
  if (!row) throw new ConversationStoreError("Run not found", 404, "run_not_found");
  return row;
}

/** 查询指定 Run 中的工具调用，不存在时抛出稳定业务错误。 */
function getToolCallOrThrow(database, runId, toolCallId) {
  const row = database
    .prepare("SELECT * FROM tool_calls WHERE run_id = ? AND tool_call_id = ?")
    .get(runId, toolCallId);
  if (!row) throw new ConversationStoreError("Tool call not found", 404, "tool_call_not_found");
  return row;
}

/** 查询 Operation，不存在时抛出稳定的 404 业务错误。 */
function getOperationOrThrow(database, operationId) {
  const row = database.prepare("SELECT * FROM operations WHERE id = ?").get(operationId);
  if (!row) throw new ConversationStoreError("Operation not found", 404, "operation_not_found");
  return row;
}

/** 校验重复 ToolCall 的协议投影和关联 Operation 与原始幂等事实完全一致。 */
function assertToolCallReplay(database, row, input) {
  const policyDecision = normalizePolicyDecision(input.policyDecision);
  const operation = row.operation_id ? getOperationOrThrow(database, row.operation_id) : null;
  const serializedInput = JSON.stringify(input.input ?? {});
  const matchesToolCall =
    row.conversation_id === input.conversationId &&
    row.run_id === input.runId &&
    row.tool_call_id === input.toolCallId &&
    row.tool_name === input.toolName &&
    row.input_json === serializedInput;
  const matchesOperation =
    operation &&
    operation.operation_key === input.operationKey &&
    operation.idempotency_key === input.idempotencyKey &&
    operation.effect === input.effect &&
    operation.risk_level === input.riskLevel &&
    operation.policy === policyDecision.policy &&
    operation.policy_version === policyDecision.policyVersion &&
    operation.policy_decision === policyDecision.decision &&
    operation.input_json === serializedInput;
  if (!matchesToolCall || !matchesOperation) {
    throw new ConversationStoreError(
      "ToolCall idempotency key conflicts with existing fact",
      409,
      "tool_call_idempotency_conflict",
    );
  }
}

/**
 * 幂等插入 Operation；相同幂等键必须保持 Run、操作键、策略版本和输入一致。
 *
 * @param {DatabaseSync} database - 当前 SQLite 连接。
 * @param {object} input - 已校验的 Operation 创建事实。
 * @returns {{operation: object, replayed: boolean}} 新建或重放结果。
 */
function insertOperation(database, input) {
  const conversationId = requireStableIdentifier(input.conversationId, "conversationId");
  const runId = requireStableIdentifier(input.runId, "runId");
  const operationKey = requireStableIdentifier(input.operationKey, "operationKey");
  const idempotencyKey = requireStableIdentifier(input.idempotencyKey, "idempotencyKey");
  const kind = normalizeEnum(input.kind, ["run", "tool", "operation"], "operation kind");
  const effect = normalizeEnum(input.effect, ["read", "write", "external", "unknown"], "operation effect");
  const riskLevel = normalizeEnum(
    input.riskLevel,
    ["low", "medium", "high", "critical"],
    "operation riskLevel",
  );
  const policyDecision = normalizePolicyDecision(input.policyDecision);
  const status = normalizeEnum(
    input.status,
    ["planned", "running", "confirmation_required"],
    "operation initial status",
  );
  const serializedInput = JSON.stringify(input.input ?? {});
  const existing = database
    .prepare("SELECT * FROM operations WHERE conversation_id = ? AND idempotency_key = ?")
    .get(conversationId, idempotencyKey);
  if (existing) {
    if (
      existing.run_id !== runId ||
      existing.operation_key !== operationKey ||
      existing.kind !== kind ||
      nullableString(existing.tool_name) !== nullableString(input.toolName) ||
      existing.effect !== effect ||
      existing.risk_level !== riskLevel ||
      existing.policy !== policyDecision.policy ||
      existing.policy_version !== policyDecision.policyVersion ||
      existing.policy_decision !== policyDecision.decision ||
      existing.input_json !== serializedInput
    ) {
      throw new ConversationStoreError(
        "Operation idempotency key conflicts with existing fact",
        409,
        "operation_idempotency_conflict",
      );
    }
    return { operation: mapOperationRow(existing), replayed: true };
  }

  const id = randomUUID();
  const now = input.now || new Date().toISOString();
  const startedAt = status === "running" ? now : null;
  database
    .prepare(
      `INSERT INTO operations (
        id, conversation_id, run_id, operation_key, idempotency_key, kind, tool_name,
        effect, risk_level, policy, policy_version, policy_decision, policy_reason_codes_json,
        status, input_json, attempt, started_at, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      id,
      conversationId,
      runId,
      operationKey,
      idempotencyKey,
      kind,
      nullableString(input.toolName),
      effect,
      riskLevel,
      policyDecision.policy,
      policyDecision.policyVersion,
      policyDecision.decision,
      JSON.stringify(policyDecision.reasonCodes),
      status,
      serializedInput,
      Number.isInteger(input.attempt) && input.attempt >= 0 ? input.attempt : 0,
      startedAt,
      now,
      now,
    );
  return {
    operation: mapOperationRow(database.prepare("SELECT * FROM operations WHERE id = ?").get(id)),
    replayed: false,
  };
}

/** 将 running 或有回读证据的 unknown Operation 幂等收口为 completed。 */
function completeOperationRow(database, row, { result, readback, externalRequestId, now }) {
  if (row.status === "completed") return mapOperationRow(row);
  if (row.status === "unknown" && readback == null) {
    throw new ConversationStoreError(
      "Unknown Operation requires readback before completion",
      409,
      "operation_readback_required",
    );
  }
  if (!["running", "unknown"].includes(row.status)) {
    throw new ConversationStoreError("Operation is not active", 409, "operation_not_active");
  }
  database
    .prepare(
      `UPDATE operations
       SET status = 'completed', external_request_id = COALESCE(?, external_request_id),
           result_json = ?, readback_json = ?, error_code = NULL, error_message = NULL,
           retryable = 0, completed_at = ?, updated_at = ?
       WHERE id = ?`,
    )
    .run(
      nullableString(externalRequestId),
      jsonOrNull(result),
      jsonOrNull(readback),
      now,
      now,
      row.id,
    );
  insertEvent(database, row.conversation_id, "operation.completed", {
    runId: row.run_id,
    operationId: row.id,
    operationKey: row.operation_key,
  });
  return mapOperationRow(database.prepare("SELECT * FROM operations WHERE id = ?").get(row.id));
}

/** 将 active 或有回读证据的 unknown Operation 收口为 failed/cancelled。 */
function failOperationRow(
  database,
  row,
  { status, code, message, retryable = false, readback = null, externalRequestId = null, now },
) {
  if (row.status === status) return mapOperationRow(row);
  if (row.status === "unknown" && readback == null) {
    throw new ConversationStoreError(
      "Unknown Operation requires readback before failure",
      409,
      "operation_readback_required",
    );
  }
  const allowedSources = status === "cancelled"
    ? ["planned", "confirmation_required", "running"]
    : ["running", "unknown"];
  if (!allowedSources.includes(row.status)) {
    throw new ConversationStoreError("Operation is not active", 409, "operation_not_active");
  }
  database
    .prepare(
      `UPDATE operations
       SET status = ?, external_request_id = COALESCE(?, external_request_id),
           readback_json = ?, error_code = ?, error_message = ?, retryable = ?,
           completed_at = ?, updated_at = ?
       WHERE id = ?`,
    )
    .run(
      status,
      nullableString(externalRequestId),
      jsonOrNull(readback),
      String(code || "operation_failed"),
      String(message || "操作执行失败。"),
      retryable ? 1 : 0,
      now,
      now,
      row.id,
    );
  insertEvent(database, row.conversation_id, `operation.${status}`, {
    runId: row.run_id,
    operationId: row.id,
    code: String(code || "operation_failed"),
    retryable: Boolean(retryable),
  });
  return mapOperationRow(database.prepare("SELECT * FROM operations WHERE id = ?").get(row.id));
}

/** 校验策略决定具备版本、结论和稳定原因码。 */
function normalizePolicyDecision(value) {
  const decision = normalizeEnum(
    value?.decision,
    ["allow", "deny", "confirmation_required", "defer"],
    "policy decision",
  );
  const reasonCodes = [];
  for (const item of Array.isArray(value?.reasonCodes) ? value.reasonCodes : []) {
    const code = String(item || "").trim();
    if (code && !reasonCodes.includes(code)) reasonCodes.push(code);
  }
  if (reasonCodes.length === 0) {
    throw new ConversationStoreError("Policy reason codes are required", 500, "invalid_policy_decision");
  }
  return Object.freeze({
    decision,
    policy: requireStableIdentifier(value?.policy, "policy"),
    policyVersion: requireStableIdentifier(value?.policyVersion, "policyVersion"),
    reasonCodes: Object.freeze(reasonCodes),
  });
}

/** 校验 RunLease；没有 lease 事实时兼容旧 Store 调用，存在事实时强制 owner/token/expiry。 */
function assertRunLease(database, runId, credentials, nowDate, { requireActive = true } = {}) {
  const row = database.prepare("SELECT * FROM run_leases WHERE run_id = ?").get(runId);
  if (!row) return null;
  const ownerId = nullableString(credentials?.ownerId);
  const fencingToken = Number(credentials?.fencingToken);
  if (!ownerId || !Number.isInteger(fencingToken) || fencingToken !== Number(row.fencing_token)) {
    throw new ConversationStoreError("Run lease fencing token is stale", 409, "stale_fencing_token");
  }
  if (ownerId !== row.owner_id) {
    throw new ConversationStoreError("Run lease owner is stale", 409, "stale_lease_owner");
  }
  if (requireActive && !isLeaseActive(row, nowDate)) {
    throw new ConversationStoreError("Run lease has expired", 409, "run_lease_expired");
  }
  return row;
}

/** 查询当前会话拥有且未过期的图片资产，缺失和越权使用同一公开错误。 */
function getAvailableImageAssetOrThrow(database, conversationId, assetId) {
  const row = database
    .prepare("SELECT * FROM image_assets WHERE id = ? AND conversation_id = ? AND status = 'available'")
    .get(assetId, conversationId);
  if (!row || (row.expires_at && Date.parse(row.expires_at) <= Date.now())) {
    throw new ConversationStoreError("Image asset not found", 404, "image_asset_not_found");
  }
  return row;
}

/** 终态幂等读取允许省略凭证；一旦携带凭证，仍校验 owner/token 防止旧实例伪装重放。 */
function assertTerminalReplayLease(database, runId, credentials, nowDate) {
  if (credentials == null) return null;
  return assertRunLease(database, runId, credentials, nowDate, { requireActive: false });
}

/** 在 Run 终态事务内释放匹配 lease，避免终态已提交但 owner 仍被误认为活跃。 */
function releaseRunLeaseAfterTerminal(database, run, credentials, now) {
  const row = database.prepare("SELECT * FROM run_leases WHERE run_id = ?").get(run.id);
  if (!row || row.released_at) return;
  database
    .prepare("UPDATE run_leases SET released_at = ?, lease_expires_at = ?, updated_at = ? WHERE run_id = ?")
    .run(now, now, now, run.id);
  insertEvent(database, run.conversation_id, "run.lease_released", {
    runId: run.id,
    ownerId: row.owner_id,
    fencingToken: Number(row.fencing_token),
    reasonCode: "run_terminal",
  });
}

/** 判断 lease 尚未释放且过期时间严格晚于当前 Store 时钟。 */
function isLeaseActive(row, nowDate) {
  return !row.released_at && Date.parse(row.lease_expires_at) > nowDate.getTime();
}

/** 将 lease TTL 限制为 1ms 到 24h 的正整数。 */
function normalizeLeaseTtl(value) {
  const ttlMs = Number(value);
  if (!Number.isInteger(ttlMs) || ttlMs < 1 || ttlMs > 86400000) {
    throw new ConversationStoreError("Run lease ttl is invalid", 400, "invalid_run_lease_ttl");
  }
  return ttlMs;
}

/** 校验时钟函数并确保每次返回有效 Date。 */
function normalizeClock(clock) {
  if (typeof clock !== "function") throw new TypeError("clock must be a function");
  return function readCurrentDate() {
    const value = clock();
    if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
      throw new TypeError("clock must return a valid Date");
    }
    return value;
  };
}

/** 返回当前系统时间，作为生产 Store 默认时钟。 */
function createCurrentDate() {
  return new Date();
}

/** 校验并返回 SQLite CHECK 对应的字符串枚举值。 */
function normalizeEnum(value, allowed, fieldName) {
  const normalized = String(value || "");
  if (!allowed.includes(normalized)) {
    throw new ConversationStoreError(`${fieldName} is invalid`, 400, "invalid_operation_fact");
  }
  return normalized;
}

/** 校验数据库事实标识不为空且不包含控制字符。 */
function requireStableIdentifier(value, fieldName) {
  const identifier = String(value || "").trim();
  if (!identifier || identifier.length > 240 || /[\r\n\0]/.test(identifier)) {
    throw new ConversationStoreError(`${fieldName} is invalid`, 400, "invalid_operation_fact");
  }
  return identifier;
}

/** 在创建图片编辑 Run 前校验源资产归属和可用性，避免无效引用落成用户消息。 */
function validateImageRunReferences(database, conversationId, operation, references) {
  if (operation !== "image.edit") return;
  const reference = Array.isArray(references) ? references[0] : null;
  getAvailableImageAssetOrThrow(database, conversationId, reference?.assetId);
}

/** 校验恢复来源属于当前会话，且终止状态和真实 operation 均与恢复请求匹配。 */
function validateRecoverySource(database, conversationId, sourceRunId, recoveryMode, operation) {
  if (!sourceRunId && !recoveryMode) return;
  const expectedStatus = RECOVERY_SOURCE_STATUS[recoveryMode];
  const source = sourceRunId ? database.prepare("SELECT * FROM runs WHERE id = ? AND conversation_id = ?").get(sourceRunId, conversationId) : null;
  if (!source || !expectedStatus || source.status !== expectedStatus || source.operation !== operation) {
    throw new ConversationStoreError("Recovery source is not valid for this mode", 409, "invalid_run_recovery_source");
  }
}

/** 将数据库 Run 行组合成可供 Runtime 重放的完整结果。 */
function buildRunResult(database, run, replayed) {
  const userMessage = run.user_message_id
    ? mapMessageWithArtifacts(database, database.prepare("SELECT * FROM messages WHERE id = ?").get(run.user_message_id))
    : null;
  const assistantMessage = run.assistant_message_id
    ? mapMessageWithArtifacts(database, database.prepare("SELECT * FROM messages WHERE id = ?").get(run.assistant_message_id))
    : null;
  return {
    run: mapRunRow(run),
    userMessage,
    assistantMessage,
    toolCalls: listToolCallsForRun(database, run.id),
    operations: listOperationsForRun(database, run.id),
    artifacts: listImageAssetsForRun(database, run.id),
    acceptance: getAcceptanceForRun(database, run.id),
    replayed,
  };
}

/** 为会话详情中的 Run 附加已持久化工具事实和图片产物。 */
function mapRunWithToolCalls(database, row) {
  return {
    ...mapRunRow(row),
    toolCalls: listToolCallsForRun(database, row.id),
    operations: listOperationsForRun(database, row.id),
    artifacts: listImageAssetsForRun(database, row.id),
    acceptance: getAcceptanceForRun(database, row.id),
  };
}

/** 返回指定 Run 的系统验收事实；普通未配置策略的 Run 返回 null。 */
function getAcceptanceForRun(database, runId) {
  const row = database.prepare("SELECT * FROM acceptance_results WHERE run_id = ?").get(runId);
  return row ? mapAcceptanceResultRow(row) : null;
}

/** 查询并映射一个 Run 的全部工具调用。 */
function listToolCallsForRun(database, runId) {
  return database
    .prepare("SELECT * FROM tool_calls WHERE run_id = ? ORDER BY started_at ASC, rowid ASC")
    .all(runId)
    .map(mapToolCallRow);
}

/** 查询并映射一个 Run 的全部 Operation 执行事实。 */
function listOperationsForRun(database, runId) {
  return database
    .prepare("SELECT * FROM operations WHERE run_id = ? ORDER BY created_at ASC, rowid ASC")
    .all(runId)
    .map(mapOperationRow);
}

/** 查询一个 Run 已完成的全部图片资产引用。 */
function listImageAssetsForRun(database, runId) {
  return database
    .prepare("SELECT * FROM image_assets WHERE run_id = ? AND status = 'available' ORDER BY created_at ASC, rowid ASC")
    .all(runId)
    .map(mapImageAssetRow);
}

/** 把调用方路由窗口限制为稳定正整数，防止分类上下文无界读取。 */
function normalizeRoutingContextMessageLimit(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return ROUTING_CONTEXT_DEFAULT_MAX_MESSAGES;
  return Math.min(Math.max(Math.trunc(parsed), 1), ROUTING_CONTEXT_MAX_MESSAGES);
}

/** 线性扫描历史正文并替换远程和内联地址，保留 Markdown 外层结构与普通标点。 */
function redactRoutingMessageUrls(value) {
  const content = String(value || "");
  let result = "";
  let copyStart = 0;
  let index = 0;
  while (index < content.length) {
    const scheme = matchRoutingUrlScheme(content, index);
    if (!scheme) {
      index += 1;
      continue;
    }
    const urlEnd = findRoutingUrlEnd(
      content,
      scheme.schemeEnd,
      isParenthesizedUrlDestination(content, index),
    );
    result += content.slice(copyStart, index) + scheme.placeholder;
    copyStart = urlEnd;
    index = urlEnd;
  }
  return result + content.slice(copyStart);
}

/**
 * 识别当前位置是否为受支持的 URL scheme，并返回脱敏占位符与正文起点。
 *
 * @returns {{placeholder:string, schemeEnd:number}|null} 匹配结果；普通字符返回 null。
 */
function matchRoutingUrlScheme(content, index) {
  const prefix = content.slice(index, index + 8).toLowerCase();
  if (prefix.startsWith("https://")) {
    return { placeholder: ROUTING_CONTEXT_URL_PLACEHOLDER, schemeEnd: index + 8 };
  }
  if (prefix.startsWith("http://")) {
    return { placeholder: ROUTING_CONTEXT_URL_PLACEHOLDER, schemeEnd: index + 7 };
  }
  if (prefix.startsWith("data:")) {
    return { placeholder: ROUTING_CONTEXT_DATA_URL_PLACEHOLDER, schemeEnd: index + 5 };
  }
  return null;
}

/** 扫描一个 URL 候选，配对内部括号并在 Markdown/自然语言外层闭合符或文本边界前停止。 */
function findRoutingUrlEnd(content, schemeEnd, parenthesizedDestination) {
  let roundDepth = 0;
  let squareDepth = 0;
  let braceDepth = 0;
  let index = schemeEnd;
  while (index < content.length) {
    const character = content[index];
    if (isRoutingUrlHardBoundary(character)) break;
    if (character === "(") roundDepth += 1;
    if (character === "[") squareDepth += 1;
    if (character === "{") braceDepth += 1;
    if (character === ")") {
      if (
        roundDepth === 0
        && (
          parenthesizedDestination
          || isRoutingUrlClosingParenthesisBoundary(content, index + 1)
        )
      ) break;
      if (roundDepth > 0) roundDepth -= 1;
    }
    if (character === "]") {
      if (squareDepth === 0) break;
      squareDepth -= 1;
    }
    if (character === "}") {
      if (braceDepth === 0) break;
      braceDepth -= 1;
    }
    index += 1;
  }
  return trimRoutingUrlTrailingPunctuation(content, schemeEnd, index);
}

/** 判断 URL 是否位于 Markdown 或自然语言外层圆括号中，以保留对应闭合符。 */
function isParenthesizedUrlDestination(content, urlStart) {
  return urlStart >= 1 && content[urlStart - 1] === "(";
}

/** 判断未配对右括号之后是否已经进入句读或文本边界。 */
function isRoutingUrlClosingParenthesisBoundary(content, nextIndex) {
  if (nextIndex >= content.length) return true;
  const nextCharacter = content[nextIndex];
  return isRoutingUrlHardBoundary(nextCharacter)
    || ROUTING_URL_TRAILING_PUNCTUATION.has(nextCharacter)
    || nextCharacter === ")"
    || nextCharacter === "]"
    || nextCharacter === "}";
}

/** 判断字符是否为 URL 之外的强边界；空白和控制字符同样终止候选。 */
function isRoutingUrlHardBoundary(character) {
  return /\s/u.test(character) || ROUTING_URL_HARD_BOUNDARIES.has(character);
}

/** 从候选尾部退回常见句末标点，使标点留在脱敏后的自然语言中。 */
function trimRoutingUrlTrailingPunctuation(content, schemeEnd, candidateEnd) {
  let end = candidateEnd;
  while (end > schemeEnd && ROUTING_URL_TRAILING_PUNCTUATION.has(content[end - 1])) end -= 1;
  return end;
}

/** 在 URL 脱敏后应用单条预算；超限正文整体替换，避免丢失尾部纠正后仍驱动副作用。 */
function truncateRoutingMessage(value) {
  const content = redactRoutingMessageUrls(value);
  const truncated = content.length > ROUTING_CONTEXT_MESSAGE_MAX_CHARS;
  return {
    value: truncated ? ROUTING_CONTEXT_TRUNCATED_CONTENT_PLACEHOLDER : content,
    truncated,
  };
}

/** 从最新消息序向前寻找活动图片，未进入消息的上传资产不会成为候选。 */
function deriveActiveImage(database, conversationId, nowDate) {
  const rows = database
    .prepare(
      `SELECT m.*
       FROM messages m
       WHERE m.conversation_id = ?
         AND m.status = 'committed'
         AND (
           (m.role = 'assistant' AND EXISTS (
             SELECT 1 FROM message_artifacts ma WHERE ma.message_id = m.id
           ))
           OR (m.role = 'user' AND m.references_json <> '[]')
         )
       ORDER BY m.seq DESC`,
    )
    .all(conversationId);
  for (const message of rows) {
    const asset = findMessageImageAsset(database, message, nowDate);
    if (!asset) continue;
    return {
      assetId: asset.id,
      source: asset.source,
      anchorMessageId: message.id,
      anchorSeq: Number(message.seq),
      originRunId: message.run_id || null,
    };
  }
  return null;
}

/** 解析一条消息锚定的唯一工作图片；多图用户输入不产生隐式活动图片。 */
function findMessageImageAsset(database, message, nowDate) {
  if (message.status !== "committed") return null;
  if (message.role === "assistant") {
    if (!message.run_id) return null;
    const assets = database
      .prepare(
        `SELECT ia.*
         FROM message_artifacts ma
         JOIN image_assets ia ON ia.id = ma.asset_id
         JOIN runs r ON r.id = ia.run_id
         WHERE ma.message_id = ?
           AND ia.conversation_id = ?
           AND ia.run_id = ?
           AND r.conversation_id = ?
           AND r.assistant_message_id = ?
           AND r.status = 'completed'
           AND (
             (r.operation = 'image.generate' AND ia.source = 'generated')
             OR (r.operation = 'image.edit' AND ia.source = 'edited')
           )
         ORDER BY ma.position ASC`,
      )
      .all(
        message.id,
        message.conversation_id,
        message.run_id,
        message.conversation_id,
        message.id,
      );
    for (const asset of assets) {
      if (isImageAssetAvailableAt(asset, nowDate)) return asset;
    }
    return null;
  }
  if (message.role !== "user") return null;
  const references = parseJson(message.references_json, []);
  const imageReferences = (Array.isArray(references) ? references : []).filter(
    /** 只统计具有稳定资产 ID 的受控图片引用。 */
    (reference) => reference?.type === "image_asset" && reference.assetId,
  );
  if (imageReferences.length !== 1) return null;
  const asset = database
    .prepare("SELECT * FROM image_assets WHERE id = ? AND conversation_id = ?")
    .get(imageReferences[0].assetId, message.conversation_id);
  return isImageAssetAvailableAt(asset, nowDate) ? asset : null;
}

/** 判断图片资产在给定 Store 时钟下是否仍可读取；非法过期时间按不可用处理。 */
function isImageAssetAvailableAt(asset, nowDate) {
  if (!asset || asset.status !== "available") return false;
  if (!asset.expires_at) return true;
  const expiresAt = Date.parse(asset.expires_at);
  return Number.isFinite(expiresAt) && expiresAt > nowDate.getTime();
}

/** 为消息附加经关联表解析的图片产物，不读取图片二进制。 */
function mapMessageWithArtifacts(database, row) {
  const message = mapMessageRow(row);
  if (!message) return null;
  const artifacts = database
    .prepare(
      `SELECT ia.* FROM message_artifacts ma
       JOIN image_assets ia ON ia.id = ma.asset_id
       WHERE ma.message_id = ? AND ia.status = 'available'
       ORDER BY ma.position ASC`,
    )
    .all(row.id)
    .map(mapImageAssetRow);
  const referenceAssets = [];
  for (const reference of message.references) {
    if (reference?.type !== "image_asset" || !reference.assetId) continue;
    const asset = database
      .prepare(
        "SELECT * FROM image_assets WHERE id = ? AND conversation_id = ? AND status = 'available'",
      )
      .get(reference.assetId, row.conversation_id);
    if (asset && (!asset.expires_at || Date.parse(asset.expires_at) > Date.now())) {
      referenceAssets.push(mapImageAssetRow(asset));
    }
  }
  return { ...message, artifacts, referenceAssets };
}

/** 写入会话事件日志，事件与业务状态共享外层事务。 */
function insertEvent(database, conversationId, eventType, payload) {
  database
    .prepare("INSERT INTO conversation_events (conversation_id, event_type, payload_json, created_at) VALUES (?, ?, ?, ?)")
    .run(conversationId, eventType, JSON.stringify(payload), new Date().toISOString());
}

/** 使用首条用户消息生成紧凑会话标题。 */
function buildConversationTitle(value) {
  const normalized = String(value || "").replace(/\s+/g, " ").trim();
  return normalized ? normalized.slice(0, 36) : "新会话";
}

/** 将可空对象序列化为数据库 JSON 文本。 */
function jsonOrNull(value) {
  return value == null ? null : JSON.stringify(value);
}

/** 将 Runtime 路由事实收敛到固定白名单，阻止正文、图片 ID 和 provider 原文进入审计。 */
function sanitizeIntentDecision(database, conversationId, value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const decision = {};
  for (const field of ["schemaVersion", "routerVersion", "contextStrategyVersion"]) {
    const normalized = sanitizeIntentDecisionIdentifier(value[field]);
    if (normalized) decision[field] = normalized;
  }
  for (const field of ["operation", "classifiedOperation"]) {
    const normalized = String(value[field] || "");
    if (INTENT_DECISION_OPERATIONS.includes(normalized)) decision[field] = normalized;
  }
  const source = String(value.source || "");
  if (INTENT_DECISION_SOURCES.includes(source)) decision.source = source;
  for (const field of ["confidence", "threshold"]) {
    if (value[field] == null) continue;
    const number = Number(value[field]);
    if (Number.isFinite(number)) decision[field] = Math.min(1, Math.max(0, number));
  }
  decision.candidates = sanitizeIntentDecisionStrings(
    value.candidates,
    INTENT_DECISION_MAX_CANDIDATES,
  ).filter(
    /** 丢弃分类器候选集合以外的任意字符串。 */
    (candidate) => INTENT_DECISION_OPERATIONS.includes(candidate),
  );
  decision.useActiveImage = Boolean(value.useActiveImage);
  const evidenceMessageIds = sanitizeIntentDecisionStrings(
    value.relevantMessageIds,
    INTENT_DECISION_MAX_EVIDENCE_MESSAGES,
  );
  decision.relevantMessageIds = [];
  for (const messageId of evidenceMessageIds) {
    const row = database
      .prepare("SELECT 1 FROM messages WHERE id = ? AND conversation_id = ?")
      .get(messageId, conversationId);
    if (row) decision.relevantMessageIds.push(messageId);
  }
  const contextVersion = value.contextVersion == null ? NaN : Number(value.contextVersion);
  decision.contextVersion = Number.isInteger(contextVersion) && contextVersion >= 0
    ? contextVersion
    : null;
  decision.contextTruncated = Boolean(value.contextTruncated);
  return Object.freeze(decision);
}

/** 保持顺序地过滤、去重并限制路由审计中的短字符串数组。 */
function sanitizeIntentDecisionStrings(values, limit) {
  const result = [];
  const seen = new Set();
  for (const value of Array.isArray(values) ? values : []) {
    const normalized = String(value || "").trim().slice(0, 160);
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    result.push(normalized);
    if (result.length >= limit) break;
  }
  return result;
}

/** 仅保留不含空白和控制字符的短标识，版本字段不得承载模型正文。 */
function sanitizeIntentDecisionIdentifier(value) {
  const normalized = String(value || "").trim();
  return /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,159}$/.test(normalized) ? normalized : null;
}

/** 将可选时间规范为 ISO 8601；无效值不进入可恢复执行事实。 */
function normalizeIsoTimestamp(value) {
  if (value == null || value === "") return null;
  const timestamp = typeof value === "number" ? value : Date.parse(String(value));
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : null;
}

/** 将可选标识去空后保存为字符串或 null。 */
function nullableString(value) {
  const normalized = String(value || "").trim();
  return normalized || null;
}

/** 从 Runtime 公开错误或普通错误读取稳定分类代码。 */
function readErrorCode(error) {
  return nullableString(error?.payload?.code || error?.code);
}

/** 校验并持久化一个与 Run 一对一的终态 AcceptanceResult。 */
function persistAcceptanceResult(database, run, acceptance, expectedStatus) {
  if (!acceptance || acceptance.status !== expectedStatus) {
    throw new ConversationStoreError("Acceptance result status is invalid", 500, "invalid_acceptance_result");
  }
  if (!acceptance.policy || !acceptance.policyVersion || !Array.isArray(acceptance.reasonCodes)) {
    throw new ConversationStoreError("Acceptance result is incomplete", 500, "invalid_acceptance_result");
  }
  const existing = database.prepare("SELECT * FROM acceptance_results WHERE run_id = ?").get(run.id);
  if (existing) {
    if (existing.status !== expectedStatus || existing.policy_version !== acceptance.policyVersion) {
      throw new ConversationStoreError("Acceptance result conflicts with existing fact", 409, "acceptance_result_conflict");
    }
    return mapAcceptanceResultRow(existing);
  }
  const evaluatedAt = normalizeIsoTimestamp(acceptance.evaluatedAt) || new Date().toISOString();
  database
    .prepare(
      `INSERT INTO acceptance_results (
        run_id, conversation_id, policy, policy_version, status,
        reason_codes_json, evidence_json, evaluated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      run.id,
      run.conversation_id,
      String(acceptance.policy),
      String(acceptance.policyVersion),
      expectedStatus,
      JSON.stringify(acceptance.reasonCodes),
      JSON.stringify(acceptance.evidence || {}),
      evaluatedAt,
    );
  if (expectedStatus === "accepted") {
    insertEvent(database, run.conversation_id, "acceptance.accepted", {
      runId: run.id,
      policy: acceptance.policy,
      policyVersion: acceptance.policyVersion,
      reasonCodes: acceptance.reasonCodes,
    });
  }
  return mapAcceptanceResultRow(database.prepare("SELECT * FROM acceptance_results WHERE run_id = ?").get(run.id));
}

/** 安全解析数据库 JSON 字段，异常时返回回退值。 */
function parseJson(value, fallback = null) {
  if (value == null || value === "") return fallback;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

/** 将 conversations 行转换为稳定的 camelCase API 结构。 */
function mapConversationRow(row) {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    userId: row.user_id,
    title: row.title,
    status: row.status,
    archivedAt: row.archived_at || null,
    version: Number(row.version),
    memoryVersion: Number(row.memory_version),
    summarizedThroughSeq: Number(row.summarized_through_seq),
    lastSeq: Number(row.next_seq),
    messageCount: Number(row.message_count ?? row.next_seq),
    memoryCount: Number(row.memory_count ?? 0),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/** 将 messages 行转换为 API 和模型可复用的消息结构。 */
function mapMessageRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    conversationId: row.conversation_id,
    seq: Number(row.seq),
    clientMessageId: row.client_message_id,
    runId: row.run_id || null,
    role: row.role,
    content: parseJson(row.content_json, ""),
    displayContent: row.display_content,
    status: row.status,
    usage: parseJson(row.usage_json),
    references: parseJson(row.references_json, []),
    createdAt: row.created_at,
  };
}

/** 将 runs 行转换为渠道可读取的 Run 状态。 */
function mapRunRow(row) {
  return {
    id: row.id,
    conversationId: row.conversation_id,
    requestId: row.request_id,
    sourceRunId: row.source_run_id || null,
    recoveryMode: row.recovery_mode || null,
    operation: row.operation || "conversation.chat",
    status: row.status,
    model: row.model,
    usage: parseJson(row.usage_json),
    contextManifest: parseJson(row.context_manifest_json),
    resilience: parseJson(row.resilience_json),
    error: row.error,
    errorCode: row.error_code || null,
    deadlineAt: row.deadline_at || null,
    chainTraceId: row.chain_trace_id || null,
    intentDecision: parseJson(row.intent_decision_json),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/** 将 acceptance_results 行映射为不包含模型候选正文的公开验收事实。 */
function mapAcceptanceResultRow(row) {
  return {
    policy: row.policy,
    policyVersion: row.policy_version,
    status: row.status,
    reasonCodes: parseJson(row.reason_codes_json, []),
    evidence: parseJson(row.evidence_json, {}),
    evaluatedAt: row.evaluated_at,
  };
}

/** 将 image_assets 行转换为不包含物理 storageKey 的公开资产引用。 */
function mapImageAssetRow(row) {
  return {
    type: "image_asset",
    assetId: row.id,
    conversationId: row.conversation_id,
    runId: row.run_id,
    version: Number(row.version),
    mediaType: row.media_type,
    sizeBytes: Number(row.size_bytes),
    width: Number(row.width),
    height: Number(row.height),
    sha256: row.sha256,
    source: row.source,
    status: row.status,
    createdAt: row.created_at,
    expiresAt: row.expires_at || null,
    url: `/api/runtime/conversations/${encodeURIComponent(row.conversation_id)}/image-assets/${encodeURIComponent(row.id)}/content`,
  };
}

/** 将 tool_calls 行转换为稳定的 camelCase ToolResult 审计结构。 */
function mapToolCallRow(row) {
  return {
    id: row.id,
    conversationId: row.conversation_id,
    runId: row.run_id,
    operationId: row.operation_id || null,
    toolCallId: row.tool_call_id,
    toolName: row.tool_name,
    status: row.status,
    input: parseJson(row.input_json, {}),
    output: parseJson(row.output_json),
    source: row.source_name || null,
    observedAt: row.observed_at || null,
    error: row.error_code
      ? {
          code: row.error_code,
          message: row.error_message || "工具执行失败。",
          retryable: Boolean(row.retryable),
        }
      : null,
    startedAt: row.started_at,
    updatedAt: row.updated_at,
  };
}

/** 将 operations 行映射为不包含外部原始响应正文的执行事实。 */
function mapOperationRow(row) {
  return {
    id: row.id,
    conversationId: row.conversation_id,
    runId: row.run_id,
    operationKey: row.operation_key,
    idempotencyKey: row.idempotency_key,
    kind: row.kind,
    toolName: row.tool_name || null,
    effect: row.effect,
    riskLevel: row.risk_level,
    policy: row.policy,
    policyVersion: row.policy_version,
    policyDecision: row.policy_decision,
    policyReasonCodes: parseJson(row.policy_reason_codes_json, []),
    status: row.status,
    input: parseJson(row.input_json, {}),
    attempt: Number(row.attempt),
    externalRequestId: row.external_request_id || null,
    result: parseJson(row.result_json),
    readback: parseJson(row.readback_json),
    error: row.error_code
      ? {
          code: row.error_code,
          message: row.error_message || "操作执行失败。",
          retryable: Boolean(row.retryable),
        }
      : null,
    startedAt: row.started_at || null,
    completedAt: row.completed_at || null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/** 将 run_leases 行映射为 Runtime 协调端口使用的稳定租约事实。 */
function mapRunLeaseRow(row) {
  return {
    runId: row.run_id,
    conversationId: row.conversation_id,
    ownerId: row.owner_id,
    fencingToken: Number(row.fencing_token),
    leaseExpiresAt: row.lease_expires_at,
    acquiredAt: row.acquired_at,
    releasedAt: row.released_at || null,
    updatedAt: row.updated_at,
  };
}

/** 将 memory_items 行恢复为带来源和生命周期的结构化记忆项。 */
function mapMemoryRow(row) {
  return {
    id: row.id,
    type: row.item_type,
    entity: row.entity,
    key: row.memory_key,
    value: parseJson(row.value_json),
    reason: row.reason,
    itemStatus: row.item_status,
    status: row.status,
    priority: row.priority,
    sourceMessageIds: parseJson(row.source_message_ids_json, []),
    updatedSeq: Number(row.updated_seq),
    supersededAtSeq: row.superseded_at_seq == null ? null : Number(row.superseded_at_seq),
    createdAt: row.created_at,
  };
}

/** 判断已映射记忆项是否仍为 active。 */
function isActiveMemoryRow(item) {
  return item.status === "active";
}

/** 将 episode_summaries 行转换为可检索的情节记忆。 */
function mapEpisodeRow(row) {
  return {
    id: row.id,
    fromSeq: Number(row.from_seq),
    toSeq: Number(row.to_seq),
    topic: row.topic,
    summary: row.summary,
    sourceMessageIds: parseJson(row.source_message_ids_json, []),
    createdAt: row.created_at,
  };
}

/** 将事件日志行转换为 SSE 载荷。 */
function mapEventRow(row) {
  return {
    id: Number(row.id),
    conversationId: row.conversation_id,
    type: row.event_type,
    payload: parseJson(row.payload_json, {}),
    createdAt: row.created_at,
  };
}
