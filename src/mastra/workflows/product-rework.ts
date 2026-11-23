import { methodPrompt } from '../team-methods.js';
import { z } from 'zod';
import { createHash } from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';
import { developmentHash } from '../../development/contracts.js';
import { deliverySchema, type Delivery } from './delivery.js';
import { correctionPauseSchema } from '../../intake/product-interruption.js';
import { nativeInvocationMemory } from '../context-memory.js';
import { productManagerStages, productReworkSchema, type ProductRework } from './product-contract.js';

const productReworkRouteSchema = z.object({
  target: z.enum(['guided-requirements', ...productManagerStages]),
  reason: z.string().trim().min(1).max(500),
});
type ClassifyRework = (prompt: string, options: {
  memory: ReturnType<typeof nativeInvocationMemory>;
  maxSteps: number;
  modelSettings: { maxRetries: number; timeout: { totalMs: number; stepMs: number } };
  structuredOutput: { schema: typeof productReworkRouteSchema };
}) => Promise<unknown>;

export type ProductReworkRoute = z.infer<typeof productReworkRouteSchema>;
export const productReworkMethod = 'product-rework.v1';
const restartAuthorization = new AsyncLocalStorage<{ runId: string; step: string; hash: string }>();

/** 仅在已验证人工反馈的服务端调用期间授权精确返工请求，不持有新的恢复事实。 */
export function withProductRestart<T>(runId: string, restart: { step: string[]; input: unknown }, execute: () => Promise<T>): Promise<T> {
  return restartAuthorization.run({ runId, step: restart.step.join('.'), hash: developmentHash(restart.input) }, execute);
}

/** 原生入口核对调用期授权，禁止客户端借返工更换任意检查点输入。 */
export function isAuthorizedProductRestart(runId: string, step: string, input: unknown): boolean {
  const authorization = restartAuthorization.getStore();
  return !!authorization && authorization.runId === runId && authorization.step === step && authorization.hash === developmentHash(input);
}

export const downstreamProductReworkSchema = productReworkRouteSchema.extend({
  target: z.literal('guided-requirements'),
  method: z.literal(productReworkMethod),
  sourceHash: z.string().length(64),
  findingRefs: z.array(z.object({ id: z.string(), refs: z.array(z.string()), evidence: z.string() })),
});
type DownstreamEvidence = Pick<z.infer<typeof downstreamProductReworkSchema>, 'sourceHash' | 'findingRefs'>;

/** 产品团队根据上游产物和反馈选择重做起点。 */
export function planProductRework(source: Delivery, feedback: string, classify?: ClassifyRework): Promise<ProductReworkRoute>;
export function planProductRework(source: Delivery, feedback: DownstreamEvidence): Promise<z.infer<typeof downstreamProductReworkSchema>>;
export async function planProductRework(source: Delivery, feedback: string | DownstreamEvidence, classify?: ClassifyRework) {
  const clarify: ProductReworkRoute = { target: 'guided-requirements', reason: '需要重新核对业务决定和需求边界。' };
  if (typeof feedback !== 'string') {
    return downstreamProductReworkSchema.parse({
      ...clarify, ...feedback, method: productReworkMethod,
      reason: '下游已记录业务缺口，需要人工澄清后再修订已批准的产品稿。',
    });
  }
  if (source.mode === 'fixture') {
    if (/^(文案|错别字|术语|标题|措辞)[：:]/.test(feedback)) return { target: 'writing', reason: '样例反馈仅修改产品稿表述。' };
    if (/^(范围|优先级)[：:]/.test(feedback)) return { target: 'scope-priority', reason: '样例反馈调整范围或优先级。' };
    return clarify;
  }
  try {
    if (!classify) return clarify;
    const result = await classify(JSON.stringify({
      task: productReworkMethod,
      instruction: source.productFlow !== undefined
        ? methodPrompt('mastra.workflows.product-rework.1', source.nacosResources?.methods)
        : methodPrompt('mastra.workflows.product-rework.2', source.nacosResources?.methods),
      brief: source.brief,
      feedback,
      priorFeedback: productReworkFeedback(source),
      direction: source.intake?.plan?.summary,
      confirmedHistory: source.intake?.history.slice(-4).map(({ response, plan }) => ({
        supplement: response.supplement.slice(0, 1000),
        answers: response.answers.map(answer => ({
          question: plan.questions.find(question => question.id === answer.questionId)?.title.slice(0, 250),
          selected: plan.questions.find(question => question.id === answer.questionId)?.options.filter(option => answer.selected.includes(option.id)).map(option => option.label.slice(0, 150)),
          custom: answer.custom.slice(0, 500),
        })),
      })),
      earlierHistoryExists: (source.intake?.history.length ?? 0) > 4,
      work: source.productWork?.entries.map(entry => ({ stage: entry.role, content: entry.content.slice(0, 4000) })),
    }), {
      memory: nativeInvocationMemory(),
      maxSteps: 1,
      modelSettings: { maxRetries: 0, timeout: { totalMs: 20000, stepMs: 20000 } },
      structuredOutput: { schema: productReworkRouteSchema },
    });
    return productReworkRouteSchema.parse(result);
  } catch {
    return clarify;
  }
}

