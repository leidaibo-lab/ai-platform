/** 需求澄清的版本化数据；模型建议与人工决定分开保存，快照拥有事实。 */
import { z } from 'zod';
import { createHash } from 'node:crypto';
const text = z.string().trim().min(1).max(4000);
/** 模型解释未决项的业务影响；历史问题可缺省，不补写旧判断。 */
export const questionDecisionSchema = z.object({ blocks: z.enum(['product', 'development', 'none']), reason: text, unanswered: text });
/** 两处澄清复用同一判断标准，具体业务证据仍由当前输入提供。 */
export const questionDecisionInstructions = '主动区分必答与可选，不要把所有细节都设为必答。每题必须提供decision:{blocks:"product"|"development"|"none",reason:string,unanswered:string}。仅当未决选择影响本期范围、权限、核心流程、验收或已确认答案存在冲突时设required:true，并说明影响哪条结果及为什么当前不能继续确认；初始需求blocks为product，开发阻塞blocks为development。可延后细节/增强/偏好设required:false、blocks:none，说明不回答时明确保留待决或排除本期；不能默认采用推荐或擅自编造规则。已有人类回答不要重问。';
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
export const intakeSchema = z.object({ enabled: z.boolean(), ready: z.boolean(), round: z.number().int().min(0), plan: planSchema.optional(), hash: z.string().optional(), history: z.array(z.object({ plan: planSchema, response: responseSchema })) });
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
/** 最新分析各业务维度均明确且没有必答缺口时，才允许请求结束澄清。 */
export function canFinalizePlan(plan: z.infer<typeof planSchema>): boolean {
  return !!plan.maturity && Object.values(plan.maturity).every(/** 每个维度均需有判断。 */item => item.clear) && !plan.questions.some(/** 必答问题仍然表示关键缺口。 */question => question.required);
}
/** 散列绑定原始需求、轮次、建议与历史，避免旧卡片答案用于新方案。 */
export function intakeHash(brief: string, intake: Intake): string {
  return createHash('sha256').update(JSON.stringify({ brief, round: intake.round, plan: intake.plan, history: intake.history })).digest('hex');
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
