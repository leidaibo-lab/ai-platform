/** 原生Time travel白名单：产品生成及尚未开工的历史失败架构节点，不开放任意步骤跳转。 */
import { deliverySchema } from '../mastra/workflows/delivery.js';
import { productRoles } from '../mastra/workflows/product-contract.js';
import { blockerCycleSchema } from './blocker-contracts.js';
import { stateV2Schema } from '../development/v2/contracts.js';
import { developmentHash } from '../development/contracts.js';
const titles: Record<string, string> = { 'guided-requirements.requirements-round.analyze-requirements': '需求分析', 'draft-product.product-coordinator': '总产品统筹', 'draft-product.product-clarification': '需求梳理', 'draft-product.product-closure': '产品闭环检查', 'draft-product.product-writing': '产品写作', 'draft-product.publish-product': '产品稿发布' };
/** 从失败叶节点与已保存输入派生恢复计划；下游存在批准或交付时不开放重放。 */
export function describeRecovery(runId: string, status: string, steps: Record<string, any>) {
  if (status !== 'failed') return undefined;
  const blocker = describeBlockerGenerationRecovery(runId, steps);
  if (blocker) return blocker;
  const development = describeArchitectureRecovery(runId, steps);
  if (development) return development;
  const failed = Object.entries(steps).find(/** 排除容器失败，选择明确登记的业务叶节点。 */([name, value]) => name in titles && !Array.isArray(value) && value.status === 'failed');
  if (!failed) return undefined;
  const [path, entry] = failed;
  const parsed = deliverySchema.safeParse(entry.payload);
  if (!parsed.success || parsed.data.artifacts.length || parsed.data.reviews.length) return undefined;
  const state = parsed.data;
  const entries = state.productWork?.entries ?? [];
  const roleIndex = path === 'draft-product.publish-product' ? 4 : productRoles.findIndex(/** 本次只重做失败角色及后续，之前产物必须顺序完整。 */role => path === `draft-product.product-${role}`);
  if (path.startsWith('draft-product.') && (roleIndex < 0 || entries.length !== roleIndex || entries.some(/** 防止缺少前序或混入重复角色的快照直接恢复。 */(value, index) => value.role !== productRoles[index]))) return undefined;
  const preserved = entries.map(/** 已完成产物保持只读，不再调用对应角色。 */value => ({ label: titles[`draft-product.product-${value.role}`], role: value.role }));
  return {
    hash: developmentHash({ runId, step: path, state, endedAt: entry.endedAt, error: entry.error?.name }),
    step: path, title: titles[path], savedAnswers: state.intake?.history.length ?? 0, preserved,
    reason: [408, 504, 524].includes(entry.error?.statusCode) ? '模型服务响应超时' : entry.error?.name === 'AI_APICallError' ? '上游模型调用未成功' : entry.error?.name === 'SyntaxError' || entry.error?.name === 'ZodError' ? '模型输出未通过格式校验' : '此步骤执行未完成',
    message: `可以从“${titles[path]}”的已保存输入继续，无需重填已确认信息。`,
    impact: path === 'draft-product.publish-product' ? '重新整理已有产品稿并生成版本，随后等待人工确认。' : '重新调用该步骤及后续所需的模型；前面已完成的产物保留。生成完整产品稿后仍需人工确认。',
  };
}

/** 仅恢复尚未实施的架构失败；批准产品、输入和前序成果必须来自同一原生Run。 */
function describeArchitectureRecovery(runId: string, steps: Record<string, any>) {
  const path = 'development-team.development-team-iteration.architecture';
  const entry = steps[path];
  if (!entry || Array.isArray(entry) || entry.status !== 'failed') return undefined;
  const state = stateV2Schema.safeParse(entry.payload);
  const approved = deliverySchema.safeParse(steps['review-product']?.output);
  if (!state.success || !approved.success) return undefined;
  const s = state.data;
  const product = approved.data.artifacts.find(/** 只从本Run已批准的产品版本派生。 */artifact => artifact.hash === s.input.source.hash);
  if (!product || !approved.data.reviews.some(/** 不能用其他版本或角色的批准放行。 */review => review.role === 'product' && review.decision === 'approve' && review.artifactHash === product.hash)) return undefined;
  if (s.input.source.kind !== 'approved-product' || s.phase !== 'architecture' || !s.context || s.plan || s.approvedHash || s.reviews.length || s.completedTasks.length || s.delivery || s.input.source.runId !== runId || s.context.productHash !== product.hash || s.work.some(/** 本入口不重放已经有实现副作用的开发。 */work => work.role !== 'context')) return undefined;
  if (!['model-timeout', 'model-network', 'invalid-output', 'model-error'].some(/** 仅登记的模型失败分类，不恢复源码漂移或身份错误。 */kind => entry.error?.message === `开发阶段 architecture 再次未完成（${kind}），人工恢复预算已耗尽`)) return undefined;
  if (Object.entries(steps).some(/** 测试、发布和最终交付一旦开始就拒绝向前重放。 */([key, value]) => /^(testing|deployment|confirm-final-delivery|initialize-delivery-lifecycle)(\.|$)/.test(key) && value?.status && !['pending', 'skipped'].includes(value.status))) return undefined;
  return { kind: 'development-architecture' as const, hash: developmentHash({ runId, step: path, state: s, endedAt: entry.endedAt, error: entry.error?.message }), step: 'development-team.development-team-iteration', checkpointStep: path, title: '技术方案生成', savedAnswers: approved.data.intake?.history.length ?? 0, preserved: [{ label: '已确认产品需求', role: 'product' }, { label: '项目与需求分析', role: 'context' }], reason: '历史架构模型调用未完成', message: '可从已保存的架构检查点继续，无需重做需求或已完成的分析。', impact: '校验当前源码和执行身份后重新生成技术方案，完成后仍等待方案批准，不直接实施。' };
}

/** 新澄清流程只重放只读模型生成；回答与产品原稿保留，批准后不重放旧稿。 */
function describeBlockerGenerationRecovery(runId: string, steps: Record<string, any>) {
  const allowed: Record<string, string> = { 'resolve-development-blockers.blocker-round.analyze-blocker-questions': '待决问题整理', 'resolve-development-blockers.blocker-round.write-revised-product': '产品稿修订' };
  const failed = Object.entries(steps).find(/** 严格限制到无代码写入的生成叶节点。 */([path, entry]) => path in allowed && !Array.isArray(entry) && entry.status === 'failed');
  if (!failed) return undefined;
  const [path, entry] = failed; const parsed = blockerCycleSchema.safeParse(entry.payload);
  if (!parsed.success || parsed.data.development.completedTasks.length || parsed.data.development.approvedHash) return undefined;
  const state = parsed.data;
  return { kind: 'blocker-generation' as const, hash: developmentHash({ runId, path, state, endedAt: entry.endedAt }), step: path, title: allowed[path], savedAnswers: (state.approvedProduct.intake?.history.length ?? 0) + (state.answer ? 1 : 0), preserved: [{ label: '原批准产品稿', role: 'product' }, ...(state.answer ? [{ label: '本轮已提交的业务选择', role: 'answers' }] : [])], reason: entry.error?.kind === 'model-timeout' ? '模型调用超时' : '本次模型输出未完成或未通过校验', message: `可以继续${allowed[path]}，原稿和已提交回答保留。`, impact: '重新执行当前只读生成步骤，修订产品稿仍需人工确认，不直接进入代码实施。' };
}