/** 校验依赖产物，保留重跑起点之前的有效结论。 */
export function prepareProductRework(source: Delivery, rework: ProductRework, route: ProductReworkRoute) {
  const entries = source.productWork?.entries ?? [];
  const simplified = source.productFlow !== undefined;
  const directionReady = source.intake?.enabled ? source.intake.ready && !!source.intake.plan : entries[0]?.role === 'analysis';
  const simplifiedTarget = route.target === 'guided-requirements' || source.intake?.enabled && (route.target !== 'writing' || !directionReady)
    ? 'guided-requirements' : route.target === 'writing' && directionReady ? 'writing' : 'analysis';
  const requested = productManagerStages.findIndex(stage => stage === route.target);
  const missing = productManagerStages.findIndex((stage, index) => entries[index]?.role !== stage);
  const mustClarify = requested < 0 || (source.intake?.enabled && !source.intake.ready);
  const start = mustClarify ? -1 : missing < 0 ? requested : Math.min(requested, missing);
  const target = simplified ? simplifiedTarget : start < 0 ? 'guided-requirements' : productManagerStages[start];
  const restartDirection = target === 'guided-requirements';
  const retained = simplified ? (target === 'writing' ? entries.filter(entry => entry.role === 'analysis') : []) : entries.slice(0, Math.max(0, start));
  const reason = target === route.target ? route.reason : '从最早缺少有效产物的产品节点重新执行。';
  const intake = restartDirection ? { ...source.intake, intakeMode: 'clarify' as const, enabled: true, ready: false, round: source.intake?.round ?? 0, history: source.intake?.history ?? [], plan: undefined, hash: undefined } : source.intake;
  const history = [...(source.productReworkHistory ?? [])];
  if (source.productRework) {
    const { sourceContent: _sourceContent, ...previous } = source.productRework;
    history.push(previous);
  }
  const container = source.productFlow === 'native-three-stage'
    ? target === 'writing' ? 'product-specification' : 'product-direction'
    : 'draft-product';
  return {
    step: source.productFlow === 'four-step'
      ? ['product-team', target === 'writing' ? 'product-writing' : 'align-product-requirements']
      : ['product-team', container, restartDirection ? target : `product-${target}`],
    input: {
      ...source, intake, intakeMode: restartDirection ? 'clarify' as const : source.intakeMode,
      revision: undefined, artifacts: [], reviews: [], productQualityReview: undefined, productRepairCheckpoint: undefined, productQualityCheckpoint: undefined,
      productWork: retained.length ? { version: 'product-graph.v1' as const, entries: retained } : undefined,
      productReworkHistory: history.length ? history : undefined,
      productRework: { ...rework, target, reason, method: productReworkMethod }, outcome: 'in-progress' as const,
    },
  };
}

/** 让从更早阶段重做的模型继续参考历次已提交反馈。 */
export function productReworkFeedback(input: Delivery) {
  return [...(input.productReworkHistory ?? []), ...(input.productRework ? [input.productRework] : [])]
    .map(({ round, feedback }) => ({ round, feedback }));
}

/** 只展示已经进入步骤输入或保存产物的返工事实。 */
export function appliedProductRework(steps: Record<string, unknown>) {
  let applied: ProductRework | undefined;
  for (const [path, raw] of Object.entries(steps)) {
    if (!path.startsWith('product-team.') || !raw || typeof raw !== 'object' || Array.isArray(raw)) continue;
    const step = raw as { output?: { productRework?: unknown }; payload?: { productRework?: unknown } };
    const parsed = productReworkSchema.safeParse(step.output?.productRework ?? step.payload?.productRework);
    if (!parsed.success || !parsed.data.target) continue;
    const targetStep = parsed.data.target === 'guided-requirements' ? 'analyze-requirements' : `product-${parsed.data.target}`;
    if ((path.endsWith(`.${targetStep}`) || path === 'product-team.align-product-requirements' && parsed.data.target !== 'writing') && parsed.data.round > (applied?.round ?? 0)) applied = parsed.data;
  }
  return applied && { attempt: applied.attempt, target: applied.target, round: applied.round };
}

const suspendedStepSchema = z.object({ status: z.literal('suspended'), suspendPayload: correctionPauseSchema, payload: z.unknown() });

/** 从团队自己的暂停点还原返工输入及来源版本。 */
export function readProductCorrectionCheckpoint(steps: Record<string, unknown>, runId: string, attempt: string) {
  for (const [path, entry] of Object.entries(steps)) {
    if (!/^product-team\.((draft-product|product-direction|product-specification)\.|(align-product-requirements|product-writing|review-product-quality)$)/.test(path)) continue;
    const step = suspendedStepSchema.safeParse(entry);
    if (!step.success || step.data.suspendPayload.attempt !== attempt) continue;
    const saved = deliverySchema.parse(step.data.payload);
    const source = step.data.suspendPayload.intake ? { ...saved, intake: step.data.suspendPayload.intake } : saved;
    const { reviewer, feedback } = step.data.suspendPayload;
    const draft = source.artifacts.find(artifact => artifact.stage === 'product');
    const rework: ProductRework = {
      attempt, sourceRunId: runId,
      sourceHash: draft?.hash ?? createHash('sha256').update(JSON.stringify({ path, attempt, input: source })).digest('hex'),
      sourceContent: draft?.content, reviewer, feedback,
      round: (source.productRework?.round ?? 0) + 1,
    };
    return { source, rework };
  }
}
