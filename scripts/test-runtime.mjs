#!/usr/bin/env node
import assert from "node:assert/strict";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { createLiteLlmClient } from "../src/gateway/litellm-client.mjs";
import { createChatRuntime } from "../src/runtime/chat-runtime.mjs";
import { createConversationCoordinator } from "../src/runtime/conversation-coordinator.mjs";
import { createContextPlanner } from "../src/runtime/context-planner.mjs";
import { estimateMessagesTokens } from "../src/runtime/context-budget.mjs";
import { createMemoryManager, selectCompactionRange } from "../src/runtime/memory-manager.mjs";
import { ConversationStoreError, createConversationStore } from "../src/storage/conversation-store.mjs";

const contextOptions = {
  maxContextTokens: 800,
  reservedOutputTokens: 120,
  safetyTokens: 80,
  highWatermarkRatio: 0.75,
  lowWatermarkRatio: 0.45,
  hardWatermarkRatio: 0.9,
};

/**
 * 创建使用内存 SQLite 的完整 Runtime 测试装配。
 *
 * @param {object} [options] - 可选测试依赖。
 * @param {object} [options.gatewayClient] - 替换默认脚本模型的 Gateway。
 * @returns {object} 可供单元测试或 fixture runner 使用的 Runtime 装配。
 */
function createTestRuntime({ gatewayClient = createScriptedGateway() } = {}) {
  const store = createConversationStore({ databasePath: ":memory:" });
  const coordinator = createConversationCoordinator();
  const contextPlanner = createContextPlanner({
    store,
    gatewayClient,
    contextOptions,
    systemPrompt: "测试助手",
  });
  const memoryManager = createMemoryManager({ store, gatewayClient, contextOptions });
  const runtime = createChatRuntime({
    gatewayClient,
    contextOptions,
    store,
    coordinator,
    contextPlanner,
    memoryManager,
  });
  return { store, gatewayClient, contextPlanner, memoryManager, runtime };
}

/** 创建可复现结构化记忆提取和问答的脚本化 Gateway。 */
function createScriptedGateway() {
  return {
    model: "scripted-test-model",
    /** 返回与本地估算一致的确定性 token 数。 */
    async countTokens({ messages }) {
      return { tokens: estimateMessagesTokens(messages), source: "scripted", model: this.model };
    },
    /** 对结构化请求生成 MemoryDelta，对普通请求根据 active 记忆回答。 */
    async chatCompletions({ messages, responseFormat }) {
      if (responseFormat) return buildScriptedMemoryResponse(messages, this.model);
      const memoryText = messages
        .filter(isSystemMessage)
        .map(getMessageContent)
        .join("\n");
      const question = String(messages.at(-1)?.content || "");
      let content = "已收到";
      if (question.includes("当前项目最终使用什么数据库")) {
        content = memoryText.includes("current-project.database=PostgreSQL") ? "PostgreSQL" : "无法确认";
      }
      return {
        model: this.model,
        usage: { prompt_tokens: estimateMessagesTokens(messages), completion_tokens: 8 },
        choices: [{ message: { content } }],
      };
    },
  };
}

/** 判断消息是否为系统消息。 */
function isSystemMessage(message) {
  return message.role === "system";
}

/** 返回消息纯文本内容。 */
function getMessageContent(message) {
  return String(message.content || "");
}

/** 根据待压缩消息中的明确事实生成可验证 MemoryDelta。 */
function buildScriptedMemoryResponse(messages, model) {
  const prompt = String(messages.at(-1)?.content || "");
  const marker = "新增消息：";
  const sourceMessages = JSON.parse(prompt.slice(prompt.lastIndexOf(marker) + marker.length).trim());
  const delta = buildScriptedDelta(sourceMessages);
  return {
    model,
    usage: { prompt_tokens: estimateMessagesTokens(messages), completion_tokens: 80 },
    choices: [{ message: { content: JSON.stringify(delta) } }],
  };
}

