import { buildMessagesWithBudget, limitByEstimatedTokens, normalizeHistory, normalizeSummary } from "./context-budget.mjs";
import { buildUserContent, normalizeChatInput, validateChatInput } from "./message-builder.mjs";
import { createToolRegistry } from "../tools/tool-registry.mjs";

export class RuntimeInputError extends Error {
  /**
   * 保存可直接返回给渠道层的校验错误载荷和 HTTP 状态码。
   *
   * @param {object} payload - Runtime 输入错误详情。
   * @param {number} [status=400] - 建议返回的 HTTP 状态码。
   */
  constructor(payload, status = 400) {
    super(payload.error || "Invalid runtime input");
    this.name = "RuntimeInputError";
    this.status = status;
    this.payload = payload;
  }
}

/**
 * 通过依赖注入装配聊天、摘要、上下文预算和工具意图边界。
 *
 * @param {object} dependencies - Runtime 依赖和策略配置。
 * @param {object} dependencies.gatewayClient - 模型网关客户端。
 * @param {object} dependencies.contextOptions - 上下文预算配置。
 * @param {string} dependencies.systemPrompt - 常规对话系统提示。
 * @param {string} dependencies.summarySystemPrompt - 摘要任务系统提示。
 * @param {object} [dependencies.toolRegistry] - 可选工具注册表。
 * @returns {object} 渠道适配器可调用的 Runtime API。
 */
export function createChatRuntime({ gatewayClient, contextOptions, systemPrompt, summarySystemPrompt, toolRegistry }) {
  const registry = toolRegistry || createToolRegistry();

  return {
    /**
     * 校验并归一化渠道输入，在预算内构造消息后调用模型网关完成对话。
     *
     * @param {unknown} body - 渠道请求体。
     * @returns {Promise<object>} 助手内容、模型信息、用量和上下文统计。
     */
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

    /**
     * 将旧历史与已有摘要合并为受预算限制的新摘要。
     *
     * @param {unknown} body - 摘要、待压缩消息组成的渠道请求体。
     * @returns {Promise<object>} 新摘要及模型调用信息。
     */
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
        // 为模型标记每条历史的说话方，保留原始消息顺序。
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
