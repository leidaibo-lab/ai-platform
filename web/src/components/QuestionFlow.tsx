/** 受控问题向导：只拥有展示方式；答案和提交权限始终由业务表单持有。 */
import { useId, useRef, useState } from 'react';

/** 服务端问题的只读展示契约；推荐不等于答案。 */
export interface ClarificationQuestion {
  id: string; title: string; reason: string; recommendation: string; required: boolean;
  kind: 'single' | 'multiple' | 'text'; options: { id: string; label: string }[];
  decision?: { blocks: 'product' | 'development' | 'none'; reason: string; unanswered: string };
}
/** 未提交答案由调用方管理，切题、切换布局均不创建副本。 */
export interface ClarificationAnswer { questionId: string; selected: string[]; custom: string }
interface QuestionFlowProps {
  questions: readonly ClarificationQuestion[];
  answers: Readonly<Record<string, ClarificationAnswer>>;
  activeId: string;
  onSelect: (id: string) => void;
  onChange: (question: ClarificationQuestion, selected: string[], custom: string) => void;
  disabled: boolean;
  prefix: string;
}

/** 必答和可选题使用相同填写规则；不把系统推荐计入已回答数量。 */
export function isQuestionAnswered(answer?: { readonly selected: readonly string[]; readonly custom: string }): boolean {
  return !!answer && (answer.selected.length > 0 || !!answer.custom.trim());
}

