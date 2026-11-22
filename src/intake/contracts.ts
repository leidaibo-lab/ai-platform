/** 需求澄清的版本化数据；模型建议与人工决定分开保存，快照拥有事实。 */
import { z } from 'zod';
import { createHash } from 'node:crypto';
const text = z.string().trim().min(1).max(4000);
/** 需求入口的两种协作策略；clarify 保留人工逐项对齐，autofill 由 AI 先生成可审阅初稿。 */
export const intakeModeSchema = z.enum(['clarify', 'autofill']);
export type IntakeMode = z.infer<typeof intakeModeSchema>;
/** 模型解释未决项的业务影响；历史问题可缺省，不补写旧判断。 */
export const questionDecisionSchema = z.object({ blocks: z.enum(['product', 'development', 'none']), reason: text, unanswered: text });
/** 各业务维度分别给出判断依据；题数与轮次不代表成熟度。 */
export const maturitySchema = z.object({
  decisions: z.object({ clear: z.boolean(), evidence: text }),
  mainFlow: z.object({ clear: z.boolean(), evidence: text }),
  exceptions: z.object({ clear: z.boolean(), evidence: text }),
  delivery: z.object({ clear: z.boolean(), evidence: text }),
});
export const planSchema = z.object({
  maturity: maturitySchema.optional(),
  summary: text, assumptions: z.array(text).max(12),
  questions: z.array(z.object({ id: z.string().regex(/^[a-zA-Z0-9_-]{1,60}$/), title: text, reason: text, required: z.boolean(), decision: questionDecisionSchema.optional(), kind: z.enum(['single', 'multiple', 'text']), options: z.array(z.object({ id: text, label: text })).max(8), recommendation: text })).max(8),
}).superRefine(
  // 模型问题必须唯一，选项必须可寻址；不接受损坏的业务表单。
  (plan, context) => {
    if (new Set(plan.questions.map(/** 取问题标识。 */q => q.id)).size !== plan.questions.length) context.addIssue({ code: 'custom', message: '问题 ID 重复' });
    for (const q of plan.questions) {
      if (q.decision && q.required !== (q.decision.blocks !== 'none')) context.addIssue({ code: 'custom', message: '问题分类与必答标记冲突' });
      if (new Set(q.options.map(/** 取选项标识。 */o => o.id)).size !== q.options.length || (q.kind !== 'text' && !q.options.length)) context.addIssue({ code: 'custom', message: '问题选项无效' });
    }
  },
);
/** 新输出强制依据和当前阶段；旧快照仍由兼容planSchema读取。 */
export const generatedPlanSchema = planSchema.safeExtend({ maturity: maturitySchema, questions: z.array(planSchema.shape.questions.element.extend({ decision: questionDecisionSchema })).max(8) }).superRefine(/** 初始需求不能声称已评估开发开工门槛。 */(plan, context) => {
  if (plan.questions.some(/** 必答在当前产品阶段处理。 */question => question.decision.blocks === 'development')) context.addIssue({ code: 'custom', message: '需求问题阻塞阶段错误' });
});
export const answerSchema = z.object({ questionId: text, selected: z.array(text).max(8), custom: z.string().trim().max(4000) });
export const responseSchema = z.object({ hash: z.string().regex(/^[a-f0-9]{64}$/), action: z.enum(['refine', 'finalize']), reviewer: z.string().trim().min(1).max(100), answers: z.array(answerSchema).max(8), supplement: z.string().trim().max(4000) });
const workspaceReadSchema = z.object({ path: z.string().min(1), sourceHash: z.string().regex(/^[a-f0-9]{64}$/) });
export const intakeSchema = z.object({ intakeMode: intakeModeSchema.optional(), enabled: z.boolean(), ready: z.boolean(), round: z.number().int().min(0), plan: planSchema.optional(), hash: z.string().optional(), workspaceReads: z.array(workspaceReadSchema).optional(), history: z.array(z.object({ plan: planSchema, response: responseSchema, workspaceReads: z.array(workspaceReadSchema).optional() })) });
/** 恢复输入同时保存服务端核对过的暂停版本，供模型失败后使用。 */
export const alignmentResumeSchema = z.object({ intake: intakeSchema, response: responseSchema });
export type Intake = z.infer<typeof intakeSchema>;
/** 已确认规则是由人工提交答案派生的只读视图，不把推荐或假设升级为业务事实。 */
export const confirmedDecisionSchema = z.object({
  round: z.number().int().min(1),
  questionId: text,
  question: text,
  selected: z.array(z.object({ id: text, label: text })).max(8),
  custom: z.string().trim().max(4000),
  reviewer: z.string().trim().min(1).max(100),
});
export type ConfirmedDecision = z.infer<typeof confirmedDecisionSchema>;