/** 从脚本化测试消息提取可验证的事实、决策和任务。 */
function buildScriptedDelta(messages) {
  const upserts = [];
  const supersedes = [];
  for (const message of messages) {
    const text = String(message.content || "");
    if (text.includes("当前项目数据库使用 MySQL")) {
      upserts.push(memoryItem("fact", "current-project", "database", "MySQL", "", "high", message.id));
    }
    if (text.includes("更正：当前项目最终使用 PostgreSQL")) {
      supersedes.push({ type: "fact", entity: "current-project", key: "database", sourceMessageIds: [message.id] });
      upserts.push(memoryItem("fact", "current-project", "database", "PostgreSQL", "需要 pgvector", "critical", message.id));
      upserts.push(memoryItem("decision", "current-project", "database-choice", "PostgreSQL", "需要 pgvector", "high", message.id));
    }
    if (text.includes("Alpha 项目仍然使用 MySQL")) {
      upserts.push(memoryItem("fact", "alpha-project", "database", "MySQL", "", "normal", message.id));
    }
    if (text.includes("待办：补充 PostgreSQL 迁移脚本")) {
      upserts.push({
        ...memoryItem("task", "current-project", "migration-script", "补充 PostgreSQL 迁移脚本", "", "high", message.id),
        itemStatus: "pending",
      });
    }
  }
  return {
    upserts,
    supersedes,
    episode: {
      topic: "批次对话",
      summary: messages.map(getSourceContent).join("；").slice(0, 240),
      sourceMessageIds: messages.map(getSourceId),
    },
  };
}

/** 创建符合 MemoryDelta schema 的脚本化记忆项。 */
function memoryItem(type, entity, key, value, reason, priority, sourceMessageId) {
  return {
    type,
    entity,
    key,
    value,
    reason,
    itemStatus: "active",
    priority,
    sourceMessageIds: [sourceMessageId],
  };
}

/** 返回提取源消息正文。 */
function getSourceContent(message) {
  return String(message.content || "");
}

/** 返回提取源消息 ID。 */
function getSourceId(message) {
  return message.id;
}

/** 使用稳定幂等 ID 执行一次测试 Run。 */
async function run(runtime, conversationId, index, message) {
  return runtime.runConversation(conversationId, {
    requestId: `request-${index}`,
    clientMessageId: `client-${index}`,
    message,
    imageUrls: [],
    documentUrls: [],
  });
}

