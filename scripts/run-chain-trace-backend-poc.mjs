#!/usr/bin/env node
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-proto";
import { InMemorySpanExporter } from "@opentelemetry/sdk-trace-base";
import { createGatewayClient } from "../src/gateway/gateway-client.mjs";
import { initializeOpenTelemetry } from "../src/observability/otel-runtime.mjs";
import { createResilienceContext } from "../src/resilience/retry-executor.mjs";

const DEFAULT_LANGFUSE_ENDPOINT = "http://localhost:3000/api/public/otel/v1/traces";
const DEFAULT_PHOENIX_ENDPOINT = "http://localhost:6006/v1/traces";
const SERVICE_NAME = "ai-platform-c1-chaintrace-poc";
const SENSITIVE_PROMPT = "poc-sensitive-prompt";
const SENSITIVE_ANSWER = "poc-sensitive-answer";
const SENSITIVE_IMAGE = "data:image/png;base64,cG9jLXNlbnNpdGl2ZS1pbWFnZQ==";
const SENSITIVE_DOCUMENT = "https://documents.example.test/poc-sensitive-document";

/**
 * @typedef {object} NamedSpanExporter
 * @property {string} name - 对比报告使用的后端名称。
 * @property {import("@opentelemetry/sdk-trace-base").SpanExporter} exporter - 接收同一批 Span 的导出器。
 */

/**
 * 仅供后端对比 PoC 使用的扇出导出器，把同一批 ReadableSpan 交给全部候选后端。
 * Composite 模式用于保证候选后端收到相同 trace_id；正式接入不得直接复用本脚本。
 */
export class PocFanoutSpanExporter {
  /**
   * 保存候选导出器并初始化批次结果；导出器集合创建后不再变化。
   *
   * @param {NamedSpanExporter[]} exporters - 至少一个命名导出器。
   */
  constructor(exporters) {
    assert.ok(Array.isArray(exporters) && exporters.length > 0, "at least one exporter is required");
    this.exporters = [...exporters];
    this.failedBackends = new Set();
    this.succeededBackends = new Set();
  }

  /** 把同一批 Span 并行导出，并把任一候选失败汇总为当前批次失败。 */
  export(spans, resultCallback) {
    let pending = this.exporters.length;
    let failed = false;

    // 汇总每个候选的异步回调，确保上游只收到一次最终结果。
    const settle = (name, result) => {
      if (result?.code === 0) this.succeededBackends.add(name);
      else {
        failed = true;
        this.failedBackends.add(name);
      }
      pending -= 1;
      if (pending === 0) {
        resultCallback(failed ? { code: 1, error: new Error("one or more PoC backends rejected spans") } : { code: 0 });
      }
    };

    for (const { name, exporter } of this.exporters) {
      try {
        // 保留子导出器的标准回调语义，不暴露响应正文或鉴权信息。
        exporter.export(spans, (result) => settle(name, result));
      } catch {
        settle(name, { code: 1 });
      }
    }
  }

  /** 关闭全部子导出器，避免 PoC 进程退出时遗留网络资源。 */
  async shutdown() {
    await Promise.all(this.exporters.map(shutdownNamedExporter));
  }

  /** 返回已成功接收至少一个批次的后端名称。 */
  getSucceededBackends() {
    return [...this.succeededBackends].sort();
  }

  /** 返回拒绝或未能接收至少一个批次的后端名称。 */
  getFailedBackends() {
    return [...this.failedBackends].sort();
  }
}

/** 关闭单个命名导出器。 */
async function shutdownNamedExporter({ exporter }) {
  await exporter.shutdown();
}

/**
 * 运行一次脱敏 C1 语义 fixture，并把完全相同的 Span 批次发往所选候选后端。
 *
 * @param {NodeJS.ProcessEnv} [env=process.env] - PoC 后端地址和测试凭据。
 * @returns {Promise<object>} 不含凭据和业务正文的可检索标识与导出结果。
 */
