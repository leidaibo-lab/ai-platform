import { useEffect, useId, useLayoutEffect, useRef, useState, type MouseEvent } from 'react';
import { Check, CircleCheck, ClipboardList, Code2, FileCheck2, Sparkles, ArrowUpRight, Clock3, ChevronDown } from 'lucide-react';
import type { RunTimelineDocument, TimelineNode } from './RunActivityFeed';

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

const stageIcons = [Sparkles, FileCheck2, Code2, CircleCheck];

const details: Record<StageId, StageDetail> = {
  requirements: { title: '需求澄清', description: '收集输入、澄清业务目标，并形成需求基线。', nodes: [['需求输入', '收集原始需求'], ['业务澄清', '确认关键决策'], ['范围收敛', '明确边界与假设'], ['需求基线', '形成阶段产物']] },
  product: { title: '产品稿确认', description: '把需求基线整理成产品稿，并通过人工确认后交给研发。', nodes: [['产品方案', '承接需求基线'], ['方案修订', '吸收确认结果'], ['产品稿生成', '形成完整产品稿'], ['人工审阅', '确认当前版本']] },
  development: { title: '开发授权与实施', description: '确认项目范围、形成技术方案，并在获得授权后进入实施。', nodes: [['项目范围授权', '确认仓库与权限'], ['技术方案', '拆分实现边界'], ['研发实施', '按方案修改代码'], ['研发自检', '执行登记检查']] },
  testing: { title: '测试与发布', description: '验证交付结果，并在通过确认后执行发布或回滚。', nodes: [['测试准备', '准备验收条件'], ['测试执行', '执行登记检查'], ['结果确认', '确认测试回执'], ['发布与回滚', '执行发布关口']] },
};

/** 阶段来自服务端的只读投影。 */
function nodeStage(node: TimelineNode): StageId | undefined { return node.stage ?? undefined; }

/** 将服务端节点状态转换为简短标签。 */
function activityLabel(status: TimelineNode['status']): string {
  return { pending: '待执行', running: '执行中', completed: '已完成', failed: '执行失败', waiting: '等待中', suspended: '等待确认', cancelled: '已停止' }[status];
}

/** 读取快照中最具体的正在执行节点，避免父步骤或已暂停的历史节点覆盖当前阶段。 */
function runningNode(document: RunFlowDocument): TimelineNode | undefined {
  const target = document.status === 'failed' || document.status === 'tripwire' ? 'failed' : 'running';
  const nodes = (document.timeline?.nodes ?? []).filter(node => node.kind === 'step' && node.status === target && node.stage);
  return nodes.sort((left, right) => {
    const depth = right.id.split('.').length - left.id.split('.').length;
    return depth || (right.startedAt ?? '').localeCompare(left.startedAt ?? '');
  })[0];
}

/** 将节点耗时格式化为便于阅读的时、分、秒。 */
function formatNodeDuration(ms: number | null): string {
  if (ms === null || !Number.isFinite(ms)) return '暂无数据';
  const seconds = Math.floor(Math.max(0, ms) / 1000);
  if (seconds >= 3600) return `${Math.floor(seconds / 3600)}小时${Math.floor(seconds % 3600 / 60)}分${seconds % 60}秒`;
  if (seconds >= 60) return `${Math.floor(seconds / 60)}分${seconds % 60}秒`;
  return `${seconds}秒`;
}

/** 将服务端 Run 快照归类到内部六阶段，供四阶段工作台展示使用。 */
export function getRunFlowStage(document?: RunFlowDocument): number {
  if (!document) return 0;
  const gate = document.gate?.key ?? '';
  if (['approve-test-cases', 'review-test-results'].includes(gate) || /testing|test-and-regression/.test(document.retry?.step ?? '') || /测试|质量/.test(document.progress?.phase ?? '')) return 4;
  if (['approve-release-scope', 'execute-release-externally', 'verify-release-health', 'execute-rollback-externally'].includes(gate) || /deployment|release|rollback|delivery/.test(document.retry?.step ?? '') || /发布|健康|回滚/.test(document.progress?.phase ?? '') || ['delivery-confirmed', 'fixture-completed', 'rolled-back'].includes(document.outcome ?? '') || document.status === 'success') return 5;
  if (gate === 'confirm-project-scope' || ['approve-architecture', 'resolve-readiness', 'resolve-findings', 'recover-development'].includes(gate) || document.developmentStop || document.blockage || /development|architecture/.test(document.retry?.step ?? '') || /开发|方案|架构|代码|开工/.test(document.progress?.phase ?? '') || document.outcome === 'blocked') return 3;
  if (['running', 'failed', 'tripwire'].includes(document.status) && !document.gate) {
    const stage = runningNode(document)?.stage;
    if (stage) return { requirements: 0, product: 1, development: 3, testing: 4 }[stage];
  }
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
  if (['running', 'failed', 'tripwire'].includes(document.status) && runningNode(document)) return runningNode(document)!.title;
  if (document.progress?.phase) return document.progress.phase;
  if (document.step === 'guided-requirements') return '产品团队 · 需求澄清';
  if (document.step === 'review-product' || document.product) return '产品团队 · 产品稿审阅';
  if (document.status === 'success') return '流程已完成';
  return stages[currentIndex(document)].label;
}

