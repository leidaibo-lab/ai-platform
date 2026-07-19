import {
  calculateContextThresholds,
  estimateMessageTokens,
  estimateMessagesTokens,
  normalizeContextOptions,
} from "./context-budget.mjs";

const PRIORITY_WEIGHT = { critical: 300, high: 200, normal: 100 };

/**
 * 创建负责上下文候选评分、预算分桶、装箱和可解释清单的 Context Planner。
 *
 * @param {object} dependencies - Planner 依赖。
 * @param {object} dependencies.store - Conversation Store。
 * @param {object} dependencies.gatewayClient - 提供可选精确 token 计数的模型网关客户端。
 * @param {object} dependencies.contextOptions - 上下文预算策略。
 * @param {string} dependencies.systemPrompt - 当前 Agent 系统规则。
 * @returns {{plan: Function}} Context Planner API。
 */
export function createContextPlanner({ store, gatewayClient, contextOptions, systemPrompt }) {
  const options = normalizeContextOptions(contextOptions);

  return {
    /**
     * 为一次 Run 选择 active 记忆、相关 Episode 和最近完整历史，并生成 Context Manifest。
     *
     * @param {object} input - 当前会话和用户消息。
     * @returns {Promise<object>} 模型消息、预算状态和可解释清单。
     */
    async plan({ conversationId, currentMessageId, currentContent, currentDisplayContent }) {
      const snapshot = store.getContextSnapshot(conversationId);
      let currentMessage = null;
      for (const message of snapshot.messages) {
        if (message.id === currentMessageId) currentMessage = message;
      }
      if (!currentMessage) throw new Error("Current message is missing from conversation store");

      const systemMessage = { role: "system", content: systemPrompt };
      const userMessage = { role: "user", content: currentContent };
      const fixedTokens = estimateMessagesTokens([systemMessage, userMessage]);
      const thresholds = calculateContextThresholds(options, fixedTokens);
      const query = String(currentDisplayContent || "").toLowerCase();
      const memoryCandidates = rankMemory(snapshot.memoryItems, query);
      const episodeCandidates = rankEpisodes(snapshot.episodes, query);
      const historyCandidates = [];
      for (const message of snapshot.messages) {
        if (message.seq > snapshot.conversation.summarizedThroughSeq && message.seq < currentMessage.seq) {
          historyCandidates.push(message);
        }
      }

      const memoryBudget = Math.floor(thresholds.dynamicBudget * 0.35);
      const episodeBudget = Math.floor(thresholds.dynamicBudget * 0.2);
      const selectedMemory = takeMemoryWithinBudget(memoryCandidates, memoryBudget);
      const selectedEpisodes = takeEpisodesWithinBudget(episodeCandidates, episodeBudget);
      const structuralTokens = estimateMessagesTokens([
        buildMemoryMessage(selectedMemory),
        buildEpisodeMessage(selectedEpisodes),
      ].filter(Boolean));
      const historyBudget = Math.max(0, thresholds.dynamicBudget - structuralTokens);
      const selectedHistory = takeRecentMessagesWithinBudget(historyCandidates, historyBudget);
      const messages = [
        systemMessage,
        ...(selectedMemory.length > 0 ? [buildMemoryMessage(selectedMemory)] : []),
        ...(selectedEpisodes.length > 0 ? [buildEpisodeMessage(selectedEpisodes)] : []),
        ...selectedHistory.map(toModelMessage),
        userMessage,
      ];
      const estimatedTokens = estimateMessagesTokens(messages);
      const gatewayCount = await countWithGateway(gatewayClient, messages);
      const dynamicTokens = estimateMessagesTokens(historyCandidates.map(toModelMessage));

      return {
        messages,
        manifest: {
          budget: thresholds.inputBudget,
          estimatedTokens,
          countedTokens: gatewayCount?.tokens ?? estimatedTokens,
          tokenCounter: gatewayCount?.source || "local-estimate",
          dynamicTokens,
          watermarks: { high: thresholds.high, low: thresholds.low, hard: thresholds.hard },
          selected: {
            memoryItemIds: selectedMemory.map(getId),
            episodeIds: selectedEpisodes.map(getId),
            historyMessageIds: selectedHistory.map(getId),
          },
          excluded: {
            memoryItemIds: differenceIds(memoryCandidates, selectedMemory),
            episodeIds: differenceIds(episodeCandidates, selectedEpisodes),
            historyMessageIds: differenceIds(historyCandidates, selectedHistory),
          },
          hardLimitReached: dynamicTokens >= thresholds.hard,
          highWatermarkReached: dynamicTokens >= thresholds.high,
        },
      };
    },
  };
}

