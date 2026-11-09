import { repositorySyncPauseSchema } from '../delivery/remote-handoff.js';
import { readLegacyArchitectureResult } from '../delivery/legacy-sync.js';
/** 主流程业务投影与命令；存储、调度及恢复继续归 Mastra。 */
import { blockerCycleSchema, developmentBlockers } from './blocker-contracts.js';
import { executionResolver } from '../mastra/workflows/product-development.js';
import type { PracticeConfig } from '../mastra/config.js';
import { stateV2Schema } from '../development/v2/contracts.js';
import { developmentHash } from '../development/contracts.js';
import { loadDevelopmentMethods } from '../development/v2/methods.js';
import { validateIdentityV2 } from '../development/v2/gates.js';
import type { createProductDevelopmentWorkflow } from '../mastra/workflows/product-development.js';
import { deliverySchema, pendingSchema, reviewSchema, validateReview } from '../mastra/workflows/delivery.js';
import { describeRecovery } from './recovery.js';
import { describeGate, validateGate, describeDevelopmentProgress } from './gates.js';
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
  const sync = repositorySyncPauseSchema.safeParse(payload);
  const intake = intakeSchema.safeParse(payload);
  const review = pendingSchema.safeParse(payload);
  const gate = path && payload ? describeGate(path, payload) : undefined;
  if (gate?.key === 'confirm-project-scope') {
    const reviewed = snapshot.steps?.['review-product'];
    const approved = reviewed && !Array.isArray(reviewed) ? deliverySchema.safeParse(reviewed.output) : undefined;
    if (approved?.success) gate.evidence = { ...gate.evidence, approvedProduct: approved.data.artifacts.at(-1)?.content };
  }
  const retry = describeRecovery(runId, snapshot.status, snapshot.steps ?? {});
  const development = stateV2Schema.safeParse((snapshot.result as { development?: unknown } | undefined)?.development);
  const blockers = development.success ? developmentBlockers(development.data) : [];
  const preparationRequired = development.success && !!development.data.input.project.preparationIssues?.length;
  const blockage = development.success && (development.data.outcome === 'clarification-required' || preparationRequired && development.data.outcome === 'manual-attention') && development.data.plan && blockers.length ? { phase: '技术方案生成', title: '技术方案已生成，开工条件未齐', summary: development.data.plan.summary, blockers, taskCount: development.data.plan.tasks.length, productContent: development.data.input.source.content, preparationRequired } : undefined;
  const clarify = snapshot.status === 'success' && blockage && !preparationRequired && development.success && development.data.completedTasks.length === 0 && !development.data.approvedHash ? { hash: developmentHash({ runId, development: development.data, outcome: (snapshot.result as any).outcome }), title: '补齐业务选择并修订产品稿' } : undefined;
  const reconfigure = snapshot.status === 'success' && blockage && preparationRequired && development.success && !development.data.completedTasks.length && !development.data.approvedHash && !development.data.delivery ? { hash: developmentHash({ runId, development: development.data, action: 'reconfirm-project' }) } : undefined;
  return { reconfigure, clarify, blockage: snapshot.status === 'success' ? blockage : undefined, progress: describeDevelopmentProgress(snapshot.status, snapshot.steps ?? {}), retry, outcome: (snapshot.result as { outcome?: string } | undefined)?.outcome, gate, runId, status: snapshot.status, mode: state?.success ? state.data.mode : sync.success ? sync.data.mode : undefined, brief: state?.success ? state.data.brief : '', step, intake: intake.success ? intake.data : undefined, product: step === 'review-product' && review.success ? review.data : undefined };
}
/** 所有非法业务决定在原生 resume 之前拒绝，不损坏人工暂停点。 */
export async function respondIntake(workflow: IntakeWorkflow, mode: 'fixture' | 'live', runId: string, input: unknown, config?: PracticeConfig) {
  const current = await readIntake(workflow, runId);
  if (current.status === 'success' && current.reconfigure && current.mode === mode) {
    if (!config || !input || typeof input !== 'object' || !('reconfigureHash' in input) || input.reconfigureHash !== current.reconfigure.hash) throw new GateInputError('项目重新交接入口已变化，请刷新');
    const snapshot = await workflow.getWorkflowRunById(runId);
    const state = stateV2Schema.parse((snapshot!.result as any).development);
    validateIdentityV2(state, config, loadDevelopmentMethods(config.rootDir).hash);
    const reviewed = snapshot!.steps?.['review-product'];
    const approved = reviewed && !Array.isArray(reviewed) ? deliverySchema.parse(reviewed.output) : undefined;
    if (!approved || !approved.reviews.some(/** 只能重用本次仍与开发输入一致的真实产品批准。 */review => review.role === 'product' && review.decision === 'approve' && review.artifactHash === state.input.source.hash) || !approved.artifacts.some(/** 产品正文与散列同时核对，不能重放其他版本。 */artifact => artifact.stage === 'product' && artifact.hash === state.input.source.hash && artifact.content === state.input.source.content)) throw new GateInputError('已批准产品版本不匹配，不能重新交接');
    const execution = executionResolver(config)(state.input);
    try { if (developmentHash(await execution.snapshot()) !== state.checkpointHash) throw new GateInputError('规划候选检查点已变化，请先核对'); } finally { await execution.close(); }
    const run = await workflow.createRun({ runId });
    await run.timeTravel({ step: 'confirm-project-scope', inputData: approved });
    return readIntake(workflow, runId);
  }
  if (current.status === 'success' && current.clarify && current.mode === mode) {
    if (!config || !input || typeof input !== 'object' || !('clarifyHash' in input) || input.clarifyHash !== current.clarify.hash) throw new GateInputError('澄清入口版本已变化，请刷新');
    const snapshot = await workflow.getWorkflowRunById(runId);
    const state = stateV2Schema.parse((snapshot!.result as any).development);
    validateIdentityV2(state, config, loadDevelopmentMethods(config.rootDir).hash);
    const execution = executionResolver(config)(state.input);
    try { if (developmentHash(await execution.snapshot()) !== state.checkpointHash) throw new GateInputError('源码检查点已变化，请先核对'); } finally { await execution.close(); }
    const run = await workflow.createRun({ runId });
    await run.timeTravel({ step: 'open-development-clarification', inputData: state });
    return readIntake(workflow, runId);
  }
  if (current.status === 'failed' && current.retry && current.mode === mode) {
    if (!input || typeof input !== 'object' || !('retryHash' in input) || input.retryHash !== current.retry.hash) throw new GateInputError('恢复版本已变化，请刷新');
    if ('additionalContextLevel' in input) throw new GateInputError('资料预算门槛已移除，请刷新后直接恢复');
    let checkpointInput: unknown;
    if ('kind' in current.retry && current.retry.kind === 'development-repository-sync') {
      if (!config?.hrmRepositoryRoot) throw new GateInputError('同步恢复缺少已授权仓库配置');
      const snapshot = await workflow.getWorkflowRunById(runId);
      const state = stateV2Schema.parse((snapshot!.steps![current.retry.checkpointStep] as any).payload);
      // 此入口只发布已保存结果，不调用角色；模型切换不能阻止既有交付资料的补同步。
      const saved = readLegacyArchitectureResult(config.hrmRepositoryRoot, runId, state);
      const execution = executionResolver(config)(state.input);
      try { if (developmentHash(await execution.snapshot()) !== saved.checkpointHash) throw new GateInputError('源码检查点已变化，不能重试同步'); } finally { await execution.close(); }
      // 嵌套 Workflow 的 time travel 会从快照还原每层输入；把架构 State 作为根输入会被外层 blockerCycle Schema 拒绝。
      checkpointInput = undefined;
    }
    if ('kind' in current.retry && current.retry.kind === 'development-architecture') {
      if (!config) throw new GateInputError('架构恢复缺少服务端执行配置');
      const snapshot = await workflow.getWorkflowRunById(runId);
      const entry = snapshot?.steps?.[current.retry.checkpointStep];
      if (!entry || Array.isArray(entry)) throw new GateInputError('架构检查点已变化');
      const state = stateV2Schema.parse(entry.payload);
      checkpointInput = state;
      validateIdentityV2(state, config, loadDevelopmentMethods(config.rootDir).hash);
      const execution = executionResolver(config)(state.input);
      try { if (state.checkpointHash !== developmentHash(await execution.snapshot())) throw new GateInputError('源码检查点已变化，请先核对'); }
      finally { await execution.close(); }
    }
    if ('kind' in current.retry && current.retry.kind === 'blocker-generation') {
      if (!config) throw new GateInputError('澄清恢复缺少服务端执行配置');
      const snapshot = await workflow.getWorkflowRunById(runId); const entry = snapshot?.steps?.[current.retry.step];
      if (!entry || Array.isArray(entry)) throw new GateInputError('澄清检查点已变化');
      const state = blockerCycleSchema.parse(entry.payload).development;
      validateIdentityV2(state, config, loadDevelopmentMethods(config.rootDir).hash);
      const execution = executionResolver(config)(state.input);
      try { if (developmentHash(await execution.snapshot()) !== state.checkpointHash) throw new GateInputError('澄清期间源码检查点已变化'); } finally { await execution.close(); }
    }
    const run = await workflow.createRun({ runId });
    // 从原生循环容器恢复，但输入是已保存的architecture状态；不依赖本轮未选中的前序分支，也不重做context。
    await run.timeTravel({ step: current.retry.step.split('.'), ...(checkpointInput ? { inputData: checkpointInput } : {}) });
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
    if (['confirm-blocker-answers', 'review-revised-product'].includes(current.gate.key)) {
      if (!config) throw new GateInputError('澄清提交缺少服务端配置');
      const state = blockerCycleSchema.parse(entry[1].payload).development;
      validateIdentityV2(state, config, loadDevelopmentMethods(config.rootDir).hash);
      const execution = executionResolver(config)(state.input);
      try { if (developmentHash(await execution.snapshot()) !== state.checkpointHash) throw new GateInputError('澄清期间源码检查点已变化'); } finally { await execution.close(); }
    }
    try { resumeData = validateGate(entry[0], entry[1].suspendPayload, input, entry[1].payload); }
    catch (error) { if (error instanceof Error && error.name !== 'ZodError') throw new GateInputError(error.message); throw error; }
    step = entry[0].split('.');
  } else throw new Error('当前没有可提交的人工确认，请刷新状态');
  const run = await workflow.createRun({ runId });
  await run.resume({ step, resumeData });
  return readIntake(workflow, runId);
}
