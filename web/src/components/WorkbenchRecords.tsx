import { useEffect, useRef, useState } from 'react';
import { RunActivityFeed, type LiveActivity, type ProductStreamView, type RunTimelineDocument } from './RunActivityFeed';
import { nodeTeam } from './run-flow-state';

export const teamLabels = { product: '产品', development: '研发', testing: '测试', delivery: '交付' };
const labels = { pending: '待执行', running: '执行中', completed: '已完成', failed: '失败', waiting: '等待中', suspended: '待确认', cancelled: '已停止' };
type Stream = ProductStreamView & { stepId?: string; taskKey?: string };

/** 展示快照节点与可确定归属的本次连接输出，不将片段视为已批准结果。 */
export function WorkbenchRecords({ timeline, activity, status, streams }: { timeline?: RunTimelineDocument; activity?: LiveActivity; status: string; streams: Record<string, Stream> }) {
  const nodes = timeline?.nodes.filter(node => node.status !== 'pending') ?? [];
  const entries = Object.entries(streams);
  const root = useRef<HTMLElement>(null);
  const [current, setCurrent] = useState('');
  /** 仅在步骤标识能唯一对应节点时关联输出，避免并行任务串线。 */
  function matchingNode(stream: Stream) {
    if (!stream.stepId || stream.taskKey) return undefined;
    const exact = nodes.filter(node => node.id === stream.stepId);
    return exact.length === 1 ? exact[0] : undefined;
  }
  useEffect(() => {
    const scroller = root.current?.closest('.workbench-content');
    if (!scroller) return;
    /** 随阅读位置更新当前节点，初始高亮最近节点。 */
    function update() {
      const items = [...(root.current?.querySelectorAll<HTMLElement>('[data-record-id]') ?? [])];
      const threshold = scroller!.getBoundingClientRect().top + scroller!.clientHeight * .4;
      const visible = items.filter(item => item.getBoundingClientRect().top <= threshold);
      setCurrent((visible.at(-1) ?? items.at(-1))?.dataset.recordId ?? '');
    }
    update(); scroller.addEventListener('scroll', update, { passive: true });
    return () => scroller.removeEventListener('scroll', update);
  }, [timeline]);
  if (!nodes.length && !entries.length && !activity) return <section className="workbench-records" aria-label="执行记录"><h2>执行记录</h2><small>暂无执行记录</small></section>;
  return <section ref={root} className="workbench-records conversation-records" aria-label="执行记录">
    <h2>执行记录</h2>
    {nodes.length > 0 && <nav className="conversation-nav" aria-label="节点快捷导航">{nodes.map(node => <button key={node.id} type="button" className={current === node.id ? 'active' : ''} aria-label={`定位到${node.title}，${labels[node.status]}`} aria-current={current === node.id ? 'location' : undefined} onClick={() => root.current?.querySelectorAll<HTMLElement>('[data-record-id]').forEach(item => { if (item.dataset.recordId === node.id) item.scrollIntoView({ block: 'start', behavior: 'smooth' }); })}><span>{node.title} · {labels[node.status]}</span></button>)}</nav>}
    {nodes.map(node => {
      const nodeStreams = entries.filter(([, stream]) => matchingNode(stream)?.id === node.id);
      const team = nodeTeam(node);
      return <article className="conversation-node" data-record-id={node.id} key={node.id}>
        <div className="conversation-task"><small>节点任务{team ? ` · ${teamLabels[team]}团队` : ''}</small><strong>{node.title}</strong></div>
        <div className="conversation-result"><div className="conversation-heading"><strong>{node.title}</strong><span className={`conversation-status status-${node.status}`}>{labels[node.status]}</span>{node.attempt != null && <small>第 {node.attempt} 轮</small>}</div>
          {nodeStreams.map(([key, stream]) => <RunActivityFeed key={key} timeline={timeline} stream={stream} status={node.status === 'running' && status === 'running' ? 'running' : 'saved'} stepLabel={stream.stepId} taskKey={stream.taskKey} />)}
          {node.check && <p>检查：{node.check.id} · 退出码 {node.check.exitCode ?? '未知'}</p>}
          {!!node.files.length && <details className="conversation-files"><summary>关联文件 · {node.files.length} 个</summary><ul>{node.files.map(file => <li key={file}>{file}</li>)}</ul></details>}
          {!!node.tools.length && <details><summary>工具记录 · {node.tools.length} 项</summary><ul>{node.tools.map(tool => <li key={tool}>{tool}</li>)}</ul></details>}
        </div>
      </article>;
    })}
    {status === 'running' && activity && <p role="status" className="conversation-progress">{activity.summary}</p>}
    {entries.filter(([, stream]) => !matchingNode(stream)).map(([key, stream], index, unmatched) => <div key={key} className="conversation-unmatched"><small>本次连接输出 · 节点归属待确认</small><RunActivityFeed timeline={timeline} stream={stream} status={status === 'running' && key === entries.at(-1)?.[0] && index === unmatched.length - 1 ? status : 'saved'} stepLabel={stream.stepId} taskKey={stream.taskKey} /></div>)}
  </section>;
}
