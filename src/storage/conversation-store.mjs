import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";

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
  database.exec("PRAGMA foreign_keys = ON");
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
        .all(conversationId)
        .map(mapMessageRow);
      const memoryItems = database
        .prepare("SELECT * FROM memory_items WHERE conversation_id = ? ORDER BY updated_seq ASC, created_at ASC")
        .all(conversationId)
        .map(mapMemoryRow);
      const episodes = database
        .prepare("SELECT * FROM episode_summaries WHERE conversation_id = ? ORDER BY from_seq ASC")
        .all(conversationId)
        .map(mapEpisodeRow);
      const lastRunRow = database
        .prepare("SELECT * FROM runs WHERE conversation_id = ? AND status = 'completed' ORDER BY updated_at DESC LIMIT 1")
        .get(conversationId);
      const latestRunRow = database
        .prepare("SELECT * FROM runs WHERE conversation_id = ? ORDER BY updated_at DESC LIMIT 1")
        .get(conversationId);

      return {
        ...mapConversationRow(conversation),
        messageCount: messages.length,
        memoryCount: memoryItems.filter(isActiveMemoryRow).length,
        messages,
        memory: {
          version: Number(conversation.memory_version),
          summarizedThroughSeq: Number(conversation.summarized_through_seq),
          items: memoryItems,
          episodes,
        },
        lastRun: lastRunRow ? mapRunRow(lastRunRow) : null,
        latestRun: latestRunRow ? mapRunRow(latestRunRow) : null,
      };
    },

    /**
     * 幂等创建 Run 并先持久化用户消息；重复 requestId 返回已有 Run。
     *
     * @param {object} input - Run 和用户消息输入。
     * @returns {object} 新建或重放的 Run 状态。
     */
    startRun({ conversationId, requestId, clientMessageId, content, displayContent }) {
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

        const runId = randomUUID();
        const messageId = randomUUID();
        const seq = Number(conversation.next_seq) + 1;
        const now = new Date().toISOString();
        const title = conversation.next_seq === 0 ? buildConversationTitle(displayContent) : conversation.title;
        database
          .prepare(
            `INSERT INTO runs (id, conversation_id, request_id, status, created_at, updated_at)
             VALUES (?, ?, ?, 'running', ?, ?)`,
          )
          .run(runId, conversationId, requestId, now, now);
        database
          .prepare(
            `INSERT INTO messages (
              id, conversation_id, seq, client_message_id, run_id, role,
              content_json, display_content, status, created_at
            ) VALUES (?, ?, ?, ?, ?, 'user', ?, ?, 'committed', ?)`,
          )
          .run(messageId, conversationId, seq, clientMessageId, runId, JSON.stringify(content), displayContent, now);
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
        .prepare("SELECT * FROM messages WHERE conversation_id = ? AND seq > ? ORDER BY seq ASC")
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

/** 创建当前 V0.6 会话、Run、记忆和事件表。 */
function migrate(database) {
  database.exec(`
    CREATE TABLE IF NOT EXISTS conversations (
      id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      title TEXT NOT NULL,
      status TEXT NOT NULL CHECK(status IN ('active', 'closed')),
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
      user_message_id TEXT,
      assistant_message_id TEXT,
      status TEXT NOT NULL CHECK(status IN ('running', 'completed', 'failed')),
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
  `);
  ensureColumn(database, "runs", "resilience_json", "TEXT");
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

/** 将数据库 Run 行组合成可供 Runtime 重放的完整结果。 */
function buildRunResult(database, run, replayed) {
  const userMessage = run.user_message_id
    ? mapMessageRow(database.prepare("SELECT * FROM messages WHERE id = ?").get(run.user_message_id))
    : null;
  const assistantMessage = run.assistant_message_id
    ? mapMessageRow(database.prepare("SELECT * FROM messages WHERE id = ?").get(run.assistant_message_id))
    : null;
  return {
    run: mapRunRow(run),
    userMessage,
    assistantMessage,
    replayed,
  };
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
    createdAt: row.created_at,
  };
}

/** 将 runs 行转换为渠道可读取的 Run 状态。 */
function mapRunRow(row) {
  return {
    id: row.id,
    conversationId: row.conversation_id,
    requestId: row.request_id,
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
