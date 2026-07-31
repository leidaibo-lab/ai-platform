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
 * @property {string} model - 当前会话 Sender 选择的 LiteLLM 模型别名。
 */

/**
 * @typedef {object} GatewayReachabilityCopy
 * @property {"checking"|"reachable"|"unreachable"} state - 仅描述 LiteLLM `/v1/models` 可达性。
 * @property {string} label - 侧栏紧凑状态文案。
 * @property {string} announcement - 用户主动重新检测后的反馈文案。
 * @property {string} detail - 解释探测边界的悬停说明。
 */

const DOCUMENT_PREFIX = "参考文档链接：";
const DAY_IN_MS = 24 * 60 * 60 * 1000;

/**
 * @typedef {object} ConversationWorkspaceResult
 * @property {object[]} conversations - 按服务端更新时间排序后的当前窗口。
 * @property {number} total - 搜索和筛选后的会话总数。
 * @property {boolean} hasMore - 是否还有未进入窗口的会话。
 */

/**
 * 搜索、筛选并按时间分组会话摘要，结果只用于渠道列表展示。
 *
 * @param {object[]} conversations - Runtime 返回的会话摘要。
 * @param {{query?: string, filter?: "active"|"archived"|"all", limit?: number, now?: Date|string|number}} [options] - 渠道列表条件。
 * @returns {ConversationWorkspaceResult} 当前列表窗口和总量。
 */
export function buildConversationWorkspace(conversations, options = {}) {
  const query = String(options.query || "").trim().toLocaleLowerCase();
  const filter = options.filter || "active";
  const limit = Math.max(1, Number(options.limit) || 40);
  const now = options.now instanceof Date ? options.now : new Date(options.now || Date.now());
  const filtered = [];
  for (const conversation of conversations || []) {
    const isArchived = Boolean(conversation?.archivedAt);
    if (filter === "active" && isArchived) continue;
    if (filter === "archived" && !isArchived) continue;
    if (query && !String(conversation?.title || "").toLocaleLowerCase().includes(query)) continue;
    filtered.push({
      ...conversation,
      timeGroup: conversationTimeGroup(conversation?.updatedAt, now),
    });
  }
  filtered.sort(compareConversationUpdatedAt);
  return {
    conversations: filtered.slice(0, limit),
    total: filtered.length,
    hasMore: filtered.length > limit,
  };
}

/**
 * 只保留消息末尾窗口，允许用户显式逐批加载更早内容。
 *
 * @param {object[]} messages - 当前会话可见消息。
 * @param {number} limit - 当前窗口上限。
 * @returns {{messages: object[], hiddenCount: number, hasMore: boolean}} 消息窗口。
 */
export function buildMessageWindow(messages, limit = 80) {
  const source = Array.isArray(messages) ? messages : [];
  const normalizedLimit = Math.max(1, Number(limit) || 80);
  const hiddenCount = Math.max(0, source.length - normalizedLimit);
  return {
    messages: source.slice(hiddenCount),
    hiddenCount,
    hasMore: hiddenCount > 0,
  };
}

/**
 * 将内存草稿转换为 sessionStorage 安全 JSON，明确剔除本地图片 data URL。
 *
 * @param {Map<string, ConversationDraft>} drafts - 当前页面会话草稿集合。
 * @returns {string} 可写入 sessionStorage 的版本化 JSON。
 */
export function serializeConversationDrafts(drafts) {
  const entries = [];
  for (const [conversationId, draft] of drafts instanceof Map ? drafts : []) {
    const normalized = normalizeConversationDraft(draft);
    entries.push([
      conversationId,
      {
        ...normalized,
        attachments: normalized.attachments.filter(isSessionSafeAttachment),
      },
    ]);
  }
  return JSON.stringify({ version: 1, entries });
}

/**
 * 从 sessionStorage JSON 恢复会话草稿；坏载荷或未知版本返回空集合。
 *
 * @param {string|null|undefined} value - sessionStorage 原始字符串。
 * @returns {Map<string, ConversationDraft>} 已完成边界过滤的草稿集合。
 */
export function deserializeConversationDrafts(value) {
  try {
    const parsed = JSON.parse(String(value || ""));
    if (parsed?.version !== 1 || !Array.isArray(parsed.entries)) return new Map();
    const drafts = new Map();
    for (const entry of parsed.entries) {
      if (!Array.isArray(entry) || entry.length !== 2 || !entry[0]) continue;
      const normalized = normalizeConversationDraft(entry[1]);
      normalized.attachments = normalized.attachments.filter(isSessionSafeAttachment);
      drafts.set(String(entry[0]), normalized);
    }
    return drafts;
  } catch {
    return new Map();
  }
}

