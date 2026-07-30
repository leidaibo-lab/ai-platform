/**
 * @typedef {object} RecoveredRunInput
 * @property {string} message - 可恢复到 Sender 的用户正文。
 * @property {string[]} imageUrls - 从持久化多模态 content 恢复的图片地址。
 * @property {string[]} documentUrls - 从 displayContent 恢复的文档链接。
 * @property {Array<{type: "conversation_message", messageId: string}>} references - 稳定消息引用。
 */

const DOCUMENT_PREFIX = "参考文档链接：";

/**
 * 在对应用户消息后插入渠道安全的失败标记，不展示 Run 原始错误。
 *
 * @param {object[]} messages - 当前会话的服务端消息事实。
 * @param {object|null|undefined} latestRun - 会话最近 Run。
 * @returns {object[]} 包含至多一个最新失败标记的新数组。
 */
export function insertLatestRunFailure(messages, latestRun) {
  const result = Array.isArray(messages) ? [...messages] : [];
  if (latestRun?.status !== "failed" || !latestRun.id) return result;
  const userMessageIndex = result.findIndex(
    // 失败标记必须锚定同一 Run 的持久化用户消息，不能按列表末尾猜测。
    (message) => message?.runId === latestRun.id && message.role === "user",
  );
  if (userMessageIndex < 0) return result;
  result.splice(userMessageIndex + 1, 0, {
    id: `run-failure:${latestRun.id}`,
    kind: "run-failure",
    conversationId: latestRun.conversationId,
    runId: latestRun.id,
    role: "assistant",
    status: "failed",
    sourceMessageId: result[userMessageIndex].id,
    displayContent: "本次生成失败",
  });
  return result;
}

/**
 * 从持久化用户消息恢复渠道可编辑输入，不复用旧幂等标识。
 *
 * @param {object|null|undefined} message - 与失败 Run 关联的用户消息。
 * @returns {RecoveredRunInput} 可重新编辑的正文、附件和引用。
 */
export function recoverRunInput(message) {
  const display = parseDisplayContent(message?.displayContent);
  const imageUrls = [];
  if (Array.isArray(message?.content)) {
    for (const part of message.content) {
      const url = part?.type === "image_url" ? part.image_url?.url : null;
      if (url) imageUrls.push(String(url));
    }
  }
  const references = [];
  for (const reference of message?.references || []) {
    if (reference?.type === "conversation_message" && reference.messageId) {
      references.push({ type: "conversation_message", messageId: String(reference.messageId) });
    }
  }
  return {
    message: display.message,
    imageUrls,
    documentUrls: display.documentUrls,
    references,
  };
}

/**
 * 统一判断渠道发送门禁，网关未确认在线时仍允许编辑但不允许提交。
 *
 * @param {object} input - 当前会话、网关、Run 和输入状态。
 * @returns {boolean} 是否允许执行 Run。
 */
export function canSubmitRun({ conversationStatus, gatewayOk, activeRun, hasInput }) {
  return conversationStatus === "active" && gatewayOk === true && !activeRun && Boolean(hasInput);
}

/** 把会话生命周期映射为不与模型生成混淆的渠道文案。 */
export function conversationStatusLabel(status) {
  return status === "closed" ? "已结束" : "可继续";
}

/** 从 displayContent 剔除附件摘要，保留用户真正输入的正文与文档链接。 */
function parseDisplayContent(value) {
  const messageSections = [];
  const documentUrls = [];
  for (const section of String(value || "").split(/\n\n+/)) {
    const normalized = section.trim();
    if (!normalized || /^图片：\d+\s*个$/.test(normalized) || /^引用了\s*\d+\s*条消息$/.test(normalized)) continue;
    if (normalized.startsWith(DOCUMENT_PREFIX)) {
      for (const line of normalized.slice(DOCUMENT_PREFIX.length).split("\n")) {
        const url = line.replace(/^\s*-\s*/, "").trim();
        if (url) documentUrls.push(url);
      }
      continue;
    }
    messageSections.push(normalized);
  }
  return { message: messageSections.join("\n\n"), documentUrls };
}
