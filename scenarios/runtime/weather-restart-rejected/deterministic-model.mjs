/**
 * 根据持久化 ToolResult 决定下一步；恢复候选故意缺少来源以验证系统门禁。
 *
 * @param {object} observation - 当前 OpenAI-compatible 模型可见请求。
 * @returns {object} 标准化脚本模型决策。
 */
export function decide(observation) {
  const toolResult = findToolResult(observation.messages);
  if (!toolResult) {
    return {
      type: "tool-call",
      toolCall: {
        id: "weather-restart-rejected-call-v1",
        name: "get_weather",
        input: { location: "深圳", date: "today" },
      },
    };
  }
  return {
    type: "text",
    content: "深圳在 2026-08-13 10:00 的气温为 31℃。",
  };
}

/** 查找当前请求中已经出现的工具结果，作为状态转移条件。 */
function findToolResult(messages) {
  for (const message of Array.isArray(messages) ? messages : []) {
    if (message?.role === "tool" && parseToolContent(message.content)) return message;
  }
  return null;
}

/** 仅把可解析 JSON 视为已观察到的持久化工具事实。 */
function parseToolContent(content) {
  if (content && typeof content === "object") return content;
  try {
    return JSON.parse(String(content || ""));
  } catch {
    return null;
  }
}
