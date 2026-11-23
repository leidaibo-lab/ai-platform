import { productRepairCheckpointSchema } from '../team/product-repair.js';
import { productRepairDetails } from './product-repair-history.js';
/** 原生Time travel白名单：产品生成及尚未开工的历史失败架构节点，不开放任意步骤跳转。 */
import { deliverySchema, type Delivery } from '../mastra/workflows/delivery.js';
import { productManagerStages } from '../mastra/workflows/product-contract.js';
import { blockerCycleSchema } from './blocker-contracts.js';
import { inputV2Schema, stateV2Schema } from '../development/v2/contracts.js';
import { developmentHash } from '../development/contracts.js';
import { alignmentResumeSchema, applyIntakeResponse, intakeHash } from './contracts.js';
import { productSteps } from '../mastra/workflows/product-steps.js';
import { describeProductFailure, isPlanOnlyProductOutput } from './product-failure.js';
const titles: Record<string, string> = { 'align-product-requirements': productSteps[0].title, 'product-writing': productSteps[1].title, 'draft-product.guided-requirements.requirements-round.analyze-requirements': '需求分析', 'draft-product.product-analysis': '需求分析', 'draft-product.product-clarification': '需求澄清整理', 'draft-product.product-scope-priority': '范围与优先级', 'draft-product.product-writing': '产品稿写作', 'draft-product.publish-product': '产品稿发布' };
/** 使用相同白名单识别两种原生布局下的产品执行节点。 */
function productRecoveryTitleKey(path: string) {
  if (path === 'product-team.align-product-requirements' || path === 'product-team.product-writing') return path.split('.')[1];
  const canonical = path.replace(/^product-team\.(product-direction|product-specification)\./, 'product-team.draft-product.');
  return Object.keys(titles).find(suffix => canonical === suffix || canonical === `product-team.${suffix}`);
}
/** 从原生失败快照重建已提交但尚未完成评估的回答。 */
export function alignmentRetryInput(state: Delivery, step: { resumePayload?: unknown }) {
  if (!step.resumePayload) return state;
  const saved = alignmentResumeSchema.safeParse(step.resumePayload);
  if (!saved.success || intakeHash(state.brief, saved.data.intake) !== saved.data.intake.hash) return undefined;
  try { return { ...state, intake: applyIntakeResponse(saved.data.intake, saved.data.response) }; }
  catch { return undefined; }
}

