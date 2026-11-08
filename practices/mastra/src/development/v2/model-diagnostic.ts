/** 模型调用诊断只保存白名单枚举、数值和本地计时，不保存异常正文、cause、URL或凭据。 */
import { z } from 'zod';
export const timeoutPolicySchema = z.object({ version: z.enum(['development-timeout.v2', 'development-timeout.v3']), totalMs: z.number().int().positive(), stepMs: z.number().int().positive() });
export const modelFailureSchema = z.object({ source: z.enum(['mastra-total', 'mastra-step', 'mastra-first-chunk', 'upstream-http', 'transport-connect', 'transport-headers', 'transport-timeout', 'aborted', 'unknown']), triggerLimitMs: z.number().int().positive().max(3600000).optional(), httpStatus: z.number().int().min(400).max(599).optional(), code: z.enum(['ETIMEDOUT', 'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_HEADERS_TIMEOUT']).optional() });
export const modelCallDiagnosticSchema = z.object({ version: z.literal('development-call.v1'), callIndex: z.number().int().positive(), durationMs: z.number().int().nonnegative(), recordedAt: z.iso.datetime(), policy: timeoutPolicySchema, failure: modelFailureSchema });
export type ModelFailure = z.infer<typeof modelFailureSchema>;
export type ModelCallDiagnostic = z.infer<typeof modelCallDiagnosticSchema>;

/** 开发角色每个模型步骤10分钟、一次Agent执行30分钟，人工等待不在模型计时内。 */
export function developmentTimeoutPolicy(_role: string): z.infer<typeof timeoutPolicySchema> {
  return { version: 'development-timeout.v3', totalMs: 1800000, stepMs: 600000 };
}
/** 优先提取明确的SDK超时或HTTP状态；外层AbortError不能掩盖内层实际来源。 */
export function diagnoseModelFailure(error: unknown): ModelFailure {
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
/** 用固定字段形成可读诊断；未知超时不按耗时猜测90秒或上游错误。 */
export function describeModelCall(detail: ModelCallDiagnostic, attempt?: number): string {
  const sources: Record<ModelFailure['source'], string> = { 'mastra-total': 'Agent总执行时限触发', 'mastra-step': '单次模型步骤时限触发', 'mastra-first-chunk': '等待首段内容超时', 'upstream-http': detail.failure.httpStatus ? `上游HTTP ${detail.failure.httpStatus}` : '上游HTTP错误（状态码未记录）', 'transport-connect': '连接建立超时', 'transport-headers': '等待响应头超时', 'transport-timeout': '传输层超时', aborted: '调用被中断（未确认时限来源）', unknown: '未取得明确的超时来源' };
  return `${attempt === undefined ? '最近一次尝试' : `第${attempt}次尝试`}（角色调用序号${detail.callIndex}）：${sources[detail.failure.source]}${detail.failure.triggerLimitMs ? `，触发时限${detail.failure.triggerLimitMs / 1000}秒` : ''}；实际耗时${Math.round(detail.durationMs / 1000)}秒；配置为模型步骤${detail.policy.stepMs / 1000}秒、Agent总计${detail.policy.totalMs / 1000}秒。`;
}
