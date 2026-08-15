const DEFAULT_IMAGE_SIZE = "1024x1024";
const ALLOWED_IMAGE_SIZES = new Set(["1024x1024", "1536x1024", "1024x1536"]);
const MAX_GENERATED_IMAGE_BYTES = 20 * 1024 * 1024;
export const MAX_UPLOADED_IMAGE_BYTES = 5 * 1024 * 1024;
const MAX_IMAGE_DIMENSION = 4096;

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
  return inspectImage(input, declaredMediaType, {
    maxBytes: MAX_GENERATED_IMAGE_BYTES,
    status: 502,
    invalidMessage: "生成结果不是受支持的完整图片",
    invalidCode: "invalid_generated_image",
    mismatchMessage: "生成图片格式与声明不一致",
    mismatchCode: "generated_image_media_mismatch",
    dimensionsMessage: "生成图片尺寸超出平台限制",
    dimensionsCode: "generated_image_dimensions_invalid",
  });
}

/**
 * 检查渠道上传图片的真实格式、字节上限和尺寸，拒绝声明 MIME 与内容不一致。
 *
 * @param {Uint8Array|Buffer} input - 渠道上传的原始图片字节。
 * @param {string} declaredMediaType - HTTP Content-Type 声明。
 * @returns {{bytes: Buffer, mediaType: string, sizeBytes: number, width: number, height: number}} 图片元数据。
 */
export function inspectUploadedImage(input, declaredMediaType) {
  return inspectImage(input, declaredMediaType, {
    maxBytes: MAX_UPLOADED_IMAGE_BYTES,
    status: 400,
    invalidMessage: "上传内容不是受支持的完整图片",
    invalidCode: "invalid_uploaded_image",
    mismatchMessage: "上传图片格式与声明不一致",
    mismatchCode: "uploaded_image_media_mismatch",
    dimensionsMessage: "上传图片尺寸超出平台限制",
    dimensionsCode: "uploaded_image_dimensions_invalid",
  });
}

/**
 * 重新检查从 ImageAssetStore 读取的受控源图，允许使用平台已生成的较大图片。
 *
 * @param {Uint8Array|Buffer} input - 资产存储返回的图片字节。
 * @param {string} declaredMediaType - SQLite 资产元数据中的 MIME。
 * @returns {{bytes: Buffer, mediaType: string, sizeBytes: number, width: number, height: number}} 图片元数据。
 */
export function inspectStoredImage(input, declaredMediaType) {
  return inspectImage(input, declaredMediaType, {
    maxBytes: MAX_GENERATED_IMAGE_BYTES,
    status: 500,
    invalidMessage: "源图片资产内容无效",
    invalidCode: "invalid_source_image",
    mismatchMessage: "源图片资产格式不一致",
    mismatchCode: "source_image_media_mismatch",
    dimensionsMessage: "源图片资产尺寸超出平台限制",
    dimensionsCode: "source_image_dimensions_invalid",
  });
}