/** 按业务优先级和当前问题相关性排序 active 记忆。 */
function rankMemory(items, query) {
  const ranked = [];
  for (const item of items) {
    ranked.push({ ...item, score: (PRIORITY_WEIGHT[item.priority] || 0) + relevanceScore(item, query) });
  }
  return ranked.sort(compareScoreDescending);
}

/** 按当前问题相关性和时间新鲜度排序 Episode。 */
function rankEpisodes(episodes, query) {
  const ranked = [];
  for (const episode of episodes) {
    ranked.push({ ...episode, score: relevanceScore(episode, query) + episode.toSeq });
  }
  return ranked.sort(compareScoreDescending);
}

/** 按预计算 score 从高到低排序候选。 */
function compareScoreDescending(left, right) {
  return right.score - left.score;
}

/** 计算候选字段出现在当前问题中的轻量词法相关性。 */
function relevanceScore(candidate, query) {
  if (!query) return 0;
  const fields = [candidate.entity, candidate.key, candidate.value, candidate.reason, candidate.topic, candidate.summary];
  let score = 0;
  for (const field of fields) {
    const text = typeof field === "string" ? field : JSON.stringify(field ?? "");
    if (text && query.includes(text.toLowerCase())) score += 80;
  }
  return score;
}

/** 在记忆分桶预算内选择完整记忆项。 */
function takeMemoryWithinBudget(items, budget) {
  const selected = [];
  let used = 0;
  for (const item of items) {
    const tokens = estimateMessageTokens({ role: "system", content: renderMemoryItem(item) });
    if (used + tokens > budget) continue;
    selected.push(item);
    used += tokens;
  }
  return selected;
}

/** 在 Episode 分桶预算内选择完整历史片段。 */
function takeEpisodesWithinBudget(episodes, budget) {
  const selected = [];
  let used = 0;
  for (const episode of episodes) {
    const tokens = estimateMessageTokens({ role: "system", content: renderEpisode(episode) });
    if (used + tokens > budget) continue;
    selected.push(episode);
    used += tokens;
  }
  return selected;
}

/** 从最新消息向前装入预算，同时保持最终消息顺序。 */
function takeRecentMessagesWithinBudget(messages, budget) {
  const selected = [];
  let used = 0;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    const tokens = estimateMessageTokens(toModelMessage(message));
    if (used + tokens > budget) continue;
    selected.unshift(message);
    used += tokens;
  }
  return selected;
}

/** 将 active 记忆组合成独立系统消息。 */
function buildMemoryMessage(items) {
  if (!items || items.length === 0) return null;
  return {
    role: "system",
    content: ["会话结构化记忆（只使用 active 条目，用户最新纠正优先）：", ...items.map(renderMemoryItem)].join("\n"),
  };
}

/** 将相关 Episode 组合成独立系统消息。 */
function buildEpisodeMessage(episodes) {
  if (!episodes || episodes.length === 0) return null;
  return {
    role: "system",
    content: ["与当前问题相关的历史片段：", ...episodes.map(renderEpisode)].join("\n"),
  };
}

/** 将单条结构化记忆渲染为稳定、紧凑、可读的提示文本。 */
function renderMemoryItem(item) {
  const value = typeof item.value === "string" ? item.value : JSON.stringify(item.value);
  const reason = item.reason ? `；原因=${item.reason}` : "";
  const state = item.itemStatus && item.itemStatus !== "active" ? `；状态=${item.itemStatus}` : "";
  return `- [${item.type}/${item.priority}] ${item.entity}.${item.key}=${value}${reason}${state}`;
}

/** 将 Episode 渲染为带消息区间的历史提示文本。 */
function renderEpisode(episode) {
  return `- [消息 ${episode.fromSeq}-${episode.toSeq}] ${episode.topic}：${episode.summary}`;
}

/** 将存储消息转换为 OpenAI-compatible user/assistant 消息。 */
function toModelMessage(message) {
  return { role: message.role, content: message.content };
}

/** 尝试使用模型网关的实际路由 tokenizer；不可用时返回 null。 */
async function countWithGateway(gatewayClient, messages) {
  if (typeof gatewayClient?.countTokens !== "function") return null;
  try {
    return await gatewayClient.countTokens({ messages });
  } catch {
    return null;
  }
}

/** 返回候选实体的稳定 ID。 */
function getId(item) {
  return item.id;
}

/** 返回全集里未入选的候选 ID。 */
function differenceIds(all, selected) {
  const selectedIds = new Set(selected.map(getId));
  const result = [];
  for (const item of all) {
    if (!selectedIds.has(item.id)) result.push(item.id);
  }
  return result;
}
