import { projectAcceptanceEvidence } from '../delivery/acceptance-evidence.js';
import { lifecycleSchema } from '../delivery/contracts.js';
import { repositorySyncPauseSchema } from '../delivery/remote-handoff.js';
import { createHash } from 'node:crypto';
import { readLegacyArchitectureResult } from '../delivery/legacy-sync.js';
/** 主流程业务投影与命令；存储、调度及恢复继续归 Mastra。 */
import { blockerCycleSchema, developmentBlockers } from './blocker-contracts.js';
import { executionResolver } from '../mastra/workflows/product-development.js';
import type { PracticeConfig } from '../mastra/config.js';
import { inputV2Schema, stateV2Schema } from '../development/v2/contracts.js';
import { developmentHash } from '../development/contracts.js';
import { loadDevelopmentMethods } from '../development/v2/methods.js';
import { validateIdentityV2 } from '../development/v2/gates.js';
import type { createProductDevelopmentWorkflow } from '../mastra/workflows/product-development.js';
import { deliverySchema, pendingSchema, reviewSchema, validateReview } from '../mastra/workflows/delivery.js';
import { describeRecovery } from './recovery.js';
import { describeGate, validateGate, describeDevelopmentProgress } from './gates.js';
import { intakeSchema, validateAnswers } from './contracts.js';
import { projectRunTimeline } from './run-timeline.js';
/** 仅公开本地业务输入校验，不透出模型或文件系统异常。 */
export class GateInputError extends Error {}
export type IntakeWorkflow = ReturnType<typeof createProductDevelopmentWorkflow>;
const recoveryInFlight = new Set<string>();
/** 在团队化主流程中按叶节点后缀读取步骤，避免业务服务依赖嵌套层数。 */
function findStep(snapshot: any, suffix: string) {
  const entries = Object.entries(snapshot.steps ?? {}).filter(([path, step]) => !Array.isArray(step) && (path === suffix || path.endsWith(`.${suffix}`)));
  return entries.sort(([left], [right]) => right.split('.').length - left.split('.').length)[0]?.[1] as any;
}
/** 将原生完整路径投影为业务阶段名称，团队容器不向页面泄漏。 */
function logicalStep(path: string | undefined): string | undefined {
  if (!path) return undefined;
  const parts = path.split('.');
  if (!['product-team', 'development-team', 'test-team', 'deployment-team', 'delivery-team'].includes(parts[0])) return parts[0];
  // draft-product 只是产品团队容器；页面展示其内部当前业务阶段，例如 guided-requirements。
  return parts[1] === 'draft-product' ? parts[2] ?? parts[1] : parts[1] ?? parts[0];
}
/** 从已保存快照读取当前人工关口，不接收客户端替代正文或步骤。 */
export async function readIntake(workflow: IntakeWorkflow, runId: string) {
  const snapshot = await workflow.getWorkflowRunById(runId);
  if (!snapshot) throw new Error('Run 不存在');
  const initial = snapshot.steps?.['initialize-product-development'];
  const state = initial && !Array.isArray(initial) ? deliverySchema.safeParse(initial.output) : undefined;
  const suspended = Object.entries(snapshot.steps ?? {}).filter(([, step]) => !Array.isArray(step) && step.status === 'suspended' && (step as any).suspendPayload !== undefined).sort(([left], [right]) => right.split('.').length - left.split('.').length)[0];
  const path = suspended?.[0];
  const step = logicalStep(path);
  const payload = suspended && !Array.isArray(suspended[1]) ? suspended[1].suspendPayload : undefined;
  const sync = repositorySyncPauseSchema.safeParse(payload);
  const intake = intakeSchema.safeParse(payload);
  const review = pendingSchema.safeParse(payload);
  const gate = path && payload ? describeGate(path, payload) : undefined;
  if (gate?.key === 'confirm-project-scope') {
    const reviewed = findStep(snapshot, 'review-product');
    const approved = reviewed && !Array.isArray(reviewed) ? deliverySchema.safeParse(reviewed.output) : undefined;
    if (approved?.success) gate.evidence = { ...gate.evidence, approvedProduct: approved.data.artifacts.at(-1)?.content };
  }
  const retry = describeRecovery(runId, snapshot.status, snapshot.steps ?? {});
  const development = stateV2Schema.safeParse((snapshot.result as { development?: unknown } | undefined)?.development);
  const blockers = development.success ? developmentBlockers(development.data) : [];
  const preparationRequired = development.success && !!development.data.input.project.preparationIssues?.length;
  const blockage = development.success && (development.data.outcome === 'clarification-required' || preparationRequired && development.data.outcome === 'manual-attention') && development.data.plan && blockers.length ? { phase: '技术方案生成', title: '技术方案已生成，开工条件未齐', summary: development.data.plan.summary, blockers, taskCount: development.data.plan.tasks.length, productContent: development.data.input.source.content, preparationRequired } : undefined;
  const clarify = snapshot.status === 'success' && blockage && !preparationRequired && development.success ? { hash: developmentHash({ runId, development: development.data, outcome: (snapshot.result as any).outcome }), title: development.data.completedTasks.length ? '处理后期业务缺口，修订产品稿并回归' : '补齐业务选择并修订产品稿' } : undefined;
  const reconfigure = snapshot.status === 'success' && blockage && preparationRequired && development.success && !development.data.completedTasks.length && !development.data.approvedHash && !development.data.delivery ? { hash: developmentHash({ runId, development: development.data, action: 'reconfirm-project' }) } : undefined;
  const intakeMode = state?.success ? state.data.intakeMode ?? state.data.intake?.intakeMode ?? (state.data.intake?.enabled ? 'clarify' : 'autofill') : intake.success ? intake.data.intakeMode ?? (intake.data.enabled ? 'clarify' : 'autofill') : undefined;
  /** 正式规格在产品确认步骤写入，不能只读取初始化步骤的早期快照。 */
  const delivery = Object.values(snapshot.steps ?? {}).map(entry => Array.isArray(entry) ? undefined : deliverySchema.safeParse((entry as any)?.output)).find(item => item?.success && item.data.formalSpecifications?.length)?.data ?? (state?.success ? state.data : undefined);
  const successor = delivery?.formalSpecifications?.length ? { sourceRunId: runId, iterationId: delivery.correlation?.iterationId, artifacts: delivery.formalSpecifications.map(item => ({ kind: item.kind, branch: item.handoff.branch, commit: item.handoff.commit, paths: item.paths })) } : undefined;
  const successorBaseline = delivery?.successorBaseline ? { sourceRunId: delivery.successorBaseline.sourceRunId, changeBrief: delivery.successorBaseline.changeBrief, artifacts: delivery.successorBaseline.artifacts.map(item => ({ kind: item.kind, branch: item.branch, commit: item.commit, path: item.path, hash: item.hash })) } : undefined;
  const currentLifecycle = lifecycleSchema.safeParse(snapshot.status === 'suspended' && suspended && !Array.isArray(suspended[1]) ? suspended[1].payload : snapshot.result);
  const acceptanceEvidence = currentLifecycle.success ? projectAcceptanceEvidence(currentLifecycle.data) : undefined;
  return { acceptanceEvidence, developmentStop: development.success && development.data.stopReason ? { reason: development.data.stopReason, rounds: development.data.round, calls: development.data.calls, checkRuns: development.data.verificationHistory?.length ?? 0, latestChecks: development.data.verificationHistory?.at(-1)?.checks } : undefined, successor, successorBaseline, reconfigure, clarify, blockage: snapshot.status === 'success' ? blockage : undefined, progress: describeDevelopmentProgress(snapshot.status, snapshot.steps ?? {}), retry, outcome: (snapshot.result as { outcome?: string } | undefined)?.outcome, gate, runId, status: snapshot.status, mode: delivery?.mode ?? (sync.success ? sync.data.mode : undefined), intakeMode, brief: delivery?.brief ?? '', step, createdAt: snapshot.createdAt, updatedAt: snapshot.updatedAt, timeline: projectRunTimeline(snapshot), intake: intake.success ? intake.data : undefined, product: step === 'review-product' && review.success ? review.data : undefined };
}
/** 所有非法业务决定在原生 resume 之前拒绝，不损坏人工暂停点。 */
export async function respondIntake(workflow: IntakeWorkflow, mode: 'fixture' | 'live', runId: string, input: unknown, config?: PracticeConfig) {
  const recovering = !!input && typeof input === 'object' && 'retryHash' in input;
  if (recovering && recoveryInFlight.has(runId)) throw new GateInputError('该运行正在恢复，请勿重复提交');
  if (recovering) recoveryInFlight.add(runId);
  try { return await respondIntakeOnce(workflow, mode, runId, input, config); }
  finally { if (recovering) recoveryInFlight.delete(runId); }
}

