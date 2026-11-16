// Factory/Dependency Injection：同一个 HTTP fixture 驱动两套真实 SDK，不替换 Agent 内部实现。
import { appendFileSync } from "node:fs";
import { createGatewayClient } from "../../src/gateway/gateway-client.mjs";
import { createChatRuntime } from "../../src/runtime/chat-runtime.mjs";
import { createConversationStore } from "../../src/storage/conversation-store.mjs";
import { createContextPlanner } from "../../src/runtime/context-planner.mjs";
import { createMemoryManager } from "../../src/runtime/memory-manager.mjs";
import { createConversationCoordinator } from "../../src/runtime/conversation-coordinator.mjs";
import { createToolRegistry } from "../../src/tools/tool-registry.mjs";
import { createWeatherToolDefinition } from "../../src/tools/weather-tool.mjs";
import { createPiGateway } from "./pi-gateway.mjs";

export const ANSWER = "深圳当前 26°C，数据时间 2026-10-13T10:00，来源 Open-Meteo。";
export const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
export const WEATHER = Object.freeze({ schemaVersion: "weather.v1",
  location: { name: "深圳", timezone: "Asia/Shanghai" },
  forecast: { date: "2026-10-13", temperature: { current: 26 } }, observedAt: "2026-10-13T10:00",
  source: { name: "Open-Meteo", retrievedAt: "2026-10-13T10:01:00.000Z" } });

/**
 * @typedef {object} FixtureOptions
 * @property {"ai-sdk"|"pi"} engine - 精确锁定的真实 SDK。
 * @property {string} [scenario="weather"] - 确定性故障/输出选择，不代表模型质量。
 * @property {string} [databasePath=":memory:"] - PoC 临时 SQLite，禁止指向正式数据。
 * @property {string} [evidencePath] - 重启测试用的 Connector 调用计数文件。
 * @property {number} [maxSteps=4] - 两引擎一致的模型步骤上限。
 * @property {object} [executionPolicy] - 注入原平台策略，验证宿主拒绝无法被 SDK 绕过。
 * 请求证据由 fixture 拥有；每次装配独立，返回快照避免测试改写输入。
 */

/**
 * 装配两引擎共用的原 Runtime/Store/天气工具，不启动 Demo 或读取 .env。
 * @param {FixtureOptions} options - 实验与故障配置。
 * @returns {object} 装配、可观察请求与 Connector 计数。
 */
export function createFixture({ engine, scenario = "weather", databasePath = ":memory:", evidencePath, maxSteps = 4, executionPolicy }) {
  const requests = [];
  let connectorCalls = 0;
  const contextOptions = { maxContextTokens: 16000, reservedOutputTokens: 1000, safetyTokens: 100,
    highWatermarkRatio: 0.75, lowWatermarkRatio: 0.45, hardWatermarkRatio: 0.9 };
  const fixtureFetch = createFixtureFetch({ requests, scenario });
  const baseClient = createGatewayClient({ baseUrl: "http://gateway.poc.invalid", model: "poc-chat",
    modelCapabilities: { chat: ["poc-chat", "poc-alt"], vision: ["poc-chat"] },
    apiKey: "poc-fake-key", fetchImplementation: fixtureFetch, maxAttempts: 2, retryBaseDelayMs: 0 });
  const gatewayClient = engine === "pi"
    ? createPiGateway({ baseClient, fetchImplementation: fixtureFetch, apiKey: "poc-fake-key" }) : baseClient;
  const store = createConversationStore({ databasePath });
  const contextPlanner = createContextPlanner({ store, gatewayClient, contextOptions, systemPrompt: "PoC：按工具事实回答。" });
  const memoryManager = createMemoryManager({ store, gatewayClient, contextOptions });
  const toolRegistry = createToolRegistry([createWeatherToolDefinition({
    /** 返回同一份 weather.v1，并在进程退出前留下独立调用证据。 */
    async getWeather(input, { abortSignal } = {}) {
      abortSignal?.throwIfAborted();
      connectorCalls += 1;
      if (evidencePath) appendFileSync(evidencePath, "connector\n");
      return structuredClone(WEATHER);
    },
  })]);
  const runtime = createChatRuntime({ store, gatewayClient, contextPlanner, memoryManager, contextOptions, executionPolicy,
    coordinator: createConversationCoordinator(), toolRegistry, toolOptions: { maxSteps },
    resilienceOptions: { runLeaseTtlMs: 1000, runLeaseRenewIntervalMs: 200 } });
  return { runtime, store, gatewayClient, toolRegistry, requests,
    /** 读取 Connector 的实际执行次数。 */
    getConnectorCalls() { return connectorCalls; },
    /** 关闭临时 SQLite；任务必须先结束。 */
    close() { store.close(); },
  };
}

