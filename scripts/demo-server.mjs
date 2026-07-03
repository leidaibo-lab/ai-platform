#!/usr/bin/env node
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = normalize(join(fileURLToPath(import.meta.url), "..", ".."));
const demoDir = join(rootDir, "demo");
const env = await loadEnv(join(rootDir, ".env"));

const port = Number(env.DEMO_PORT || 4010);
const gatewayBaseUrl = trimTrailingSlash(env.LITELLM_BASE_URL || "http://localhost:4000");
const model = env.LITELLM_MODEL || "chat-default";
const apiKey = env.LITELLM_MASTER_KEY || "sk-local-admin-key";
const maxContextTokens = Number(env.DEMO_MAX_CONTEXT_TOKENS || 12000);
const reservedOutputTokens = Number(env.DEMO_RESERVED_OUTPUT_TOKENS || 2000);
const maxHistoryMessageTokens = Number(env.DEMO_MAX_HISTORY_MESSAGE_TOKENS || 1200);
const maxSummaryTokens = Number(env.DEMO_MAX_SUMMARY_TOKENS || 1600);
const demoSystemPrompt = "你是 AI Gateway Demo 助手。请优先结合提供的对话摘要、最近上下文和当前用户消息回答。";

const mimeTypes = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
};

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);

    if (req.method === "GET" && url.pathname === "/api/status") {
      await sendStatus(res);
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/chat") {
      await sendChat(req, res);
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/summarize") {
      await sendSummary(req, res);
      return;
    }

    if (req.method === "GET") {
      await sendStatic(url.pathname, res);
      return;
    }

    sendJson(res, 405, { error: "Method not allowed" });
  } catch (error) {
    sendJson(res, 500, { error: error.message || "Unexpected error" });
  }
});

server.listen(port, () => {
  console.log(`AI Gateway demo: http://localhost:${port}`);
  console.log(`Gateway base URL: ${gatewayBaseUrl}/v1`);
  console.log(`Model alias: ${model}`);
});

async function loadEnv(filePath) {
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

async function sendStatus(res) {
  try {
    const upstreamRes = await fetch(`${gatewayBaseUrl}/v1/models`, {
      headers: authHeaders(),
      signal: AbortSignal.timeout(5000),
    });
    sendJson(res, 200, {
      ok: upstreamRes.ok,
      status: upstreamRes.status,
      gatewayBaseUrl: `${gatewayBaseUrl}/v1`,
      model,
    });
  } catch (error) {
    sendJson(res, 200, {
      ok: false,
      gatewayBaseUrl: `${gatewayBaseUrl}/v1`,
      model,
      error: error.message,
    });
  }
}

async function sendChat(req, res) {
  const body = await readJson(req);
  const message = String(body.message || "").trim();
  const imageUrls = normalizeUrlList(body.imageUrls);
  const documentUrls = normalizeUrlList(body.documentUrls);
  const history = normalizeHistory(body.history);
  const summary = normalizeSummary(body.summary);

  if (!message && imageUrls.length === 0 && documentUrls.length === 0) {
    sendJson(res, 400, { error: "Message, image, or document link is required" });
    return;
  }

  const invalidUrls = [...imageUrls, ...documentUrls].filter((url) => !isSupportedUrl(url));
  if (invalidUrls.length > 0) {
    sendJson(res, 400, {
      error: "Only http(s) URLs and image data URLs are supported",
      invalidUrls,
    });
    return;
  }

  const content = buildUserContent({ message, imageUrls, documentUrls });
  const { messages, contextTokens } = buildMessagesWithBudget({ summary, history, content });

  const upstreamRes = await fetch(`${gatewayBaseUrl}/v1/chat/completions`, {
    method: "POST",
    headers: {
      ...authHeaders(),
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model,
      messages,
    }),
    signal: AbortSignal.timeout(120000),
  });

  const text = await upstreamRes.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    data = { error: text };
  }

  if (!upstreamRes.ok) {
    sendJson(res, upstreamRes.status, {
      error: data?.error?.message || data?.error || "Gateway request failed",
      status: upstreamRes.status,
    });
    return;
  }

  sendJson(res, 200, {
    content: data?.choices?.[0]?.message?.content || "",
    usage: data?.usage || null,
    model: data?.model || model,
    context: {
      messages: messages.length,
      estimatedTokens: contextTokens,
      budget: maxContextTokens,
      historyReceived: history.length,
      historySent: Math.max(0, messages.length - 2 - (summary ? 1 : 0)),
      hasSummary: Boolean(summary),
    },
  });
}

