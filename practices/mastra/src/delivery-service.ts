import type { PracticeConfig } from './mastra/config.js';
import type { WorkflowRunStatus } from '@mastra/core/workflows';
import { productReworkRunId } from './mastra/workflows/product-contract.js';
import { deliveryInputSchema, deliverySchema, pendingSchema, reviewSchema, validateReview, type createDeliveryWorkflow, type Delivery, type PendingReview } from './mastra/workflows/delivery.js';

/** 服务仅依赖原生流程及配置；HTTP Adapter 与 CLI 共享同一校验。 */
export interface DeliveryContext {
  deliveryWorkflow: ReturnType<typeof createDeliveryWorkflow>;
  config: PracticeConfig;
}

/** CLI 只交付已校验的业务快照，不暴露框架 requestContext 或模型配置。 */
export interface DeliveryStatus {
  runId: string;
  mode?: Delivery['mode'];
  status: WorkflowRunStatus;
  pending?: PendingReview & { step: string };
  result?: Delivery;
}

/** 读取原生持久快照，提取单个待审节点；不维护平行状态或审批数据库。 */
export async function deliveryStatus(app: DeliveryContext, runId: string): Promise<DeliveryStatus> {
  const snapshot = await app.deliveryWorkflow.getWorkflowRunById(runId);
  if (!snapshot) throw new Error('找不到该交付 Run');
  let pending: DeliveryStatus['pending'];
  for (const [step, value] of Object.entries(snapshot.steps ?? {})) {
    if (!Array.isArray(value) && value.status === 'suspended') {
      pending = { step, ...pendingSchema.parse(value.suspendPayload) };
    }
  }
  const initialized = snapshot.steps?.initialize;
  const mode = initialized && !Array.isArray(initialized) && initialized.output ? deliverySchema.parse(initialized.output).mode : undefined;
  const result = snapshot.result ? deliverySchema.parse(snapshot.result) : undefined;
  return { runId, mode, status: snapshot.status, pending, result };
}

/** 校验输入后启动一次交接；等待人工的状态由 Workflow 原生持久化。 */
export async function startDelivery(app: DeliveryContext, brief: string) {
  const inputData = deliveryInputSchema.parse({ brief });
  const run = await app.deliveryWorkflow.createRun();
  await run.start({ inputData });
  return deliveryStatus(app, run.runId);
}

/** 从已保存的退回事实派生后继；固定标识使同一决定的重试只回读已有轮次。 */
async function continueProductRework(app: DeliveryContext, sourceRunId: string, state: Delivery) {
  const review = state.reviews.at(-1);
  const artifact = state.artifacts.find(
    // 返工只针对本轮唯一的产品交接物。
    (item) => item.stage === 'product',
  );
  if (state.outcome !== 'rework-requested' || review?.decision !== 'rework' || !artifact)
    throw new Error('找不到已保存的产品退回决定');
  const runId = productReworkRunId(sourceRunId, artifact.hash);
  const existing = await app.deliveryWorkflow.getWorkflowRunById(runId);
  if (existing) return deliveryStatus(app, runId);
  const inputData = deliveryInputSchema.parse({
    brief: state.brief,
    productRework: {
      sourceRunId, sourceHash: artifact.hash, sourceContent: artifact.content,
      reviewer: review.reviewer, feedback: review.comment, round: (state.productRework?.round ?? 0) + 1,
    },
  });
  const run = await app.deliveryWorkflow.createRun({ runId });
  await run.start({ inputData });
  return deliveryStatus(app, runId);
}

/** CLI 在恢复前校验，错误审批不会消耗暂停点；仅支持本地串行使用。 */
export async function reviewDelivery(app: DeliveryContext, runId: string, input: unknown) {
  const status = await deliveryStatus(app, runId);
  if (status.mode !== app.config.mode) throw new Error('当前 Run 的模型模式与应用配置不同，请使用创建时的模式恢复');
  // 退回已保存但响应丢失时，仅相同决定可继续创建/回读同一个后继。
  if (!status.pending && status.result?.outcome === 'rework-requested') {
    const repeated = reviewSchema.parse(input);
    if (JSON.stringify(repeated) !== JSON.stringify(status.result.reviews.at(-1)))
      throw new Error('当前 Run 的退回决定已经保存，不能更换意见或批准旧版本');
    return continueProductRework(app, runId, status.result);
  }
  if (status.status !== 'suspended' || !status.pending) throw new Error('当前 Run 没有待审批交接物；请勿重复确认');
  const resumeData = validateReview(status.pending, input);
  const run = await app.deliveryWorkflow.createRun({ runId });
  await run.resume({ step: status.pending.step, resumeData });
  const next = await deliveryStatus(app, runId);
  return next.result?.outcome === 'rework-requested' ? continueProductRework(app, runId, next.result) : next;
}
