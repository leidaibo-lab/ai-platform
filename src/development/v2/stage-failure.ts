/** 失败终态也保存最后尝试的脱敏证据；原生Error序列化保留details，不附带SDK原异常。 */
import { z } from 'zod';
import { phaseSchema, roleV2Schema, type StateV2 } from './contracts.js';
import { modelCallDiagnosticSchema } from './model-diagnostic.js';
export const stageFailureDetailsSchema = z.object({ version: z.literal('development-stage-failure.v1'), phase: phaseSchema, reason: z.literal('recovery-exhausted'), calls: z.number().int().nonnegative(), maxCalls: z.number().int().positive().max(Number.MAX_SAFE_INTEGER), faultCount: z.number().int().nonnegative(), attempts: z.array(z.object({ phase: phaseSchema, role: roleV2Schema, kind: z.enum(['model-timeout', 'model-network', 'invalid-output', 'model-error', 'context-budget']), attempt: z.number().int().positive(), modelCall: modelCallDiagnosticSchema.optional() })).max(8) });
/** SDK会序列化Error自有属性；这里只允许校验后的固定字段，禁止复制整个业务状态。 */
export class DevelopmentStageFailure extends Error {
  readonly details: z.infer<typeof stageFailureDetailsSchema>;
  /** 最近八条尝试足以定位本阶段，完整故障数与调用计数保留，旧记录无细项不补猜。 */
  constructor(state: StateV2) {
    super(`开发阶段 ${state.phase} 再次未完成（${state.recovery?.kind ?? 'model-error'}），人工恢复预算已耗尽`);
    this.name = 'DevelopmentStageFailure';
    this.details = stageFailureDetailsSchema.parse({ version: 'development-stage-failure.v1', phase: state.phase, reason: 'recovery-exhausted', calls: state.calls, maxCalls: state.maxCalls, faultCount: state.faults.length, attempts: state.faults.slice(-8).map(/** 仅复制诊断白名单，任务ID、源码、请求和cause均不写入异常。 */fault => ({ phase: fault.phase, role: fault.role, kind: fault.kind, attempt: fault.attempt, modelCall: fault.modelCall })) });
  }
}
