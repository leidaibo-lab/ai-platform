import { verificationScope, VerificationBudgetError, stopAutonomy } from './autonomy.js';
import { ContextBudgetError } from '../../delivery/context-budget.js';
/** v2单角色受控调用：精确回滚、独立故障预算与失败阶段持久化。 */
import { developmentTimeoutPolicy, diagnoseModelFailure, modelCallDiagnosticSchema } from './model-diagnostic.js';
import { automaticAttempts, retryDelayMs, pauseForCallBudget } from './recovery-policy.js';
import { setTimeout as delay } from 'node:timers/promises';
import { performance } from 'node:perf_hooks';
import { randomUUID } from 'node:crypto';
import { diagnoseOutput } from './output-diagnostic.js';
import type { PracticeConfig } from '../../mastra/config.js';
import type { ExecutionPort } from './execution-scope.js';
import { developmentHash } from '../contracts.js';
import { classifyDevelopmentError } from '../errors.js';
import { recoveryHashV2, type StateV2, type RoleV2 } from './contracts.js';
import { generateV2, type GeneratorV2 } from './agents.js';
import type { DevelopmentMethods } from './methods.js';
import type { LiveOutputEvent } from '../../intake/live-output.js';
import { blockTechnicalRecovery, matchingFault, recordTechnicalAttempt, technicalAction, usedTechnicalAttempts, type TechnicalAttempt } from './recovery-policy.js';

