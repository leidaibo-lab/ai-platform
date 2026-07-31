import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";

const RECOVERY_SOURCE_STATUS = Object.freeze({
  retry: "failed",
  regenerate: "completed",
  continue: "cancelled",
});

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
export function createConversationStore({ databasePath }) {
  if (databasePath !== ":memory:") mkdirSync(dirname(databasePath), { recursive: true });
  const database = new DatabaseSync(databasePath);
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
        lastRun: lastRunRow ? mapRunWithToolCalls(database, lastRunRow) : null,
        latestRun: latestRunRow ? mapRunWithToolCalls(database, latestRunRow) : null,
      };
    },

    /** 原子更新会话标题或独立归档状态，不改变 active/closed 生命周期。 */
    updateConversation(conversationId, { title, archived } = {}) {
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
    }) {
      // Run、用户消息、序号和事件必须在同一事务创建。
      return withTransaction(database, () => {
        const existing = database
          .prepare("SELECT * FROM runs WHERE conversation_id = ? AND request_id = ?")
          .get(conversationId, requestId);
        if (existing) return buildRunResult(database, existing, true);

        const conversation = getConversationOrThrow(database, conversationId);
        if (conversation.status !== "active") {
          throw new ConversationStoreError("Conversation is closed", 409, "conversation_closed");
        }
        const duplicateMessage = database
          .prepare("SELECT id FROM messages WHERE conversation_id = ? AND client_message_id = ?")
          .get(conversationId, clientMessageId);
        if (duplicateMessage) {
          throw new ConversationStoreError("clientMessageId has already been used", 409, "duplicate_client_message");
        }
        validateRecoverySource(database, conversationId, sourceRunId, recoveryMode);

        const runId = randomUUID();
        const messageId = randomUUID();
        const seq = Number(conversation.next_seq) + 1;
        const now = new Date().toISOString();
        const title = conversation.next_seq === 0 ? buildConversationTitle(displayContent) : conversation.title;
        database
          .prepare(
            `INSERT INTO runs (
              id, conversation_id, request_id, source_run_id, recovery_mode,
              operation, status, model, created_at, updated_at
             ) VALUES (?, ?, ?, ?, ?, ?, 'running', ?, ?, ?)`,
          )
          .run(runId, conversationId, requestId, sourceRunId, recoveryMode, operation, model, now, now);
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
        insertEvent(database, conversationId, "message.created", { messageId, seq, role: "user" });
        return buildRunResult(database, database.prepare("SELECT * FROM runs WHERE id = ?").get(runId), false);
      });
    },

    /** 幂等登记一次模型生成的工具调用，并与当前 running Run 绑定。 */
    startToolCall({ conversationId, runId, toolCallId, toolName, input }) {
      return withTransaction(database, () => {
        const run = getRunOrThrow(database, runId);
        if (run.conversation_id !== conversationId || run.status !== "running") {
          throw new ConversationStoreError("Run is not active", 409, "run_not_active");
        }
        const existing = database
          .prepare("SELECT * FROM tool_calls WHERE run_id = ? AND tool_call_id = ?")
          .get(runId, toolCallId);
        if (existing) return { ...mapToolCallRow(existing), replayed: true };
        const id = randomUUID();
        const now = new Date().toISOString();
        database
          .prepare(
            `INSERT INTO tool_calls (
              id, conversation_id, run_id, tool_call_id, tool_name, status,
              input_json, started_at, updated_at
             ) VALUES (?, ?, ?, ?, ?, 'running', ?, ?, ?)`,
          )
          .run(id, conversationId, runId, toolCallId, toolName, JSON.stringify(input), now, now);
        insertEvent(database, conversationId, "tool.started", { runId, toolCallId, toolName });
        return { ...mapToolCallRow(database.prepare("SELECT * FROM tool_calls WHERE id = ?").get(id)), replayed: false };
      });
    },

    /** 将结构化 ToolResult、来源和数据时间原子保存为 completed 工具事实。 */
    completeToolCall({ runId, toolCallId, output, source = null, observedAt = null }) {
      return withTransaction(database, () => {
        const row = getToolCallOrThrow(database, runId, toolCallId);
        if (row.status === "completed") return mapToolCallRow(row);
        if (row.status !== "running") {
          throw new ConversationStoreError("Tool call is not active", 409, "tool_call_not_active");
        }
        const now = new Date().toISOString();
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
          toolCallId,
          toolName: row.tool_name,
          source,
          observedAt,
        });
        return mapToolCallRow(database.prepare("SELECT * FROM tool_calls WHERE id = ?").get(row.id));
      });
    },

    /** 以安全错误码和公开说明收口工具失败，不保存外部原始响应。 */
    failToolCall({ runId, toolCallId, code, message, retryable = false }) {
      return withTransaction(database, () => {
        const row = getToolCallOrThrow(database, runId, toolCallId);
        if (row.status !== "running") return mapToolCallRow(row);
        const now = new Date().toISOString();
        database
          .prepare(
            `UPDATE tool_calls
             SET status = 'failed', error_code = ?, error_message = ?, retryable = ?, updated_at = ?
             WHERE id = ?`,
          )
          .run(String(code || "tool_execution_failed"), String(message || "工具执行失败。"), retryable ? 1 : 0, now, row.id);
        insertEvent(database, row.conversation_id, "tool.failed", {
          runId,
          toolCallId,
          toolName: row.tool_name,
          code: String(code || "tool_execution_failed"),
          retryable: Boolean(retryable),
        });
        return mapToolCallRow(database.prepare("SELECT * FROM tool_calls WHERE id = ?").get(row.id));
      });
    },

    /** 按开始顺序返回一个 Run 的全部工具事实，供重放、API 和验收使用。 */
    listToolCalls(runId) {
      return listToolCallsForRun(database, runId);
    },

    /** 在同一事务中写入助手消息、usage、Context Manifest、韧性证据并完成 Run。 */
    completeRun({ runId, content, displayContent, usage, contextManifest, model, resilience }) {
      // 助手消息和完成状态必须在同一事务提交。
      return withTransaction(database, () => {
        const run = getRunOrThrow(database, runId);
        if (run.status === "completed") return buildRunResult(database, run, true);
        if (run.status !== "running") {
          throw new ConversationStoreError("Run is not active", 409, "run_not_active");
        }

        const conversation = getConversationOrThrow(database, run.conversation_id);
        const messageId = randomUUID();
        const seq = Number(conversation.next_seq) + 1;
        const now = new Date().toISOString();
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
    completeImageRun({ runId, assets, displayContent, usage, model, resilience }) {
      if (!Array.isArray(assets) || assets.length === 0) {
        throw new ConversationStoreError("Image Run requires at least one asset", 400, "image_asset_required");
      }
      return withTransaction(database, () => {
        const run = getRunOrThrow(database, runId);
        if (run.status === "completed") return buildRunResult(database, run, true);
        if (run.status !== "running" || run.operation !== "image.generate") {
          throw new ConversationStoreError("Run is not an active image generation", 409, "run_not_active");
        }

        const conversation = getConversationOrThrow(database, run.conversation_id);
        const messageId = randomUUID();
        const seq = Number(conversation.next_seq) + 1;
        const now = new Date().toISOString();
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
              ) VALUES (?, ?, ?, 1, ?, ?, ?, ?, ?, 'generated', 'available', ?, ?, NULL)`,
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
        insertEvent(database, run.conversation_id, "run.completed", { runId, messageId, seq, role: "assistant" });
        return buildRunResult(database, database.prepare("SELECT * FROM runs WHERE id = ?").get(runId), false);
      });
    },

    /** 读取当前会话拥有的可用图片资产及内部 storageKey，越权与缺失统一返回 404。 */
    readImageAsset(conversationId, assetId) {
      getConversationOrThrow(database, conversationId);
      const row = database
        .prepare("SELECT * FROM image_assets WHERE id = ? AND conversation_id = ? AND status = 'available'")
        .get(assetId, conversationId);
      if (!row || (row.expires_at && Date.parse(row.expires_at) <= Date.now())) {
        throw new ConversationStoreError("Image asset not found", 404, "image_asset_not_found");
      }
      return { asset: mapImageAssetRow(row), storageKey: row.storage_key };
    },

    /** 将模型调用失败记录到 Run，同时保留已经落库的用户消息。 */
    failRun(runId, error) {
      // 失败状态和事件必须在同一事务提交。
      return withTransaction(database, () => {
        const run = getRunOrThrow(database, runId);
        if (run.status !== "running") return buildRunResult(database, run, false);
        const now = new Date().toISOString();
        database
          .prepare("UPDATE runs SET status = 'failed', error = ?, resilience_json = ?, updated_at = ? WHERE id = ?")
          .run(String(error?.message || error || "Run failed"), jsonOrNull(error?.resilience), now, runId);
        insertEvent(database, run.conversation_id, "run.failed", { runId });
        return buildRunResult(database, database.prepare("SELECT * FROM runs WHERE id = ?").get(runId), false);
      });
    },

    /**
     * 原子取消指定会话中的运行中 Run，并按需持久化一条中断助手消息。
     *
     * @param {object} input - 取消目标和已交付的部分结果。
     * @returns {object} 当前终止状态；重复取消或完成竞态不会改写既有事实。
     */
    cancelRun({ conversationId, runId, partialContent = "", contextManifest, model, resilience }) {
      return withTransaction(database, () => {
        const run = getRunOrThrow(database, runId);
        if (run.conversation_id !== conversationId) {
          throw new ConversationStoreError("Run not found", 404, "run_not_found");
        }
        if (run.status !== "running") return buildRunResult(database, run, true);

        const text = String(partialContent || "");
        const conversation = getConversationOrThrow(database, conversationId);
        const now = new Date().toISOString();
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
      CREATE TABLE IF NOT EXISTS image_assets (
      id TEXT PRIMARY KEY,
      conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
      run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
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

/** 判断 PRAGMA 表信息行是否表示 status 列。 */
function isStatusColumn(column) {
  return column.name === "status";
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

/** 校验恢复来源属于当前会话且终止状态与恢复模式匹配。 */
function validateRecoverySource(database, conversationId, sourceRunId, recoveryMode) {
  if (!sourceRunId && !recoveryMode) return;
  const expectedStatus = RECOVERY_SOURCE_STATUS[recoveryMode];
  const source = sourceRunId ? database.prepare("SELECT * FROM runs WHERE id = ? AND conversation_id = ?").get(sourceRunId, conversationId) : null;
  if (!source || !expectedStatus || source.status !== expectedStatus) {
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
    artifacts: listImageAssetsForRun(database, run.id),
    replayed,
  };
}

/** 为会话详情中的 Run 附加已持久化工具事实和图片产物。 */
function mapRunWithToolCalls(database, row) {
  return {
    ...mapRunRow(row),
    toolCalls: listToolCallsForRun(database, row.id),
    artifacts: listImageAssetsForRun(database, row.id),
  };
}

/** 查询并映射一个 Run 的全部工具调用。 */
function listToolCallsForRun(database, runId) {
  return database
    .prepare("SELECT * FROM tool_calls WHERE run_id = ? ORDER BY started_at ASC, rowid ASC")
    .all(runId)
    .map(mapToolCallRow);
}

/** 查询一个 Run 已完成的全部图片资产引用。 */
function listImageAssetsForRun(database, runId) {
  return database
    .prepare("SELECT * FROM image_assets WHERE run_id = ? AND status = 'available' ORDER BY created_at ASC, rowid ASC")
    .all(runId)
    .map(mapImageAssetRow);
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
  return { ...message, artifacts };
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
    runId: row.run_id,
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
    createdAt: row.created_at,
    updatedAt: row.updated_at,
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
