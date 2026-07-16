/**
 * 将渠道请求整理为 Runtime 内部稳定使用的聊天输入结构。
 *
 * @param {unknown} body - 外部请求体。
 * @returns {object} 文本、附件地址、历史和摘要组成的归一化输入。
 */
export function normalizeChatInput(body) {
  return {
    message: String(body?.message || "").trim(),
    imageUrls: normalizeUrlList(body?.imageUrls),
    documentUrls: normalizeUrlList(body?.documentUrls),
    history: body?.history,
    summary: body?.summary,
  };
}

/**
 * 校验聊天请求至少包含一种输入，并限制附件地址为受支持协议。
 *
 * @param {object} input - 已归一化的聊天输入。
 * @returns {object|null} 可直接返回给渠道的错误载荷，合法时返回 null。
 */
export function validateChatInput(input) {
  if (!input.message && input.imageUrls.length === 0 && input.documentUrls.length === 0) {
    return { error: "Message, image, or document link is required" };
  }

  // 收集全部非法地址，让调用方可以一次修正完整输入。
  const invalidUrls = [...input.imageUrls, ...input.documentUrls].filter((url) => !isSupportedUrl(url));
  if (invalidUrls.length > 0) {
    return {
      error: "Only http(s) URLs and image data URLs are supported",
      invalidUrls,
    };
  }

  return null;
}

/**
 * 将文本、文档链接和图片转换为 OpenAI-compatible 用户消息内容。
 *
 * @param {object} input - 当前用户输入。
 * @param {string} input.message - 用户正文。
 * @param {string[]} input.imageUrls - 图片地址或 data URL。
 * @param {string[]} input.documentUrls - 文档链接。
 * @returns {string|Array<object>} 纯文本或多模态消息内容。
 */
export function buildUserContent({ message, imageUrls, documentUrls }) {
  if (imageUrls.length === 0) {
    return [message, formatDocumentLinks(documentUrls)].filter(Boolean).join("\n\n");
  }

  const content = [];
  if (message) {
    content.push({ type: "text", text: message });
  }

  const documentText = formatDocumentLinks(documentUrls);
  if (documentText) {
    content.push({ type: "text", text: documentText });
  }

  for (const url of imageUrls) {
    content.push({ type: "image_url", image_url: { url } });
  }

  if (content.length === imageUrls.length) {
    content.unshift({ type: "text", text: "请分析这些图片。" });
  }

  return content;
}

/**
 * 把文档地址格式化为模型可读的文本列表；当前 Runtime 不主动抓取文档内容。
 *
 * @param {string[]} documentUrls - 文档链接列表。
 * @returns {string} 文档链接提示文本，无链接时返回空字符串。
 */
export function formatDocumentLinks(documentUrls) {
  if (documentUrls.length === 0) return "";
  // 将每个地址转换为单独的 Markdown 列表项，保持输入顺序。
  return `参考文档链接：\n${documentUrls.map((url) => `- ${url}`).join("\n")}`;
}

/**
 * 接受数组或分隔文本形式的地址输入，并返回去空、去重后的有序列表。
 *
 * @param {unknown} value - 地址数组或以空白、逗号分隔的文本。
 * @returns {string[]} 归一化后的唯一地址列表。
 */
export function normalizeUrlList(value) {
  const list = Array.isArray(value) ? value : String(value || "").split(/[\s,，]+/);
  // 统一将外部地址项转换为去除首尾空白的字符串。
  return [...new Set(list.map((url) => String(url).trim()).filter(Boolean))];
}

/**
 * 判断附件地址是否为 HTTP(S) URL 或可内联传输的图片 data URL。
 *
 * @param {string} value - 待校验地址。
 * @returns {boolean} 是否允许进入模型消息。
 */
export function isSupportedUrl(value) {
  if (/^data:image\/[a-z0-9.+-]+;base64,/i.test(value)) return true;

  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}
