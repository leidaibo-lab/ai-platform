#!/usr/bin/env node
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { dirname, extname, join, normalize, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { loadDemoConfig } from "../src/config/env.mjs";
import { createOpenMeteoWeatherConnector } from "../src/connectors/open-meteo-weather.mjs";
import { GatewayRequestError, createGatewayClient } from "../src/gateway/gateway-client.mjs";
import { initializeOpenTelemetry } from "../src/observability/otel-runtime.mjs";
import { RuntimeExecutionError, RuntimeInputError, createChatRuntime } from "../src/runtime/chat-runtime.mjs";
import { createConversationCoordinator } from "../src/runtime/conversation-coordinator.mjs";
import { createContextPlanner } from "../src/runtime/context-planner.mjs";
import { createMemoryManager } from "../src/runtime/memory-manager.mjs";
import { ConversationStoreError, createConversationStore } from "../src/storage/conversation-store.mjs";
import { createLocalImageAssetStore } from "../src/storage/image-asset-store.mjs";
import { createToolRegistry } from "../src/tools/tool-registry.mjs";
import { createWeatherToolDefinition } from "../src/tools/weather-tool.mjs";

const rootDir = normalize(join(dirname(fileURLToPath(import.meta.url)), ".."));
const demoDir = join(rootDir, "demo", "dist");
const config = await loadDemoConfig(rootDir);
const telemetryRuntime = initializeOpenTelemetry(config.observability);
const chainTracer = telemetryRuntime.chainTracer;
const store = createConversationStore(config.storage);
const imageAssetStore = createLocalImageAssetStore({ directory: config.storage.imageAssetDirectory });
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
const weatherConnector = createOpenMeteoWeatherConnector({ timeoutMs: config.tools.weatherTimeoutMs });
const toolRegistry = createToolRegistry(
  config.tools.weatherEnabled ? [createWeatherToolDefinition(weatherConnector)] : [],
);
const chatRuntime = createChatRuntime({
  gatewayClient,
  contextOptions: config.context,
  store,
  coordinator,
  contextPlanner,
  memoryManager,
  imageAssetStore,
  toolRegistry,
  toolOptions: { maxSteps: config.tools.maxSteps },
  chainTracer,
  resilienceOptions: config.resilience,
});

const mimeTypes = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
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
  if (!route.action && req.method === "PATCH") {
    sendJson(res, 200, chatRuntime.updateConversation(route.conversationId, await readJson(req)));
    return;
  }
  if (route.action === "runs" && req.method === "POST") {
    await runJsonConversation(req, res, route.conversationId);
    return;
  }
  if (route.action === "runs/stream" && req.method === "POST") {
    await streamConversationRun(req, res, route.conversationId);
    return;
  }
  if (route.action === "run/cancel" && req.method === "POST") {
    sendJson(res, 200, chatRuntime.cancelConversationRun(route.conversationId, route.runId));
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
  if (route.action === "image-asset-content" && req.method === "GET") {
    await sendImageAsset(res, route.conversationId, route.assetId);
    return;
  }
  sendJson(res, 405, { error: "Method not allowed" });
}

/** 读取 JSON Run，并保证最终 HTTP 交付发生在同一个 C1 根 Trace 内。 */
async function runJsonConversation(req, res, conversationId) {
  const body = await readJson(req);
  await runTracedConversation(conversationId, body, "json", {
    /** 在渠道交付阶段写入最终 JSON 响应。 */
    onCompleted(result) {
      sendJson(res, 200, result);
    },
    /** 在 JSON 请求被其他渠道主动取消时返回最终取消事实。 */
    onCancelled(result) {
      sendJson(res, 200, result);
    },
  });
}

/** 将会话资源 URL 解析为 conversationId 和动作。 */
function parseConversationRoute(pathname) {
  const match = pathname.match(/^\/api\/runtime\/conversations\/([^/]+)(?:\/(.+))?$/);
  if (!match) return null;
  const conversationId = decodeURIComponent(match[1]);
  const action = match[2] || "";
  if (["", "runs", "runs/stream", "close", "events"].includes(action)) {
    return { conversationId, action };
  }
  const imageAsset = action.match(/^image-assets\/([^/]+)\/content$/);
  if (imageAsset) {
    return {
      conversationId,
      action: "image-asset-content",
      assetId: decodeURIComponent(imageAsset[1]),
    };
  }
  const cancellation = action.match(/^runs\/([^/]+)\/cancel$/);
  if (!cancellation) return null;
  return {
    conversationId,
    action: "run/cancel",
    runId: decodeURIComponent(cancellation[1]),
  };
}

/**
 * 通过 POST SSE 交付模型文本增量，Runtime 完成后再发送持久化最终结果。
 *
 * @param {import("node:http").IncomingMessage} req - HTTP 请求。
 * @param {import("node:http").ServerResponse} res - HTTP 响应。
 * @param {string} conversationId - 会话 ID。
 */
async function streamConversationRun(req, res, conversationId) {
  const body = await readJson(req);
  res.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });
  res.write(": connected\n\n");

  /** 将已创建或幂等命中的 Run 身份发送给渠道。 */
  function sendRunStarted({ run, replayed }) {
    writeSseEvent(res, "run-started", {
      runId: run.id,
      requestId: run.requestId,
      status: run.status,
      replayed,
    });
  }

  /** 把单个模型文本增量立即写入当前 HTTP 响应。 */
  function sendTextDelta(delta) {
    writeSseEvent(res, "text-delta", { delta });
  }

  /** 将 Runtime 工具阶段映射为命名 SSE 事件，不发送工具输入或完整结果。 */
  function sendToolEvent(event) {
    writeSseEvent(res, `tool-${event.type}`, event);
  }

  /** 将已持久化图片资产引用作为结构化 SSE 事件交付。 */
  function sendArtifactCreated(artifact) {
    writeSseEvent(res, "artifact-created", artifact);
  }

  try {
    await runTracedConversation(conversationId, body, "sse", {
      onRunStarted: sendRunStarted,
      onToolEvent: sendToolEvent,
      onArtifactCreated: sendArtifactCreated,
      onTextDelta: sendTextDelta,
      /** 在渠道交付阶段写入最终 completed 事件。 */
      onCompleted(result) {
        writeSseEvent(res, "completed", result);
      },
      /** 把主动取消映射为独立终止事件，而不是普通 error。 */
      onCancelled(result) {
        writeSseEvent(res, "cancelled", result);
      },
      /** 把失败映射为稳定 error 事件，并在根 Trace 内完成交付。 */
      onError(error) {
        const mapped = mapHttpError(error);
        writeSseEvent(res, "error", { ...mapped.payload, status: mapped.statusCode });
      },
    });
  } finally {
    if (!res.writableEnded) res.end();
  }
}