/** 从团队嵌套快照中取得当前版本的叶节点；只匹配新团队 Workflow 的完整后缀。 */
function findStep(steps: Record<string, any>, suffix: string) {
  return Object.entries(steps)
    .filter(([path, value]) => !Array.isArray(value) && (path === suffix || path.endsWith(`.${suffix}`)))
    .sort(([left], [right]) => right.split('.').length - left.split('.').length)[0]?.[1] as any;
}
/** 从团队嵌套快照中取得真实路径，供恢复哈希和原生 time travel 使用。 */
function findPath(steps: Record<string, any>, suffix: string) {
  return Object.keys(steps)
    .filter((path) => path === suffix || path.endsWith(`.${suffix}`))
    .sort((left, right) => right.split('.').length - left.split('.').length)[0];
}
/** 从失败叶节点与已保存输入派生恢复计划；下游存在批准或交付时不开放重放。 */
export function describeRecovery(runId: string, status: string, steps: Record<string, any>) {
  if (status !== 'failed') return undefined;
  const initialization = describeInitializationRecovery(runId, steps);
  if (initialization) return initialization;
  const sync = describeLegacySyncRecovery(runId, steps);
  if (sync) return sync;
  const blocker = describeBlockerGenerationRecovery(runId, steps);
  if (blocker) return blocker;
  const development = describeArchitectureRecovery(runId, steps);
  if (development) return development;
  const qualityReview = describeProductQualityRecovery(runId, steps);
  if (qualityReview) return qualityReview;
  const failed = Object.entries(steps).find(/** 只恢复白名单内的产品叶节点。 */([path, value]) => productRecoveryTitleKey(path) && !Array.isArray(value) && value.status === 'failed');
  if (!failed) return undefined;
  const [path, entry] = failed;
  const titleKey = productRecoveryTitleKey(path)!;
  const parsed = deliverySchema.safeParse(entry.payload);
  if (!parsed.success || parsed.data.artifacts.length || parsed.data.reviews.length) return undefined;
  const state = titleKey === 'align-product-requirements' ? alignmentRetryInput(parsed.data, entry) : parsed.data;
  if (!state) return undefined;
  const entries = state.productWork?.entries ?? [];
  const simplified = state.productFlow !== undefined;
  const roles = simplified ? (state.intake?.enabled ? ['writing'] : ['analysis', 'writing']) : productManagerStages;
  const roleIndex = titleKey === 'draft-product.publish-product' ? roles.length
    : titleKey === 'align-product-requirements' || titleKey.endsWith('.analyze-requirements') ? 0 : roles.findIndex(role => titleKey === `draft-product.product-${role}` || titleKey === `product-${role}`);
  if (path.startsWith('product-team.') && (roleIndex < 0 || entries.length !== roleIndex || entries.some((value, index) => value.role !== roles[index]))) return undefined;
  const preserved = entries.map(/** 前序产物保持只读；旧快照中的计划句不计为完成交付。 */value => ({ label: titles[`draft-product.product-${value.role}`], role: value.role, complete: !(value.role === 'scope-priority' && isPlanOnlyProductOutput(value.content)) }));
  const failure = describeProductFailure(entry.error, state.contextBudgetLevel ?? 0);
  const repairCheckpoint = productRepairCheckpointSchema.safeParse(entry.error?.productRepairCheckpoint);
  const repairStopped = repairCheckpoint.success && ['no-progress', 'budget-exhausted'].includes(repairCheckpoint.data.history.at(-1)?.outcome ?? '');
  return {
    hash: developmentHash({ runId, step: path, state, endedAt: entry.endedAt, error: entry.error?.name, details: entry.error?.details, repairHistory: productRepairDetails(entry.error) }),
    step: path, title: titles[titleKey], savedAnswers: state.intake?.history.length ?? 0, preserved: simplified && state.intake?.ready && state.intake.plan ? [{ label: '已收敛的产品方向', role: 'direction', complete: true }, ...preserved] : preserved,
    reason: failure?.reason ?? ([408, 504, 524].includes(entry.error?.statusCode) ? '模型服务响应超时' : entry.error?.name === 'AI_APICallError' ? '上游模型调用未成功' : entry.error?.name === 'SyntaxError' || entry.error?.name === 'ZodError' ? '模型输出未通过格式校验' : '此步骤执行未完成'),
    attemptDetails: [...(failure?.details ?? []), ...productRepairDetails(entry.error)], next: failure?.next, additionalContextLevel: failure?.additionalContextLevel, retryBlocked: repairStopped || failure?.retryBlocked,
    message: repairStopped ? '文档修订已停止，普通重试不会重新授予预算。请处理停止原因后发起有明确授权的新任务。' : `可以从“${titles[titleKey]}”的已保存输入继续，无需重填已确认信息。`,
    impact: titleKey === 'draft-product.publish-product' ? '重新整理已有产品稿并生成版本，随后等待人工确认。' : '重新调用该步骤及后续所需的模型；前面已完成的产物保留。生成完整产品稿后仍需人工确认。',
  };
}