/** 一次聚焦一题，支持跳题和全部查看；导航永不触发 Workflow 提交。 */
export function QuestionFlow({ questions, answers, activeId, onSelect, onChange, disabled, prefix }: QuestionFlowProps) {
  // 必答先行，同组保留服务端顺序；不修改原问题、ID或版本。
  questions = [...questions.filter(/** 必答是当前提交门槛。 */question => question.required), ...questions.filter(/** 可选空白不阻止提交。 */question => !question.required)];
  const [showAll, setShowAll] = useState(false);
  const heading = useRef<HTMLDivElement>(null);
  const navId = useId();
  const [navOpen, setNavOpen] = useState(false);
  const activeIndex = Math.max(0, questions.findIndex(/** 当前ID不属于本轮时回到首题。 */question => question.id === activeId));
  const answered = questions.filter(/** 统计实际填写，切题不改变完成状态。 */question => isQuestionAnswered(answers[question.id])).length;
  const missing = questions.filter(/** 可选空白不构成提交阻塞。 */question => question.required && !isQuestionAnswered(answers[question.id]));
  /** 导航完成后聚焦题目区域，长题翻页时避免停留在页面下方。 */
  function select(id: string) {
    onSelect(id); setNavOpen(false);
    requestAnimationFrame(/** 等待题目渲染后移动阅读位置。 */() => {
      heading.current?.focus({ preventScroll: true });
      heading.current?.scrollIntoView({ block: 'nearest' });
    });
  }
  if (!questions.length) return <p>当前没有新增关键问题，可补充要求后继续。</p>;
  return <div className="question-flow">
    <div className="question-flow-heading" ref={heading} tabIndex={-1}>
      <div className="question-flow-status" role="status"><strong>{showAll ? `全部 ${questions.length} 个问题` : `问题 ${activeIndex + 1} / ${questions.length}`}</strong><span>已回答 {answered} · 必答待补 {missing.length}</span></div>
      <progress max={questions.length} value={answered} aria-label="本轮已回答问题数" />
      <div className="question-flow-tools"><button type="button" aria-expanded={navOpen} aria-controls={navId} onClick={/** 目录仅帮助定位，不代替实际回答。 */() => setNavOpen(!navOpen)}>问题目录</button><button type="button" aria-pressed={showAll} onClick={/** 所有输入均由父级持有，切换不丢失草稿。 */() => setShowAll(!showAll)}>{showAll ? '逐题填写' : '查看全部问题'}</button></div>
    </div>
    <div className="question-groups" aria-label="按回答要求分组">{[true, false].map(/** 分组只依赖服务端必答标记，不从文案猜测优先级。 */required => {
      const group = questions.filter(/** 筛出同组问题并保留内部顺序。 */question => question.required === required);
      const first = group.find(/** 优先定位本组未填问题，全部填过可回看第一题。 */question => !isQuestionAnswered(answers[question.id])) ?? group[0];
      return <button type="button" key={String(required)} disabled={!first} aria-pressed={questions[activeIndex]?.required === required} onClick={/** 切组只定位，不自动填答或提交。 */() => { setShowAll(false); if (first) select(first.id); }}>{required ? '当前必答' : '可选补充'} <strong>{group.length}</strong></button>;
    })}</div>
    {navOpen && <nav id={navId} aria-label="本轮问题目录" className="question-flow-directory">{questions.map(/** 目录同时提示分组及实际填写状态。 */(question, index) => <button type="button" key={question.id} aria-current={index === activeIndex ? 'step' : undefined} onClick={/** 从全部模式返回对应的单题处理。 */() => { setShowAll(false); select(question.id); }}><span>{question.required ? '必答' : '可选'} · {index + 1}. {question.title}</span><small>{isQuestionAnswered(answers[question.id]) ? '已填写' : question.required ? '待回答' : '可选'}</small></button>)}</nav>}
    <p className="question-flow-hint">选择或填写自己的答案。推荐供参考，翻题不会提交。</p>
    {questions.map(/** 单题模式只渲染当前题；受控答案保证返回时原样呈现。 */(question, index) => {
      if (!showAll && index !== activeIndex) return null;
      const answer = answers[question.id] ?? { questionId: question.id, selected: [], custom: '' };
      return <div key={question.id}>{showAll && (index === 0 || questions[index - 1].required !== question.required) && <h3 className="question-group-title">{question.required ? '当前必答 · 确认后继续' : '可选补充 · 可暂不回答'}</h3>}<fieldset id={`${prefix}-${question.id}`} disabled={disabled} className="question-flow-card"><legend>{showAll ? `${index + 1}. ` : ''}{question.title} <small>{question.required ? '必须确认' : '可选补充'}</small></legend>
        <div className={`question-decision${question.required ? ' question-decision-required' : ''}`}><strong>{question.required ? '为什么必须确认' : '为什么可以后续完善'}</strong><p>{question.decision?.reason ?? question.reason}</p><p>{question.decision ? `${question.decision.blocks === 'product' ? '影响产品确认' : question.decision.blocks === 'development' ? '影响开工条件确认' : '不阻止本轮继续'}：${question.decision.unanswered}` : question.required ? '未回答时不能提交本轮选择。' : '未回答不会视为接受推荐。'}</p></div>
        <p>{question.reason}</p><div className="intake-recommendation">建议：{question.recommendation}</div>
        {question.options.map(/** 单选替换、多选增删；不做推荐预选。 */option => <label className="intake-option" key={option.id}><input type={question.kind === 'multiple' ? 'checkbox' : 'radio'} name={`${prefix}-${question.id}`} checked={answer.selected.includes(option.id)} onChange={/** 选择只更新本题草稿，不自动跳转或确认。 */event => onChange(question, question.kind === 'multiple' ? event.target.checked ? [...answer.selected, option.id] : answer.selected.filter(/** 只移除当前选项。 */id => id !== option.id) : [option.id], answer.custom)} />{option.label}</label>)}
        <label>{question.kind === 'text' ? '你的回答' : '自己的方案或补充说明'}<textarea rows={3} maxLength={4000} value={answer.custom} onChange={/** 自定义文字可独立完成回答。 */event => onChange(question, answer.selected, event.target.value)} /></label>
      </fieldset></div>;
    })}
    {!showAll && <div className="question-flow-pagination"><button type="button" disabled={activeIndex === 0} onClick={/** 返回上一题，不撤销已填写内容。 */() => select(questions[activeIndex - 1].id)}>← 上一题</button>{activeIndex < questions.length - 1 ? <button type="button" onClick={/** 允许跳过当前题，提交前仍由业务层检查必答项。 */() => select(questions[activeIndex + 1].id)}>下一题 →</button> : missing.length > 0 ? <button type="button" onClick={/** 最后一题直接定位首个未回答必答题。 */() => select(missing[0].id)}>补齐未回答问题 →</button> : <span role="status">必答已填齐，可核对后提交</span>}</div>}
  </div>;
}
