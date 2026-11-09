import { useEffect, useState } from 'react';
interface Catalog { available: boolean; reason?: string; id: string; title: string; branch: string; revision: string; catalogHash: string; executionReady: boolean; executionReason: string; preparationIssues?: string[]; modules: { id: string; title: string; role: string; count: number }[]; files: { path: string; area: string; bytes: number }[]; checks: { id: string; title: string; command: string; ready: boolean; reason: string }[] }
/** 用户只确认项目与整体权限，精确文件拆分及实际团队由开发Workflow形成。 */
export function RepositoryScope({ gateHash, busy, submit }: { gateHash: string; busy: boolean; submit: (body: unknown) => Promise<void> }) {
  const [catalog, setCatalog] = useState<Catalog>();
  const [error, setError] = useState('');
  const [revision, setRevision] = useState(0);
  const [reviewer, setReviewer] = useState('');
  const [comment, setComment] = useState('');
  const [confirm, setConfirm] = useState(false);
  // 只读取服务端已授权仓库；不接受浏览器任意路径。
  useEffect(() => {
    const controller = new AbortController(); setConfirm(false); setError(''); setCatalog(undefined);
    /** 检查当前仓库版本与隔离验证环境，不执行项目开发或数据库操作。 */
    async function load() {
      try { const response = await fetch('/intake-api/project', { signal: controller.signal }); if (!response.ok) throw new Error('项目环境读取失败'); const result = await response.json(); if (!controller.signal.aborted) setCatalog(result); }
      catch { if (!controller.signal.aborted) setError('项目环境暂时无法读取，请重新检查。'); }
    }
    void load();
    // 关口切换后不再更新旧表单。
    return () => controller.abort();
  }, [revision]);
  /** 确认仅启动上下文、方案与团队规划；不会跳过架构批准直接实施。 */
  function proceed() { if (catalog) void submit({ gateHash, repositoryScope: { catalogHash: catalog.catalogHash, reviewer, comment } }); }
  if (!catalog) return <section className="intake-card"><h1>确认开发项目</h1><p role="status">{error || '正在关联 HRM 仓库并检查验证环境…'}</p>{error && <button onClick={/** 重试只读检查。 */() => setRevision(revision + 1)}>重新检查</button>}</section>;
  return <section className="intake-card repository-scope"><div className="intake-eyebrow">产品需求已确认 · 交接开发团队</div><h1>确认开发项目</h1><p>你只需确认使用这个项目和代码版本。具体改哪些文件、由哪些开发角色负责，会由开发团队根据已批准需求提出方案。</p>
    {!catalog.available ? <p role="alert">{catalog.reason}</p> : <>
      <section className="scope-section"><h2>使用的项目与版本</h2><p><strong>{catalog.title}</strong> · 已自动关联</p><p>当前工作分支：<code>{catalog.branch}</code><br />代码版本：<code>{catalog.revision.slice(0, 12)}</code></p><details><summary>查看当前项目模块</summary><ul>{catalog.modules.map(/** 模块概况用于核对项目，不要求用户分配技术任务。 */module => <li key={module.id}>{module.title} · {module.count} 个源码或配置文件</li>)}</ul></details></section>
      <section className="scope-section"><h2>开发团队接下来会做什么？</h2><ol><li>读取已批准的需求、项目规则和当前代码。</li><li>提出实现方案，确定具体文件改动和任务依赖。</li><li>根据任务组建所需角色，再由独立角色检查是否具备开工条件。</li><li>向你展示技术方案、团队和改动范围，确认后才开始实施。</li></ol><p>本次仅在独立候选副本中准备与开发，不直接修改原仓库。检查脚本、依赖清单和锁文件受保护；数据库使用临时测试实例。</p><details><summary>查看项目权限上界</summary><p>允许开发团队在前端页面、后端接口、数据库代码与模型目录内提出文件新增和改动。具体路径必须进入后续架构批准包；不能由 Agent 自行扩大授权。</p></details></section>
      <section className="scope-section"><h2>改动如何验证？</h2><p>验证配置由项目自动关联，不需要你选择测试文件。开发自检和后续独立测试会使用这些固定检查。</p>{catalog.checks.map(/** 显示已登记的验证能力，不冒充当前候选已经测试通过。 */check => <div className="scope-check" key={check.id}><span><strong>{check.title}</strong><code>{check.command}</code><small>{catalog.executionReady ? '已接入隔离执行 · 实际改动后运行并保存证据' : '工程准备完成后执行'}</small></span></div>)}<p role="status">{catalog.executionReason}</p>{!!catalog.preparationIssues?.length && <details open><summary>待完成的工程准备（{catalog.preparationIssues.length} 项）</summary><ul>{catalog.preparationIssues.map(/** 显示服务端实际检测缺口，产品交接不要求用户代建工程。 */issue => <li key={issue}>{issue}</li>)}</ul></details>}<button disabled={busy} onClick={/** 环境变化后只重新检查，不自动提交授权。 */() => setRevision(revision + 1)}>重新检查环境</button></section>
      <label>确认人<input value={reviewer} maxLength={100} onChange={/** 本地标签不代表真实身份认证。 */event => { setReviewer(event.target.value); setConfirm(false); }} /></label><label>交接说明<textarea value={comment} maxLength={2000} placeholder="例如：使用当前 HRM 项目，由开发团队提出实现方案后再确认开工。" onChange={/** 明确保留人类对本次交接的说明。 */event => { setComment(event.target.value); setConfirm(false); }} /></label>
      {confirm ? <div className="intake-assumptions"><strong>确认使用当前项目，开始生成开发方案？</strong><p>会读取当前代码并调用开发模型分析。{catalog.executionReady ? '方案完成后仍会等待你的确认，不自动实施或发布。' : '当前仅生成方案并列出工程准备事项，不能批准实施或发布。'}</p><button className="primary" disabled={busy} onClick={proceed}>{busy ? '正在生成开发方案…' : '确认项目并继续'}</button><button disabled={busy} onClick={/** 返回不会改变工作流或授权。 */() => setConfirm(false)}>返回检查</button></div> : <button className="primary" disabled={busy || !reviewer.trim() || !comment.trim()} onClick={/** 提交前明确说明实际后果。 */() => setConfirm(true)}>确认项目，交给开发团队规划 →</button>}
    </>}
  </section>;
}
