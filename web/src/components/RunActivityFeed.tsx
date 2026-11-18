import { useLayoutEffect, useRef, type UIEvent } from 'react';

export interface TimelineNode {
  id: string;
  kind: 'step' | 'agent' | 'check';
  stage: 'requirements' | 'product' | 'development' | 'testing' | null;
  attempt: number | null;
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

export type ProductStreamEvent = { type: 'text'; text: string; role: string; attempt: number } | { type: 'tool'; name: string; state: 'started' | 'completed' | 'failed'; role: string; attempt: number };
export interface ProductStreamView { role: string; attempt: number; entries: Array<{ type: 'text'; text: string } | { type: 'tool'; name: string; state: 'started' | 'completed' | 'failed' }>; }

/** 将同一节点的文本增量合并；切换角色或重试时从新片段开始。 */
export function appendProductStream(previous: ProductStreamView | undefined, event: ProductStreamEvent): ProductStreamView {
  const entries = previous?.role === event.role && previous.attempt === event.attempt ? [...previous.entries] : [];
  if (event.type === 'text') {
    const last = entries.at(-1);
    if (last?.type === 'text') entries[entries.length - 1] = { type: 'text', text: (last.text + event.text).slice(-30000) };
    else entries.push({ type: 'text', text: event.text.slice(-30000) });
  } else entries.push({ type: 'tool', name: event.name, state: event.state });
  return { role: event.role, attempt: event.attempt, entries: entries.slice(-100) };
}

interface RunActivityFeedProps {
  timeline?: RunTimelineDocument;
  stream?: ProductStreamView;
  status: string;
  liveActivity?: LiveActivity;
  /** 当前服务端阶段说明作为正文流中的安全文案，不替代最终业务正文。 */
  progressText?: string;
  /** 当前服务端阶段的下一步说明，作为正文流末尾的辅助文案。 */
  nextText?: string;
}

/** 展示产品节点真实模型文本和工具事件，片段不代表已确认产物。 */
export function RunActivityFeed({ timeline, status, liveActivity, progressText, nextText, stream }: RunActivityFeedProps) {
  const outputRef = useRef<HTMLDivElement>(null);
  const followOutput = useRef(true);
  const lastScrollTop = useRef(0);
  useLayoutEffect(() => {
    const output = outputRef.current;
    if (!output) { followOutput.current = true; lastScrollTop.current = 0; return; }
    if (followOutput.current) {
      output.scrollTop = output.scrollHeight;
      lastScrollTop.current = output.scrollTop;
    }
  }, [stream]);
  /** 用户上滚时暂停跟随；重新滚到底部后恢复。 */
  function handleOutputScroll(event: UIEvent<HTMLDivElement>) {
    const output = event.currentTarget;
    const atBottom = output.scrollHeight - output.clientHeight - output.scrollTop <= 8;
    if (atBottom) followOutput.current = true;
    else if (output.scrollTop < lastScrollTop.current) followOutput.current = false;
    lastScrollTop.current = output.scrollTop;
  }
  if (!timeline && !stream) return null;
  const live = ['running', 'pending'].includes(status);
  const currentText = live ? liveActivity?.summary ?? progressText : undefined;
  if (!currentText && !nextText && !stream) return null;
  const roles: Record<string, string> = { analysis: '需求分析', clarification: '需求澄清整理', 'scope-priority': '范围与优先级', writing: '产品稿写作', reviewer: '独立审查', context: '研发上下文核实', architect: '技术方案设计', readiness: '实施前就绪审查', frontend: '前端实现', backend: '后端实现', infrastructure: '基础设施实现', testing: '测试计划', operations: '发布计划' };
  return <section className="intake-card live-model-output" aria-label="节点实时输出">
    <div className="live-model-output-head"><div><span className="intake-eyebrow">节点实时输出</span><h2>{stream ? roles[stream.role] ?? '当前节点' : '当前进展'}</h2></div><span>{live ? '运行中' : '本次连接记录'}</span></div>
    {stream && <><p className="live-model-output-note">模型生成片段 · 第 {stream.attempt} 次尝试 · 完成前内容可能变化</p><div ref={outputRef} className="live-model-output-stream" aria-live="off" onScroll={handleOutputScroll}>{stream.entries.map((entry, index) => entry.type === 'text' ? <p className="live-model-output-text" key={index}>{entry.text}</p> : <p className="live-model-output-tool" key={index}>工具 {entry.name} · {{ started: '调用中', completed: '已完成', failed: '失败' }[entry.state]}</p>)}</div></>}
    {!stream && currentText && <p className="run-activity-copy" role="status">{currentText}</p>}
    {!stream && live && nextText && <p className="run-activity-copy run-activity-next">{nextText}</p>}
    {!stream && live && <p className="live-model-output-note">等待模型文本或工具调用；部分节点暂未接入实时输出。</p>}
  </section>;
}
