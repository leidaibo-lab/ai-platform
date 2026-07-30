#!/usr/bin/env node
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";

/** 验证真实 HTTP Adapter 把 OpenAI-compatible 模型流贯通到浏览器协议并最终单次落库。 */
async function testStreamingRunOverHttp() {
  const temporaryDirectory = mkdtempSync(join(tmpdir(), "ai-platform-stream-http-"));
  const generatedModels = [];
  const fakeGateway = createServer(createFakeGatewayHandler(generatedModels));
  let demoProcess = null;
  let demoStderr = "";
  try {
    const gatewayPort = await listenOnRandomPort(fakeGateway);
    const demoPort = await reservePort();
    demoProcess = spawn(process.execPath, ["scripts/demo-server.mjs"], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        DEMO_PORT: String(demoPort),
        DEMO_DATABASE_PATH: join(temporaryDirectory, "streaming.sqlite"),
        LITELLM_BASE_URL: `http://127.0.0.1:${gatewayPort}`,
        LITELLM_MASTER_KEY: "sk-http-stream-test",
        LITELLM_MODEL: "chat-default",
        DEMO_MODEL_RETRY_BASE_DELAY_MS: "0",
        OTEL_ENABLED: "false",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    /** 收集 Demo Server 标准错误，验证安全映射不会额外打印 provider 原始正文。 */
    function appendDemoStderr(chunk) {
      demoStderr += chunk;
    }
    demoProcess.stderr.setEncoding("utf8");
    demoProcess.stderr.on("data", appendDemoStderr);
    const demoBaseUrl = `http://127.0.0.1:${demoPort}`;
    await waitForDemo(demoBaseUrl, demoProcess);

    const conversation = await requestJson(`${demoBaseUrl}/api/runtime/conversations`, {
      method: "POST",
      body: {},
    });
    const response = await fetch(
      `${demoBaseUrl}/api/runtime/conversations/${encodeURIComponent(conversation.id)}/runs/stream`,
      {
        method: "POST",
        headers: { Accept: "text/event-stream", "Content-Type": "application/json" },
        body: JSON.stringify({
          requestId: "http-stream-request",
          clientMessageId: "http-stream-message",
          model: "chat-quality",
          message: "验证 HTTP 流",
          imageUrls: [],
          documentUrls: [],
        }),
      },
    );
    assert.equal(response.status, 200);
    assert.match(response.headers.get("content-type") || "", /^text\/event-stream/);
    const events = await readSseEvents(response.body);
    const completed = events.find(isCompletedEvent)?.data;

    assert.deepEqual(events.map(readEventName), ["run-started", "text-delta", "text-delta", "completed"]);
    assert.deepEqual(events.filter(isTextDeltaEvent).map(readTextDelta), ["流式", "回复"]);
    assert.equal(completed.content, "流式回复");
    assert.equal(completed.resilience.outputStarted, true);
    assert.equal(generatedModels[0], "chat-quality");
    assert.deepEqual(completed.conversation.messages.map(readDisplayContent), ["验证 HTTP 流", "流式回复"]);

    const detail = await requestJson(
      `${demoBaseUrl}/api/runtime/conversations/${encodeURIComponent(conversation.id)}`,
    );
    assert.equal(detail.messages.length, 2);
    assert.equal(detail.messages.filter(isAssistantMessage).length, 1);

    const authorizationResponse = await fetch(
      `${demoBaseUrl}/api/runtime/conversations/${encodeURIComponent(conversation.id)}/runs/stream`,
      {
        method: "POST",
        headers: { Accept: "text/event-stream", "Content-Type": "application/json" },
        body: JSON.stringify({
          requestId: "http-authorization-request",
          clientMessageId: "http-authorization-message",
          model: "chat-quality",
          message: "验证模型鉴权失败",
        }),
      },
    );
    const authorizationEvents = await readSseEvents(authorizationResponse.body);
    const authorizationError = authorizationEvents.find(isErrorEvent)?.data;
    assert.deepEqual(authorizationEvents.map(readEventName), ["run-started", "error"]);
    assert.equal(authorizationError.error, "模型鉴权失败");
    assert.equal(authorizationError.code, "model_authorization_failed");
    assert.match(authorizationError.detail, /上游访问凭据无效或没有权限/);
    assert.doesNotMatch(JSON.stringify(authorizationError), /INVALID_API_KEY|provider secret/);
    const failedDetail = await requestJson(
      `${demoBaseUrl}/api/runtime/conversations/${encodeURIComponent(conversation.id)}`,
    );
    assert.equal(failedDetail.latestRun.status, "failed");
    assert.equal(failedDetail.latestRun.error, "模型鉴权失败");
    assert.equal(failedDetail.latestRun.model, "chat-quality");
    assert.doesNotMatch(demoStderr, /INVALID_API_KEY|provider secret/);

    let cancellationRunId = null;
    let resolveCancellationReady;
    /** 保存首个取消增量到达时使用的 Promise resolver。 */
    const cancellationReady = new Promise((resolve) => {
      resolveCancellationReady = resolve;
    });
    const cancellationResponse = await fetch(
      `${demoBaseUrl}/api/runtime/conversations/${encodeURIComponent(conversation.id)}/runs/stream`,
      {
        method: "POST",
        headers: { Accept: "text/event-stream", "Content-Type": "application/json" },
        body: JSON.stringify({
          requestId: "http-cancel-request",
          clientMessageId: "http-cancel-message",
          message: "验证 HTTP 取消",
        }),
      },
    );
    /** 收集取消流的 Run ID，并在首个增量到达时允许测试调用取消端点。 */
    function observeCancellationEvent(event) {
      if (event.name === "run-started") cancellationRunId = event.data.runId;
      if (event.name === "text-delta") resolveCancellationReady();
    }
    const cancellationEventsPromise = readSseEvents(cancellationResponse.body, observeCancellationEvent);
    await withTimeout(cancellationReady, "waiting for cancellation delta");
    const cancellationResult = await withTimeout(
      requestJson(
        `${demoBaseUrl}/api/runtime/conversations/${encodeURIComponent(conversation.id)}/runs/${encodeURIComponent(cancellationRunId)}/cancel`,
        { method: "POST", body: {} },
      ),
      "waiting for cancellation response",
    );
    const cancellationEvents = await withTimeout(cancellationEventsPromise, "waiting for cancelled SSE event");
    const repeatedCancellation = await requestJson(
      `${demoBaseUrl}/api/runtime/conversations/${encodeURIComponent(conversation.id)}/runs/${encodeURIComponent(cancellationRunId)}/cancel`,
      { method: "POST", body: {} },
    );
    assert.deepEqual(cancellationEvents.map(readEventName), ["run-started", "text-delta", "cancelled"]);
    assert.equal(cancellationResult.run.status, "cancelled");
    assert.equal(cancellationResult.assistantMessage.status, "interrupted");
    assert.equal(cancellationResult.assistantMessage.displayContent, "取消前片段");
    assert.equal(repeatedCancellation.run.status, "cancelled");

    const disconnectController = new AbortController();
    const disconnectResponse = await fetch(
      `${demoBaseUrl}/api/runtime/conversations/${encodeURIComponent(conversation.id)}/runs/stream`,
      {
        method: "POST",
        headers: { Accept: "text/event-stream", "Content-Type": "application/json" },
        body: JSON.stringify({
          requestId: "http-disconnect-request",
          clientMessageId: "http-disconnect-message",
          message: "验证 SSE 断线",
        }),
        signal: disconnectController.signal,
      },
    );
    /** 在首个断线测试增量到达后主动关闭浏览器侧读取。 */
    function disconnectAfterFirstDelta(event) {
      if (event.name === "text-delta") disconnectController.abort();
    }
    await withTimeout(
      readSseEvents(disconnectResponse.body, disconnectAfterFirstDelta).catch(ignoreExpectedDisconnect),
      "waiting for client disconnect",
    );
    const completedAfterDisconnect = await waitForLatestRunStatus(
      `${demoBaseUrl}/api/runtime/conversations/${encodeURIComponent(conversation.id)}`,
      "completed",
    );
    assert.equal(completedAfterDisconnect.latestRun.status, "completed");
    assert.equal(completedAfterDisconnect.messages.at(-1).displayContent, "断线后继续完成");
  } finally {
    if (demoProcess) await stopProcess(demoProcess);
    await closeServer(fakeGateway);
    rmSync(temporaryDirectory, { recursive: true, force: true });
  }
}

test("POST SSE supports completion, explicit cancellation, and disconnect continuation", testStreamingRunOverHttp);

/** 创建可按用户输入模拟完成、取消等待和渠道断线的 OpenAI-compatible Gateway。 */
function createFakeGatewayHandler(generatedModels) {
  /** 为 Demo 测试提供 models、token counter 和标准文本流。 */
  return async function handleFakeGatewayRequest(req, res) {
    if (req.method === "GET" && req.url === "/v1/models") {
      req.resume();
      sendJson(res, { data: [{ id: "chat-default" }, { id: "chat-quality" }] });
      return;
    }
    if (req.method === "POST" && req.url === "/utils/token_counter") {
      req.resume();
      sendJson(res, { total_tokens: 12, model: "fake-stream-model" });
      return;
    }
    if (req.method === "POST" && req.url === "/v1/chat/completions") {
      const requestBody = await readRequestBody(req);
      const parsedBody = JSON.parse(requestBody);
      generatedModels.push(parsedBody.model);
      const latestMessage = parsedBody.messages.at(-1);
      if (latestMessage?.role === "user" && latestMessage.content === "验证模型鉴权失败") {
        sendJson(res, { error: { message: "INVALID_API_KEY provider secret" } }, 401);
        return;
      }
      res.writeHead(200, {
        "Content-Type": "text/event-stream; charset=utf-8",
        "Cache-Control": "no-cache",
      });
      if (requestBody.includes("验证 SSE 断线")) {
        writeOpenAiChunk(res, "断线后", null);
        await delay(40);
        writeOpenAiChunk(res, "继续完成", null);
        finishOpenAiStream(res, 4);
        return;
      }
      if (requestBody.includes("验证 HTTP 取消")) {
        const responseClosed = waitForResponseClose(res);
        writeOpenAiChunk(res, "取消前片段", null);
        await withTimeout(responseClosed, "model request was not aborted");
        return;
      }
      writeOpenAiChunk(res, "流式", null);
      await delay(10);
      writeOpenAiChunk(res, "回复", null);
      finishOpenAiStream(res, 2);
      return;
    }
    req.resume();
    sendJson(res, { error: "not found" }, 404);
  };
}

/** 判断 SSE 事件是否为失败终止事件。 */
function isErrorEvent(event) {
  return event.name === "error";
}

/** 写入 finish chunk、usage 和 DONE 标记并结束模型流。 */
function finishOpenAiStream(res, completionTokens) {
  writeOpenAiChunk(res, "", "stop", {
    prompt_tokens: 12,
    completion_tokens: completionTokens,
    total_tokens: 12 + completionTokens,
  });
  res.end("data: [DONE]\n\n");
}

/** 写入一个 OpenAI-compatible chat completion chunk。 */
function writeOpenAiChunk(res, content, finishReason, usage) {
  res.write(`data: ${JSON.stringify({
    id: "chatcmpl-http-stream",
    object: "chat.completion.chunk",
    created: 1785200000,
    model: "fake-stream-model",
    choices: [{ index: 0, delta: content ? { content } : {}, finish_reason: finishReason }],
    ...(usage ? { usage } : {}),
  })}\n\n`);
}

/** 写入测试网关 JSON 响应。 */
function sendJson(res, payload, statusCode = 200) {
  res.writeHead(statusCode, { "Content-Type": "application/json" });
  res.end(JSON.stringify(payload));
}

/** 启动 HTTP Server 并返回操作系统分配的端口。 */
function listenOnRandomPort(server) {
  /** 将 Server 监听事件转换为可等待的端口结果。 */
  return new Promise((resolve, reject) => {
    /** 监听成功后读取实际端口。 */
    function handleListening() {
      resolve(server.address().port);
    }
    server.once("error", reject);
    server.listen(0, "127.0.0.1", handleListening);
  });
}

/** 短暂占用随机端口并释放，供子进程 Demo Server 使用。 */
async function reservePort() {
  const server = createServer();
  const port = await listenOnRandomPort(server);
  await closeServer(server);
  return port;
}

/** 轮询 Demo 健康接口，子进程提前退出时返回其 stderr。 */
async function waitForDemo(baseUrl, child) {
  let stderr = "";
  /** 收集子进程错误输出，供启动失败诊断。 */
  function collectStderr(chunk) {
    stderr += chunk;
  }
  child.stderr.on("data", collectStderr);
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (child.exitCode !== null) throw new Error(`Demo Server exited early: ${stderr}`);
    try {
      const response = await fetch(`${baseUrl}/api/gateway/status`);
      if (response.ok) return;
    } catch {
      // 启动窗口内的连接拒绝属于预期轮询状态。
    }
    await delay(20);
  }
  throw new Error(`Demo Server did not become ready: ${stderr}`);
}

