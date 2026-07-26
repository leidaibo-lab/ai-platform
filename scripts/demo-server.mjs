#!/usr/bin/env node
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { dirname, extname, join, normalize, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { loadDemoConfig } from "../src/config/env.mjs";
import { GatewayRequestError, createGatewayClient } from "../src/gateway/gateway-client.mjs";
import { RuntimeInputError, createChatRuntime } from "../src/runtime/chat-runtime.mjs";
import { createConversationCoordinator } from "../src/runtime/conversation-coordinator.mjs";
import { createContextPlanner } from "../src/runtime/context-planner.mjs";
import { createMemoryManager } from "../src/runtime/memory-manager.mjs";
import { ConversationStoreError, createConversationStore } from "../src/storage/conversation-store.mjs";

const rootDir = normalize(join(dirname(fileURLToPath(import.meta.url)), ".."));
const demoDir = join(rootDir, "demo");
const config = await loadDemoConfig(rootDir);
const store = createConversationStore(config.storage);
const gatewayClient = createGatewayClient(config.gateway);
const coordinator = createConversationCoordinator();
const contextPlanner = createContextPlanner({
  store,
  gatewayClient,
  contextOptions: config.context,
  systemPrompt: config.prompts.demoSystemPrompt,
});
const memoryManager = createMemoryManager({
  store,
  gatewayClient,
  contextOptions: config.context,
  memoryOptions: config.memory,
  onError: reportBackgroundMemoryError,
});
const chatRuntime = createChatRuntime({
  gatewayClient,
  contextOptions: config.context,
  store,
  coordinator,
  contextPlanner,
  memoryManager,
});

const mimeTypes = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
};

// 将网关、会话资源、Run、SSE 和静态文件分流到各自 Adapter。
const server = createServer(handleRequest);

/**
 * 解析并处理一个 Demo Server HTTP 请求。
 *
 * @param {import("node:http").IncomingMessage} req - HTTP 请求。
 * @param {import("node:http").ServerResponse} res - HTTP 响应。
 * @returns {Promise<void>}
 */
async function handleRequest(req, res) {
  try {
    const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
    if (req.method === "GET" && url.pathname === "/api/gateway/status") {
      sendJson(res, 200, await gatewayClient.status());
      return;
    }
    if (url.pathname === "/api/runtime/conversations") {
      await handleConversationCollection(req, res);
      return;
    }

    const route = parseConversationRoute(url.pathname);
    if (route) {
      await handleConversationRoute(req, res, url, route);
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
}

/** 创建或列出会话集合。 */
async function handleConversationCollection(req, res) {
  if (req.method === "GET") {
    sendJson(res, 200, { conversations: chatRuntime.listConversations() });
    return;
  }
  if (req.method === "POST") {
    sendJson(res, 201, chatRuntime.createConversation(await readJson(req)));
    return;
  }
  sendJson(res, 405, { error: "Method not allowed" });
}

/** 处理单个会话的详情、Run、关闭和事件流。 */
async function handleConversationRoute(req, res, url, route) {
  if (!route.action && req.method === "GET") {
    sendJson(res, 200, chatRuntime.getConversation(route.conversationId));
    return;
  }
  if (route.action === "runs" && req.method === "POST") {
    sendJson(res, 200, await chatRuntime.runConversation(route.conversationId, await readJson(req)));
    return;
  }
  if (route.action === "close" && req.method === "POST") {
    sendJson(res, 200, await chatRuntime.closeConversation(route.conversationId));
    return;
  }
  if (route.action === "events" && req.method === "GET") {
    openEventStream(req, res, url, route.conversationId);
    return;
  }
  sendJson(res, 405, { error: "Method not allowed" });
}

/** 将会话资源 URL 解析为 conversationId 和动作。 */
function parseConversationRoute(pathname) {
  const match = pathname.match(/^\/api\/runtime\/conversations\/([^/]+)(?:\/(runs|close|events))?$/);
  if (!match) return null;
  return { conversationId: decodeURIComponent(match[1]), action: match[2] || "" };
}

/**
 * 打开基于 SQLite 事件日志游标的 SSE 连接，支持多标签页增量刷新。
 *
 * @param {import("node:http").IncomingMessage} req - HTTP 请求。
 * @param {import("node:http").ServerResponse} res - HTTP 响应。
 * @param {URL} url - 已解析 URL。
 * @param {string} conversationId - 会话 ID。
 */
function openEventStream(req, res, url, conversationId) {
  chatRuntime.getConversation(conversationId);
  let cursor = Number(url.searchParams.get("after") || req.headers["last-event-id"] || 0);
  res.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
  });
  res.write(": connected\n\n");

  /** 查询并发送游标之后的事件。 */
  function sendAvailableEvents() {
    const events = store.listEventsAfter(conversationId, cursor);
    for (const event of events) {
      cursor = event.id;
      res.write(`id: ${event.id}\n`);
      res.write(`data: ${JSON.stringify(event)}\n\n`);
    }
  }

  /** 关闭连接时停止轮询，避免泄漏计时器。 */
  function closeStream() {
    clearInterval(timer);
  }

  sendAvailableEvents();
  const timer = setInterval(sendAvailableEvents, 750);
  req.on("close", closeStream);
}