/**
 * 在 `c1.conversation.run` 根 Span 内执行 Runtime，并组合业务 ID 与渠道最终交付。
 *
 * @param {string} conversationId - 会话 ID。
 * @param {object} body - 已解析 Run 输入。
 * @param {"json"|"sse"} transport - 当前渠道协议。
 * @param {object} delivery - 渠道回调。
 * @returns {Promise<object|null>} Runtime 结果；已交付 SSE 错误时返回 null。
 */
async function runTracedConversation(conversationId, body, transport, delivery) {
  const requestId = String(body?.requestId || "");
  const operation = body?.operation === "image.generate" ? "image.generate" : "conversation.chat";
  const scenarioId = operation === "image.generate" ? "C2" : "C1";
  const rootSpanName = operation === "image.generate" ? "c2.image.generate" : "c1.conversation.run";
  return chainTracer.withSpan(
    rootSpanName,
    buildRunTraceAttributes({ requestId, conversationId, transport, scenarioId, operation }),
    /** 在根 Span 生命周期内执行排队、Runtime 和最终渠道交付。 */
    async (rootSpan) => {
      let runId = null;
      let chainTraceId = null;
      try {
        const result = await chatRuntime.runConversation(conversationId, body, {
          /** Runtime 创建业务 Chain ID 后立即补到根 Span。 */
          onChainTraceStarted(input) {
            chainTraceId = input.chainTraceId;
            rootSpan.setAttribute("ai.platform.chain_trace_id", chainTraceId);
          },
          /** Run 创建或重放后补齐 Run ID，并继续通知渠道。 */
          async onRunStarted(input) {
            runId = input.run.id;
            chainTraceId = input.chainTraceId || chainTraceId;
            rootSpan.setAttributes({
              "ai.platform.run_id": runId,
              "ai.platform.chain_trace_id": chainTraceId,
              "ai.platform.run.replayed": input.replayed,
            });
            if (typeof delivery.onRunStarted === "function") await delivery.onRunStarted(input);
          },
          onToolEvent: delivery.onToolEvent,
          onArtifactCreated: delivery.onArtifactCreated,
          onTextDelta: delivery.onTextDelta,
        });
        const finalStatus = result.cancelled ? "cancelled" : "completed";
        rootSpan.setAttributes({
          "ai.platform.run.status": finalStatus,
          "ai.platform.run.replayed": result.replayed,
        });
        const finalDelivery = result.cancelled ? delivery.onCancelled : delivery.onCompleted;
        if (typeof finalDelivery === "function") {
          await chainTracer.withSpan(
            `channel.${transport}.delivery`,
            buildRunTraceAttributes({ requestId, conversationId, runId, chainTraceId, transport, status: finalStatus, scenarioId, operation }),
            /** 把最终完成或取消载荷交给当前渠道，Span 本身不记录载荷正文。 */
            () => finalDelivery(result),
          );
        }
        return result;
      } catch (error) {
        rootSpan.setAttribute("ai.platform.run.status", "failed");
        if (typeof delivery.onError !== "function") throw error;
        rootSpan.recordError(error);
        await chainTracer.withSpan(
          `channel.${transport}.delivery`,
          buildRunTraceAttributes({ requestId, conversationId, runId, chainTraceId, transport, status: "failed", scenarioId, operation }),
          /** 把脱敏后的公开错误交给当前渠道。 */
          () => delivery.onError(error),
        );
        return null;
      }
    },
  );
}

