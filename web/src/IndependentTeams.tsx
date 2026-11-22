import { useEffect, useState } from 'react';
import { WorkflowGateForm, WorkflowGateEvidence, type WorkflowGate } from './WorkflowGate';
import { QuestionFlow, type ClarificationAnswer, type ClarificationQuestion } from './components/QuestionFlow';
import { RepositoryScope } from './RepositoryScope';
import { Markdown } from './components/Markdown';

type Team = 'product' | 'development' | 'testing' | 'delivery';
const labels = { product: '产品', development: '研发', testing: '测试', delivery: '交付' };
interface Source { workflow: string; runId: string; hash: string; brief: string }
interface TeamDocument {
  runId: string; brief: string; status: string; outcome?: string; gate?: WorkflowGate;
  intake?: { hash: string; plan: { summary: string; questions: ClarificationQuestion[] } };
  product?: { artifact: { content: string; hash: string } };
  retry?: { hash: string; title: string; reason: string; impact: string };
  progress?: { title: string; detail: string; next: string };
  developmentStop?: { reason: string; rounds: number; calls: number; checkRuns: number };
}

/** 独立团队共用原有审批表单，来源选择只提交服务端返回的版本引用。 */
export function IndependentTeams({ projectId, close }: { projectId: string; close: () => void }) {
  const [team, setTeam] = useState<Team>('product');
  const [sources, setSources] = useState<Source[]>([]);
  const [source, setSource] = useState('');
  const [brief, setBrief] = useState('');
  const [iteration, setIteration] = useState('unassigned');
  const [runs, setRuns] = useState<TeamDocument[]>([]);
  const [current, setCurrent] = useState<TeamDocument>();
  const [answers, setAnswers] = useState<Record<string, ClarificationAnswer>>({});
  const [question, setQuestion] = useState('');
  const [comment, setComment] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [inputPackage, setInputPackage] = useState<{ runId: string; hash: string; confirmed: boolean }>();

  /** 写操作失败后保留输入，读取以原生快照响应为准。 */
  async function request<T>(path: string, body?: unknown): Promise<T> {
    const response = await fetch(`/intake-api/teams/${team}/${path}`, body === undefined ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error ?? '操作未完成');
    return result;
  }
  /** 团队切换后重新读取当前团队记录和可用来源。 */
  async function refresh() {
    setError('');
    try {
      const list = await request<{ runs: TeamDocument[] }>(`runs?projectId=${encodeURIComponent(projectId)}`);
      setRuns(list.runs);
      if (team !== 'product') setSources((await request<{ sources: Source[] }>(`sources?projectId=${encodeURIComponent(projectId)}`)).sources);
    } catch (reason) { setError((reason as Error).message); }
  }
  useEffect(() => { setCurrent(undefined); setInputPackage(undefined); setSources([]); setSource(''); void refresh(); }, [team, projectId]);

  /** 输入包确认和撤销均提交原生关口版本，确认后由服务端重读正文启动。 */
  async function packageRequest(action: 'prepare' | 'confirm' | 'revoke') {
    setBusy(true); setError('');
    try {
      const runId = inputPackage?.runId ?? crypto.randomUUID();
      const selected = sources.find(item => `${item.workflow}:${item.runId}` === source);
      const body = action === 'prepare' ? { runId, input: { version: 'team-run-input.v1', team, projectId, iterationId: iteration,
        ...(team === 'product' ? { brief, intakeMode: 'clarify' } : { source: selected && { workflow: selected.workflow, runId: selected.runId, hash: selected.hash } }) } }
        : { action, hash: inputPackage!.hash, comment };
      const response = await fetch(`/intake-api/team-input-packages${action === 'prepare' ? '' : `/${runId}/respond`}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error);
      if (action === 'revoke') setInputPackage(undefined);
      else setInputPackage({ runId, hash: result.steps['prepare-package'].output.hash, confirmed: action === 'confirm' });
    } catch (reason) { setError((reason as Error).message); }
    finally { setBusy(false); }
  }

  /** 每次批准只提交当前保存的版本，响应丢失后允许主动回读。 */
  async function submit(body: unknown) {
    if (!current) return;
    setBusy(true); setError('');
    try { setCurrent(await request<TeamDocument>(`runs/${current.runId}/respond`, body)); setAnswers({}); }
    catch (reason) { setError((reason as Error).message); }
    finally { setBusy(false); }
  }
  /** 新 Run 的 UUID 在发送前固定，失败后保留在当前运行视图供回读。 */
  async function start() {
    const runId = crypto.randomUUID();
    setBusy(true); setError('');
    setCurrent({ runId, brief, status: 'pending' });
    try {
      const input = { version: 'team-run-input.v1', team, projectId, iterationId: iteration,
        ...(team === 'product' ? { brief, intakeMode: 'clarify' } : { source: sources.find(item => `${item.workflow}:${item.runId}` === source) }),
      };
      if ('source' in input && input.source) {
        const { workflow, runId: sourceRunId, hash } = input.source;
        input.source = { workflow, runId: sourceRunId, hash } as Source;
      }
      setCurrent(await request<TeamDocument>('runs', inputPackage?.confirmed ? { runId, inputPackage: { runId: inputPackage.runId, hash: inputPackage.hash } } : { runId, input }));
      await refresh();
    } catch (reason) { setError((reason as Error).message); }
    finally { setBusy(false); }
  }
  return <main className="intake-shell"><header><button disabled={busy} onClick={close}>返回工作台</button><h1>独立团队运行</h1></header>
    <section className="intake-card"><label>团队<select value={team} disabled={busy} onChange={event => setTeam(event.target.value as Team)}>{Object.entries(labels).map(([id, label]) => <option key={id} value={id}>{label}</option>)}</select></label>
      <label>迭代<input value={iteration} onChange={event => setIteration(event.target.value)} /></label>
      {team === 'product' ? <label>需求<textarea value={brief} onChange={event => setBrief(event.target.value)} maxLength={12000} /></label> : <label>来源<select value={source} onChange={event => setSource(event.target.value)}><option value="">选择已核验来源</option>{sources.map(item => <option key={`${item.workflow}:${item.runId}`} value={`${item.workflow}:${item.runId}`}>{item.brief.slice(0, 60)} · {item.runId.slice(0, 8)}</option>)}</select></label>}
      {team !== 'product' && !sources.length && <p>当前项目尚无满足该团队输入要求的来源。</p>}
      <button disabled={busy || !iteration.trim() || (team === 'product' ? !brief.trim() : !source)} onClick={() => void start()}>启动{labels[team]}团队</button>
      <button disabled={busy} onClick={() => void refresh()}>刷新来源与记录</button>
      <button disabled={busy || !!inputPackage || (team === 'product' ? !brief.trim() : !source)} onClick={() => void packageRequest('prepare')}>登记当前输入包</button>
      {inputPackage && <div><p>输入包 {inputPackage.runId} · {inputPackage.confirmed ? '已确认，启动将使用包内材料' : '待确认'}</p><label>确认或撤销意见<input value={comment} onChange={event => setComment(event.target.value)} /></label><button disabled={busy || !comment.trim()} onClick={() => void packageRequest(inputPackage.confirmed ? 'revoke' : 'confirm')}>{inputPackage.confirmed ? '撤销输入包' : '确认输入包'}</button></div>}
    </section>
    {error && <p role="alert">{error}</p>}
    <section className="intake-card"><h2>运行记录</h2>{runs.map(run => <button disabled={busy} key={run.runId} onClick={() => { setCurrent(run); setAnswers({}); }}>{run.brief.slice(0, 40)} · {run.status}</button>)}</section>
    {current && <section className="intake-card"><p>{current.runId} · {current.status} {current.outcome}</p><button disabled={busy} onClick={() => void request<TeamDocument>(`runs/${current.runId}`).then(setCurrent).catch(reason => setError(reason.message))}>回读当前状态</button>
      {current.progress && <div><h2>{current.progress.title}</h2><p>{current.progress.detail}</p><p>{current.progress.next}</p></div>}
      {current.developmentStop && <p>停止原因：{current.developmentStop.reason} · 轮次 {current.developmentStop.rounds} · 调用 {current.developmentStop.calls} · 检查 {current.developmentStop.checkRuns}</p>}
      {current.retry && <div><h2>{current.retry.title}</h2><p>{current.retry.reason}</p><p>{current.retry.impact}</p><button disabled={busy} onClick={() => void submit({ retryHash: current.retry!.hash })}>从当前检查点重试</button></div>}
      {current.intake && <><Markdown>{current.intake.plan.summary}</Markdown><QuestionFlow questions={current.intake.plan.questions} answers={answers} activeId={question} onSelect={setQuestion} onChange={(item, selected, custom) => setAnswers({ ...answers, [item.id]: { questionId: item.id, selected, custom } })} disabled={busy} prefix={current.runId} /><button disabled={busy} onClick={() => void submit({ hash: current.intake!.hash, action: 'refine', answers: Object.values(answers), supplement: '' })}>提交回答</button>{!current.intake.plan.questions.some(item => item.required) && <button disabled={busy} onClick={() => void submit({ hash: current.intake!.hash, action: 'finalize', answers: Object.values(answers), supplement: '' })}>确认方向并写作</button>}</>}
      {current.product && <><Markdown>{current.product.artifact.content}</Markdown><label>审阅意见<textarea value={comment} onChange={event => setComment(event.target.value)} /></label>{(['approve', 'rework', 'reject'] as const).map(decision => <button key={decision} disabled={busy || !comment.trim()} onClick={() => void submit({ role: 'product', artifactHash: current.product!.artifact.hash, decision, comment })}>{{ approve: '批准产品', rework: '退回修改', reject: '结束本轮' }[decision]}</button>)}</>}
      {current.gate && (current.gate.key === 'confirm-project-scope' ? <RepositoryScope projectId={projectId} runId={current.runId} gateHash={current.gate.gateHash} busy={busy} submit={submit} /> : <><WorkflowGateEvidence gate={current.gate} /><WorkflowGateForm key={current.gate.gateHash} gate={current.gate} busy={busy} submit={submit} /></>)}
    </section>}
  </main>;
}
