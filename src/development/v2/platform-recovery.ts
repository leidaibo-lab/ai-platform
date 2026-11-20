import { createHmac, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import { recoveryHashV2, stateV2Schema, type StateV2 } from './contracts.js';
import { usedTechnicalAttempts } from './recovery-policy.js';

export const platformRecoveryStepId = 'await-platform-repair';
export const platformRepairEventSchema = z.strictObject({
  eventId: z.uuid(),
  faultId: z.uuid(),
  checkpoint: z.hash('sha256'),
});
export const platformRepairResumeSchema = platformRepairEventSchema.extend({ proof: z.hash('sha256') });
export const platformRepairPauseSchema = z.object({
  faultId: z.uuid(),
  checkpoint: z.hash('sha256'),
  dependency: z.enum(['model-service', 'registered-checks']),
  recoveryState: stateV2Schema,
});
type RepairEvent = z.infer<typeof platformRepairEventSchema>;

/** 仅已识别、可复验且仍有额度的依赖故障等待平台。 */
export function platformRepairPause(state: StateV2): z.infer<typeof platformRepairPauseSchema> | undefined {
  const policy = state.technicalRecovery;
  const blocked = policy?.blocked;
  if (!policy || blocked?.owner !== 'platform' || state.outcome !== 'manual-attention') return;
  if (blocked.reason === 'integrity' || blocked.reason === 'continuation-limit' || usedTechnicalAttempts(policy) >= policy.limit) return;
  const fault = state.faults.find(item => item.id === blocked.faultId);
  if (!fault?.id) return;
  const checks = fault.origin === 'registered-checks' && fault.checkIds?.some(id => id.startsWith('environment:'));
  const source = fault.modelCall?.failure.source;
  const model = source === 'upstream-http' || source?.startsWith('transport-');
  if (!checks && (!model || state.calls >= state.maxCalls)) return;
  if (checks && state.input.autonomy && (state.verificationHistory?.length ?? 0) >= state.input.autonomy.maxCheckRuns) return;
  return { faultId: fault.id, dependency: checks ? 'registered-checks' : 'model-service', checkpoint: recoveryHashV2(state), recoveryState: state };
}

/** 生成原生恢复证明。故障标识和完整检查点绑定单个暂停实例。 */
export function platformRepairProof(secret: string, event: RepairEvent) {
  return createHmac('sha256', secret).update(JSON.stringify(['platform-repair.v1', event.eventId, event.faultId, event.checkpoint])).digest('hex');
}

/** 等长编码后比较，避免通过响应时差判断配置值。 */
export function matchesPlatformSecret(actual: string, expected: string) {
  const value = Buffer.from(actual);
  const reference = Buffer.from(expected);
  return value.length === reference.length && timingSafeEqual(value, reference);
}

/** 原生步骤消费平台事件，将接续额度和待复验目标保存到下一轮。 */
export function acceptPlatformRepair(state: StateV2, resume: z.infer<typeof platformRepairResumeSchema>, secret: string): StateV2 {
  const pause = platformRepairPause(state);
  if (!pause || resume.faultId !== pause.faultId || resume.checkpoint !== pause.checkpoint
    || !matchesPlatformSecret(resume.proof, platformRepairProof(secret, resume))) throw new Error('平台修复事件与当前暂停版本不匹配');
  const policy = state.technicalRecovery!;
  if (policy.platformResumes?.some(receipt => receipt.eventId === resume.eventId)) throw new Error('平台修复事件已处理');
  const { eventId, faultId, checkpoint } = resume;
  return {
    ...state, outcome: 'in-progress',
    technicalRecovery: { ...policy, blocked: undefined, pendingFaultId: faultId, platformResumes: [...(policy.platformResumes ?? []), { eventId, faultId, checkpoint }] },
  };
}
