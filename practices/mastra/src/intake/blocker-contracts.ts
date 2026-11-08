import { remoteHandoffSchema } from '../delivery/remote-handoff.js';
/** 开发阻塞澄清契约；原稿、问题建议、人工答案与新稿审批分别保存。 */
import { z } from 'zod';
import { planSchema, answerSchema } from './contracts.js';
import { stateV2Schema, inputV2Schema, type StateV2 } from '../development/v2/contracts.js';
import { artifactSchema, deliverySchema } from '../mastra/workflows/delivery.js';
import { developmentHash } from '../development/contracts.js';
export const blockerQuestionSchema = planSchema.shape.questions.element.extend({ blockerIds: z.array(z.string()).min(1).max(20) });
export const blockerPlanSchema = planSchema.safeExtend({ questions: z.array(blockerQuestionSchema).max(16) });
export const blockerAnswerSchema = z.object({ hash: z.string().length(64), reviewer: z.string().trim().min(1).max(100), answers: z.array(answerSchema).max(16), supplement: z.string().trim().max(4000) });
export const revisedProductReviewSchema = z.object({ hash: z.string().length(64), decision: z.enum(['approve', 'revise', 'stop']), reviewer: z.string().trim().min(1).max(100), comment: z.string().trim().min(1).max(2000) });
export const blockerCycleSchema = z.object({ repositoryHandoff: remoteHandoffSchema.optional(),
  development: stateV2Schema, approvedProduct: deliverySchema,
  round: z.number().int().positive(), plan: blockerPlanSchema.optional(), answer: blockerAnswerSchema.optional(), draft: artifactSchema.optional(), review: revisedProductReviewSchema.optional(),
  references: z.record(z.string(), z.string()).default({}), referenceNote: z.string().default(''),
  business: z.array(z.object({ id: z.string(), text: z.string() })).default([]), engineering: z.array(z.string()).default([]),
  nextInput: inputV2Schema.optional(), stopped: z.boolean().default(false),
  history: z.array(z.object({ sourceHash: z.string(), plan: blockerPlanSchema, answer: blockerAnswerSchema, draft: artifactSchema, review: revisedProductReviewSchema })).default([]),
});
export type BlockerCycle = z.infer<typeof blockerCycleSchema>;
/** 只有明确的仓库资料缺口由工程侧补齐，其余阻塞默认进入业务澄清。 */
export function splitBlockers(blockers: string[]) {
  const business: BlockerCycle['business'] = []; const engineering: string[] = [];
  blockers.forEach(/** 稳定标识绑定原始条目，模型不能自行删除业务问题。 */(text, index) => { if (!/^U\d+/.test(text) && /^工程上下文缺口/.test(text)) engineering.push(text); else business.push({ id: `blocker-${index + 1}`, text }); });
  return { business, engineering };
}
/** 架构及开工检查提出的业务缺口都应回到问题卡片，不遗漏就绪阶段发现。 */
export function developmentBlockers(state: StateV2): string[] {
  return [...new Set([...(state.plan?.blockers ?? []), ...(state.readiness?.assessment.findings.filter(/** 技术发现仍由开发侧处理，业务选择由用户确认。 */finding => finding.category === 'business').map(/** 保留原发现描述作为澄清依据。 */finding => `就绪检查业务待决：${finding.detail}`) ?? [])])];
}
/** 每个业务阻塞必须有可回答的必答卡片；建议不能直接变成确认结果。 */
export function validateBlockerPlan(plan: z.infer<typeof blockerPlanSchema>, state: BlockerCycle): void {
  const ids = new Set(state.business.map(/** 原始阻塞作为唯一覆盖集合。 */item => item.id));
  const covered = new Set<string>();
  for (const question of plan.questions) { if (!question.required) throw new Error('业务阻塞必须显式回答'); for (const id of question.blockerIds) { if (!ids.has(id)) throw new Error('问题引用未知阻塞'); covered.add(id); } }
  if (covered.size !== ids.size) throw new Error('问题卡片遗漏业务阻塞');
}
/** 绑定当前产品、方案与问题；工程资料观察也参与版本，避免旧表单污染新稿。 */
export function blockerHash(state: BlockerCycle): string { return developmentHash({ sourceHash: state.development.input.source.hash, planHash: state.development.planHash, readinessHash: state.development.readiness?.hash, business: state.business, engineering: state.engineering, round: state.round, plan: state.plan, references: state.references, referenceNote: state.referenceNote, history: state.history }); }
/** 服务端恢复前和原生节点内都校验，未知问题/选项及必答缺失不消耗暂停点。 */
export function validateBlockerAnswers(state: BlockerCycle, input: unknown) {
  const answer = blockerAnswerSchema.parse(input);
  if (!state.plan || answer.hash !== blockerHash(state)) throw new Error('澄清问题版本已变化，请刷新');
  const answers = new Map(answer.answers.map(/** 不允许重复答案覆盖前一个提交。 */item => [item.questionId, item]));
  if (answers.size !== answer.answers.length) throw new Error('回答重复');
  for (const a of answer.answers) if (!state.plan.questions.some(/** 客户端不能注入新的业务问题。 */question => question.id === a.questionId)) throw new Error('未知问题');
  for (const q of state.plan.questions) {
    const a = answers.get(q.id);
    if (q.required && (!a || (!a.selected.length && !a.custom))) throw new Error('请回答全部必答事项');
    if (!a) continue;
    if (a.selected.some(/** 泛指其他方案必须写明内容，否则仍是业务缺口。 */id => /^(other|custom)$/i.test(id)) && !a.custom) throw new Error('选择其他方案时请补充具体说明');
    if (new Set(a.selected).size !== a.selected.length || a.selected.some(/** 仅当前卡片中的选项可以提交。 */id => !q.options.some(/** 以版本化选项ID匹配。 */option => option.id === id)) || (q.kind === 'single' && a.selected.length > 1) || (q.kind === 'text' && a.selected.length)) throw new Error('回答选项无效');
  }
  return answer;
}