/** 执行 JSON 请求并校验成功状态。 */
async function requestJson(url, options = {}) {
  const response = await fetch(url, {
    method: options.method || "GET",
    headers: options.body ? { "Content-Type": "application/json" } : undefined,
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  const payload = await response.json();
  if (!response.ok) throw new Error(payload.error || `HTTP ${response.status}`);
  return payload;
}

/** 读取完整 SSE 响应并解析 JSON 事件。 */
async function readSseEvents(stream, onEvent) {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  const events = [];
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
        appendSseEvent(events, block, onEvent);
        boundary = /\r?\n\r?\n/.exec(buffer);
      }
    }
  } finally {
    reader.releaseLock();
  }
  return events;
}

/** 将包含 data 的单个 SSE block 追加为结构化事件。 */
function appendSseEvent(events, block, onEvent) {
  let name = "message";
  const dataLines = [];
  for (const line of block.split(/\r?\n/)) {
    if (line.startsWith("event:")) name = line.slice(6).trim();
    if (line.startsWith("data:")) dataLines.push(line.slice(5).trimStart());
  }
  if (dataLines.length === 0) return;
  const event = { name, data: JSON.parse(dataLines.join("\n")) };
  events.push(event);
  if (typeof onEvent === "function") onEvent(event);
}

/** 读取完整测试请求体，供 fake gateway 根据当前输入选择响应行为。 */
function readRequestBody(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    /** 累积一个测试请求块。 */
    function appendChunk(chunk) {
      body += chunk;
    }
    /** 请求体读取完成后返回聚合文本。 */
    function finishBody() {
      resolve(body);
    }
    req.on("data", appendChunk);
    req.on("end", finishBody);
    req.on("error", reject);
  });
}

