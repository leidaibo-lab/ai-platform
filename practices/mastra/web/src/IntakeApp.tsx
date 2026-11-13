import { ExecutionStatus, type ExecutionView, type ExecutionSettings } from './ExecutionStatus';
import { intakeRequest as request, reconcileWrite } from './intake-request';
import { RepositoryScope } from './RepositoryScope';
import { OperationFeedback } from './OperationFeedback';
import { useEffect, useState } from 'react';
import { WorkflowGateForm, type WorkflowGate } from './WorkflowGate';
import { Markdown } from './components/Markdown';
import { ClarificationProgress, RequirementWorkspace } from './components/RequirementWorkspace';
import { RemoteSyncSettings } from './RemoteSyncSettings';
import { RepositoryManagement } from './RepositoryManagement';
import { QuestionFlow, type ClarificationQuestion as Question, type ClarificationAnswer as Answer } from './components/QuestionFlow';
import { RoleWorkbench } from './RoleWorkbench';
import { DiagnosticTrace } from './DiagnosticTrace';
import './intake.css';
interface Document { diagnostics?: { enabled: boolean; items: { id: string; status: 'completed' | 'running' | 'waiting' | 'failed'; phase: string; role: string; summary: string; evidence: string[]; nextAction?: string; tools?: { name: string; inputHash?: string; returned?: boolean; repeated?: boolean; callCount?: number }[] }[] }; execution?: ExecutionView; executionSettings?: ExecutionSettings; developmentStop?: { reason: string; rounds: number; calls: number; checkRuns: number; latestChecks?: { id: string; command: string; exitCode: number | null; stderr: string; stdout: string }[] }; delivery?: { branch?: string; candidateCommit?: string; candidateStatus?: 'candidate' | 'quality-attested'; qualityHash?: string | null; releaseHash?: string | null; releaseStatus?: string; healthPassed?: boolean; pullRequest?: { url: string; status: string; mergeCommit: string; targetBranchHead: string; approvedBy: string } | null }; reconfigure?: { hash: string }; clarify?: { hash: string; title: string }; blockage?: { preparationRequired?: boolean; phase: string; title: string; summary: string; blockers: string[]; taskCount: number; productContent: string }; progress?: { attemptDetails?: string[]; phase: string; title: string; detail: string; next: string }; retry?: { attemptDetails?: string[]; next?: string; syncOnly?: boolean; hash: string; message: string; savedAnswers: number; title: string; step: string; reason: string; impact: string; preserved: {label: string; role: string; complete?: boolean}[] }; outcome?: string; gate?: WorkflowGate; runId: string; status: string; mode?: string; brief: string; step?: string; intake?: { round: number; hash: string; plan: { maturity?: Record<string, { clear: boolean; evidence: string }>; summary: string; assumptions: string[]; questions: Question[] }; history: { plan: { questions: Question[] }; response: { reviewer: string; supplement: string; answers: Answer[] } }[] }; product?: { artifact: { content: string; hash: string } } }

interface AnalysisProgressProps { operation: { label: string; startedAt: number }; uncertain: boolean; document?: Document }

