import type { RunTimelineDocument, TimelineNode } from './run-timeline-types';

export const teams = ['product', 'development', 'testing', 'delivery'] as const;
export type Team = typeof teams[number];
export type TeamState = 'done' | 'current' | 'pending' | 'failed' | 'stopped';
export interface RunFlowDocument {
  timeline?: RunTimelineDocument;
  runId: string;
  brief?: string;
  status: string;
  outcome?: string;
  step?: string;
  gate?: { key: string; title: string };
  progress?: { phase: string; title: string };
  retry?: { step: string; title: string };
  intake?: { round?: number };
  developmentStop?: { reason: string };
  blockage?: unknown;
  product?: unknown;
  clarify?: unknown;
  productCorrection?: { status: 'saved' };
  appliedCorrection?: { target: string };
}

const productReturn = /^(analyze-blocker-questions|confirm-blocker-answers|write-revised-product|review-revised-product)$/;
export const productPhases = ['对齐方向', '完善规格', '审阅交接'] as const;
const productContainers = new Set(['product-team', 'draft-product', 'guided-requirements', 'requirements-round']);

/** 将初稿、历史流程和下游返工路径投影到同一组产品阶段。 */
function productPhaseForPath(path = '') {
  const step = path.replace(/#\d+$/, '').split('.').at(-1) ?? '';
  if (/^(product-specification|product-writing|publish-product|review-product-quality|write-revised-product)$/.test(step)) return productPhases[1];
  if (/^(review-product|review-revised-product|complete-product-team)$/.test(step)) return productPhases[2];
  return productPhases[0];
}

/** 取当前产品操作对应的阶段，用于标题与详情的统一展示。 */
function currentProductPhase(document: RunFlowDocument, node?: TimelineNode) {
  if (document.product) return productPhases[2];
  if (document.gate?.key === 'review-revised-product') return productPhases[2];
  if (document.intake || document.clarify) return productPhases[0];
  return productPhaseForPath(document.gate?.key ?? document.retry?.step ?? node?.id ?? document.step);
}

/** 以最近的原生步骤汇总阶段状态，容器与 Agent 活动仅作为原始记录。 */
export function projectProductPhases(document: RunFlowDocument, flow: ReturnType<typeof projectRunFlow>) {
  const latest = new Map<typeof productPhases[number], TimelineNode['status']>();
  for (const node of document.timeline?.nodes ?? []) {
    if (node.kind !== 'step' || nodeTeam(node) !== 'product' || node.status === 'pending') continue;
    const step = node.id.replace(/#\d+$/, '').split('.').at(-1) ?? '';
    if (!productContainers.has(step)) latest.set(productPhaseForPath(step), node.status);
  }
  const current = flow.productPhase;
  let activeStatus: TimelineNode['status'] = 'pending';
  if (flow.states.product === 'failed') activeStatus = 'failed';
  else if (flow.states.product === 'stopped') activeStatus = 'cancelled';
  else if (document.clarify || document.productCorrection || document.status === 'suspended') activeStatus = 'suspended';
  else if (document.status === 'waiting') activeStatus = 'waiting';
  else if (document.status === 'running') activeStatus = 'running';
  return productPhases.map(phase => ({
    phase,
    status: flow.active === 'product' && phase === current ? activeStatus : latest.get(phase) ?? 'pending',
  }));
}

/** 按业务职责解释步骤路径，兼容嵌套在其他团队 Workflow 中的历史子流程。 */
export function teamForPath(path = ''): Team | undefined {
  const parts = path.replace(/#\d+$/, '').split('.');
  const leaf = parts.at(-1) ?? '';
  if (productReturn.test(leaf) || parts.includes('product-team') || /^(guided-requirements|confirm-requirements|analyze-requirements|product-.+|review-product|review-product-quality|publish-product)$/.test(leaf)) return 'product';
  if (parts.some(part => /^(delivery-team|deployment-team|submit-merge-request|confirm-final-delivery|approve-release-scope|execute-release-externally|verify-release-health|execute-rollback-externally)$/.test(part))) return 'delivery';
  if (parts.some(part => /^(development-team|qa-defect-repair|replanned-development|confirm-project-scope|approve-architecture|resolve-readiness|resolve-findings|recover-development)$/.test(part))) return 'development';
  if (parts.some(part => /^(test-team|testing-team|test-and-regression-cycle|approve-test-cases|review-test-results)$/.test(part))) return 'testing';
}

/** 利用步骤路径与旧时间线字段将活动卡片归到同一个团队。 */
export function nodeTeam(node: TimelineNode): Team | undefined {
  return (node.kind === 'step' ? teamForPath(node.id) : undefined) ?? (node.stage === 'requirements' ? 'product' : node.stage ?? undefined);
}

/** 在当前状态对应的步骤中选取最近、最具体的执行节点。 */
function relevantNodes(document: RunFlowDocument, status?: TimelineNode['status']) {
  return (document.timeline?.nodes ?? []).filter(node => node.kind === 'step' && (!status || node.status === status) && nodeTeam(node))
    .sort((left, right) => (right.endedAt ?? right.startedAt ?? '').localeCompare(left.endedAt ?? left.startedAt ?? '') || right.id.split('.').length - left.id.split('.').length);
}

/** 将原生快照投影为四团队状态和有明确证据的回流状态。 */
export function projectRunFlow(document: RunFlowDocument) {
  const failed = ['failed', 'tripwire'].includes(document.status);
  const settled = ['success', 'bailed', 'canceled', 'cancelled'].includes(document.status);
  const done = document.status === 'success' && ['delivery-confirmed', 'fixture-completed'].includes(document.outcome ?? '');
  const targetStatus = failed ? 'failed' : document.status === 'suspended' ? 'suspended' : document.status === 'waiting' ? 'waiting' : 'running';
  const node = relevantNodes(document, targetStatus)[0];
  const last = settled ? relevantNodes(document, 'completed')[0] : undefined;
  const gate = document.gate?.key;
  // 恢复节点使用原路径，避免把 QA 缺陷修复错算成测试或产品。
  const gateTeam = gate === 'recover-development' && node ? nodeTeam(node) : teamForPath(gate);
  const active = done ? 'delivery' : document.clarify || document.productCorrection ? 'product'
    : gateTeam ?? teamForPath(document.retry?.step) ?? (node && nodeTeam(node))
      ?? (document.intake || document.product || document.outcome === 'rejected' ? 'product' : undefined)
      ?? (last && nodeTeam(last)) ?? teamForPath(document.step)
      ?? (document.developmentStop || document.blockage ? 'development' : 'product');
  const status = done ? '已完成' : document.clarify ? '等待业务处理' : document.productCorrection ? '纠偏已保存'
    : failed ? '执行失败' : settled ? '已停止' : document.status === 'suspended' || document.status === 'waiting' ? '等待确认'
      : document.status === 'running' ? '执行中' : '待执行';
  const states = Object.fromEntries(teams.map((team, index) => [team, done || index < teams.indexOf(active) ? 'done'
    : team !== active ? 'pending' : failed ? 'failed' : settled && !document.clarify ? 'stopped' : 'current'])) as Record<Team, TeamState>;
  const returnPath = node?.id ?? document.retry?.step ?? '';
  const businessReturn = !!document.clarify || active === 'product' && (productReturn.test(gate ?? '') || returnPath.includes('resolve-development-blockers') || productReturn.test(returnPath.split('.').at(-1) ?? ''));
  const qaRepair = active === 'development' && returnPath.includes('qa-defect-repair');
  const correction = !!document.productCorrection || !settled && active === 'product' && !!document.appliedCorrection && !businessReturn;
  const title = done ? '交付完成' : document.clarify ? '待处理业务缺口' : document.productCorrection ? '立即纠偏'
    : document.gate?.title ?? document.retry?.title ?? (node && nodeTeam(node) === active ? node.title : undefined)
      ?? (document.intake || document.step === 'guided-requirements' ? '需求澄清' : document.product || document.step === 'review-product' ? '产品稿审阅' : undefined)
      ?? document.progress?.phase;
  const productPhase = currentProductPhase(document, node ?? last);
  return { active, states, status, title, node, productPhase, businessReturn, qaRepair, correction };
}
