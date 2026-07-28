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
  const fakeGateway = createServer(handleFakeGatewayRequest);
  let demoProcess = null;
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
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
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
    assert.deepEqual(completed.conversation.messages.map(readDisplayContent), ["验证 HTTP 流", "流式回复"]);

    const detail = await requestJson(
      `${demoBaseUrl}/api/runtime/conversations/${encodeURIComponent(conversation.id)}`,
    );
    assert.equal(detail.messages.length, 2);
    assert.equal(detail.messages.filter(isAssistantMessage).length, 1);
  } finally {
    if (demoProcess) await stopProcess(demoProcess);
    await closeServer(fakeGateway);
    rmSync(temporaryDirectory, { recursive: true, force: true });
  }
}

test("POST SSE run streams model deltas and persists one final message", testStreamingRunOverHttp);

/** 为 Demo 测试提供 models、token counter 和标准 OpenAI-compatible 文本流。 */
async function handleFakeGatewayRequest(req, res) {
  req.resume();
  if (req.method === "GET" && req.url === "/v1/models") {
    sendJson(res, { data: [{ id: "chat-default" }] });
    return;
  }
  if (req.method === "POST" && req.url === "/utils/token_counter") {
    sendJson(res, { total_tokens: 12, model: "fake-stream-model" });
    return;
  }
  if (req.method === "POST" && req.url === "/v1/chat/completions") {
    res.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache",
    });
    writeOpenAiChunk(res, "流式", null);
    await delay(10);
    writeOpenAiChunk(res, "回复", null);
    writeOpenAiChunk(res, "", "stop", {
      prompt_tokens: 12,
      completion_tokens: 2,
      total_tokens: 14,
    });
    res.end("data: [DONE]\n\n");
    return;
  }
  sendJson(res, { error: "not found" }, 404);
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
async function readSseEvents(stream) {
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
        appendSseEvent(events, block);
        boundary = /\r?\n\r?\n/.exec(buffer);
      }
    }
  } finally {
    reader.releaseLock();
  }
  return events;
}

/** 将包含 data 的单个 SSE block 追加为结构化事件。 */
function appendSseEvent(events, block) {
  let name = "message";
  const dataLines = [];
  for (const line of block.split(/\r?\n/)) {
    if (line.startsWith("event:")) name = line.slice(6).trim();
    if (line.startsWith("data:")) dataLines.push(line.slice(5).trimStart());
  }
  if (dataLines.length > 0) events.push({ name, data: JSON.parse(dataLines.join("\n")) });
}

/** 终止 Demo 子进程并等待退出。 */
async function stopProcess(child) {
  if (child.exitCode !== null) return;
  child.kill("SIGTERM");
  /** 将子进程退出事件转换为清理 Promise。 */
  await new Promise((resolve) => {
    /** 子进程退出后完成清理等待。 */
    function handleExit() {
      resolve();
    }
    child.once("exit", handleExit);
  });
}

/** 关闭 HTTP Server；未启动状态直接视为已关闭。 */
function closeServer(server) {
  if (!server.listening) return Promise.resolve();
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