export async function runChainTraceBackendPoc(env = process.env) {
  const memoryExporter = new InMemorySpanExporter();
  const configuredExporters = createBackendExporters(env);
  const fanoutExporter = new PocFanoutSpanExporter([
    ...configuredExporters,
    { name: "memory", exporter: memoryExporter },
  ]);
  const telemetryRuntime = initializeOpenTelemetry(
    { enabled: true, serviceName: SERVICE_NAME, samplingRatio: 1 },
    { traceExporter: fanoutExporter },
  );

  try {
    const identifiers = createFixtureIdentifiers();
    await emitC1Fixture({ chainTracer: telemetryRuntime.chainTracer, identifiers });
    await telemetryRuntime.forceFlush();

    const spans = memoryExporter.getFinishedSpans();
    assertFixtureShape(spans, identifiers);
    assertSensitiveValuesAbsent(spans);

    const failedBackends = fanoutExporter.getFailedBackends().filter(isExternalBackend);
    assert.deepEqual(failedBackends, [], `backend export failed: ${failedBackends.join(", ")}`);
    return {
      ...identifiers,
      otelTraceId: readFixtureTraceId(spans),
      spanCount: spans.length,
      backends: fanoutExporter.getSucceededBackends().filter(isExternalBackend),
      serviceName: SERVICE_NAME,
      privacyScan: "passed",
    };
  } finally {
    await telemetryRuntime.shutdown();
  }
}

/** 根据 PoC 目标创建带独立鉴权的官方 OTLP HTTP 导出器。 */
function createBackendExporters(env) {
  const targets = parseTargets(env.CHAIN_TRACE_POC_TARGETS || "both");
  const exporters = [];
  if (targets.has("langfuse")) exporters.push(createLangfuseExporter(env));
  if (targets.has("phoenix")) exporters.push(createPhoenixExporter(env));
  return exporters;
}

/** 解析 `both`、`langfuse` 或 `phoenix`，拒绝静默跳过候选的未知值。 */
function parseTargets(value) {
  const normalized = String(value || "both").trim().toLowerCase();
  if (normalized === "both") return new Set(["langfuse", "phoenix"]);
  if (["langfuse", "phoenix"].includes(normalized)) return new Set([normalized]);
  throw new Error("CHAIN_TRACE_POC_TARGETS must be both, langfuse, or phoenix");
}

/** 创建 Langfuse OTLP HTTP 导出器；Basic Auth 仅在内存中组装且不会输出。 */
function createLangfuseExporter(env) {
  const publicKey = requireValue(env.CHAIN_TRACE_POC_LANGFUSE_PUBLIC_KEY, "CHAIN_TRACE_POC_LANGFUSE_PUBLIC_KEY");
  const secretKey = requireValue(env.CHAIN_TRACE_POC_LANGFUSE_SECRET_KEY, "CHAIN_TRACE_POC_LANGFUSE_SECRET_KEY");
  const authorization = Buffer.from(`${publicKey}:${secretKey}`).toString("base64");
  return {
    name: "langfuse",
    exporter: new OTLPTraceExporter({
      url: resolveTraceEndpoint(env.CHAIN_TRACE_POC_LANGFUSE_ENDPOINT || DEFAULT_LANGFUSE_ENDPOINT),
      headers: {
        Authorization: `Basic ${authorization}`,
        "x-langfuse-ingestion-version": "4",
      },
    }),
  };
}

/** 创建 Phoenix OTLP HTTP 导出器；本地无鉴权实例允许 API key 为空。 */
function createPhoenixExporter(env) {
  const apiKey = String(env.CHAIN_TRACE_POC_PHOENIX_API_KEY || "").trim();
  return {
    name: "phoenix",
    exporter: new OTLPTraceExporter({
      url: resolveTraceEndpoint(env.CHAIN_TRACE_POC_PHOENIX_ENDPOINT || DEFAULT_PHOENIX_ENDPOINT),
      ...(apiKey ? { headers: { Authorization: `Bearer ${apiKey}` } } : {}),
    }),
  };
}

/** 把基础 OTLP 地址规范为 HTTP Trace 接收地址。 */
function resolveTraceEndpoint(endpoint) {
  const url = new URL(String(endpoint));
  if (!url.pathname.endsWith("/v1/traces")) url.pathname = `${url.pathname.replace(/\/$/, "")}/v1/traces`;
  return url.toString();
}

/** 校验 PoC 必填值，同时避免错误文本包含真实凭据。 */
function requireValue(value, name) {
  const normalized = String(value || "").trim();
  if (!normalized) throw new Error(`${name} is required for the Langfuse PoC`);
  return normalized;
}