/** 回滚当前任务允许写入的部分；其他漂移失败关闭，不能隐藏外部变化。 */
export async function invokeV2(config: PracticeConfig, execution: ExecutionPort, role: RoleV2, input: StateV2, paths: string[], extra: unknown, methods: DevelopmentMethods, generate: GeneratorV2 = generateV2, validate?: (text: string) => string | void, checkBudget?: number, onProgress?: (event: LiveOutputEvent) => Promise<void>) {
  let state = input;
  const verification = verificationScope(execution, input, role, paths, checkBudget);
  const before = await execution.snapshot();
  if (developmentHash(before) !== state.checkpointHash) throw new Error('v2源码检查点漂移');
  const contents: Record<string, string> = {};
  for (const path of paths) contents[path] = await execution.readFile(path);
  const taskId = extra && typeof extra === 'object' && 'id' in extra && typeof extra.id === 'string' ? extra.id : null;
  const pending = state.faults.find(fault => fault.id && fault.id === state.technicalRecovery?.pendingFaultId && fault.phase === state.phase && fault.role === role && fault.taskId === taskId);
  const platform = pending && state.technicalRecovery?.platformResumes?.some(receipt => receipt.faultId === pending.id);
  const pendingAction = platform ? 'platform-repair' : pending?.checkpointHash === state.checkpointHash && pending ? technicalAction(pending) : undefined;
  let retry: Omit<TechnicalAttempt, 'result' | 'artifactHash'> | undefined;
  if (pendingAction && pending?.id) {
    retry = { faultId: pending.id, action: pendingAction, check: pendingAction === 'correct-output' && validate ? 'output-validation' : 'role-execution' };
    if (pendingAction === 'backoff' && config.mode === 'live') await delay(retryDelayMs(pending.attempt));
  }
  for (let attempt = pendingAction && !platform ? pending!.attempt + 1 : 1; attempt <= automaticAttempts; attempt++) {
    if (state.calls >= state.maxCalls) return { state: pauseForCallBudget(state, role), entry: null };
    state = { ...state, calls: state.calls + 1 };
    const startedAt = performance.now();
    let origin: NonNullable<StateV2['faults'][number]['origin']> = 'role';
    try {
      const fault = matchingFault(state, role, taskId);
      const entry = await generate(config, verification.port, role, { ...state, verificationHistory: verification.history() }, paths, { ...(extra && typeof extra === 'object' ? extra : { input: extra }), retryDiagnostic: fault?.diagnostic }, methods, undefined, onProgress);
      state = { ...state, verificationHistory: verification.history() };
      if (verification.exhausted()) throw new VerificationBudgetError();
      origin = 'output-validation';
      const validatedHash = validate?.(entry.text);
      origin = 'role';
      const snapshot = await execution.snapshot();
      for (const path of Object.keys(before)) if (!paths.includes(path) && snapshot[path] !== before[path]) throw new Error('角色修改了任务外源码');
      if (Object.keys(snapshot).length !== Object.keys(before).length) throw new Error('候选文件集合发生漂移');
      const checkpointHash = developmentHash(snapshot);
      if (retry) state = recordTechnicalAttempt(state, { ...retry, result: retry.action === 'correct-output' && validate ? 'verified' : 'execution-passed', artifactHash: validatedHash || checkpointHash });
      return { state: { ...state, checkpointHash }, entry };
    } catch (error) {
      state = { ...state, verificationHistory: verification.history() };
      if (retry) state = recordTechnicalAttempt(state, { ...retry, result: 'failed' });
      const modelCall = modelCallDiagnosticSchema.parse({ version: 'development-call.v1', callIndex: state.calls, durationMs: Math.max(0, Math.round(performance.now() - startedAt)), recordedAt: new Date().toISOString(), policy: developmentTimeoutPolicy(role), failure: diagnoseModelFailure(error) });
      const partialSourceHash = developmentHash(await execution.snapshot());
      for (const [path, content] of Object.entries(contents)) await execution.writeFile(path, content);
      if (developmentHash(await execution.snapshot()) !== developmentHash(before)) throw new Error('v2失败检查点无法完整恢复');
      if (verification.exhausted() || error instanceof VerificationBudgetError) return { state: stopAutonomy(state, 'verification-budget'), entry: null };
      const budget = error instanceof ContextBudgetError ? error.budget : undefined;
      const kind = budget ? 'context-budget' as const : error instanceof SyntaxError || (error instanceof Error && (error as Error & { code?: string }).code === 'INVALID_OUTPUT') ? 'invalid-output' as const : classifyDevelopmentError(error);
      const diagnostic = kind === 'invalid-output' ? diagnoseOutput(error) : undefined;
      const fault = { sequence: state.faults.length + 1, ...(state.technicalRecovery ? { id: randomUUID(), origin } : {}), phase: state.phase, role, taskId, kind, ...(budget ? { budget } : {}), attempt, ...(diagnostic ? { diagnostic } : {}), modelCall, checkpointHash: state.checkpointHash, partialSourceHash, restored: true as const };
      state = { ...state, faults: [...state.faults, fault] };
      if (state.technicalRecovery) {
        const action = technicalAction(fault);
        if (!action) return { state: blockTechnicalRecovery(state, fault, 'diagnosis-required'), entry: null };
        if (usedTechnicalAttempts(state.technicalRecovery) >= state.technicalRecovery.limit) return { state: blockTechnicalRecovery(state, fault, 'continuation-limit'), entry: null };
        const priorFault = state.faults.at(-2);
        if (attempt >= automaticAttempts || (attempt >= 3 && action === 'correct-output' && diagnostic?.code === priorFault?.diagnostic?.code
          && developmentHash(diagnostic?.issues ?? []) === developmentHash(priorFault?.diagnostic?.issues ?? []))) {
          return { state: blockTechnicalRecovery(state, fault, 'no-progress'), entry: null };
        }
        // 只读角色在原生迭代边界保存失败与待接续状态。实现分支在隔离候选内处理回滚。
        if (role === 'context' || role === 'architect' || role === 'readiness' || role === 'reviewer') {
          return { state: { ...state, technicalRecovery: { ...state.technicalRecovery, pendingFaultId: fault.id } }, entry: null };
        }
        retry = { faultId: fault.id!, action, check: 'role-execution' };
        if (action === 'backoff' && config.mode === 'live') await delay(retryDelayMs(attempt));
        continue;
      }
      if (attempt < automaticAttempts && (['model-timeout', 'model-network'].includes(kind) || (!!state.input.autonomy && kind === 'invalid-output'))) {
        if (config.mode === 'live') await delay(retryDelayMs(attempt));
        continue;
      }
      return { state: { ...state, recovery: { hash: recoveryHashV2(state), checkpointHash: state.checkpointHash, phase: state.phase, role, taskId, kind, ...(budget ? { budget } : {}), modelCall, ...(diagnostic ? { diagnostic } : {}) } }, entry: null };
    }
  }
  throw new Error('v2有界调用没有返回');
}