/** 从 Markdown 正文提取一到六级 ATX 标题，供长回答导航使用。 */
export function extractMarkdownHeadings(content, messageId = "message") {
  const headings = [];
  const occurrences = new Map();
  for (const line of String(content || "").split(/\r?\n/)) {
    const match = /^(#{1,6})\s+(.+?)\s*#*\s*$/.exec(line);
    if (!match) continue;
    const title = match[2].replace(/[*_`[\]]/g, "").trim();
    if (!title) continue;
    const slug = markdownHeadingSlug(title);
    const occurrence = (occurrences.get(slug) || 0) + 1;
    occurrences.set(slug, occurrence);
    headings.push({
      level: match[1].length,
      title,
      id: `answer-heading-${String(messageId)}-${slug}-${occurrence}`,
    });
  }
  return headings;
}

/** 仅允许 Markdown 链接使用页面内锚点、相对地址及 http(s)/mailto 协议。 */
export function isSafeMarkdownHref(value) {
  const href = String(value || "").trim();
  if (!href) return false;
  if (href.startsWith("#") || href.startsWith("/") || href.startsWith("./") || href.startsWith("../")) return true;
  try {
    const url = new URL(href);
    return ["http:", "https:", "mailto:"].includes(url.protocol);
  } catch {
    return false;
  }
}

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
  if (
    !normalized.value.trim() &&
    normalized.attachments.length === 0 &&
    normalized.references.length === 0 &&
    !normalized.model
  ) {
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
export function activeRunStageLabel(status, hasContent = false, toolTitle = "") {
  if (status === "stopping") return "正在停止生成";
  if (status === "starting") return "正在连接模型";
  if (status === "tool-running") return `正在查询${toolTitle || "外部数据"}`;
  if (status === "image-generating") return "正在生成图片";
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
  const failure = buildRunFailureCopy(latestRun);
  result.splice(userMessageIndex + 1, 0, {
    id: `run-failure:${latestRun.id}`,
    kind: "run-failure",
    conversationId: latestRun.conversationId,
    runId: latestRun.id,
    role: "assistant",
    status: "failed",
    sourceMessageId: result[userMessageIndex].id,
    displayContent: failure.title,
    failure,
  });
  return result;
}

/**
 * 将失败 Run 的安全分类映射为会话内可理解的原因和处理建议。
 *
 * @param {object|null|undefined} run - latestRun 或渠道收到的公开错误事实。
 * @returns {{title: string, detail: string, action: string, code: string}} 渠道失败文案。
 */
export function buildRunFailureCopy(run) {
  const publicError = run?.publicError || run?.payload || {};
  const lastAttempt = readLastFailedAttempt(run?.resilience);
  const statusCode = Number(publicError.status ?? run?.statusCode ?? run?.status ?? lastAttempt?.statusCode);
  const errorType = String(lastAttempt?.errorType || "");
  const publicCode = String(publicError.code || "");
  const errorText = String(run?.error || publicError.error || "").toLowerCase();
  const model = String(publicError.model || run?.model || "所选模型");

  if (publicCode === "model_authorization_failed" || errorType === "authorization" || statusCode === 401 || statusCode === 403 || /模型鉴权失败|invalid_api_key/.test(errorText)) {
    return {
      title: "模型鉴权失败",
      detail: `${model} 的上游访问凭据无效或没有权限。`,
      action: "请检查模型服务凭据与模型访问权限后重试。",
      code: "model_authorization_failed",
    };
  }
  if (publicCode === "model_rate_limited" || errorType === "rate_limit" || statusCode === 429) {
    return {
      title: "模型服务限流",
      detail: `${model} 当前请求过于频繁或额度暂时受限。`,
      action: "请稍后重试，或切换到其他可用模型。",
      code: "model_rate_limited",
    };
  }
  if (publicCode === "model_timeout" || errorType === "timeout" || statusCode === 408 || statusCode === 504) {
    return {
      title: "模型响应超时",
      detail: `${model} 未在本次运行时限内返回完整结果。`,
      action: "可缩短输入后重试，或切换到其他可用模型。",
      code: "model_timeout",
    };
  }
  if (publicCode === "model_provider_unavailable" || errorType === "provider_unavailable" || statusCode >= 500) {
    return {
      title: "模型服务暂时不可用",
      detail: `${model} 的上游服务当前异常。`,
      action: "请稍后重试；持续失败时检查上游服务状态。",
      code: "model_provider_unavailable",
    };
  }
  if (publicCode === "unsupported_model" || /所选模型不可用|unsupported model alias/.test(errorText)) {
    return {
      title: "所选模型不可用",
      detail: `${model} 不在当前模型网关授权列表中。`,
      action: "请重新检测模型列表并选择可用模型。",
      code: "unsupported_model",
    };
  }
  if (publicCode === "model_context_limit" || /上下文超过模型限制|context.*length|token.*limit/.test(errorText)) {
    return {
      title: "上下文超过模型限制",
      detail: `${model} 无法接收当前长度的会话上下文。`,
      action: "请缩短输入、减少附件或新建会话后重试。",
      code: "model_context_limit",
    };
  }
  if (publicCode === "model_invalid_request" || errorType === "invalid_request" || (statusCode >= 400 && statusCode < 500)) {
    return {
      title: "模型无法处理当前请求",
      detail: `${model} 拒绝了当前输入或参数。`,
      action: "请调整输入内容、附件或模型后重试。",
      code: "model_invalid_request",
    };
  }
  return {
    title: "无法连接模型服务",
    detail: `${model} 的模型调用未能完成。`,
    action: "请检查模型网关与网络状态后重试。",
    code: "model_connection_failed",
  };
}

/** 从网关状态读取去重模型别名；兼容只返回单个默认 `model` 的旧状态响应。 */
export function readGatewayModels(gateway) {
  const candidates = Array.isArray(gateway?.models) ? gateway.models : [gateway?.model];
  const result = [];
  const seen = new Set();
  for (const candidate of candidates) {
    const model = String(candidate || "").trim();
    if (model && model !== "-" && !seen.has(model)) {
      seen.add(model);
      result.push(model);
    }
  }
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
 * 统一判断渠道发送门禁，网关未确认可达时仍允许编辑但不允许提交。
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
 * 将网关状态映射为不夸大上游生成能力的渠道文案。
 *
 * @param {object|null|undefined} gateway - `/api/gateway/status` 返回的 LiteLLM 可达性事实。
 * @returns {GatewayReachabilityCopy} 统一用于侧栏、提示和悬停说明的展示模型。
 */
export function buildGatewayReachabilityCopy(gateway) {
  if (!gateway) {
    return {
      state: "checking",
      label: "正在检查",
      announcement: "正在检查模型网关",
      detail: "正在检查 LiteLLM /v1/models",
    };
  }
  if (gateway.ok) {
    const model = String(gateway.model || "未知模型");
    const baseUrl = String(gateway.gatewayBaseUrl || "LiteLLM");
    return {
      state: "reachable",
      label: `网关可达 · ${model}`,
      announcement: `模型网关可达：${model}；上游生成能力未验证`,
      detail: `${baseUrl}；仅验证 LiteLLM /v1/models，上游生成能力需以实际请求为准`,
    };
  }
  return {
    state: "unreachable",
    label: "模型网关不可达",
    announcement: "模型网关仍不可达",
    detail: String(gateway.error || gateway.gatewayBaseUrl || "LiteLLM /v1/models 不可访问"),
  };
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
    model: String(draft?.model || ""),
  };
}

/** 按更新时间倒序排列会话，缺失或无效时间稳定落到末尾。 */
function compareConversationUpdatedAt(left, right) {
  const leftTime = Date.parse(left?.updatedAt || "") || 0;
  const rightTime = Date.parse(right?.updatedAt || "") || 0;
  return rightTime - leftTime;
}

/** 把服务端更新时间映射为渠道会话列表的固定时间分组。 */
function conversationTimeGroup(updatedAt, now) {
  const updated = new Date(updatedAt || 0);
  if (Number.isNaN(updated.getTime())) return "更早";
  const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const updatedStart = new Date(updated.getFullYear(), updated.getMonth(), updated.getDate()).getTime();
  const elapsedDays = Math.floor((todayStart - updatedStart) / DAY_IN_MS);
  if (elapsedDays <= 0) return "今天";
  if (elapsedDays === 1) return "昨天";
  if (elapsedDays < 7) return "最近 7 天";
  return "更早";
}

/** 判断附件是否可进入 sessionStorage；本地图片正文只保留在当前页面内存。 */
function isSessionSafeAttachment(attachment) {
  const url = String(attachment?.url || "");
  return Boolean(url) && !url.toLowerCase().startsWith("data:");
}

/** 将 Markdown 标题压缩为可用于 DOM id 的稳定 ASCII 片段。 */
function markdownHeadingSlug(value) {
  const slug = String(value || "")
    .toLocaleLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
  return slug || "section";
}

/** 从 resilience 中读取最后一个失败尝试，避免成功重试覆盖最终分类。 */
function readLastFailedAttempt(resilience) {
  const attempts = Array.isArray(resilience?.attempts) ? resilience.attempts : [];
  for (let index = attempts.length - 1; index >= 0; index -= 1) {
    if (attempts[index]?.status === "failed") return attempts[index];
  }
  return null;
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
