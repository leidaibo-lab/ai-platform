import { useEffect, useId, useState } from 'react';
import { Check, CircleCheck, Clock3, Code2, GitPullRequest, Sparkles } from 'lucide-react';
import type { TimelineNode } from './RunActivityFeed';
import { nodeTeam, productPhases, projectDevelopmentStages, projectProductPhases, projectRunFlow, teamForPath, teams, type RunFlowDocument, type Team, type TeamState } from './run-flow-state';

const teamDetails = {
  product: { label: '产品团队', icon: Sparkles, steps: productPhases.join(' · ') },
  development: { label: '研发团队', icon: Code2, steps: '项目授权 · 开发方案 · 实施验证 · 评审交接' },
  testing: { label: '测试团队', icon: CircleCheck, steps: '用例确认 · 验证 · QA 放行' },
  delivery: { label: '交付团队', icon: GitPullRequest, steps: '提交指向 main 的 MR · 核验回执' },
};
const teamStates: Record<TeamState, string> = { done: '已完成', current: '当前团队', pending: '待执行', failed: '执行失败', stopped: '已停止' };
const activityLabels: Record<TimelineNode['status'], string> = { pending: '待执行', running: '执行中', completed: '已完成', failed: '执行失败', waiting: '等待中', suspended: '等待确认', cancelled: '已停止' };

/** 使用 SVG 绘制正向交接和返工箭头，状态与原生 Run 快照同步。 */
function FlowArrow({ active, returning = false }: { active: boolean; returning?: boolean }) {
  return <svg className={`workflow-flow-arrow${returning ? ' returning' : ''}${active ? ' active' : ''}`} viewBox="0 0 28 16" aria-hidden="true" fill="none">
    <path d={returning ? 'M25 13V4H3m5-3L3 4l5 4' : 'M2 8h23m-6-5 6 5-6 5'} stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
  </svg>;
}

/** 将节点耗时格式化为便于阅读的时、分、秒。 */
function formatDuration(ms: number | null) {
  if (ms === null || !Number.isFinite(ms)) return '暂无数据';
  const seconds = Math.floor(Math.max(0, ms) / 1000);
  if (seconds >= 3600) return `${Math.floor(seconds / 3600)}小时${Math.floor(seconds % 3600 / 60)}分`;
  if (seconds >= 60) return `${Math.floor(seconds / 60)}分${seconds % 60}秒`;
  return `${seconds}秒`;
}

/** 展示选中团队的执行证据和已存在的恢复入口。 */
function TeamActivity({ title, status, description, attempt, canRecover, recoveryDisabled, onRecover }: Pick<TimelineNode, 'title' | 'status'> & { description?: string; attempt?: number | null; canRecover?: boolean; recoveryDisabled?: boolean; onRecover?: () => void }) {
  return <article className={`workflow-board-card ${status}`}>
    <strong>{title}</strong>
    {description && <p className="workflow-node-description">{description}</p>}
    <small><i aria-hidden="true" />{activityLabels[status]}{attempt != null ? ` · 第 ${attempt} 轮` : ''}</small>
    {canRecover && onRecover && <button type="button" className="workflow-recover-button" disabled={recoveryDisabled} onClick={onRecover}>重试</button>}
  </article>;
}

