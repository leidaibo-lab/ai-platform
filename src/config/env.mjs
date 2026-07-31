import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { parseKeyPairsIntoRecord } from "@opentelemetry/core";

/**
 * 从项目环境文件生成 Demo Server、Runtime 和模型网关所需的分层配置。
 *
 * @param {string} rootDir - 项目根目录。
 * @returns {Promise<object>} 归一化后的 Demo 配置。
 */
export async function loadDemoConfig(rootDir) {
  const fileEnv = await loadEnv(join(rootDir, ".env"));
  const env = { ...fileEnv, ...process.env };
  const runTimeoutMs = readPositiveNumber(env.DEMO_RUN_TIMEOUT_MS, 120000);

  return {
    port: readPositiveNumber(env.DEMO_PORT, 4010),
    gateway: {
      baseUrl: trimTrailingSlash(env.LITELLM_BASE_URL || "http://localhost:4000"),
      model: env.LITELLM_MODEL || "chat-default",
      imageModel: env.LITELLM_IMAGE_MODEL || "image-default",
      apiKey: env.LITELLM_MASTER_KEY || "sk-local-admin-key",
      timeoutMs: runTimeoutMs,
      maxAttempts: readPositiveInteger(env.DEMO_MODEL_MAX_ATTEMPTS, 3),
      retryBaseDelayMs: readNonNegativeNumber(env.DEMO_MODEL_RETRY_BASE_DELAY_MS, 500),
      retryMaxDelayMs: readNonNegativeNumber(env.DEMO_MODEL_RETRY_MAX_DELAY_MS, 5000),
    },
    resilience: { runTimeoutMs },
    observability: {
      enabled: readBoolean(env.OTEL_ENABLED, false),
      endpoint:
        env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT ||
        env.OTEL_EXPORTER_OTLP_ENDPOINT ||
        "http://localhost:4318",
      headers: {
        ...parseOtlpHeaders(env.OTEL_EXPORTER_OTLP_HEADERS),
        ...parseOtlpHeaders(env.OTEL_EXPORTER_OTLP_TRACES_HEADERS),
      },
      timeoutMillis: readPositiveNumber(
        env.OTEL_EXPORTER_OTLP_TRACES_TIMEOUT || env.OTEL_EXPORTER_OTLP_TIMEOUT,
        10000,
      ),
      serviceName: env.OTEL_SERVICE_NAME || "ai-platform-demo",
      samplingRatio: readUnitInterval(env.OTEL_TRACES_SAMPLER_ARG, 1),
    },
    storage: {
      databasePath: resolve(rootDir, env.DEMO_DATABASE_PATH || ".data/ai-platform.sqlite"),
      imageAssetDirectory: resolve(rootDir, env.DEMO_IMAGE_ASSET_DIR || ".data/image-assets"),
    },
    context: {
      maxContextTokens: readPositiveNumber(env.DEMO_MAX_CONTEXT_TOKENS, 12000),
      reservedOutputTokens: readPositiveNumber(env.DEMO_RESERVED_OUTPUT_TOKENS, 2000),
      safetyTokens: readPositiveNumber(env.DEMO_CONTEXT_SAFETY_TOKENS, 500),
      highWatermarkRatio: readRatio(env.DEMO_CONTEXT_HIGH_WATERMARK_RATIO, 0.75),
      lowWatermarkRatio: readRatio(env.DEMO_CONTEXT_LOW_WATERMARK_RATIO, 0.45),
      hardWatermarkRatio: readRatio(env.DEMO_CONTEXT_HARD_WATERMARK_RATIO, 0.9),
    },
    memory: {
      maxCompletionTokens: readPositiveNumber(env.DEMO_MEMORY_MAX_COMPLETION_TOKENS, 1200),
    },
    tools: {
      maxSteps: readBoundedInteger(env.DEMO_TOOL_MAX_STEPS, 4, 1, 8),
      weatherEnabled: readBoolean(env.DEMO_WEATHER_TOOL_ENABLED, true),
      weatherTimeoutMs: readPositiveNumber(env.DEMO_WEATHER_TIMEOUT_MS, 8000),
    },
    prompts: {
      demoSystemPrompt:
        "你是 AI 应用基础平台 Demo 助手。请优先结合 active 结构化记忆、相关历史片段、最近对话和当前用户消息回答；用户最新纠正优先。涉及当前或明日天气时必须调用 get_weather，不得凭模型记忆声称实时结果；回答需说明地点、数据时间和来源。",
    },
  };
}

/**
 * 读取简单 KEY=VALUE 环境文件；文件不存在时返回空对象且不修改进程环境变量。
 *
 * @param {string} filePath - 环境文件路径。
 * @returns {Promise<Record<string, string>>} 文件中解析出的键值对。
 */
export async function loadEnv(filePath) {
  if (!existsSync(filePath)) return {};
  const content = await readFile(filePath, "utf8");

  // 将有效配置行累积为键值对象，并忽略空行、注释和无等号内容。
  return content.split(/\r?\n/).reduce((acc, line) => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) return acc;

    const index = trimmed.indexOf("=");
    if (index === -1) return acc;

    const key = trimmed.slice(0, index).trim();
    let value = trimmed.slice(index + 1).trim();
    value = value.replace(/^['"]|['"]$/g, "");
    acc[key] = value;
    return acc;
  }, {});
}

/**
 * 按 OpenTelemetry 标准 key=value 列表解析 OTLP header，百分号编码值会被安全解码。
 *
 * @param {unknown} value - `OTEL_EXPORTER_OTLP*_HEADERS` 原始值。
 * @returns {Record<string, string>} 可直接交给 OTLP exporter 的 header 副本。
 */
export function parseOtlpHeaders(value) {
  return { ...parseKeyPairsIntoRecord(typeof value === "string" ? value.trim() : "") };
}

/**
 * 统一移除基础地址末尾的斜杠，避免调用方拼接路径时产生重复分隔符。
 *
 * @param {unknown} value - 待处理的地址值。
 * @returns {string} 不含末尾斜杠的字符串。
 */
export function trimTrailingSlash(value) {
  return String(value || "").replace(/\/+$/, "");
}

// 将环境变量转换为正数配置，无效值回退到调用方提供的默认值。
function readPositiveNumber(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

/** 将环境变量转换为正整数配置，无效值回退到调用方提供的默认值。 */
function readPositiveInteger(value, fallback) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

/** 将环境变量限制为指定闭区间整数，异常值回退到默认值。 */
function readBoundedInteger(value, fallback, min, max) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= min && parsed <= max ? parsed : fallback;
}

/** 将环境变量转换为非负数配置，无效值回退到调用方提供的默认值。 */
function readNonNegativeNumber(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

/** 将环境变量转换为 0 到 1 之间的水位比例。 */
function readRatio(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 && parsed <= 1 ? parsed : fallback;
}

/** 将常见布尔字符串转换为开关，无效值回退到默认值。 */
function readBoolean(value, fallback) {
  if (typeof value === "boolean") return value;
  const normalized = String(value || "").trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "off"].includes(normalized)) return false;
  return fallback;
}

/** 将采样参数限制为包含 0 和 1 的单位区间。 */
function readUnitInterval(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 && parsed <= 1 ? parsed : fallback;
}
