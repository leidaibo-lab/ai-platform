const DEFAULT_CONTEXT_OPTIONS = {
  maxContextTokens: 12000,
  reservedOutputTokens: 2000,
  maxHistoryMessageTokens: 1200,
  maxSummaryTokens: 1600,
};

export function buildMessagesWithBudget({ summary, history, content, systemPrompt, contextOptions }) {
  const options = normalizeContextOptions(contextOptions);
  const systemMessage = { role: "system", content: systemPrompt };
  const currentMessage = { role: "user", content };
  const summaryMessage = summary
    ? { role: "system", content: `此前对话摘要：\n${limitByEstimatedTokens(summary, options.maxSummaryTokens)}` }
    : null;
  const fixedMessages = [systemMessage, summaryMessage, currentMessage].filter(Boolean);
  const fixedTokens =
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

export function normalizeHistory(value, contextOptions) {
  const options = normalizeContextOptions(contextOptions);
  if (!Array.isArray(value)) return [];

  return value
    .slice(-48)
    .map((item) => {
      const role = item?.role === "assistant" ? "assistant" : item?.role === "user" ? "user" : "";
      const content = String(item?.content || "").trim();
      if (!role || !content) return null;
      return { role, content: limitByEstimatedTokens(content, options.maxHistoryMessageTokens * 2) };
    })
    .filter(Boolean);
}

export function normalizeSummary(value, contextOptions) {
  const options = normalizeContextOptions(contextOptions);
  return limitByEstimatedTokens(String(value || "").trim(), options.maxSummaryTokens);
}

export function estimateMessageTokens(message) {
  const roleTokens = 4;
  if (Array.isArray(message.content)) {
    return (
      roleTokens +
      message.content.reduce((total, part) => {
        if (part?.type === "image_url") return total + 260;
        return total + estimateTokens(String(part?.text || ""));
      }, 0)
    );
  }

  return roleTokens + estimateTokens(String(message.content || ""));
}

export function estimateTokens(value) {
  return Math.ceil(String(value || "").length / 2);
}

export function limitByEstimatedTokens(value, maxTokens) {
  const text = String(value || "");
  if (estimateTokens(text) <= maxTokens) return text;

  const maxChars = Math.max(0, maxTokens * 2);
  return `${text.slice(0, maxChars)}\n...[内容已截断]`;
}

export function normalizeContextOptions(contextOptions = {}) {
  return {
    ...DEFAULT_CONTEXT_OPTIONS,
    ...Object.fromEntries(
      Object.entries(contextOptions).filter(([, value]) => Number.isFinite(value) && value > 0),
    ),
  };
}
