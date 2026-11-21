/** Team Loop 纯决策 Kernel；循环、暂停和恢复仍由 Mastra Workflow/Store 执行。 */
import { teamRunEnvelopeSchema, type TeamRunEnvelope } from './contracts.js';

export type TeamLoopAction = 'continue' | 'request-rework' | 'complete' | 'block' | 'stop';

/** 将公共信封确定性映射为下一动作，不读写外部状态。 */
export function decideTeamLoop(value: TeamRunEnvelope): TeamLoopAction {
  const envelope = teamRunEnvelopeSchema.parse(value);
  if (envelope.status === 'completed') return 'complete';
  if (envelope.status === 'blocked') return 'block';
  if (envelope.status === 'stopped') return 'stop';
  if (envelope.status === 'rework') return 'request-rework';
  return 'continue';
}

/** 只有完成、阻塞和停止是循环终态；返工需要目标团队继续处理。 */
export function isTeamLoopTerminal(value: TeamRunEnvelope): boolean {
  return ['complete', 'block', 'stop'].includes(decideTeamLoop(value));
}
