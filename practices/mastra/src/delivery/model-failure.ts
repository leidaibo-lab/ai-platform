/** 模型失败诊断 Adapter：识别常见 SDK/传输故障，只返回可持久化白名单证据。 */
import { z } from 'zod';
import { HandoffReadError } from './remote-handoff.js';

export const modelFailureSchema = z.object({ source: z.enum(['mastra-total', 'mastra-step', 'mastra-first-chunk', 'upstream-http', 'transport-connect', 'transport-headers', 'transport-timeout', 'handoff-read', 'aborted', 'unknown', 'tool-step-limit', 'output-length', 'content-filter', 'model-finish']), triggerLimitMs: z.number().int().positive().max(3600000).optional(), httpStatus: z.number().int().min(400).max(599).optional(), code: z.enum(['ETIMEDOUT', 'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_HEADERS_TIMEOUT', 'HANDOFF_VERSION_UNAVAILABLE', 'HANDOFF_HASH_MISMATCH', 'HANDOFF_FILE_UNREGISTERED']).optional(), finishReason: z.enum(['stop', 'length', 'tool-calls', 'content-filter', 'error', 'other', 'unknown', 'tripwire']).optional(), steps: z.number().int().nonnegative().optional(), maxSteps: z.number().int().positive().optional() });
export type ModelFailure = z.infer<typeof modelFailureSchema>;

/** 按明确 SDK 属性或传输码分类，忽略 message、URL 和请求响应正文。 */
export function diagnoseModelFailure(error: unknown): ModelFailure {
  if (error instanceof HandoffReadError) return { source: 'handoff-read', code: error.code };
  let current = error; let aborted = false;
  for (let depth = 0; depth < 5 && current && typeof current === 'object'; depth++) {
    const value = current as Record<string, unknown>;
    if (value.name === 'DevelopmentModelError') { const detail = modelFailureSchema.safeParse(value.failure); if (detail.success) return detail.data; }
    if (value.name === 'MastraTimeoutError' && typeof value.timeoutType === 'string' && ['total', 'step', 'firstChunk'].includes(value.timeoutType)) {
      const source = value.timeoutType === 'total' ? 'mastra-total' : value.timeoutType === 'step' ? 'mastra-step' : 'mastra-first-chunk';
      const limit = typeof value.timeoutMs === 'number' && Number.isInteger(value.timeoutMs) && value.timeoutMs > 0 && value.timeoutMs <= 3600000 ? value.timeoutMs : undefined;
      return { source, ...(limit ? { triggerLimitMs: limit } : {}) };
    }
    const status = value.statusCode ?? value.status;
    if (typeof status === 'number' && Number.isInteger(status) && status >= 400 && status <= 599) return { source: 'upstream-http', httpStatus: status };
    if (value.code === 'UND_ERR_CONNECT_TIMEOUT') return { source: 'transport-connect', code: value.code };
    if (value.code === 'UND_ERR_HEADERS_TIMEOUT') return { source: 'transport-headers', code: value.code };
    if (value.code === 'ETIMEDOUT') return { source: 'transport-timeout', code: value.code };
    aborted ||= value.name === 'AbortError';
    current = value.cause;
  }
  return { source: aborted ? 'aborted' : 'unknown' };
}