/** 计算主流程的完成、当前和待执行状态。 */
function states(document: RunFlowDocument, active: number): StageState[] {
  const failed = document.status === 'failed' || document.status === 'tripwire';
  const terminal = document.status === 'success';
  return stages.map((_, index) => index < active ? 'done' : index === active ? failed ? 'failed' : terminal && active === 3 ? 'done' : 'current' : 'pending');
}

/** 将阶段状态转换成详情节点文案。 */
function stateLabel(state: StageState): string { return { done: '已完成', current: '当前节点', pending: '待执行', failed: '执行失败' }[state]; }

/** 渲染阶段专属节点详情，查看历史阶段不会改变顶部真实位置。 */
function StageDialog({ stageId, document, close }: { stageId: StageId; document: RunFlowDocument; close: () => void }) {
  const detail = details[stageId];
  const nodes = document.timeline?.nodes.filter(node => nodeStage(node) === stageId) ?? [];
  /** 只处理背景点击关闭，不提交任何业务动作。 */
  function handleBackdrop(event: MouseEvent<HTMLDivElement>) { if (event.currentTarget === event.target) close(); }
  return <div className="workflow-dialog" role="presentation" onClick={handleBackdrop}>
    <div className="workflow-dialog-card" role="dialog" aria-modal="true" aria-labelledby="workflow-dialog-title">
      <div className="workflow-dialog-head"><div><span className="intake-eyebrow">阶段流程详情</span><h2 id="workflow-dialog-title">{detail.title}</h2></div><button className="workflow-dialog-close" type="button" aria-label="关闭阶段详情" onClick={close}>×</button></div>
      <p className="workflow-dialog-current">查看阶段节点：{detail.title}。运行当前节点：{currentNode(document)}。{detail.description}</p>
      <div className="team-flow">{nodes.map(node => <div className={`team-step ${node.status}`} key={node.id}><small>{activityLabel(node.status)}</small><strong>{node.title}</strong></div>)}{nodes.length === 0 && <p>暂无可归属的执行节点。</p>}</div>
      <div className="workflow-node-detail"><h3>节点说明</h3><p>{detail.description}</p></div>
    </div>
  </div>;
}

