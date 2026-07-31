/**
 * @typedef {object} RuntimeAdapterOptions
 * @property {typeof fetch} [fetchImpl] - 可注入的 Fetch Port，测试用 fake 实现替代浏览器网络。
 * @property {(url: string) => EventSource} [eventSourceFactory] - 会话事实流连接工厂。
 */

/**
 * @typedef {object} RunStreamHandlers
 * @property {(event: object) => Promise<void>|void} [onRunStarted] - 接收稳定 Run 身份。
 * @property {(event: object) => Promise<void>|void} [onToolEvent] - 接收服务端工具开始、完成或失败事实。
 * @property {(delta: string) => Promise<void>|void} [onTextDelta] - 接收单个文本增量。
 * @property {(result: object) => Promise<void>|void} [onCompleted] - 接收完成事实。
 * @property {(result: object) => Promise<void>|void} [onCancelled] - 接收取消事实。
 */

/** 渠道 Adapter 的公开错误，仅保留服务端允许展示的消息和状态。 */
export class RuntimeAdapterError extends Error {
  /**
   * @param {string} message - 用户可见错误消息。
   * @param {number|null} [status] - 可选 HTTP 状态。
   * @param {object|null} [payload] - 可选公开错误载荷。
   */
  constructor(message, status = null, payload = null) {
    super(message);
    this.name = "RuntimeAdapterError";
    this.status = status;
    this.payload = payload;
  }
}

/**
 * 通过 Adapter 模式把现有 JSON、POST SSE 和事实 SSE 契约收口为渠道方法。
 *
 * @param {RuntimeAdapterOptions} [options] - 网络 Port 注入配置。
 * @returns {object} 与 UI 框架无关的 Runtime API。
 */
export function createRuntimeAdapter({
  fetchImpl = globalThis.fetch?.bind(globalThis),
  eventSourceFactory = createBrowserEventSource,
} = {}) {
  if (typeof fetchImpl !== "function") throw new TypeError("A fetch implementation is required");

  return {
    /** 查询模型网关公开状态。 */
    getGatewayStatus() {
      return requestJson(fetchImpl, "/api/gateway/status");
    },

    /** 列出 SQLite 事实源中的会话摘要。 */
    async listConversations() {
      const data = await requestJson(fetchImpl, "/api/runtime/conversations");
      return Array.isArray(data.conversations) ? data.conversations : [];
    },

    /** 创建新的 active 会话。 */
    createConversation(input = {}) {
      return requestJson(fetchImpl, "/api/runtime/conversations", { method: "POST", body: input });
    },

    /** 获取会话、消息、Run 和结构化记忆完整事实。 */
    getConversation(conversationId) {
      return requestJson(fetchImpl, conversationPath(conversationId));
    },

    /** 更新服务端会话标题或独立归档状态。 */
    updateConversation(conversationId, input) {
      return requestJson(fetchImpl, conversationPath(conversationId), { method: "PATCH", body: input });
    },

    /** 完成最终 checkpoint 并关闭会话。 */
    closeConversation(conversationId) {
      return requestJson(fetchImpl, `${conversationPath(conversationId)}/close`, { method: "POST", body: {} });
    },

    /** 显式取消服务端 Runtime Run，而不是只关闭浏览器读取。 */
    cancelRun(conversationId, runId) {
      return requestJson(
        fetchImpl,
        `${conversationPath(conversationId)}/runs/${encodeURIComponent(runId)}/cancel`,
        { method: "POST", body: {} },
      );
    },

    /** 读取一次 POST SSE Run，并把唯一终止事实返回给调用方。 */
    runConversationStream(conversationId, input, handlers = {}) {
      return requestRunStream(fetchImpl, `${conversationPath(conversationId)}/runs/stream`, input, handlers);
    },

    /** 订阅 SQLite 事件游标；返回幂等 close 句柄供 React effect 清理。 */
    subscribeConversation(conversationId, { after = 0, onEvent, onError } = {}) {
      const query = after > 0 ? `?after=${encodeURIComponent(after)}` : "";
      const source = eventSourceFactory(`${conversationPath(conversationId)}/events${query}`);
      /** 解析服务端事实事件后交给页面，坏载荷只进入错误回调。 */
      source.onmessage = function handleMessage(event) {
        try {
          onEvent?.(JSON.parse(event.data));
        } catch (error) {
          onError?.(error);
        }
      };
      /** 透传 EventSource 重连错误，不把网络抖动改写为 Run 失败。 */
      source.onerror = function handleError(event) {
        onError?.(event);
      };
      return {
        /** 关闭当前页面的事实订阅，不改变服务端会话或 Run 状态。 */
        close() {
          source.close();
        },
      };
    },
  };
}

