import { useEffect, useState } from 'react';
import { ArrowLeft, Layers3, LockKeyhole, Settings2 } from 'lucide-react';

type Detail = { label: string; value: string; source: string };
type Team = { id: string; name: string; model: string | null; details: Detail[] };
type Models = { default: string; product: string | null; development: string | null; testing: string };
type Settings = { version: 'team-settings.v1'; developmentContinuationLimit: number; models?: Models };
type View = { version: 'team-configuration-view.v1'; settings: Settings; models: { active: Models; pending: Models; mode: 'fixture' | 'live' }; teams: Team[]; shared: Detail[]; methods: string };

/** 统一处理配置读取、保存与服务端错误，页面不接触运行配置来源。 */
async function requestSettings(settings?: Settings): Promise<View> {
  const response = await fetch('/intake-api/team-configuration', settings ? { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(settings) } : { signal: AbortSignal.timeout(15000) });
  const data = await response.json() as View & { error?: string };
  if (!response.ok) throw new Error(data.error ?? '团队配置请求未完成。');
  return data;
}

/** 共用配置行以一致的方式展示值和权威来源。 */
function Details({ items }: { items: Detail[] }) {
  return <div className="team-settings-rows">{items.map(item => <div className="team-settings-row" key={item.label}><strong>{item.label}</strong><span>{item.value}</span><small>{item.source} · 只读</small></div>)}</div>;
}

/** 平台配置页消费聚合视图，只有明确接入的设置可以保存。 */
export function TeamSettings({ close }: { close: () => void }) {
  const [view, setView] = useState<View>();
  const [selected, setSelected] = useState('product');
  const [limit, setLimit] = useState('');
  const [models, setModels] = useState<Models>();
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [saving, setSaving] = useState(false);
  useEffect(() => {
    let active = true;
    void requestSettings().then(result => { if (active) { setView(result); setLimit(String(result.settings.developmentContinuationLimit)); setModels(result.models.pending); } }).catch(reason => { if (active) setError((reason as Error).message); });
    return () => { active = false; };
  }, []);
  /** 保存经过校验的默认预算，并以服务端回执刷新视图。 */
  async function save() {
    const value = Number(limit);
    if (!/^\d+$/.test(limit) || !Number.isInteger(value) || value < 0 || value > 72) { setError('技术接续次数须为 0 至 72 的整数。'); return; }
    setSaving(true); setError(''); setNotice('');
    try { const result = await requestSettings({ ...view!.settings, developmentContinuationLimit: value }); setView(result); setLimit(String(result.settings.developmentContinuationLimit)); setNotice('已保存。尚未初始化的研发阶段使用新默认值；已初始化的研发状态与继承预算保持不变。'); }
    catch (reason) { setError((reason as Error).message); }
    finally { setSaving(false); }
  }
  /** 保存三个模型选择，不改变当前进程正在使用的模型。 */
  async function saveModels(field: keyof Models) {
    if (!view || !models) return;
    const nextModels = { ...view.models.pending, [field]: models[field] };
    if (!nextModels.product || !nextModels.development || !nextModels.testing) { setError('每个团队都需要填写模型。'); return; }
    const valid = (value: string) => /^openai\/[^\s]+$/.test(value) && value.length <= 200;
    if (!valid(nextModels.default) || (nextModels.product && !valid(nextModels.product)) || (nextModels.development && !valid(nextModels.development)) || !valid(nextModels.testing)) { setError('模型标识须以 openai/ 开头且不包含空白，最多 200 个字符。'); return; }
    setSaving(true); setError(''); setNotice('');
    try { const result = await requestSettings({ ...view.settings, models: nextModels }); setView(result); setModels(current => current ? { ...current, [field]: result.models.pending[field] } : result.models.pending); setNotice('模型配置已保存，重启服务后生效。研发模型变化可能导致旧 Run 因身份不匹配而无法恢复。'); }
    catch (reason) { setError((reason as Error).message); }
    finally { setSaving(false); }
  }
  const team = view?.teams.find(item => item.id === selected);
  return <main className="team-settings-page"><header className="team-settings-header"><button className="team-back" type="button" onClick={close}><ArrowLeft size={16} aria-hidden="true" />返回工作台</button><span>平台管理 / 团队配置</span></header><section className="team-settings"><div className="team-settings-intro"><span className="team-settings-icon"><Settings2 size={20} aria-hidden="true" /></span><div><h1>团队配置中心</h1><p>查看和管理各团队的模型与运行参数。</p></div></div>{error && <p className="team-settings-feedback is-error" role="alert">{error}</p>}{!view && !error && <p>正在读取配置…</p>}{view && <><div className="team-settings-title"><h2>团队配置</h2><p>选择团队，查看或调整该团队的配置。</p></div><nav className="team-settings-tabs" aria-label="选择团队">{view.teams.map(item => <button key={item.id} type="button" aria-pressed={selected === item.id} onClick={() => { setSelected(item.id); setNotice(''); }}>{item.name}</button>)}</nav><div className="team-settings-team">{team && <><h2>{team.name}</h2>{team.model && <Details items={[{ label: '当前运行模型', value: team.model, source: '服务端启动配置' }]} />}{selected === 'delivery' && <Details items={[{ label: '团队模型', value: '当前无需配置：交付团队按固定流程执行交接与回执核验，未使用独立模型。', source: '交付流程' }]} />}{models && (selected === 'product' || selected === 'development' || selected === 'testing') && <fieldset><legend>{team.name}模型</legend><label>团队模型<input name="teamModel" autoComplete="off" spellCheck={false} value={models[selected] ?? ''} onChange={event => setModels({ ...models, [selected]: event.target.value })} placeholder="openai/模型名称" /></label><p>保存后重启服务生效。{selected === 'development' && '研发模型变化可能导致旧 Run 因身份不匹配而无法恢复；请先确认运行状态。'}{view.models.mode === 'fixture' && '当前为固定样例模式，模型调用仍使用样例模型。'}模型可用性需另行验证。</p><button className="primary" type="button" disabled={saving} onClick={() => void saveModels(selected)}>{saving ? '保存中…' : '保存团队模型'}</button></fieldset>}{team.details.length > 0 && <Details items={team.details} />}{selected === 'development' && <fieldset><legend>技术接续默认次数</legend><label>允许 0–72 次<input name="continuationLimit" type="number" min="0" max="72" step="1" value={limit} onChange={event => setLimit(event.target.value)} /></label><p>尚未初始化的研发阶段使用此值；已初始化的研发状态与从前序流程继承的预算不会改变。调整只影响此项，不扩大权限或跳过审批。</p><button className="primary" type="button" disabled={saving} onClick={() => void save()}>{saving ? '保存中…' : '保存默认次数'}</button></fieldset>}</>}</div><section className="team-settings-shared" aria-labelledby="shared-settings-title"><h2 id="shared-settings-title"><Layers3 size={18} aria-hidden="true" />平台共用信息</h2><h3>团队方法</h3><p>{view.methods}</p><p>方法版本和执行时限当前只读；其配置来源及生效方式不同。</p><h3>资料读取策略</h3><Details items={view.shared} /><p>资料读取策略在构建时加载，修改后需重新发布。</p><h3><LockKeyhole size={15} aria-hidden="true" />执行与验收</h3><p>受保护检查、审批、项目绑定及交付门禁由工程契约和 Workflow 管理；此页面不提供关闭入口。</p></section></>}{notice && <p className="team-settings-feedback" role="status">{notice}</p>}</section></main>;
}
