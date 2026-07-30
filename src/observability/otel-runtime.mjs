import { OpenTelemetry } from "@ai-sdk/otel";
import { trace } from "@opentelemetry/api";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { resourceFromAttributes } from "@opentelemetry/resources";
import { NodeSDK } from "@opentelemetry/sdk-node";
import { BatchSpanProcessor, ParentBasedSampler, TraceIdRatioBasedSampler } from "@opentelemetry/sdk-trace-base";
import { registerTelemetry } from "ai";
import { createChainTracer, createNullChainTracer } from "./chain-tracer.mjs";

const DEFAULT_OTLP_ENDPOINT = "http://localhost:4318";
const DEFAULT_SERVICE_NAME = "ai-platform-demo";
const SDK_TRACER_NAME = "ai-platform.chain-trace";
const SDK_VERSION = "0.6.0";
let aiSdkTelemetryRegistered = false;

/**
 * 初始化默认关闭的 OpenTelemetry PoC，并返回 Runtime 可注入的 ChainTracer。
 * Facade 模式统一管理 SDK、Exporter、采样、AI SDK 适配和进程关闭。
 *
 * @param {object} [options] - OTel 开关和导出配置。
 * @param {boolean} [options.enabled=false] - 是否启用 PoC。
 * @param {string} [options.endpoint] - OTLP HTTP 基础地址或 `/v1/traces` 地址。
 * @param {string} [options.serviceName] - OTel service.name。
 * @param {number} [options.samplingRatio=1] - 根 Trace 采样比例。
 * @param {object} [dependencies] - 测试可替换的 Exporter、Processor 和 SDK 工厂。
 * @returns {object} OTel 生命周期和 ChainTracer。
 */
export function initializeOpenTelemetry(
  {
    enabled = false,
    endpoint = DEFAULT_OTLP_ENDPOINT,
    serviceName = DEFAULT_SERVICE_NAME,
    samplingRatio = 1,
  } = {},
  { traceExporter, spanProcessor, createNodeSdk = createDefaultNodeSdk } = {},
) {
  if (!enabled) return createDisabledRuntime();

  const exporter = traceExporter || new OTLPTraceExporter({ url: resolveTraceEndpoint(endpoint) });
  const processor = spanProcessor || new BatchSpanProcessor(exporter);
  const sdk = createNodeSdk({
    autoDetectResources: false,
    resource: resourceFromAttributes({
      "service.name": String(serviceName || DEFAULT_SERVICE_NAME),
      "service.version": SDK_VERSION,
      "ai.platform.area": "agent-runtime",
    }),
    sampler: new ParentBasedSampler({ root: new TraceIdRatioBasedSampler(normalizeSamplingRatio(samplingRatio)) }),
    spanProcessors: [processor],
  });
  sdk.start();
  registerAiSdkTelemetry();

  let shutdownPromise = null;
  return {
    enabled: true,
    chainTracer: createChainTracer({ tracer: trace.getTracer(SDK_TRACER_NAME, SDK_VERSION) }),
    /** 立即导出当前已结束 Span，供测试和受控进程收口使用。 */
    async forceFlush() {
      await processor.forceFlush();
    },
    /** 幂等刷新并关闭 OTel SDK，确保批处理 Span 不在进程退出时丢失。 */
    shutdown() {
      if (!shutdownPromise) shutdownPromise = flushAndShutdown(processor, sdk);
      return shutdownPromise;
    },
  };
}

/** 创建 NodeSDK，保留测试替换点而不把 SDK 构造细节泄漏给调用方。 */
function createDefaultNodeSdk(configuration) {
  return new NodeSDK(configuration);
}

/** 返回完全无副作用的禁用态生命周期。 */
function createDisabledRuntime() {
  return {
    enabled: false,
    chainTracer: createNullChainTracer(),
    forceFlush: noOperation,
    shutdown: noOperation,
  };
}

/** 为禁用态 flush/shutdown 提供可等待的空操作。 */
async function noOperation() {}

/** 先刷新处理器，再关闭 SDK；刷新失败时仍释放 SDK 资源。 */
async function flushAndShutdown(processor, sdk) {
  try {
    await processor.forceFlush();
  } finally {
    await sdk.shutdown();
  }
}

/** 全局只注册一次带错误脱敏的 AI SDK OTel 集成。 */
function registerAiSdkTelemetry() {
  if (aiSdkTelemetryRegistered) return;
  registerTelemetry(
    new RedactedOpenTelemetry({
      runtimeContext: true,
      usage: true,
      enrichSpan: enrichAiSdkSpan,
    }),
  );
  aiSdkTelemetryRegistered = true;
}

/**
 * 使用官方 OTel 集成生成 GenAI Span，只替换其错误事件中的原始 message 和 stack。
 * 输入和输出正文仍由每次 AI SDK 调用的 telemetry 配置显式关闭。
 */
class RedactedOpenTelemetry extends OpenTelemetry {
  /** 把官方集成收到的任意模型错误替换为无正文错误后再记录。 */
  onError(event) {
    if (!event?.callId) return super.onError(createRedactedError());
    return super.onError({ ...event, error: createRedactedError() });
  }
}

/** 创建不包含原始异常 message、stack 或响应数据的固定错误。 */
function createRedactedError() {
  const error = new Error("redacted");
  error.name = "ModelCallError";
  error.stack = undefined;
  return error;
}

/** 把安全 Runtime Context 映射为平台命名空间属性，便于后端直接检索业务身份。 */
function enrichAiSdkSpan({ runtimeContext }) {
  const attributes = {};
  assignOptionalAttribute(attributes, "ai.platform.chain_trace_id", runtimeContext?.chainTraceId);
  assignOptionalAttribute(attributes, "ai.platform.request_id", runtimeContext?.requestId);
  assignOptionalAttribute(attributes, "ai.platform.conversation_id", runtimeContext?.conversationId);
  assignOptionalAttribute(attributes, "ai.platform.run_id", runtimeContext?.runId);
  assignOptionalAttribute(attributes, "ai.platform.model.attempt", runtimeContext?.attempt);
  assignOptionalAttribute(attributes, "ai.platform.scenario_id", runtimeContext?.scenarioId);
  assignOptionalAttribute(attributes, "ai.platform.operation", runtimeContext?.operation);
  return attributes;
}

/** 只把非空字符串、数字和布尔值放入 OTel 属性。 */
function assignOptionalAttribute(attributes, name, value) {
  if (["string", "number", "boolean"].includes(typeof value) && value !== "") attributes[name] = value;
}

/** 把 OTLP 基础地址规范为 Trace Exporter 所需的 `/v1/traces` 地址。 */
function resolveTraceEndpoint(endpoint) {
  const url = new URL(String(endpoint || DEFAULT_OTLP_ENDPOINT));
  if (!url.pathname.endsWith("/v1/traces")) {
    url.pathname = `${url.pathname.replace(/\/$/, "")}/v1/traces`;
  }
  return url.toString();
}

/** 把采样比例限制在 0 到 1，非法值回退为全量采样。 */
function normalizeSamplingRatio(value) {
  const ratio = Number(value);
  return Number.isFinite(ratio) && ratio >= 0 && ratio <= 1 ? ratio : 1;
}
