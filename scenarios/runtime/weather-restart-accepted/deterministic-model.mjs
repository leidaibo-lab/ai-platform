/**
 * 根据当前模型请求中是否已有持久化 ToolResult 决定调用工具或生成最终总结。
 *
 * @param {object} observation - 当前 OpenAI-compatible 模型可见请求。
 * @returns {object} 标准化脚本模型决策。
 */
export function decide(observation) {
  const toolResult = findToolResult(observation.messages, "get_weather");
  if (!toolResult) {
    return {
      type: "tool-call",
      toolCall: {
        id: "weather-restart-accepted-call-v1",
        name: "get_weather",
        input: { location: "深圳", date: "today" },
      },
    };
  }
  return {
    type: "text",
    content: "深圳在 2026-08-13 10:00 的气温为 31℃，天气局部多云；数据来源 Open-Meteo。",
  };
}

/** 从当前消息观察中查找指定工具的结构化结果。 */
function findToolResult(messages, toolName) {
  for (const message of Array.isArray(messages) ? messages : []) {
    if (message?.role !== "tool") continue;
    if (message.name && message.name !== toolName) continue;
    const parsed = parseToolContent(message.content);
    if (parsed) return parsed;
  }
  return null;
}

/** 兼容 OpenAI-compatible 工具消息的 JSON 字符串或已解析对象。 */
function parseToolContent(content) {
  if (content && typeof content === "object") return content;
  try {
    return JSON.parse(String(content || ""));
  } catch {
    return null;
  }
}
