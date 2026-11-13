import { readExecution } from './execution-control.js';
import { repositorySyncPauseSchema } from '../delivery/remote-handoff.js';
import { readLegacyArchitectureResult } from '../delivery/legacy-sync.js';
/** 主流程业务投影与命令；存储、调度及恢复继续归 Mastra。 */
import { blockerCycleSchema, developmentBlockers } from './blocker-contracts.js';
import { executionResolver } from '../mastra/workflows/product-development.js';
import type { PracticeConfig } from '../mastra/config.js';
import { stateV2Schema } from '../development/v2/contracts.js';
import { lifecycleSchema } from '../delivery/contracts.js';
import { developmentHash } from '../development/contracts.js';
import { loadDevelopmentMethods } from '../development/v2/methods.js';
import { validateIdentityV2 } from '../development/v2/gates.js';
import type { createProductDevelopmentWorkflow } from '../mastra/workflows/product-development.js';
import { deliverySchema, pendingSchema, reviewSchema, validateReview } from '../mastra/workflows/delivery.js';
import { describeRecovery } from './recovery.js';
import { describeGate, projectGateReceipt, describeDevelopmentProgress } from './gates.js';
import { intakeSchema, validateAnswers } from './contracts.js';
import { loadResources, resourceWorkflowConfig } from '../resources/runtime.js';
import { currentResources, withResources } from '../resources/scope.js';
import { frozenResourcesSchema, ResourceError } from '../resources/contracts.js';
import { createApprovalReceipt, createHumanGate, projectAgentRun, type ApprovalReceipt, type HumanGate } from '../resources/governance.js';
/** 仅公开本地业务输入校验，不透出模型或文件系统异常。 */
export class GateInputError extends Error {}
export type IntakeWorkflow = ReturnType<typeof createProductDevelopmentWorkflow>;

type DiagnosticItem = {
  id: string;
  status: 'completed' | 'running' | 'waiting' | 'failed';
  phase: string;
  role: string;
  summary: string;
  evidence: string[];
  nextAction?: string;
  tools?: { name: string; inputHash?: string; returned?: boolean; repeated?: boolean; callCount?: number }[];
};

/** 从已保存角色产物、执行观察和人工关口拼装统一诊断轨迹，不暴露工具入参或模型原始错误。 */
function buildDiagnosticTrace(input: { state?: any; development?: any; execution?: ReturnType<typeof readExecution>; progress?: any; gate?: any; retry?: any }): { enabled: true; items: DiagnosticItem[] } {
  const items: DiagnosticItem[] = [];
  for (const entry of input.state?.productWork?.entries ?? []) {
    const diagnostic = entry.diagnostic;
    const detailedTools = diagnostic.tools;
    const evidence = [
      `阶段目标：${diagnostic.objective}`,
      `模型：${diagnostic.model.modelId ?? '未返回模型标识'} · ${diagnostic.model.steps} 个步骤 · ${diagnostic.durationMs}ms`,
      `输入引用：${diagnostic.input.sourceRefs.length} 个 · 需求轮次 ${diagnostic.input.intakeRound}`,
      ...(diagnostic.output.headings.length ? [`输出结构：${diagnostic.output.headings.join('、')}`] : []),
      ...(diagnostic.failures.length ? diagnostic.failures.map((failure: { attempt: number; kind: string; durationMs: number; detail: string }) => `第 ${failure.attempt} 次尝试失败：${failure.kind} · ${failure.durationMs}ms · ${failure.detail}`) : []),
    ];
    items.push({ id: `product-${entry.role}`, status: 'completed', phase: diagnostic.phase, role: `产品${entry.role}`, summary: `已完成${entry.role}阶段：${diagnostic.objective}。输出 ${diagnostic.output.contentChars} 字，结果已绑定版本指纹。`, evidence, tools: detailedTools, nextAction: diagnostic.nextAction });
  }
  for (const entry of input.development?.work ?? []) {
    const tools = (entry.tools ?? []).map((name: string) => ({ name }));
    items.push({ id: `development-${entry.role}-${entry.round}`, status: 'completed', phase: '开发实施', role: entry.role, summary: `已完成${entry.role}角色的本轮交付，结果绑定当前源码检查点。`, evidence: [`模型步骤 ${entry.steps}`, ...(entry.modelId ? [`模型：${entry.modelId}`] : []), ...(tools.length ? [`实际调用工具：${tools.map((tool: { name: string }) => tool.name).join('、')}`] : ['本节点未记录工具调用'])], tools });
  }
  if (input.execution && !input.execution.settled) {
    const toolTrace = input.execution.toolTrace.map(item => ({ name: item.toolName, inputHash: item.inputHash.slice(0, 12), returned: item.returned, repeated: !item.newCallSignature }));
    items.push({ id: 'active-execution', status: 'running', phase: '实时执行', role: input.execution.role, summary: `当前正在进行第 ${input.execution.attempt} 次模型尝试，已完成 ${input.execution.steps} 个模型步骤。`, evidence: [`最近真实活动：${new Date(input.execution.lastActivityAt).toISOString()}`], tools: toolTrace, nextAction: toolTrace.length ? '等待工具结果后继续生成；重复签名仅标记事实，不自动判定业务错误。' : '等待模型返回下一步决策。' });
  }
  if (input.progress) items.push({ id: 'progress', status: input.progress.title.includes('失败') ? 'failed' : 'running', phase: input.progress.phase, role: '当前执行角色', summary: input.progress.detail, evidence: input.progress.attemptDetails ?? [], nextAction: input.progress.next });
  if (input.gate) items.push({ id: `gate-${input.gate.key}`, status: 'waiting', phase: '人工确认', role: '用户', summary: input.gate.description, evidence: [`当前关口：${input.gate.key}`, ...(input.gate.humanGate?.requiredArtifactHashes?.length ? [`绑定版本数：${input.gate.humanGate.requiredArtifactHashes.length}`] : [])], nextAction: '完成当前内嵌确认卡后继续流程。' });
  if (input.retry) items.push({ id: 'retry', status: 'failed', phase: input.retry.title, role: '系统', summary: input.retry.reason, evidence: input.retry.attemptDetails ?? [], nextAction: input.retry.next });
  return { enabled: true, items };
}
/** 将专用产品/澄清暂停点也投影为统一关口，不改变它们各自的resume schema。 */
function projectNativeGate(runId: string, gateType: HumanGate['gateType'], path: string, payload: unknown, artifactHash?: string): HumanGate {
  return createHumanGate({ runId, gateType, requiredArtifactHashes: artifactHash && /^[a-f0-9]{64}$/.test(artifactHash) ? [artifactHash] : [], gateHash: developmentHash({ path, payload }), status: 'open' });
}

