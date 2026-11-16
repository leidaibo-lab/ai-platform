import { useState, type KeyboardEvent, type MouseEvent } from 'react';

export interface RunFlowDocument {
  runId: string;
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
}

type StageId = 'requirements' | 'product' | 'development' | 'testing';
type StageState = 'done' | 'current' | 'pending' | 'failed';
interface Stage { id: StageId; label: string; }
interface StageDetail { title: string; description: string; nodes: readonly [string, string][]; }

const stages: readonly Stage[] = [
  { id: 'requirements', label: '需求澄清' },
  { id: 'product', label: '产品稿确认' },
  { id: 'development', label: '开发授权与实施' },
  { id: 'testing', label: '测试与发布' },
];

const details: Record<StageId, StageDetail> = {
  requirements: { title: '需求澄清', description: '收集输入、澄清业务目标，并形成需求基线。', nodes: [['需求输入', '收集原始需求'], ['业务澄清', '确认关键决策'], ['范围收敛', '明确边界与假设'], ['需求基线', '形成阶段产物']] },
  product: { title: '产品稿确认', description: '把需求基线整理成产品稿，并通过人工确认后交给研发。', nodes: [['产品方案', '承接需求基线'], ['方案修订', '吸收确认结果'], ['产品稿生成', '形成完整产品稿'], ['人工审阅', '确认当前版本']] },
  development: { title: '开发授权与实施', description: '确认项目范围、形成技术方案，并在获得授权后进入实施。', nodes: [['项目范围授权', '确认仓库与权限'], ['技术方案', '拆分实现边界'], ['研发实施', '按方案修改代码'], ['研发自检', '执行登记检查']] },
  testing: { title: '测试与发布', description: '验证交付结果，并在通过确认后执行发布或回滚。', nodes: [['测试准备', '准备验收条件'], ['测试执行', '执行登记检查'], ['结果确认', '确认测试回执'], ['发布与回滚', '执行发布关口']] },
};

const centers = [90, 330, 570, 810];

/** 将服务端 Run 快照归类到内部六阶段，供四阶段工作台展示使用。 */
export function getRunFlowStage(document?: RunFlowDocument): number {
  if (!document) return 0;
  const gate = document.gate?.key ?? '';
  if (['approve-test-cases', 'review-test-results'].includes(gate) || /testing|test-and-regression/.test(document.retry?.step ?? '') || /测试|质量/.test(document.progress?.phase ?? '')) return 4;
  if (['approve-release-scope', 'execute-release-externally', 'verify-release-health', 'execute-rollback-externally'].includes(gate) || /deployment|release|rollback|delivery/.test(document.retry?.step ?? '') || /发布|健康|回滚/.test(document.progress?.phase ?? '') || ['delivery-confirmed', 'fixture-completed', 'rolled-back'].includes(document.outcome ?? '') || document.status === 'success') return 5;
  if (gate === 'confirm-project-scope' || ['approve-architecture', 'resolve-readiness', 'resolve-findings', 'recover-development'].includes(gate) || document.developmentStop || document.blockage || /development|architecture/.test(document.retry?.step ?? '') || /开发|方案|架构|代码|开工/.test(document.progress?.phase ?? '') || document.outcome === 'blocked') return 3;
  if (document.product || document.step === 'review-product' || document.outcome === 'rejected') return 1;
  return 0;
}

/** 将内部阶段压缩为页面上的四个主流程节点。 */
function currentIndex(document: RunFlowDocument): number {
  const stage = getRunFlowStage(document);
  return stage <= 0 ? 0 : stage === 1 ? 1 : stage <= 3 ? 2 : 3;
}

/** 生成用户可读的当前节点文案。 */
function currentNode(document: RunFlowDocument): string {
  if (document.gate?.title) return document.gate.title;
  if (document.retry?.title) return document.retry.title;
  if (document.progress?.phase) return document.progress.phase;
  if (document.step === 'guided-requirements') return '产品团队 · 需求澄清';
  if (document.step === 'review-product' || document.product) return '产品团队 · 产品稿审阅';
  if (document.status === 'success') return '流程已完成';
  return '研发团队 · 技术方案';
}

/** 计算主流程的完成、当前和待执行状态。 */
function states(document: RunFlowDocument, active: number): StageState[] {
  const failed = document.status === 'failed' || document.status === 'tripwire';
  const terminal = ['success', 'canceled', 'bailed'].includes(document.status);
  return stages.map((_, index) => index < active ? 'done' : index === active ? failed ? 'failed' : terminal && active === 3 ? 'done' : 'current' : 'pending');
}

/** 根据选中阶段和当前主流程生成阶段内部节点状态。 */
function detailStates(stageId: StageId, active: number): StageState[] {
  const index = stages.findIndex(stage => stage.id === stageId);
  if (index < active) return details[stageId].nodes.map(() => 'done');
  if (index > active) return details[stageId].nodes.map(() => 'pending');
  const current = stageId === 'development' ? 1 : stageId === 'testing' ? 0 : details[stageId].nodes.length - 1;
  return details[stageId].nodes.map((_, nodeIndex) => nodeIndex < current ? 'done' : nodeIndex === current ? 'current' : 'pending');
}