/** 在进程内串行恢复同一 Run，实际权限与版本仍在执行前重新校验。 */
async function respondIntakeOnce(workflow: IntakeWorkflow, mode: 'fixture' | 'live', runId: string, input: unknown, config?: PracticeConfig) {
  const current = await readIntake(workflow, runId);
  if (current.status === 'success' && current.reconfigure && current.mode === mode) {
    if (!config || !input || typeof input !== 'object' || !('reconfigureHash' in input) || input.reconfigureHash !== current.reconfigure.hash) throw new GateInputError('项目重新交接入口已变化，请刷新');
    const snapshot = await workflow.getWorkflowRunById(runId);
    const state = stateV2Schema.parse((snapshot!.result as any).development);
    validateIdentityV2(state, config, loadDevelopmentMethods(config.rootDir).hash);
    const reviewed = findStep(snapshot, 'review-product');
    const approved = reviewed && !Array.isArray(reviewed) ? deliverySchema.parse(reviewed.output) : undefined;
    if (!approved || !approved.reviews.some(/** 只能重用本次仍与开发输入一致的真实产品批准。 */review => review.role === 'product' && review.decision === 'approve' && review.artifactHash === state.input.source.hash) || !approved.artifacts.some(/** 产品正文与散列同时核对，不能重放其他版本。 */artifact => artifact.stage === 'product' && artifact.hash === state.input.source.hash && artifact.content === state.input.source.content)) throw new GateInputError('已批准产品版本不匹配，不能重新交接');
    const execution = executionResolver(config)(state.input);
    try { if (developmentHash(await execution.snapshot()) !== state.checkpointHash) throw new GateInputError('规划候选检查点已变化，请先核对'); } finally { await execution.close(); }
    const run = await workflow.createRun({ runId });
    await run.timeTravel({ step: ['development-team', 'confirm-project-scope'], inputData: approved });
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
    await run.timeTravel({ step: ['development-team', 'open-development-clarification'], inputData: state });
    return readIntake(workflow, runId);
  }
  if (current.status === 'failed' && current.retry && current.mode === mode) {
    if (!input || typeof input !== 'object' || !('retryHash' in input) || input.retryHash !== current.retry.hash) throw new GateInputError('恢复版本已变化，请刷新');
    if ('additionalContextLevel' in input) throw new GateInputError('资料预算门槛已移除，请刷新后直接恢复');
    let checkpointInput: unknown;
    if ('kind' in current.retry && current.retry.kind === 'development-initialization') {
      if (!config || config.mode !== mode) throw new GateInputError('恢复模式或服务配置已变化');
      const snapshot = await workflow.getWorkflowRunById(runId);
      const entry = snapshot?.steps?.[current.retry.checkpointStep];
      if (!entry || Array.isArray(entry)) throw new GateInputError('开发初始化检查点已变化');
      const savedInput = inputV2Schema.parse(entry.payload);
      const execution = executionResolver(config, { requireExisting: true })(savedInput);
      try {
        const expected = Object.fromEntries(Object.entries(savedInput.project.files).sort().map(/** 候选文件摘要使用原始字节的 SHA-256。 */([path, content]) => [path, createHash('sha256').update(content).digest('hex')]));
        if (developmentHash(await execution.snapshot()) !== developmentHash(expected)) throw new GateInputError('原候选检查点已变化，不能恢复');
      } finally { await execution.close(); }
      checkpointInput = savedInput;
    }
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
    step = ['product-team', 'draft-product', 'guided-requirements', 'requirements-round', 'confirm-requirements'];
  } else if (current.step === 'review-product' && current.product) {
    resumeData = validateReview(current.product, reviewSchema.parse(input));
    if (resumeData.decision === 'rework') {
      const snapshot = await workflow.getWorkflowRunById(runId);
      const review = findStep(snapshot, 'review-product');
      const source = deliverySchema.parse(review?.payload);
      const artifact = source.artifacts.at(-1);
      if (!artifact || artifact.stage !== 'product') throw new GateInputError('当前待审产品稿已变化，请刷新');
      const nextRound = (source.productRework?.round ?? 0) + 1;
      const rework = { sourceRunId: runId, sourceHash: artifact.hash, sourceContent: artifact.content, reviewer: resumeData.reviewer, feedback: resumeData.comment, round: nextRound };
      const restart = deliverySchema.parse({ ...source, intake: { intakeMode: 'clarify', enabled: true, ready: false, round: 0, history: [] }, intakeMode: 'clarify', artifacts: [], reviews: [], productWork: undefined, productQualityReview: undefined, productRework: rework, outcome: 'in-progress' });
      const run = await workflow.createRun({ runId });
      await run.timeTravel({ step: ['product-team', 'draft-product', 'guided-requirements'], inputData: restart });
      return readIntake(workflow, runId);
    }
    step = ['product-team', 'review-product'];
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
