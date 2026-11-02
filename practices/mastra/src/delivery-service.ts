import type { PracticeApplication } from './mastra/app.js';
import type { WorkflowRunStatus } from '@mastra/core/workflows';
import { deliveryInputSchema, deliverySchema, pendingSchema, validateReview, type Delivery, type PendingReview } from './mastra/workflows/delivery.js';

/** CLI 只交付已校验的业务快照，不暴露框架 requestContext 或模型配置。 */
export interface DeliveryStatus {
  runId: string;
  mode?: Delivery['mode'];
  status: WorkflowRunStatus;
  pending?: PendingReview & { step: string };
  result?: Delivery;
}

/** 读取原生持久快照，提取单个待审节点；不维护平行状态或审批数据库。 */
export async function deliveryStatus(app: PracticeApplication, runId: string): Promise<DeliveryStatus> {
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
export async function startDelivery(app: PracticeApplication, brief: string) {
  const inputData = deliveryInputSchema.parse({ brief });
  const run = await app.deliveryWorkflow.createRun();
  await run.start({ inputData });
  return deliveryStatus(app, run.runId);
}

/** CLI 在恢复前校验，错误审批不会消耗暂停点；仅支持本地串行使用。 */
export async function reviewDelivery(app: PracticeApplication, runId: string, input: unknown) {
  const status = await deliveryStatus(app, runId);
  if (status.status !== 'suspended' || !status.pending) throw new Error('当前 Run 没有待审批交接物；请勿重复确认');
  if (status.mode !== app.config.mode) throw new Error('当前 Run 的模型模式与应用配置不同，请使用创建时的模式恢复');
  const resumeData = validateReview(status.pending, input);
  const run = await app.deliveryWorkflow.createRun({ runId });
  await run.resume({ step: status.pending.step, resumeData });
  return deliveryStatus(app, runId);
}