/** 将阶段状态转换成详情节点文案。 */
function stateLabel(state: StageState): string { return { done: '已完成', current: '当前节点', pending: '待执行', failed: '执行失败' }[state]; }

/** 渲染阶段专属节点详情，查看历史阶段不会改变顶部真实位置。 */
function StageDialog({ stageId, document, active, close }: { stageId: StageId; document: RunFlowDocument; active: number; close: () => void }) {
  const detail = details[stageId];
  const nodeStates = detailStates(stageId, active);
  /** 只处理背景点击关闭，不提交任何业务动作。 */
  function handleBackdrop(event: MouseEvent<HTMLDivElement>) { if (event.currentTarget === event.target) close(); }
  return <div className="workflow-dialog" role="presentation" onClick={handleBackdrop}>
    <div className="workflow-dialog-card" role="dialog" aria-modal="true" aria-labelledby="workflow-dialog-title">
      <div className="workflow-dialog-head"><div><span className="intake-eyebrow">阶段流程详情</span><h2 id="workflow-dialog-title">{detail.title}</h2></div><button className="workflow-dialog-close" type="button" aria-label="关闭阶段详情" onClick={close}>×</button></div>
      <p className="workflow-dialog-current">查看阶段节点：{detail.title}。运行当前节点：{currentNode(document)}。{detail.description}</p>
      <div className="team-flow">{detail.nodes.map(/** 阶段详情只展示当前阶段自己的节点。 */([title, description], index) => <div className={`team-step ${nodeStates[index]}`} key={title}><small>0{index + 1} · {stateLabel(nodeStates[index])}</small><strong>{title}</strong><span>{description}</span></div>)}</div>
      <div className="workflow-node-detail"><h3>节点说明</h3><p>{detail.description}</p></div>
    </div>
  </div>;
}

/** 渲染动态 SVG 主流程和可点击的阶段专属详情浮层。 */
export function RunFlowMini({ document }: { document: RunFlowDocument }) {
  const active = currentIndex(document);
  const stageStates = states(document, active);
  const [selected, setSelected] = useState<StageId>();
  const activeLabel = stages[active].label;
  const status = document.status === 'suspended' || document.status === 'waiting' ? '等待人工确认' : stageStates[active] === 'failed' ? '执行失败' : '执行中';

  /** 打开阶段详情。 */
  function openStage(stageId: StageId) { setSelected(stageId); }
  /** 支持键盘操作 SVG 阶段节点。 */
  function handleKeyDown(event: KeyboardEvent<SVGGElement>, stageId: StageId) { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); openStage(stageId); } }
  /** 关闭阶段详情。 */
  function closeStage() { setSelected(undefined); }

  return <>
    <section className="workflow-overview" aria-label="Workflow 主流程动态状态">
      <div className="workflow-overview-head"><div><span className="intake-eyebrow">Workflow 主流程 · 动态状态</span><strong>{activeLabel}</strong><small>当前位于：{currentNode(document)}</small></div><button className="workflow-detail-button" type="button" onClick={/** 默认打开当前阶段的内部流程。 */() => openStage(stages[active].id)}>查看阶段流程</button></div>
      <svg className="workflow-svg" viewBox="0 0 900 78" role="img" aria-label="需求澄清、产品稿确认、开发授权与实施、测试与发布四阶段流程">
        <path className="workflow-track" d="M90 28 H810" /><path className="workflow-progress" d={`M90 28 H${centers[active]}`} />
        {stages.map(/** 主流程节点按服务端快照渲染。 */(stage, index) => <g className={`workflow-node ${stageStates[index]}`} key={stage.id} tabIndex={0} role="button" aria-label={`查看${stage.label}流程`} onClick={/** 点击节点只打开详情。 */() => openStage(stage.id)} onKeyDown={/** 键盘打开阶段详情。 */event => handleKeyDown(event, stage.id)}><rect x={centers[index] - 60} y="5" width="120" height="68" fill="#fff" fillOpacity="0.001" pointerEvents="all" /><circle cx={centers[index]} cy="28" r={stageStates[index] === 'current' ? 12 : 10} />{stageStates[index] === 'done' && <text className="workflow-node-check" x={centers[index]} y="32">✓</text>}<text x={centers[index]} y="51">{String(index + 1).padStart(2, '0')} {stage.label}</text><text className="workflow-node-state" x={centers[index]} y="67">{stateLabel(stageStates[index])}</text></g>)}
      </svg>
      <div className="workflow-current"><span>当前节点</span><strong>{currentNode(document)}</strong><span>·</span><span>{status}</span></div>
      <div className="workflow-legend" aria-label="Workflow 状态图例"><span><i className="legend-mark done" />已完成</span><span><i className="legend-mark current" />当前阶段</span><span><i className="legend-mark" />待执行</span></div>
    </section>
    {selected && <StageDialog stageId={selected} document={document} active={active} close={closeStage} />}
  </>;
}
