import { useEffect, useState } from 'react';
/** 服务端白名单观察投影，不包含正文和原始错误。 */
export interface ExecutionView { token: string; role: string; startedAt: number; lastActivityAt: number; attempt: number; attemptStartedAt: number; steps: number; phase: string; settled: boolean; failures: { attempt: number; durationMs: number; recordedAt: string; kind: string; failure: { source: string; httpStatus?: number; triggerLimitMs?: number } }[] }
export interface ExecutionSettings { maxAttempts: number; totalMs: number; stepMs: number; retryDelayMs: number; sdkRetries: number; outputTokens?: number }
/** 以服务器时间呈现真实尝试，取消确认绑定当前调用版本。 */
export function ExecutionStatus({ execution, settings, status, cancel, cancelBusy }: { execution?: ExecutionView; settings?: ExecutionSettings; status: string; cancel: (token: string) => Promise<void>; cancelBusy: boolean }) {
  const [now, setNow] = useState(Date.now());
  const [confirmToken, setConfirmToken] = useState('');
  // 本地计时不是后台活动证据。
  useEffect(() => { const timer = window.setInterval(/** 更新计时。 */() => setNow(Date.now()), 1000); return /** 卸载停止。 */() => window.clearInterval(timer); }, []);
  if (!execution) return status === 'running' ? <section className="intake-card"><h2>后台运行中</h2><p>当前没有细粒度观察，可能是历史任务、其他服务进程或非产品阶段，不能据此判断超时或重试。本阶段暂不支持从此页取消。</p></section> : null;
  const titles: Record<string, string> = { requirements: '需求分析', coordinator: '产品统筹', clarification: '需求梳理', closure: '业务闭环检查', writing: '产品稿写作' };
  const phases: Record<string, string> = { generating: '正在生成', retrying: '故障后等待自动重试', canceling: '取消中，等待本地调用退出', stopped: '本地执行已停止', settled: '该次生成已退出' };
  const end = execution.settled ? execution.lastActivityAt : now;
  const cancellable = !execution.settled && ['generating', 'retrying'].includes(execution.phase);
  return <section className="intake-card"><div className="intake-eyebrow">实时执行观察 · 服务器时间</div><h2>{titles[execution.role] ?? execution.role} · {phases[execution.phase] ?? execution.phase}</h2>
    <p role="status">第 {execution.attempt}/{settings?.maxAttempts ?? 2} 次尝试 · 已完成 {execution.steps} 个模型步骤</p>
    <p>本次角色已用 {Math.max(0, Math.floor((end - execution.startedAt) / 1000))} 秒 · 当前尝试 {Math.max(0, Math.floor((end - execution.attemptStartedAt) / 1000))} 秒</p>
    <p>最近真实活动：{new Date(execution.lastActivityAt).toLocaleString()}。长时间无新活动不能直接判定卡死。</p>
    {execution.failures.length > 0 && <div role="status"><strong>已发生 {execution.failures.length} 次失败{execution.attempt > 1 ? '，已进入重试' : ''}</strong>{execution.failures.map(/** 仅展示白名单来源、计时及状态码。 */item => <p key={item.attempt}>尝试 {item.attempt} · {Math.round(item.durationMs / 1000)} 秒 · {item.failure.source}{item.failure.httpStatus ? ` HTTP ${item.failure.httpStatus}` : ''}{item.failure.triggerLimitMs ? `，触发时限 ${item.failure.triggerLimitMs / 1000} 秒` : ''} · {new Date(item.recordedAt).toLocaleString()}</p>)}</div>}
    <details><summary>查看当前生效的超时与重试配置</summary><p>单模型步骤 {settings ? settings.stepMs / 60000 : 10} 分钟；一次角色调用共享总时限 {settings ? settings.totalMs / 60000 : 30} 分钟；最多 {settings?.maxAttempts ?? 2} 次尝试（含首次）；临时故障退避 {settings ? settings.retryDelayMs / 1000 : 1} 秒；SDK 自动重试 {settings?.sdkRetries ?? 0} 次{settings?.outputTokens ? `；输出上限 ${settings.outputTokens} tokens` : ''}。</p><p>HTTP 连接超时与模型执行时限分开；上游也可能提前返回 504/524。这里只读配置，修改服务端配置需重启后生效。观察信息在服务进程内保存，重启后不补造历史。</p></details>
    {execution.phase === 'canceling' && <p role="status">已请求取消。确认本地调用退出之前，请勿恢复或重新提交。</p>}
    {execution.phase === 'stopped' && <p>已阻止当前调用的迟到结果继续交付。上游是否立即停止计算及计费无法由本地确认。此前保存的回答和成果保留。</p>}
    {cancellable && (confirmToken === execution.token ? <div className="intake-assumptions"><strong>确认取消当前生成？</strong><p>将终止本轮流程；已保存的回答和前序成果保留，未完成正文不交付。取消后暂无原位恢复入口。</p><button disabled={cancelBusy} onClick={/** 版本绑定避免误取消下一角色。 */() => void cancel(confirmToken)}>确认取消生成</button><button disabled={cancelBusy} onClick={/** 返回观察。 */() => setConfirmToken('')}>继续等待</button></div> : <button disabled={cancelBusy} onClick={/** 打开影响确认。 */() => setConfirmToken(execution.token)}>取消当前生成</button>)}
  </section>;
}
