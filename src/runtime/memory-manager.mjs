import {
  calculateContextThresholds,
  estimateMessagesTokens,
  normalizeContextOptions,
} from "./context-budget.mjs";

const MEMORY_PROMPT_VERSION = "structured-memory-v1";
const ALLOWED_TYPES = new Set(["goal", "constraint", "preference", "fact", "decision", "task"]);
const ALLOWED_PRIORITIES = new Set(["critical", "high", "normal"]);

/**
 * 创建结构化记忆提取、压缩调度、乐观锁重试和最终 checkpoint 管理器。
 *
 * @param {object} dependencies - Memory Manager 依赖。
 * @returns {object} Memory Manager API。
 */
export function createMemoryManager({ store, gatewayClient, contextOptions, memoryOptions = {}, onError = ignoreError }) {
  const options = normalizeContextOptions(contextOptions);
  const pending = new Map();
  const maxCompletionTokens = memoryOptions.maxCompletionTokens || 1200;

  return {
    /**
     * 根据 token 高低水位压缩连续旧消息；force 时处理全部可用消息。
     *
     * @param {string} conversationId - 会话 ID。
     * @param {object} [runOptions] - 强制模式、排除消息和重试配置。
     * @returns {Promise<object>} 压缩状态和最新水位。
     */
    async compactIfNeeded(conversationId, runOptions = {}) {
      const maxAttempts = runOptions.maxAttempts || 3;
      for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
        const snapshot = store.getCompactionSnapshot(conversationId);
        const eligibleMessages = [];
        for (const message of snapshot.messages) {
          if (!runOptions.excludeSeq || message.seq < runOptions.excludeSeq) eligibleMessages.push(message);
        }
        if (eligibleMessages.length === 0) return { status: "skipped", reason: "no-messages" };

        const thresholds = calculateContextThresholds(options, runOptions.fixedInputTokens || 0);
        const dynamicTokens = await countMessages(gatewayClient, eligibleMessages, runOptions.resilienceContext);
        if (!runOptions.force && dynamicTokens < thresholds.high) {
          return { status: "skipped", reason: "below-high-watermark", dynamicTokens, thresholds };
        }

        const selected = runOptions.force
          ? eligibleMessages
          : selectCompactionRange(eligibleMessages, thresholds.low);
        if (selected.length === 0) return { status: "skipped", reason: "no-complete-range" };

        const deltaResult = await extractMemoryDelta({
          gatewayClient,
          memoryItems: snapshot.memoryItems,
          messages: selected,
          maxCompletionTokens,
          resilienceContext: runOptions.resilienceContext,
        });
        const nextThroughSeq = selected[selected.length - 1].seq;
        const applyResult = store.applyMemoryDelta({
          conversationId,
          expectedVersion: snapshot.conversation.memoryVersion,
          expectedThroughSeq: snapshot.conversation.summarizedThroughSeq,
          nextThroughSeq,
          delta: deltaResult.delta,
          usage: deltaResult.usage,
          model: deltaResult.model,
          promptVersion: MEMORY_PROMPT_VERSION,
        });
        if (applyResult.applied) {
          return {
            status: "compacted",
            fromSeq: snapshot.conversation.summarizedThroughSeq + 1,
            toSeq: nextThroughSeq,
            memoryVersion: applyResult.conversation.memoryVersion,
          };
        }
      }
      return { status: "conflict", reason: "memory-version-changed" };
    },

    /** 将普通压缩任务按 conversationId 去重后放入后台 Promise 队列。 */
    schedule(conversationId, runOptions = {}) {
      if (pending.has(conversationId)) return pending.get(conversationId);
      /** 任务结束后释放当前会话的后台去重槽位。 */
      function releasePendingSlot() {
        pending.delete(conversationId);
      }
      const task = this.compactIfNeeded(conversationId, runOptions)
        .catch(onError)
        .finally(releasePendingSlot);
      pending.set(conversationId, task);
      return task;
    },

    /** 等待指定会话当前后台压缩结束，便于关闭会话和测试确定性验证。 */
    async flush(conversationId) {
      if (pending.has(conversationId)) await pending.get(conversationId);
    },
  };
}

/**
 * 从最老消息选择连续压缩区间，使保留的最近消息不超过低水位。
 *
 * @param {Array<object>} messages - 水位之后的连续消息。
 * @param {number} lowTokenBudget - 希望保留的最近消息 token 上限。
 * @returns {Array<object>} 待压缩的完整连续消息。
 */
