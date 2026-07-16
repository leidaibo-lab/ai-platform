#!/usr/bin/env node
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { dirname, extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { loadDemoConfig } from "../src/config/env.mjs";
import { GatewayRequestError, createLiteLlmClient } from "../src/gateway/litellm-client.mjs";
import { RuntimeInputError, createChatRuntime } from "../src/runtime/chat-runtime.mjs";

const rootDir = normalize(join(dirname(fileURLToPath(import.meta.url)), ".."));
const demoDir = join(rootDir, "demo");
const config = await loadDemoConfig(rootDir);
const gatewayClient = createLiteLlmClient(config.gateway);
const chatRuntime = createChatRuntime({
  gatewayClient,
  contextOptions: config.context,
  systemPrompt: config.prompts.demoSystemPrompt,
  summarySystemPrompt: config.prompts.summarySystemPrompt,
});

const mimeTypes = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
};

// 将渠道 API 和静态资源请求分流到对应处理函数，并统一收口未捕获错误。
const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);

    if (req.method === "GET" && url.pathname === "/api/gateway/status") {
      await sendGatewayStatus(res);
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/runtime/chat") {
      await sendRuntimeChat(req, res);
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/runtime/summaries") {
      await sendRuntimeSummary(req, res);
      return;
    }

    if (url.pathname.startsWith("/api/")) {
      sendJson(res, 404, { error: "API endpoint not found" });
      return;
    }

    if (req.method === "GET") {
      await sendStatic(url.pathname, res);
      return;
    }

    sendJson(res, 405, { error: "Method not allowed" });
  } catch (error) {
    sendError(res, error);
  }
});

// 服务开始监听后输出本地入口和实际使用的网关配置，便于启动验证。
server.listen(config.port, () => {
  console.log(`AI Platform demo: http://localhost:${config.port}`);
  console.log(`Gateway base URL: ${gatewayClient.gatewayBaseUrl}`);
  console.log(`Model alias: ${gatewayClient.model}`);
});

/**
 * 查询模型网关健康状态并写入渠道响应。
 *
 * @param {import("node:http").ServerResponse} res - HTTP 响应对象。
 * @returns {Promise<void>}
 */
async function sendGatewayStatus(res) {
  sendJson(res, 200, await gatewayClient.status());
}

/**
 * 读取聊天请求体、调用 Runtime，并将业务错误映射为统一 HTTP 响应。
 *
 * @param {import("node:http").IncomingMessage} req - HTTP 请求对象。
 * @param {import("node:http").ServerResponse} res - HTTP 响应对象。
 * @returns {Promise<void>}
 */
async function sendRuntimeChat(req, res) {
  try {
    const body = await readJson(req);
    sendJson(res, 200, await chatRuntime.chat(body));
  } catch (error) {
    sendError(res, error);
  }
}

/**
 * 读取摘要请求体、调用 Runtime，并将业务错误映射为统一 HTTP 响应。
 *
 * @param {import("node:http").IncomingMessage} req - HTTP 请求对象。
 * @param {import("node:http").ServerResponse} res - HTTP 响应对象。
 * @returns {Promise<void>}
 */
async function sendRuntimeSummary(req, res) {
  try {
    const body = await readJson(req);
    sendJson(res, 200, await chatRuntime.summarize(body));
  } catch (error) {
    sendError(res, error);
  }
}

/**
 * 从受限 Demo 目录读取静态文件，阻止路径逃逸并禁用浏览器缓存。
 *
 * @param {string} pathname - 请求路径。
 * @param {import("node:http").ServerResponse} res - HTTP 响应对象。
 * @returns {Promise<void>}
 */
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

/**
 * 按 Runtime、模型网关和未知错误的层级生成稳定的渠道错误响应。
 *
 * @param {import("node:http").ServerResponse} res - HTTP 响应对象。
 * @param {Error} error - 待映射错误。
 * @returns {void}
 */
function sendError(res, error) {
  if (error instanceof RuntimeInputError) {
    sendJson(res, error.status, error.payload);
    return;
  }

  if (error instanceof GatewayRequestError) {
    sendJson(res, error.status, {
      error: error.message,
      status: error.status,
    });
    return;
  }

  sendJson(res, 500, { error: error.message || "Unexpected error" });
}

/**
 * 在响应尚未发送时写入禁用缓存的 JSON 结果。
 *
 * @param {import("node:http").ServerResponse} res - HTTP 响应对象。
 * @param {number} statusCode - HTTP 状态码。
 * @param {unknown} payload - 可序列化响应数据。
 * @returns {void}
 */
function sendJson(res, statusCode, payload) {
  if (res.headersSent) return;

  res.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });
  res.end(JSON.stringify(payload));
}

/**
 * 聚合并解析 JSON 请求体，同时限制体积以保护本地 Demo Server。
 *
 * @param {import("node:http").IncomingMessage} req - HTTP 请求对象。
 * @returns {Promise<object>} 解析后的 JSON 对象。
 */
function readJson(req) {
  // 将请求流事件转换为一次性 JSON 解析 Promise。
  return new Promise((resolve, reject) => {
    let raw = "";

    // 累积请求块并在超过 Demo 附件体积上限时终止连接。
    req.on("data", (chunk) => {
      raw += chunk;
      if (raw.length > 32 * 1024 * 1024) {
        reject(new Error("Request body is too large"));
        req.destroy();
      }
    });

    // 请求读取完成后解析 JSON，空请求体按空对象处理。
    req.on("end", () => {
      try {
        resolve(raw ? JSON.parse(raw) : {});
      } catch {
        reject(new Error("Invalid JSON body"));
      }
    });

    // 将底层请求流错误原样传递给调用方的异常处理边界。
    req.on("error", reject);
  });
}
