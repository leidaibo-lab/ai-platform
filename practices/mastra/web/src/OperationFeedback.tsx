import { useEffect, useState } from 'react';
/** 持续可见的真实请求反馈，不使用虚构百分比；计时只表示已等待时长。 */
export function OperationFeedback({ busy, label, startedAt, error, notice, dismiss }: { busy: boolean; label: string; startedAt: number; error: string; notice: string; dismiss: () => void }) {
  const [seconds, setSeconds] = useState(0);
  // 等待时每秒更新视觉计时，完成即清理，不逐秒触发读屏播报。
  useEffect(() => {
    if (!busy) return;
    /** 时长由本次操作开始时间计算，不暗示模型处理进度。 */
    function tick() { setSeconds(Math.max(0, Math.floor((Date.now() - startedAt) / 1000))); }
    tick(); const timer = window.setInterval(tick, 1000);
    // 离开等待态后停止计时。
    return () => window.clearInterval(timer);
  }, [busy, startedAt]);
  if (!busy && !error && !notice) return null;
  return <div className={`operation-feedback ${error ? 'operation-failed' : ''}`}>
    {busy ? <><span className="operation-spinner" aria-hidden="true" /><div><strong role="status">{label}</strong><p aria-hidden="true">已等待 {seconds} 秒{seconds >= 45 ? ' · 模型生成可能需要几分钟，请勿重复提交' : ' · 完成后将自动展示结果'}</p></div></> : <><div><strong role={error ? 'alert' : 'status'}>{error ? '本次操作未完成' : notice}</strong>{error && <p>{error} 输入已保留；请先刷新确认状态，不要重复批准。</p>}</div><button type="button" aria-label="关闭操作提示" onClick={dismiss}>关闭</button></>}
  </div>;
}
