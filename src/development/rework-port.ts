/** 研发返工 Port：验证跨团队请求后才进入研发内部状态策略。
 * ADR: docs/decisions/2026-11-21-unified-team-loop-and-project-adapters.md
 */
import { reworkRequestSchema, teamRunEnvelopeSchema, type ReworkRequest, type TeamRunEnvelope } from '../team/contracts.js';
import { decideTeamLoop } from '../team/loop.js';
import { reworkState } from './v2/autonomy.js';
import { evidenceRefs, stateV2Schema, type StateV2 } from './v2/contracts.js';
import { reportV2 } from './v2/gates.js';

export type DevelopmentReworkDisposition = 'rework' | 'clarification' | 'blocked' | 'exhausted';

/** 将研发专业状态投影成公共信封；投影本身不写 Store。 */
export function developmentEnvelope(state: StateV2): TeamRunEnvelope {
  const stopped = state.outcome === 'rework-exhausted' || state.outcome === 'manual-attention' || state.outcome === 'rejected';
  const completed = state.outcome === 'development-delivered';
  return teamRunEnvelopeSchema.parse({
    version: 'team-run-envelope.v1', teamId: 'development',
    status: completed ? 'completed' : state.outcome === 'clarification-required' ? 'blocked' : stopped ? 'stopped' : state.round ? 'rework' : 'running',
    phase: state.phase, inputVersion: state.version, budget: { used: state.round, limit: state.input.maxReworks },
    evidence: [...evidenceRefs(state)],
    ...(state.outcome === 'clarification-required' ? { blocker: { kind: 'business', detail: '研发需要已确认的业务决定' } } : {}),
    ...(completed ? { stopReason: 'completed' } : state.stopReason ? { stopReason: state.stopReason } : state.outcome === 'manual-attention' ? { stopReason: 'authorization-required' } : state.outcome === 'rejected' ? { stopReason: 'integrity' } : {}),
  });
}

/** 验证 QA 请求并由研发边界生成下一状态，调用方不能提交内部字段补丁。 */
export function requestDevelopmentRework(current: StateV2, value: ReworkRequest, source: { reportHash: string; checks: StateV2['checks'] }): { state: StateV2; disposition: DevelopmentReworkDisposition } {
  const state = stateV2Schema.parse(current);
  const request = reworkRequestSchema.parse(value);
  if (state.outcome !== 'development-delivered' || !state.delivery || state.delivery.sourceHash !== state.checkpointHash) throw new Error('返工请求缺少当前研发交付');
  if (request.targetCheckpointHash !== state.checkpointHash) throw new Error('返工请求与研发 checkpoint 不匹配');
  if (request.sourceReportHash !== source.reportHash) throw new Error('返工请求与测试报告不匹配');
  const allowed = evidenceRefs(state);
  for (const ref of request.evidenceRefs) if (!allowed.has(ref)) throw new Error('返工请求包含未知证据引用');
  for (const finding of request.findings) for (const ref of finding.refs) if (!allowed.has(ref)) throw new Error('返工缺陷引用未知研发证据');
  const report = reportV2({ verdict: 'FAIL', findings: request.findings, coverageRefs: request.evidenceRefs, unchecked: ['QA人工缺陷来源，非模型评审'], resolutions: [] }, { ...state, checks: source.checks });
  const base = stateV2Schema.parse({ ...state, stopReason: undefined, outcome: 'in-progress', delivery: null, checks: source.checks, codeReviews: [...state.codeReviews, report], recovery: null, ...(request.acceptanceCases ? { priorAcceptanceCases: request.acceptanceCases } : {}) });
  const business = request.findings.filter(/** 业务责任只进入产品澄清，完整性与人工责任停止。 */finding => finding.category === 'business' || finding.route === 'product');
  if (request.findings.some(finding => finding.category === 'integrity' || finding.route === 'human')) {
    return { state: stateV2Schema.parse({ ...base, outcome: 'manual-attention', stopReason: 'authorization-required' }), disposition: 'blocked' };
  }
  if (business.length) {
    const blockers = [...new Set([...(base.plan?.blockers ?? []), ...business.map(finding => `QA业务待决：${finding.detail}`)])];
    return { state: stateV2Schema.parse({ ...base, outcome: 'clarification-required', stopReason: 'business-decision', plan: { ...base.plan!, blockers } }), disposition: 'clarification' };
  }
  const routes = new Set(request.findings.map(/** 研发内部拥有缺陷路由策略。 */finding => finding.route));
  const selected = routes.has('architecture') ? 'architecture' : routes.size === 1 ? request.findings[0]!.route : state.input.autonomy ? 'all' : 'architecture';
  if (!['frontend', 'backend', 'infrastructure', 'architecture', 'all'].includes(selected)) throw new Error('返工请求没有可用研发路由');
  const route = selected as StateV2['route'];
  const next = reworkState(base, route, route === 'architecture' ? 'prepare-context' : 'implement');
  const action = decideTeamLoop(developmentEnvelope(next));
  return { state: next, disposition: action === 'stop' ? 'exhausted' : 'rework' };
}