/** 等待 Runtime 取消下游请求后 fake gateway 响应连接关闭。 */
function waitForResponseClose(res) {
  return new Promise((resolve) => {
    /** 下游连接关闭后结束等待。 */
    function handleResponseClose() {
      resolve();
    }
    res.once("close", handleResponseClose);
  });
}

/** 为异步集成测试阶段增加可诊断的硬超时。 */
async function withTimeout(promise, label, timeoutMs = 5000) {
  let timeout;
  /** 超时后抛出带当前阶段的错误。 */
  const timeoutPromise = new Promise((resolve, reject) => {
    timeout = setTimeout(() => reject(new Error(label)), timeoutMs);
  });
  try {
    return await Promise.race([promise, timeoutPromise]);
  } finally {
    clearTimeout(timeout);
  }
}

/** 轮询会话详情直到 latestRun 达到预期终止状态。 */
async function waitForLatestRunStatus(url, expectedStatus) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const detail = await requestJson(url);
    if (detail.latestRun?.status === expectedStatus) return detail;
    await delay(20);
  }
  throw new Error(`latestRun did not reach ${expectedStatus}`);
}

/** 吞掉测试主动中断客户端读取产生的预期 AbortError。 */
function ignoreExpectedDisconnect(error) {
  if (error?.name !== "AbortError") throw error;
}