/** 渲染动态 SVG 主流程和可点击的阶段专属详情浮层。 */
export function RunFlowMini({ document, onRecover, recoveryDisabled = false }: { document: RunFlowDocument; onRecover?: () => void; recoveryDisabled?: boolean }) {
  const active = currentIndex(document);
  const stageStates = states(document, active);
  const [selected, setSelected] = useState<StageId>();
  const [expanded, setExpanded] = useState(true);
  const detailsId = useId();
  const activeLabel = stages[active].label;
  const node = ['running', 'failed', 'tripwire'].includes(document.status) && !document.gate ? runningNode(document) : undefined;
  const nodeStart = node?.startedAt ? Date.parse(node.startedAt) : NaN;
  const ticking = document.status === 'running' && node?.status === 'running' && Number.isFinite(nodeStart);
  const runStart = document.timeline?.startedAt ? Date.parse(document.timeline.startedAt) : NaN;
  const runActive = ['running', 'pending', 'waiting', 'suspended'].includes(document.status);
  const runTicking = runActive && Number.isFinite(runStart);
  const [, setTick] = useState(0);
  useEffect(() => {
    if (!ticking && !runTicking) return;
    const timer = window.setInterval(() => setTick(value => value + 1), 1000);
    return () => window.clearInterval(timer);
  }, [ticking, runTicking, node?.id, nodeStart, runStart]);
  const nodeDuration = ticking ? Math.max(0, Date.now() - nodeStart) : node?.durationMs ?? null;
  const runDuration = runTicking ? Math.max(0, Date.now() - runStart) : document.timeline?.durationMs ?? null;
  const workItemRef = useRef<HTMLDivElement>(null);
  const previousPosition = useRef<{ runId: string; stage: number; left: number; top: number } | null>(null);
  /** 仅对同一 Run 的阶段变化做位置过渡，首次加载及切换记录直接定位。 */
  useLayoutEffect(() => {
    const element = workItemRef.current;
    if (!expanded || !element) { previousPosition.current = null; return; }
    const rect = element.getBoundingClientRect();
    const previous = previousPosition.current;
    if (previous && previous.runId === document.runId && previous.stage !== active && !window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      element.animate([{ transform: `translate(${previous.left - rect.left}px, ${previous.top - rect.top}px)` }, { transform: 'translate(0, 0)' }], { duration: 450, easing: 'ease-out' });
    }
    previousPosition.current = { runId: document.runId, stage: active, left: rect.left, top: rect.top };
  });
  const status = document.status === 'success' ? '已完成' : ['canceled', 'bailed'].includes(document.status) ? '已停止' : document.status === 'suspended' || document.status === 'waiting' ? '等待人工确认' : stageStates[active] === 'failed' ? '执行失败' : '执行中';

  /** 打开阶段详情。 */
  function openStage(stageId: StageId) { setSelected(stageId); }
  /** 关闭阶段详情。 */
  function closeStage() { setSelected(undefined); }

  return <>
    <section className="workflow-overview" aria-label="Workflow 主流程动态状态">
      <div className="workflow-overview-head"><div><span className="intake-eyebrow">Workflow 主流程 · 动态状态</span><strong>{activeLabel}</strong><small>当前位于：{currentNode(document)}</small></div><div className="workflow-timers"><div className="workflow-node-timer" aria-label={`Run 总历时：${formatNodeDuration(runDuration)}，包含等待时间`} title="从 Run 开始计算，包含等待时间"><Clock3 size={16} aria-hidden="true" /><span><small>Run 总历时 · 含等待</small><strong>{formatNodeDuration(runDuration)}</strong></span></div><div className="workflow-node-timer" aria-label={`当前节点耗时：${formatNodeDuration(nodeDuration)}`}><Clock3 size={16} aria-hidden="true" /><span><small>当前节点耗时</small><strong>{formatNodeDuration(nodeDuration)}</strong></span></div></div></div>
      <div className="workflow-board">{stages.map((stage, index) => { const Icon = stageIcons[index]; return <div className="workflow-column" key={stage.id}>
        <button type="button" className={`workflow-column-heading ${stageStates[index]}`} onClick={() => openStage(stage.id)}><span className="workflow-stage-icon">{stageStates[index] === 'done' ? <Check size={15} /> : <Icon size={15} />}</span><span className="workflow-stage-name">{stage.label}</span><small>{stateLabel(stageStates[index])}</small></button>
        <div id={`${detailsId}-${stage.id}`} hidden={!expanded}>
        {index === active && <div ref={workItemRef} className={`workflow-work-item ${stageStates[active]} ${status === '执行中' ? 'is-running' : ''}`} ><div className="workflow-item-meta"><span><span className="workflow-live-dot" />当前需求</span><ArrowUpRight size={15} aria-hidden="true" /></div><strong>{document.brief?.split(/[\n：:]/u)[0].slice(0, 36) || '当前流程'}</strong><div className="workflow-item-footer"><span className="workflow-item-tag">{status}</span><small>{activeLabel}</small></div></div>}
        {(document.timeline?.nodes ?? []).filter(node => nodeStage(node) === stage.id).map(node => <article className={`workflow-board-card ${node.status}`} key={node.id}><div className="workflow-card-kind"><ClipboardList size={13} aria-hidden="true" /> {node.kind === 'agent' ? 'Agent' : node.kind === 'check' ? '检查' : '流程节点'}</div><strong>{node.title}</strong><small><i aria-hidden="true" />{activityLabel(node.status)}{node.attempt !== null && node.attempt !== undefined ? ` · 第 ${node.attempt} 轮` : ''}</small>{node.status === 'failed' && node.id === document.retry?.step && onRecover && <button type="button" className="workflow-recover-button" disabled={recoveryDisabled} onClick={onRecover}>重试</button>}</article>)}
        {index === active && document.gate && <article className="workflow-board-card suspended"><strong>{document.gate.title}</strong><small><i aria-hidden="true" />等待确认</small></article>}
        </div>
      </div>})}</div>
      {expanded && !!document.timeline?.nodes.some(node => !nodeStage(node)) && <details className="workflow-unclassified"><summary>其他执行活动</summary>{document.timeline.nodes.filter(node => !nodeStage(node)).map(node => <p key={node.id}>{node.title} · {activityLabel(node.status)}</p>)}</details>}
      <button type="button" className="workflow-board-current workflow-details-toggle" aria-expanded={expanded} aria-controls={stages.map(stage => `${detailsId}-${stage.id}`).join(' ')} onClick={() => setExpanded(value => !value)}><span>当前：{currentNode(document)} · {status}</span><span>{expanded ? '收起流程详情' : '展开流程详情'} <ChevronDown size={14} className={expanded ? 'is-expanded' : ''} aria-hidden="true" /></span></button>
    </section>
    {selected && <StageDialog stageId={selected} document={document} close={closeStage} />}
  </>;
}
