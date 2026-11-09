/** 开发阶段回到产品澄清的业务表单；推荐不预选，所有决定绑定当前原生版本。 */
import { useState } from 'react';
import { Markdown } from './components/Markdown';
import { ClarificationProgress, RequirementWorkspace } from './components/RequirementWorkspace';
import type { WorkflowGate } from './WorkflowGate';
import { QuestionFlow, type ClarificationQuestion as Question, type ClarificationAnswer as Answer } from './components/QuestionFlow';
/** 用户提交之前只编辑本地草稿，缺失回答不会消耗暂停点。 */
export function BlockerClarification({ gate, busy, submit }: { gate: WorkflowGate; busy: boolean; submit: (body: unknown) => Promise<void> }) {
  const [answers, setAnswers] = useState<Record<string, Answer>>({});
  const [activeQuestion, setActiveQuestion] = useState('');
  const [reviewer, setReviewer] = useState(''); const [supplement, setSupplement] = useState(''); const [preview, setPreview] = useState(false); const [error, setError] = useState('');
  const questions = gate.evidence.plan.questions as Question[];
  const missing = questions.filter(/** 推荐不算回答，必须实际选择或输入。 */question => question.required && !answers[question.id]?.selected.length && !answers[question.id]?.custom.trim()).length;
  /** 一次只更新当前卡片，修改后重新确认提交后果。 */
  function update(question: Question, selected: string[], custom: string) { setAnswers({ ...answers, [question.id]: { questionId: question.id, selected, custom } }); setPreview(false); }
  /** 显式确认之后才发出单次业务命令，异常保留全部答案。 */
  async function send() {
    setError('');
    try { await submit({ gateHash: gate.gateHash, data: { ...gate.fixed, reviewer: reviewer.trim(), answers: Object.values(answers), supplement } }); setPreview(false); }
    catch (reason) { setError((reason as Error).message); }
  }
  return <RequirementWorkspace title="澄清开工选择" panel={<>
    <fieldset className="requirement-inputs" disabled={busy}><legend className="sr-only">本轮问题与补充</legend>
    <QuestionFlow key={gate.gateHash} questions={questions} answers={answers} activeId={activeQuestion} onSelect={setActiveQuestion} onChange={update} disabled={busy} prefix="blocker-question" />
    <label>其他补充<textarea rows={3} value={supplement} maxLength={4000} onChange={/** 补充会进入本轮修订依据。 */event => { setSupplement(event.target.value); setPreview(false); }} /></label></fieldset>
  </>} actions={<>
<label>确认人<input disabled={busy} value={reviewer} maxLength={100} onChange={/** 标签与本次人工决定一起记录。 */event => { setReviewer(event.target.value); setPreview(false); }} /></label>
    {missing > 0 && <p className="intake-validation" role="status">还有 {missing} 项必答事项，请选择或补充自己的答案。</p>}{!reviewer.trim() && <p className="intake-validation">填写确认人后提交。</p>}{error && <p role="alert">{error}</p>}
    {preview ? <div className="intake-assumptions" role="status"><strong>确认提交这些选择，并生成完整修订产品稿？</strong><p>将调用产品模型修订，原批准稿保留。新稿仍需你确认，不会直接开工。</p><button className="primary" disabled={busy} onClick={/** 最终确认才恢复Workflow。 */() => void send()}>{busy ? '正在修订，请稍候…' : '确认提交并生成修订稿'}</button><button disabled={busy} onClick={/** 返回不会提交或丢弃草稿。 */() => setPreview(false)}>返回检查</button></div> : <button className="primary" disabled={busy || missing > 0 || !reviewer.trim()} onClick={/** 先展示提交后果。 */() => setPreview(true)}>提交选择，生成完整修订产品稿 →</button>}
  </>}>
    <ClarificationProgress questions={questions} answers={answers} prefix="blocker-question" onSelect={setActiveQuestion} />
    <section className="intake-card"><div className="intake-eyebrow">补齐开工选择 · 原需求和已确认产品稿保留</div><h1>{gate.title}</h1><h2>需求分析与整理依据</h2><Markdown>{gate.evidence.plan.summary}</Markdown><p>建议供参考。请逐项选择，或直接填写自己的方案；提交后先生成完整修订稿，由你确认后才重新规划。</p>
    {gate.evidence.referenceNote && <div className="intake-assumptions"><strong>工程资料由系统关联</strong><p>{gate.evidence.referenceNote}</p><p>不需要你上传仓库文档、选择文件或安排开发角色。</p></div>}
    {gate.evidence.plan.assumptions?.length > 0 && <div className="intake-assumptions"><strong>选项中的具体规则建议，请一并核对</strong><ul>{gate.evidence.plan.assumptions.map(/** 复合选项引用的字段和生命周期必须完整展示，不能成为隐藏确认。 */(text: string, index: number) => <li key={index}>{text}</li>)}</ul></div>}
    {gate.evidence.previousAnswers && <details><summary>查看上一轮补充记录</summary><p>上一轮确认人：{gate.evidence.previousAnswers.reviewer}</p><p>{gate.evidence.previousAnswers.supplement}</p></details>}
  </section>
  </RequirementWorkspace>;
}
/** 新版产品稿独立审批，不沿用旧批准，也不直接授权实现。 */
export function RevisedProductReview({ gate, busy, submit }: { gate: WorkflowGate; busy: boolean; submit: (body: unknown) => Promise<void> }) {
  const [reviewer, setReviewer] = useState(''); const [comment, setComment] = useState(''); const [decision, setDecision] = useState<'approve' | 'revise' | 'stop' | null>(null); const [error, setError] = useState('');
  /** 只提交当前新稿版本，重复或旧版本由服务端拒绝。 */
  async function send() { setError(''); try { await submit({ gateHash: gate.gateHash, data: { ...gate.fixed, decision, reviewer, comment } }); setDecision(null); } catch (reason) { setError((reason as Error).message); } }
  return <RequirementWorkspace title="审核与确认修订稿" panel={<>
    <label>确认人<input value={reviewer} maxLength={100} disabled={busy} onChange={/** 编辑后重新确认动作。 */event => { setReviewer(event.target.value); setDecision(null); }} /></label><label>确认说明或需要再修改的地方<textarea rows={3} value={comment} maxLength={2000} disabled={busy} placeholder="例如：本轮选择已准确写入；或说明仍需调整的内容" onChange={/** 反馈用于下一轮修订，不改变当前稿。 */event => { setComment(event.target.value); setDecision(null); }} /></label>
  </>} actions={<>
    {error && <p role="alert">{error}</p>}{decision ? <div className="intake-assumptions" role="status"><strong>{decision === 'approve' ? '批准这份修订产品稿，并在原项目权限内重新规划？' : decision === 'revise' ? '返回业务选择，继续完善这份产品稿？' : '停止本轮流程？'}</strong><p>不会跳过技术方案批准；原稿、回答和本次决定都会保留。</p><button className="primary" disabled={busy} onClick={/** 最终确认后才提交决定。 */() => void send()}>{busy ? '正在处理…' : '确认提交'}</button><button disabled={busy} onClick={/** 取消不恢复Workflow。 */() => setDecision(null)}>返回检查</button></div> : <div className="intake-actions"><button className="primary" disabled={busy || !reviewer.trim() || !comment.trim()} onClick={/** 产品批准与开发方案批准是两个关口。 */() => setDecision('approve')}>批准修订稿，重新规划 →</button><button disabled={busy || !reviewer.trim() || !comment.trim()} onClick={/** 重新澄清，不沿用旧批准。 */() => setDecision('revise')}>返回补充选择</button><button disabled={busy || !reviewer.trim() || !comment.trim()} onClick={/** 停止前再次核对。 */() => setDecision('stop')}>停止本轮</button></div>}
  </>}>
    <section className="intake-card requirement-completeness"><div className="intake-eyebrow">当前成果状态</div><h2>业务选择已提交，修订稿待确认</h2><p>请对照本轮明确选择核对修订结果。批准产品稿后重新规划，实施仍需方案确认。</p></section>
    <section className="intake-card"><div className="intake-eyebrow">完整修订产品稿 · 待你确认</div><h1>{gate.title}</h1><p>原稿和本轮回答已保留。请核对这些选择是否准确进入规则与验收；批准后重新生成技术方案，实施仍需方案确认。</p><details><summary>查看本轮明确选择</summary>{gate.evidence.plan.questions.map(/** 将当前答案映射回提交时的选项文字。 */(question: Question) => { const answer = gate.evidence.answer.answers.find(/** 依据版本化问题ID匹配。 */(item: Answer) => item.questionId === question.id); return <p key={question.id}><strong>{question.title}</strong>：{answer?.selected.map(/** 推荐未被选择时不会出现在确认依据中。 */(id: string) => question.options.find(/** 使用当时选项版本。 */option => option.id === id)?.label).join('；')} {answer?.custom}</p>; })}<p>其他补充：{gate.evidence.answer.supplement || '无'}</p></details><Markdown>{gate.evidence.draft.content}</Markdown><details><summary>对照原批准产品稿</summary><Markdown>{gate.evidence.originalContent}</Markdown></details>
</section>
  </RequirementWorkspace>;
}
