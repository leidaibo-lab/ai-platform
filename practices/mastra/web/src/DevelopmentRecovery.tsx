/** 按真实故障阶段引导重试/停止；恢复版本由服务端绑定，不让用户填写技术字段。 */
import { useState } from 'react';
import type { WorkflowGate } from './WorkflowGate';
export interface RecoveryInfo { budgetUsage?: string; additionalCalls?: number; attemptDetails?: string[]; title: string; phase: string; reason: string; description: string; preserved: string; next: string; retryLabel: string; stopLabel: string; stopImpact: string; limit: string }
/** 明确点击处理动作后再核对后果，失败保留确认人和草稿。 */
export function DevelopmentRecovery({ gate, busy, submit }: { gate: WorkflowGate; busy: boolean; submit: (body: unknown) => Promise<void> }) {
  const info = gate.recoveryInfo!;
  const [additionalCalls, setAdditionalCalls] = useState(info.additionalCalls ?? 72);
  const [reviewer, setReviewer] = useState('');
  const [note, setNote] = useState('');
  const [decision, setDecision] = useState<'retry' | 'stop' | null>(null);
  const [error, setError] = useState('');
  /** 只恢复当前已保存暂停点；网络异常交给父页面只读回查，不自行重复提交。 */
  async function send() {
    if (!decision || !reviewer.trim()) return;
    setError('');
    try { await submit({ gateHash: gate.gateHash, data: { ...gate.fixed, ...(decision === 'retry' && info.additionalCalls ? { additionalCalls } : {}), decision, reviewer: reviewer.trim(), comment: note.trim() || (decision === 'retry' ? `同意从已保存检查点重试${info.phase}` : `停止本轮流程：${info.phase}未完成`) } }); setDecision(null); }
    catch (reason) { setError((reason as Error).message); }
  }
  return <section className="intake-card development-recovery" aria-labelledby="development-recovery-title">
    <div className="intake-eyebrow">执行遇到问题 · 已暂停，等待你的决定</div>
    <h1 id="development-recovery-title">{info.title}</h1>
    <p role="status">{info.description}</p>
    <dl className="recovery-explanation"><dt>发生在哪一步</dt><dd>{info.phase}</dd><dt>出了什么问题</dt><dd>{info.reason}</dd><dt>已为你保留</dt><dd>{info.preserved}</dd><dt>接下来怎么做</dt><dd>{info.next}</dd></dl>
    {info.budgetUsage && <p className="intake-validation" role="status">{info.budgetUsage}</p>}
    {info.additionalCalls && <label>本次追加调用次数（1–72）<input type="number" min={1} max={72} step={1} value={additionalCalls} disabled={busy} onChange={/** 追加量由用户确认，修改后撤销旧确认预览。 */event => { setAdditionalCalls(Number(event.target.value)); setDecision(null); }} /><small>累计消费不会清零；只增加调用额度，文件权限和后续审批保持。</small></label>}
    <p className="intake-validation">{info.limit}</p>
    <label>确认人<input value={reviewer} maxLength={100} disabled={busy} placeholder="填写你的名字，用于记录本次决定" onChange={/** 编辑后重新确认动作。 */event => { setReviewer(event.target.value); setDecision(null); }} /></label>
    <label>补充说明（可选）<textarea value={note} maxLength={2000} rows={2} disabled={busy} placeholder="如需调整环境或稍后处理，可在这里说明" onChange={/** 补充只作为当前决定说明。 */event => { setNote(event.target.value); setDecision(null); }} /></label>
    {!reviewer.trim() && <p className="intake-validation">填写确认人后，选择重试或停止。</p>}
    {error && <p role="alert">{error}</p>}
    {decision ? <div className="intake-assumptions" role="status"><strong>{decision === 'retry' ? `确认${info.retryLabel}？` : '确认停止本轮流程？'}</strong><p>{decision === 'retry' ? info.next : info.stopImpact}</p>{decision === 'retry' && info.additionalCalls && <p>本次追加 {additionalCalls} 次模型角色调用额度；可能产生额外模型费用。</p>}<div className="intake-actions"><button className="primary" disabled={busy} onClick={/** 只有最终确认才提交实际决定。 */() => void send()}>{busy ? '正在处理，请稍候…' : decision === 'retry' ? (info.additionalCalls ? '确认补充并继续' : '确认重试') : '确认停止'}</button><button disabled={busy} onClick={/** 取消确认不恢复原生流程。 */() => setDecision(null)}>返回检查</button></div></div>
      : <div className="intake-actions"><button className="primary" disabled={busy || !reviewer.trim() || (!!info.additionalCalls && (!Number.isInteger(additionalCalls) || additionalCalls < 1 || additionalCalls > 72))} onClick={/** 显式选择重试，不预选或自动恢复。 */() => setDecision('retry')}>{info.retryLabel}</button><button disabled={busy || !reviewer.trim() || (!!info.additionalCalls && (!Number.isInteger(additionalCalls) || additionalCalls < 1 || additionalCalls > 72))} onClick={/** 停止同样需要确认其后果。 */() => setDecision('stop')}>{info.stopLabel}</button></div>}
    <details><summary>技术信息（排查时查看）</summary><p>阶段：{String(gate.evidence.phase)} · 角色：{String(gate.evidence.role)} · 故障分类：{String(gate.evidence.kind)}</p>{info.attemptDetails?.map(/** 每条文案来自服务端白名单，不输出原始异常。 */(detail, index) => <p key={index}>{detail}</p>)}</details>
  </section>;
}
