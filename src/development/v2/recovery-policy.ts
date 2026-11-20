/** 额度与连续重试只触发原阶段等待，不决定需求是否结束；恢复沿用原生审批事实。 */
import { matchesRecoveryHashV2, recoveryHashV2, type StateV2, type RoleV2 } from './contracts.js';
import { recoveryReviewSchema } from '../contracts.js';
import type { z } from 'zod';
export const automaticAttempts = 5;
type TechnicalRecovery = NonNullable<StateV2['technicalRecovery']>;
export type TechnicalAttempt = TechnicalRecovery['attempts'][number];
type Fault = StateV2['faults'][number];

/** 同一 Run 在产品澄清前后的接续均占用总额度。 */
export function usedTechnicalAttempts(policy: TechnicalRecovery) {
  return (policy.priorAttempts ?? 0) + policy.attempts.filter(attempt => attempt.action !== 'platform-repair').length + (policy.platformResumes?.length ?? 0);
}

/** 只在同一执行责任和候选基线上传递诊断。 */
export function matchingFault(state: StateV2, role: RoleV2, taskId: string | null) {
  return state.faults.filter(fault => fault.phase === state.phase && fault.role === role && fault.taskId === taskId && fault.checkpointHash === state.checkpointHash).at(-1);
}

/** 只对明确的瞬时故障或可用的输出诊断安排再次执行。 */
export function technicalAction(fault: Fault): TechnicalAttempt['action'] | undefined {
  if (fault.origin === 'registered-checks') return 'rerun-checks';
  if (fault.diagnostic && fault.diagnostic.stage !== 'unknown') return 'correct-output';
  const failure = fault.modelCall?.failure;
  if (!failure) return undefined;
  if (failure.source === 'upstream-http') {
    return [408, 429, 500, 502, 503, 504, 524].includes(failure.httpStatus ?? 0) ? 'backoff' : undefined;
  }
  return ['mastra-total', 'mastra-step', 'mastra-first-chunk', 'transport-connect', 'transport-headers', 'transport-timeout', 'transport-network'].includes(failure.source) ? 'backoff' : undefined;
}

/** 将技术阻塞记录成团队待处理结果，保留审批和检查点。 */
export function blockTechnicalRecovery(state: StateV2, fault: Fault, reason: NonNullable<TechnicalRecovery['blocked']>['reason']): StateV2 {
  const modelSource = fault.modelCall?.failure.source;
  const platform = fault.origin === 'registered-checks' || fault.kind === 'model-timeout' || fault.kind === 'model-network'
    || modelSource === 'upstream-http' || modelSource?.startsWith('transport-');
  return { ...state, recovery: null, outcome: 'manual-attention', technicalRecovery: { ...state.technicalRecovery!, pendingFaultId: undefined, blocked: { faultId: fault.id!, owner: platform ? 'platform' : 'development', reason } } };
}

/** 复验结果引用实际发生的下一次执行及其产物。 */
export function recordTechnicalAttempt(state: StateV2, attempt: TechnicalAttempt): StateV2 {
  return { ...state, technicalRecovery: { ...state.technicalRecovery!, pendingFaultId: undefined, attempts: [...state.technicalRecovery!.attempts, attempt] } };
}
/** 连续临时故障指数退避，单轮最多五次，避免密集冲击模型服务。 */
export function retryDelayMs(attempt: number): number { return Math.min(8000, 1000 * 2 ** Math.max(0, attempt - 1)); }
/** 到达调用额度时保留预算和阶段，不伪造一次模型错误或清零累计计数。 */
export function pauseForCallBudget(state: StateV2, role: RoleV2): StateV2 {
  return { ...state, recovery: { hash: recoveryHashV2(state), checkpointHash: state.checkpointHash, phase: state.phase, role, taskId: null, kind: 'call-budget' } };
}
/** 人工重试可以多轮；仅在额度暂停点允许明确追加，所有历史消费和成功任务保留。 */
export function applyRecoveryDecision(state: StateV2, review: z.infer<typeof recoveryReviewSchema>): StateV2 {
  if (!state.recovery || review.hash !== state.recovery.hash || !matchesRecoveryHashV2(state, review.hash)) throw new Error('恢复版本发生漂移');
  if (review.decision === 'stop') return { ...state, recoveries: [...state.recoveries, review], recovery: null, outcome: 'manual-attention' };
  const exhausted = state.recovery.kind === 'call-budget' || state.calls >= state.maxCalls;
  if (exhausted && !review.additionalCalls) throw new Error('请明确确认追加调用额度后继续');
  if (!exhausted && review.additionalCalls) throw new Error('当前不是调用额度确认点');
  if (review.additionalContextLevel !== undefined) throw new Error('资料预算门槛已移除，请直接重试');
  const maxCalls = state.maxCalls + (review.additionalCalls ?? 0);
  if (!Number.isSafeInteger(maxCalls)) throw new Error('累计调用额度超出安全范围');
  return { ...state, maxCalls, recovery: null, recoveries: [...state.recoveries, review] };
}
