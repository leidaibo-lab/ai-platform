/** 组合式布局：正文、澄清表单和操作区各自拥有内容，布局不读取或修改 Workflow 事实。 */
import { useId, useState, type ReactNode } from 'react';
import { isQuestionAnswered } from './QuestionFlow';

/** 插槽只承载当前关口的展示内容；操作与版本绑定由调用方拥有。 */
interface WorkspaceProps { children: ReactNode; title: string; panel: ReactNode; actions: ReactNode }

/** 处理区随页面展开；专注模式只切换布局，保留表单节点和未提交草稿。 */
export function RequirementWorkspace({ children, title, panel, actions }: WorkspaceProps) {
  const panelId = useId();
  const [focused, setFocused] = useState(false);
  return <div className={`requirement-workspace${focused ? ' requirement-focused' : ''}`}>
    <a className="requirement-jump" href={`#${panelId}`}>前往{title} ↓</a>
    <div className="requirement-overview">{children}</div>
    <aside className="intake-card requirement-panel" id={panelId} aria-label={title} tabIndex={-1}>
      <div className="requirement-panel-heading"><div><div className="intake-eyebrow">当前待办</div><h2>{title}</h2></div><button type="button" aria-pressed={focused} aria-controls={panelId} onClick={/** 仅切换呈现，不提交或重置回答。 */() => setFocused(!focused)}>{focused ? '并排查看方案' : '展开处理区'}</button></div>
      <div className="requirement-panel-body">{panel}</div>
      <div className="requirement-panel-actions">{actions}</div>
    </aside>
  </div>;
}

/** 问题按服务端顺序展示；草稿只含显式输入，未出现的 ID 一律视为未填写。 */
interface ProgressProps {
  questions: readonly { id: string; title: string; required: boolean }[];
  answers: Readonly<Record<string, { selected: readonly string[]; custom: string }>>;
  prefix: string;
  onSelect?: (id: string) => void;
}

/** 展示当前轮回答进度和定位入口，不把回答数解释为需求覆盖率或实现完成度。 */
export function ClarificationProgress({ questions, answers, prefix, onSelect }: ProgressProps) {
  const answered = questions.filter(/** 推荐不算答案，可选项也必须实际填写。 */question => isQuestionAnswered(answers[question.id])).length;
  const missing = questions.filter(/** 必答缺口与可选空白分别计算。 */question => question.required && !isQuestionAnswered(answers[question.id])).length;
  return <section className="intake-card requirement-completeness" aria-label="需求完善情况">
    <div className="intake-eyebrow">当前轮澄清进度</div>
    <h2>先看方案，逐项确认关键选择</h2>
    <div className="requirement-counts" role="status"><span>已回答 <strong>{answered} / {questions.length}</strong></span><span>必答待补 <strong>{missing}</strong></span></div>
    <p>以下仅统计当前轮问题的回答情况，不代表需求覆盖度或实现进度。提交后才会进入方案修订。</p>
    {questions.length > 0 ? <details><summary>查看本轮问题清单（{questions.length}）</summary><ul className="requirement-question-index">{questions.map(/** 索引定位到同一个问题，不创建第二份答案状态。 */question => {
      const filled = isQuestionAnswered(answers[question.id]);
      return <li key={question.id}><a href={`#${prefix}-${question.id}`} onClick={/** 等待选中题目挂载后再定位，不改变Run深链接。 */event => {
        if (!onSelect) return;
        event.preventDefault(); onSelect(question.id);
        requestAnimationFrame(/** 单题模式切换后移动到对应题目。 */() => {
          const target = document.getElementById(`${prefix}-${question.id}`);
          target?.scrollIntoView({ block: 'nearest' });
        });
      }}>{question.title}</a><small className={filled ? 'answer-filled' : ''}>{filled ? '已回答，待提交' : question.required ? '待回答' : '可选补充'}</small></li>;
    })}</ul></details> : <p>当前没有新增问题，可补充要求或生成完整产品稿。</p>}
  </section>;
}
