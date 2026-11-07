/** 需求澄清的版本化数据；模型建议与人工决定分开保存，快照拥有事实。 */
import { z } from 'zod';
import { createHash } from 'node:crypto';
const text = z.string().trim().min(1).max(4000);
export const planSchema = z.object({
  summary: text, assumptions: z.array(text).max(12),
  questions: z.array(z.object({ id: z.string().regex(/^[a-zA-Z0-9_-]{1,60}$/), title: text, reason: text, required: z.boolean(), kind: z.enum(['single', 'multiple', 'text']), options: z.array(z.object({ id: text, label: text })).max(8), recommendation: text })).max(8),
}).superRefine(
  // 模型问题必须唯一，选项必须可寻址；不接受损坏的业务表单。
  (plan, context) => {
    if (new Set(plan.questions.map(/** 取问题标识。 */q => q.id)).size !== plan.questions.length) context.addIssue({ code: 'custom', message: '问题 ID 重复' });
    for (const q of plan.questions) {
      if (new Set(q.options.map(/** 取选项标识。 */o => o.id)).size !== q.options.length || (q.kind !== 'text' && !q.options.length)) context.addIssue({ code: 'custom', message: '问题选项无效' });
    }
  },
);
export const answerSchema = z.object({ questionId: text, selected: z.array(text).max(8), custom: z.string().trim().max(4000) });
export const responseSchema = z.object({ hash: z.string().regex(/^[a-f0-9]{64}$/), action: z.enum(['refine', 'finalize']), reviewer: z.string().trim().min(1).max(100), answers: z.array(answerSchema).max(8), supplement: z.string().trim().max(4000) });
export const intakeSchema = z.object({ enabled: z.boolean(), ready: z.boolean(), round: z.number().int().min(0).max(4), plan: planSchema.optional(), hash: z.string().optional(), history: z.array(z.object({ plan: planSchema, response: responseSchema })).max(4) });
export type Intake = z.infer<typeof intakeSchema>;
/** 散列绑定原始需求、轮次、建议与历史，避免旧卡片答案用于新方案。 */
export function intakeHash(brief: string, intake: Intake): string {
  return createHash('sha256').update(JSON.stringify({ brief, round: intake.round, plan: intake.plan, history: intake.history })).digest('hex');
}
/** 在恢复前和节点内双重校验，所有必答项必须有显式答案；推荐不算确认。 */
export function validateAnswers(intake: Intake, value: unknown) {
  const response = responseSchema.parse(value);
  if (!intake.plan || response.hash !== intake.hash) throw new Error('方案版本已变化，请刷新');
  if (response.action === 'refine' && intake.round >= 4) throw new Error('已达四轮，请补齐回答生成完整稿或另起需求');
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
