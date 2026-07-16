import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

/**
 * 从项目环境文件生成 Demo Server、Runtime 和模型网关所需的分层配置。
 *
 * @param {string} rootDir - 项目根目录。
 * @returns {Promise<object>} 归一化后的 Demo 配置。
 */
export async function loadDemoConfig(rootDir) {
  const env = await loadEnv(join(rootDir, ".env"));

  return {
    port: readPositiveNumber(env.DEMO_PORT, 4010),
    gateway: {
      baseUrl: trimTrailingSlash(env.LITELLM_BASE_URL || "http://localhost:4000"),
      model: env.LITELLM_MODEL || "chat-default",
      apiKey: env.LITELLM_MASTER_KEY || "sk-local-admin-key",
    },
    context: {
      maxContextTokens: readPositiveNumber(env.DEMO_MAX_CONTEXT_TOKENS, 12000),
      reservedOutputTokens: readPositiveNumber(env.DEMO_RESERVED_OUTPUT_TOKENS, 2000),
      maxHistoryMessageTokens: readPositiveNumber(env.DEMO_MAX_HISTORY_MESSAGE_TOKENS, 1200),
      maxSummaryTokens: readPositiveNumber(env.DEMO_MAX_SUMMARY_TOKENS, 1600),
    },
    prompts: {
      demoSystemPrompt:
        "你是 AI 应用基础平台 Demo 助手。请优先结合提供的对话摘要、最近上下文和当前用户消息回答。",
      summarySystemPrompt: "你负责把历史对话压缩成可供下一轮模型理解的上下文摘要。",
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