/** 展示可验证的高层执行进度；不把模型内部思维链伪装成前端事实。 */
function AnalysisProgress({ operation, uncertain, document }: AnalysisProgressProps) {
  const [now, setNow] = useState(Date.now());
  /** 每秒刷新经过时间，帮助用户判断后台是否仍在处理。 */
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [operation.startedAt]);
  const elapsed = Math.max(0, Math.floor((now - operation.startedAt) / 1000));
  const execution = document?.execution;
  const activeDiagnostic = document?.diagnostics?.items.find(item => item.status === 'running');
  const current = activeDiagnostic?.phase ?? document?.progress?.phase ?? (operation.label.includes('产品稿') ? '产品需求稿生成' : operation.label.includes('完善方案') ? '方案修订' : '需求分析与方案生成');
  const steps = [
    { label: '读取需求', detail: '整理用户输入与迭代标识' },
    { label: '分析上下文', detail: '核对项目资料、角色和方法约束' },
    { label: '生成方案', detail: '形成摘要、假设与待确认问题' },
    { label: '检查结果', detail: '保存证据并准备下一个人工节点' },
  ];
  const stepIndex = current.includes('产品') || current.includes('修订') ? 2 : current.includes('检查') || document?.progress ? 3 : elapsed > 3 ? 1 : 0;
  return <section className="analysis-progress intake-card" aria-label="分析过程" role="status">
    <div className="analysis-progress-heading"><div><div className="intake-eyebrow">可观察执行进度</div><h2>{uncertain ? '连接暂时中断，正在确认后台进度' : '正在分析需求并生成方案…'}</h2></div><span>{elapsed}s</span></div>
    <p className="analysis-progress-current"><strong>当前阶段：</strong>{current}{execution ? ` · 第 ${execution.attempt} 次尝试` : ''}</p>
    <div className="analysis-progress-steps">{steps.map(/** 渲染一个可观察阶段及其完成状态。 */(step, index) => <div className={`analysis-progress-step ${index < stepIndex ? 'done' : ''} ${index === stepIndex ? 'current' : ''}`} key={step.label}><span className="analysis-progress-marker">{index < stepIndex ? '✓' : index + 1}</span><div><strong>{step.label}</strong><small>{step.detail}</small></div></div>)}</div>
    <p className="analysis-progress-note">页面展示阶段、工具调用和结果证据；模型的私有逐字推理不会直接展示。{activeDiagnostic?.summary ? ` 当前摘要：${activeDiagnostic.summary}` : ' 服务端结果返回后会补充真实执行记录。'}</p>
  </section>;
}
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

/** 将人工关口以内嵌节点卡呈现在主流程中，处理动作仍由下方原生表单提交。 */
function InlineDecisionCard({ document, questions, answers, busy, onOpen }: { document?: Document; questions: Question[]; answers: Record<string, Answer>; busy: boolean; onOpen: () => void }) {
  const gateTitle = document?.gate?.title;
  const intakeTitle = document?.intake ? '请确认这轮关键业务选择' : gateTitle || '当前节点需要你的确认';
  const answered = questions.filter(question => answers[question.id]?.selected.length || answers[question.id]?.custom.trim()).length;
  const missing = questions.filter(question => question.required && !answers[question.id]?.selected.length && !answers[question.id]?.custom.trim()).length;
  const detail = document?.intake
    ? `已回答 ${answered} / ${questions.length}，还有 ${missing} 个必答项待补充。`
    : document?.gate
      ? '流程已暂停在人工关口，确认后才会进入下一步。'
      : '流程会在这里展示需要你决定的内容。';
  return (
    <section className="inline-decision-card" aria-live="polite">
      <div className="inline-decision-marker"><span /> 人机协作节点</div>
      <div className="inline-decision-content">
        <strong>{intakeTitle}</strong>
        <p>{detail}</p>
        <small>{document?.gate?.key ? `当前关口：${document.gate.key}` : '推荐方案仅供参考，提交后才会形成确认记录。'}</small>
      </div>
      <button type="button" className="primary" disabled={busy} onClick={onOpen}>{busy ? '处理中…' : '在这里处理 →'}</button>
    </section>
  );
}

