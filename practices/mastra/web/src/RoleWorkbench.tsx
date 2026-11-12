/** 角色工作台：编辑受控增强字段并发布原生Agent新版本，既有Run不在此页变更。 */
import { useEffect, useState } from 'react';

interface RoleView {
  key: string; agentId: string; versionId: string; versionNumber: number | null; instructions: string;
  model: { name: string; temperature?: number; topP?: number; maxCompletionTokens?: number };
  tools: string[]; skillPins: { skillId: string; versionId: string }[]; configHash: string;
}

/** 同源资源请求只处理公开错误，浏览器不接触Skill正文、制品或凭据。 */
async function resourceRequest<T>(path: string, options?: RequestInit): Promise<T> {
  const response = await fetch(`/intake-api/role-resources${path}`, { ...options, headers: options?.body ? { 'Content-Type': 'application/json' } : undefined, cache: 'no-store' });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error ?? '角色资源操作未完成。');
  return body as T;
}

/** 只展示一项角色的可编辑增强，Skill pin和工具实现始终只读。 */
function RoleEditor({ role, refresh }: { role: RoleView; refresh: () => Promise<void> }) {
  const [instructions, setInstructions] = useState(role.instructions);
  const [model, setModel] = useState(role.model.name);
  const [temperature, setTemperature] = useState(role.model.temperature ?? 0);
  const [tools, setTools] = useState(role.tools);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  useEffect(() => { setInstructions(role.instructions); setModel(role.model.name); setTemperature(role.model.temperature ?? 0); setTools(role.tools); setMessage(''); }, [role]);
  /** 只可在当前已登记工具集合内收紧；不能从页面声明新工具。 */
  function toggleTool(name: string) { setTools(current => current.includes(name) ? current.filter(item => item !== name) : [...current, name]); }
  /** 发布生成新的Stored Agent版本，冲突时保留用户输入并让其刷新比对。 */
  async function publish() {
    setBusy(true); setMessage('');
    try {
      const result = await resourceRequest<{ versionId: string }>('/publish', { method: 'POST', body: JSON.stringify({ agentId: role.agentId, baseVersionId: role.versionId, instructions, model: { name: model, temperature }, tools }) });
      setMessage(`已发布原生版本 ${result.versionId.slice(0, 8)}；仅后续新 Run 会采用它。`);
      await refresh();
    } catch (error) { setMessage((error as Error).message); }
    finally { setBusy(false); }
  }
  return <article className="role-editor">
    <header><div><strong>{role.key}</strong><small>已发布版本 {role.versionNumber ?? '?'} · {role.versionId.slice(0, 8)}</small></div><code title={role.configHash}>{role.configHash.slice(0, 12)}</code></header>
    <label>角色指令<textarea value={instructions} maxLength={50000} onChange={event => setInstructions(event.target.value)} /></label>
    <label>冻结模型名称<input value={model} maxLength={200} onChange={event => setModel(event.target.value)} /></label>
    <label>temperature<input type="number" min="0" max="2" step="0.1" value={temperature} onChange={event => setTemperature(Number(event.target.value))} /></label>
    <fieldset><legend>已登记工具（只能收紧）</legend>{role.tools.map(name => <label className="role-tool" key={name}><input type="checkbox" checked={tools.includes(name)} onChange={() => toggleTool(name)} />{name}</label>)}</fieldset>
    <details><summary>固定 Skill pin（只读，{role.skillPins.length} 项）</summary>{role.skillPins.length ? role.skillPins.map(pin => <p key={pin.skillId}><code>{pin.skillId}</code> · {pin.versionId.slice(0, 8)}</p>) : <p>此角色未绑定 Skill。</p>}</details>
    <p className="role-boundary">工具实现、Skill 正文、部署制品与运行中 Run 绑定不在此页编辑。</p>
    <button className="primary" disabled={busy || !instructions.trim() || !model.trim()} onClick={() => void publish()}>{busy ? '发布中…' : '发布为新角色版本'}</button>{message && <p className="role-message" role="status">{message}</p>}
  </article>;
}

/** 工作台入口：原生Agent版本是唯一事实源，页面只展示投影。 */
export function RoleWorkbench({ close }: { close: () => void }) {
  const [roles, setRoles] = useState<RoleView[]>([]);
  const [selected, setSelected] = useState('');
  const [error, setError] = useState('');
  /** 刷新后保持当前角色选择，角色新版本由服务端原生Store决定。 */
  async function refresh() {
    try { const result = await resourceRequest<{ roles: RoleView[] }>(''); setRoles(result.roles); setSelected(current => result.roles.some(role => role.agentId === current) ? current : result.roles[0]?.agentId ?? ''); setError(''); }
    catch (reason) { setError((reason as Error).message); }
  }
  useEffect(() => { void refresh(); }, []);
  const role = roles.find(item => item.agentId === selected);
  return <main className="role-workbench"><header><div><div className="intake-eyebrow">原生 Stored Agent</div><h1>角色资源工作台</h1><p>配置只能增强或收紧已登记能力。发布创建新版本；已暂停或运行中的 Run 继续使用它们首步冻结的版本。</p></div><div className="role-workbench-actions"><button onClick={close}>返回产研 Run</button><button onClick={() => void refresh()}>刷新版本</button></div></header>{error && <p className="intake-error">{error}</p>}<div className="role-workbench-layout"><nav aria-label="角色列表">{roles.map(item => <button className={item.agentId === selected ? 'selected' : ''} key={item.agentId} onClick={() => setSelected(item.agentId)}><strong>{item.key}</strong><small>v{item.versionNumber ?? '?'}</small></button>)}</nav>{role ? <RoleEditor role={role} refresh={refresh} /> : <section className="intake-card"><p>正在加载原生角色版本…</p></section>}</div></main>;
}
