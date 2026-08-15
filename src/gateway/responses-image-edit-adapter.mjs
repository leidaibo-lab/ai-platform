import { GatewayRequestError } from "./gateway-contract.mjs";

const MAX_IMAGE_RESULT_BYTES = 20 * 1024 * 1024;
const MAX_IMAGE_RESULT_BASE64_CHARACTERS = Math.ceil(MAX_IMAGE_RESULT_BYTES / 3) * 4 + 4;
const MAX_RESPONSES_JSON_BYTES = MAX_IMAGE_RESULT_BASE64_CHARACTERS + 1024 * 1024;
const INITIAL_RESPONSES_JSON_BUFFER_BYTES = 64 * 1024;
const SUPPORTED_SOURCE_MEDIA_TYPES = new Set(["image/png", "image/jpeg", "image/webp"]);

/**
 * @typedef {object} ResponsesImageEditInput
 * @property {string} model - LiteLLM 平台编辑模型别名。
 * @property {string} prompt - 当前轮图片编辑指令。
 * @property {{bytes: Uint8Array|Buffer, mediaType: string}} sourceImage - Runtime 已校验的唯一源图片。
 * @property {string} size - 平台白名单图片尺寸。
 * @property {AbortSignal} [abortSignal] - 当前 Run 的组合取消与截止时间信号。
 */

/**
 * 创建 OpenAI Responses 图片编辑 Adapter。
 * Adapter 模式只补齐锁定 openai-compatible SDK 尚未覆盖的 `/responses` 协议，
 * 不拥有模型选择、重试、会话、资产或 provider 凭据生命周期。
 *
 * @param {object} options - LiteLLM Responses 连接配置。
 * @param {string} options.baseUrl - 包含 `/v1` 的 OpenAI-compatible 基础地址。
 * @param {string} options.apiKey - LiteLLM master key 或 virtual key。
 * @param {typeof fetch} [options.fetchImplementation] - 可注入 Fetch Port。
 * @returns {{editImage: (input: ResponsesImageEditInput) => Promise<object>}} 单次图片编辑协议 Adapter。
 */