/** 生成根 Span 和渠道 Span 共用的安全业务关联属性。 */
function buildRunTraceAttributes({ requestId, conversationId, runId, chainTraceId, transport, status, scenarioId = "C1", operation = "conversation.chat" }) {
  return {
    "ai.platform.request_id": requestId,
    "ai.platform.conversation_id": conversationId,
    ...(runId ? { "ai.platform.run_id": runId } : {}),
    ...(chainTraceId ? { "ai.platform.chain_trace_id": chainTraceId } : {}),
    "ai.platform.scenario_id": scenarioId,
    "ai.platform.operation": operation,
    "ai.platform.channel.transport": transport,
    ...(status ? { "ai.platform.run.status": status } : {}),
  };
}

/** 读取当前会话拥有的图片资产并以受控 MIME 返回，不公开 storageKey 或物理路径。 */
async function sendImageAsset(res, conversationId, assetId) {
  const { asset, storageKey } = store.readImageAsset(conversationId, assetId);
  const content = await imageAssetStore.read(storageKey);
  res.writeHead(200, {
    "Content-Type": asset.mediaType,
    "Content-Length": String(content.length),
    "Cache-Control": "private, no-store",
    "Content-Disposition": `inline; filename="${asset.assetId}${extensionForImageMediaType(asset.mediaType)}"`,
    "X-Content-Type-Options": "nosniff",
  });
  res.end(content);
}

/** 将已校验图片 MIME 转换为下载文件扩展名。 */
function extensionForImageMediaType(mediaType) {
  if (mediaType === "image/jpeg") return ".jpg";
  if (mediaType === "image/webp") return ".webp";
  return ".png";
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
  const mapped = mapHttpError(error);
  sendJson(res, mapped.statusCode, mapped.payload);
}

/** 将 Runtime、存储、网关和未知错误统一映射为 HTTP 状态与公开载荷。 */
function mapHttpError(error) {
  if (error instanceof RuntimeInputError) return { statusCode: error.status, payload: error.payload };
  if (error instanceof RuntimeExecutionError) return { statusCode: error.status, payload: error.payload };
  if (error instanceof ConversationStoreError) {
    return { statusCode: error.status, payload: { error: error.message, code: error.code } };
  }
  if (error instanceof GatewayRequestError) {
    return { statusCode: error.status, payload: { error: error.message, status: error.status } };
  }
  return { statusCode: 500, payload: { error: error.message || "Unexpected error" } };
}

/** 写入一个 JSON SSE 事件；客户端断开后保持 Run 在服务端继续完成。 */
function writeSseEvent(res, eventName, payload) {
  if (res.destroyed || res.writableEnded) return;
  res.write(`event: ${eventName}\n`);
  res.write(`data: ${JSON.stringify(payload)}\n\n`);
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

let shutdownPromise = null;

/** 幂等关闭 HTTP Server、SQLite 和 OpenTelemetry，并报告关闭失败。 */
function shutdown() {
  if (!shutdownPromise) shutdownPromise = closeResources().catch(reportShutdownError);
  return shutdownPromise;
}

/** 停止接收请求后释放事实源，并刷新所有已结束 Span。 */
async function closeResources() {
  await closeHttpServer();
  try {
    store.close();
  } finally {
    await telemetryRuntime.shutdown();
  }
}

/** 将 HTTP Server close 回调转换为可等待的 Promise。 */
function closeHttpServer() {
  if (!server.listening) return Promise.resolve();
  return new Promise((resolve, reject) => {
    /** Server 停止监听后完成关闭等待。 */
    function handleClosed(error) {
      if (error) reject(error);
      else resolve();
    }
    server.close(handleClosed);
  });
}

/** 记录关闭阶段错误并设置失败退出码。 */
function reportShutdownError(error) {
  console.error(`Demo shutdown failed: ${error?.message || error}`);
  process.exitCode = 1;
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
  console.log(`ChainTrace OTel: ${telemetryRuntime.enabled ? "enabled" : "disabled"}`);
}
