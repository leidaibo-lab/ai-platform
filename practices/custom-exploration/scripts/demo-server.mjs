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
import { MAX_UPLOADED_IMAGE_BYTES } from "../src/runtime/image-generation-policy.mjs";
import { createMemoryManager } from "../src/runtime/memory-manager.mjs";
import { createRunEventSink } from "../src/runtime/run-event-sink.mjs";
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
const startupRecoveryReport = await chatRuntime.recoverInterruptedRuns();

/**
 * @typedef {object} ActiveRunRequest
 * @property {string} conversationId - 请求所属会话。
 * @property {string} requestId - 渠道生成的幂等请求 ID。
 * @property {AbortController} controller - 只由显式 requestId 取消入口触发的控制器。
 * @property {string|null} runId - Runtime 创建 Run 后关联的稳定 ID，分类阶段保持 null。
 */

// Registry 模式集中维护进程内 HTTP 请求执行权；连接断开不会触碰这里的取消控制器。
const activeRunRequests = new Map();

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
  if (route.action === "image-assets" && req.method === "POST") {
    await uploadImageAsset(req, res, route.conversationId);
    return;
  }
  if (route.action === "run/cancel" && req.method === "POST") {
    sendJson(res, 200, chatRuntime.cancelConversationRun(route.conversationId, route.runId));
    return;
  }
  if (route.action === "run-request/cancel" && req.method === "POST") {
    sendJson(res, 202, cancelActiveRunRequest(route.conversationId, route.requestId));
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
  if (["", "runs", "runs/stream", "close", "events", "image-assets"].includes(action)) {
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
  const requestCancellation = action.match(/^run-requests\/([^/]+)\/cancel$/);
  if (requestCancellation) {
    return {
      conversationId,
      action: "run-request/cancel",
      requestId: decodeURIComponent(requestCancellation[1]),
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

  const eventSubscriber = createSseRunEventSubscriber(res);

  try {
    await runTracedConversation(conversationId, body, "sse", {
      eventSubscribers: [eventSubscriber],
      streamText: true,
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
 * 在按请求模式命名的根 Span 内执行 Runtime，并组合真实 operation、业务 ID 与渠道最终交付。
 *
 * @param {string} conversationId - 会话 ID。
 * @param {object} body - 已解析 Run 输入。
 * @param {"json"|"sse"} transport - 当前渠道协议。
 * @param {object} delivery - 渠道终态回调和可选 Runtime 事件订阅者。
 * @returns {Promise<object|null>} Runtime 结果；已交付 SSE 错误时返回 null。
 */
async function runTracedConversation(conversationId, body, transport, delivery) {
  const requestId = String(body?.requestId || "");
  const activeRequest = registerActiveRunRequest(conversationId, requestId);
  const requestedOperation = String(body?.operation || "conversation.chat");
  const operation = ["auto", "image.generate", "image.edit"].includes(requestedOperation)
    ? requestedOperation
    : "conversation.chat";
  const scenarioId = operation === "auto" ? "AUTO" : operation.startsWith("image.") ? "C2" : "C1";
  const rootSpanName = operation === "auto"
    ? "runtime.auto.run"
    : operation.startsWith("image.")
      ? `c2.${operation}`
      : "c1.conversation.run";
  try {
    return await chainTracer.withSpan(
      rootSpanName,
      buildRunTraceAttributes({ requestId, conversationId, transport, scenarioId, operation }),
      /** 在根 Span 生命周期内执行排队、Runtime 和最终渠道交付。 */
      async (rootSpan) => {
        let runId = null;
        let chainTraceId = null;
        let resolvedOperation = operation;
        let resolvedScenarioId = scenarioId;
        const eventSink = createRunEventSink({
          subscribers: [
            /** 把 Runtime 关联事件写入当前根 Span，不依赖任何渠道协议。 */
            async function observeRuntimeIdentity(event) {
              if (event.type === "chain-trace.started") {
                chainTraceId = event.chainTraceId;
                rootSpan.setAttribute("ai.platform.chain_trace_id", chainTraceId);
                return;
              }
              if (event.type !== "run.started") return;
              runId = event.runId;
              associateActiveRunRequestWithRun(activeRequest, runId);
              chainTraceId = event.chainTraceId || chainTraceId;
              resolvedOperation = event.operation || resolvedOperation;
              resolvedScenarioId = resolvedOperation.startsWith("image.") ? "C2" : "C1";
              rootSpan.setAttributes({
                "ai.platform.run_id": runId,
                "ai.platform.chain_trace_id": chainTraceId,
                "ai.platform.run.replayed": event.replayed,
                "ai.platform.operation": resolvedOperation,
                "ai.platform.scenario_id": resolvedScenarioId,
              });
            },
            ...(delivery.eventSubscribers || []),
          ],
          /** 记录旁路订阅失败；不记录异常正文，也不改变 Runtime 执行事实。 */
          onSubscriberError(error) {
            rootSpan.recordError(error, { "ai.platform.event.subscriber.status": "failed" });
          },
        });
        try {
          const result = await chatRuntime.runConversation(conversationId, body, {
            abortSignal: activeRequest.controller.signal,
            eventSink,
            streamText: Boolean(delivery.streamText),
          });
          const finalStatus = result.cancelled ? "cancelled" : "completed";
          rootSpan.setAttributes({
            "ai.platform.run.status": finalStatus,
            "ai.platform.run.replayed": result.replayed,
          });
          const finalDelivery = result.cancelled ? delivery.onCancelled : delivery.onCompleted;
          if (typeof finalDelivery === "function") {
            try {
              await chainTracer.withSpan(
                `channel.${transport}.delivery`,
                buildRunTraceAttributes({ requestId, conversationId, runId, chainTraceId, transport, status: finalStatus, scenarioId: resolvedScenarioId, operation: resolvedOperation }),
                /** 把最终完成或取消载荷交给当前渠道，Span 本身不记录载荷正文。 */
                () => finalDelivery(result),
              );
              rootSpan.setAttribute("ai.platform.delivery.status", "completed");
            } catch {
              // 子 Span 已记录脱敏异常；终态后的投递失败不得反向改写 Run 执行状态。
              rootSpan.setAttribute("ai.platform.delivery.status", "failed");
            }
          }
          return result;
        } catch (error) {
          if (activeRequest.controller.signal.aborted && !runId) {
            const result = buildPreRunCancellationResult(requestId);
            rootSpan.setAttribute("ai.platform.request.status", "cancelled_before_run");
            if (typeof delivery.onCancelled === "function") {
              try {
                await chainTracer.withSpan(
                  `channel.${transport}.delivery`,
                  buildRunTraceAttributes({ requestId, conversationId, chainTraceId, transport, scenarioId: resolvedScenarioId, operation: resolvedOperation }),
                  /** 交付未创建 Run 的请求级取消事实，不写入虚假的 Run 状态属性。 */
                  () => delivery.onCancelled(result),
                );
                rootSpan.setAttribute("ai.platform.delivery.status", "completed");
              } catch {
                // 请求已经取消；渠道投递失败只记旁路状态，不补造 Run 或错误事实。
                rootSpan.setAttribute("ai.platform.delivery.status", "failed");
              }
            }
            return result;
          }
          rootSpan.setAttribute("ai.platform.run.status", "failed");
          if (typeof delivery.onError !== "function") throw error;
          rootSpan.recordError(error);
          await chainTracer.withSpan(
            `channel.${transport}.delivery`,
            buildRunTraceAttributes({ requestId, conversationId, runId, chainTraceId, transport, status: "failed", scenarioId: resolvedScenarioId, operation: resolvedOperation }),
            /** 把脱敏后的公开错误交给当前渠道。 */
            () => delivery.onError(error),
          );
          return null;
        }
      },
    );
  } finally {
    unregisterActiveRunRequest(activeRequest);
  }
}

/** 登记一个 HTTP Run 请求执行实例，允许相同幂等 ID 的并发重放被统一取消。 */
function registerActiveRunRequest(conversationId, requestId) {
  let requestsById = activeRunRequests.get(conversationId);
  if (!requestsById) {
    requestsById = new Map();
    activeRunRequests.set(conversationId, requestsById);
  }
  let executions = requestsById.get(requestId);
  if (!executions) {
    executions = new Set();
    requestsById.set(requestId, executions);
  }
  const execution = {
    conversationId,
    requestId,
    controller: new AbortController(),
    runId: null,
  };
  executions.add(execution);
  return execution;
}

/** 在 Runtime 发布 run.started 后，把请求级取消入口与真实 Run 身份关联。 */
function associateActiveRunRequestWithRun(execution, runId) {
  execution.runId = String(runId || "") || null;
}

/** 从请求注册表移除一个已经终止的 HTTP 执行，并清理空索引。 */
function unregisterActiveRunRequest(execution) {
  const requestsById = activeRunRequests.get(execution.conversationId);
  const executions = requestsById?.get(execution.requestId);
  if (!executions) return;
  executions.delete(execution);
  if (executions.size === 0) requestsById.delete(execution.requestId);
  if (requestsById.size === 0) activeRunRequests.delete(execution.conversationId);
}

/**
 * 显式取消当前进程中匹配 conversationId 与 requestId 的全部活动 HTTP 执行。
 *
 * @returns {{cancellationRequested: true, requestId: string, runId: string|null}} 已接受的取消动作。
 */
function cancelActiveRunRequest(conversationId, requestId) {
  chatRuntime.getConversation(conversationId);
  const executions = activeRunRequests.get(conversationId)?.get(requestId);
  if (!executions || executions.size === 0) {
    throw new RuntimeInputError({
      error: "Run request is not active",
      code: "run_request_not_active",
    }, 404);
  }
  let runId = null;
  for (const execution of [...executions]) {
    runId ||= execution.runId;
    if (!execution.controller.signal.aborted) {
      execution.controller.abort(new DOMException("Run request was cancelled by user", "AbortError"));
    }
  }
  return { cancellationRequested: true, requestId, runId };
}

/** 构造分类完成前的渠道取消终态，显式声明没有 Run 或助手消息事实。 */
function buildPreRunCancellationResult(requestId) {
  return {
    cancelled: true,
    requestId,
    run: null,
    assistantMessage: null,
    content: "",
    artifacts: [],
    replayed: false,
  };
}

/**
 * 创建 Runtime Event 到 POST SSE 的渠道 Adapter，只暴露稳定公开字段。
 *
 * @param {import("node:http").ServerResponse} res - 当前 SSE 响应。
 * @returns {(event: object) => void} Runtime 事件订阅者。
 */
function createSseRunEventSubscriber(res) {
  /** 将一个 Runtime 生命周期事件映射为现有 SSE 事件名与公开载荷。 */
  return function sendRuntimeEvent(event) {
    if (event.type === "run.started") {
      writeSseEvent(res, "run-started", {
        runId: event.runId,
        requestId: event.requestId,
        operation: event.operation,
        status: event.status,
        replayed: event.replayed,
      });
      return;
    }
    if (event.type === "text.delta") {
      writeSseEvent(res, "text-delta", { delta: event.delta });
      return;
    }
    if (event.type.startsWith("tool.")) {
      writeSseEvent(res, event.type.replace("tool.", "tool-"), {
        type: event.type.slice("tool.".length),
        toolCallId: event.toolCallId,
        toolName: event.toolName,
        title: event.title,
        status: event.status,
        source: event.source,
        observedAt: event.observedAt,
        error: event.error,
      });
      return;
    }
    if (event.type === "artifact.created") writeSseEvent(res, "artifact-created", event.artifact);
  };
}

/** 读取并登记一张会话级受控源图片，上传本身不创建 Run。 */
async function uploadImageAsset(req, res, conversationId) {
  const mediaType = normalizeUploadMediaType(req.headers["content-type"]);
  if (!mediaType) {
    req.resume();
    throw new RuntimeInputError({
      error: "Only PNG, JPEG, or WebP image uploads are supported",
      code: "unsupported_image_media_type",
    });
  }
  const bytes = await readBinaryBody(req, MAX_UPLOADED_IMAGE_BYTES);
  const asset = await chatRuntime.uploadImageAsset(conversationId, { bytes, mediaType });
  sendJson(res, 201, asset);
}

/** 从 Content-Type 读取平台允许的图片 MIME，忽略可选参数。 */
function normalizeUploadMediaType(value) {
  const mediaType = String(value || "").split(";", 1)[0].trim().toLowerCase();
  return ["image/png", "image/jpeg", "image/webp"].includes(mediaType) ? mediaType : "";
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
  // Promise executor 只桥接 Node JSON 请求流与解析/体积错误。
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

/** 聚合受硬上限保护的二进制请求体，超限时返回稳定 413 输入错误。 */
function readBinaryBody(req, maxBytes) {
  const declaredLength = Number(req.headers["content-length"]);
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
    req.resume();
    return Promise.reject(new RuntimeInputError({
      error: "Uploaded image is too large",
      code: "uploaded_image_too_large",
    }, 413));
  }
  // Promise executor 只桥接 Node 二进制请求流与稳定的体积上限错误。
  return new Promise((resolve, reject) => {
    const chunks = [];
    let sizeBytes = 0;
    let tooLarge = false;
    /** 累积一个二进制块，达到上限后继续消费连接但不再保留内容。 */
    function collectBinaryChunk(chunk) {
      if (tooLarge) return;
      sizeBytes += chunk.length;
      if (sizeBytes > maxBytes) {
        tooLarge = true;
        reject(new RuntimeInputError({
          error: "Uploaded image is too large",
          code: "uploaded_image_too_large",
        }, 413));
        return;
      }
      chunks.push(chunk);
    }
    /** 请求结束时组合完整 Buffer；超限请求已经由首次错误收口。 */
    function finishBinaryBody() {
      if (!tooLarge) resolve(Buffer.concat(chunks, sizeBytes));
    }
    req.on("data", collectBinaryChunk);
    req.on("end", finishBinaryBody);
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
  // Promise executor 只桥接 Node HTTP Server 的错误优先关闭回调。
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

reportStartupRecovery(startupRecoveryReport);
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

/** 输出不含消息正文和 ToolResult 数据的启动恢复摘要。 */
function reportStartupRecovery(report) {
  if (!report || report.scanned === 0) return;
  console.log(
    `Runtime startup recovery: scanned=${report.scanned} recovered=${report.recovered} failed=${report.failed} skipped=${report.skipped}`,
  );
  for (const outcome of report.outcomes || []) {
    console.log(
      `Runtime startup recovery outcome: runId=${outcome.runId} status=${outcome.status} reason=${outcome.reasonCode}`,
    );
  }
}