/** 使用调用方策略检查图片字节、真实类型和尺寸，并返回统一资产元数据。 */
function inspectImage(input, declaredMediaType, policy) {
  const bytes = Buffer.from(input || []);
  if (bytes.length === 0 || bytes.length > policy.maxBytes) {
    throw new ImageGenerationPolicyError(policy.invalidMessage, policy.invalidCode, policy.status);
  }
  const detected = detectImage(bytes);
  if (!detected) {
    throw new ImageGenerationPolicyError(policy.invalidMessage, policy.invalidCode, policy.status);
  }
  const normalizedDeclaredType = String(declaredMediaType || detected.mediaType).toLowerCase();
  if (normalizedDeclaredType !== detected.mediaType) {
    throw new ImageGenerationPolicyError(policy.mismatchMessage, policy.mismatchCode, policy.status);
  }
  if (
    detected.width < 1 ||
    detected.height < 1 ||
    detected.width > MAX_IMAGE_DIMENSION ||
    detected.height > MAX_IMAGE_DIMENSION
  ) {
    throw new ImageGenerationPolicyError(policy.dimensionsMessage, policy.dimensionsCode, policy.status);
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

/** 遍历 PNG chunk，要求首个 IHDR、至少一个 IDAT 和文件末尾的完整 IEND。 */
function detectPng(bytes) {
  if (bytes.length < 45 || bytes.toString("hex", 0, 8) !== "89504e470d0a1a0a") return null;
  let offset = 8;
  let width = null;
  let height = null;
  let chunkIndex = 0;
  let hasImageData = false;

  while (offset + 12 <= bytes.length) {
    const dataLength = bytes.readUInt32BE(offset);
    const chunkEnd = offset + 12 + dataLength;
    if (chunkEnd > bytes.length) return null;
    const chunkType = bytes.toString("ascii", offset + 4, offset + 8);
    if (chunkIndex === 0) {
      if (chunkType !== "IHDR" || dataLength !== 13) return null;
      width = bytes.readUInt32BE(offset + 8);
      height = bytes.readUInt32BE(offset + 12);
    } else if (chunkType === "IHDR") {
      return null;
    }
    if (chunkType === "IDAT" && dataLength > 0) hasImageData = true;
    if (chunkType === "IEND") {
      if (dataLength !== 0 || !hasImageData || chunkEnd !== bytes.length) return null;
      return { mediaType: "image/png", width, height };
    }
    offset = chunkEnd;
    chunkIndex += 1;
  }
  return null;
}

/** 遍历 JPEG 头部段，要求 SOF、SOS 和文件末尾的 EOI 标记完整存在。 */
function detectJpeg(bytes) {
  if (
    bytes.length < 12 ||
    bytes[0] !== 0xff ||
    bytes[1] !== 0xd8 ||
    bytes[bytes.length - 2] !== 0xff ||
    bytes[bytes.length - 1] !== 0xd9
  ) return null;
  let offset = 2;
  let width = null;
  let height = null;
  let hasScan = false;
  while (offset < bytes.length - 2) {
    if (bytes[offset] !== 0xff) return null;
    while (offset < bytes.length - 2 && bytes[offset] === 0xff) offset += 1;
    if (offset >= bytes.length - 2) return null;
    const marker = bytes[offset];
    offset += 1;
    if (marker === 0x00 || marker === 0xd8 || marker === 0xd9) return null;
    if (isJpegStandaloneMarker(marker)) continue;
    if (offset + 2 > bytes.length - 2) return null;
    const segmentLength = bytes.readUInt16BE(offset);
    const segmentEnd = offset + segmentLength;
    if (segmentLength < 2 || segmentEnd > bytes.length - 2) return null;
    if (isJpegStartOfFrame(marker)) {
      if (segmentLength < 8) return null;
      width = bytes.readUInt16BE(offset + 5);
      height = bytes.readUInt16BE(offset + 3);
    }
    if (marker === 0xda) {
      hasScan = true;
      break;
    }
    offset = segmentEnd;
  }
  if (!hasScan || width == null || height == null) return null;
  return { mediaType: "image/jpeg", width, height };
}

/** 判断 JPEG 标记是否包含帧尺寸。 */
function isJpegStartOfFrame(marker) {
  return [0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf].includes(marker);
}

/** 判断 JPEG 标记是否为不携带长度字段的独立标记。 */
function isJpegStandaloneMarker(marker) {
  return marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7);
}

/** 校验 WebP RIFF 与 chunk 边界，并要求尺寸元数据之外存在有效帧数据。 */
function detectWebp(bytes) {
  if (
    bytes.length < 20 ||
    bytes.toString("ascii", 0, 4) !== "RIFF" ||
    bytes.toString("ascii", 8, 12) !== "WEBP"
  ) return null;
  if (bytes.readUInt32LE(4) !== bytes.length - 8) return null;

  let offset = 12;
  let dimensions = null;
  let hasImageData = false;
  while (offset < bytes.length) {
    if (offset + 8 > bytes.length) return null;
    const chunkType = bytes.toString("ascii", offset, offset + 4);
    const dataLength = bytes.readUInt32LE(offset + 4);
    const dataOffset = offset + 8;
    const dataEnd = dataOffset + dataLength;
    const chunkEnd = dataEnd + (dataLength % 2);
    if (chunkEnd > bytes.length) return null;
    if (!dimensions && chunkType === "VP8X" && dataLength >= 10) {
      dimensions = {
        width: 1 + readUInt24LE(bytes, dataOffset + 4),
        height: 1 + readUInt24LE(bytes, dataOffset + 7),
      };
    } else if (chunkType === "VP8 ") {
      const frameDimensions = readWebpVp8Dimensions(bytes, dataOffset, dataLength);
      if (frameDimensions) {
        dimensions ||= frameDimensions;
        hasImageData = true;
      }
    } else if (chunkType === "VP8L") {
      const frameDimensions = readWebpVp8lDimensions(bytes, dataOffset, dataLength);
      if (frameDimensions) {
        dimensions ||= frameDimensions;
        hasImageData = true;
      }
    } else if (chunkType === "ANMF" && hasValidWebpAnimationFrame(bytes, dataOffset, dataLength)) {
      hasImageData = true;
    }
    offset = chunkEnd;
  }
  return dimensions && hasImageData ? { mediaType: "image/webp", ...dimensions } : null;
}

/** 读取带关键帧签名的 VP8 有损码流尺寸，非法或过短码流返回 null。 */
function readWebpVp8Dimensions(bytes, dataOffset, dataLength) {
  if (
    dataLength <= 10 ||
    dataOffset + dataLength > bytes.length ||
    bytes.toString("hex", dataOffset + 3, dataOffset + 6) !== "9d012a"
  ) return null;
  const width = bytes.readUInt16LE(dataOffset + 6) & 0x3fff;
  const height = bytes.readUInt16LE(dataOffset + 8) & 0x3fff;
  return width > 0 && height > 0 ? { width, height } : null;
}

/** 读取带 VP8L 签名的无损码流尺寸，非法或过短码流返回 null。 */
function readWebpVp8lDimensions(bytes, dataOffset, dataLength) {
  if (dataLength <= 5 || dataOffset + dataLength > bytes.length || bytes[dataOffset] !== 0x2f) return null;
  const bits = bytes.readUInt32LE(dataOffset + 1);
  if ((bits >>> 29) !== 0) return null;
  return {
    width: (bits & 0x3fff) + 1,
    height: ((bits >> 14) & 0x3fff) + 1,
  };
}

/** 校验 ANMF 帧头及内部子块边界，并要求唯一 VP8/VP8L 码流匹配帧尺寸。 */
function hasValidWebpAnimationFrame(bytes, dataOffset, dataLength) {
  const frameHeaderBytes = 16;
  const frameEnd = dataOffset + dataLength;
  if (dataLength < frameHeaderBytes + 13 || frameEnd > bytes.length) return false;
  const frameWidth = 1 + readUInt24LE(bytes, dataOffset + 6);
  const frameHeight = 1 + readUInt24LE(bytes, dataOffset + 9);
  if ((bytes[dataOffset + 15] & 0xfc) !== 0) return false;

  let offset = dataOffset + frameHeaderBytes;
  let imageDimensions = null;
  while (offset < frameEnd) {
    if (offset + 8 > frameEnd) return false;
    const chunkType = bytes.toString("ascii", offset, offset + 4);
    const nestedLength = bytes.readUInt32LE(offset + 4);
    const nestedDataOffset = offset + 8;
    const nestedDataEnd = nestedDataOffset + nestedLength;
    const nestedChunkEnd = nestedDataEnd + (nestedLength % 2);
    if (nestedChunkEnd > frameEnd) return false;
    const nestedDimensions = chunkType === "VP8 "
      ? readWebpVp8Dimensions(bytes, nestedDataOffset, nestedLength)
      : chunkType === "VP8L"
        ? readWebpVp8lDimensions(bytes, nestedDataOffset, nestedLength)
        : null;
    if (nestedDimensions) {
      if (imageDimensions) return false;
      imageDimensions = nestedDimensions;
    }
    offset = nestedChunkEnd;
  }
  return Boolean(
    imageDimensions &&
    imageDimensions.width === frameWidth &&
    imageDimensions.height === frameHeight,
  );
}

/** 从 Buffer 读取 24 位小端无符号整数。 */
function readUInt24LE(bytes, offset) {
  return bytes[offset] | (bytes[offset + 1] << 8) | (bytes[offset + 2] << 16);
}

/** 判断值是否为普通对象。 */
function isPlainObject(value) {
  return value !== null && typeof value === "object" && Object.getPrototypeOf(value) === Object.prototype;
}
