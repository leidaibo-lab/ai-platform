import { registerApiRoute, type ContextWithMastra } from '@mastra/core/server';
import { z } from 'zod';
import { developmentHash } from '../development/contracts.js';
import { stateV2Schema, type StateV2 } from '../development/v2/contracts.js';
import { validateIdentityV2 } from '../development/v2/gates.js';
import { loadDevelopmentMethods } from '../development/v2/methods.js';
import { matchesPlatformSecret, platformRecoveryStepId, platformRepairEventSchema, platformRepairPauseSchema, platformRepairProof } from '../development/v2/platform-recovery.js';
import type { PracticeConfig } from '../mastra/config.js';
import { executionResolver } from '../mastra/workflows/development-team.js';
import type { IntakeWorkflow } from './service.js';
import { assertProjectCorrelation, selectProjectConfig } from '../business-engineering/project.js';

type Snapshot = NonNullable<Awaited<ReturnType<IntakeWorkflow['getWorkflowRunById']>>>;

/** 获取唯一可接续的原生平台暂停点。 */
export function platformWait(snapshot: Snapshot) {
  if (snapshot.status !== 'suspended') return;
  for (const [path, step] of Object.entries(snapshot.steps ?? {})) {
    if (Array.isArray(step) || step.status !== 'suspended' || path.split('.').at(-1) !== platformRecoveryStepId) continue;
    const pause = platformRepairPauseSchema.safeParse(step.suspendPayload);
    if (pause.success) return { path, ...pause.data };
  }
}

/** 从原生结果和阶段快照读取历史证据。嵌套 Run 的结果同样保持版本绑定。 */
export function observedDevelopmentStates(snapshot: Snapshot): StateV2[] {
  const result = snapshot.result as { development?: unknown } | undefined;
  const candidates: unknown[] = [result?.development ?? result];
  for (const entry of Object.values(snapshot.steps ?? {})) {
    for (const item of Array.isArray(entry) ? entry : [entry]) {
      if (!item || typeof item !== 'object') continue;
      const step = item as { output?: { development?: unknown }; payload?: unknown; suspendPayload?: { recoveryState?: unknown; findingsState?: unknown } };
      candidates.push(step.output?.development ?? step.output, step.payload, step.suspendPayload?.recoveryState, step.suspendPayload?.findingsState);
    }
  }
  return candidates.flatMap(candidate => {
    if (!candidate || typeof candidate !== 'object' || !('version' in candidate) || candidate.version !== 'development-state.v2') return [];
    const parsed = stateV2Schema.safeParse(candidate);
    return parsed.success ? [parsed.data] : [];
  });
}

