import { useState } from 'react';

interface MigrationPlan { hash: string; previousPolicy?: string; currentPolicy: string; checkpointHash: string; budget: { calls: number; maxCalls: number } }

/** 先展示服务端迁移计划，确认时只提交当前计划散列与新 Run 标识。 */
export function RunMigration({ runId, completed }: { runId: string; completed: (runId: string) => void }) {
  const [plan, setPlan] = useState<MigrationPlan>();
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [target] = useState(() => crypto.randomUUID());
  /** 写连接中断时保留目标标识，重试由服务端核对相同谱系。 */
  async function migrate(confirm: boolean) {
    setBusy(true); setError('');
    try {
      const response = await fetch(`/intake-api/runs/${runId}/migration`, confirm ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ runId: target, planHash: plan!.hash }) } : {});
      const data = await response.json();
      if (!response.ok) throw new Error(data.error);
      if (confirm) completed(data.runId); else setPlan(data);
    } catch (reason) { setError((reason as Error).message); }
    finally { setBusy(false); }
  }
  return <section className="intake-card"><h2>历史 Run 迁移</h2>{error && <p role="alert">{error}</p>}{plan ? <>
    <p>原策略 {plan.previousPolicy ?? '未记录'}，当前策略 {plan.currentPolicy}。新 Run 将重新确认产品和架构，继承已消费的 {plan.budget.calls} / {plan.budget.maxCalls} 次模型调用。</p>
    <p>来源检查点 <code>{plan.checkpointHash}</code></p>
    <button disabled={busy} onClick={() => void migrate(true)}>确认计划并创建新 Run</button>
  </> : <button disabled={busy} onClick={() => void migrate(false)}>核验并准备迁移计划</button>}</section>;
}
