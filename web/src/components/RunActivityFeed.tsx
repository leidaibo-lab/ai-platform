import { useEffect, useState, type ReactNode, type SyntheticEvent } from 'react';

export interface TimelineNode {
  id: string;
  kind: 'step' | 'agent' | 'check';
  title: string;
  status: 'pending' | 'running' | 'completed' | 'failed' | 'waiting' | 'suspended' | 'cancelled';
  startedAt: string | null;
  endedAt: string | null;
  durationMs: number | null;
  tools: string[];
  files: string[];
  modelSteps?: number;
  check?: { id: string; exitCode: number | null };
}

export interface RunTimelineDocument {
  startedAt: string | null;
  endedAt: string | null;
  durationMs: number | null;
  nodes: TimelineNode[];
  tools: string[];
  files: string[];
}

export interface LiveActivity {
  type: 'workflow-step';
  stepId: string | null;
  title: string;
  status: TimelineNode['status'];
  summary: string;
  occurredAt: string;
}

/** 将毫秒格式化为正文活动行使用的短时长。 */
function formatDuration(durationMs: number | null, live = false): string {
  if (durationMs === null) return live ? '进行中' : '—';
  const seconds = Math.max(0, Math.floor(durationMs / 1000));
  if (seconds < 60) return `${seconds}秒`;
  const minutes = Math.floor(seconds / 60);
  return `${minutes}分${String(seconds % 60).padStart(2, '0')}秒`;
}

/** 将公开节点状态转换为活动行短标签。 */
function statusLabel(status: TimelineNode['status']): string {
  return { completed: '已完成', running: '进行中', failed: '失败', waiting: '等待', suspended: '已暂停', cancelled: '已停止', pending: '待执行' }[status];
}

/** 选择活动行图标，避免把内部 Workflow 类型直接暴露给用户。 */
function activityIcon(node: TimelineNode): string {
  if (node.files.length > 0) return '▧';
  if (node.tools.length > 0 || node.kind === 'check') return '⌁';
  return node.status === 'running' ? '✳' : '·';
}

/** 生成当前活动之前或之后的安全正文摘要，不展示模型隐藏思维链。 */
function activityCopy(node: TimelineNode, position: number, total: number): string {
  if (node.status === 'running') return `正在处理“${node.title}”，并把已读取的事实整理进当前结果。`;
  if (node.status === 'failed') return `“${node.title}”未完成，已保留失败状态和可复核信息。`;
  if (position === total - 1) return '这一步已完成，正在整理当前阶段的结果和下一步。';
  return `已完成“${node.title}”，继续输出当前阶段的结果。`;
}

interface ActivityRowProps {
  node: TimelineNode;
}

/** 渲染正文流中的单个可展开活动行；完成节点默认折叠，当前节点展示公开摘要。 */
function ActivityRow({ node }: ActivityRowProps) {
  const [open, setOpen] = useState(node.status === 'running');
  const live = node.status === 'running';
  useEffect(() => {
    if (live) setOpen(true);
  }, [live]);
  /** 同步活动行展开状态，不改变服务端事实。 */
  function handleToggle(event: SyntheticEvent<HTMLDetailsElement>) {
    setOpen(event.currentTarget.open);
  }
  const title = node.status === 'running' ? node.title : node.files.length > 0 ? '已读取文件' : node.tools.length > 0 ? '调用工具' : node.title;
  return <details className={`run-activity-row run-activity-row-${node.status}`} open={open} onToggle={handleToggle}>
    <summary>
      <span className="run-activity-icon" aria-hidden="true">{activityIcon(node)}</span>
      <span className="run-activity-title">{title}<small>{statusLabel(node.status)}</small></span>
      <span className="run-activity-meta">{formatDuration(node.durationMs, live)}</span>
    </summary>
    <div className="run-activity-detail">
      {node.tools.length > 0 && <div><span>工具</span><strong>{node.tools.join('、')}</strong></div>}
      {node.files.length > 0 && <div><span>文件</span><strong>{node.files.join('、')}</strong></div>}
      {node.modelSteps !== undefined && <div><span>模型步骤</span><strong>{node.modelSteps}</strong></div>}
      {node.check && <div><span>检查</span><strong>{node.check.exitCode === 0 ? '通过' : `退出码 ${node.check.exitCode ?? '未知'}`}</strong></div>}
      {live && <p>工作摘要：基于当前已公开的文件和工具事实继续处理，不展示模型隐藏思维链。</p>}
    </div>
  </details>;
}

interface RunActivityFeedProps {
  timeline?: RunTimelineDocument;
  status: string;
  liveActivity?: LiveActivity;
  /** 当前服务端阶段说明作为正文流中的安全文案，不替代最终业务正文。 */
  progressText?: string;
  /** 当前服务端阶段的下一步说明，作为正文流末尾的辅助文案。 */
  nextText?: string;
  children?: ReactNode;
}

/** 渲染 Mastra Run 的单一流式活动流，不维护独立 Workflow 时间线面板。 */
export function RunActivityFeed({ timeline, status, liveActivity, progressText, nextText, children }: RunActivityFeedProps) {
  const [, setTick] = useState(0);
  useEffect(() => {
    if (!timeline?.startedAt || !['running', 'pending'].includes(status)) return;
    const timer = window.setInterval(() => setTick(value => value + 1), 1000);
    return () => window.clearInterval(timer);
  }, [timeline?.startedAt, status]);
  if (!timeline) return null;
  const live = !timeline.endedAt && ['running', 'pending'].includes(status);
  const totalDuration = live && timeline.startedAt ? Math.max(0, Date.now() - Date.parse(timeline.startedAt)) : timeline.durationMs;
  const liveNode: TimelineNode | undefined = liveActivity && liveActivity.stepId && !timeline.nodes.some(node => node.id === liveActivity.stepId)
    ? { id: liveActivity.stepId, kind: 'step', title: liveActivity.title, status: liveActivity.status, startedAt: liveActivity.occurredAt, endedAt: null, durationMs: null, tools: [], files: [] }
    : undefined;
  const nodes = liveNode ? [...timeline.nodes, liveNode] : timeline.nodes;
  const currentText = liveActivity?.summary ?? progressText ?? (live ? '我正在根据当前需求读取已公开的项目资料，并整理下一步。' : '本次运行已保存执行结果，下面展示正文流中的关键活动。');
  return <section className="run-activity-feed" aria-label="正文与执行活动流">
    <div className="run-activity-elapsed"><span className={`run-activity-dot${live ? ' is-live' : ''}`} aria-hidden="true" /><span>已处理 <strong>{formatDuration(totalDuration, live)}</strong></span></div>
    <div className="run-activity-stream">
      <p className="run-activity-copy">{currentText}{live && <span className="run-activity-cursor" aria-label="流式输出中" />}</p>
      {nodes.map((node, index) => <div className="run-activity-segment" key={node.id}>
        <ActivityRow node={node} />
        <p className="run-activity-copy">{activityCopy(node, index, nodes.length)}{live && index === nodes.length - 1 && <span className="run-activity-cursor" aria-label="流式输出中" />}</p>
      </div>)}
      {nodes.length === 0 && <p className="run-activity-empty">等待执行活动进入正文流…</p>}
      {nextText && <p className="run-activity-copy run-activity-next">{nextText}</p>}
      {children}
    </div>
    <p className="run-activity-boundary">活动行只展示 Workflow、工具和文件元数据；模型隐藏思维链不会发送到前端。</p>
  </section>;
}
