import { useEffect, useState } from 'react';

interface Contract { version: 'project-delivery-contract.v1'; paths: { requirements: string; productSpecification: string; developmentSource: string; testingCases: string; engineeringRules: string } }
interface ProjectOption { id: string; title: string }
interface ContractResponse { project: { id: string; label: string; repositoryUrl: string }; adapterRoots: { developmentSource: string[]; testingCases: string[] }; contract: Contract; hash: string }

/** 读取并保存当前已登记项目的交付落点契约。 */
async function contractRequest<T>(method: 'GET' | 'PUT', projectId: string, body?: Contract): Promise<T> {
  const response = await fetch('/intake-api/project-delivery-contract?projectId=' + encodeURIComponent(projectId), method === 'GET' ? { signal: AbortSignal.timeout(15000) } : { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const data = await response.json() as T & { error?: string };
  if (!response.ok) throw new Error(data.error ?? '项目交付配置未完成。');
  return data;
}

/** 配置项目级业务文档和工程落点；Git 交接是固定必需门禁。 */
export function RemoteSyncSettings({ close, projectId }: { close: () => void; projectId?: string }) {
  const [projects, setProjects] = useState<ProjectOption[]>([]); const [activeProjectId, setActiveProjectId] = useState(projectId ?? ''); const [value, setValue] = useState<ContractResponse>(); const [loading, setLoading] = useState(true); const [saving, setSaving] = useState(false); const [error, setError] = useState(''); const [notice, setNotice] = useState('');
  useEffect(() => {
    void fetch('/intake-api/projects').then(response => response.json()).then((data: { projects: ProjectOption[] }) => { setProjects(data.projects); setActiveProjectId(current => current || projectId || data.projects[0]?.id || ''); }).catch(reason => setError((reason as Error).message));
  }, [projectId]);
  useEffect(() => {
    if (!activeProjectId) { setValue(undefined); setLoading(false); return; }
    setLoading(true); setError('');
    void contractRequest<ContractResponse>('GET', activeProjectId).then(/** 使用服务端绑定和当前契约初始化页面。 */result => setValue(result)).catch(/** 清空上个项目残留值并展示当前错误。 */reason => { setValue(undefined); setError((reason as Error).message); }).finally(/** 请求结束后显示完整表单。 */() => setLoading(false));
  }, [activeProjectId]);
  /** 更新单个路径字段，其他项目契约内容保持不变。 */
  function update(key: keyof Contract['paths'], path: string) { setValue(current => current ? { ...current, contract: { ...current.contract, paths: { ...current.contract.paths, [key]: path } } } : current); }
  /** 保存时由服务端再校验路径并生成不可变配置版本。 */
  async function save() {
    if (!value || !activeProjectId) return;
    setSaving(true); setError(''); setNotice('');
    try { const result = await contractRequest<ContractResponse>('PUT', activeProjectId, value.contract); setValue(result); setNotice('已保存。新 Run 将使用此配置版本，运行中的 Run 保持原落点。'); }
    catch (reason) { setError((reason as Error).message); }
    finally { setSaving(false); }
  }
  const fields: { key: keyof Contract['paths']; label: string; hint: string }[] = [
    { key: 'requirements', label: '需求文档', hint: '必须包含 {iterationId}，每个迭代独立归档。' },
    { key: 'productSpecification', label: '产品规格', hint: '必须包含 {iterationId}，产品批准后与需求一起交接。' },
    { key: 'developmentSource', label: '开发代码目录', hint: `当前 Adapter 登记路径：${value?.adapterRoots.developmentSource.join('、') ?? ''}` },
    { key: 'testingCases', label: '测试用例目录', hint: `当前 Adapter 登记路径：${value?.adapterRoots.testingCases.join('、') ?? ''}` },
    { key: 'engineeringRules', label: '工程规则目录', hint: '放置项目协作规则与经负责人确认的工程契约。' },
  ];
  return <main className="intake-main"><header><span>产研交付 · 业务工程接入</span><button onClick={close}>返回需求流程</button></header><section className="intake-card"><div className="intake-eyebrow">多项目 · 项目级配置</div><h1>配置业务工程接入</h1><p>每个项目的 Git 仓库已在项目登记时绑定。这里选择的项目只决定交付落点，不重复配置仓库地址。</p>{projects.length > 1 && <label>选择业务工程<select value={activeProjectId} onChange={event => { setValue(undefined); setNotice(''); setActiveProjectId(event.target.value); }}>{projects.map(item => <option key={item.id} value={item.id}>{item.title}</option>)}</select></label>}{error && <p className="intake-error">{error}</p>}{loading ? <p>正在读取项目交付配置…</p> : value && <><section className="sync-targets"><h2>{value.project.label}</h2><article><strong>已绑定 Git 仓库</strong><code>{value.project.repositoryUrl}</code></article><p>当前交付配置版本：<code>{value.hash.slice(0, 12)}</code></p></section><div className="sync-settings">{fields.map(field => <fieldset key={field.key}><legend>{field.label}</legend><label>仓库内相对路径<input value={value.contract.paths[field.key]} onChange={event => update(field.key, event.target.value)} spellCheck={false} /></label><small>{field.hint}</small></fieldset>)}</div><aside className="repository-warning"><strong>必需 Git 交接</strong><p>产品批准后，需求与产品规格必须提交到绑定仓库。远端交接失败会阻止开发继续，并保留恢复点；此门禁不可关闭。</p></aside><aside className="sync-targets"><strong>首次接入</strong><p>接入检查发现的缺失目录和工程契约必须按受控流程准备；待确认的工程规则、Adapter 或权限不会自动成为已批准版本。</p></aside></>}{<div className="intake-actions"><button className="primary" disabled={!value || loading || saving} onClick={() => void save()}>{saving ? '正在保存…' : '保存项目交付配置'}</button></div>}{notice && <p className="intake-notice">{notice}</p>}</section></main>;
}
