import { useState } from 'react';

interface DiagnosticTool { name: string; inputHash?: string; returned?: boolean; repeated?: boolean; callCount?: number }
interface DiagnosticItem { id: string; status: 'completed' | 'running' | 'waiting' | 'failed'; phase: string; role: string; summary: string; evidence: string[]; nextAction?: string; tools?: DiagnosticTool[] }
interface DiagnosticTraceProps { trace?: { enabled: boolean; items: DiagnosticItem[] } }

const statusLabel: Record<DiagnosticItem['status'], string> = { completed: '已完成', running: '进行中', waiting: '等待确认', failed: '未完成' };

/** 展示统一的测试诊断轨迹、决策摘要和工具调用审计事实。 */
export function DiagnosticTrace({ trace }: DiagnosticTraceProps) {
  const [open, setOpen] = useState(true);
  if (!trace?.enabled || !trace.items.length) return null;
  return <section className="diagnostic-trace intake-card" aria-label="测试诊断轨迹">
    <div className="diagnostic-heading">
      <div><div className="intake-eyebrow">可审计执行记录</div><h2>测试诊断轨迹</h2></div>
      <button type="button" onClick={() => setOpen(!open)}>{open ? '收起轨迹' : '展开轨迹'}</button>
    </div>
    {open && <div className="diagnostic-list">{trace.items.map(item => <article className={`diagnostic-item diagnostic-${item.status}`} key={item.id}>
      <div className="diagnostic-status"><span className="diagnostic-dot" />{statusLabel[item.status]}</div>
      <div className="diagnostic-body"><div className="diagnostic-title"><strong>{item.phase}</strong><span>{item.role}</span></div><p>{item.summary}</p>
        {item.evidence.length > 0 && <details><summary>查看依据与运行事实（{item.evidence.length}）</summary><ul>{item.evidence.map((fact, index) => <li key={`${item.id}-evidence-${index}`}>{fact}</li>)}</ul></details>}
        {item.tools && item.tools.length > 0 && <details open={item.status === 'running'}><summary>工具调用审计（{item.tools.length} 个签名）</summary><div className="diagnostic-tools">{item.tools.map((tool, index) => <div className="diagnostic-tool" key={`${item.id}-tool-${index}`}><strong>{tool.name}</strong><span>{tool.inputHash ? `入参指纹 ${tool.inputHash}` : '已记录调用事实'}</span><em>{tool.returned === false ? '未收到结果' : tool.repeated ? `重复 ${tool.callCount ?? 2} 次` : '已返回'}</em></div>)}</div></details>}
        {item.nextAction && <div className="diagnostic-next"><span>下一步</span>{item.nextAction}</div>}
      </div>
    </article>)}</div>}
  </section>;
}
