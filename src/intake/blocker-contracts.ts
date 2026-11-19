import { remoteHandoffSchema } from '../delivery/remote-handoff.js';
/** 开发阻塞澄清契约；原稿、问题建议、人工答案与新稿审批分别保存。 */
import { z } from 'zod';
import { planSchema, answerSchema, questionDecisionSchema } from './contracts.js';
import { stateV2Schema, inputV2Schema, type StateV2 } from '../development/v2/contracts.js';
import { artifactSchema, deliverySchema } from '../mastra/workflows/delivery.js';
import { developmentHash } from '../development/contracts.js';
import { unresolvedV2 } from '../development/v2/gates.js';
import { downstreamProductReworkSchema } from '../mastra/workflows/product-rework.js';
export const blockerQuestionSchema = planSchema.shape.questions.element.extend({ blockerIds: z.array(z.string()).max(20) });
export const blockerPlanSchema = planSchema.safeExtend({ questions: z.array(blockerQuestionSchema).max(16) });
/** 新开发澄清必须解释开工影响；兼容历史卡片时不虚构依据。 */
export const generatedBlockerPlanSchema = blockerPlanSchema.safeExtend({ questions: z.array(z.discriminatedUnion('required', [
  blockerQuestionSchema.extend({ required: z.literal(true), blockerIds: z.array(z.string()).min(1).max(20), decision: questionDecisionSchema.extend({ blocks: z.literal('development') }) }),
  blockerQuestionSchema.extend({ required: z.literal(false), blockerIds: z.array(z.string()).max(0), decision: questionDecisionSchema.extend({ blocks: z.literal('none') }) }),
])).max(16) });
/** 有业务阻塞时向模型暴露非空约束，完整覆盖仍由宿主校验。 */
export function generatedBlockerPlanForCount(count: number) {
  return generatedBlockerPlanSchema.safeExtend({ questions: generatedBlockerPlanSchema.shape.questions.min(count > 0 ? 1 : 0) });
}
export const blockerAnswerSchema = z.object({ hash: z.string().length(64), reviewer: z.string().trim().min(1).max(100), answers: z.array(answerSchema).max(16), supplement: z.string().trim().max(4000) });
export const revisedProductReviewSchema = z.object({ hash: z.string().length(64), decision: z.enum(['approve', 'revise', 'stop']), reviewer: z.string().trim().min(1).max(100), comment: z.string().trim().min(1).max(2000) });
export const blockerCycleSchema = z.object({ repositoryHandoff: remoteHandoffSchema.optional(),
  development: stateV2Schema, approvedProduct: deliverySchema,
  round: z.number().int().positive(), plan: blockerPlanSchema.optional(), answer: blockerAnswerSchema.optional(), draft: artifactSchema.optional(), review: revisedProductReviewSchema.optional(),
  references: z.record(z.string(), z.string()).default({}), referenceNote: z.string().default(''),
  business: z.array(z.object({ id: z.string(), text: z.string() })).default([]), engineering: z.array(z.string()).default([]),
  productReworkDecision: downstreamProductReworkSchema.optional(),
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
/** 读取当前版本的结构化业务发现，保留需求和 QA 用例等原始引用。 */
export function businessGapFindings(state: StateV2) {
  return [...(state.readiness?.assessment.findings ?? []), ...unresolvedV2(state)]
    .filter(/** 只使用明确归属产品的发现。 */ finding => finding.category === 'business' || finding.route === 'product');
}

/** 将下游各阶段保存的业务缺口统一转成澄清输入。 */
export function developmentBlockers(state: StateV2): string[] {
  const blockers = [...(state.plan?.blockers ?? [])];
  for (const finding of businessGapFindings(state)) {
    if (!blockers.includes(finding.detail) && !blockers.some(/** QA 和历史发布已将部分发现投影到阻塞清单。 */ blocker => blocker.endsWith(`业务待决：${finding.detail}`))) {
      blockers.push(`业务待决：${finding.detail}`);
    }
  }
  if (state.stopReason === 'business-decision') {
    for (const entry of state.work.filter(/** 只读取本轮实现明确记录的业务阻塞。 */ item => item.round === state.round && ['frontend', 'backend', 'infrastructure'].includes(item.role))) {
      for (const line of entry.text.split('\n')) {
        const detail = /BUSINESS_BLOCKER:\s*(.+)/.exec(line)?.[1]?.trim();
        if (detail) blockers.push(detail);
      }
    }
  }
  return [...new Set(blockers)];
}
/** 每个业务阻塞必须有可回答的必答卡片；建议不能直接变成确认结果。 */
export function validateBlockerPlan(plan: z.infer<typeof blockerPlanSchema>, state: BlockerCycle): void {
  const ids = new Set(state.business.map(/** 原始阻塞作为唯一覆盖集合。 */item => item.id));
  const covered = new Set<string>();
  for (const question of plan.questions) {
    if (question.blockerIds.length && !question.required) throw new Error('业务阻塞必须显式回答');
    if (question.required && !question.blockerIds.length) throw new Error('必答问题缺少业务阻塞依据');
    for (const id of question.blockerIds) { if (!ids.has(id)) throw new Error('问题引用未知阻塞'); covered.add(id); }
  }
  if (covered.size !== ids.size) throw new Error('问题卡片遗漏业务阻塞');
}
/** 绑定当前产品、方案与问题；工程资料观察也参与版本，避免旧表单污染新稿。 */
export function blockerHash(state: BlockerCycle): string { return developmentHash({ sourceHash: state.development.input.source.hash, planHash: state.development.planHash, readinessHash: state.development.readiness?.hash, business: state.business, engineering: state.engineering, round: state.round, plan: state.plan, references: state.references, referenceNote: state.referenceNote, history: state.history, productReworkDecision: state.productReworkDecision }); }
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
