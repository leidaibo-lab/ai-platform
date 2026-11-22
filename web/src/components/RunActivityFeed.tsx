import { useLayoutEffect, useRef, type UIEvent } from 'react';

import type { RunTimelineDocument, TimelineNode } from './run-timeline-types';
export type { RunTimelineDocument, TimelineNode } from './run-timeline-types';

export interface LiveActivity {
  type: 'workflow-step';
  stepId: string | null;
  title: string;
  status: TimelineNode['status'];
  summary: string;
  occurredAt: string;
}

export { appendProductStream } from './product-stream';
export type { ProductStreamEvent, ProductStreamView } from './product-stream';
import type { ProductStreamView } from './product-stream';

interface RunActivityFeedProps {
  timeline?: RunTimelineDocument;
  stream?: ProductStreamView;
  stepLabel?: string;
  taskKey?: string;
  status: string;
  liveActivity?: LiveActivity;
  /** 当前服务端阶段说明作为正文流中的安全文案，不替代最终业务正文。 */
  progressText?: string;
  /** 当前服务端阶段的下一步说明，作为正文流末尾的辅助文案。 */
  nextText?: string;
}

/** 展示产品节点真实模型文本和工具事件，片段不代表已确认产物。 */
export function RunActivityFeed({ timeline, status, liveActivity, progressText, nextText, stream, stepLabel, taskKey }: RunActivityFeedProps) {
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
  return <details key={live ? 'live' : 'saved'} open={live || undefined} className="live-model-output" aria-label="节点实时输出">
    <summary>{stream ? roles[stream.role] ?? stream.role : '当前进展'} · {live ? '实时输出' : '本次连接输出'}{stepLabel && <small className="sr-only"> · 节点 {stepLabel}</small>}{taskKey && <small> · 任务 {taskKey.slice(0, 8)}</small>}</summary>
    {stream && <><p className="live-model-output-note">第 {stream.attempt} 次尝试 · 生成内容可能变化</p><div ref={outputRef} className="live-model-output-stream" aria-live="off" onScroll={handleOutputScroll}>{stream.entries.map((entry, index) => entry.type === 'text' ? <p className="live-model-output-text" key={index}>{entry.text}</p> : <p className="live-model-output-tool" key={index}>{toolLabel(entry)} · {{ started: '调用中', completed: '已完成', failed: '失败' }[entry.state]}</p>)}</div></>}
    {!stream && currentText && <p className="run-activity-copy" role="status">{currentText}</p>}
    {!stream && live && nextText && <p className="run-activity-copy run-activity-next">{nextText}</p>}
    {!stream && live && <p className="live-model-output-note">等待模型文本或工具调用；部分节点暂未接入实时输出。</p>}
  </details>;
}

/** 将内部工具标识转换成可理解的操作名称，并明确展示被调用的 Skill。 */
function toolLabel(entry: { action: string; object?: string }): string {
  const labels: Record<string, string> = { 'skill.load': '加载 Skill', 'skill.read': '读取 Skill 资料', 'skill.search': '搜索 Skill', 'handoff.locate': '查找交接资料', 'handoff.read': '读取交接资料', 'file.read': '读取文件', 'file.write': '写入文件', 'checks.run': '运行登记检查', 'task.delegate': '委派任务', 'platform.info': '读取平台说明', 'tool.invoke': '调用工具' };
  const action = labels[entry.action] ?? '调用工具';
  return entry.object ? `${action}：${entry.object}` : action;
}