export function selectCompactionRange(messages, lowTokenBudget) {
  let retainedTokens = 0;
  let cutIndex = messages.length;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const tokens = estimateMessagesTokens([{ role: messages[index].role, content: messages[index].content }]);
    if (retainedTokens + tokens > lowTokenBudget) break;
    retainedTokens += tokens;
    cutIndex = index;
  }

  if (cutIndex === 0) return [];
  if (messages[cutIndex - 1]?.role === "user") cutIndex -= 1;
  return messages.slice(0, Math.max(0, cutIndex));
}

/** 调用 AI SDK 结构化输出提取 MemoryDelta，并在 provider 不兼容时退回纯 JSON 提示。 */
async function extractMemoryDelta({ gatewayClient, memoryItems, messages, maxCompletionTokens, resilienceContext }) {
  const prompt = buildExtractionPrompt(memoryItems, messages);
  const request = {
    messages: [
      {
        role: "system",
        content:
          "你是 Agent Runtime 的结构化记忆提取器。只输出符合 schema 的 JSON，不解释，不编造，不修改精确值。",
      },
      { role: "user", content: prompt },
    ],
    temperature: 0.1,
    maxCompletionTokens,
    outputSchema: buildMemoryOutputSchema(),
    resilienceContext,
    operation: "memory.compact",
  };

  let data;
  try {
    data = await gatewayClient.chatCompletions(request);
  } catch (error) {
    if (error?.status !== 400) throw error;
    data = await gatewayClient.chatCompletions({
      ...request,
      outputSchema: undefined,
    });
  }
  const content = data?.choices?.[0]?.message?.content || "";
  return {
    delta: normalizeMemoryDelta(data?.output ?? parseModelJson(content), messages),
    usage: data?.usage || null,
    model: data?.model || gatewayClient.model,
  };
}

/** 构造包含已有 active 记忆和固定来源消息 ID 的提取提示。 */
function buildExtractionPrompt(memoryItems, messages) {
  const existing = [];
  for (const item of memoryItems) {
    existing.push({
      type: item.type,
      entity: item.entity,
      key: item.key,
      value: item.value,
      reason: item.reason,
      itemStatus: item.itemStatus,
    });
  }
  const source = [];
  for (const message of messages) {
    source.push({
      id: message.id,
      seq: message.seq,
      role: message.role,
      content: message.displayContent,
    });
  }
  return [
    "从新增消息提取长期有效的目标、约束、偏好、事实、决策和任务。",
    "明确纠正时在 supersedes 中标记旧键，并在 upserts 中写入最新值。",
    "临时寒暄、重复内容和模型猜测不得进入记忆。sourceMessageIds 只能使用给定消息 ID。",
    "Episode 只概括本批消息发生的事情，不代替结构化事实。",
    `已有 active 记忆：${JSON.stringify(existing)}`,
    `新增消息：${JSON.stringify(source)}`,
  ].join("\n\n");
}

/** 定义交给 AI SDK `Output.object` 的 MemoryDelta JSON Schema 和模型提示元数据。 */
function buildMemoryOutputSchema() {
  const itemProperties = {
    type: { type: "string", enum: [...ALLOWED_TYPES] },
    entity: { type: "string" },
    key: { type: "string" },
  };
  return {
    name: "conversation_memory_delta",
    description: "长期会话记忆的新增、纠正和 Episode 摘要",
    schema: {
      type: "object",
      additionalProperties: false,
      required: ["upserts", "supersedes", "episode"],
      properties: {
        upserts: {
          type: "array",
          items: {
            type: "object",
            additionalProperties: false,
            required: ["type", "entity", "key", "value", "reason", "itemStatus", "priority", "sourceMessageIds"],
            properties: {
              ...itemProperties,
              value: { type: "string" },
              reason: { type: "string" },
              itemStatus: { type: "string" },
              priority: { type: "string", enum: [...ALLOWED_PRIORITIES] },
              sourceMessageIds: { type: "array", items: { type: "string" } },
            },
          },
        },
        supersedes: {
          type: "array",
          items: {
            type: "object",
            additionalProperties: false,
            required: ["type", "entity", "key", "sourceMessageIds"],
            properties: {
              ...itemProperties,
              sourceMessageIds: { type: "array", items: { type: "string" } },
            },
          },
        },
        episode: {
          anyOf: [
            { type: "null" },
            {
              type: "object",
              additionalProperties: false,
              required: ["topic", "summary", "sourceMessageIds"],
              properties: {
                topic: { type: "string" },
                summary: { type: "string" },
                sourceMessageIds: { type: "array", items: { type: "string" } },
              },
            },
          ],
        },
      },
    },
  };
}