/** 为一次 PoC 生成唯一但不含业务数据的关联标识。 */
function createFixtureIdentifiers() {
  const suffix = randomUUID();
  return {
    requestId: `poc-request-${suffix}`,
    conversationId: `poc-conversation-${suffix}`,
    runId: `poc-run-${suffix}`,
    chainTraceId: `poc-chain-${suffix}`,
  };
}

/** 用真实 ChainTracer 和 AI SDK Gateway 路径生成 C1 阶段、模型与交付 Span。 */
async function emitC1Fixture({ chainTracer, identifiers }) {
  const gatewayClient = createFixtureGateway();
  await chainTracer.withSpan(
    "c1.conversation.run",
    createLookupAttributes(identifiers, {
      "ai.platform.scenario_id": "C1",
      "ai.platform.channel.transport": "json",
    }),
    /** 在同一活动上下文内生成完整 C1 Span 树。 */
    async (rootSpan) => {
      await chainTracer.withSpan("runtime.queue", createLookupAttributes(identifiers), asyncNoOperation);
      await chainTracer.withSpan("storage.start_run", createLookupAttributes(identifiers), asyncNoOperation);
      await chainTracer.withSpan(
        "runtime.context.plan",
        createLookupAttributes(identifiers, {
          "ai.platform.context.tokens.system": 12,
          "ai.platform.context.tokens.current_input": 18,
          "ai.platform.context.tokens.memory": 6,
          "ai.platform.context.tokens.episodes": 0,
          "ai.platform.context.tokens.history": 24,
          "ai.platform.context.tokens.total_input": 60,
          "ai.platform.context.tokens.counted_total_input": 60,
        }),
        asyncNoOperation,
      );

      const response = await gatewayClient.chatCompletions({
        messages: createSensitiveModelMessages(),
        resilienceContext: createResilienceContext({
          traceId: identifiers.chainTraceId,
          requestId: identifiers.requestId,
          conversationId: identifiers.conversationId,
          runId: identifiers.runId,
          deadlineAt: Date.now() + 30000,
        }),
      });
      assert.equal(response.choices[0].message.content, SENSITIVE_ANSWER);

      await chainTracer.withSpan("storage.complete_run", createLookupAttributes(identifiers), asyncNoOperation);
      await chainTracer.withSpan(
        "channel.json.delivery",
        createLookupAttributes(identifiers, { "ai.platform.run.status": "completed" }),
        asyncNoOperation,
      );
      rootSpan.setAttribute("ai.platform.run.status", "completed");
    },
  );
}

/** 返回不产生额外数据的可等待阶段操作。 */
async function asyncNoOperation() {}

/** 合并 C1 的四个稳定查询标识和当前阶段附加属性。 */
function createLookupAttributes(identifiers, additional = {}) {
  return {
    "ai.platform.request_id": identifiers.requestId,
    "ai.platform.conversation_id": identifiers.conversationId,
    "ai.platform.run_id": identifiers.runId,
    "ai.platform.chain_trace_id": identifiers.chainTraceId,
    ...additional,
  };
}

/** 创建走真实 AI SDK telemetry、但由本地 fake LiteLLM 返回固定结果的 GatewayClient。 */
function createFixtureGateway() {
  return createGatewayClient({
    baseUrl: "http://fixture-gateway.test",
    model: "chat-default",
    apiKey: "poc-local-key",
    maxAttempts: 1,
    fetchImplementation: createFixtureFetch(),
  });
}

/** 创建只响应 chat completions 的 fake LiteLLM fetch，杜绝 PoC 向模型发送正文。 */
function createFixtureFetch() {
  /** 返回固定模型结果，不读取或记录请求正文。 */
  async function fixtureFetch(input) {
    const url = input instanceof Request ? input.url : String(input);
    if (!url.endsWith("/v1/chat/completions")) return jsonResponse({ error: "not found" }, 404);
    return jsonResponse({
      id: "chatcmpl-chaintrace-poc",
      object: "chat.completion",
      created: 1785369600,
      model: "poc-model",
      choices: [{ index: 0, message: { role: "assistant", content: SENSITIVE_ANSWER }, finish_reason: "stop" }],
      usage: { prompt_tokens: 60, completion_tokens: 8, total_tokens: 68 },
    });
  }
  return fixtureFetch;
}

