/** 主流程业务投影与命令；存储、调度及恢复继续归 Mastra。 */
import type { createProductDevelopmentWorkflow } from '../mastra/workflows/product-development.js';
import { deliverySchema, pendingSchema, reviewSchema, validateReview } from '../mastra/workflows/delivery.js';
import { describeRecovery } from './recovery.js';
import { describeGate, validateGate } from './gates.js';
import { intakeSchema, validateAnswers } from './contracts.js';
/** 仅公开本地业务输入校验，不透出模型或文件系统异常。 */
export class GateInputError extends Error {}
export type IntakeWorkflow = ReturnType<typeof createProductDevelopmentWorkflow>;
/** 从已保存快照读取当前人工关口，不接收客户端替代正文或步骤。 */
export async function readIntake(workflow: IntakeWorkflow, runId: string) {
  const snapshot = await workflow.getWorkflowRunById(runId);
  if (!snapshot) throw new Error('Run 不存在');
  const initial = snapshot.steps?.['initialize-product-development'];
  const state = initial && !Array.isArray(initial) ? deliverySchema.safeParse(initial.output) : undefined;
  const suspended = Object.entries(snapshot.steps ?? {}).find(/** 根步骤保存嵌套暂停 payload。 */([, step]) => !Array.isArray(step) && step.status === 'suspended');
  const path = suspended?.[0];
  const step = path?.split('.')[0];
  const payload = suspended && !Array.isArray(suspended[1]) ? suspended[1].suspendPayload : undefined;
  const intake = intakeSchema.safeParse(payload);
  const review = pendingSchema.safeParse(payload);
  const gate = path && payload ? describeGate(path, payload) : undefined;
  if (gate?.key === 'confirm-project-scope') {
    const reviewed = snapshot.steps?.['review-product'];
    const approved = reviewed && !Array.isArray(reviewed) ? deliverySchema.safeParse(reviewed.output) : undefined;
    if (approved?.success) gate.evidence = { ...gate.evidence, approvedProduct: approved.data.artifacts.at(-1)?.content };
  }
  const retry = describeRecovery(runId, snapshot.status, snapshot.steps ?? {});
  return { retry, outcome: (snapshot.result as { outcome?: string } | undefined)?.outcome, gate, runId, status: snapshot.status, mode: state?.success ? state.data.mode : undefined, brief: state?.success ? state.data.brief : '', step, intake: intake.success ? intake.data : undefined, product: step === 'review-product' && review.success ? review.data : undefined };
}
/** 所有非法业务决定在原生 resume 之前拒绝，不损坏人工暂停点。 */
export async function respondIntake(workflow: IntakeWorkflow, mode: 'fixture' | 'live', runId: string, input: unknown) {
  const current = await readIntake(workflow, runId);
  if (current.status === 'failed' && current.retry && current.mode === mode) {
    if (!input || typeof input !== 'object' || !('retryHash' in input) || input.retryHash !== current.retry.hash) throw new GateInputError('恢复版本已变化，请刷新');
    const run = await workflow.createRun({ runId });
    await run.timeTravel({ step: current.retry.step.split('.') });
    return readIntake(workflow, runId);
  }
  if (current.status !== 'suspended' || current.mode !== mode) throw new Error('状态或模型模式已变化，请刷新');
  let step: string | string[];
  let resumeData;
  if (current.step === 'guided-requirements' && current.intake) {
    resumeData = validateAnswers(current.intake, input);
    step = ['guided-requirements', 'requirements-round', 'confirm-requirements'];
  } else if (current.step === 'review-product' && current.product) {
    resumeData = validateReview(current.product, reviewSchema.parse(input));
    if (resumeData.decision === 'rework') throw new Error('请另起需求完善；当前页面仅支持确认或终止');
    step = 'review-product';
  } else if (current.gate) {
    const snapshot = await workflow.getWorkflowRunById(runId);
    const entry = Object.entries(snapshot!.steps ?? {}).find(/** 重新读取实际暂停路径，客户端不可替换。 */([, value]) => !Array.isArray(value) && value.status === 'suspended');
    if (!entry || Array.isArray(entry[1])) throw new Error('暂停点已变化');
    try { resumeData = validateGate(entry[0], entry[1].suspendPayload, input, entry[1].payload); }
    catch (error) { if (error instanceof Error && error.name !== 'ZodError') throw new GateInputError(error.message); throw error; }
    step = entry[0].split('.');
  } else throw new Error('当前没有可提交的人工确认，请刷新状态');
  const run = await workflow.createRun({ runId });
  await run.resume({ step, resumeData });
  return readIntake(workflow, runId);
}
