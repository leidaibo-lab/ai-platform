import { intakeRequest as request, reconcileWrite } from './intake-request';
import { RepositoryScope } from './RepositoryScope';
import { OperationFeedback } from './OperationFeedback';
import { useEffect, useState } from 'react';
import { WorkflowGateForm, type WorkflowGate } from './WorkflowGate';
import { Markdown } from './components/Markdown';
import './intake.css';
interface Question { id: string; title: string; reason: string; required: boolean; kind: 'single' | 'multiple' | 'text'; options: { id: string; label: string }[]; recommendation: string }
interface Answer { questionId: string; selected: string[]; custom: string }
interface Document { clarify?: { hash: string; title: string }; blockage?: { phase: string; title: string; summary: string; blockers: string[]; taskCount: number; productContent: string }; progress?: { attemptDetails?: string[]; phase: string; title: string; detail: string; next: string }; retry?: { hash: string; message: string; savedAnswers: number; title: string; step: string; reason: string; impact: string; preserved: {label: string; role: string}[] }; outcome?: string; gate?: WorkflowGate; runId: string; status: string; mode?: string; brief: string; step?: string; intake?: { round: number; hash: string; plan: { summary: string; assumptions: string[]; questions: Question[] }; history: { plan: { questions: Question[] }; response: { reviewer: string; supplement: string; answers: Answer[] } }[] }; product?: { artifact: { content: string; hash: string } } }
/** 从实际关口映射业务阶段，避免进入开发后仍高亮需求输入。 */
function intakeStage(document?: Document): number {
  if (document?.progress?.phase === '产品稿修订') return 1;
  if (document?.gate?.key === 'confirm-blocker-answers') return 0;
  if (document?.gate?.key === 'review-revised-product') return 1;
  if (document?.blockage) return 2;
  if (document?.product || document?.retry?.step.startsWith('draft-product.')) return 1;
  if (document?.gate) return ['confirm-project-scope', 'approve-architecture', 'resolve-readiness', 'resolve-findings', 'recover-development'].includes(document.gate.key) ? 2 : 3;
  return document?.outcome ? 3 : 0;
}
/** 主流程需求入口；只有未提交表单属于 React，所有已确认内容来自快照。 */
export function IntakeApp() {
  const [id, setId] = useState(new URLSearchParams(location.search).get('run') ?? '');
  const [document, setDocument] = useState<Document>();
  const [runs, setRuns] = useState<Document[]>([]);
  const [brief, setBrief] = useState('');
  const [iterationId, setIterationId] = useState('unassigned');
  const [answers, setAnswers] = useState<Record<string, Answer>>({});
  const [reviewer, setReviewer] = useState('');
  const [supplement, setSupplement] = useState('');
  const [comment, setComment] = useState('');
  const [uncertain, setUncertain] = useState(false);
  const [busy, setBusy] = useState(false);
  const [operation, setOperation] = useState({ label: '正在处理你的提交…', startedAt: Date.now() });
  const [notice, setNotice] = useState('');
  const [error, setError] = useState('');
  const [approving, setApproving] = useState(false);
  const [recoveryConfirm, setRecoveryConfirm] = useState(false);
  /** 深链接与所选 Run 一致，刷新恢复当前人工节点。 */
  function choose(value: string) {
    setNotice(''); setUncertain(false); setRecoveryConfirm(false); setId(value); setDocument(undefined); setAnswers({}); setSupplement(''); setComment(''); setError(''); setApproving(false);
    const url = new URL(location.href); value ? url.searchParams.set('run', value) : url.searchParams.delete('run'); history.replaceState(null, '', url);
  }
  /** 回读不重发用户决定，网络失败保留表单。 */
  async function refresh(value = id) {
    try {
      if (value) {
        const next = await request<Document>(`/${value}`);
        if (next.intake?.hash !== document?.intake?.hash || next.product?.artifact.hash !== document?.product?.artifact.hash || next.retry?.hash !== document?.retry?.hash) { setRecoveryConfirm(false); setAnswers({}); setSupplement(''); setApproving(false); setComment(''); }
        setDocument(next); setUncertain(false); setError(''); if (next.status !== document?.status) setNotice('已同步最新流程状态。');
      }
      setRuns((await request<{ runs: Document[] }>('')).runs);
    } catch (reason) { setError((reason as Error).message); }
  }
  // 切换记录时丢弃旧响应，不让其他 Run 覆盖当前表单。
  useEffect(() => {
    if (busy) return;
    let active = true;
    /** 载入当前页面状态。 */
    async function load() {
      try {
        const list = await request<{ runs: Document[] }>('');
        const current = id ? await request<Document>(`/${id}`) : undefined;
        if (active) { setRuns(list.runs); setDocument(current); }
      } catch (reason) { if (active) setError((reason as Error).message); }
    }
    void load();
    // 页面切换后忽略迟到响应。
    return () => { active = false; };
  }, [id]);
  // 已在服务端运行的记录可刷新恢复观察，不需要重复提交。
  useEffect(() => {
    if (busy || (!uncertain && document?.status !== 'running') || !id) return;
    let active = true; let reading = false;
    /** 一次只执行一个只读查询，终态或新暂停点会自然停止轮询。 */
    async function poll() {
      if (reading) return; reading = true;
      try { const next = await request<Document>(`/${id}`); if (active) { setDocument(next); setUncertain(false); setError(''); if (next.status !== document?.status) setNotice('已同步最新流程状态。'); if (next.status !== 'running') { setAnswers({}); setSupplement(''); setApproving(false); setRecoveryConfirm(false); if (next.status === 'failed') { setError(next.retry ? `${next.retry.title}未完成：${next.retry.reason}。可使用恢复入口继续。` : '后台执行已失败，请查看处理说明。'); setNotice(''); } else setNotice('已重新同步最新流程状态。'); } } }
      catch { /* 只读观察暂不可达时保留未知状态，下一轮继续回读。 */ }
      finally { reading = false; }
    }
    const timer = window.setInterval(poll, 5000);
    // 切换记录或离开运行态后取消观察。
    return () => { active = false; window.clearInterval(timer); };
  }, [busy, id, document?.status, uncertain]);
  /** 超时只代表连接结束；先回读状态，再决定展示运行、失败或输入错误。 */
  async function recoverResponse(runId: string, reason: unknown) {
    const result = await reconcileWrite(() => request<Document>(`/${runId}`));
    const advanced = result.document && (result.document.intake?.hash !== document?.intake?.hash || result.document.product?.artifact.hash !== document?.product?.artifact.hash || result.document.gate?.gateHash !== document?.gate?.gateHash);
    if (result.document) setDocument(result.document);
    setUncertain(result.uncertain);
    if (result.running || result.uncertain) {
      setError(''); setNotice(''); setOperation({ label: result.running ? '提交连接已超时，后台仍在运行，正在同步进度…' : '连接暂时中断，正在重新确认后台执行状态…', startedAt: operation.startedAt });
    } else if (result.failed) setError(result.document?.retry?.message ?? '后台执行已失败，请查看本页的失败原因和恢复入口。');
    else if (result.document?.status === 'success' || (result.document?.status === 'suspended' && advanced)) { setError(''); setAnswers({}); setSupplement(''); setApproving(false); setRecoveryConfirm(false); setNotice('已重新同步，流程已进入最新确认步骤。'); }
    else setError((reason as Error).message);
  }
  /** 创建前固定 UUID，即使响应丢失仍可按地址找回同一流程。 */
  async function start() {
    const runId = crypto.randomUUID(); choose(runId); setOperation({ label: '正在分析需求并生成方案…', startedAt: Date.now() }); setNotice(''); setBusy(true); setError('');
    try { const next = await request<Document>('', { runId, brief, iterationId }); setDocument(next); setRuns([next, ...runs]); }
    catch (reason) { await recoverResponse(runId, reason); }
    finally { setBusy(false); }
  }
  /** 仅在版本变化后清空回答，失败时保留当前输入用于检查。 */
  async function submit(body: unknown) {
    const action = (body as { action?: string; retryHash?: string }).action;
    setOperation({ label: (body as { clarifyHash?: string }).clarifyHash ? '正在整理待决问题、关联工程资料并准备选择卡片…' : (body as { retryHash?: string }).retryHash ? `正在从${document?.retry?.title ?? '已保存检查点'}恢复…` : action === 'refine' ? '正在根据你的回答完善方案…' : action === 'finalize' ? '正在生成完整产品需求稿…' : '正在保存决定并处理下一步…', startedAt: Date.now() }); setNotice('');
    setBusy(true); setError('');
    try {
      const next = await request<Document>(`/${id}/respond`, body);
      if (next.status === 'failed') setError(next.retry?.message ?? '后续生成未完成，请查看本页处理说明。'); else setNotice(next.gate?.key === 'confirm-blocker-answers' ? '待决问题已整理，请逐项选择或补充。' : next.gate?.key === 'review-revised-product' ? '已生成完整修订稿，请审阅确认。' : next.gate?.recoveryInfo ? '该阶段执行未完成，检查点已保留。请查看下面的处理指引。' : '本次决定已保存，请查看当前阶段与下一步。'); setDocument(next); window.scrollTo({ top: 0, behavior: 'smooth' }); setRuns(runs.map(/** 当前 Run 状态随已保存响应同步。 */run => run.runId === next.runId ? next : run)); setAnswers({}); setSupplement(''); setApproving(false); setRecoveryConfirm(false);
    } catch (reason) { await recoverResponse(id, reason); }
    finally { setBusy(false); }
  }
  /** 更新一个问题的显式选择，用户可以用补充文本覆盖或说明。 */
  function update(q: Question, selected: string[], custom: string) {
    setAnswers({ ...answers, [q.id]: { questionId: q.id, selected, custom } });
  }
  const intake = document?.intake;
  const questions = intake?.plan.questions ?? [];
  const complete = questions.every(/** 必答必须显式选择或填写，不读取推荐作为默认。 */q => !q.required || !!answers[q.id]?.selected.length || !!answers[q.id]?.custom.trim());
  /** 业务问题与当前 hash 一起提交，服务端重复执行相同校验。 */
  function respond(action: 'refine' | 'finalize') {
    void submit({ hash: intake!.hash, action, reviewer, answers: Object.values(answers), supplement });
  }
  /** 产品批准与业务回答分开提交，继续停在项目范围授权。 */
  function review(decision: 'approve' | 'reject') {
    void submit({ role: 'product', artifactHash: document!.product!.artifact.hash, decision, reviewer, comment });
  }
  return <div className="intake-shell">
    <aside className="intake-sidebar"><a className="intake-brand" href="/">◈ 产研工作台</a><p>从想法到可执行需求</p>
      <button disabled={busy || uncertain} onClick={/** 新建需求只重置本地页面。 */() => choose('')}>＋ 新需求</button>
      <h3>最近的主流程</h3>{runs.map(/** 历史列表只选择，不恢复审批。 */run => <button className={id === run.runId ? 'selected' : ''} key={run.runId} disabled={busy || uncertain} onClick={/** 打开保存的 Run。 */() => choose(run.runId)}>{run.brief.slice(0, 32) || run.runId}<small>{run.step === 'review-product' ? '等待产品确认' : run.step === 'guided-requirements' ? '等待需求回答' : run.step === 'confirm-project-scope' ? '等待项目授权' : run.blockage ? '开工条件未齐' : run.status === 'failed' ? '生成失败' : run.gate ? `待办：${run.gate.title}` : run.status === 'success' ? '本轮已结束' : '流程记录'}</small></button>)}
      <small>所有确认在此工作台完成</small>
    </aside>
    <main className="intake-main"><header><span>产研交付 · 业务流程</span><button disabled={busy} onClick={/** 刷新只回读事实。 */() => void refresh()}>刷新状态</button></header>
      <div className="intake-progress"><span className={intakeStage(document) === 0 ? 'active' : ''}>01 需求方案</span><span className={intakeStage(document) === 1 ? 'active' : ''}>02 产品确认</span><span className={intakeStage(document) === 2 ? 'active' : ''}>03 开发授权与实施</span><span className={intakeStage(document) === 3 ? 'active' : ''}>04 测试与发布</span></div>
      {error && <div role="alert" className="intake-error">{error}</div>}
      {busy && <p role="status">正在处理，请勿重复提交。完成后会自动展示下一步…</p>}
      {!id ? <section className="intake-card"><div className="intake-eyebrow">先描述问题，让方案逐步清晰</div><h1>你想解决什么问题？</h1><p>说明使用者、当前困难和期望结果。我们会先给出方案建议，再请你确认关键选择。</p>
        <label>需求描述<textarea value={brief} maxLength={12000} rows={8} placeholder="例如：招聘同事希望统一处理候选人初筛和面试邀约，目前靠表格记录，容易遗漏跟进…" onChange={/** 保留原始输入。 */e => setBrief(e.target.value)} /></label>
        <label>迭代标识<input value={iterationId} maxLength={100} onChange={/** 标识显式绑定本次主流程。 */e => setIterationId(e.target.value)} /></label>
        <button className="primary" disabled={busy || uncertain || !brief.trim() || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,99}$/.test(iterationId)} onClick={start}>分析需求，形成初步方案 →</button>
      </section> : <>
        <section className="intake-context"><small>原始需求 · {document?.mode === 'fixture' ? '固定样例，不理解业务输入' : document?.mode === 'live' ? '真实模型提案，待人工审核' : '正在载入'}</small><p>{document?.brief || brief}</p><code>{id}</code></section>
        {intake && <><section className="intake-card"><div className="intake-eyebrow">第 {intake.round} / 4 轮 · 方案建议</div><h1>先对齐方向，再完善需求</h1><Markdown>{intake.plan.summary}</Markdown>{intake.plan.assumptions.length > 0 && <div className="intake-assumptions"><strong>当前假设 · 尚未作为事实确认</strong>{intake.plan.assumptions.map(/** 假设与方案明确区分。 */(item, index) => <p key={index}>{item}</p>)}</div>}</section>
          <section className="intake-card">{intake.history.length > 0 && <details><summary>查看已提交的确认记录（{intake.history.length} 轮）</summary>{intake.history.map(/** 回答原样回读，选择标签来自对应历史方案。 */(entry, index) => <div className="intake-assumptions" key={index}><strong>第 {index + 1} 轮 · {entry.response.reviewer}</strong>{entry.response.answers.map(/** 用本轮选项解释已确认答案。 */answer => { const q = entry.plan.questions.find(/** 按历史 ID 查找问题。 */item => item.id === answer.questionId); return <p key={answer.questionId}>{q?.title}：{answer.selected.map(/** 展示历史选项标签。 */id => q?.options.find(/** 按 ID 关联标签。 */option => option.id === id)?.label ?? id).join('、')} {answer.custom}</p>; })}{entry.response.supplement && <p>补充：{entry.response.supplement}</p>}</div>)}</details>}<h2>需要你确认的选择</h2><p>推荐供参考。你可以选择其他方案，或填写自己的答案。</p>
          {questions.length === 0 && <p>当前没有新增关键问题。你仍可补充要求，或生成完整产品稿。</p>}
          {questions.map(/** 每个业务问题独立绑定稳定 ID。 */q => {
            const a = answers[q.id] ?? { questionId: q.id, selected: [], custom: '' };
            return <fieldset key={q.id}><legend>{q.title} <small>{q.required ? '必须确认' : '可选补充'}</small></legend><p>{q.reason}</p><div className="intake-recommendation">建议：{q.recommendation}</div>
              {q.options.map(/** 选项不预选，点击才形成用户输入。 */option => <label className="intake-option" key={option.id}><input type={q.kind === 'multiple' ? 'checkbox' : 'radio'} name={q.id} checked={a.selected.includes(option.id)} onChange={/** 多选按 ID 去重，单选替换前值。 */e => update(q, q.kind === 'multiple' ? (e.target.checked ? [...a.selected, option.id] : a.selected.filter(/** 移除取消项。 */item => item !== option.id)) : [option.id], a.custom)} />{option.label}</label>)}
              <label>{q.kind === 'text' ? '你的回答' : '其他方案或补充说明'}<textarea rows={2} maxLength={4000} value={a.custom} onChange={/** 自由文本作为显式答案。 */e => update(q, a.selected, e.target.value)} /></label>
            </fieldset>;
          })}
          <label>其他补充<textarea value={supplement} maxLength={4000} onChange={/** 补充与当前问题回答一并保存。 */e => setSupplement(e.target.value)} /></label>
          <label>确认人（本地标签）<input value={reviewer} maxLength={100} onChange={/** 标签不暗示认证身份。 */e => setReviewer(e.target.value)} /></label>
          <div className="intake-actions"><button disabled={busy || uncertain || !complete || !reviewer.trim() || intake.round >= 4} onClick={/** 回答后重新形成方案，仍须确认。 */() => respond('refine')}>{busy ? '处理中…' : '回答并完善方案'}</button><button className="primary" disabled={busy || uncertain || !complete || !reviewer.trim()} onClick={/** 显式结束澄清，进入完整稿生成。 */() => respond('finalize')}>{busy ? '处理中，请稍候…' : '按当前回答生成完整产品稿 →'}</button></div>
          {!busy && !complete && <p className="intake-validation" role="status">还有 {questions.filter(/** 只统计未显式回答的必答项。 */q => q.required && !answers[q.id]?.selected.length && !answers[q.id]?.custom.trim()).length} 个必答问题未完成，请补齐后提交。</p>}
          {!busy && complete && !reviewer.trim() && <p className="intake-validation">请填写确认人后提交。</p>}
          {!busy && intake.round >= 4 && <p className="intake-validation">本轮已达方案完善上限，补齐回答后可生成完整产品稿。</p>}
          </section></>}
        {document?.product && <section className="intake-card"><div className="intake-eyebrow">完整产品稿 · 待确认</div><h1>审核这份产品需求</h1><Markdown>{document.product.artifact.content}</Markdown><details><summary>版本标识</summary><code>{document.product.artifact.hash}</code></details>
          <label>审阅人<input value={reviewer} maxLength={100} onChange={/** 产品审阅单独记录操作者。 */e => setReviewer(e.target.value)} /></label><label>审阅意见<textarea value={comment} maxLength={2000} onChange={/** 明确记录产品决定依据。 */e => setComment(e.target.value)} /></label>
          {approving ? <div className="intake-assumptions"><p>确认当前版本后，本页将展示项目文件与可写范围授权。实施前仍需确认开发方案。</p><button className="primary" disabled={busy || uncertain} onClick={/** 二次确认只批准当前 hash。 */() => review('approve')}>确认产品版本并继续</button><button disabled={busy || uncertain} onClick={/** 取消不推进。 */() => setApproving(false)}>取消</button></div> : <div className="intake-actions"><button disabled={busy || uncertain || !reviewer.trim() || !comment.trim()} onClick={/** 终止只作用当前产品轮次。 */() => review('reject')}>拒绝并结束</button><button className="primary" disabled={busy || uncertain || !reviewer.trim() || !comment.trim()} onClick={/** 先展示下一步影响。 */() => setApproving(true)}>确认产品稿 →</button></div>}
        </section>}
        {document?.blockage && <section className="intake-card"><div className="intake-eyebrow">{document.blockage.phase} · 已返回方案，尚未开工</div><h1>{document.blockage.title}</h1><p>真实模型已生成 {document.blockage.taskCount} 项开发任务。以下事项仍阻止开工，本次没有进入代码实施；这不是模型超时，不需要原样重复重试。</p><Markdown>{document.blockage.summary}</Markdown><h2>接下来需要处理什么？</h2><p>先补齐产品稿中的业务选择；工程资料缺口由开发侧核对。补齐后再继续方案规划和确认，不应把这些未决项直接当作已批准规则。</p>{document.clarify && <button className="primary" disabled={busy || uncertain} onClick={/** 在原Run创建原生澄清暂停点，不选择答案或自动批准。 */() => void submit({ clarifyHash: document.clarify!.hash })}>{busy ? '正在准备选择卡片…' : '补齐业务选择，修订产品稿 →'}</button>}<details open><summary>查看具体阻塞事项（{document.blockage.blockers.length}）</summary><ul>{document.blockage.blockers.map(/** 阻塞依据来自模型已保存的实际方案，不代替用户作决定。 */(item, index) => <li key={index}><p>{item}</p></li>)}</ul></details><details><summary>查看已确认产品稿及其待决项</summary><Markdown>{document.blockage.productContent}</Markdown></details></section>}
        {document?.progress && !document.gate && <section className="intake-card" role="status"><div className="intake-eyebrow">当前阶段 · {document.progress.phase}</div><h1>{document.progress.title}</h1><p>{document.progress.detail}</p><p>{document.progress.next}</p>{!!document.progress.attemptDetails?.length && <details><summary>查看模型调用诊断</summary>{document.progress.attemptDetails.map(/** 后端仅返回经过白名单校验的来源和计时。 */(detail, index) => <p key={index}>{detail}</p>)}</details>}</section>}
        {document?.gate?.key === 'confirm-project-scope' ? <RepositoryScope key={document.gate.gateHash} gateHash={document.gate.gateHash} busy={busy || uncertain} submit={submit} /> : document?.gate && <WorkflowGateForm key={document.gate.gateHash} gate={document.gate} busy={busy || uncertain} submit={submit} />}
        {document && !intake && !document.product && !document.gate && !document.blockage && (!document.progress || document.retry) && <section className="intake-card"><h2>{busy || uncertain ? operation.label : document.retry ? '继续当前需求' : document.status === 'failed' ? '流程遇到问题' : document.status === 'success' ? '本轮流程已结束' : '流程正在处理'}</h2><p>{busy || uncertain ? '正在处理已保存的信息，完成后会自动更新本页，无需重新填写。' : document.status === 'failed' ? document.retry?.message ?? '已保存的记录仍可查看。当前失败不支持直接恢复，请核对结果后处理。' : document.status === 'success' ? ({'fixture-completed':'固定样例流程已走完，所有执行与回执均为合成验证。','delivery-confirmed':'本轮交付已确认，执行证据与人工决定已保存。','rejected':'本轮已拒绝并结束。','blocked':'本轮已停止，仍有需要处理的阻塞。','rolled-back':'本轮发布已回滚。','manual-attention':'本轮需要人工处理。'}[document.outcome ?? ''] ?? '已保存本轮结果与决定。') : '请刷新查看进展，后续需要你确认的内容会在本页显示。'}</p>{document.retry && <div className="recovery-panel"><h3>从已保存检查点继续</h3><p><strong>失败节点：</strong>{document.retry.title} · {document.retry.reason}</p><p>已保存 {document.retry.savedAnswers} 轮回答。</p>{document.retry.preserved.length > 0 && <><strong>以下工作保持原样：</strong><ul>{document.retry.preserved.map(/** 恢复前明确展示实际完成的前序角色。 */item => <li key={item.role}>{item.label} · 已完成</li>)}</ul></>}<p>{document.retry.impact}</p>{recoveryConfirm ? <div className="intake-assumptions"><strong>确认从“{document.retry.title}”继续？</strong><p>会继续当前需求执行，不重新填写需求；模型调用可能产生费用。</p><button className="primary" disabled={busy || uncertain} onClick={/** 路径和输入由服务端快照决定，客户端只提交版本令牌。 */() => void submit({ retryHash: document.retry!.hash })}>{busy ? '正在恢复…' : '确认恢复并继续'}</button><button disabled={busy || uncertain} onClick={/** 返回检查不改变原生快照。 */() => setRecoveryConfirm(false)}>返回检查</button></div> : <button className="primary" disabled={busy || uncertain} onClick={/** 恢复前先展示检查点与执行影响。 */() => setRecoveryConfirm(true)}>从{document.retry.title}继续 →</button>}</div>}</section>}
      </>}
    </main>
    <OperationFeedback busy={busy || uncertain || document?.status === 'running'} label={busy || uncertain || operation.label.includes('超时') ? operation.label : document?.progress?.title ?? '后台流程仍在处理，正在自动同步最新结果…'} startedAt={operation.startedAt} error={error} notice={notice} dismiss={/** 关闭反馈不丢弃表单或重新提交。 */() => { setError(''); setNotice(''); }} />
  </div>;
}
