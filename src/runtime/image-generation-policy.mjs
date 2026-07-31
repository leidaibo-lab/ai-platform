const DEFAULT_IMAGE_SIZE = "1024x1024";
const ALLOWED_IMAGE_SIZES = new Set(["1024x1024", "1536x1024", "1024x1536"]);
const MAX_GENERATED_IMAGE_BYTES = 20 * 1024 * 1024;
const MAX_GENERATED_IMAGE_DIMENSION = 4096;

/** 图片生成策略错误，供 Runtime 映射稳定请求或结果错误。 */
export class ImageGenerationPolicyError extends Error {
  /** 保存稳定错误码和 HTTP 建议状态。 */
  constructor(message, code, status = 400) {
    super(message);
    this.name = "ImageGenerationPolicyError";
    this.code = code;
    this.status = status;
  }
}

/**
 * 将渠道图片选项收敛到平台白名单，不允许任意 provider 参数穿透。
 *
 * @param {unknown} value - 渠道提交的通用图片选项。
 * @returns {{size: string}} 规范化图片尺寸。
 */
export function normalizeImageGenerationOptions(value) {
  if (value != null && (!isPlainObject(value) || Array.isArray(value))) {
    throw new ImageGenerationPolicyError("imageOptions must be an object", "invalid_image_options");
  }
  const options = value || {};
  const keys = Object.keys(options);
  for (const key of keys) {
    if (key !== "size") {
      throw new ImageGenerationPolicyError("Unsupported image option", "unsupported_image_option");
    }
  }
  const size = String(options.size || DEFAULT_IMAGE_SIZE);
  if (!ALLOWED_IMAGE_SIZES.has(size)) {
    throw new ImageGenerationPolicyError("Unsupported image size", "unsupported_image_size");
  }
  return { size };
}

/**
 * 检查生成图片的真实格式、字节上限和尺寸，并返回可持久化元数据。
 *
 * @param {Uint8Array|Buffer} input - 图片模型返回的原始字节。
 * @param {string} declaredMediaType - SDK 声明的 MIME。
 * @returns {{bytes: Buffer, mediaType: string, sizeBytes: number, width: number, height: number}} 图片元数据。
 */
export function inspectGeneratedImage(input, declaredMediaType) {
  const bytes = Buffer.from(input || []);
  if (bytes.length === 0 || bytes.length > MAX_GENERATED_IMAGE_BYTES) {
    throw new ImageGenerationPolicyError("生成图片大小无效", "invalid_generated_image", 502);
  }
  const detected = detectImage(bytes);
  if (!detected) {
    throw new ImageGenerationPolicyError("生成结果不是受支持的完整图片", "invalid_generated_image", 502);
  }
  const normalizedDeclaredType = String(declaredMediaType || detected.mediaType).toLowerCase();
  if (normalizedDeclaredType !== detected.mediaType) {
    throw new ImageGenerationPolicyError("生成图片格式与声明不一致", "generated_image_media_mismatch", 502);
  }
  if (
    detected.width < 1 ||
    detected.height < 1 ||
    detected.width > MAX_GENERATED_IMAGE_DIMENSION ||
    detected.height > MAX_GENERATED_IMAGE_DIMENSION
  ) {
    throw new ImageGenerationPolicyError("生成图片尺寸超出平台限制", "generated_image_dimensions_invalid", 502);
  }
  return {
    bytes,
    mediaType: detected.mediaType,
    sizeBytes: bytes.length,
    width: detected.width,
    height: detected.height,
  };
}

/** 按文件签名识别 PNG、JPEG 或 WebP，并读取真实尺寸。 */
function detectImage(bytes) {
  return detectPng(bytes) || detectJpeg(bytes) || detectWebp(bytes);
}

/** 识别 PNG 签名和 IHDR 尺寸。 */
function detectPng(bytes) {
  if (bytes.length < 24 || bytes.toString("hex", 0, 8) !== "89504e470d0a1a0a") return null;
  if (bytes.toString("ascii", 12, 16) !== "IHDR") return null;
  return { mediaType: "image/png", width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
}

/** 遍历 JPEG 段直到找到包含尺寸的 SOF 标记。 */
function detectJpeg(bytes) {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return null;
  let offset = 2;
  while (offset + 8 < bytes.length) {
    if (bytes[offset] !== 0xff) {
      offset += 1;
      continue;
    }
    const marker = bytes[offset + 1];
    if (marker === 0xd9 || marker === 0xda) break;
    const segmentLength = bytes.readUInt16BE(offset + 2);
    if (segmentLength < 2 || offset + segmentLength + 2 > bytes.length) return null;
    if (isJpegStartOfFrame(marker) && segmentLength >= 7) {
      return {
        mediaType: "image/jpeg",
        width: bytes.readUInt16BE(offset + 7),
        height: bytes.readUInt16BE(offset + 5),
      };
    }
    offset += segmentLength + 2;
  }
  return null;
}

/** 判断 JPEG 标记是否包含帧尺寸。 */
function isJpegStartOfFrame(marker) {
  return [0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf].includes(marker);
}

/** 识别 WebP VP8X/VP8/VP8L 头部并读取画布尺寸。 */
function detectWebp(bytes) {
  if (
    bytes.length < 30 ||
    bytes.toString("ascii", 0, 4) !== "RIFF" ||
    bytes.toString("ascii", 8, 12) !== "WEBP"
  ) return null;
  const chunk = bytes.toString("ascii", 12, 16);
  if (chunk === "VP8X") {
    return {
      mediaType: "image/webp",
      width: 1 + readUInt24LE(bytes, 24),
      height: 1 + readUInt24LE(bytes, 27),
    };
  }
  if (chunk === "VP8 " && bytes.length >= 30) {
    return {
      mediaType: "image/webp",
      width: bytes.readUInt16LE(26) & 0x3fff,
      height: bytes.readUInt16LE(28) & 0x3fff,
    };
  }
  if (chunk === "VP8L" && bytes.length >= 25 && bytes[20] === 0x2f) {
    const bits = bytes.readUInt32LE(21);
    return {
      mediaType: "image/webp",
      width: (bits & 0x3fff) + 1,
      height: ((bits >> 14) & 0x3fff) + 1,
    };
  }
  return null;
}

/** 从 Buffer 读取 24 位小端无符号整数。 */
function readUInt24LE(bytes, offset) {
  return bytes[offset] | (bytes[offset + 1] << 8) | (bytes[offset + 2] << 16);
}

/** 判断值是否为普通对象。 */
function isPlainObject(value) {
  return value !== null && typeof value === "object" && Object.getPrototypeOf(value) === Object.prototype;
}