/** 在浏览器中延迟创建原生 EventSource，避免测试环境加载模块时失败。 */
function createBrowserEventSource(url) {
  if (typeof EventSource !== "function") throw new Error("EventSource is not available");
  return new EventSource(url);
}

/** 生成单会话资源路径并对外部 ID 做 URL 编码。 */
function conversationPath(conversationId) {
  return `/api/runtime/conversations/${encodeURIComponent(conversationId)}`;
}

/**
 * 执行 JSON API 请求并把错误载荷转换为稳定 Adapter 错误。
 *
 * @param {typeof fetch} fetchImpl - Fetch Port。
 * @param {string} path - 相对 API 路径。
 * @param {{method?: string, body?: object}} [options] - 请求配置。
 * @returns {Promise<object>} JSON 载荷。
 */
async function requestJson(fetchImpl, path, options = {}) {
  const response = await fetchImpl(path, {
    method: options.method || "GET",
    headers: options.body ? { "Content-Type": "application/json" } : undefined,
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  const data = await readJsonPayload(response);
  if (!response.ok) throw buildResponseError(response, data);
  return data;
}

/** 读取 POST SSE，按事件名映射运行阶段并要求出现明确终止事件。 */
async function requestRunStream(fetchImpl, path, input, handlers) {
  const response = await fetchImpl(path, {
    method: "POST",
    headers: { Accept: "text/event-stream", "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
  if (!response.ok) throw buildResponseError(response, await readJsonPayload(response));
  if (!response.body) throw new RuntimeAdapterError("浏览器未提供流式响应体", response.status);
  let terminal = null;

  /** 把一个已解析 SSE 事件映射到渠道回调并保存最终事实。 */
  async function handleRunEvent(event) {
    if (event.name === "run-started") {
      await handlers.onRunStarted?.(event.data);
      return;
    }
    if (event.name === "text-delta") {
      await handlers.onTextDelta?.(String(event.data.delta || ""));
      return;
    }
    if (["tool-started", "tool-completed", "tool-failed"].includes(event.name)) {
      await handlers.onToolEvent?.({ ...event.data, event: event.name });
      return;
    }
    if (event.name === "completed") {
      terminal = { type: "completed", data: event.data };
      await handlers.onCompleted?.(event.data);
      return;
    }
    if (event.name === "cancelled") {
      terminal = { type: "cancelled", data: event.data };
      await handlers.onCancelled?.(event.data);
      return;
    }
    if (event.name === "error") {
      throw new RuntimeAdapterError(event.data.error || "流式请求失败", event.data.status || null, event.data);
    }
  }

  await readJsonEventStream(response.body, handleRunEvent);
  if (!terminal) throw new RuntimeAdapterError("流式请求未返回最终状态", response.status);
  return terminal;
}

/** 按 SSE 空行边界读取任意分块的 UTF-8 响应。 */
async function readJsonEventStream(stream, handleEvent) {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    while (true) {
      const result = await reader.read();
      if (result.done) break;
      buffer += decoder.decode(result.value, { stream: true });
      let boundary = /\r?\n\r?\n/.exec(buffer);
      while (boundary) {
        const block = buffer.slice(0, boundary.index);
        buffer = buffer.slice(boundary.index + boundary[0].length);
        await dispatchJsonEvent(block, handleEvent);
        boundary = /\r?\n\r?\n/.exec(buffer);
      }
    }
    buffer += decoder.decode();
    if (buffer.trim()) await dispatchJsonEvent(buffer, handleEvent);
  } finally {
    reader.releaseLock();
  }
}

/** 解析单个 SSE block，并把多行 JSON data 交给调用方。 */
async function dispatchJsonEvent(block, handleEvent) {
  let name = "message";
  const dataLines = [];
  for (const line of block.split(/\r?\n/)) {
    if (line.startsWith("event:")) name = line.slice(6).trim();
    if (line.startsWith("data:")) dataLines.push(line.slice(5).trimStart());
  }
  if (dataLines.length === 0) return;
  await handleEvent({ name, data: JSON.parse(dataLines.join("\n")) });
}

/** 尽可能读取公开 JSON 错误；空响应回退为空对象。 */
async function readJsonPayload(response) {
  try {
    return await response.json();
  } catch {
    return {};
  }
}

/** 从 HTTP 响应和公开载荷构造统一 RuntimeAdapterError。 */
function buildResponseError(response, payload) {
  return new RuntimeAdapterError(payload?.error || `HTTP ${response.status}`, response.status, payload);
}

export const runtimeAdapter = createRuntimeAdapter();
