export function normalizeChatInput(body) {
  return {
    message: String(body?.message || "").trim(),
    imageUrls: normalizeUrlList(body?.imageUrls),
    documentUrls: normalizeUrlList(body?.documentUrls),
    history: body?.history,
    summary: body?.summary,
  };
}

export function validateChatInput(input) {
  if (!input.message && input.imageUrls.length === 0 && input.documentUrls.length === 0) {
    return { error: "Message, image, or document link is required" };
  }

  const invalidUrls = [...input.imageUrls, ...input.documentUrls].filter((url) => !isSupportedUrl(url));
  if (invalidUrls.length > 0) {
    return {
      error: "Only http(s) URLs and image data URLs are supported",
      invalidUrls,
    };
  }

  return null;
}

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

export function formatDocumentLinks(documentUrls) {
  if (documentUrls.length === 0) return "";
  return `参考文档链接：\n${documentUrls.map((url) => `- ${url}`).join("\n")}`;
}

export function normalizeUrlList(value) {
  const list = Array.isArray(value) ? value : String(value || "").split(/[\s,，]+/);
  return [...new Set(list.map((url) => String(url).trim()).filter(Boolean))];
}

export function isSupportedUrl(value) {
  if (/^data:image\/[a-z0-9.+-]+;base64,/i.test(value)) return true;

  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}
