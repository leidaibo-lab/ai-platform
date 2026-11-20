import { RunActivityFeed, type LiveActivity, type ProductStreamView, type RunTimelineDocument } from './RunActivityFeed';
import { nodeTeam, teams } from './run-flow-state';

export const teamLabels = { product: '产品', development: '研发', testing: '测试', delivery: '交付' };
const labels = { pending: '待执行', running: '执行中', completed: '已完成', failed: '失败', waiting: '等待中', suspended: '待确认', cancelled: '已停止' };

/** 展示快照节点与本次连接的公开输出，流式文本不代表已批准结果。 */
export function WorkbenchRecords({ timeline, activity, status, streams }: { timeline?: RunTimelineDocument; activity?: LiveActivity; status: string; streams: Record<string, ProductStreamView & { stepId?: string; taskKey?: string }> }) {
  const entries = Object.entries(streams);
  return <section className="workbench-records" aria-label="执行记录"><h2>执行记录</h2>
    {status === 'running' && activity && <p role="status">{activity.summary}</p>}
    {teams.map(team => {
      const nodes = timeline?.nodes.filter(node => nodeTeam(node) === team && node.status !== 'pending') ?? [];
      return nodes.length > 0 && <details key={team}><summary>{teamLabels[team]} · {nodes.length} 条</summary>{nodes.map(node => <details key={node.id}><summary>{node.title} <small>{labels[node.status]}</small></summary>
        {node.attempt != null && <p>第 {node.attempt} 轮</p>}{node.check && <p>{node.check.id} · 退出码 {node.check.exitCode ?? '未知'}</p>}
        {!!node.files.length && <p>{node.files.join('、')}</p>}{!!node.tools.length && <p>{node.tools.join('、')}</p>}
      </details>)}</details>;
    })}
    {entries.map(([key, stream]) => <RunActivityFeed key={key} timeline={timeline} stream={stream} status={status === 'running' && key === entries.at(-1)?.[0] ? status : 'saved'} stepLabel={stream.stepId} taskKey={stream.taskKey} />)}
    {!timeline?.nodes.some(node => node.status !== 'pending') && !entries.length && <small>暂无执行记录</small>}
  </section>;
}