/** 主流程需求入口；只有未提交表单属于 React，所有已确认内容来自快照。 */
export function IntakeApp() {
  const [view, setView] = useState(new URLSearchParams(location.search).get('view') === 'roles' ? 'roles' : 'runs');
  const [id, setId] = useState(new URLSearchParams(location.search).get('run') ?? '');
  const [document, setDocument] = useState<Document>();
  const [runs, setRuns] = useState<Document[]>([]);
  const [brief, setBrief] = useState('');
  const [iterationId, setIterationId] = useState('unassigned');
  const [answers, setAnswers] = useState<Record<string, Answer>>({});
  const [activeQuestion, setActiveQuestion] = useState('');
  const [reviewer, setReviewer] = useState('');
  const [supplement, setSupplement] = useState('');
  const [comment, setComment] = useState('');
  const [uncertain, setUncertain] = useState(false);
  const [cancelBusy, setCancelBusy] = useState(false);
  const [busy, setBusy] = useState(false);
  const [operation, setOperation] = useState({ label: '正在处理你的提交…', startedAt: Date.now() });
  const [notice, setNotice] = useState('');
  const [error, setError] = useState('');
  const [approving, setApproving] = useState(false);
  const [recoveryConfirm, setRecoveryConfirm] = useState(false);
  const [showSyncSettings, setShowSyncSettings] = useState(false);
  const [showRepositoryManagement, setShowRepositoryManagement] = useState(false);
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
    if (!id || (!busy && !uncertain && document?.status !== 'running' && (!document?.execution || document.execution.settled))) return;
    let active = true; let reading = false;
    /** 一次只执行一个只读查询，终态或新暂停点会自然停止轮询。 */
    async function poll() {
      if (reading) return; reading = true;
      try { const next = await request<Document>(`/${id}`); if (active) { setDocument(next); setUncertain(false); setError(''); if (next.status !== document?.status) setNotice('已同步最新流程状态。'); if (next.status !== 'running') { setAnswers({}); setSupplement(''); setApproving(false); setRecoveryConfirm(false); if (next.status === 'failed') { setError(next.retry ? `${next.retry.title}未完成：${next.retry.reason}。可使用恢复入口继续。` : '后台执行已失败，请查看处理说明。'); setNotice(''); } else setNotice('已重新同步最新流程状态。'); } } }
      catch { if (active) { setUncertain(true); setError('状态查询暂不可达，后台执行状态未知。正在继续回读，请勿重新提交。'); } }
      finally { reading = false; }
    }
    const timer = window.setInterval(poll, 5000);
    // 切换记录或离开运行态后取消观察。
    return () => { active = false; window.clearInterval(timer); };
  }, [busy, id, document?.status, document?.execution?.settled, uncertain]);
  /** 取消不复用提交busy锁，后台长请求期间也可操作。 */
  async function cancelCurrent(token: string) {
    setCancelBusy(true); setError('');
    try { setDocument(await request<Document>(`/${id}/cancel`, { token })); setNotice('取消请求已发送，正在确认本地调用退出。'); }
    catch { setUncertain(true); setError('取消尚未确认，正在回读后台状态。请勿重新提交。'); }
    finally { setCancelBusy(false); }
  }
  /** 超时只代表连接结束；先回读状态，再决定展示运行、失败或输入错误。 */
  async function recoverResponse(runId: string, reason: unknown) {
    const result = await reconcileWrite(/** 仅回读原Run，不重发写入。 */() => request<Document>(`/${runId}`));
    const advanced = result.document && (result.document.intake?.hash !== document?.intake?.hash || result.document.product?.artifact.hash !== document?.product?.artifact.hash || result.document.gate?.gateHash !== document?.gate?.gateHash);
    if (result.document) setDocument(result.document);
    setUncertain(result.uncertain);
    if (result.running || result.uncertain) {
      setError(''); setNotice(''); setOperation({ label: result.running ? '提交连接已超时，后台仍在运行，正在同步进度…' : '连接暂时中断，正在重新确认后台执行状态…', startedAt: operation.startedAt });
    } else if (result.failed) setError(result.document?.retry ? `${result.document.retry.title}未完成：${result.document.retry.reason}。请查看本页的失败证据与恢复入口。` : '后台执行已失败，请查看本页的失败原因和恢复入口。');
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
    setOperation({ label: (body as { clarifyHash?: string }).clarifyHash ? '正在整理待决问题、关联工程资料并准备选择卡片…' : (body as { retryHash?: string }).retryHash ? `正在从${document?.retry?.title ?? '已保存检查点'}恢复…` : action === 'refine' ? '正在根据你的回答完善方案…' : action === 'finalize' ? '正在检查业务缺口，满足条件后生成产品需求稿…' : '正在保存决定并处理下一步…', startedAt: Date.now() }); setNotice('');
    setBusy(true); setError('');
    try {
      const next = await request<Document>(`/${id}/respond`, body);
      if (next.status === 'canceled') setNotice(next.execution?.settled ? '本轮流程已取消，本地生成调用已退出。' : '本轮流程已取消，正在等待本地生成调用退出。'); else if (next.status === 'failed') setError(next.retry ? `${next.retry.title}未完成：${next.retry.reason}。请查看本页的失败证据与恢复入口。` : '后续生成未完成，请查看本页处理说明。'); else setNotice(next.gate?.key === 'confirm-blocker-answers' ? '待决问题已整理，请逐项选择或补充。' : next.gate?.key === 'review-revised-product' ? '已生成完整修订稿，请审阅确认。' : next.gate?.recoveryInfo ? '该阶段执行未完成，检查点已保留。请查看下面的处理指引。' : '本次决定已保存，请查看当前阶段与下一步。'); setDocument(next); window.scrollTo({ top: 0, behavior: 'smooth' }); setRuns(runs.map(/** 当前 Run 状态随已保存响应同步。 */run => run.runId === next.runId ? next : run)); setAnswers({}); setSupplement(''); setApproving(false); setRecoveryConfirm(false);
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
  /** 把主流程视线移到当前内嵌卡对应的真实表单，不创建第二份状态。 */
  function openInlineDecision() {
    globalThis.document.querySelector('.requirement-panel')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }
  /** 业务问题与当前 hash 一起提交，服务端重复执行相同校验。 */
  function respond(action: 'refine' | 'finalize') {
    void submit({ hash: intake!.hash, action, reviewer, answers: Object.values(answers), supplement });
  }
  /** 产品批准与业务回答分开提交，继续停在项目范围授权。 */
  function review(decision: 'approve' | 'reject') {
    void submit({ role: 'product', artifactHash: document!.product!.artifact.hash, decision, reviewer, comment });
  }
  /** 角色资源是跨Run的控制面入口，切换不修改当前流程事实。 */
  function openRoleWorkbench() {
    const url = new URL(location.href); url.searchParams.set('view', 'roles'); history.replaceState(null, '', url); setView('roles');
  }
  /** 返回Run工作台时仅移除视图参数，保留当前选中的Run深链接。 */
  function openRunWorkbench() {
    const url = new URL(location.href); url.searchParams.delete('view'); history.replaceState(null, '', url); setView('runs');
  }
  if (showRepositoryManagement) return <RepositoryManagement close={/** 返回同一需求页面，不改变当前Run选择。 */() => setShowRepositoryManagement(false)} />;
  if (showSyncSettings) return <RemoteSyncSettings close={/** 返回同一需求页面，不改变当前Run选择。 */() => setShowSyncSettings(false)} />;
  if (view === 'roles') return <div className="intake-shell intake-workbench"><aside className="intake-sidebar"><a className="intake-brand" href="/">◈ 产研工作台</a><p>角色资源受控发布</p><small>角色版本是跨Run控制面；既有Run仍使用首步冻结的版本。</small></aside><RoleWorkbench close={openRunWorkbench} /></div>;
  return <div className="intake-shell intake-workbench">
    <aside className="intake-sidebar"><a className="intake-brand" href="/">◈ 产研工作台</a><p>从想法到可执行需求</p>
      <button disabled={busy || uncertain} onClick={/** 新建需求只重置本地页面。 */() => choose('')}>＋ 新需求</button>
      <h3>最近的主流程</h3>{runs.map(/** 历史列表只选择，不恢复审批。 */run => <button className={id === run.runId ? 'selected' : ''} key={run.runId} disabled={busy || uncertain} onClick={/** 打开保存的 Run。 */() => choose(run.runId)}>{run.brief.slice(0, 32) || run.runId}<small>{run.step === 'review-product' ? '等待产品确认' : run.step === 'guided-requirements' ? '等待需求回答' : run.step === 'confirm-project-scope' ? '等待项目授权' : run.blockage ? '开工条件未齐' : run.status === 'canceled' ? '已取消' : run.status === 'failed' ? '生成失败' : run.gate ? `待办：${run.gate.title}` : run.status === 'success' ? '本轮已结束' : '流程记录'}</small></button>)}
      <small>所有确认在此工作台完成</small>
    </aside>
    <main className="intake-main"><header><span>产研交付 · 业务流程</span><div className="intake-actions"><button disabled={busy || uncertain} onClick={openRoleWorkbench}>角色资源管理</button><button disabled={busy} onClick={/** 管理仓库字典不改变当前Run。 */() => setShowRepositoryManagement(true)}>项目仓库管理</button><button disabled={busy} onClick={/** 设置只影响后续同步节点。 */() => setShowSyncSettings(true)}>远端同步设置</button><button disabled={busy} onClick={/** 刷新只回读事实。 */() => void refresh()}>刷新状态</button></div></header>
      <div className="intake-progress"><span className={intakeStage(document) === 0 ? 'active' : ''}>01 需求方案</span><span className={intakeStage(document) === 1 ? 'active' : ''}>02 产品确认</span><span className={intakeStage(document) === 2 ? 'active' : ''}>03 开发授权与实施</span><span className={intakeStage(document) === 3 ? 'active' : ''}>04 测试与发布</span></div>
      {error && <div role="alert" className="intake-error">{error}</div>}
      {(busy || uncertain || document?.status === 'running') && <AnalysisProgress operation={operation} uncertain={uncertain} document={document} />}
      {busy && <p role="status">提交请求处理中；下方独立同步后台状态，请勿重复提交。</p>}
      {document && (intake || document.gate) && !busy && <InlineDecisionCard document={document} questions={questions} answers={answers} busy={busy || uncertain} onOpen={openInlineDecision} />}
      {!id ? <section className="intake-card"><div className="intake-eyebrow">先描述问题，让方案逐步清晰</div><h1>你想解决什么问题？</h1><p>说明使用者、当前困难和期望结果。我们会先给出方案建议，再请你确认关键选择。</p>
        <label>需求描述<textarea value={brief} maxLength={12000} rows={8} placeholder="例如：招聘同事希望统一处理候选人初筛和面试邀约，目前靠表格记录，容易遗漏跟进…" onChange={/** 保留原始输入。 */e => setBrief(e.target.value)} /></label>
        <label>迭代标识<input value={iterationId} maxLength={100} onChange={/** 标识显式绑定本次主流程。 */e => setIterationId(e.target.value)} /></label>
        <button className="primary" disabled={busy || uncertain || !brief.trim() || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,99}$/.test(iterationId)} onClick={start}>分析需求，形成初步方案 →</button>
      </section> : <>
        <section className="intake-context"><details><summary>原始需求 · {document?.mode === 'fixture' ? '固定样例，不理解业务输入' : document?.mode === 'live' ? '真实模型提案，待人工审核' : '正在载入'}</summary><p>{document?.brief || brief}</p><code>{id}</code></details></section>
        {document && <ExecutionStatus execution={document.execution} settings={document.executionSettings} status={document.status} cancel={cancelCurrent} cancelBusy={cancelBusy} />}
        {document && <DiagnosticTrace trace={document.diagnostics} />}
        {intake && <RequirementWorkspace title="澄清待确认项" panel={<fieldset className="requirement-inputs" disabled={busy || uncertain}><legend className="sr-only">本轮问题与补充</legend>
<QuestionFlow key={intake.hash} questions={questions} answers={answers} activeId={activeQuestion} onSelect={setActiveQuestion} onChange={update} disabled={busy || uncertain} prefix="intake-question" />
          <label>其他补充<textarea value={supplement} maxLength={4000} onChange={/** 补充与当前问题回答一并保存。 */e => setSupplement(e.target.value)} /></label>
          </fieldset>} actions={<>
          <label>确认人（本地标签）<input value={reviewer} maxLength={100} onChange={/** 标签不暗示认证身份。 */e => setReviewer(e.target.value)} /></label>
          <div className="intake-actions"><button disabled={busy || uncertain || !complete || !reviewer.trim()} onClick={/** 回答后重新形成方案，仍须确认。 */() => respond('refine')}>{busy ? '处理中…' : '回答并完善方案'}</button><button className="primary" disabled={busy || uncertain || !complete || !reviewer.trim()} onClick={/** 显式结束澄清，进入完整稿生成。 */() => respond('finalize')}>{busy ? '处理中，请稍候…' : '检查缺口，满足条件后生成产品稿 →'}</button></div>
          {!busy && !complete && <p className="intake-validation" role="status">还有 {questions.filter(/** 只统计未显式回答的必答项。 */q => q.required && !answers[q.id]?.selected.length && !answers[q.id]?.custom.trim()).length} 个必答问题未完成，请补齐后提交。</p>}
          {!busy && complete && !reviewer.trim() && <p className="intake-validation">请填写确认人后提交。</p>}
          </>}>
          <ClarificationProgress questions={questions} answers={answers} prefix="intake-question" onSelect={setActiveQuestion} />
          <p>本轮答完仍需检查业务缺口，有缺口会继续澄清。可随时离开，已提交记录保留；未提交输入请先提交保存。缩小范围须由你明确确认。</p>
          {intake.plan.maturity && <section className="intake-card"><h2>本轮业务检查</h2>{Object.entries(intake.plan.maturity).map(/** 模型判断与人工确认分开展示。 */([key, item]) => <p key={key}><strong>{{ decisions: '关键业务决策', mainFlow: '主流程', exceptions: '异常处理', delivery: '交付影响' }[key] ?? key}：{item.clear ? '模型评估已明确，待你核对' : '仍有缺口'}</strong> · {item.evidence}</p>)}</section>}
          <section className="intake-card"><div className="intake-eyebrow">第 {intake.round} 轮 · 方案建议</div><h1>先对齐方向，再完善需求</h1><Markdown>{intake.plan.summary}</Markdown>{intake.plan.assumptions.length > 0 && <div className="intake-assumptions"><strong>当前假设 · 尚未作为事实确认</strong>{intake.plan.assumptions.map(/** 假设与方案明确区分。 */(item, index) => <p key={index}>{item}</p>)}</div>}</section>
          {intake.history.length > 0 && <section className="intake-card"><details><summary>查看已提交的确认记录（{intake.history.length} 轮）</summary>{intake.history.map(/** 回答原样回读，选择标签来自对应历史方案。 */(entry, index) => <div className="intake-assumptions" key={index}><strong>第 {index + 1} 轮 · {entry.response.reviewer}</strong>{entry.response.answers.map(/** 用本轮选项解释已确认答案。 */answer => { const q = entry.plan.questions.find(/** 按历史 ID 查找问题。 */item => item.id === answer.questionId); return <p key={answer.questionId}>{q?.title}：{answer.selected.map(/** 展示历史选项标签。 */id => q?.options.find(/** 按 ID 查找本轮选项。 */option => option.id === id)?.label ?? id).join('、')} {answer.custom}</p>; })}{entry.response.supplement && <p>补充：{entry.response.supplement}</p>}</div>)}</details></section>}
        </RequirementWorkspace>}
        {document?.product && <RequirementWorkspace title="审核与确认产品稿" panel={<><p>对照左侧正文核对需求，在这里填写审阅意见。确认只作用于当前产品版本。</p>
          <label>审阅人<input value={reviewer} maxLength={100} onChange={/** 产品审阅单独记录操作者。 */e => setReviewer(e.target.value)} /></label><label>审阅意见<textarea value={comment} maxLength={2000} onChange={/** 明确记录产品决定依据。 */e => setComment(e.target.value)} /></label>
        </>} actions={<>
          {approving ? <div className="intake-assumptions"><p>确认当前版本后，本页将展示项目文件与可写范围授权。实施前仍需确认开发方案。</p><button className="primary" disabled={busy || uncertain} onClick={/** 二次确认只批准当前 hash。 */() => review('approve')}>确认产品版本并继续</button><button disabled={busy || uncertain} onClick={/** 取消不推进。 */() => setApproving(false)}>取消</button></div> : <div className="intake-actions"><button disabled={busy || uncertain || !reviewer.trim() || !comment.trim()} onClick={/** 终止只作用当前产品轮次。 */() => review('reject')}>拒绝并结束</button><button className="primary" disabled={busy || uncertain || !reviewer.trim() || !comment.trim()} onClick={/** 先展示下一步影响。 */() => setApproving(true)}>确认产品稿 →</button></div>}
        </>}>
          <section className="intake-card requirement-completeness"><div className="intake-eyebrow">当前成果状态</div><h2>完整产品稿已生成，等待审阅</h2><p>请逐项核对业务规则、待决事项和验收条件；确认当前版本不会自动授权开发实施。</p></section>
          <section className="intake-card"><div className="intake-eyebrow">完整产品稿 · 待确认</div><h1>审核这份产品需求</h1><Markdown>{document.product.artifact.content}</Markdown><details><summary>版本标识</summary><code>{document.product.artifact.hash}</code></details>
</section>
        </RequirementWorkspace>}
        {document?.developmentStop && <section className="intake-card"><h2>自主开发需要处理</h2><p>{{'business-decision':'实现过程中发现需要新增业务决定。请先明确该规则与验收预期。','authorization-required':'当前任务需要扩大授权，或发现权限与证据完整性问题。请核对已保存候选与范围。','repair-budget':'已达到批准的返工轮数上限。','verification-budget':'已达到分配的登记检查执行上限。','no-progress':'相同失败连续出现，已达到批准的无进展上限。'}[document.developmentStop.reason] ?? document.developmentStop.reason}</p><p>已返工 {document.developmentStop.rounds} 轮 · 模型调用 {document.developmentStop.calls} 次 · 登记检查执行 {document.developmentStop.checkRuns} 次。候选与证据已保存。</p>{document.developmentStop.latestChecks?.map(/** 只显示服务端已脱敏的实际检查，不提供命令输入。 */check => <details key={check.id}><summary>{check.id} · 退出码 {check.exitCode ?? '未知'}</summary><pre>{check.command}<br />{check.stderr || check.stdout}</pre></details>)}</section>}
        {document?.blockage && <section className="intake-card"><div className="intake-eyebrow">{document.blockage.phase} · 已返回方案，尚未开工</div><h1>{document.blockage.title}</h1><p>已保存开发方案，包含 {document.blockage.taskCount} 项任务。以下事项仍阻止开工，本次没有进入代码实施。</p><Markdown>{document.blockage.summary}</Markdown><h2>接下来需要处理什么？</h2><p>{document.blockage.preparationRequired ? '当前项目尚未具备实施与验证条件。开发侧需要先按方案完成工程准备，再点击下方入口重新确认项目；产品需求和本次方案已保存，工程缺口不需要通过修改产品稿解决。' : '先补齐产品稿中的业务选择；工程资料缺口由开发侧核对。补齐后再继续方案规划和确认，不应把这些未决项直接当作已批准规则。'}</p>{document.reconfigure && <button className="primary" disabled={busy || uncertain} onClick={/** 返回项目确认关口重新检查工程环境，不重做产品生成或自动批准。 */() => void submit({ reconfigureHash: document.reconfigure!.hash })}>重新检查项目，继续交接 →</button>}{document.clarify && <button className="primary" disabled={busy || uncertain} onClick={/** 在原Run创建原生澄清暂停点，不选择答案或自动批准。 */() => void submit({ clarifyHash: document.clarify!.hash })}>{busy ? '正在准备选择卡片…' : '补齐业务选择，修订产品稿 →'}</button>}<details open><summary>查看具体阻塞事项（{document.blockage.blockers.length}）</summary><ul>{document.blockage.blockers.map(/** 阻塞依据来自模型已保存的实际方案，不代替用户作决定。 */(item, index) => <li key={index}><p>{item}</p></li>)}</ul></details><details><summary>查看已确认产品稿及其待决项</summary><Markdown>{document.blockage.productContent}</Markdown></details></section>}
        {document?.progress && !document.gate && <section className="intake-card" role="status"><div className="intake-eyebrow">当前阶段 · {document.progress.phase}</div><h1>{document.progress.title}</h1><p>{document.progress.detail}</p><p>{document.progress.next}</p>{!!document.progress.attemptDetails?.length && <details><summary>查看模型调用诊断</summary>{document.progress.attemptDetails.map(/** 后端仅返回经过白名单校验的来源和计时。 */(detail, index) => <p key={index}>{detail}</p>)}</details>}</section>}
        {document?.delivery?.branch && <section className="intake-card"><div className="intake-eyebrow">交付版本</div><h2>Run 分支与质量状态</h2><p><strong>分支：</strong>{document.delivery.branch}</p><p><strong>候选 Commit：</strong>{document.delivery.candidateCommit}</p><p><strong>候选状态：</strong>{document.delivery.candidateStatus === 'quality-attested' ? '已绑定独立测试质量回执' : '待独立测试'}</p>{document.delivery.qualityHash && <p><strong>质量版本：</strong>{document.delivery.qualityHash}</p>}{document.delivery.releaseHash && <p><strong>发布版本：</strong>{document.delivery.releaseHash}（{document.delivery.releaseStatus ?? '待执行'}，健康{document.delivery.healthPassed ? '通过' : '待确认'}）</p>}{document.delivery.pullRequest && <p><strong>PR：</strong><a href={document.delivery.pullRequest.url} target="_blank" rel="noreferrer">{document.delivery.pullRequest.status}</a>，审批人 {document.delivery.pullRequest.approvedBy}，合并 Commit {document.delivery.pullRequest.mergeCommit}，main HEAD {document.delivery.pullRequest.targetBranchHead}</p>}</section>}
        {document?.gate?.key === 'confirm-project-scope' ? <RepositoryScope key={document.gate.gateHash} gateHash={document.gate.gateHash} busy={busy || uncertain} submit={submit} /> : document?.gate && <WorkflowGateForm key={document.gate.gateHash} gate={document.gate} busy={busy || uncertain} submit={submit} />}
        {document && !intake && !document.product && !document.gate && !document.blockage && (!document.progress || document.retry) && (document.retry ? <RequirementWorkspace title="恢复与下一步" panel={<><p>{document.retry.next ?? '从已保存的检查点继续，已确认内容和前序成果保留。'}</p><h3>执行影响</h3><p>{document.retry.impact}</p></>} actions={recoveryConfirm ? <div className="intake-assumptions"><strong>确认从“{document.retry.title}”继续？</strong><p>{document.retry.next}</p><p>{document.retry.syncOnly ? '仅同步已保存产物，不重新调用模型；成功后继续原流程。' : '会继续当前需求执行，不重新填写需求；模型调用可能产生费用。'}</p><button className="primary" disabled={busy || uncertain} onClick={/** 路径和输入由服务端快照决定，客户端只提交版本令牌。 */() => void submit({ retryHash: document.retry!.hash })}>{busy ? '正在恢复…' : '确认恢复并继续'}</button><button disabled={busy || uncertain} onClick={/** 返回检查不改变原生快照。 */() => setRecoveryConfirm(false)}>返回检查</button></div> : <button className="primary" disabled={busy || uncertain} onClick={/** 恢复前先展示检查点与执行影响。 */() => setRecoveryConfirm(true)}>{document.retry.syncOnly ? '重试资料同步 →' : `从${document.retry.title}继续 →`}</button>}>
          <section className="intake-card requirement-completeness"><div className="intake-eyebrow">当前成果状态</div><h1>已保存的工作与待补结果</h1><p>已保存 {document.retry.savedAnswers} 轮回答。当前停在“{document.retry.title}”，恢复后仍会停在相应的人工确认关口。</p>{document.retry.preserved.length > 0 && <ul className="requirement-preserved">{document.retry.preserved.map(/** 状态由服务端依据保存的角色结果判断，计划句不计作完成交付。 */item => <li key={item.role}><span>{item.label}</span><strong>{item.complete === false ? '仅保存执行计划，未保存检查结果' : '已完成'}</strong></li>)}</ul>}</section>
          <section className="intake-card"><h2>当前需要处理的问题</h2><p><strong>{document.retry.title}：</strong>{document.retry.reason}</p>{document.retry.attemptDetails?.map(/** 保留服务端脱敏后的失败依据，不推断额外故障原因。 */detail => <p key={detail}>{detail}</p>)}<p>{document.retry.message}</p></section>
        </RequirementWorkspace> : <section className="intake-card"><h2>{busy || uncertain ? operation.label : document.status === 'canceled' ? '流程已取消' : document.status === 'failed' ? '流程遇到问题' : document.status === 'success' ? '本轮流程已结束' : '流程正在处理'}</h2><p>{busy || uncertain ? '正在处理已保存的信息，完成后会自动更新本页，无需重新填写。' : document.status === 'canceled' ? '本轮流程已终止，已保存的回答和前序成果保留；不支持直接恢复已取消流程。' : document.status === 'failed' ? '已保存的记录仍可查看。当前失败不支持直接恢复，请核对结果后处理。' : document.status === 'success' ? ({'fixture-completed':'固定样例流程已走完，所有执行与回执均为合成验证。','delivery-confirmed':'本轮交付已确认，执行证据与人工决定已保存。','rejected':'本轮已拒绝并结束。','blocked':'本轮已停止，仍有需要处理的阻塞。','rolled-back':'本轮发布已回滚。','manual-attention':'本轮需要人工处理。'}[document.outcome ?? ''] ?? '已保存本轮结果与决定。') : '请刷新查看进展，后续需要你确认的内容会在本页显示。'}</p></section>)}
      </>}
    </main>
    <OperationFeedback busy={(busy || uncertain || document?.status === 'running') && document?.status !== 'canceled'} label={document?.execution && !document.execution.settled ? (document.execution.phase === 'canceling' ? '取消中，等待本地调用退出…' : `正在执行：第 ${document.execution.attempt} 次尝试${document.execution.failures.length ? '，已发生故障重试' : ''}…`) : busy || uncertain || operation.label.includes('超时') ? operation.label : document?.progress?.title ?? '后台流程仍在处理，正在自动同步最新结果…'} startedAt={document?.execution?.startedAt ?? operation.startedAt} error={error} notice={notice} dismiss={/** 关闭反馈不丢弃表单或重新提交。 */() => { setError(''); setNotice(''); }} />
  </div>;
}
