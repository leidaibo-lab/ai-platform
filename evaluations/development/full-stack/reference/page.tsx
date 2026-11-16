'use client';
import {useEffect,useState,type FormEvent} from 'react';
interface Ticket {id:string;title:string;createdAt:string}
/** 主持参考实现，仅用于验证容器与固定检查，不能计为Agent产出。 */
export default function Page() {
  const [tickets,setTickets]=useState<Ticket[]>([]);
  const [title,setTitle]=useState('');
  const [loading,setLoading]=useState(true);
  const [saving,setSaving]=useState(false);
  const [error,setError]=useState('');
  /** 从相同来源的固定API代理读取真实数据。 */
  async function refresh() { const response=await fetch('/api/tickets',{cache:'no-store'}); if (!response.ok) throw new Error('加载失败'); setTickets(await response.json()); }
  // 首次加载显示明确状态并处理失败。
  useEffect(() => {
    /** 将首次加载异常显示给用户。 */
    function initialError() { setError('加载失败'); }
    /** 无论成功失败均结束加载状态。 */
    function finishLoading() { setLoading(false); }
    refresh().catch(initialError).finally(finishLoading);
  },[]);
  /** 以真实POST创建，失败保留输入，成功重新读取列表。 */
  async function submit(event:FormEvent<HTMLFormElement>) {
    event.preventDefault(); setError('');
    if (title.trim().length<1 || title.trim().length>120) { setError('标题长度必须为1到120'); return; }
    setSaving(true);
    try { const response=await fetch('/api/tickets',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({title})}); if (!response.ok) throw new Error('创建失败'); await refresh(); setTitle(''); }
    catch { setError('创建失败'); } finally { setSaving(false); }
  }
  return <main><h1>工单</h1><form onSubmit={submit}><label htmlFor="title">标题</label><input id="title" value={title} maxLength={120} onChange={
    // 仅更新表单值，React文本节点负责输出转义。
    (event) => setTitle(event.target.value)
  }/><button disabled={saving}>{saving?'提交中':'创建'}</button></form>{loading?<p>加载中</p>:tickets.length===0?<p>暂无工单</p>:<ul>{tickets.map(
    // 使用持久化UUID作为列表稳定标识。
    (ticket) => <li key={ticket.id}>{ticket.title}</li>
  )}</ul>}{error&&<p role="alert">{error}</p>}</main>;
}
