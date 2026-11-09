import { useEffect, useState } from 'react';

interface Target { id: string; label: string; root: string; origin: string }
interface Dictionary { version: 'remote-sync-targets.v1'; targets: Target[] }

/** 仓库字典端点只在本机服务可用；保存前服务端还会校验Git根目录及origin。 */
async function targetRequest<T>(method: 'GET' | 'PUT', body?: Dictionary): Promise<T> {
  const response = await fetch('/intake-api/remote-sync-targets', method === 'GET' ? { signal: AbortSignal.timeout(15000) } : { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const data = await response.json() as T & { error?: string };
  if (!response.ok) throw new Error(data.error ?? '项目仓库字典未完成。');
  return data;
}

/** 管理本机已授权的项目仓库；阶段路由仍由独立设置页负责。 */
export function RepositoryManagement({ close }: { close: () => void }) {
  const [targets, setTargets] = useState<Target[]>([]); const [loading, setLoading] = useState(true); const [saving, setSaving] = useState(false); const [error, setError] = useState(''); const [notice, setNotice] = useState('');
  /** 读取完整字典；此页才显示本地checkout路径，阶段页不会暴露。 */
  useEffect(() => { void targetRequest<{ targets: Target[] }>('GET').then(/** 初始化表单。 */value => { setTargets(value.targets); }).catch(/** 将服务端校验错误呈现给操作者。 */reason => setError((reason as Error).message)).finally(/** 加载完成后开放返回与编辑。 */() => setLoading(false)); }, []);
  /** 仅覆盖一个目标的一个字段，不修改其他目标或阶段策略。 */
  function update(index: number, field: keyof Target, value: string) { setTargets(current => current.map(/** 按索引返回不可变新对象。 */(target, currentIndex) => currentIndex === index ? { ...target, [field]: value } : target)); }
  /** 添加空白目标，保存时由服务端统一验证标识、checkout与远端。 */
  function add() { setTargets(current => [...current, { id: '', label: '', root: '', origin: 'https://' }]); }
  /** 移除当前编辑项；若仍被启用阶段引用，服务端会拒绝保存并提示先调整路由。 */
  function remove(index: number) { setTargets(current => current.filter(/** 保留其他目标。 */(_target, currentIndex) => currentIndex !== index)); }
  /** 原子保存完整仓库字典，成功后以服务端规范化结果覆盖本地草稿。 */
  async function save() {
    setSaving(true); setError(''); setNotice('');
    try { const result = await targetRequest<{ targets: Target[] }>('PUT', { version: 'remote-sync-targets.v1', targets }); setTargets(result.targets); setNotice('已保存。请到“远端同步设置”将阶段分配到目标仓库。'); }
    catch (reason) { setError((reason as Error).message); }
    finally { setSaving(false); }
  }
  return <main className="intake-main"><header><span>产研交付 · 项目仓库管理</span><button onClick={close}>返回需求流程</button></header><section className="intake-card"><div className="intake-eyebrow">仓库字典</div><h1>管理可同步的项目仓库</h1><p>在这里登记可用项目仓库；阶段设置页只从这份字典选择目标。保存前会核对本地 checkout 是 Git 根目录，且其 origin 与填写的 HTTPS 地址一致。不会自动 clone、改写代码或推送。</p><p className="repository-warning">这是本机服务的管理入口。请仅填写已授权的本地项目 checkout；远端地址不能包含账号或凭据。</p>{error && <p className="intake-error">{error}</p>}{loading ? <p>正在读取项目仓库字典…</p> : <div className="repository-management">{targets.map((target, index) => <fieldset key={`${target.id}-${index}`}><legend>{target.label || `项目仓库 ${index + 1}`}</legend><label>稳定标识<input value={target.id} maxLength={40} placeholder="例如 frontend-flow" onChange={event => update(index, 'id', event.target.value)} /></label><label>显示名称<input value={target.label} maxLength={80} placeholder="例如 前端交付仓库" onChange={event => update(index, 'label', event.target.value)} /></label><label>本地 checkout 路径<input value={target.root} placeholder="/absolute/path/to/project" onChange={event => update(index, 'root', event.target.value)} /></label><label>Git 远端地址（HTTPS）<input value={target.origin} placeholder="https://github.com/org/project.git" onChange={event => update(index, 'origin', event.target.value)} /></label><button disabled={targets.length === 1 || saving} onClick={/** 删除只修改本地草稿，保存前仍可取消。 */() => remove(index)}>移除此仓库</button></fieldset>)}</div>}<div className="intake-actions"><button disabled={loading || saving || targets.length >= 50} onClick={add}>＋ 添加项目仓库</button><button className="primary" disabled={loading || saving || !targets.length} onClick={save}>{saving ? '正在校验并保存…' : '校验并保存仓库字典'}</button></div>{notice && <p className="intake-notice">{notice}</p>}</section></main>;
}