/** ADR: docs/decisions/2026-11-18-recover-development-initialization.md；只恢复同 Run 中未实施的旧锚点上限故障。 */
function describeInitializationRecovery(runId: string, steps: Record<string, any>) {
  const path = findPath(steps, 'development-team.development-execution.initialize-development');
  const entry = path ? steps[path] : undefined;
  if (!path || !entry || Array.isArray(entry) || entry.status !== 'failed' || entry.error?.message !== 'v2产品原文超过试点锚点预算') return undefined;
  const parsed = inputV2Schema.safeParse(entry.payload);
  const scoped = inputV2Schema.safeParse(findStep(steps, 'development-team.confirm-project-scope')?.output);
  const approved = deliverySchema.safeParse(findStep(steps, 'product-team.review-product')?.output);
  if (!parsed.success || !scoped.success || !approved.success || developmentHash(parsed.data) !== developmentHash(scoped.data)) return undefined;
  const input = parsed.data;
  if (input.source.kind !== 'approved-product' || input.source.runId !== runId || input.scopeApproval?.productHash !== input.source.hash) return undefined;
  if (!approved.data.artifacts.some(/** 恢复只能使用同一 Run 的已批准产品原文。 */item => item.stage === 'product' && item.hash === input.source.hash && item.content === input.source.content) || !approved.data.reviews.some(/** 不把项目确认或其他版本当作产品批准。 */review => review.role === 'product' && review.decision === 'approve' && review.artifactHash === input.source.hash)) return undefined;
  if (Object.entries(steps).some(([key, value]) => /^(?:development-team\.development-execution\.(?!initialize-development(?:\.|$))|development-team\.(?:open-development-clarification|resolve-development-blockers|continue-after-clarification)(?:\.|$)|(?:test-team|testing-team|deployment-team|delivery-team|initialize-delivery-lifecycle)(?:\.|$))/.test(key) && value?.status && !['pending', 'skipped'].includes(value.status))) return undefined;
  return { kind: 'development-initialization' as const, hash: developmentHash({ runId, path, input, endedAt: entry.endedAt, error: entry.error.message }), step: 'development-team.development-execution', checkpointStep: path, title: '开发初始化', savedAnswers: approved.data.intake?.history.length ?? 0, preserved: [{ label: '已批准产品稿', role: 'product' }, { label: '已确认项目范围', role: 'context' }], reason: '旧版本产品原文逐行锚点超过限制', message: '可以校验已保存输入与候选后继续开发规划，无需重填产品或项目确认。', impact: '重新生成开发规划可能产生模型费用；工程准备门禁和方案批准仍然生效，不直接实施。' };
}

/** 只重试已生成产品稿的质量审查，核对原生发布结果和后续审批边界。 */
function describeProductQualityRecovery(runId: string, steps: Record<string, any>) {
  const flatPath = findPath(steps, 'product-team.review-product-quality');
  const nativePath = findPath(steps, 'product-team.product-specification.review-product-quality');
  const path = flatPath ?? nativePath ?? findPath(steps, 'draft-product.review-product-quality');
  const entry = path ? steps[path] : undefined;
  if (!path || !entry || Array.isArray(entry) || entry.status !== 'failed') return undefined;
  const input = deliverySchema.safeParse(entry.payload);
  const publishedStep = findStep(steps, flatPath ? 'product-team.product-writing' : nativePath ? 'product-team.product-specification.product-writing' : 'draft-product.publish-product');
  const published = deliverySchema.safeParse(publishedStep?.status === 'success' ? publishedStep.output : undefined);
  if (!input.success || !published.success || developmentHash({ ...input.data, productQualityCheckpoint: undefined }) !== developmentHash({ ...published.data, productQualityCheckpoint: undefined })) return undefined;
  const state = input.data;
  const artifact = state.artifacts.at(-1);
  if (!artifact || artifact.stage !== 'product' || state.reviews.length || state.productQualityReview || state.outcome !== 'in-progress') return undefined;
  if (Object.entries(steps).some(([key, value]) => /^(product-team\.review-product|development-team|testing-team|test-team|deployment-team|delivery-team)(\.|$)/.test(key) && value?.status && !['pending', 'skipped'].includes(value.status))) return undefined;
  const failure = describeProductFailure(entry.error, state.contextBudgetLevel ?? 0);
  return { hash: developmentHash({ runId, step: path, state, endedAt: entry.endedAt, error: entry.error?.name, details: entry.error?.details, qualityCheckpoint: entry.error?.productQualityCheckpoint }), step: path, title: '产品质量审查', savedAnswers: state.intake?.history.length ?? 0, preserved: [{ label: '已生成的产品稿', role: 'product', complete: true }], reason: failure?.reason ?? '产品质量审查未完成', attemptDetails: failure?.details, next: failure?.next, message: '可使用已保存的产品稿重新执行质量审查，无需重新生成产品稿。', impact: '重新调用产品审查，可能产生模型费用；完成后仍需人工审阅和确认。' };
}