async function sendSummary(req, res) {
  const body = await readJson(req);
  const summary = normalizeSummary(body.summary);
  const messages = normalizeHistory(body.messages);

  if (messages.length === 0) {
    sendJson(res, 400, { error: "Messages are required for summary" });
    return;
  }

  const summaryPrompt = [
    "请更新一份用于后续多轮对话的中文上下文摘要。",
    "要求：保留用户目标、关键事实、已做决定、代码/文件名、未完成事项；删除寒暄和重复内容。",
    `摘要不超过 ${maxSummaryTokens} 个估算 token。`,
    "",
    summary ? `已有摘要：\n${summary}` : "已有摘要：无",
    "",
    "新增对话：",
    ...messages.map((item) => `${item.role === "user" ? "用户" : "助手"}：${item.content}`),
  ].join("\n");

  const upstreamRes = await fetch(`${gatewayBaseUrl}/v1/chat/completions`, {
    method: "POST",
    headers: {
      ...authHeaders(),
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model,
      messages: [
        { role: "system", content: "你负责把历史对话压缩成可供下一轮模型理解的上下文摘要。" },
        { role: "user", content: summaryPrompt },
      ],
      temperature: 0.2,
    }),
    signal: AbortSignal.timeout(120000),
  });

  const text = await upstreamRes.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    data = { error: text };
  }

  if (!upstreamRes.ok) {
    sendJson(res, upstreamRes.status, {
      error: data?.error?.message || data?.error || "Summary request failed",
      status: upstreamRes.status,
    });
    return;
  }

  sendJson(res, 200, {
    summary: limitByEstimatedTokens(data?.choices?.[0]?.message?.content || "", maxSummaryTokens),
    usage: data?.usage || null,
    model: data?.model || model,
  });
}

async function sendStatic(pathname, res) {
  const target = pathname === "/" ? "/index.html" : pathname;
  const filePath = normalize(join(demoDir, target));
  if (!filePath.startsWith(demoDir)) {
    sendJson(res, 403, { error: "Forbidden" });
    return;
  }

  try {
    const content = await readFile(filePath);
    res.writeHead(200, {
      "Content-Type": mimeTypes[extname(filePath)] || "application/octet-stream",
      "Cache-Control": "no-store",
    });
    res.end(content);
  } catch {
    sendJson(res, 404, { error: "Not found" });
  }
}

function authHeaders() {
  return { Authorization: `Bearer ${apiKey}` };
}

function sendJson(res, statusCode, payload) {
  res.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });
  res.end(JSON.stringify(payload));
}

function buildMessagesWithBudget({ summary, history, content }) {
  const systemMessage = { role: "system", content: demoSystemPrompt };
  const currentMessage = { role: "user", content };
  const summaryMessage = summary
    ? { role: "system", content: `此前对话摘要：\n${limitByEstimatedTokens(summary, maxSummaryTokens)}` }
    : null;
  const fixedMessages = [systemMessage, summaryMessage, currentMessage].filter(Boolean);
  const fixedTokens =
    reservedOutputTokens + fixedMessages.reduce((total, item) => total + estimateMessageTokens(item), 0);
  const historyBudget = Math.max(0, maxContextTokens - fixedTokens);
  const selectedHistory = [];
  let historyTokens = 0;

  for (const item of history.slice().reverse()) {
    const clipped = {
      role: item.role,
      content: limitByEstimatedTokens(item.content, maxHistoryMessageTokens),
    };
    const tokens = estimateMessageTokens(clipped);
    if (historyTokens + tokens > historyBudget) break;
    selectedHistory.unshift(clipped);
    historyTokens += tokens;
  }

  return {
    messages: [systemMessage, ...(summaryMessage ? [summaryMessage] : []), ...selectedHistory, currentMessage],
    contextTokens: fixedTokens + historyTokens,
  };
}

function normalizeHistory(value) {
  if (!Array.isArray(value)) return [];
  return value
    .slice(-48)
    .map((item) => {
      const role = item?.role === "assistant" ? "assistant" : item?.role === "user" ? "user" : "";
      const content = String(item?.content || "").trim();
      if (!role || !content) return null;
      return { role, content: limitByEstimatedTokens(content, maxHistoryMessageTokens * 2) };
    })
    .filter(Boolean);
}

function normalizeSummary(value) {
  return limitByEstimatedTokens(String(value || "").trim(), maxSummaryTokens);
}

function estimateMessageTokens(message) {
  const roleTokens = 4;
  if (Array.isArray(message.content)) {
    return (
      roleTokens +
      message.content.reduce((total, part) => {
        if (part?.type === "image_url") return total + 260;
        return total + estimateTokens(String(part?.text || ""));
      }, 0)
    );
  }
  return roleTokens + estimateTokens(String(message.content || ""));
}

function estimateTokens(value) {
  return Math.ceil(String(value || "").length / 2);
}

function limitByEstimatedTokens(value, maxTokens) {
  const text = String(value || "");
  if (estimateTokens(text) <= maxTokens) return text;
  const maxChars = Math.max(0, maxTokens * 2);
  return `${text.slice(0, maxChars)}\n...[内容已截断]`;
}

function buildUserContent({ message, imageUrls, documentUrls }) {
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

function formatDocumentLinks(documentUrls) {
  if (documentUrls.length === 0) return "";
  return `参考文档链接：\n${documentUrls.map((url) => `- ${url}`).join("\n")}`;
}

function normalizeUrlList(value) {
  const list = Array.isArray(value) ? value : String(value || "").split(/[\s,，]+/);
  return [...new Set(list.map((url) => String(url).trim()).filter(Boolean))];
}

function isSupportedUrl(value) {
  if (/^data:image\/[a-z0-9.+-]+;base64,/i.test(value)) return true;
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let raw = "";
    req.on("data", (chunk) => {
      raw += chunk;
      if (raw.length > 32 * 1024 * 1024) {
        reject(new Error("Request body is too large"));
        req.destroy();
      }
    });
    req.on("end", () => {
      try {
        resolve(raw ? JSON.parse(raw) : {});
      } catch {
        reject(new Error("Invalid JSON body"));
      }
    });
    req.on("error", reject);
  });
}

function trimTrailingSlash(value) {
  return value.replace(/\/+$/, "");
}
