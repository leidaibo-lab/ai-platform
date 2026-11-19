import { matchesAcceptancePlan, type Lifecycle } from './contracts.js';

/** 从原生状态派生只读需求视图，历史或其他候选的结果不进入本轮视图。 */
export function projectAcceptanceEvidence(state: Lifecycle) {
  const { development, quality } = state;
  if (!development.input.requirementTracking) return undefined;
  const productHash = development.input.source.hash;
  const sourceHash = development.checkpointHash;
  const planHash = development.planHash;
  const currentPlan = matchesAcceptancePlan(state);
  const cases = currentPlan && quality.approval?.hash === quality.plan?.hash ? quality.approval?.cases ?? [] : [];
  const results = new Map((currentPlan && quality.sourceHash === sourceHash ? quality.results : []).map(
    /** 用例结果与批准包按 ID 关联。 */
    result => [result.caseId, result],
  ));
  return {
    productHash, sourceHash, planHash, qualityStatus: currentPlan ? quality.status : 'pending',
    reportHash: currentPlan ? quality.reportHash : null,
    impact: development.input.requirementImpact,
    requirements: development.requirements.map(requirement => ({
      id: requirement.id,
      text: requirement.text,
      taskIds: development.plan?.tasks.filter(task => task.requirementRefs.includes(requirement.id) || task.acceptanceRefs.includes(requirement.id)).map(task => task.id) ?? [],
      cases: cases.filter(item => item.requirementRefs.includes(requirement.id)).map(item => ({
        id: item.id, expected: item.expected, result: results.get(item.id),
      })),
    })),
  };
}