/** 旧图同步失败只开放未实施的架构检查点；新版同步故障使用原生暂停关口。 */
function describeLegacySyncRecovery(runId: string, steps: Record<string, any>) {
  const paths = ['development-team.development-execution.development-execution-iteration.architecture', 'development-team.resolve-development-blockers.blocker-round.replanned-development.replanned-development-iteration.architecture'];
  for (const suffix of paths) {
    const path = findPath(steps, suffix);
    const entry = path ? steps[path] : undefined;
    // 旧页面曾在同步前做身份校验；模型切换会把同一安全可恢复的同步失败改写为此固定错误。
    if (entry?.status !== 'failed' || !['角色产物远端同步失败；生成检查点已保留，请恢复原失败节点重试同步', 'v2模型、模式或方法发生漂移'].includes(entry.error?.message)) continue;
    const parsed = stateV2Schema.safeParse(entry.payload); if (!parsed.success) continue;
    const s = parsed.data;
    if (s.input.source.runId !== runId || s.phase !== 'architecture' || s.plan || s.approvedHash || s.completedTasks.length || s.reviews.length || s.delivery || !s.context) continue;
    const revised = blockerCycleSchema.safeParse(findStep(steps, 'development-team.resolve-development-blockers.blocker-round.review-revised-product')?.output);
    const original = deliverySchema.safeParse(findStep(steps, 'product-team.review-product')?.output);
    const approved = path.includes('resolve-development-blockers') ? revised.success && revised.data.review?.decision === 'approve' && revised.data.review.hash === s.input.source.hash && revised.data.draft?.hash === s.input.source.hash : original.success && original.data.reviews.some(/** 仅同产品版本的真实批准生效。 */review => review.decision === 'approve' && review.role === 'product' && review.artifactHash === s.input.source.hash);
    if (!approved) continue;
    // Time travel 必须落在真实失败叶节点；外层循环接收的是 blockerCycle，传入架构 State 会在原生输入校验前失败。
    const identityDrift = entry.error?.message === 'v2模型、模式或方法发生漂移';
    return { kind: 'development-repository-sync' as const, syncOnly: true, hash: developmentHash({ runId, path, state: s, endedAt: entry.endedAt }), step: path, checkpointStep: path, title: '技术方案资料同步', savedAnswers: revised.success ? revised.data.history.length : original.success ? original.data.intake?.history.length ?? 0 : 0, preserved: [{ label: '已批准产品稿与业务选择', role: 'product' }, { label: '已生成架构结果', role: 'architect' }], reason: identityDrift ? '切换模型后触发历史身份校验；调用额度并未耗尽' : '资料同步失败；调用额度并未耗尽', message: identityDrift ? '已保存技术方案与源码检查点一致。此恢复只同步已有资料，不使用当前模型。' : '已生成技术方案结果，远端同步尚未完成。可以只重试资料同步，无需重填或重新调用模型。', impact: '先校验已保存结果与源码版本，只同步现有产物；成功后按结果继续澄清或方案确认，不直接开工。' };
  }
  return undefined;
}

