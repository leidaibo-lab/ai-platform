import { SpanStatusCode, trace } from "@opentelemetry/api";

const TRACER_NAME = "ai-platform.chain-trace";
const TRACER_VERSION = "0.6.0";

/**
 * @typedef {object} ChainSpan
 * @property {(name: string, value: unknown) => void} setAttribute - 写入单个脱敏属性。
 * @property {(attributes: Record<string, unknown>) => void} setAttributes - 批量写入脱敏属性。
 * @property {(error: unknown, attributes?: Record<string, unknown>) => void} recordError - 记录不含原始正文的错误分类。
 * @property {() => void} end - 结束手动创建的 Span。
 */

/**
 * @typedef {object} ChainTracer
 * @property {(name: string, attributes: Record<string, unknown>, operation: (span: ChainSpan) => unknown) => unknown} withSpan - 在活动上下文中执行阶段。
 * @property {(name: string, attributes?: Record<string, unknown>) => ChainSpan} startSpan - 创建由调用方结束的阶段。
 */

const NULL_CHAIN_SPAN = Object.freeze({
  /** 禁用观测时忽略单个属性。 */
  setAttribute() {},
  /** 禁用观测时忽略批量属性。 */
  setAttributes() {},
  /** 禁用观测时忽略错误。 */
  recordError() {},
  /** 禁用观测时无需结束 Span。 */
  end() {},
});

const NULL_CHAIN_TRACER = Object.freeze({
  /** 禁用观测时直接执行原操作，保持返回值和异常语义不变。 */
  withSpan(_name, _attributes, operation) {
    return operation(NULL_CHAIN_SPAN);
  },
  /** 禁用观测时返回 Null Object Span。 */
  startSpan() {
    return NULL_CHAIN_SPAN;
  },
});

/** 返回不产生任何遥测副作用的 ChainTracer Null Object。 */
export function createNullChainTracer() {
  return NULL_CHAIN_TRACER;
}

/**
 * 创建 C1 业务阶段追踪端口，Runtime 只依赖该端口而不感知具体观测后端。
 * Adapter 模式把业务 Span 语义映射到 OpenTelemetry API。
 *
 * @param {object} [options] - Tracer 开关与测试注入。
 * @param {boolean} [options.enabled=true] - 是否真实创建 Span。
 * @param {import("@opentelemetry/api").Tracer} [options.tracer] - 可替换 OTel Tracer。
 * @returns {ChainTracer} C1 Runtime 使用的追踪端口。
 */
export function createChainTracer({ enabled = true, tracer = trace.getTracer(TRACER_NAME, TRACER_VERSION) } = {}) {
  if (!enabled) return createNullChainTracer();

  return {
    /** 创建活动 Span，并在同步或异步操作结束后统一收口状态。 */
    withSpan(name, attributes, operation) {
      return tracer.startActiveSpan(
        String(name),
        { attributes: normalizeAttributes(attributes) },
        /** 把原生活动 Span 收窄为业务 ChainSpan 后执行调用方操作。 */
        (span) => executeWithinSpan(span, operation),
      );
    },

    /** 创建适合队列等待等跨回调阶段的手动 Span。 */
    startSpan(name, attributes = {}) {
      return createChainSpan(tracer.startSpan(String(name), { attributes: normalizeAttributes(attributes) }));
    },
  };
}

/** 执行 Span 内操作，并对同步异常和 Promise 拒绝执行相同的脱敏收口。 */
function executeWithinSpan(span, operation) {
  const chainSpan = createChainSpan(span);
  try {
    const result = operation(chainSpan);
    if (!isPromiseLike(result)) {
      span.end();
      return result;
    }
    return Promise.resolve(result).then(
      /** 异步操作成功后结束 Span 并透传结果。 */
      (value) => {
        span.end();
        return value;
      },
      /** 异步操作失败时只记录稳定分类，再结束 Span 并继续抛出原异常。 */
      (error) => {
        recordSanitizedError(span, error);
        span.end();
        throw error;
      },
    );
  } catch (error) {
    recordSanitizedError(span, error);
    span.end();
    throw error;
  }
}

/** 将原生 OTel Span 收窄为禁止写入对象正文的业务 Span API。 */
function createChainSpan(span) {
  return {
    /** 仅写入 OTel 支持的标量或标量数组。 */
    setAttribute(name, value) {
      const attributes = normalizeAttributes({ [name]: value });
      if (Object.hasOwn(attributes, name)) span.setAttribute(name, attributes[name]);
    },
    /** 过滤空值和对象后批量写入属性。 */
    setAttributes(attributes) {
      span.setAttributes(normalizeAttributes(attributes));
    },
    /** 记录稳定错误分类，不记录原始 message、stack 或响应数据。 */
    recordError(error, attributes = {}) {
      span.setAttributes(normalizeAttributes(attributes));
      recordSanitizedError(span, error);
    },
    /** 结束由调用方手动管理的 Span。 */
    end() {
      span.end();
    },
  };
}

/** 把业务属性限制为 OTel 标量和同类型标量数组，避免正文对象被意外序列化。 */
function normalizeAttributes(attributes = {}) {
  const normalized = {};
  for (const [name, value] of Object.entries(attributes || {})) {
    if (isAttributeValue(value)) normalized[name] = value;
  }
  return normalized;
}

/** 判断值是否可作为安全 OTel 属性，不接受任意对象。 */
function isAttributeValue(value) {
  if (["string", "number", "boolean"].includes(typeof value)) return true;
  return Array.isArray(value) && value.every(isAttributeScalar);
}

/** 判断数组成员是否为 OTel 支持的标量。 */
function isAttributeScalar(value) {
  return ["string", "number", "boolean"].includes(typeof value);
}

/** 记录不含原始错误正文和调用栈的异常事件与状态。 */
function recordSanitizedError(span, error) {
  const classification = classifyError(error);
  span.setAttributes(classification.attributes);
  span.recordException({ name: classification.name, message: "redacted" });
  span.setStatus({ code: SpanStatusCode.ERROR });
}

/** 从错误类型和状态码生成稳定、无正文的错误分类。 */
function classifyError(error) {
  const statusCode = Number(error?.status ?? error?.statusCode);
  let errorType = "internal";
  if (error?.name === "AbortError" || statusCode === 499) errorType = "cancelled";
  else if (error?.name === "TimeoutError" || [408, 504].includes(statusCode)) errorType = "timeout";
  else if (statusCode === 429) errorType = "rate_limit";
  else if (statusCode >= 500) errorType = "provider_unavailable";
  else if ([401, 403].includes(statusCode)) errorType = "authorization";
  else if (statusCode >= 400) errorType = "invalid_request";
  return {
    name: "ChainStageError",
    attributes: {
      "error.type": errorType,
      ...(Number.isFinite(statusCode) ? { "http.response.status_code": statusCode } : {}),
    },
  };
}

/** 判断返回值是否为 Promise-like 对象。 */
function isPromiseLike(value) {
  return value !== null && ["object", "function"].includes(typeof value) && typeof value.then === "function";
}