/**
 * 同一 OpenAI-compatible 请求/响应 fixture；真实 provider 协议解析由各 SDK 执行。
 * @param {object} options - 请求证据与故障名称。
 * @returns {typeof fetch} 仅允许假网关端点的受控 fetch。
 */
function createFixtureFetch({ requests, scenario }) {
  let generationCalls = 0;
  /** 校验网关目标、记录假请求，并注入可重复的响应/失败。 */
  return async function fixtureFetch(url, init = {}) {
    const request = new Request(url, init);
    if (!request.url.startsWith("http://gateway.poc.invalid/")) throw new Error("unexpected network destination");
    if (request.url.endsWith("/v1/models")) return jsonResponse({ data: [{ id: "poc-chat" }, { id: "poc-alt" }, { id: "image-default" }] });
    const body = await request.json();
    if (request.url.includes("token_counter")) return jsonResponse({ total_tokens: 100 });
    if (request.url.endsWith("/v1/images/generations") || request.url.endsWith("/v1/responses")) {
      requests.push({ url: request.url, authorization: request.headers.get("authorization"), body });
      if (scenario === "image-failure") return jsonResponse({ error: { message: "poc-sensitive-provider-text" } }, 503);
      return request.url.endsWith("/v1/images/generations") ? jsonResponse({ data: [{ b64_json: PNG }] })
        : jsonResponse({ id: "poc-edit", status: "completed", output: [
          { type: "image_generation_call", status: "completed", result: PNG }] });
    }
    if (!request.url.endsWith("/v1/chat/completions")) throw new Error("unexpected endpoint");
    generationCalls += 1;
    requests.push({ url: request.url, authorization: request.headers.get("authorization"), body });
    if (scenario === "unauthorized") return jsonResponse({ error: { message: "poc-sensitive-provider-text" } }, 401);
    if (scenario === "cancel") {
      /** 模拟等待 provider 时收到真实 AbortSignal；不使用任意 sleep。 */
      return new Promise((resolve, reject) => {
        if (request.signal.aborted) reject(request.signal.reason);
        else request.signal.addEventListener("abort",
          /** 把取消交还真实 SDK 的错误处理链。 */
          () => reject(request.signal.reason), { once: true });
      });
    }
    if ((scenario === "pre-tool-failure" && generationCalls === 1)
      || (scenario === "post-tool-failure" && generationCalls === 2)) {
      return jsonResponse({ error: { message: "poc-sensitive-provider-text", type: "server_error" } }, 503);
    }
    let message;
    let finishReason = "stop";
    const hasToolResult = body.messages.some(isToolMessage);
    if (body.response_format) {
      message = { role: "assistant", content: scenario === "invalid-structured" ? '{"value":"bad"}' : '{"value":26}' };
    } else if (body.tools?.length && (!hasToolResult || scenario === "loop")) {
      const name = scenario === "unknown-tool" ? "delete_database" : "get_weather";
      const args = scenario === "invalid-args" ? { location: "", date: "yesterday" } : { location: "深圳", date: "today" };
      message = { role: "assistant", content: null, tool_calls: [{ id: `call-${generationCalls}`, type: "function",
        function: { name, arguments: JSON.stringify(args) } }] };
      finishReason = "tool_calls";
    } else {
      message = { role: "assistant", content: scenario === "plain" ? "你好" : scenario === "wrong-facts" ? "北京 99°C" : ANSWER };
    }
    const usage = { prompt_tokens: 20, completion_tokens: 10, total_tokens: 30 };
    if (!body.stream) return jsonResponse({ id: "poc-response", object: "chat.completion", created: 1,
      model: "poc-chat", choices: [{ index: 0, message, finish_reason: finishReason }], usage });
    const delta = { role: "assistant", ...(message.content ? { content: message.content } : {}),
      ...(message.tool_calls ? { tool_calls: message.tool_calls.map(indexToolCall) } : {}) };
    const chunks = [
      { id: "poc-response", object: "chat.completion.chunk", created: 1, model: "poc-chat",
        choices: [{ index: 0, delta, finish_reason: null }] },
      { id: "poc-response", object: "chat.completion.chunk", created: 1, model: "poc-chat",
        choices: [{ index: 0, delta: {}, finish_reason: finishReason }], usage },
    ];
    return new Response(chunks.map(serializeSse).join("") + "data: [DONE]\n\n",
      { headers: { "content-type": "text/event-stream" } });
  };
}
/** 识别模型收到的事实结果。 */
function isToolMessage(message) { return message.role === "tool"; }
/** 按 OpenAI 流协议标记工具分段索引。 */
function indexToolCall(call, index) { return { index, ...call }; }
/** 序列化单个流分段。 */
function serializeSse(chunk) { return `data: ${JSON.stringify(chunk)}\n\n`; }
/** 返回模型目录、计数或非流 JSON。 */
function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}
