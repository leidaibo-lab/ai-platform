/**
 * @typedef {object} RecoveredRunInput
 * @property {string} message - 可恢复到 Sender 的用户正文。
 * @property {string[]} imageUrls - 从持久化多模态 content 恢复的图片地址。
 * @property {string[]} documentUrls - 从 displayContent 恢复的文档链接。
 * @property {Array<{type: "conversation_message", messageId: string}>} references - 稳定消息引用。
 */

/**
 * @typedef {object} ConversationAnchor
 * @property {string} id - 与 DOM 消息节点一致的稳定身份。
 * @property {string} preview - 单行消息摘要，不承载完整会话事实。
 */

/**
 * @typedef {object} ConversationDraft
 * @property {string} value - 当前会话尚未发送的正文。
 * @property {object[]} attachments - 仅由渠道层持有的附件展示事实。
 * @property {object[]} references - 仅由渠道层持有的待发送消息引用。
 */

const DOCUMENT_PREFIX = "参考文档链接：";

/**
 * 按 conversationId 保存渠道草稿，空草稿会删除对应项且不修改原 Map。
 *
 * @param {Map<string, ConversationDraft>} drafts - 当前页面会话草稿集合。
 * @param {string|null|undefined} conversationId - 草稿所属的稳定会话 ID。
 * @param {ConversationDraft|null|undefined} draft - 待保存的正文、附件和引用。
 * @returns {Map<string, ConversationDraft>} 写入后的新草稿集合。
 */
export function storeConversationDraft(drafts, conversationId, draft) {
  const next = new Map(drafts instanceof Map ? drafts : []);
  const id = String(conversationId || "");
  if (!id) return next;
  const normalized = normalizeConversationDraft(draft);
  if (!normalized.value.trim() && normalized.attachments.length === 0 && normalized.references.length === 0) {
    next.delete(id);
    return next;
  }
  next.set(id, normalized);
  return next;
}

/**
 * 读取指定会话的渠道草稿并返回数组副本，缺失时返回空草稿。
 *
 * @param {Map<string, ConversationDraft>} drafts - 当前页面会话草稿集合。
 * @param {string|null|undefined} conversationId - 要恢复的稳定会话 ID。
 * @returns {ConversationDraft} 与其他会话隔离的草稿快照。
 */
export function readConversationDraft(drafts, conversationId) {
  const draft = drafts instanceof Map ? drafts.get(String(conversationId || "")) : null;
  return normalizeConversationDraft(draft);
}

/** 判断反向滚动消息列表是否仍贴近视觉底部。 */
export function isMessageListAtLatest(scrollTop, threshold = 24) {
  const normalizedTop = Number.isFinite(Number(scrollTop)) ? Number(scrollTop) : 0;
  const normalizedThreshold = Math.max(0, Number(threshold) || 0);
  return Math.abs(normalizedTop) <= normalizedThreshold;
}

/**
 * 仅在 Bubble.List 内部滚动节点就绪后执行回到底部，避免首次挂载时调用第三方空引用。
 *
 * @param {object|null|undefined} messageList - Bubble.List 暴露的命令对象。
 * @param {ScrollBehavior} behavior - 浏览器滚动行为。
 * @returns {boolean} 是否已经向就绪的消息列表发出滚动命令。
 */
export function scrollMessageListToLatest(messageList, behavior = "smooth") {
  if (!messageList?.scrollBoxNativeElement || typeof messageList.scrollTo !== "function") return false;
  messageList.scrollTo({ top: "bottom", behavior });
  return true;
}

/** 把现有活动 Run 事实映射为回答附近的渠道状态，不推断服务端未提供的阶段。 */
export function activeRunStageLabel(status, hasContent = false) {
  if (status === "stopping") return "正在停止生成";
  if (status === "starting") return "正在连接模型";
  return hasContent ? "正在生成回答" : "正在等待模型响应";
}

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

/**
 * 从当前可见消息建立用户侧导航锚点，助手回复和渠道派生项不进入轨道。
 *
 * @param {object[]} messages - 服务端消息和当前活动 Run 的乐观消息。
 * @returns {ConversationAnchor[]} 保持消息顺序的锚点描述。
 */
export function buildConversationAnchors(messages) {
  const anchors = [];
  const knownIds = new Set();
  for (const message of messages || []) {
    const id = String(message?.id || "");
    if (!id || knownIds.has(id) || message?.kind === "run-failure") continue;
    if (message?.role !== "user") continue;
    knownIds.add(id);
    anchors.push({
      id,
      preview: buildMessagePreview(message.displayContent),
    });
  }
  return anchors;
}

/** 将消息正文压缩为单行预览，并允许调用方提供空正文占位。 */
export function buildMessagePreview(value, emptyLabel = "(空消息)") {
  const normalized = String(value || "").replace(/\s+/g, " ").trim();
  return normalized.length > 72 ? `${normalized.slice(0, 72)}...` : normalized || emptyLabel;
}

/** 将任意渠道草稿输入归一化为独立数组快照。 */
function normalizeConversationDraft(draft) {
  return {
    value: String(draft?.value || ""),
    attachments: Array.isArray(draft?.attachments) ? [...draft.attachments] : [],
    references: Array.isArray(draft?.references) ? [...draft.references] : [],
  };
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
