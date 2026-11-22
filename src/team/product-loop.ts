import { decideTeamLoop } from './loop.js';
import type { TeamRunEnvelope } from './contracts.js';

/** 将产品既有阶段事实投影到公共决策，不创建持久状态。 */
export function decideProductLoop(phase: string, inputVersion: string, status: TeamRunEnvelope['status'], evidence: string[] = [], budget = { used: 0, limit: 0 }) {
  return decideTeamLoop({ version: 'team-run-envelope.v1', teamId: 'product', phase, inputVersion, status, budget, evidence });
}
