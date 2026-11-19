import { QuestionFlow, type ClarificationAnswer, type ClarificationQuestion } from './QuestionFlow';

interface InlineClarificationNodeProps {
  questions: readonly ClarificationQuestion[];
  questionKey: string;
  answers: Readonly<Record<string, ClarificationAnswer>>;
  activeQuestion: string;
  onSelect: (id: string) => void;
  onChange: (question: ClarificationQuestion, selected: string[], custom: string) => void;
  disabled: boolean;
  prefix: string;
  supplement: string;
  onSupplementChange: (value: string) => void;
  reviewer: string;
  onReviewerChange: (value: string) => void;
  missingRequired: number;
  draftPersisted?: boolean;
  busy: boolean;
  onRefine: () => void;
  onFinalize: () => void;
}

/** 将需求问题渲染为正文流中的人工确认节点，提交动作仍由父级拥有。 */
export function InlineClarificationNode({ questions, questionKey, answers, activeQuestion, onSelect, onChange, disabled, prefix, supplement, onSupplementChange, reviewer, onReviewerChange, missingRequired, draftPersisted, busy, onRefine, onFinalize }: InlineClarificationNodeProps) {
  const canSubmit = !disabled && missingRequired === 0 && !!reviewer.trim();
  return <section className="intake-card inline-confirmation-node" aria-label="需要你确认">
    <div className="inline-confirmation-heading"><div><div className="intake-eyebrow">当前执行需要你的决定</div><h2>需要你确认</h2></div><span>回答后继续当前流程</span></div>
    <fieldset className="requirement-inputs" disabled={disabled}><legend className="sr-only">本轮问题与补充</legend>
      <QuestionFlow key={questionKey} questions={questions} answers={answers} activeId={activeQuestion} onSelect={onSelect} onChange={onChange} disabled={disabled} prefix={prefix} />
      <label>补充输入<textarea rows={3} value={supplement} maxLength={4000} placeholder="补充你的判断或边界" onChange={/** 补充与当前问题回答一并保存。 */event => onSupplementChange(event.target.value)} /></label>
    </fieldset>
    <div className="inline-confirmation-actions">
      <label>确认人（本地标签）<input disabled={disabled} value={reviewer} maxLength={100} onChange={/** 标签不暗示认证身份。 */event => onReviewerChange(event.target.value)} /></label>
      {draftPersisted === true && <small role="status">草稿已保存在此标签页，刷新后可恢复。</small>}
      {draftPersisted === false && <small role="status">草稿未能保存到浏览器，请提交后再离开。</small>}
      <p className="run-activity-copy">提交后会检查业务缺口。有缺口时继续澄清，满足条件后生成产品稿。</p>
      <div className="intake-actions">
        <button disabled={!canSubmit} onClick={onRefine}>提交回答并继续澄清</button>
        <button className="primary" disabled={!canSubmit} onClick={onFinalize}>提交回答并检查缺口 →</button>
      </div>
      {!busy && missingRequired > 0 && <p className="intake-validation" role="status">还有 {missingRequired} 个必答问题未完成，请补齐后提交。</p>}
      {!busy && missingRequired === 0 && !reviewer.trim() && <p className="intake-validation">请填写确认人后提交。</p>}
    </div>
  </section>;
}