/** 去除 Markdown 代码围栏并解析模型 JSON。 */
function parseModelJson(content) {
  const normalized = String(content || "")
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/, "");
  return JSON.parse(normalized);
}

/** 校验 MemoryDelta 字段、去重键并强制来源 ID 可追溯。 */
function normalizeMemoryDelta(value, messages) {
  const sourceIds = new Set(messages.map(getMessageId));
  const fallbackSources = messages.map(getMessageId);
  const upsertMap = new Map();
  for (const raw of Array.isArray(value?.upserts) ? value.upserts : []) {
    const item = normalizeUpsert(raw, sourceIds, fallbackSources);
    if (item) upsertMap.set(memoryIdentity(item), item);
  }
  const supersedeMap = new Map();
  for (const raw of Array.isArray(value?.supersedes) ? value.supersedes : []) {
    const item = normalizeSupersede(raw, sourceIds, fallbackSources);
    if (item) supersedeMap.set(memoryIdentity(item), item);
  }
  return {
    upserts: [...upsertMap.values()],
    supersedes: [...supersedeMap.values()],
    episode: normalizeEpisode(value?.episode, sourceIds, fallbackSources),
  };
}

/** 校验并标准化新增或更新记忆项。 */
function normalizeUpsert(raw, sourceIds, fallbackSources) {
  const base = normalizeIdentity(raw);
  if (!base) return null;
  return {
    ...base,
    value: String(raw.value ?? ""),
    reason: String(raw.reason || ""),
    itemStatus: String(raw.itemStatus || "active"),
    priority: ALLOWED_PRIORITIES.has(raw.priority) ? raw.priority : "normal",
    sourceMessageIds: normalizeSources(raw.sourceMessageIds, sourceIds, fallbackSources),
  };
}

/** 校验并标准化待废弃记忆键。 */
function normalizeSupersede(raw, sourceIds, fallbackSources) {
  const base = normalizeIdentity(raw);
  if (!base) return null;
  return {
    ...base,
    sourceMessageIds: normalizeSources(raw.sourceMessageIds, sourceIds, fallbackSources),
  };
}

/** 校验记忆类型、实体和键，非法项直接忽略。 */
function normalizeIdentity(raw) {
  const type = String(raw?.type || "");
  const entity = String(raw?.entity || "").trim();
  const key = String(raw?.key || "").trim();
  if (!ALLOWED_TYPES.has(type) || !entity || !key) return null;
  return { type, entity, key };
}

/** 标准化 Episode 并确保至少包含当前批次来源。 */
function normalizeEpisode(raw, sourceIds, fallbackSources) {
  if (!raw || !String(raw.topic || "").trim() || !String(raw.summary || "").trim()) return null;
  return {
    topic: String(raw.topic).trim(),
    summary: String(raw.summary).trim(),
    sourceMessageIds: normalizeSources(raw.sourceMessageIds, sourceIds, fallbackSources),
  };
}

/** 过滤模型伪造来源；完全缺失时回退到本批全部消息。 */
function normalizeSources(values, allowed, fallback) {
  const result = [];
  for (const value of Array.isArray(values) ? values : []) {
    if (allowed.has(value) && !result.includes(value)) result.push(value);
  }
  return result.length > 0 ? result : [...fallback];
}

/** 返回结构化记忆的稳定合并键。 */
function memoryIdentity(item) {
  return `${item.type}\u0000${item.entity}\u0000${item.key}`;
}

/** 返回消息 ID，供 map/filter 操作复用。 */
function getMessageId(message) {
  return message.id;
}

/** 优先使用模型网关 token counter，失败时回退本地估算。 */
async function countMessages(gatewayClient, messages, resilienceContext) {
  const modelMessages = [];
  for (const message of messages) {
    modelMessages.push({ role: message.role, content: message.content });
  }
  if (typeof gatewayClient?.countTokens === "function") {
    try {
      const result = await gatewayClient.countTokens({
        messages: modelMessages,
        deadlineAt: resilienceContext?.deadlineAt,
      });
      if (Number.isFinite(result?.tokens)) return result.tokens;
    } catch {
      // 网关计数是优化能力，失败不得阻断上下文管理。
    }
  }
  return estimateMessagesTokens(modelMessages);
}

/** 默认吞掉后台压缩异常；同步路径仍会把异常返回给调用方。 */
function ignoreError() {}
