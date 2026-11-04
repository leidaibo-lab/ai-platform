import type { UIMessage } from "ai";

/** 将 SDK 展示消息投影成纯文本历史；步骤、元数据和供应商字段不进入业务接口。 */
export function readingRequest(messages: UIMessage[], artifactHash: string) {
  // 只保留可见文字，流中断产生的空助手消息不作为下一轮上下文。
  const history = messages
    .map((message) => ({
      id: message.id,
      role: message.role,
      // SDK 的文本 part 也可能带有 state/providerMetadata，只提取正文。
      parts: message.parts.flatMap((part) =>
        part.type === "text" && part.text
          ? [{ type: "text" as const, text: part.text }]
          : [],
      ),
      // 被取消且尚无文字的助手消息没有可恢复的上下文。
    }))
    .filter((message) => message.parts.length > 0);
  return { artifactHash, messages: history };
}