/** 从原生快照计算单次运行的观测计数。未知历史样本单独标明。 */
export function projectRecoveryMetrics(snapshot: Snapshot) {
  const states = observedDevelopmentStates(snapshot);
  if (!states.length) return undefined;
  const faults = new Map<string, StateV2['faults'][number]>();
  const attempts = new Map<string, NonNullable<StateV2['technicalRecovery']>['attempts'][number]>();
  const platformEvents = new Set<string>();
  const humanDecisions = new Set<string>();
  const approvals = new Set<string>();
  for (const state of states) {
    for (const fault of state.faults) faults.set(fault.id ?? `${state.input.source.hash}:${fault.sequence}`, fault);
    for (const attempt of state.technicalRecovery?.attempts ?? []) attempts.set(`${attempt.faultId}:${attempt.action}`, attempt);
    for (const event of state.technicalRecovery?.platformResumes ?? []) platformEvents.add(event.eventId);
    for (const decision of state.recoveries) humanDecisions.add(decision.hash);
    for (const review of state.reviews) if (review.authority === 'local-human-label') approvals.add(review.hash);
  }
  const observedFaults = [...faults.values()];
  const signatures = new Set(observedFaults.map(fault => JSON.stringify([fault.phase, fault.role, fault.taskId, fault.kind, fault.diagnostic?.code, fault.modelCall?.failure.source, fault.modelCall?.failure.httpStatus])));
  const values = [...attempts.values()];
  const completedClarifications = Object.entries(snapshot.steps ?? {}).filter(([path, entry]) => path.split('.').at(-1)?.replace(/#\d+$/, '') === 'confirm-blocker-answers' && !Array.isArray(entry) && entry.status === 'success').length;
  return {
    coverage: observedFaults.every(fault => fault.id) && states.some(state => state.technicalRecovery) ? 'structured' as const : 'legacy-partial' as const,
    technicalFaults: faults.size,
    repeatedFaults: faults.size - signatures.size,
    automaticExecutions: values.length,
    automaticPassed: values.filter(item => item.result !== 'failed').length,
    verifiedRepairs: values.filter(item => item.result === 'verified').length,
    platformEvents: platformEvents.size,
    humanTechnicalDecisions: humanDecisions.size,
    architectureApprovals: approvals.size,
    completedClarifications,
  };
}

/** 按暂停版本回读原生回执，重复通知不触发第二次执行。 */
export async function notifyPlatformRepair(
  workflow: Pick<IntakeWorkflow, 'getWorkflowRunById' | 'createRun' | 'mastra'>,
  runId: string, input: z.infer<typeof platformRepairEventSchema>, secret: string,
  verify: (state: StateV2) => Promise<void>,
) {
  /** 对当前 Run 的快照回读同一故障或重复事件。 */
  function receipt(snapshot: Snapshot) {
    const records = observedDevelopmentStates(snapshot).flatMap(state => state.technicalRecovery?.platformResumes ?? []);
    const sameEvent = records.find(item => item.eventId === input.eventId);
    if (sameEvent && (sameEvent.faultId !== input.faultId || sameEvent.checkpoint !== input.checkpoint)) return 'stale' as const;
    return records.some(item => item.faultId === input.faultId && item.checkpoint === input.checkpoint) ? 'duplicate' as const : undefined;
  }
  const snapshot = await workflow.getWorkflowRunById(runId);
  if (!snapshot) return 'missing';
  const accepted = receipt(snapshot);
  if (accepted) return accepted;
  const pause = platformWait(snapshot);
  if (!pause) return snapshot.status === 'running' ? 'processing' : 'stale';
  if (pause.faultId !== input.faultId || pause.checkpoint !== input.checkpoint) return 'stale';
  await verify(pause.recoveryState);
  try {
    const run = await workflow.createRun({ runId });
    const store = await workflow.mastra?.getStorage()?.getStore('workflows');
    if (!store?.supportsConcurrentUpdates()) throw new Error('平台恢复要求原生 Store 原子认领');
    const before = await store.loadWorkflowSnapshot({ workflowName: 'product-development', runId });
    const current = await workflow.getWorkflowRunById(runId);
    const currentPause = current && platformWait(current);
    if (!before || !currentPause || currentPause.path !== pause.path || currentPause.faultId !== input.faultId || currentPause.checkpoint !== input.checkpoint) return current && receipt(current) ? 'duplicate' : current?.status === 'running' ? 'processing' : 'stale';
    const claimed = await store.updateWorkflowState({ workflowName: 'product-development', runId, opts: { status: 'running', expectedStatus: 'suspended' } });
    if (!claimed) return 'processing';
    // CAS 只比较状态，必须再比较返回的原上下文；旧通知不能认领后继的同名团队暂停。
    const { status: _beforeStatus, ...beforeIdentity } = before;
    const { status: _claimedStatus, ...claimedIdentity } = claimed;
    if (developmentHash(claimedIdentity) !== developmentHash(beforeIdentity)) {
      await store.updateWorkflowState({ workflowName: 'product-development', runId, opts: { status: 'suspended', expectedStatus: 'running' } });
      return 'stale';
    }
    let started = false;
    try {
      await run.resumeClaimed({ claimedSnapshot: claimed, step: currentPause.path.split('.'), resumeData: { ...input, proof: platformRepairProof(secret, input) }, onExecutionStarted: () => { started = true; } });
    } finally {
      if (!started) await store.updateWorkflowState({ workflowName: 'product-development', runId, opts: { status: 'suspended', expectedStatus: 'running' } });
    }
  } catch {
    // 多实例由 Mastra 获取原生执行所有权。失败和竞争都按实际状态回读。
    const current = await workflow.getWorkflowRunById(runId);
    if (current && receipt(current)) return receipt(current)!;
    if (current?.status === 'running') return 'processing';
    return 'stale';
  }
  const current = await workflow.getWorkflowRunById(runId);
  const consumed = current && observedDevelopmentStates(current).flatMap(state => state.technicalRecovery?.platformResumes ?? []).some(record => record.eventId === input.eventId && record.faultId === input.faultId && record.checkpoint === input.checkpoint);
  return consumed ? 'accepted' : current && receipt(current) === 'duplicate' ? 'duplicate' : current?.status === 'running' ? 'processing' : 'stale';
}

/** 平台机器接口与工作台人工决定入口独立授权。 */
export function createPlatformRecoveryRoutes(workflow: IntakeWorkflow, config: PracticeConfig) {
  const secret = config.platformRepairToken;
  if (!secret) return [];
  const path = '/platform-api/runs/:runId/dependency-repair';
  /** 平台通知使用单独凭据且不回传候选和原生恢复证明。 */
  function authorize(c: ContextWithMastra) {
    c.header('Cache-Control', 'no-store');
    return matchesPlatformSecret(c.req.header('authorization') ?? '', `Bearer ${secret}`);
  }
  /** 在原生认领前检查固定项目候选，步骤执行时再次检查。 */
  async function validateCandidate(state: StateV2) {
    const selected = selectProjectConfig(config, state.input.correlation?.projectId);
    assertProjectCorrelation(selected, state.input.correlation);
    validateIdentityV2(state, selected, loadDevelopmentMethods(selected.rootDir).hashFor(state.input, state.methodBundleHash));
    const execution = executionResolver(selected, { requireExisting: true })(state.input);
    try {
      if (developmentHash(await execution.snapshot()) !== state.checkpointHash) throw new Error('候选检查点已变化');
    } finally { await execution.close(); }
  }
  return [
    registerApiRoute(path, { method: 'GET',
      /** 只返回待修依赖和版本标识。 */
      handler: async c => {
        if (!authorize(c)) return c.json({ error: '平台身份校验失败' }, 401);
        const runId = z.uuid().safeParse(c.req.param('runId'));
        if (!runId.success) return c.json({ error: 'Run 标识无效' }, 400);
        const snapshot = await workflow.getWorkflowRunById(runId.data);
        if (!snapshot) return c.json({ error: 'Run 不存在' }, 404);
        const pause = platformWait(snapshot);
        return c.json({ waiting: pause ? { faultId: pause.faultId, checkpoint: pause.checkpoint, dependency: pause.dependency } : null });
      },
    }),
    registerApiRoute(path, { method: 'POST',
      /** 修复方使用稳定事件 ID，响应丢失后可原样重发。 */
      handler: async c => {
        if (!authorize(c)) return c.json({ error: '平台身份校验失败' }, 401);
        const runId = z.uuid().safeParse(c.req.param('runId'));
        const message = platformRepairEventSchema.safeParse(await c.req.json().catch(() => undefined));
        if (!runId.success || !message.success) return c.json({ error: '平台修复事件格式无效' }, 400);
        try {
          const status = await notifyPlatformRepair(workflow, runId.data, message.data, secret, validateCandidate);
          return c.json({ status }, status === 'processing' ? 202 : status === 'stale' ? 409 : status === 'missing' ? 404 : 200);
        } catch { return c.json({ error: '候选版本或运行环境无法核验' }, 409); }
      },
    }),
  ];
}
