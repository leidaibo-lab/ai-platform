import { ImageGenerationPolicyError, normalizeImageGenerationOptions } from "./image-generation-policy.mjs";

export const DEFAULT_RUN_OPERATION = "conversation.chat";
export const AUTO_RUN_OPERATION = "auto";
export const IMAGE_GENERATION_OPERATION = "image.generate";
export const IMAGE_EDIT_OPERATION = "image.edit";

/**
 * 归一化渠道提交的当前 Run 输入，不接收浏览器历史或摘要。
 *
 * @param {unknown} body - 渠道请求体。
 * @returns {object} 当前输入、附件和幂等标识。
 */
export function normalizeRunInput(body) {
  return {
    operation: String(body?.operation || DEFAULT_RUN_OPERATION).trim() || DEFAULT_RUN_OPERATION,
    requestId: String(body?.requestId || "").trim(),
    clientMessageId: String(body?.clientMessageId || "").trim(),
    model: String(body?.model || "").trim(),
    sourceRunId: String(body?.sourceRunId || "").trim(),
    recoveryMode: String(body?.recoveryMode || "").trim(),
    message: String(body?.message || "").trim(),
    imageUrls: normalizeUrlList(body?.imageUrls),
    documentUrls: normalizeUrlList(body?.documentUrls),
    references: normalizeReferences(body?.references),
    imageOptions: body?.imageOptions,
  };
}

/**
 * 校验 Run 幂等标识、当前文本和附件地址。
 *
 * @param {object} input - 归一化后的 Run 输入。
 * @param {{allowImageAssetConversation?: boolean}} [options] - auto 路由为视觉对话后的内部资产许可。
 * @returns {object|null} 可直接返回渠道的错误或 null。
 */
export function validateRunInput(input, { allowImageAssetConversation = false } = {}) {
  if (!input.requestId || !input.clientMessageId) {
    return { error: "requestId and clientMessageId are required" };
  }
  if (input.model.length > 160 || /[\r\n\0]/.test(input.model)) {
    return { error: "model must be a valid model alias", code: "invalid_model" };
  }
  if (![AUTO_RUN_OPERATION, DEFAULT_RUN_OPERATION, IMAGE_GENERATION_OPERATION, IMAGE_EDIT_OPERATION].includes(input.operation)) {
    return { error: "Unsupported Run operation", code: "unsupported_run_operation" };
  }
  if (input.operation === AUTO_RUN_OPERATION && input.model) {
    return {
      error: "auto operation does not accept a client-selected model",
      code: "auto_model_not_allowed",
    };
  }
  const recoveryModes = new Set(["retry", "regenerate", "continue"]);
  if (Boolean(input.sourceRunId) !== Boolean(input.recoveryMode)) {
    return { error: "sourceRunId and recoveryMode must be provided together", code: "invalid_run_recovery" };
  }
  if (input.recoveryMode && !recoveryModes.has(input.recoveryMode)) {
    return { error: "Unsupported recoveryMode", code: "invalid_run_recovery", recoveryMode: input.recoveryMode };
  }
  if (input.operation === AUTO_RUN_OPERATION && input.recoveryMode) {
    return {
      error: "auto operation cannot be used for Run recovery",
      code: "auto_recovery_not_allowed",
    };
  }
  if (!Array.isArray(input.references)) {
    return { error: "references must be an array", code: "invalid_references" };
  }
  if ([IMAGE_GENERATION_OPERATION, IMAGE_EDIT_OPERATION].includes(input.operation)) {
    if (!input.message) {
      return { error: "Image prompt is required", code: "image_prompt_required" };
    }
    if (input.message.length > 4000) {
      return { error: "Image prompt is too long", code: "image_prompt_too_long" };
    }
    if (
      input.operation === IMAGE_GENERATION_OPERATION &&
      (input.imageUrls.length > 0 || input.documentUrls.length > 0 || input.references.length > 0)
    ) {
      return { error: "image.generate currently accepts prompt text only", code: "unsupported_image_generation_input" };
    }
    if (input.operation === IMAGE_EDIT_OPERATION) {
      if (input.imageUrls.length > 0 || input.documentUrls.length > 0) {
        return { error: "image.edit accepts controlled image assets only", code: "unsupported_image_edit_input" };
      }
      if (input.references.length !== 1 || input.references[0]?.type !== "image_asset" || !input.references[0]?.assetId) {
        return { error: "image.edit requires exactly one image_asset reference", code: "image_edit_source_required" };
      }
    }
    try {
      input.imageOptions = normalizeImageGenerationOptions(input.imageOptions);
    } catch (error) {
      if (error instanceof ImageGenerationPolicyError) {
        return { error: error.message, code: error.code };
      }
      throw error;
    }
  }
  for (const reference of input.references) {
    const allowedTypes = input.operation === AUTO_RUN_OPERATION
      ? ["conversation_message", "image_asset"]
      : input.operation === IMAGE_EDIT_OPERATION
        ? ["image_asset"]
        : input.operation === DEFAULT_RUN_OPERATION && allowImageAssetConversation
          ? ["conversation_message", "image_asset"]
          : ["conversation_message"];
    if (!allowedTypes.includes(reference.type)) {
      return {
        error: "Unsupported reference type",
        code: "unsupported_reference_type",
        type: reference.type || "unknown",
      };
    }
    if (reference.type === "conversation_message" && !reference.messageId) {
      return { error: "conversation_message reference requires messageId", code: "invalid_message_reference" };
    }
    if (reference.type === "image_asset" && !reference.assetId) {
      return { error: "image_asset reference requires assetId", code: "invalid_image_asset_reference" };
    }
  }
  if (!input.message && input.imageUrls.length === 0 && input.documentUrls.length === 0 && input.references.length === 0) {
    return { error: "Message, image, document link, or reference is required" };
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
export function buildDisplayContent({ message, imageUrls, documentUrls, references = [] }) {
  const sections = [];
  if (message) sections.push(message);
  if (imageUrls.length > 0) sections.push(`图片：${imageUrls.length} 个`);
  if (documentUrls.length > 0) sections.push(formatDocumentLinks(documentUrls));
  const imageAssetCount = references.filter(isImageAssetReference).length;
  const messageReferenceCount = references.length - imageAssetCount;
  if (imageAssetCount > 0) sections.push(`源图片：${imageAssetCount} 张`);
  if (sections.length === 0 && messageReferenceCount > 0) sections.push(`引用了 ${messageReferenceCount} 条消息`);
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

/** 将分类型引用整理为稳定判别对象并按类型与 ID 去重；非数组交给校验层拒绝。 */
export function normalizeReferences(value) {
  if (value == null) return [];
  if (!Array.isArray(value)) return value;
  const result = [];
  const seen = new Set();
  for (const item of value) {
    const type = String(item?.type || "").trim();
    const reference = type === "image_asset"
      ? { type, assetId: String(item?.assetId || "").trim() }
      : { type, messageId: String(item?.messageId || "").trim() };
    const stableId = reference.type === "image_asset" ? reference.assetId : reference.messageId;
    const key = `${reference.type}:${stableId}`;
    if (!seen.has(key)) {
      seen.add(key);
      result.push(reference);
    }
  }
  return result;
}

/** 判断引用是否为受控图片资产。 */
function isImageAssetReference(reference) {
  return reference?.type === "image_asset";
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
