/** 模型调用诊断只保存白名单枚举、数值和本地计时，不保存异常正文、cause、URL或凭据。 */
import { z } from 'zod';
import { diagnoseModelFailure, modelFailureSchema, type ModelFailure } from '../../delivery/model-failure.js';
export { diagnoseModelFailure, modelFailureSchema, type ModelFailure } from '../../delivery/model-failure.js';
export const timeoutPolicySchema = z.object({ version: z.enum(['development-timeout.v2', 'development-timeout.v3']), totalMs: z.number().int().positive(), stepMs: z.number().int().positive() });
export const modelCallDiagnosticSchema = z.object({ version: z.literal('development-call.v1'), callIndex: z.number().int().positive(), durationMs: z.number().int().nonnegative(), recordedAt: z.iso.datetime(), policy: timeoutPolicySchema, failure: modelFailureSchema });
export type ModelCallDiagnostic = z.infer<typeof modelCallDiagnosticSchema>;

/** 开发角色每个模型步骤10分钟、一次Agent执行30分钟，人工等待不在模型计时内。 */
export function developmentTimeoutPolicy(_role: string): z.infer<typeof timeoutPolicySchema> {
  return { version: 'development-timeout.v3', totalMs: 1800000, stepMs: 600000 };
}
/** SDK 正常返回但未完成时保留白名单结束证据；工具停止不能推断为请求超时。 */
export function diagnoseModelResult(result: { finishReason?: unknown; steps: readonly unknown[]; error?: unknown }, maxSteps: number): ModelFailure {
  const parsed = modelFailureSchema.shape.finishReason.safeParse(result.finishReason);
  const finishReason = parsed.success && parsed.data ? parsed.data : 'unknown';
  const source = finishReason === 'error' ? diagnoseModelFailure(result.error).source
    : finishReason === 'tool-calls' && result.steps.length >= maxSteps ? 'tool-step-limit'
    : finishReason === 'length' ? 'output-length' : finishReason === 'content-filter' || finishReason === 'tripwire' ? 'content-filter' : 'model-finish';
  return modelFailureSchema.parse({ ...(finishReason === 'error' ? diagnoseModelFailure(result.error) : {}), source, finishReason, steps: result.steps.length, maxSteps });
}
/** 用固定字段形成可读诊断；未知超时不按耗时猜测90秒或上游错误。 */
export function describeModelCall(detail: ModelCallDiagnostic, attempt?: number): string {
  const sources: Record<ModelFailure['source'], string> = { 'tool-step-limit': '工具调用已达步骤上限，尚未生成最终结果', 'output-length': '模型输出达到长度上限，结果未完成', 'content-filter': '模型输出被安全规则阻断', 'model-finish': '模型提前结束，未生成完整结果', 'handoff-read': '交接资料读取失败（检查版本与散列）', 'mastra-total': 'Agent总执行时限触发', 'mastra-step': '单次模型步骤时限触发', 'mastra-first-chunk': '等待首段内容超时', 'upstream-http': detail.failure.httpStatus ? `上游HTTP ${detail.failure.httpStatus}` : '上游HTTP错误（状态码未记录）', 'transport-connect': '连接建立超时', 'transport-headers': '等待响应头超时', 'transport-timeout': '传输层超时', aborted: '调用被中断（未确认时限来源）', unknown: '未记录明确的失败来源' };
  return `${attempt === undefined ? '最近一次尝试' : `第${attempt}次尝试`}（角色调用序号${detail.callIndex}）：${sources[detail.failure.source]}${detail.failure.finishReason ? `，结束原因${detail.failure.finishReason}，步骤${detail.failure.steps ?? '?'} / ${detail.failure.maxSteps ?? '?'}` : ''}${detail.failure.triggerLimitMs ? `，触发时限${detail.failure.triggerLimitMs / 1000}秒` : ''}；实际耗时${Math.round(detail.durationMs / 1000)}秒；配置为模型步骤${detail.policy.stepMs / 1000}秒、Agent总计${detail.policy.totalMs / 1000}秒。`;
}