/** 创建包含正文、图片和文档 URL 的脱敏扫描样例。 */
function createSensitiveModelMessages() {
  return [
    { role: "system", content: "C1 backend comparison fixture" },
    {
      role: "user",
      content: [
        { type: "text", text: `${SENSITIVE_PROMPT}\nDocument: ${SENSITIVE_DOCUMENT}` },
        { type: "image_url", image_url: { url: SENSITIVE_IMAGE } },
      ],
    },
  ];
}

/** 创建带 JSON content type 的标准响应。 */
function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

/** 断言候选后端收到的 Span 具备 C1 阶段、GenAI 子树和全部查询标识。 */
function assertFixtureShape(spans, identifiers) {
  const names = spans.map(readSpanName);
  for (const required of [
    "c1.conversation.run",
    "runtime.queue",
    "storage.start_run",
    "runtime.context.plan",
    "storage.complete_run",
    "channel.json.delivery",
  ]) {
    assert.ok(names.includes(required), `missing fixture span: ${required}`);
  }
  assert.ok(names.some(isInvokeAgentName), "missing AI SDK invoke_agent span");
  assert.ok(names.some(isChatName), "missing AI SDK chat span");

  for (const span of spans) {
    if (!["c1.conversation.run", "runtime.context.plan"].includes(span.name) && !isInvokeAgentName(span.name)) continue;
    assert.equal(span.attributes["ai.platform.request_id"], identifiers.requestId);
    assert.equal(span.attributes["ai.platform.conversation_id"], identifiers.conversationId);
    assert.equal(span.attributes["ai.platform.run_id"], identifiers.runId);
    assert.equal(span.attributes["ai.platform.chain_trace_id"], identifiers.chainTraceId);
  }
}

/** 扫描 Span 名称、属性、状态和事件，确保 fixture 敏感样例没有进入 Trace。 */
function assertSensitiveValuesAbsent(spans) {
  const serialized = JSON.stringify(spans.map(toInspectableSpan));
  for (const value of [SENSITIVE_PROMPT, SENSITIVE_ANSWER, SENSITIVE_IMAGE, SENSITIVE_DOCUMENT]) {
    assert.equal(serialized.includes(value), false, "sensitive fixture value entered exported spans");
  }
}

/** 把 ReadableSpan 收窄为隐私扫描所需字段。 */
function toInspectableSpan(span) {
  return {
    name: span.name,
    attributes: span.attributes,
    status: span.status,
    events: span.events.map(readInspectableEvent),
  };
}

/** 返回事件名称和属性，排除不参与隐私验证的运行时对象。 */
function readInspectableEvent(event) {
  return { name: event.name, attributes: event.attributes };
}

/** 读取 C1 根 Span 的 OTel trace_id。 */
function readFixtureTraceId(spans) {
  const root = spans.find(isRootSpan);
  assert.ok(root, "missing C1 root span");
  return root.spanContext().traceId;
}

/** 返回 Span 名称。 */
function readSpanName(span) {
  return span.name;
}

/** 判断 Span 是否为 C1 根 Span。 */
function isRootSpan(span) {
  return span.name === "c1.conversation.run";
}

/** 判断名称是否属于 AI SDK generateText 根 Span。 */
function isInvokeAgentName(name) {
  return name.startsWith("invoke_agent ");
}

/** 判断名称是否属于 AI SDK 模型推理 Span。 */
function isChatName(name) {
  return name.startsWith("chat ");
}

/** 排除仅用于本地断言的内存导出器。 */
function isExternalBackend(name) {
  return name !== "memory";
}

/** 命令行入口只输出安全关联标识，异常时不打印后端响应或凭据。 */
async function main() {
  try {
    const result = await runChainTraceBackendPoc();
    console.log(JSON.stringify(result, null, 2));
  } catch (error) {
    console.error(`C1 ChainTrace backend PoC failed: ${toSafeErrorMessage(error)}`);
    process.exitCode = 1;
  }
}

/** 将命令行错误限制为本地校验文本，不透传网络响应正文。 */
function toSafeErrorMessage(error) {
  if (error instanceof assert.AssertionError) return error.message;
  if (error?.message?.startsWith("CHAIN_TRACE_POC_")) return error.message;
  return "backend export or fixture validation failed";
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