export function createResponsesImageEditAdapter({
  baseUrl,
  apiKey,
  fetchImplementation = fetch,
}) {
  const responsesUrl = `${String(baseUrl || "").replace(/\/+$/, "")}/responses`;
  const authorization = `Bearer ${apiKey || "sk-local-admin-key"}`;

  return {
    /**
     * 发送一次强制编辑请求，只接受唯一、已完成的图片工具结果。
     *
     * @param {ResponsesImageEditInput} input - 当前轮规范化编辑输入。
     * @returns {Promise<{images: Array<{bytes: Buffer, mediaType: string}>, usage: object, warnings: number}>} 稳定图片结果。
     */
    async editImage(input) {
      const sourceImage = normalizeSourceImage(input.sourceImage);
      const response = await fetchImplementation(responsesUrl, {
        method: "POST",
        headers: {
          Authorization: authorization,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(buildResponsesImageEditBody(input, sourceImage)),
        ...(input.abortSignal === undefined ? {} : { signal: input.abortSignal }),
      });
      const payload = await readJsonPayload(response);
      if (!response.ok) throw buildResponsesHttpError(response.status, payload);
      return mapResponsesImageEditResult(payload);
    },
  };
}

/** 把已校验源图复制为 Adapter 局部不可变输入，并再次限制允许的 MIME。 */
function normalizeSourceImage(sourceImage) {
  const mediaType = String(sourceImage?.mediaType || "").toLowerCase();
  const bytes = Buffer.from(sourceImage?.bytes || []);
  if (!SUPPORTED_SOURCE_MEDIA_TYPES.has(mediaType) || bytes.length === 0) {
    throw new GatewayRequestError("Responses image editing requires a valid source image", 400, {
      error: "Invalid image edit source",
      code: "invalid_image_edit_source",
    });
  }
  return { bytes, mediaType };
}

/** 构造单工具 Responses 编辑请求；当前兼容上游不接受 `max_tool_calls`，唯一结果由响应解析器强制。 */
function buildResponsesImageEditBody(input, sourceImage) {
  return {
    model: String(input.model || "").trim(),
    input: [{
      role: "user",
      content: [
        { type: "input_text", text: String(input.prompt || "") },
        { type: "input_image", image_url: createImageDataUrl(sourceImage) },
      ],
    }],
    tools: [{
      type: "image_generation",
      action: "edit",
      size: String(input.size || "1024x1024"),
    }],
    tool_choice: { type: "image_generation" },
    store: false,
  };
}

/** 将单张受控源图编码为只存在于本次服务端请求内的 data URL。 */
function createImageDataUrl(sourceImage) {
  return `data:${sourceImage.mediaType};base64,${sourceImage.bytes.toString("base64")}`;
}

/** 读取受字节上限约束的 Responses JSON；坏载荷只返回稳定错误，不保留原始响应正文。 */
async function readJsonPayload(response) {
  try {
    const bytes = await readLimitedResponseBytes(response);
    return JSON.parse(bytes.toString("utf8"));
  } catch (error) {
    if (error instanceof GatewayRequestError) throw error;
    if (!response.ok) return {};
    throw withCause(new GatewayRequestError("Invalid Responses payload", 502, {
      error: "Invalid Responses payload",
      code: "invalid_image_edit_response",
    }), error);
  }
}

/**
 * 从 Fetch 已解压的响应流读取有限字节，避免 chunked 或不可信 Content-Length 绕过内存边界。
 *
 * @param {Response} response - LiteLLM Responses HTTP 响应。
 * @returns {Promise<Buffer>} 不超过协议上限的完整响应字节副本。
 */
async function readLimitedResponseBytes(response) {
  const tooLargeError = createResponsesPayloadTooLargeError();
  const contentLength = readDeclaredContentLength(response.headers);
  if (contentLength !== null && contentLength > MAX_RESPONSES_JSON_BYTES) {
    await cancelReadable(response.body, tooLargeError);
    throw tooLargeError;
  }
  if (!response.body) return Buffer.alloc(0);

  const reader = response.body.getReader();
  let bytes = Buffer.alloc(0);
  let totalBytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const chunk = value instanceof Uint8Array ? value : Buffer.from(value || []);
      const nextTotalBytes = totalBytes + chunk.byteLength;
      if (!Number.isSafeInteger(nextTotalBytes) || nextTotalBytes > MAX_RESPONSES_JSON_BYTES) {
        await cancelReadable(reader, tooLargeError);
        throw tooLargeError;
      }
      bytes = ensureResponseBufferCapacity(bytes, totalBytes, nextTotalBytes);
      bytes.set(chunk, totalBytes);
      totalBytes = nextTotalBytes;
    }
  } finally {
    reader.releaseLock();
  }
  return bytes.subarray(0, totalBytes);
}

/** 以几何增长方式扩展累计缓冲区，避免极碎分块通过对象开销造成无界内存增长。 */
function ensureResponseBufferCapacity(bytes, usedBytes, requiredBytes) {
  if (requiredBytes <= bytes.byteLength) return bytes;
  const doubledCapacity = bytes.byteLength === 0
    ? INITIAL_RESPONSES_JSON_BUFFER_BYTES
    : bytes.byteLength * 2;
  const capacity = Math.min(
    MAX_RESPONSES_JSON_BYTES,
    Math.max(requiredBytes, doubledCapacity),
  );
  const expanded = Buffer.allocUnsafe(capacity);
  bytes.copy(expanded, 0, 0, usedBytes);
  return expanded;
}

/** 将可信格式的非负 Content-Length 解析为快速拒绝提示，缺失或非法值交给流式上限处理。 */
function readDeclaredContentLength(headers) {
  const rawValue = headers.get("content-length");
  if (rawValue === null || rawValue.trim() === "") return null;
  const value = Number(rawValue);
  return Number.isFinite(value) && value >= 0 ? value : null;
}