/** 终止 Demo 子进程并等待退出。 */
async function stopProcess(child) {
  if (child.exitCode !== null) return;
  child.kill("SIGTERM");
  /** 将子进程退出事件转换为可等待的 Promise，并避免失败用例永久卡住。 */
  const exited = new Promise((resolve) => {
    /** 子进程退出后完成清理等待。 */
    function handleExit() {
      resolve();
    }
    child.once("exit", handleExit);
  });
  try {
    await withTimeout(exited, "waiting for Demo Server shutdown", 2000);
  } catch {
    child.kill("SIGKILL");
    await exited;
  }
}

/** 关闭 HTTP Server；未启动状态直接视为已关闭。 */
function closeServer(server) {
  if (!server.listening) return Promise.resolve();
  server.closeAllConnections();
  /** 将 Server 关闭回调转换为可等待的清理结果。 */
  return new Promise((resolve, reject) => {
    /** Server 完成关闭后结束 Promise。 */
    function handleClosed(error) {
      if (error) reject(error);
      else resolve();
    }
    server.close(handleClosed);
  });
}

/** 返回 SSE 事件名。 */
function readEventName(event) {
  return event.name;
}

/** 判断 SSE 事件是否为文本增量。 */
function isTextDeltaEvent(event) {
  return event.name === "text-delta";
}

/** 返回文本增量正文。 */
function readTextDelta(event) {
  return event.data.delta;
}

/** 判断 SSE 事件是否为最终完成事件。 */
function isCompletedEvent(event) {
  return event.name === "completed";
}

/** 返回持久化消息展示正文。 */
function readDisplayContent(message) {
  return message.displayContent;
}

/** 判断消息是否为助手最终消息。 */
function isAssistantMessage(message) {
  return message.role === "assistant";
}
