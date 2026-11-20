import seakoiLogo from './assets/seakoi-logo.webp';
import { intakeRequest as request, IntakeRequestError, reconcileWrite } from './intake-request';
import { RepositoryScope } from './RepositoryScope';
import { ChevronDown, CircleAlert, Clock3, Folder, FolderPlus, GitBranch, Plus, RefreshCw, X } from 'lucide-react';
import { WorkbenchAccount } from './components/WorkbenchAccount';
import { WorkbenchUserMenu } from './components/WorkbenchUserMenu';
import { WorkbenchComposer } from './components/WorkbenchComposer';
import { WorkbenchRecords, teamLabels } from './components/WorkbenchRecords';
import { lazy, Suspense, useEffect, useRef, useState } from 'react';
import { WorkflowGateForm, WorkflowGateEvidence, type WorkflowGate } from './WorkflowGate';
import { Markdown } from './components/Markdown';
import { ClarificationProgress, RequirementWorkspace } from './components/RequirementWorkspace';
import { RemoteSyncSettings } from './RemoteSyncSettings';
import { RepositoryManagement } from './RepositoryManagement';
import { isQuestionAnswered, type ClarificationQuestion as Question, type ClarificationAnswer as Answer } from './components/QuestionFlow';
import { RunFlowMini } from './components/RunFlowMini';
import { projectRunFlow, type Team } from './components/run-flow-state';
import { TeamSpecifications, type Specification } from './components/TeamSpecifications';
import { appendProductStream, type ProductStreamEvent, type ProductStreamView, type LiveActivity, type RunTimelineDocument } from './components/RunActivityFeed';
import { InlineClarificationNode } from './components/InlineClarificationNode';
import { useClarificationDraft } from './clarification-draft';
import { AcceptanceEvidence, type AcceptanceEvidenceData } from './components/AcceptanceEvidence';
import { MergeRequestDelivery, type MergeRequestDeliveryReceipt } from './components/MergeRequestDelivery';
import './intake.css';
const CandidateChangesPanel = lazy(() => import('./components/CandidateChangesPanel'));
const productReworkLabels: Record<string, string> = {
  'guided-requirements': '对齐需求（业务澄清）', analysis: '对齐需求', clarification: '澄清结论整理',
  'scope-priority': '范围与优先级', writing: '产品稿写作',
};
interface Document { projectId?: string; productDocuments?: { requirements: string; specification: string }; approvedProduct?: { content: string; hash: string; reviewer: string }; specifications?: Specification[]; directionDraft?: string; mergeRequest?: MergeRequestDeliveryReceipt; activeProductAttempt?: { attempt: string; stopping: boolean }; productCorrection?: { attempt: string; status: 'saved' }; appliedCorrection?: { attempt?: string; target: string; round: number }; acceptanceEvidence?: AcceptanceEvidenceData; developmentStop?: { reason: string; rounds: number; calls: number; checkRuns: number; latestChecks?: { id: string; command: string; exitCode: number | null; stderr: string; stdout: string }[] }; successor?: { sourceRunId: string; iterationId?: string; artifacts: { kind: 'product' | 'development' | 'testing'; branch: string; commit: string; paths: string[] }[] }; successorBaseline?: { sourceRunId: string; changeBrief: string; artifacts: { kind: string; branch: string; commit: string; path: string; hash: string }[] }; reconfigure?: { hash: string }; clarify?: { hash: string; title: string }; blockage?: { preparationRequired?: boolean; phase: string; title: string; summary: string; blockers: string[]; taskCount: number; productContent: string }; progress?: { attemptDetails?: string[]; phase: string; title: string; detail: string; next: string }; retry?: { attemptDetails?: string[]; next?: string; syncOnly?: boolean; hash: string; message: string; savedAnswers: number; title: string; step: string; reason: string; impact: string; preserved: {label: string; role: string; complete?: boolean}[] }; outcome?: string; gate?: WorkflowGate; runId: string; status: string; mode?: string; intakeMode?: 'clarify' | 'autofill'; brief: string; step?: string; createdAt?: string; updatedAt?: string; timeline?: RunTimelineDocument; intake?: { intakeMode?: 'clarify' | 'autofill'; round: number; hash: string; plan: { maturity?: Record<string, { clear: boolean; evidence: string }>; summary: string; assumptions: string[]; questions: Question[] }; history: { plan: { questions: Question[] }; response: { reviewer: string; supplement: string; answers: Answer[] } }[] }; product?: { artifact: { content: string; hash: string } } }

type Material = 'product' | 'gate' | 'specifications' | 'quality' | 'delivery';
const materialLabels: Record<Material, string> = { product: '产品正文', gate: '审查材料', specifications: '正式规格', quality: '测试证据', delivery: '交付回执' };

/** 从原始需求取可重复计算的列表标题。 */
function requirementTitle(brief: string) {
  const explicit = brief.match(/^(?:需求)?标题[：:]\s*([^\n]+)/m)?.[1];
  const outcome = brief.match(/(?:希望|期望|想要)[：:\s]*([^。！？；\n]+)/)?.[1];
  return Array.from((explicit || outcome || brief).trim().split(/[。！？；\n]/)[0]).slice(0, 32).join('') || '新需求';
}

/** 从已提交历史中投影确认基线；当前轮推荐、假设和未提交草稿不进入列表。 */
function confirmedRules(intake: NonNullable<Document['intake']>) {
  return intake.history.flatMap((entry, round) => entry.response.answers.flatMap(answer => {
    const question = entry.plan.questions.find(item => item.id === answer.questionId);
    if (!question) return [];
    const selected = answer.selected.map(id => question.options.find(option => option.id === id)?.label ?? id);
    const custom = answer.custom.trim();
    const value = [...selected, custom].filter(Boolean).join('；');
    return value ? [{ round: round + 1, question: question.title, value, reviewer: entry.response.reviewer }] : [];
  }));
}
/** 根据已保存的澄清结果提示下一步。 */
function clarificationNotice(next: Document) {
  if (next.product && next.step === 'review-product') return '产品稿已生成，请审阅并确认当前版本。';
  if (!next.intake) return undefined;
  const required = next.intake.plan.questions.filter(question => question.required).length;
  if (required) return `回答已提交。第 ${next.intake.round} 轮还有 ${required} 个必答问题，请继续澄清。`;
  return '回答已提交。本轮没有必答问题，可核对方案后继续检查缺口。';
}