const isDirectExecution = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isDirectExecution) {
// 验证会话隔离、幂等重放和服务端消息事实源。
test("conversation runs are persisted, isolated, and idempotent", async () => {
  const fixture = createTestRuntime();
  const first = fixture.runtime.createConversation();
  const second = fixture.runtime.createConversation();
  const response = await run(fixture.runtime, first.id, 1, "第一会话");
  const replay = await run(fixture.runtime, first.id, 1, "第一会话");

  assert.equal(response.replayed, false);
  assert.equal(replay.replayed, true);
  assert.equal(fixture.runtime.getConversation(first.id).messages.length, 2);
  assert.equal(fixture.runtime.getConversation(second.id).messages.length, 0);
  fixture.store.close();
});

// 验证同一会话的并发 Run 经过 Coordinator 后保持完整轮次顺序。
test("concurrent runs in one conversation are serialized", async () => {
  const fixture = createTestRuntime();
  const conversation = fixture.runtime.createConversation();
  await Promise.all([
    run(fixture.runtime, conversation.id, 1, "第一条并发输入"),
    run(fixture.runtime, conversation.id, 2, "第二条并发输入"),
  ]);

  const detail = fixture.runtime.getConversation(conversation.id);
  assert.deepEqual(detail.messages.map(getMessageRole), ["user", "assistant", "user", "assistant"]);
  assert.deepEqual(detail.messages.map(getDisplayContent), ["第一条并发输入", "已收到", "第二条并发输入", "已收到"]);
  fixture.store.close();
});

// 验证用户纠正会废弃旧事实，Context Planner 只发送 active 最新值。
test("structured memory keeps the latest corrected fact", async () => {
  const fixture = createTestRuntime();
  const conversation = fixture.runtime.createConversation();
  await run(fixture.runtime, conversation.id, 1, "当前项目数据库使用 MySQL");
  await fixture.memoryManager.compactIfNeeded(conversation.id, { force: true });
  await run(fixture.runtime, conversation.id, 2, "更正：当前项目最终使用 PostgreSQL，因为需要 pgvector");
  await fixture.memoryManager.compactIfNeeded(conversation.id, { force: true });

  const detail = fixture.runtime.getConversation(conversation.id);
  const activeDatabase = detail.memory.items.find(isActiveCurrentDatabase);
  const supersededMysql = detail.memory.items.find(isSupersededMysql);
  assert.equal(activeDatabase.value, "PostgreSQL");
  assert.equal(activeDatabase.reason, "需要 pgvector");
  assert.ok(supersededMysql);
  assert.equal(detail.memoryCount, 2);
  fixture.store.close();
});

// 验证旧 memoryVersion 无法覆盖已提交的新记忆版本。
test("memory compare-and-set rejects stale compaction", async () => {
  const fixture = createTestRuntime();
  const conversation = fixture.runtime.createConversation();
  await run(fixture.runtime, conversation.id, 1, "当前项目数据库使用 MySQL");
  const first = await fixture.memoryManager.compactIfNeeded(conversation.id, { force: true });
  const stale = fixture.store.applyMemoryDelta({
    conversationId: conversation.id,
    expectedVersion: 0,
    expectedThroughSeq: 0,
    nextThroughSeq: 2,
    delta: { upserts: [], supersedes: [], episode: null },
    usage: null,
    model: "stale",
    promptVersion: "stale",
  });
  assert.equal(first.status, "compacted");
  assert.equal(stale.applied, false);
  fixture.store.close();
});

// 验证高低水位选择连续旧轮次并保留最近上下文。
test("compaction range preserves a recent low-watermark window", () => {
  const messages = [
    { role: "user", content: "a".repeat(80) },
    { role: "assistant", content: "b".repeat(80) },
    { role: "user", content: "c".repeat(80) },
    { role: "assistant", content: "d".repeat(80) },
  ];
  const selected = selectCompactionRange(messages, 90);
  assert.equal(selected.length, 2);
});

// 验证结束会话后新 Run 在存储边界被拒绝。
test("closed conversations reject new runs", async () => {
  const fixture = createTestRuntime();
  const conversation = fixture.runtime.createConversation();
  await run(fixture.runtime, conversation.id, 1, "当前项目数据库使用 MySQL");
  const closed = await fixture.runtime.closeConversation(conversation.id);
  assert.equal(closed.conversation.memoryCount, 1);
  await assert.rejects(
    run(fixture.runtime, conversation.id, 2, "结束后消息"),
    isConversationClosedError,
  );
  fixture.store.close();
});

// 验证 Gateway 客户端字段映射由独立单元测试环境覆盖导入边界。
test("gateway client factory remains importable", () => {
  const client = createLiteLlmClient({ baseUrl: "http://localhost:4000", model: "chat-default", apiKey: "test" });
  assert.equal(client.model, "chat-default");
});
}

export { createScriptedGateway, createTestRuntime, run };

/** 判断是否为当前项目 active 数据库事实。 */
function isActiveCurrentDatabase(item) {
  return item.status === "active" && item.entity === "current-project" && item.key === "database";
}

/** 判断是否为已废弃的 MySQL 事实。 */
function isSupersededMysql(item) {
  return item.status === "superseded" && item.value === "MySQL";
}

/** 判断异常是否为关闭会话拒绝新 Run。 */
function isConversationClosedError(error) {
  return error instanceof ConversationStoreError && error.code === "conversation_closed";
}

/** 返回持久化消息角色，供顺序断言复用。 */
function getMessageRole(message) {
  return message.role;
}

/** 返回持久化消息展示内容，供顺序断言复用。 */
function getDisplayContent(message) {
  return message.displayContent;
}