/** 从受限 Demo 目录读取静态文件并阻止路径逃逸。 */
async function sendStatic(pathname, res) {
  const target = pathname === "/" ? "/index.html" : pathname;
  const filePath = normalize(join(demoDir, target));
  if (filePath !== demoDir && !filePath.startsWith(`${demoDir}${sep}`)) {
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

/** 将 Runtime、存储、网关和未知错误映射为稳定 JSON 响应。 */
function sendError(res, error) {
  if (res.headersSent) {
    res.end();
    return;
  }
  if (error instanceof RuntimeInputError) {
    sendJson(res, error.status, error.payload);
    return;
  }
  if (error instanceof ConversationStoreError) {
    sendJson(res, error.status, { error: error.message, code: error.code });
    return;
  }
  if (error instanceof GatewayRequestError) {
    sendJson(res, error.status, { error: error.message, status: error.status });
    return;
  }
  sendJson(res, 500, { error: error.message || "Unexpected error" });
}

/** 写入禁用缓存的 JSON 结果。 */
function sendJson(res, statusCode, payload) {
  if (res.headersSent) return;
  res.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });
  res.end(JSON.stringify(payload));
}

/** 聚合并解析受体积限制的 JSON 请求体。 */
function readJson(req) {
  // Node 请求流通过单个 Promise 聚合为 JSON 对象。
  return new Promise((resolve, reject) => {
    let raw = "";
    /** 累积请求块并阻止超大附件请求。 */
    function collectChunk(chunk) {
      raw += chunk;
      if (raw.length > 32 * 1024 * 1024) {
        reject(new Error("Request body is too large"));
        req.destroy();
      }
    }
    /** 请求结束后完成一次 JSON 解析。 */
    function parseBody() {
      try {
        resolve(raw ? JSON.parse(raw) : {});
      } catch {
        reject(new Error("Invalid JSON body"));
      }
    }
    req.on("data", collectChunk);
    req.on("end", parseBody);
    req.on("error", reject);
  });
}

/** 记录后台记忆任务失败，不影响已经完成的用户回复。 */
function reportBackgroundMemoryError(error) {
  console.error(`Memory compaction failed: ${error?.message || error}`);
}

/** 关闭 HTTP Server 和 SQLite 连接。 */
function shutdown() {
  server.close(closeStore);
}

/** HTTP Server 关闭后释放 SQLite 连接。 */
function closeStore() {
  store.close();
}

server.listen(config.port, reportReady);
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

/** 输出本地入口和实际模型别名。 */
function reportReady() {
  console.log(`AI Platform demo: http://localhost:${config.port}`);
  console.log(`Gateway base URL: ${gatewayClient.gatewayBaseUrl}`);
  console.log(`Model alias: ${gatewayClient.model}`);
  console.log(`Conversation database: ${config.storage.databasePath}`);
}
