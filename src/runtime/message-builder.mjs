/**
 * 归一化渠道提交的当前 Run 输入，不接收浏览器历史或摘要。
 *
 * @param {unknown} body - 渠道请求体。
 * @returns {object} 当前输入、附件和幂等标识。
 */
export function normalizeRunInput(body) {
  return {
    requestId: String(body?.requestId || "").trim(),
    clientMessageId: String(body?.clientMessageId || "").trim(),
    message: String(body?.message || "").trim(),
    imageUrls: normalizeUrlList(body?.imageUrls),
    documentUrls: normalizeUrlList(body?.documentUrls),
  };
}

/**
 * 校验 Run 幂等标识、当前文本和附件地址。
 *
 * @param {object} input - 归一化后的 Run 输入。
 * @returns {object|null} 可直接返回渠道的错误或 null。
 */
export function validateRunInput(input) {
  if (!input.requestId || !input.clientMessageId) {
    return { error: "requestId and clientMessageId are required" };
  }
  if (!input.message && input.imageUrls.length === 0 && input.documentUrls.length === 0) {
    return { error: "Message, image, or document link is required" };
  }

  const invalidUrls = [];
  for (const url of [...input.imageUrls, ...input.documentUrls]) {
    if (!isSupportedUrl(url)) invalidUrls.push(url);
  }
  if (invalidUrls.length > 0) {
    return {
      error: "Only http(s) URLs and image data URLs are supported",
      invalidUrls,
    };
  }
  return null;
}

/**
 * 将当前文本、文档链接和图片转换为 OpenAI-compatible user content。
 *
 * @param {object} input - 归一化 Run 输入。
 * @returns {string|Array<object>} 模型消息 content。
 */
export function buildUserContent({ message, imageUrls, documentUrls }) {
  if (imageUrls.length === 0) {
    return [message, formatDocumentLinks(documentUrls)].filter(Boolean).join("\n\n");
  }

  const content = [];
  if (message) content.push({ type: "text", text: message });
  const documentText = formatDocumentLinks(documentUrls);
  if (documentText) content.push({ type: "text", text: documentText });
  for (const url of imageUrls) {
    content.push({ type: "image_url", image_url: { url } });
  }
  if (content.length === imageUrls.length) {
    content.unshift({ type: "text", text: "请分析这些图片。" });
  }
  return content;
}

/**
 * 将当前 Run 输入转换为消息列表中的用户可读文本。
 *
 * @param {object} input - 归一化 Run 输入。
 * @returns {string} 会话页面和记忆来源使用的纯文本。
 */
export function buildDisplayContent({ message, imageUrls, documentUrls }) {
  const sections = [];
  if (message) sections.push(message);
  if (imageUrls.length > 0) sections.push(`图片：${imageUrls.length} 个`);
  if (documentUrls.length > 0) sections.push(formatDocumentLinks(documentUrls));
  return sections.join("\n\n");
}

/** 将文档地址格式化为模型和用户都可读的列表。 */
export function formatDocumentLinks(documentUrls) {
  if (documentUrls.length === 0) return "";
  return `参考文档链接：\n${documentUrls.map(formatListItem).join("\n")}`;
}

/** 将单个地址格式化为 Markdown 列表项。 */
function formatListItem(url) {
  return `- ${url}`;
}

/** 将数组或分隔字符串整理为去空、去重 URL 列表。 */
export function normalizeUrlList(value) {
  const raw = Array.isArray(value) ? value : String(value || "").split(/[\s,，]+/);
  const result = [];
  const seen = new Set();
  for (const item of raw) {
    const url = String(item).trim();
    if (url && !seen.has(url)) {
      seen.add(url);
      result.push(url);
    }
  }
  return result;
}

/** 判断地址是否为 http(s) 或图片 data URL。 */
export function isSupportedUrl(value) {
  if (/^data:image\/[a-z0-9.+-]+;base64,/i.test(value)) return true;
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}
