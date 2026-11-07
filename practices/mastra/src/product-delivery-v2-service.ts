/** 新产品执行交接服务；批准仍由原生步骤保存，不调用旧提案链。 */
import type { createProductDeliveryV2 } from './mastra/workflows/product-delivery-v2.js';
import { productDeliveryV2Schema } from './mastra/workflows/product-delivery-v2.js';
import { deliverySchema, pendingSchema, validateReview } from './mastra/workflows/delivery.js';
import { productReworkRunId } from './mastra/workflows/product-contract.js';
import type { PracticeConfig } from './mastra/config.js';

export interface ProductV2Context { productDeliveryV2: ReturnType<typeof createProductDeliveryV2>; config: PracticeConfig }

/** 仅投影原生存储，status无模式伪造或平行审批状态。 */
export async function productStatusV2(app: ProductV2Context, runId: string) {
  const snapshot = await app.productDeliveryV2.getWorkflowRunById(runId);
  if (!snapshot) throw new Error('产品v2 Run不存在');
  const initialized = snapshot.steps?.initialize;
  const mode = initialized && !Array.isArray(initialized) ? deliverySchema.parse(initialized.output).mode : undefined;
  const step = snapshot.steps?.['review-product'];
  const pending = step && !Array.isArray(step) && step.status === 'suspended' ? pendingSchema.parse(step.suspendPayload) : null;
  return { workflowId: 'product-delivery-v2' as const, runId, mode, status: snapshot.status, pending, result: snapshot.result ? productDeliveryV2Schema.parse(snapshot.result) : null };
}

/** 显式创建新执行模式产品Run，与旧product-delivery互不自动消费。 */
export async function startProductV2(app: ProductV2Context, brief: string) {
  const run = await app.productDeliveryV2.createRun();
  await run.start({ inputData: { brief } });
  return productStatusV2(app, run.runId);
}

/** 已保存退回事实派生唯一后继；同一退回重试只读回原后继。 */
async function continueReworkV2(app: ProductV2Context, runId: string, state: NonNullable<Awaited<ReturnType<typeof productStatusV2>>['result']>) {
  const artifact = state.artifacts[0];
  const review = state.reviews.at(-1)!;
  if (state.outcome !== 'rework-requested' || review.decision !== 'rework') throw new Error('产品v2没有已保存退回');
  const nextId = productReworkRunId(runId, artifact.hash);
  if (!await app.productDeliveryV2.getWorkflowRunById(nextId)) {
    const next = await app.productDeliveryV2.createRun({ runId: nextId });
    await next.start({ inputData: { brief: state.brief, productRework: { sourceRunId: runId, sourceHash: artifact.hash, sourceContent: artifact.content, reviewer: review.reviewer, feedback: review.comment, round: (state.productRework?.round ?? 0) + 1 } } });
  }
  return productStatusV2(app, nextId);
}

/** 错误hash/模式请求在resume前拒绝，原暂停点保持可用。 */
export async function reviewProductV2(app: ProductV2Context, runId: string, input: unknown) {
  const status = await productStatusV2(app, runId);
  if (status.mode !== app.config.mode) throw new Error('产品v2模式变化');
  if (status.result?.outcome === 'rework-requested') {
    if (JSON.stringify(input) !== JSON.stringify(status.result.reviews.at(-1))) throw new Error('产品v2退回决定已经保存');
    return continueReworkV2(app, runId, status.result);
  }
  if (status.status !== 'suspended' || !status.pending) throw new Error('产品v2没有待审版本');
  const review = validateReview(status.pending, input);
  const run = await app.productDeliveryV2.createRun({ runId });
  await run.resume({ step: 'review-product', resumeData: review });
  const next = await productStatusV2(app, runId);
  return next.result?.outcome === 'rework-requested' ? continueReworkV2(app, runId, next.result) : next;
}