/** 仅恢复尚未实施的架构失败；批准产品、输入和前序成果必须来自同一原生Run。 */
function describeArchitectureRecovery(runId: string, steps: Record<string, any>) {
  const suffix = 'development-team.development-execution.development-execution-iteration.architecture';
  const path = findPath(steps, suffix);
  const entry = path ? steps[path] : undefined;
  if (!entry || Array.isArray(entry) || entry.status !== 'failed') return undefined;
  const state = stateV2Schema.safeParse(entry.payload);
  const approved = deliverySchema.safeParse(findStep(steps, 'product-team.review-product')?.output);
  if (!state.success || !approved.success) return undefined;
  const s = state.data;
  const product = approved.data.artifacts.find(/** 只从本Run已批准的产品版本派生。 */artifact => artifact.hash === s.input.source.hash);
  if (!product || !approved.data.reviews.some(/** 不能用其他版本或角色的批准放行。 */review => review.role === 'product' && review.decision === 'approve' && review.artifactHash === product.hash)) return undefined;
  if (s.input.source.kind !== 'approved-product' || s.phase !== 'architecture' || !s.context || s.plan || s.approvedHash || s.reviews.length || s.completedTasks.length || s.delivery || s.input.source.runId !== runId || s.context.productHash !== product.hash || s.work.some(/** 本入口不重放已经有实现副作用的开发。 */work => work.role !== 'context')) return undefined;
  const exhausted = ['model-timeout', 'model-network', 'invalid-output', 'model-error'].some(/** 仅登记的模型失败分类，不恢复源码漂移或身份错误。 */kind => entry.error?.message === `开发阶段 architecture 再次未完成（${kind}），人工恢复预算已耗尽`);
  // 旧同步缓存曾把原生暂停包当作架构结果回放；该错误发生在只读架构入口、无实施副作用时，可按同一检查点安全恢复。
  const stalePauseReplay = entry.error?.name === 'ZodError';
  const cacheKeyConflict = entry.error?.message === '交接缓存冲突';
  if (!exhausted && !stalePauseReplay && !cacheKeyConflict) return undefined;
  if (Object.entries(steps).some(/** 测试、发布和最终交付一旦开始就拒绝向前重放。 */([key, value]) => /^(test-team|deployment-team|delivery-team|initialize-delivery-lifecycle)(\.|$)/.test(key) && value?.status && !['pending', 'skipped'].includes(value.status))) return undefined;
  return { kind: 'development-architecture' as const, hash: developmentHash({ runId, step: path, state: s, endedAt: entry.endedAt, error: entry.error?.message, errorName: entry.error?.name }), step: 'development-team.development-execution.development-execution-iteration', checkpointStep: path, title: '技术方案生成', savedAnswers: approved.data.intake?.history.length ?? 0, preserved: [{ label: '已确认产品需求', role: 'product' }, { label: '项目与需求分析', role: 'context' }], reason: stalePauseReplay ? '历史同步缓存未能与架构恢复检查点兼容' : cacheKeyConflict ? '历史暂停检查点与本轮恢复共用了缓存键' : '历史架构模型调用未完成', message: '可从已保存的架构检查点继续，无需重做需求或已完成的分析。', impact: '校验当前源码和执行身份后重新生成技术方案，完成后仍等待方案批准，不直接实施。' };
}

/** 新澄清流程只重放只读模型生成；回答与产品原稿保留，批准后不重放旧稿。 */
function describeBlockerGenerationRecovery(runId: string, steps: Record<string, any>) {
  const allowed: Record<string, string> = { 'development-team.resolve-development-blockers.blocker-round.analyze-blocker-questions': '待决问题整理', 'development-team.resolve-development-blockers.blocker-round.write-revised-product': '产品稿修订' };
  const failed = Object.entries(steps).find(/** 严格限制到无代码写入的生成叶节点。 */([path, entry]) => Object.keys(allowed).some((suffix) => (path === suffix || path.endsWith(`.${suffix}`)) && !Array.isArray(entry) && entry.status === 'failed'));
  if (!failed) return undefined;
  const [path, entry] = failed; const suffix = Object.keys(allowed).find((value) => path === value || path.endsWith(`.${value}`))!; const parsed = blockerCycleSchema.safeParse(entry.payload);
  if (!parsed.success || parsed.data.development.completedTasks.length || parsed.data.development.approvedHash) return undefined;
  const state = parsed.data;
  const identityDrift = entry.error?.message === 'v2模型、模式或方法发生漂移';
  return { kind: 'blocker-generation' as const, hash: developmentHash({ runId, step: path, state, endedAt: entry.endedAt }), step: path, title: allowed[suffix], savedAnswers: (state.approvedProduct.intake?.history.length ?? 0) + (state.answer ? 1 : 0), preserved: [{ label: '原批准产品稿', role: 'product' }, ...(state.answer ? [{ label: '本轮已提交的业务选择', role: 'answers' }] : [])], reason: identityDrift ? '已切换模型，需要使用新模型重新整理' : entry.error?.kind === 'model-timeout' ? '模型调用超时' : '本次模型输出未完成或未通过校验', message: identityDrift ? `当前步骤尚未执行新模型。可以重新整理${allowed[suffix]}，原稿和已提交回答保留。` : `可以继续${allowed[suffix]}，原稿和已提交回答保留。`, impact: identityDrift ? '将调用当前已选择的新模型重新执行这个只读整理步骤，可能产生模型费用；修订产品稿仍需人工确认，不直接进入代码实施。' : '重新执行当前只读生成步骤，修订产品稿仍需人工确认，不直接进入代码实施。' };
}
