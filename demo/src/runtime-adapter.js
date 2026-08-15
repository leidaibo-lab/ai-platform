/**
 * @typedef {object} RuntimeAdapterOptions
 * @property {typeof fetch} [fetchImpl] - 可注入的 Fetch Port，测试用 fake 实现替代浏览器网络。
 * @property {(url: string) => EventSource} [eventSourceFactory] - 会话事实流连接工厂。
 * @property {number} [imageUploadTimeoutMs=30000] - 单次本地图片上传的渠道超时。
 */

/**
 * @typedef {object} ImageUploadOptions
 * @property {AbortSignal} [abortSignal] - 页面取消源图片准备时向上传请求传播的信号。
 */

const DEFAULT_IMAGE_UPLOAD_TIMEOUT_MS = 30000;

/**
 * @typedef {object} RunStreamHandlers
 * @property {(event: object) => Promise<void>|void} [onRunStarted] - 接收稳定 Run 身份。
 * @property {(event: object) => Promise<void>|void} [onToolEvent] - 接收服务端工具开始、完成或失败事实。
 * @property {(artifact: object) => Promise<void>|void} [onArtifactCreated] - 接收已持久化图片资产引用。
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
  imageUploadTimeoutMs = DEFAULT_IMAGE_UPLOAD_TIMEOUT_MS,
} = {}) {
  if (typeof fetchImpl !== "function") throw new TypeError("A fetch implementation is required");
  const normalizedImageUploadTimeoutMs = normalizeImageUploadTimeout(imageUploadTimeoutMs);

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

    /**
     * 上传一张本地图片并返回当前会话拥有的稳定 image_asset。
     *
     * @param {string} conversationId - 图片所属会话。
     * @param {Blob} image - 带受控 MIME 的原始图片。
     * @param {ImageUploadOptions} [options] - 页面取消信号。
     * @returns {Promise<object>} 服务端登记的稳定图片资产。
     */
    uploadImageAsset(conversationId, image, options = {}) {
      if (!(image instanceof Blob) || !String(image.type || "").startsWith("image/")) {
        throw new TypeError("A typed image Blob is required");
      }
      return requestImageUpload(fetchImpl, `${conversationPath(conversationId)}/image-assets`, image, {
        abortSignal: options.abortSignal,
        timeoutMs: normalizedImageUploadTimeoutMs,
      });
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

    /** 在 Runtime 尚未创建 Run 时按幂等请求身份显式取消当前执行。 */
    cancelRunRequest(conversationId, requestId) {
      return requestJson(
        fetchImpl,
        `${conversationPath(conversationId)}/run-requests/${encodeURIComponent(requestId)}/cancel`,
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

/** 发送原始图片二进制，并把服务端、用户取消和渠道超时转换为统一 Adapter 错误。 */
async function requestImageUpload(fetchImpl, path, image, { abortSignal, timeoutMs }) {
  const abortContext = createTimedAbortContext(abortSignal, timeoutMs);
  try {
    const response = await fetchImpl(path, {
      method: "POST",
      headers: { "Content-Type": image.type },
      body: image,
      signal: abortContext.signal,
    });
    if (abortContext.signal.aborted) throw abortContext.signal.reason;
    const data = await readJsonPayload(response);
    if (abortContext.signal.aborted) throw abortContext.signal.reason;
    if (!response.ok) throw buildResponseError(response, data);
    return data;
  } catch (error) {
    if (abortContext.timedOut()) {
      throw new RuntimeAdapterError("源图片上传超时", 408, {
        error: "源图片上传超时",
        code: "image_upload_timeout",
      });
    }
    if (abortSignal?.aborted || abortContext.signal.aborted) {
      throw new RuntimeAdapterError("源图片上传已取消", 499, {
        error: "源图片上传已取消",
        code: "image_upload_cancelled",
      });
    }
    throw error;
  } finally {
    abortContext.dispose();
  }
}

/** 创建可清理的上传取消上下文，把调用方信号与本地超时合并为单一 Fetch 信号。 */
function createTimedAbortContext(callerSignal, timeoutMs) {
  const controller = new AbortController();
  let didTimeOut = false;

  /** 把调用方取消原因原样传播给 Fetch。 */
  function relayCallerAbort() {
    if (!controller.signal.aborted) {
      controller.abort(callerSignal?.reason || new DOMException("Image upload was cancelled", "AbortError"));
    }
  }

  /** 在渠道时限耗尽时以 TimeoutError 终止 Fetch。 */
  function abortOnTimeout() {
    didTimeOut = true;
    if (!controller.signal.aborted) {
      controller.abort(new DOMException("Image upload timed out", "TimeoutError"));
    }
  }

  if (callerSignal?.aborted) relayCallerAbort();
  else callerSignal?.addEventListener("abort", relayCallerAbort, { once: true });
  const timer = controller.signal.aborted ? null : setTimeout(abortOnTimeout, timeoutMs);

  return {
    signal: controller.signal,
    /** 返回超时是否先于正常完成触发。 */
    timedOut() {
      return didTimeOut;
    },
    /** 清理计时器和调用方监听，避免成功上传后残留生命周期资源。 */
    dispose() {
      if (timer !== null) clearTimeout(timer);
      callerSignal?.removeEventListener("abort", relayCallerAbort);
    },
  };
}

/** 把外部超时配置限制为正整数，异常输入回退到默认时限。 */
function normalizeImageUploadTimeout(value) {
  const timeoutMs = Number(value);
  return Number.isFinite(timeoutMs) && timeoutMs > 0
    ? Math.floor(timeoutMs)
    : DEFAULT_IMAGE_UPLOAD_TIMEOUT_MS;
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
    if (event.name === "artifact-created") {
      await handlers.onArtifactCreated?.(event.data);
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
