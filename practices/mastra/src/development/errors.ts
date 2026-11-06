/** 模型异常边界：仅保留固定分类，不保留 SDK 异常、cause、请求或响应。 */
import type { DevelopmentState } from './contracts.js';

type FaultKind = DevelopmentState['faults'][number]['kind'];

/** 白名单分类同时处理 SDK 抛错与 finishReason=error 返回的异常。 */
export function classifyDevelopmentError(error: unknown): FaultKind {
  let current = error;
  for (let depth = 0; depth < 5 && current && typeof current === 'object'; depth++) {
    if (current instanceof DevelopmentModelError) return current.kind;
    const value = current as { name?: unknown; code?: unknown; status?: unknown; statusCode?: unknown; cause?: unknown };
    if (typeof value.name === 'string' && ['TimeoutError', 'AbortError', 'MastraTimeoutError'].includes(value.name)) return 'model-timeout';
    if (typeof value.code === 'string' && ['ETIMEDOUT', 'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_HEADERS_TIMEOUT'].includes(value.code)) return 'model-timeout';
    if (typeof value.code === 'string' && ['ENOTFOUND', 'EAI_AGAIN', 'ECONNRESET', 'ECONNREFUSED', 'EPIPE', 'UND_ERR_SOCKET'].includes(value.code)) return 'model-network';
    const status = value.statusCode ?? value.status;
    if (typeof status === 'number' && Number.isInteger(status) && (status === 429 || (status >= 500 && status <= 599))) return 'model-network';
    if (typeof value.name === 'string' && ['ZodError', 'SyntaxError', 'AI_NoObjectGeneratedError', 'AI_TypeValidationError', 'NoObjectGeneratedError', 'TypeValidationError'].includes(value.name)) return 'invalid-output';
    current = value.cause;
  }
  return 'model-error';
}

/** Workflow 可安全记录的异常，仅包含应用拥有的固定 kind。 */
export class DevelopmentModelError extends Error {
  /** 禁止把原异常作为 cause 附到新错误上，避免框架 logger 展开敏感内容。 */
  constructor(readonly kind: FaultKind) {
    super(`开发角色调用失败：${kind}`);
    this.name = 'DevelopmentModelError';
  }
}
