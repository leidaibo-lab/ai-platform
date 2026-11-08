import { useEffect, useState } from 'react';

type Phase = 'product' | 'architecture' | 'development' | 'testing' | 'release';
interface Setting { enabled: boolean; targetId: string }
interface Settings { version: 'remote-sync-settings.v1'; phases: Record<Phase, Setting> }
interface Target { id: string; label: string; repositoryUrl: string }
const labels: Record<Phase, { title: string; detail: string }> = {
  product: { title: '产品与业务澄清', detail: '需求输入、产品稿、待决问题和修订稿' }, architecture: { title: '技术方案', detail: '上下文核对、架构任务包、开工条件' }, development: { title: '开发与评审', detail: '实现、自检、代码评审和研发交付检查' }, testing: { title: '测试', detail: '测试计划、执行记录与质量结论' }, release: { title: '发布', detail: '发布授权、执行回执、健康检查与回滚' },
};
/** 设置端点不属于单个Run，单独使用固定地址并保留与主请求一致的错误语义。 */
async function settingsRequest<T>(method: 'GET' | 'PUT', body?: Settings): Promise<T> {
  const response = await fetch('/intake-api/remote-sync-settings', method === 'GET' ? { signal: AbortSignal.timeout(15000) } : { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const data = await response.json() as T & { error?: string };
  if (!response.ok) throw new Error(data.error ?? '远端同步设置未完成。');
  return data;
}

/** 管理后续阶段的交付同步策略；页面不接触本地路径、Git地址或凭据。 */
export function RemoteSyncSettings({ close }: { close: () => void }) {
  const [settings, setSettings] = useState<Settings>(); const [targets, setTargets] = useState<Target[]>([]); const [saving, setSaving] = useState(false); const [error, setError] = useState(''); const [notice, setNotice] = useState('');
  /** 服务端只回传可选择的稳定目标ID和标签。 */
  useEffect(() => { void settingsRequest<{ settings: Settings; targets: Target[] }>('GET').then(/** 载入当前设置。 */value => { setSettings(value.settings); setTargets(value.targets); }).catch(/** 展示服务端拒绝原因。 */reason => setError((reason as Error).message)); }, []);
  /** 返回当前阶段已选择的服务端目标，用于把名称和远端地址一起呈现。 */
  function targetFor(phase: Phase): Target | undefined { return targets.find(/** 目标ID由服务端白名单保证稳定。 */target => target.id === settings?.phases[phase].targetId); }
  /** 只更新当前阶段，其他路由设置原样保留。 */
  function update(phase: Phase, patch: Partial<Setting>) { setSettings(current => current ? { ...current, phases: { ...current.phases, [phase]: { ...current.phases[phase], ...patch } } } : current); }
  /** 保存整体策略；已暂停节点继续使用既有检查点。 */
  async function save() { if (!settings) return; setSaving(true); setError(''); try { const next = await settingsRequest<{ settings: Settings; targets: Target[] }>('PUT', settings); setSettings(next.settings); setTargets(next.targets); setNotice('已保存。后续进入的节点将按此策略同步。'); } catch (reason) { setError((reason as Error).message); } finally { setSaving(false); } }
  return <main className="intake-main"><header><span>产研交付 · 远端同步设置</span><button onClick={close}>返回需求流程</button></header><section className="intake-card"><div className="intake-eyebrow">交付路由</div><h1>每个阶段同步到哪里</h1><p>开关决定后续节点是否创建远端交付副本。仓库由服务端登记；本页可以分配阶段，但不能添加本地路径、Git 地址或凭据。</p>{error && <p className="intake-error">{error}</p>}{!settings ? <p>正在读取设置…</p> : <><section className="sync-targets" aria-label="已登记的目标仓库"><h2>已登记的目标仓库</h2><p>以下是当前服务实际允许同步的远端地址。新增或替换项目仓库后，重启服务即可在下方选择。</p>{targets.map(target => <article key={target.id}><strong>{target.label}</strong><code>{target.repositoryUrl}</code></article>)}</section><div className="sync-settings">{(Object.keys(labels) as Phase[]).map(phase => { const target = targetFor(phase); return <fieldset key={phase}><legend>{labels[phase].title}</legend><p>{labels[phase].detail}</p><label className="intake-option"><input type="checkbox" checked={settings.phases[phase].enabled} onChange={event => update(phase, { enabled: event.target.checked })} />同步本阶段交付资料</label><label>目标仓库<select disabled={!settings.phases[phase].enabled || !targets.length} value={settings.phases[phase].targetId} onChange={event => update(phase, { targetId: event.target.value })}>{targets.map(item => <option key={item.id} value={item.id}>{item.label}</option>)}</select></label>{settings.phases[phase].enabled && target && <p className="sync-target-address">将同步至：<code>{target.repositoryUrl}</code></p>}{!settings.phases[phase].enabled && <p className="sync-target-address">本阶段已关闭远端同步。</p>}</fieldset>; })}</div></>}<div className="intake-actions"><button className="primary" disabled={!settings || saving} onClick={save}>{saving ? '正在保存…' : '保存同步设置'}</button></div>{notice && <p className="intake-notice">{notice}</p>}</section></main>;
}