/** 取消尚未消费完的响应流；取消异常不覆盖稳定的网关边界错误。 */
async function cancelReadable(readable, reason) {
  if (!readable || typeof readable.cancel !== "function") return;
  try {
    await readable.cancel(reason);
  } catch {
    // 流式上限错误是对外稳定事实，底层取消失败只影响连接复用。
  }
}

/** 创建不包含上游响应正文的 Responses 体积越界错误。 */
function createResponsesPayloadTooLargeError() {
  return new GatewayRequestError("Responses payload is too large", 502, {
    error: "Responses payload is too large",
    code: "image_edit_response_too_large",
  });
}

/** 将非 2xx Responses 结果压缩为状态和 provider 错误分类，不上抛原始消息。 */
function buildResponsesHttpError(status, payload) {
  const providerCode = readProviderErrorCode(payload);
  return new GatewayRequestError("Responses image editing failed", Number(status) || 502, {
    error: "Responses image editing failed",
    code: "image_edit_provider_error",
    ...(providerCode ? { providerCode } : {}),
  });
}

/** 从 provider 错误对象只读取短分类码，丢弃可能包含输入或凭据的正文。 */
function readProviderErrorCode(payload) {
  const value = payload?.error?.code || payload?.error?.type || payload?.code;
  const normalized = String(value || "").trim();
  return normalized && normalized.length <= 120 && /^[a-zA-Z0-9_.:-]+$/.test(normalized)
    ? normalized
    : "";
}

/** 从 Responses 混合输出中提取唯一完成图片调用，并映射为 GatewayClient 图片结果。 */
function mapResponsesImageEditResult(payload) {
  const imageCalls = [];
  for (const item of Array.isArray(payload?.output) ? payload.output : []) {
    if (item?.type === "image_generation_call") imageCalls.push(item);
  }
  if (imageCalls.length !== 1 || imageCalls[0]?.status !== "completed") {
    throw new GatewayRequestError("Responses did not return one completed image", 502, {
      error: "Invalid Responses image result",
      code: imageCalls.length > 1 ? "multiple_image_edit_results" : "image_edit_result_missing",
    });
  }
  const bytes = decodeImageResult(imageCalls[0].result);
  return {
    images: [{ bytes, mediaType: "image/png" }],
    usage: mapResponsesUsage(payload.usage, 1),
    warnings: 0,
  };
}

/** 严格解码 canonical Base64，并在分配图片 Buffer 前执行编码长度上限。 */
function decodeImageResult(value) {
  const encoded = String(value || "");
  if (
    encoded.length === 0 ||
    encoded.length > MAX_IMAGE_RESULT_BASE64_CHARACTERS ||
    encoded.length % 4 !== 0 ||
    !/^[A-Za-z0-9+/]+={0,2}$/.test(encoded)
  ) {
    throw invalidImageResultError();
  }
  const bytes = Buffer.from(encoded, "base64");
  if (
    bytes.length === 0 ||
    bytes.length > MAX_IMAGE_RESULT_BYTES ||
    bytes.toString("base64") !== encoded
  ) {
    throw invalidImageResultError();
  }
  return bytes;
}

/** 创建不包含 provider 结果内容的非法图片错误。 */
function invalidImageResultError() {
  return new GatewayRequestError("Responses returned an invalid image result", 502, {
    error: "Invalid Responses image result",
    code: "invalid_image_edit_result",
  });
}

/** 将 Responses token 用量收敛到现有图片资产 Run 可持久化字段。 */
function mapResponsesUsage(usage, generatedImages) {
  return {
    input_tokens: normalizeUsageNumber(usage?.input_tokens),
    output_tokens: normalizeUsageNumber(usage?.output_tokens),
    total_tokens: normalizeUsageNumber(usage?.total_tokens),
    generated_images: generatedImages,
  };
}

/** 将可选 usage 数值限制为非负有限值或 null。 */
function normalizeUsageNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : null;
}

/** 给稳定 Gateway 错误附加内部 cause，便于进程内诊断且不改变公开载荷。 */
function withCause(error, cause) {
  error.cause = cause;
  return error;
}
