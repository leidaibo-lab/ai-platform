import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

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
        "你是 AI Gateway Demo 助手。请优先结合提供的对话摘要、最近上下文和当前用户消息回答。",
      summarySystemPrompt: "你负责把历史对话压缩成可供下一轮模型理解的上下文摘要。",
    },
  };
}

export async function loadEnv(filePath) {
  if (!existsSync(filePath)) return {};
  const content = await readFile(filePath, "utf8");

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

export function trimTrailingSlash(value) {
  return String(value || "").replace(/\/+$/, "");
}

function readPositiveNumber(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}