/** 主流程需求入口；已确认内容来自 Workflow 快照。 */
export function IntakeApp() {
  const [id, setId] = useState(new URLSearchParams(location.search).get('run') ?? '');
  const [document, setDocument] = useState<Document>();
  const [runs, setRuns] = useState<Document[]>([]);
  const [brief, setBrief] = useState('');
  const [iterationId, setIterationId] = useState('unassigned');
  const [intakeMode, setIntakeMode] = useState<'clarify' | 'autofill'>('clarify');
  const [activeQuestion, setActiveQuestion] = useState('');
  const [reviewer, setReviewer] = useState('');
  const [comment, setComment] = useState('');
  const [uncertain, setUncertain] = useState(false);
  const [busy, setBusy] = useState(false);
  const [operation, setOperation] = useState({ label: '正在处理你的提交…' });
  const [notice, setNotice] = useState('');
  const [error, setError] = useState('');
  const [accountName, setAccountName] = useState<string | null>(null);
  const [accountOpen, setAccountOpen] = useState(false);
  const [correctionDrafts, setCorrectionDrafts] = useState<Record<string, { attempt: string; feedback: string }>>({});
  const [correcting, setCorrecting] = useState(false);
  const [correctionError, setCorrectionError] = useState('');
  const [approving, setApproving] = useState(false);
  const [showSyncSettings, setShowSyncSettings] = useState(false);
  const [showRepositoryManagement, setShowRepositoryManagement] = useState(false);
  const [showSuccessor, setShowSuccessor] = useState(false);
  const [successorBrief, setSuccessorBrief] = useState('');
  const [successorKinds, setSuccessorKinds] = useState<Array<'product' | 'development' | 'testing'>>(['product']);
  const [liveActivity, setLiveActivity] = useState<LiveActivity>();
  const [streams, setStreams] = useState<Record<string, ProductStreamView & { stepId?: string; taskKey?: string }>>({});
  const streamRound = useRef(0);
  const [project, setProject] = useState<{ id?: string; title?: string }>();
  const [flowOpen, setFlowOpen] = useState(false);
  const [material, setMaterial] = useState<Material>();
  const [notes, setNotes] = useState<Record<string, string[]>>({});
  const [messages, setMessages] = useState<Record<string, string>>({});
  const focusMaterial = useRef<HTMLElement | null>(null);
  const materialPanel = useRef<HTMLElement>(null);
  const content = useRef<HTMLDivElement>(null);
  const projectLabel = project?.title ?? '当前工作区';
  const navigationLocked = busy || uncertain || correcting;
  const currentNote = messages[id] ?? '';
  const activeAttempt = document?.activeProductAttempt;
  const savedCorrection = document?.productCorrection;
  const correctionDraft = correctionDrafts[id];
  const correctionMode = !!(activeAttempt || savedCorrection || correcting || correctionDraft);
  const staleCorrection = !!correctionDraft && correctionDraft.attempt !== activeAttempt?.attempt;
  /** 底部输入按当前尝试保存纠偏；旧草稿可由用户明确转为普通补充。 */
  function changeCorrection(feedback: string) {
    const attempt = correctionDraft?.attempt ?? activeAttempt?.attempt;
    if (!feedback) clearCorrection();
    else if (attempt) setCorrectionDrafts(previous => ({ ...previous, [id]: { attempt, feedback } }));
  }
  /** 清空已被接收或已明确转为补充的反馈。 */
  function clearCorrection() {
    setCorrectionDrafts(previous => {
      const next = { ...previous };
      delete next[id];
      return next;
    });
  }
  /** 将过期意见带回普通输入，仍由用户决定是否提交。 */
  function moveCorrectionToNote() {
    if (!correctionDraft) return;
    setMessages(previous => ({ ...previous, [id]: [previous[id], correctionDraft.feedback].filter(Boolean).join('\n') }));
    clearCorrection();
    setCorrectionError('');
  }
  const clarificationOpen = !!document?.intake && !document.product && !document.gate;
  const productReviewOpen = !!document?.product;
  const canUseComposer = !id || !!document || busy;
  const materialOpen = !!document && !!material && (material !== 'gate' || !!document.gate);
  useEffect(() => {
    const controller = new AbortController();
    void fetch('/intake-api/project', { signal: controller.signal }).then(async response => {
      if (response.ok && !controller.signal.aborted) setProject(await response.json());
    }).catch(() => { /* 沿用当前实例工作区标签。 */ });
    return () => controller.abort();
  }, []);
  useEffect(() => {
    if (content.current) content.current.scrollTop = 0;
  }, [id]);
  useEffect(() => {
    if (materialOpen) materialPanel.current?.querySelector('button')?.focus();
  }, [materialOpen]);
  useEffect(() => {
    if (material === 'gate') setMaterial(undefined);
  }, [document?.gate?.gateHash]);
  const [changesRun, setChangesRun] = useState<string>();
  const changesTrigger = useRef<HTMLButtonElement>(null);
  const [browsedTeam, setBrowsedTeam] = useState<Team>();
  const flow = document ? projectRunFlow(document) : undefined;
  const activeTeam = flow?.active ?? 'product';
  const selectedTeam = browsedTeam ?? activeTeam;
  const onActiveTeam = selectedTeam === activeTeam;
  const changesOpen = !!id && changesRun === id;
  /** 收起差异栏并将键盘焦点交还入口。 */
  function closeChanges() { setChangesRun(undefined); changesTrigger.current?.focus(); }
  useEffect(() => {
    if (!changesOpen) return;
    /** Escape 只收起当前可见的变更栏。 */
    function dismissChanges(event: KeyboardEvent) { if (event.key === 'Escape' && !event.defaultPrevented) closeChanges(); }
    window.addEventListener('keydown', dismissChanges);
    return () => window.removeEventListener('keydown', dismissChanges);
  }, [changesOpen]);
  const intake = document?.intake;
  /** 点击当前团队时恢复自动跟随。 */
  function selectTeam(team: Team) { setBrowsedTeam(team === activeTeam ? undefined : team); }
  /** 展开当前 Run 的只读材料栏。 */
  function openMaterial(view: Material, trigger: HTMLElement) {
    focusMaterial.current = trigger;
    setMaterial(view); setChangesRun(undefined); setFlowOpen(false);
  }
  /** 收起材料并把焦点交还入口。 */
  function closeMaterial() { setMaterial(undefined); focusMaterial.current?.focus(); }
  /** 底部输入仅保存草稿或本页记录，人工关口仍通过原表单提交。 */
  function sendNote() {
    const value = currentNote.trim();
    if (!value) return;
    if (clarificationOpen && value.length + supplement.length + (supplement ? 1 : 0) > 4000) { setError('本轮澄清补充最多 4000 字'); return; }
    if (productReviewOpen && value.length + comment.length + (comment ? 1 : 0) > 2000) { setError('审阅意见最多 2000 字'); return; }
    setError('');
    if (clarificationOpen) { updateDraft({ supplement: [supplement, value].filter(Boolean).join('\n') }); setNotice('已加入澄清草稿，确认后随本轮回答提交。'); }
    else if (productReviewOpen) { setApproving(false); setComment(previous => [previous, value].filter(Boolean).join('\n')); setNotice('已加入审阅意见草稿，请在审批卡确认。'); }
    else { setNotes(previous => ({ ...previous, [id]: [...(previous[id] ?? []), value] })); setNotice('已记录在本页，当前流程未推进。'); }
    setMessages(previous => ({ ...previous, [id]: '' }));
  }
  const questions = intake?.plan.questions ?? [];
  const draftRun = intake || document?.product ? document?.runId : undefined;
  const { draft, persisted, update: updateDraft } = useClarificationDraft(draftRun, intake?.hash);
  const { answers, supplement } = draft;
  const draftReviewer = draft.reviewer ?? reviewer;
  const missingRequired = questions.filter(question => question.required && !isQuestionAnswered(answers[question.id])).length;
  /** 深链接与所选 Run 一致，刷新恢复当前人工节点。 */
  function choose(value: string) {
    setChangesRun(undefined); setBrowsedTeam(undefined); setNotice(''); setUncertain(false); setId(value); setDocument(undefined); setLiveActivity(undefined); setStreams({}); streamRound.current = 0; setMaterial(undefined); setFlowOpen(false); setActiveQuestion(''); setComment(''); setCorrectionError(''); setError(''); setApproving(false);
    const url = new URL(location.href); value ? url.searchParams.set('run', value) : url.searchParams.delete('run'); history.replaceState(null, '', url);
  }
  /** 回读不重发用户决定，网络失败保留表单。 */
  async function refresh(value = id) {
    try {
      if (value) {
        const next = await request<Document>(`/${value}`);
        if (next.intake?.hash !== document?.intake?.hash || next.product?.artifact.hash !== document?.product?.artifact.hash || next.retry?.hash !== document?.retry?.hash) { setApproving(false); setComment(''); }
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
    if ((!busy && !correcting && !uncertain && document?.status !== 'running') || !id) return;
    let active = true; let reading = false;
    /** 一次只执行一个只读查询，终态或新暂停点会自然停止轮询。 */
    async function poll() {
      if (reading) return; reading = true;
      try { const next = await request<Document>(`/${id}`); if (active) { setDocument(next); setUncertain(false); setError(''); if (next.status !== document?.status) setNotice('已同步最新流程状态。'); if (next.status !== 'running') { setApproving(false); if (next.status === 'failed') { setError(next.retry ? `${next.retry.title}未完成：${next.retry.reason}。可使用恢复入口继续。` : '后台执行已失败，请查看处理说明。'); setNotice(''); } else if (next.status !== document?.status || next.intake?.hash !== document?.intake?.hash) setNotice(clarificationNotice(next) ?? '已重新同步最新流程状态。'); } } }
      catch { /* 只读观察暂不可达时保留未知状态，下一轮继续回读。 */ }
      finally { reading = false; }
    }
    const timer = window.setInterval(poll, 5000);
    // 切换记录或离开运行态后取消观察。
    return () => { active = false; window.clearInterval(timer); };
  }, [busy, correcting, id, document?.status, uncertain]);
  // 运行期间订阅 Mastra 原生 Workflow.watch 的工作台 SSE；断线由快照轮询兜底。
  useEffect(() => {
    if (!id || (!busy && !correcting && !uncertain && document?.status !== 'running')) return;
    let active = true;
    const source = new EventSource(`/intake-api/runs/${encodeURIComponent(id)}/events`);
    /** 事件只触发权威快照回读，不把 SSE payload 当作执行事实。 */
    source.onmessage = event => {
      try {
        const payload = JSON.parse(event.data) as { activity?: LiveActivity; output?: ProductStreamEvent; stepId?: string; taskKey?: string };
        const output = payload.output;
        if (active && output) {
          const key = JSON.stringify([streamRound.current, payload.stepId, payload.taskKey, output.role, output.attempt]);
          setStreams(previous => Object.fromEntries([...Object.entries(previous).filter(([id]) => id !== key), [key, { ...appendProductStream(previous[key], output), stepId: payload.stepId, taskKey: payload.taskKey }]].slice(-24)));
          return;
        }
        if (active && payload.activity) setLiveActivity(payload.activity);
      } catch { /* 非活动 SSE 事件不影响快照同步。 */ }
      void request<Document>(`/${id}`).then(next => {
        if (active) setDocument(next);
      }).catch(() => { /* SSE 断线期间保留当前 UI，轮询会继续尝试。 */ });
    };
    /** 事件流错误不覆盖当前 Run 状态，避免网络抖动伪造失败。 */
    source.onerror = () => { /* REST fallback remains active. */ };
    return () => { active = false; source.close(); };
  }, [busy, correcting, document?.status, id, uncertain]);
  /** 超时只代表连接结束；先回读状态，再决定展示运行、失败或输入错误。 */
  async function recoverResponse(runId: string, reason: unknown) {
    const result = await reconcileWrite(/** 仅回读原Run，不重发写入。 */() => request<Document>(`/${runId}`));
    const advanced = result.document && (result.document.intake?.hash !== document?.intake?.hash || result.document.product?.artifact.hash !== document?.product?.artifact.hash || result.document.gate?.gateHash !== document?.gate?.gateHash);
    if (result.document) {
      setDocument(result.document);
      setRuns(previous => [result.document!, ...previous.filter(run => run.runId !== runId)]);
    }
    setUncertain(result.uncertain);
    if (result.running || result.uncertain) {
      setError(''); setNotice(''); setOperation({ label: result.running ? '提交连接已超时，后台仍在运行，正在同步进度…' : '连接暂时中断，正在重新确认后台执行状态…' });
    } else if (result.failed) setError(result.document?.retry ? `${result.document.retry.title}未完成：${result.document.retry.reason}。请查看本页的失败证据与恢复入口。` : '后台执行已失败，请查看本页的失败原因和恢复入口。');
    else if (result.document?.status === 'success' || (result.document?.status === 'suspended' && advanced)) { setError(''); setApproving(false); setNotice(clarificationNotice(result.document) ?? '已重新同步，流程已进入最新确认步骤。'); }
    else setError((reason as Error).message);
  }
  /** 创建前固定 UUID，即使响应丢失仍可按地址找回同一流程。 */
  async function start() {
    const runId = crypto.randomUUID(); choose(runId); setOperation({ label: intakeMode === 'autofill' ? '正在自主补全需求并生成产品稿…' : '正在分析需求并生成澄清方案…' }); setNotice(''); setBusy(true); setError('');
    try { const next = await request<Document>('', { runId, brief, iterationId, intakeMode }); setDocument(next); setBrief(''); setRuns(previous => [next, ...previous.filter(run => run.runId !== next.runId)]); }
    catch (reason) { await recoverResponse(runId, reason); }
    finally { setBusy(false); }
  }
  /** 从来源 Run 的服务端确认回执创建新 Run；浏览器不传 Git 参数或正文。 */
  async function startSuccessor() {
    if (!document?.successor) return;
    const runId = crypto.randomUUID(); setOperation({ label: '正在校验已确认规格并创建后继 Run…' }); setBusy(true); setError('');
    try {
      const next = await request<Document>(`/${document.runId}/successors`, { runId, artifactKinds: successorKinds, changeBrief: successorBrief, iterationId: document.successor.iterationId, intakeMode: 'clarify' });
      setRuns([next, ...runs]); setShowSuccessor(false); choose(next.runId); setDocument(next); setNotice('已创建后继 Run；旧审批、预算和交付回执没有继承。');
    } catch (reason) { setError((reason as Error).message); }
    finally { setBusy(false); }
  }
  /** 仅在版本变化后清空回答，失败时保留当前输入用于检查。 */
  async function submit(body: unknown) {
    const action = (body as { action?: string; retryHash?: string }).action;
    setLiveActivity(undefined); streamRound.current += 1;
    setOperation({ label: (body as { clarifyHash?: string }).clarifyHash ? '正在整理待决问题、关联工程资料并准备选择卡片…' : (body as { retryHash?: string }).retryHash ? `正在从${document?.retry?.title ?? '已保存检查点'}恢复…` : action === 'refine' ? '正在根据你的回答完善方案…' : action === 'finalize' ? '正在检查业务缺口，满足条件后生成产品需求稿…' : '正在保存决定并处理下一步…' }); setNotice('');
    setBusy(true); setError('');
    try {
      const next = await request<Document>(`/${id}/respond`, body);
      if (next.status === 'failed') {
        setError(next.retry ? `${next.retry.title}未完成：${next.retry.reason}。请查看本页的失败证据与恢复入口。` : '后续生成未完成，请查看本页处理说明。');
      } else {
        const clarification = action === 'refine' || action === 'finalize' ? clarificationNotice(next) : undefined;
        setNotice(clarification ?? (next.gate?.key === 'confirm-blocker-answers' ? '待决问题已整理，请逐项选择或补充。' : next.gate?.key === 'review-revised-product' ? '已生成完整修订稿，请审阅确认。' : next.gate?.recoveryInfo ? '该阶段执行未完成，检查点已保留。请查看下面的处理指引。' : '本次决定已保存，请查看当前阶段与下一步。'));
      }
      setDocument(next);
      setRuns(runs.map(/** 当前 Run 状态随已保存响应同步。 */run => run.runId === next.runId ? next : run));
      setApproving(false);
    } catch (reason) { await recoverResponse(id, reason); }
    finally { setBusy(false); }
  }
  /** 更新一个问题的显式选择，用户可以用补充文本覆盖或说明。 */
  function update(q: Question, selected: string[], custom: string) {
    updateDraft({ answers: { ...answers, [q.id]: { questionId: q.id, selected, custom } } });
  }
  const confirmed = intake ? confirmedRules(intake) : [];
  /** 业务问题与当前 hash 一起提交，服务端重复执行相同校验。 */
  function respond(action: 'refine' | 'finalize') {
    if (!intake) return;
    setReviewer(draftReviewer);
    setActiveQuestion('');
    void submit({ hash: intake.hash, action, reviewer: draftReviewer, answers: Object.values(answers), supplement });
  }
  /** 纠偏使用独立请求，生成中的原请求可以继续观察暂停结果。 */
  async function correctProduct() {
    if (correcting || (!savedCorrection && (!activeAttempt || activeAttempt.stopping || staleCorrection || !correctionDraft?.feedback.trim()))) return;
    if (!accountName) { setAccountOpen(true); return; }
    const body = savedCorrection ? { attempt: savedCorrection.attempt } : { attempt: activeAttempt!.attempt, feedback: correctionDraft!.feedback };
    setCorrecting(true);
    setCorrectionError('');
    /** 只在权威快照确认接收后清除同一尝试的草稿。 */
    function accept(next: Document) {
      setDocument(next);
      if (next.productCorrection?.attempt === body.attempt || next.appliedCorrection?.attempt === body.attempt) {
        streamRound.current += 1;
        if (correctionDraft?.attempt === body.attempt) clearCorrection();
        return true;
      }
      return false;
    }
    try {
      accept(await request<Document>(`/${id}/correct-product`, body));
    } catch (reason) {
      if (reason instanceof IntakeRequestError && reason.status === 401) {
        setAccountName(null);
        setAccountOpen(true);
      }
      setCorrectionError((reason as Error).message);
      try { if (accept(await request<Document>(`/${id}`))) setCorrectionError(''); }
      catch { /* 回读失败时保留草稿和原错误。 */ }
    } finally { setCorrecting(false); }
  }
  /** 将产品审阅决定绑定到当前稿件版本。 */
  function review(decision: 'approve' | 'reject' | 'rework') {
    void submit({ role: 'product', artifactHash: document!.product!.artifact.hash, decision, reviewer, comment });
  }
  if (showRepositoryManagement) return <RepositoryManagement close={/** 返回同一需求页面，不改变当前Run选择。 */() => setShowRepositoryManagement(false)} />;
  if (showSyncSettings) return <RemoteSyncSettings close={/** 返回同一需求页面，不改变当前Run选择。 */() => setShowSyncSettings(false)} />;
  const availableMaterials = document ? [
    (document.product || document.approvedProduct) && 'product',
    document.gate && !document.gate.recoveryInfo && ['approve-architecture','approve-test-cases','review-test-results'].includes(document.gate.key) && 'gate',
    !!document.specifications?.length && 'specifications', document.acceptanceEvidence && 'quality', document.mergeRequest && 'delivery',
  ].filter(Boolean) as Material[] : [];
  const scopedRuns = runs.filter(run => !project?.id || !run.projectId || run.projectId === project.id);
  return <div className={`intake-shell intake-workbench project-workbench${changesOpen || materialOpen ? ' workbench-inspecting' : ''}`} onKeyDown={event => {
    if (event.key !== 'Escape' || event.defaultPrevented) return;
    if (materialOpen) closeMaterial(); else if (flowOpen) setFlowOpen(false);
  }}>
    <header className="workbench-bar"><a className="intake-brand" href="/" aria-label="产研工作台首页"><img className="intake-brand-logo" src={seakoiLogo} alt="Seakoi" /><span>产研工作台</span></a>{document?.mode === 'fixture' && <small>固定样例</small>}
      <div className="workbench-tools"><button type="button" disabled={navigationLocked} title="刷新状态" aria-label="刷新状态" onClick={() => void refresh()}><RefreshCw size={15} /></button></div>
    </header>
    <aside className="intake-sidebar" aria-label="项目与需求">
      <div className="workbench-sidebar-nav">
        <div className="workbench-nav-row"><strong>项目</strong><button type="button" className="workbench-row-action" disabled={navigationLocked} title="登记项目仓库" aria-label="登记项目仓库" onClick={() => setShowRepositoryManagement(true)}><FolderPlus size={15} /></button></div>
        <div className="workbench-project-group">
          <button type="button" className="workbench-project-add workbench-row-action" disabled={navigationLocked} aria-label="新增需求" title="新增需求" onClick={() => choose('')}><Plus size={15} /></button>
          <details open><summary className="workbench-nav-row"><ChevronDown size={13} className="workbench-chevron"/><Folder size={14} /><span title={projectLabel}>{projectLabel}</span></summary>
          <div className="workbench-nav-runs">{id && !scopedRuns.some(run => run.runId === id) && <div className="workbench-pending">{brief ? requirementTitle(brief) : '正在加载需求'}</div>}{scopedRuns.map(run => {
            const waiting = run.status === 'suspended';
            const failed = run.status === 'failed';
            return <button type="button" key={run.runId} aria-current={id === run.runId ? 'page' : undefined} disabled={navigationLocked || id === run.runId} title={run.brief || run.runId} onClick={() => choose(run.runId)}><span>{requirementTitle(run.brief || run.runId)}</span>{waiting && <Clock3 size={13} aria-label="待处理" />}{failed && <CircleAlert size={13} aria-label="失败" />}</button>;
          })}</div>
          </details>
        </div>
      </div>
      <WorkbenchUserMenu
        username={accountName}
        settingsDisabled={navigationLocked}
        openAccount={() => setAccountOpen(true)}
        openSettings={() => setShowSyncSettings(true)}
      />
    </aside>
    <main className="intake-main">
      {id && <header className="workbench-context"><details><summary>{(document?.brief || brief).split(/\n/)[0]?.slice(0, 90) || '原始需求'}</summary><p>{document?.brief || brief}</p><code>{id}</code></details>
        <div className="workbench-tools">
          {!!availableMaterials.length && <button type="button" onClick={event => openMaterial(availableMaterials[0], event.currentTarget)}>审查材料</button>}
          {document && ['development','testing','delivery'].includes(activeTeam) && <button ref={changesTrigger} type="button" aria-expanded={changesOpen} onClick={() => { setMaterial(undefined); setFlowOpen(false); if (changesOpen) closeChanges(); else setChangesRun(id); }}>代码变更</button>}
          {document && <button type="button" aria-expanded={flowOpen} aria-controls="workbench-flow" onClick={() => setFlowOpen(value => !value)}><GitBranch size={14} />流程</button>}
        </div>
        {flowOpen && document && <div className="workbench-flow" id="workbench-flow"><RunFlowMini compact key={document.runId} document={document} selected={selectedTeam} onSelect={team => { selectTeam(team); setFlowOpen(false); }} /></div>}
      </header>}
      <div className={`workbench-content${!id ? ' workbench-welcome' : ''}`} ref={content}>
      {error && <div role="alert" className="intake-error">{error}</div>}
      {(busy || uncertain) && <p role="status" className="workbench-feedback">{operation.label}</p>}
      {notice && !busy && !uncertain && <div role="status" className="workbench-feedback">{notice}<button type="button" aria-label="关闭提示" onClick={() => setNotice('')}><X size={14} /></button></div>}
      {!id ? <section className="workbench-intro"><h1>你想在「{projectLabel}」中改进什么？</h1><p>描述遇到的问题和期望的结果。提交后会提炼列表标题。</p>
        <details><summary>需求设置</summary><label>迭代标识 <input value={iterationId} maxLength={100} onChange={event => setIterationId(event.target.value)} /></label><label><input type="checkbox" checked={intakeMode === 'autofill'} onChange={event => setIntakeMode(event.target.checked ? 'autofill' : 'clarify')} /> AI 主动补全需求</label></details>
      </section> : <>
        {document?.successorBaseline && <details><summary>后继 Run 的只读基线</summary><p>{document.successorBaseline.sourceRunId}</p></details>}
        {document && <WorkbenchRecords timeline={document.timeline} activity={liveActivity} status={document.status} streams={streams} />}
        {(correcting || activeAttempt?.stopping || savedCorrection || staleCorrection || correctionError) && <div className="workbench-feedback" id={savedCorrection ? 'product-team-action' : undefined}>
          <span role={correctionError ? 'alert' : 'status'}>{correctionError || (correcting || activeAttempt?.stopping ? '正在处理纠偏…' : savedCorrection ? '纠偏已保存，可继续执行。' : '原生成尝试已结束，意见仍在输入框中。')}</span>
          {savedCorrection ? <button type="button" disabled={correcting} onClick={() => void correctProduct()}>继续纠偏</button>
            : staleCorrection && <button type="button" disabled={correcting} onClick={moveCorrectionToNote}>转为补充草稿</button>}
        </div>}
        {!!notes[id]?.length && <details className="workbench-local-notes" open><summary>本页补充记录</summary>{notes[id].map((note, index) => <p key={index}>{note}</p>)}</details>}
        {!onActiveTeam && <div className="workbench-feedback">当前查看{teamLabels[selectedTeam]}阶段 <button type="button" onClick={() => selectTeam(activeTeam)}>返回当前待办</button></div>}
        {document?.successor && document.status === 'success' && <section className="intake-card"><div className="intake-eyebrow">后继 Run</div><h2>基于已确认规格创建新 Run</h2><p>旧 Run 的审批、预算、测试与发布回执不会继承。系统会重新校验下列固定 commit 与散列，并让新 Run 从需求澄清开始。</p>{showSuccessor ? <><label>本轮变更说明<textarea value={successorBrief} maxLength={12000} rows={4} onChange={event => setSuccessorBrief(event.target.value)} /></label>{document.successor.artifacts.map(item => <label className="intake-mode-toggle" key={item.kind}><input type="checkbox" checked={successorKinds.includes(item.kind)} onChange={event => setSuccessorKinds(event.target.checked ? [...successorKinds, item.kind] : successorKinds.filter(kind => kind !== item.kind))} /><span><strong>{item.kind === 'product' ? '产品 Spec' : item.kind === 'development' ? '开发 Spec' : '测试 Spec'}</strong><small>{item.branch} · {item.commit.slice(0, 12)}</small></span></label>)}<div className="intake-actions"><button className="primary" disabled={busy || !successorBrief.trim() || !successorKinds.length} onClick={startSuccessor}>校验规格并新建 Run →</button><button disabled={busy} onClick={() => setShowSuccessor(false)}>取消</button></div></> : <button className="primary" disabled={busy || uncertain} onClick={() => { setSuccessorBrief(''); setSuccessorKinds(document.successor!.artifacts.map(item => item.kind)); setShowSuccessor(true); }}>基于已确认版本新建 Run →</button>}</section>}
        {selectedTeam === 'product' && <>
        {document?.appliedCorrection && <p className="run-activity-copy" role="status">反馈已应用，从「{productReworkLabels[document.appliedCorrection.target]}」重新处理。</p>}
        {document?.directionDraft && !intake && !document.approvedProduct && !document.product && onActiveTeam && flow?.productPhase === '对齐需求' && !flow.businessReturn && <details className="intake-card" open><summary>对齐需求 · AI 初稿</summary><Markdown business>{document.directionDraft}</Markdown></details>}
        {intake && <section id="product-clarification" aria-label="产品团队 · 对齐需求">
          <div className="intake-eyebrow">产品团队 · 对齐需求</div>
          <InlineClarificationNode
          questions={questions} questionKey={intake.hash} answers={answers} activeQuestion={activeQuestion}
          onSelect={setActiveQuestion} onChange={update} disabled={busy || uncertain} prefix="intake-question"
          supplement={supplement} onSupplementChange={value => updateDraft({ supplement: value })}
          reviewer={draftReviewer} onReviewerChange={value => updateDraft({ reviewer: value })}
          missingRequired={missingRequired} draftPersisted={persisted} busy={busy}
          onRefine={() => respond('refine')} onFinalize={() => respond('finalize')}
        />
        <RequirementWorkspace contentOnly title="澄清待确认项" panel={null} actions={null}>
          <ClarificationProgress questions={questions} answers={answers} prefix="intake-question" onSelect={setActiveQuestion} />
          <p>已提交的回答会保留在确认记录中。缩小范围须由你明确确认。</p>
          {intake.plan.maturity && <section className="intake-card"><h2>本轮业务检查</h2>{Object.entries(intake.plan.maturity).map(/** 模型判断与人工确认分开展示。 */([key, item]) => <p key={key}><strong>{{ decisions: '关键业务决策', mainFlow: '主流程', exceptions: '异常处理', delivery: '交付影响' }[key] ?? key}：{item.clear ? '模型评估已明确，待你核对' : '仍有缺口'}</strong> · {item.evidence}</p>)}</section>}
          <section className="intake-card"><div className="intake-eyebrow">第 {intake.round} 轮 · 方案建议</div><h1>先对齐需求，再完善需求</h1><p className="intake-boundary-note">系统基于当前上下文给出推荐，帮助降低决策成本；推荐不等于事实，也不等于批准。只有你明确选择或填写并提交后，才会进入本项目的确认基线。</p><Markdown business>{intake.plan.summary}</Markdown>{intake.plan.assumptions.length > 0 && <div className="intake-assumptions"><strong>当前假设 · 尚未作为事实确认</strong>{intake.plan.assumptions.map(/** 假设与方案明确区分。 */(item, index) => <p key={index}>{item}</p>)}</div>}</section>
          {confirmed.length > 0 && <section className="intake-card confirmed-rules"><div className="intake-eyebrow">已提交 · 确认基线</div><h2>已确认业务规则</h2><p>以下内容来自用户已提交的明确选择或填写，将作为下一轮分析和产品稿的业务依据；系统推荐和未提交草稿不在此列。</p><ul>{confirmed.map(/** 只展示已提交的确认事实，不展示推荐值。 */item => <li key={`${item.round}-${item.question}`}><strong>第 {item.round} 轮 · {item.question}</strong><span>{item.value}</span><small>确认人：{item.reviewer}</small></li>)}</ul></section>}
          {intake.history.length > 0 && <section className="intake-card"><details><summary>查看已提交的确认记录（{intake.history.length} 轮）</summary>{intake.history.map(/** 回答原样回读，选择标签来自对应历史方案。 */(entry, index) => <div className="intake-assumptions" key={index}><strong>第 {index + 1} 轮 · {entry.response.reviewer}</strong>{entry.response.answers.map(/** 用本轮选项解释已确认答案。 */answer => { const q = entry.plan.questions.find(/** 按历史 ID 查找问题。 */item => item.id === answer.questionId); return <p key={answer.questionId}>{q?.title}：{answer.selected.map(/** 展示历史选项标签。 */id => q?.options.find(/** 按 ID 查找本轮选项。 */option => option.id === id)?.label ?? id).join('、')} {answer.custom}</p>; })}{entry.response.supplement && <p>补充：{entry.response.supplement}</p>}</div>)}</details></section>}
        </RequirementWorkspace></section>}
        {document?.product && <section id="product-team-action" className="intake-card" aria-label="产品团队 · 产品稿审阅"><h2>人工审批与交接</h2><button type="button" onClick={event => openMaterial('product', event.currentTarget)}>审阅产品正文</button> · <code>{document.product.artifact.hash.slice(0, 12)}</code><p>核对本版需求正文后填写审阅意见。确认只作用于当前产品版本。</p>
          <label>审阅人<input value={reviewer} maxLength={100} onChange={/** 产品审阅单独记录操作者。 */e => setReviewer(e.target.value)} /></label><label>审阅意见<textarea value={comment} maxLength={2000} onChange={/** 明确记录产品决定依据。 */e => { setComment(e.target.value); setApproving(false); }} /></label>
          {approving ? <div className="intake-assumptions"><p>确认当前版本后，本页将展示项目文件与可写范围授权。实施前仍需确认开发方案。</p><button className="primary" disabled={busy || uncertain} onClick={/** 二次确认只批准当前 hash。 */() => review('approve')}>确认产品版本并继续</button><button disabled={busy || uncertain} onClick={/** 取消不推进。 */() => setApproving(false)}>取消</button></div> : <div className="intake-actions"><button disabled={busy || uncertain || !reviewer.trim() || !comment.trim()} onClick={/** 终止只作用当前产品轮次。 */() => review('reject')}>拒绝并结束</button><button disabled={busy || uncertain || !reviewer.trim() || !comment.trim()} onClick={/** 产品团队按审阅意见选择重跑节点。 */() => review('rework')}>退回修改</button><button className="primary" disabled={busy || uncertain || !reviewer.trim() || !comment.trim()} onClick={/** 先展示下一步影响。 */() => setApproving(true)}>确认产品稿 →</button></div>}
        </section>}
        </>}
        {selectedTeam === 'development' && document?.developmentStop && <section className="intake-card"><h2>自主开发需要处理</h2><p>{{'business-decision':'实现过程中发现需要新增业务决定。请先明确该规则与验收预期。','authorization-required':'当前任务需要扩大授权，或发现权限与证据完整性问题。请核对已保存候选与范围。','repair-budget':'已达到批准的返工轮数上限。','verification-budget':'已达到分配的登记检查执行上限。','no-progress':'相同失败连续出现，已达到批准的无进展上限。'}[document.developmentStop.reason] ?? document.developmentStop.reason}</p><p>已返工 {document.developmentStop.rounds} 轮 · 模型调用 {document.developmentStop.calls} 次 · 登记检查执行 {document.developmentStop.checkRuns} 次。候选与证据已保存。</p>{document.developmentStop.latestChecks?.map(/** 只显示服务端已脱敏的实际检查，不提供命令输入。 */check => <details key={check.id}><summary>{check.id} · 退出码 {check.exitCode ?? '未知'}</summary><pre>{check.command}<br />{check.stderr || check.stdout}</pre></details>)}</section>}
        {onActiveTeam && document?.blockage && <section id={document.clarify ? "product-team-action" : undefined} className="intake-card"><div className="intake-eyebrow">{document.blockage.phase} · 已返回方案，尚未开工</div><h1>{document.blockage.title}</h1><p>已保存开发方案，包含 {document.blockage.taskCount} 项任务。以下事项仍阻止开工，本次没有进入代码实施。</p><Markdown business>{document.blockage.summary}</Markdown><h2>接下来需要处理什么？</h2><p>{document.blockage.preparationRequired ? '当前项目尚未具备实施与验证条件。开发侧需要先按方案完成工程准备，再点击下方入口重新确认项目；产品需求和本次方案已保存，工程缺口不需要通过修改产品稿解决。' : '先补齐产品稿中的业务选择；工程资料缺口由开发侧核对。补齐后再继续方案规划和确认，不应把这些未决项直接当作已批准规则。'}</p>{document.reconfigure && <button className="primary" disabled={busy || uncertain} onClick={/** 返回项目确认关口重新检查工程环境，不重做产品生成或自动批准。 */() => void submit({ reconfigureHash: document.reconfigure!.hash })}>重新检查项目，继续交接 →</button>}{document.clarify && <button className="primary" disabled={busy || uncertain} onClick={/** 在原Run创建原生澄清暂停点，不选择答案或自动批准。 */() => void submit({ clarifyHash: document.clarify!.hash })}>{busy ? '正在准备选择卡片…' : '补齐业务选择，修订产品稿 →'}</button>}<details open><summary>查看具体阻塞事项（{document.blockage.blockers.length}）</summary><ul>{document.blockage.blockers.map(/** 阻塞依据来自模型已保存的实际方案，不代替用户作决定。 */(item, index) => <li key={index}><p>{item}</p></li>)}</ul></details><button type="button" onClick={/** 从阻塞说明转到产品批准材料。 */() => selectTeam('product')}>查看产品团队成果</button></section>}
        {onActiveTeam && document?.status === 'failed' && document.progress && !document.gate && <section className="intake-card" role="status"><div className="intake-eyebrow">当前阶段 · {document.progress.phase}</div><h1>{document.progress.title}</h1><p>{document.progress.detail}</p><p>{document.progress.next}</p>{!!document.progress.attemptDetails?.length && <details><summary>查看模型调用诊断</summary>{document.progress.attemptDetails.map(/** 后端仅返回经过白名单校验的来源和计时。 */(detail, index) => <p key={index}>{detail}</p>)}</details>}</section>}
        {onActiveTeam && (document?.gate?.key === 'confirm-project-scope' ? <RepositoryScope key={document.gate.gateHash} gateHash={document.gate.gateHash} busy={busy || uncertain} submit={submit} /> : document?.gate && <section id={['confirm-blocker-answers', 'review-revised-product'].includes(document.gate.key) ? "product-team-action" : undefined} aria-label={document.gate.key === 'confirm-blocker-answers' ? '产品团队 · 业务缺口澄清' : document.gate.key === 'review-revised-product' ? '产品团队 · 修订稿审阅' : undefined}>
          {document.gate.key === 'confirm-blocker-answers' && <div className="intake-eyebrow">产品团队 · 业务缺口澄清</div>}
          {document.gate.key === 'review-revised-product' && <div className="intake-eyebrow">产品团队 · 修订稿审阅</div>}
          <WorkflowGateForm key={document.gate.gateHash} gate={document.gate} busy={busy || uncertain} submit={submit} onInspect={availableMaterials.includes('gate') ? trigger => openMaterial('gate', trigger) : undefined} />
        </section>)}
        {onActiveTeam && document && !intake && !document.product && !document.gate && !document.blockage && (!document.progress || document.retry) && (document.retry ? <div id="workflow-recovery"><RequirementWorkspace title="恢复与下一步" panel={<><p>{document.retry.next ?? '从已保存的检查点继续，已确认内容和前序成果保留。'}</p><h3>执行影响</h3><p>{document.retry.impact}</p></>} actions={<button className="primary" disabled={busy || uncertain} onClick={/** 恢复只提交当前服务端版本，不允许客户端指定路径。 */() => void submit({ retryHash: document.retry!.hash })}>{busy ? '正在重试…' : '重试'}</button>}>
          <section className="intake-card requirement-completeness"><div className="intake-eyebrow">当前成果状态</div><h1>已保存的工作与待补结果</h1><p>已保存 {document.retry.savedAnswers} 轮回答。当前停在“{document.retry.title}”，恢复后仍会停在相应的人工确认关口。</p>{document.retry.preserved.length > 0 && <ul className="requirement-preserved">{document.retry.preserved.map(/** 状态由服务端依据保存的角色结果判断，计划句不计作完成交付。 */item => <li key={item.role}><span>{item.label}</span><strong>{item.complete === false ? '仅保存执行计划，未保存检查结果' : '已完成'}</strong></li>)}</ul>}</section>
          <section className="intake-card"><h2>当前需要处理的问题</h2><p><strong>{document.retry.title}：</strong>{document.retry.reason}</p>{document.retry.attemptDetails?.map(/** 保留服务端脱敏后的失败依据，不推断额外故障原因。 */detail => <p key={detail}>{detail}</p>)}<p>{document.retry.message}</p></section>
        </RequirementWorkspace></div> : document.status === 'running' ? null : <section className="intake-card"><h2>{busy || uncertain ? operation.label : document.status === 'failed' ? '流程遇到问题' : document.status === 'success' ? '本轮流程已结束' : '流程正在处理'}</h2><p>{busy || uncertain ? '正在处理已保存的信息，完成后会自动更新本页，无需重新填写。' : document.status === 'failed' ? '已保存的记录仍可查看。当前失败不支持直接恢复，请核对结果后处理。' : document.status === 'success' ? ({'fixture-completed':'固定样例流程已走完，所有执行与回执均为合成验证。','delivery-confirmed':'本轮交付已确认，执行证据与人工决定已保存。','rejected':'本轮已拒绝并结束。','blocked':'本轮已停止，仍有需要处理的阻塞。','rolled-back':'本轮发布已回滚。','manual-attention':'本轮需要人工处理。'}[document.outcome ?? ''] ?? '已保存本轮结果与决定。') : '请刷新查看进展，后续需要你确认的内容会在本页显示。'}</p></section>)}
      </>}
      </div>
      {canUseComposer && <WorkbenchComposer key={`${id || 'create'}:${correctionDraft?.attempt ?? activeAttempt?.attempt ?? 'note'}`}
        readOnly={correcting}
        value={correctionMode ? correctionDraft?.feedback ?? '' : id ? currentNote : brief}
        change={correctionMode ? changeCorrection : id ? value => setMessages(previous => ({ ...previous, [id]: value })) : setBrief}
        send={correctionMode ? () => void correctProduct() : id ? sendNote : () => void start()}
        maxLength={correctionMode ? 2000 : undefined}
        disabled={correctionMode ? correcting || staleCorrection || !!savedCorrection || !activeAttempt || activeAttempt.stopping : navigationLocked || (!id && !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,99}$/.test(iterationId))} />}
      <WorkbenchAccount key={String(accountOpen)} open={accountOpen} signedIn={setAccountName} close={() => setAccountOpen(false)} />
    </main>
    {materialOpen && document && material && <aside ref={materialPanel} className="workbench-materials" aria-label="审查材料"><header><div className="workbench-tools">{availableMaterials.map(view => <button key={view} type="button" aria-pressed={view === material} onClick={() => setMaterial(view)}>{view === 'gate' && document.gate?.key === 'approve-architecture' ? '架构方案' : view === 'gate' && document.gate?.key === 'approve-test-cases' ? '测试用例' : materialLabels[view]}</button>)}</div><button type="button" aria-label="关闭材料" onClick={closeMaterial}><X size={16} /></button></header>
      <div className="workbench-material-body">
      {material === 'product' && (document.product || document.approvedProduct) && <><small>版本 <code>{(document.product?.artifact.hash ?? document.approvedProduct?.hash)?.slice(0, 12)}</code></small>{document.productDocuments ? <>
        <details open><summary>需求文档</summary><Markdown business>{document.productDocuments.requirements}</Markdown></details>
        <details><summary>产品规格</summary><Markdown business>{document.productDocuments.specification}</Markdown></details>
      </> : <Markdown business>{document.product?.artifact.content ?? document.approvedProduct?.content ?? ''}</Markdown>}{document.specifications && <TeamSpecifications team="product" specifications={document.specifications} approval={document.approvedProduct} />}</>}
      {material === 'gate' && document.gate && <WorkflowGateEvidence gate={document.gate} />}
      {material === 'specifications' && (['product','development','testing'] as const).map(team => <TeamSpecifications key={team} team={team} specifications={document.specifications ?? []} approval={document.approvedProduct} />)}
      {material === 'quality' && document.acceptanceEvidence && <AcceptanceEvidence evidence={document.acceptanceEvidence} />}
      {material === 'delivery' && document.mergeRequest && <MergeRequestDelivery key={document.mergeRequest.commit} receipt={document.mergeRequest} />}
      </div>
    </aside>}
    {changesOpen && <Suspense fallback={<aside id="candidate-changes-panel" className="candidate-changes-panel" role="status">正在加载变更查看器…</aside>}><CandidateChangesPanel key={id} runId={id} close={closeChanges} /></Suspense>}
  </div>;
}