/** 展示团队执行链，允许查看历史节点并定位当前团队的操作。 */
export function RunFlowMini({ document, selected, onSelect, onRecover, recoveryDisabled = false, compact = false }: { document: RunFlowDocument; selected: Team; onSelect: (team: Team) => void; onRecover?: () => void; recoveryDisabled?: boolean; compact?: boolean }) {
  const flow = projectRunFlow(document);
  const [showDetails, setShowDetails] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const sectionId = useId();
  const live = ['running', 'pending', 'waiting', 'suspended'].includes(document.status);
  const runStartedAt = Date.parse(document.timeline?.startedAt ?? '');
  const nodeStartedAt = Date.parse(flow.node?.startedAt ?? '');
  useEffect(() => {
    if (!live) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [live]);
  const runDuration = live && Number.isFinite(runStartedAt) ? now - runStartedAt : document.timeline?.durationMs ?? null;
  const nodeDuration = flow.node?.status === 'running' && live && Number.isFinite(nodeStartedAt) ? now - nodeStartedAt : flow.node?.durationMs ?? null;
  const currentTitle = flow.title ?? teamDetails[flow.active].label;
  const nodes = document.timeline?.nodes.filter(node => nodeTeam(node) === selected) ?? [];
  const condensed = selected === 'product' || selected === 'development';
  const retry = condensed && document.retry && teamForPath(document.retry.step) === selected ? document.retry : undefined;
  const records = selected === 'development' ? nodes.filter(node => !/(?:^|\.)(?:state-after-[^.]+|select-candidate-checkpoint)(?:#\d+)?$/.test(node.id)) : nodes;
  const inClarification = !!document.intake;
  const needsProductAction = inClarification || !!document.product || !!document.clarify || !!document.productCorrection
    || ['confirm-blocker-answers', 'review-revised-product'].includes(document.gate?.key ?? '');
  const returnHint = document.gate?.key === 'submit-merge-request' ? 'MR 提交失败 → 交付节点重试'
    : flow.businessReturn ? '研发 / QA 业务缺口 → 产品团队'
    : flow.correction ? '纠偏 / 审阅退回 → 产品返工判断'
    : flow.qaRepair ? 'QA 代码缺陷 → 研发修复后回归' : undefined;

  if (compact) return <section aria-label="流程进度">
    {teams.map(team => {
      const current = flow.active === team;
      const steps = team === 'product' ? projectProductPhases(document, flow).map(item => ({ title: item.phase, status: item.status, description: item.description }))
        : team === 'development' ? projectDevelopmentStages(document, flow)
          : (document.timeline?.nodes ?? []).filter(node => node.kind === 'step' && nodeTeam(node) === team);
      return <details key={team} open={current || undefined}><summary>{teamDetails[team].label} <small>{teamStates[flow.states[team]]}</small></summary>
        {steps.map((step, index) => <details key={`${step.title}-${index}`}><summary>{step.title} <small>{activityLabels[step.status]}</small></summary>{'description' in step && <p>{String(step.description ?? '')}</p>}</details>)}
        {!steps.length && <small>暂无节点记录</small>}<button type="button" onClick={() => onSelect(team)}>定位{current ? '当前阶段' : '该阶段'}</button>
      </details>;
    })}
    {returnHint && <small>{returnHint}</small>}
  </section>;

  return <section className="workflow-overview workflow-team-overview" aria-label="Workflow 团队执行链">
    <div className="workflow-overview-head">
      <div><span className="intake-eyebrow">Workflow 执行链路</span><strong role="status">{teamDetails[flow.active].label} · {flow.active === 'product' && `${flow.productPhase} · `}{currentTitle === teamDetails[flow.active].label ? flow.status : currentTitle}</strong></div>
      <div className="workflow-timers">
        <div className="workflow-node-timer"><Clock3 size={16} aria-hidden="true" /><span><small>Run 总历时 · 含等待</small><strong>{formatDuration(runDuration)}</strong></span></div>
        <div className="workflow-node-timer"><Clock3 size={16} aria-hidden="true" /><span><small>当前节点耗时</small><strong>{formatDuration(nodeDuration)}</strong></span></div>
      </div>
    </div>
    <ol className="workflow-team-chain">
      {teams.map((team, index) => {
        const { label, steps, icon: Icon } = teamDetails[team];
        const state = flow.states[team];
        return <li key={team} className="workflow-team-link">
          <button type="button" className={`workflow-team-node ${state}`} aria-current={flow.active === team ? 'step' : undefined} aria-pressed={selected === team} onClick={/** 切换团队页并收起上一个团队的原始记录。 */() => { onSelect(team); setShowDetails(false); }}>
            <span className="workflow-team-title">{state === 'done' ? <Check size={17} aria-hidden="true" /> : <Icon size={17} aria-hidden="true" />}{label}</span>
            <span className="workflow-team-steps">{steps}</span>
            <span className="workflow-team-status">{team === flow.active ? flow.status : teamStates[state]}</span>
          </button>
          {index < teams.length - 1 && <FlowArrow active={state === 'done'} />}
        </li>;
      })}
    </ol>
    {returnHint && <div className="workflow-return-paths" aria-label="返工与跨团队回流">
      <span className="active"><FlowArrow returning active />{returnHint}</span>
    </div>}
    <div className="workflow-team-activity">
      <div className="workflow-team-activity-head"><h3>{teamDetails[selected].label}</h3><button type="button" aria-controls={sectionId} aria-expanded={showDetails} onClick={/** 保留团队选择，仅展开执行记录。 */() => setShowDetails(!showDetails)}>{showDetails ? '收起执行详情' : '查看执行详情'}</button></div>
      {showDetails && <div id={sectionId}>
        {selected === 'product' && needsProductAction && <a href={inClarification ? '#product-clarification' : '#product-team-action'}>前往{inClarification ? '需求澄清' : '产品团队当前操作'}</a>}
        {condensed ? <>
          {selected === 'product' ? <div className="workflow-team-events" aria-label="产品执行节点">
            {projectProductPhases(document, flow).map(({ phase, description, status }) => <TeamActivity key={phase} title={phase} description={description} status={status} />)}
          </div> : <div className="workflow-team-events" aria-label="研发执行节点">
            {projectDevelopmentStages(document, flow).map(({ title, description, status }) => <TeamActivity key={title} title={title} description={description} status={status} />)}
          </div>}
          {retry && onRecover && <button type="button" className="workflow-recover-button" disabled={recoveryDisabled} onClick={onRecover}>重试：{retry.title}</button>}
          {records.length > 0 && <details className="workflow-team-records">
            <summary>原始执行记录（{records.length}）</summary>
            <div className="workflow-team-events">{records.map(node => <TeamActivity key={node.id} title={node.title} status={node.status} attempt={node.attempt} />)}</div>
          </details>}
        </> : nodes.length ? <div className="workflow-team-events">{nodes.map(node => <TeamActivity key={node.id} title={node.title} status={node.status} attempt={node.attempt} canRecover={node.status === 'failed' && node.id === document.retry?.step} onRecover={onRecover} recoveryDisabled={recoveryDisabled} />)}</div> : <p>暂无执行记录。</p>}
      </div>}
    </div>
  </section>;
}