/** 把专用resume结果投影为统一回执；原生Workflow仍保存其实际状态和交接物。 */
function projectNativeReceipt(gate: HumanGate, data: unknown, actor: string | null, decision: ApprovalReceipt['decision']): ApprovalReceipt {
  return createApprovalReceipt({ gate, decision, actor, payload: data, bindingHashes: gate.requiredArtifactHashes });
}
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
  const gate = path && payload ? describeGate(path, payload, runId) : undefined;
  const humanGate = gate?.humanGate ?? (path && intake.success ? projectNativeGate(runId, 'requirements', path, payload) : path && review.success ? projectNativeGate(runId, 'product', path, payload, review.data.artifact.hash) : undefined);
  if (gate?.key === 'confirm-project-scope') {
    const reviewed = snapshot.steps?.['review-product'];
    const approved = reviewed && !Array.isArray(reviewed) ? deliverySchema.safeParse(reviewed.output) : undefined;
    if (approved?.success) gate.evidence = { ...gate.evidence, approvedProduct: approved.data.artifacts.at(-1)?.content };
  }
  const observed = readExecution(runId);
  // 已完成的本机取消不应永久封死没有副作用的产品节点；恢复仍由原生失败叶节点和恢复哈希共同约束。
  const retry = observed?.phase === 'canceling' ? undefined : describeRecovery(runId, snapshot.status, snapshot.steps ?? {});
  const development = stateV2Schema.safeParse((snapshot.result as { development?: unknown } | undefined)?.development);
  const lifecycle = lifecycleSchema.safeParse(snapshot.result);
  const frozen = initial && !Array.isArray(initial) ? frozenResourcesSchema.safeParse((snapshot.steps?.['freeze-role-resources'] as any)?.output?.resources) : undefined;
  const binding = currentResources()?.binding ?? (frozen?.success ? frozen.data : undefined);
  const agentRun = development.success && binding ? projectAgentRun({ runId, bundleHash: binding.bundleHash, state: development.data }) : undefined;
  const blockers = development.success ? developmentBlockers(development.data) : [];
  const preparationRequired = development.success && !!development.data.input.project.preparationIssues?.length;
  const blockage = development.success && (development.data.outcome === 'clarification-required' || preparationRequired && development.data.outcome === 'manual-attention') && development.data.plan && blockers.length ? { phase: '技术方案生成', title: '技术方案已生成，开工条件未齐', summary: development.data.plan.summary, blockers, taskCount: development.data.plan.tasks.length, productContent: development.data.input.source.content, preparationRequired } : undefined;
  const clarify = snapshot.status === 'success' && blockage && !preparationRequired && development.success && development.data.completedTasks.length === 0 && !development.data.approvedHash ? { hash: developmentHash({ runId, development: development.data, outcome: (snapshot.result as any).outcome }), title: '补齐业务选择并修订产品稿' } : undefined;
  const reconfigure = snapshot.status === 'success' && blockage && preparationRequired && development.success && !development.data.completedTasks.length && !development.data.approvedHash && !development.data.delivery ? { hash: developmentHash({ runId, development: development.data, action: 'reconfirm-project' }) } : undefined;
  const delivery = lifecycle.success ? { branch: lifecycle.data.codePublication?.receipt.branch, candidateCommit: lifecycle.data.codePublication?.receipt.commit, candidateStatus: lifecycle.data.codePublication?.status, qualityHash: lifecycle.data.codePublication?.qualityHash, releaseHash: lifecycle.data.release.hash, releaseStatus: lifecycle.data.release.receipt?.status, healthPassed: lifecycle.data.release.health?.checks.every(check => check.status === 'passed'), pullRequest: lifecycle.data.release.pullRequest } : undefined;
  const progress = describeDevelopmentProgress(snapshot.status, snapshot.steps ?? {});
  const diagnostics = buildDiagnosticTrace({ state: state?.success ? state.data : undefined, development: development.success ? development.data : undefined, execution: observed, progress, gate, retry });
  return { executionSettings: observed ? { maxAttempts: observed?.role === 'requirements' ? 1 : 2, totalMs: 1800000, stepMs: 600000, retryDelayMs: 1000, sdkRetries: 0, outputTokens: observed?.role === 'requirements' ? undefined : 16000 } : undefined, execution: observed, agentRun, diagnostics, humanGate, developmentStop: development.success && development.data.stopReason ? { reason: development.data.stopReason, rounds: development.data.round, calls: development.data.calls, checkRuns: development.data.verificationHistory?.length ?? 0, latestChecks: development.data.verificationHistory?.at(-1)?.checks } : undefined, delivery, reconfigure, clarify, blockage: snapshot.status === 'success' ? blockage : undefined, progress, retry, outcome: (snapshot.result as { outcome?: string } | undefined)?.outcome, gate, runId, status: snapshot.status, mode: state?.success ? state.data.mode : sync.success ? sync.data.mode : undefined, brief: state?.success ? state.data.brief : '', step, intake: intake.success ? intake.data : undefined, product: step === 'review-product' && review.success ? review.data : undefined };
}
/** 所有非法业务决定在原生 resume 之前拒绝，不损坏人工暂停点。 */
export async function respondIntake(workflow: IntakeWorkflow, mode: 'fixture' | 'live', runId: string, input: unknown, config?: PracticeConfig): Promise<Awaited<ReturnType<typeof readIntake>>> {
  config ??= resourceWorkflowConfig(workflow);
  if (!currentResources()) {
    const storage = workflow.mastra?.getStorage();
    if (!config || !storage) throw new ResourceError('BINDING_MISSING');
    const binding = await loadResources(storage, config, runId);
    return withResources({ storage, binding }, /** HTTP预校验与后续原生恢复共享已核验资源身份。 */
      () => respondIntake(workflow, mode, runId, input, config));
  }
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
  if ((current.status === 'failed' || current.status === 'canceled') && current.retry && current.mode === mode) {
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
    if ('kind' in current.retry && current.retry.kind === 'requirements-analysis') {
      // 需求分析没有副作用，原 Run 的确认历史已在输入快照中；仅回放失败分析节点。
      await run.timeTravel({ step: current.retry.step.split('.') });
      return readIntake(workflow, runId);
    }
    // 从原生循环容器恢复，但输入是已保存的architecture状态；不依赖本轮未选中的前序分支，也不重做context。
    await run.timeTravel({ step: current.retry.step.split('.'), ...(checkpointInput ? { inputData: checkpointInput } : {}) });
    return readIntake(workflow, runId);
  }
  if (current.status !== 'suspended' || current.mode !== mode) throw new Error('状态或模型模式已变化，请刷新');
  let step: string | string[];
  let resumeData;
  let receipt: ApprovalReceipt | undefined;
  if (current.step === 'guided-requirements' && current.intake) {
    resumeData = validateAnswers(current.intake, input);
    if (current.humanGate) receipt = projectNativeReceipt(current.humanGate, resumeData, typeof resumeData.reviewer === 'string' ? resumeData.reviewer : null, 'submitted');
    step = ['guided-requirements', 'requirements-round', 'confirm-requirements'];
  } else if (current.step === 'review-product' && current.product) {
    resumeData = validateReview(current.product, reviewSchema.parse(input));
    if (resumeData.decision === 'rework') throw new Error('请另起需求完善；当前页面仅支持确认或终止');
    if (current.humanGate) receipt = projectNativeReceipt(current.humanGate, resumeData, resumeData.reviewer, resumeData.decision);
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
    try { const projected = projectGateReceipt(entry[0], entry[1].suspendPayload, input, entry[1].payload, runId); resumeData = projected.data; receipt = projected.receipt; }
    catch (error) { if (error instanceof Error && error.name !== 'ZodError') throw new GateInputError(error.message); throw error; }
    step = entry[0].split('.');
  } else throw new Error('当前没有可提交的人工确认，请刷新状态');
  const run = await workflow.createRun({ runId });
  await run.resume({ step, resumeData });
  return { ...await readIntake(workflow, runId), ...(receipt ? { approvalReceipt: receipt } : {}) };
}
