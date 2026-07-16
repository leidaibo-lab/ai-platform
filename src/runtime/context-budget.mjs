const DEFAULT_CONTEXT_OPTIONS = {
  maxContextTokens: 12000,
  reservedOutputTokens: 2000,
  maxHistoryMessageTokens: 1200,
  maxSummaryTokens: 1600,
};

/**
 * 按上下文预算组合系统提示、摘要、近期历史和当前消息。
 *
 * @param {object} input - 消息构造输入。
 * @param {string} input.summary - 已有对话摘要。
 * @param {Array<object>} input.history - 归一化后的历史消息。
 * @param {string|Array<object>} input.content - 当前用户消息内容。
 * @param {string} input.systemPrompt - Runtime 系统提示。
 * @param {object} input.contextOptions - 上下文预算配置。
 * @returns {{messages: Array<object>, contextTokens: number, historySent: number}} 预算内消息及估算结果。
 */
export function buildMessagesWithBudget({ summary, history, content, systemPrompt, contextOptions }) {
  const options = normalizeContextOptions(contextOptions);
  const systemMessage = { role: "system", content: systemPrompt };
  const currentMessage = { role: "user", content };
  const summaryMessage = summary
    ? { role: "system", content: `此前对话摘要：\n${limitByEstimatedTokens(summary, options.maxSummaryTokens)}` }
    : null;
  const fixedMessages = [systemMessage, summaryMessage, currentMessage].filter(Boolean);
  const fixedTokens =
    // 汇总不可裁剪消息和预留输出所占预算，剩余部分仅供历史消息使用。
    options.reservedOutputTokens + fixedMessages.reduce((total, item) => total + estimateMessageTokens(item), 0);
  const historyBudget = Math.max(0, options.maxContextTokens - fixedTokens);
  const selectedHistory = [];
  let historyTokens = 0;

  for (const item of history.slice().reverse()) {
    const clipped = {
      role: item.role,
      content: limitByEstimatedTokens(item.content, options.maxHistoryMessageTokens),
    };
    const tokens = estimateMessageTokens(clipped);
    if (historyTokens + tokens > historyBudget) break;

    selectedHistory.unshift(clipped);
    historyTokens += tokens;
  }

  return {
    messages: [systemMessage, ...(summaryMessage ? [summaryMessage] : []), ...selectedHistory, currentMessage],
    contextTokens: fixedTokens + historyTokens,
    historySent: selectedHistory.length,
  };
}

/**
 * 过滤并裁剪外部历史消息，只保留有限数量的 user/assistant 文本消息。
 *
 * @param {unknown} value - 外部传入的历史消息。
 * @param {object} contextOptions - 上下文预算配置。
 * @returns {Array<{role: "user"|"assistant", content: string}>} 可进入预算计算的历史消息副本。
 */
export function normalizeHistory(value, contextOptions) {
  const options = normalizeContextOptions(contextOptions);
  if (!Array.isArray(value)) return [];

  return value
    .slice(-48)
    // 将每条外部消息归一化为受支持角色和受限长度的文本结构。
    .map((item) => {
      const role = item?.role === "assistant" ? "assistant" : item?.role === "user" ? "user" : "";
      const content = String(item?.content || "").trim();
      if (!role || !content) return null;
      return { role, content: limitByEstimatedTokens(content, options.maxHistoryMessageTokens * 2) };
    })
    .filter(Boolean);
}

/**
 * 将外部摘要转换为不超过摘要预算的纯文本。
 *
 * @param {unknown} value - 外部摘要值。
 * @param {object} contextOptions - 上下文预算配置。
 * @returns {string} 归一化后的摘要。
 */
export function normalizeSummary(value, contextOptions) {
  const options = normalizeContextOptions(contextOptions);
  return limitByEstimatedTokens(String(value || "").trim(), options.maxSummaryTokens);
}

/**
 * 估算单条文本或多模态消息占用的 token，用于本地保守裁剪。
 *
 * @param {object} message - OpenAI-compatible 消息。
 * @returns {number} 估算 token 数量。
 */
export function estimateMessageTokens(message) {
  const roleTokens = 4;
  if (Array.isArray(message.content)) {
    return (
      roleTokens +
      // 对图片使用固定估值，对文本片段使用字符近似值。
      message.content.reduce((total, part) => {
        if (part?.type === "image_url") return total + 260;
        return total + estimateTokens(String(part?.text || ""));
      }, 0)
    );
  }

  return roleTokens + estimateTokens(String(message.content || ""));
}

/**
 * 用字符数近似估算文本 token，作为未接入 tokenizer 时的轻量预算依据。
 *
 * @param {unknown} value - 待估算文本。
 * @returns {number} 向上取整的估算 token 数。
 */
export function estimateTokens(value) {
  return Math.ceil(String(value || "").length / 2);
}

/**
 * 按估算 token 上限截断文本，并明确标记内容已被裁剪。
 *
 * @param {unknown} value - 待限制文本。
 * @param {number} maxTokens - 允许的最大估算 token 数。
 * @returns {string} 原文本或带截断标记的文本。
 */
export function limitByEstimatedTokens(value, maxTokens) {
  const text = String(value || "");
  if (estimateTokens(text) <= maxTokens) return text;

  const maxChars = Math.max(0, maxTokens * 2);
  return `${text.slice(0, maxChars)}\n...[内容已截断]`;
}

/**
 * 合并上下文预算默认值，只接受调用方提供的有限正数覆盖项。
 *
 * @param {object} [contextOptions] - 调用方预算配置。
 * @returns {object} 完整且可用于计算的预算配置副本。
 */
export function normalizeContextOptions(contextOptions = {}) {
  return {
    ...DEFAULT_CONTEXT_OPTIONS,
    ...Object.fromEntries(
      // 仅允许有限正数覆盖默认预算，阻止无效配置进入计算。
      Object.entries(contextOptions).filter(([, value]) => Number.isFinite(value) && value > 0),
    ),
  };
}