/** 将历史中的显式选择/填写规范化为产品稿可消费的确认基线；未回答推荐不进入结果。 */
export function collectConfirmedDecisions(intake: Intake): ConfirmedDecision[] {
  const decisions: ConfirmedDecision[] = [];
  intake.history.forEach((entry, index) => {
    entry.response.answers.forEach(answer => {
      const question = entry.plan.questions.find(item => item.id === answer.questionId);
      if (!question) return;
      const selected = answer.selected.flatMap(id => {
        const option = question.options.find(item => item.id === id);
        return option ? [{ id: option.id, label: option.label }] : [];
      });
      const custom = answer.custom.trim();
      if (!selected.length && !custom) return;
      decisions.push(confirmedDecisionSchema.parse({ round: index + 1, questionId: question.id, question: question.title, selected, custom, reviewer: entry.response.reviewer }));
    });
  });
  return decisions;
}
/** 评估仅消费已提交的回答和补充；原始逐轮问题卡继续保存在 Workflow 快照。 */
export function assessmentHistory(intake: Intake) {
  return intake.history.map((entry, index) => ({
    round: index + 1,
    reviewer: entry.response.reviewer,
    action: entry.response.action,
    supplement: entry.response.supplement,
    answers: entry.response.answers.map(answer => ({
      question: entry.plan.questions.find(question => question.id === answer.questionId)?.title ?? answer.questionId,
      selected: answer.selected.map(id => entry.plan.questions.find(question => question.id === answer.questionId)?.options.find(option => option.id === id)?.label ?? id),
      custom: answer.custom,
    })),
  }));
}
/** 最新分析各业务维度均明确且没有必答缺口时，才允许请求结束澄清。 */
export function canFinalizePlan(plan: z.infer<typeof planSchema>): boolean {
  return !!plan.maturity && Object.values(plan.maturity).every(/** 每个维度均需有判断。 */item => item.clear) && !plan.questions.some(/** 必答问题仍然表示关键缺口。 */question => question.required);
}
/** 已明确受限研发范围时，只将重复的公司书面治理制度归入发布待决，不降级其他业务问题。 */
export function classifyPublicationDependency(plan: z.infer<typeof generatedPlanSchema>, history: Intake['history']) {
  const governance = history.some(entry => entry.response.answers.some(answer =>
    /governance|data_lifecycle|resume-retention/i.test(answer.questionId)
    && /合成数据|合成资料/.test(answer.custom)
    && /真实.*(关闭|禁止|受阻)|不得导入真实/.test(answer.custom)
    && /书面|法务/.test(answer.custom)));
  if (!governance || !plan.maturity.decisions.clear || !plan.maturity.mainFlow.clear || !plan.maturity.exceptions.clear) return plan;
  const repeated = plan.questions.filter(question => question.required && /governance[_-]?policy|data[_-]?lifecycle/i.test(question.id) && /书面|保留|隐私/.test(question.title));
  if (!repeated.length || plan.questions.some(question => question.required && !repeated.includes(question))) return plan;
  return generatedPlanSchema.parse({
    ...plan,
    questions: plan.questions.map(question => repeated.includes(question) ? { ...question, required: false, decision: { blocks: 'none', reason: '仅合成数据研发验收；公司制度仍阻断真实资料导入和正式发布', unanswered: question.decision.unanswered } } : question),
    maturity: { ...plan.maturity, delivery: { clear: true, evidence: '本期受控研发与验收范围已收敛，可进入待审双文档写作；尚未生成的正文由后续节点完成。公司书面治理制度仍是发布阻断项，不得导入真实资料。' } },
  });
}
/** 只消除“文档尚未写出所以不能开始写作”的循环依赖；业务或交付其他缺口照常阻断。 */
export function classifyWritingPrerequisite(plan: z.infer<typeof generatedPlanSchema>) {
  if (plan.questions.some(question => question.required) || !plan.maturity.decisions.clear || !plan.maturity.mainFlow.clear || !plan.maturity.exceptions.clear || plan.maturity.delivery.clear) return plan;
  const evidence = plan.maturity.delivery.evidence;
  if (!/(尚未|未|没有|待).{0,18}(生成|输出|编写|完成|形成|撰写).{0,18}(正式|需求|产品|双文档|PRD|项目总览|模块|用户故事|测试场景|验收映射)|(?:正式|需求|产品|双文档|PRD|项目总览|模块|用户故事|测试场景|验收映射).{0,18}(尚未|未|没有|待).{0,18}(生成|输出|编写|完成|形成|撰写)/.test(evidence)) return plan;
  if (/(仍|还|尚).{0,12}(缺少|缺乏|未明确|未确认).{0,20}(业务|权限|字段|状态|流程|异常|验收边界)/.test(evidence)) return plan;
  return generatedPlanSchema.parse({ ...plan, maturity: { ...plan.maturity, delivery: { clear: true, evidence: `${evidence}；上述正式交付由后续产品写作和审查完成，不是启动写作的前置条件。` } } });
}
/** 散列绑定原始需求、轮次、建议与历史，避免旧卡片答案用于新方案。 */
export function intakeHash(brief: string, intake: Intake): string {
  return createHash('sha256').update(JSON.stringify({ brief, round: intake.round, plan: intake.plan, history: intake.history, ...(intake.workspaceReads ? { workspaceReads: intake.workspaceReads } : {}) })).digest('hex');
}
/** 在恢复前和节点内双重校验，所有必答项必须有显式答案；推荐不算确认。 */
export function validateAnswers(intake: Intake, value: unknown) {
  const response = responseSchema.parse(value);
  if (!intake.plan || response.hash !== intake.hash) throw new Error('方案版本已变化，请刷新');
  const answers = new Map(response.answers.map(/** 以 ID 关联用户输入。 */a => [a.questionId, a]));
  if (answers.size !== response.answers.length) throw new Error('回答重复');
  for (const a of response.answers) if (!intake.plan.questions.some(/** 拒绝未知问题。 */q => q.id === a.questionId)) throw new Error('未知问题');
  for (const q of intake.plan.questions) {
    const a = answers.get(q.id);
    if (q.required && (!a || (!a.selected.length && !a.custom))) throw new Error('请回答所有必答问题');
    if (!a) continue;
    if (new Set(a.selected).size !== a.selected.length || a.selected.some(/** 选项仅允许当前服务端计划。 */id => !q.options.some(/** 匹配选项 ID。 */o => o.id === id)) || (q.kind === 'single' && a.selected.length > 1) || (q.kind === 'text' && a.selected.length)) throw new Error('回答选项无效');
  }
  return response;
}

/** 校验并记录本轮人工决定，补充内容交由同一方向步骤重新评估。 */
export function applyIntakeResponse(intake: Intake, value: unknown): Intake {
  const response = validateAnswers(intake, value);
  return { ...intake, ready: response.action === 'finalize' && canFinalizePlan(intake.plan!) && !response.answers.length && !response.supplement, history: [...intake.history, { plan: intake.plan!, response, ...(intake.workspaceReads ? { workspaceReads: intake.workspaceReads } : {}) }] };
}
