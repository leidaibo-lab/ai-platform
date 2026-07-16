import { buildMessagesWithBudget, limitByEstimatedTokens, normalizeHistory, normalizeSummary } from "./context-budget.mjs";
import { buildUserContent, normalizeChatInput, validateChatInput } from "./message-builder.mjs";
import { createToolRegistry } from "../tools/tool-registry.mjs";

export class RuntimeInputError extends Error {
  constructor(payload, status = 400) {
    super(payload.error || "Invalid runtime input");
    this.name = "RuntimeInputError";
    this.status = status;
    this.payload = payload;
  }
}

export function createChatRuntime({ gatewayClient, contextOptions, systemPrompt, summarySystemPrompt, toolRegistry }) {
  const registry = toolRegistry || createToolRegistry();

  return {
    async chat(body) {
      const input = normalizeChatInput(body);
      const validationError = validateChatInput(input);
      if (validationError) {
        throw new RuntimeInputError(validationError);
      }

      const history = normalizeHistory(input.history, contextOptions);
      const summary = normalizeSummary(input.summary, contextOptions);
      const content = buildUserContent(input);
      registry.resolveToolIntent(input);
      const { messages, contextTokens, historySent } = buildMessagesWithBudget({
        summary,
        history,
        content,
        systemPrompt,
        contextOptions,
      });

      const data = await gatewayClient.chatCompletions({ messages });

      return {
        content: data?.choices?.[0]?.message?.content || "",
        usage: data?.usage || null,
        model: data?.model || gatewayClient.model,
        context: {
          messages: messages.length,
          estimatedTokens: contextTokens,
          budget: contextOptions.maxContextTokens,
          historyReceived: history.length,
          historySent,
          hasSummary: Boolean(summary),
        },
      };
    },

    async summarize(body) {
      const summary = normalizeSummary(body?.summary, contextOptions);
      const messages = normalizeHistory(body?.messages, contextOptions);
      if (messages.length === 0) {
        throw new RuntimeInputError({ error: "Messages are required for summary" });
      }

      const summaryPrompt = [
        "请更新一份用于后续多轮对话的中文上下文摘要。",
        "要求：保留用户目标、关键事实、已做决定、代码/文件名、未完成事项；删除寒暄和重复内容。",
        `摘要不超过 ${contextOptions.maxSummaryTokens} 个估算 token。`,
        "",
        summary ? `已有摘要：\n${summary}` : "已有摘要：无",
        "",
        "新增对话：",
        ...messages.map((item) => `${item.role === "user" ? "用户" : "助手"}：${item.content}`),
      ].join("\n");

      const data = await gatewayClient.chatCompletions({
        messages: [
          { role: "system", content: summarySystemPrompt },
          { role: "user", content: summaryPrompt },
        ],
        temperature: 0.2,
      });

      return {
        summary: limitByEstimatedTokens(data?.choices?.[0]?.message?.content || "", contextOptions.maxSummaryTokens),
        usage: data?.usage || null,
        model: data?.model || gatewayClient.model,
      };
    },
  };
}
