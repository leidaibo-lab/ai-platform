/** 额度与连续重试只触发原阶段等待，不决定需求是否结束；恢复沿用原生审批事实。 */
import { recoveryHashV2, type StateV2, type RoleV2 } from './contracts.js';
import { recoveryReviewSchema } from '../contracts.js';
import type { z } from 'zod';
export const automaticAttempts = 5;
/** 连续临时故障指数退避，单轮最多五次，避免密集冲击模型服务。 */
export function retryDelayMs(attempt: number): number { return Math.min(8000, 1000 * 2 ** Math.max(0, attempt - 1)); }
/** 到达调用额度时保留预算和阶段，不伪造一次模型错误或清零累计计数。 */
export function pauseForCallBudget(state: StateV2, role: RoleV2): StateV2 {
  return { ...state, recovery: { hash: recoveryHashV2(state), checkpointHash: state.checkpointHash, phase: state.phase, role, taskId: null, kind: 'call-budget' } };
}
/** 人工重试可以多轮；仅在额度暂停点允许明确追加，所有历史消费和成功任务保留。 */
export function applyRecoveryDecision(state: StateV2, review: z.infer<typeof recoveryReviewSchema>): StateV2 {
  if (!state.recovery || review.hash !== state.recovery.hash || review.hash !== recoveryHashV2(state)) throw new Error('恢复版本发生漂移');
  if (review.decision === 'stop') return { ...state, recoveries: [...state.recoveries, review], recovery: null, outcome: 'manual-attention' };
  const exhausted = state.recovery.kind === 'call-budget' || state.calls >= state.maxCalls;
  if (exhausted && !review.additionalCalls) throw new Error('请明确确认追加调用额度后继续');
  if (!exhausted && review.additionalCalls) throw new Error('当前不是调用额度确认点');
  const maxCalls = state.maxCalls + (review.additionalCalls ?? 0);
  if (!Number.isSafeInteger(maxCalls)) throw new Error('累计调用额度超出安全范围');
  return { ...state, maxCalls, recovery: null, recoveries: [...state.recoveries, review] };
}
