import { verificationScope, VerificationBudgetError, stopAutonomy } from './autonomy.js';
import { ContextBudgetError } from '../../delivery/context-budget.js';
/** v2单角色受控调用：精确回滚、独立故障预算与失败阶段持久化。 */
import { developmentTimeoutPolicy, diagnoseModelFailure, modelCallDiagnosticSchema } from './model-diagnostic.js';
import { automaticAttempts, retryDelayMs, pauseForCallBudget } from './recovery-policy.js';
import { setTimeout as delay } from 'node:timers/promises';
import { performance } from 'node:perf_hooks';
import { diagnoseOutput } from './output-diagnostic.js';
import type { PracticeConfig } from '../../mastra/config.js';
import type { ExecutionPort } from './execution-scope.js';
import { developmentHash } from '../contracts.js';
import { classifyDevelopmentError } from '../errors.js';
import { recoveryHashV2, type StateV2, type RoleV2 } from './contracts.js';
import { generateV2, type GeneratorV2 } from './agents.js';
import type { DevelopmentMethods } from './methods.js';

/** 回滚当前任务允许写入的部分；其他漂移失败关闭，不能隐藏外部变化。 */
export async function invokeV2(config: PracticeConfig, execution: ExecutionPort, role: RoleV2, input: StateV2, paths: string[], extra: unknown, methods: DevelopmentMethods, generate: GeneratorV2 = generateV2, validate?: (text: string) => void, checkBudget?: number) {
  let state = input;
  const verification = verificationScope(execution, input, role, paths, checkBudget);
  const before = await execution.snapshot();
  if (developmentHash(before) !== state.checkpointHash) throw new Error('v2源码检查点漂移');
  const contents: Record<string, string> = {};
  for (const path of paths) contents[path] = await execution.readFile(path);
  for (let attempt = 1; attempt <= automaticAttempts; attempt++) {
    if (state.calls >= state.maxCalls) return { state: pauseForCallBudget(state, role), entry: null };
    state = { ...state, calls: state.calls + 1 };
    const startedAt = performance.now();
    try {
      const entry = await generate(config, verification.port, role, { ...state, verificationHistory: verification.history() }, paths, { ...(extra && typeof extra === 'object' ? extra : { input: extra }), retryDiagnostic: state.faults.at(-1)?.diagnostic }, methods);
      state = { ...state, verificationHistory: verification.history() };
      if (verification.exhausted()) throw new VerificationBudgetError();
      validate?.(entry.text);
      const snapshot = await execution.snapshot();
      for (const path of Object.keys(before)) if (!paths.includes(path) && snapshot[path] !== before[path]) throw new Error('角色修改了任务外源码');
      if (Object.keys(snapshot).length !== Object.keys(before).length) throw new Error('候选文件集合发生漂移');
      return { state: { ...state, checkpointHash: developmentHash(snapshot) }, entry };
    } catch (error) {
      state = { ...state, verificationHistory: verification.history() };
      const modelCall = modelCallDiagnosticSchema.parse({ version: 'development-call.v1', callIndex: state.calls, durationMs: Math.max(0, Math.round(performance.now() - startedAt)), recordedAt: new Date().toISOString(), policy: developmentTimeoutPolicy(role), failure: diagnoseModelFailure(error) });
      const partialSourceHash = developmentHash(await execution.snapshot());
      for (const [path, content] of Object.entries(contents)) await execution.writeFile(path, content);
      if (developmentHash(await execution.snapshot()) !== developmentHash(before)) throw new Error('v2失败检查点无法完整恢复');
      if (verification.exhausted() || error instanceof VerificationBudgetError) return { state: stopAutonomy(state, 'verification-budget'), entry: null };
      const budget = error instanceof ContextBudgetError ? error.budget : undefined;
      const kind = budget ? 'context-budget' as const : error instanceof SyntaxError || (error instanceof Error && (error as Error & { code?: string }).code === 'INVALID_OUTPUT') ? 'invalid-output' as const : classifyDevelopmentError(error);
      const diagnostic = kind === 'invalid-output' ? diagnoseOutput(error) : undefined;
      const taskId = extra && typeof extra === 'object' && 'id' in extra && typeof extra.id === 'string' ? extra.id : null;
      state = { ...state, faults: [...state.faults, { sequence: state.faults.length + 1, phase: state.phase, role, taskId, kind, ...(budget ? { budget } : {}), attempt, modelCall, ...(diagnostic ? { diagnostic } : {}), checkpointHash: state.checkpointHash, partialSourceHash, restored: true }] };
      if (attempt < automaticAttempts && (['model-timeout', 'model-network'].includes(kind) || (!!state.input.autonomy && kind === 'invalid-output'))) {
        if (config.mode === 'live') await delay(retryDelayMs(attempt));
        continue;
      }
      return { state: { ...state, recovery: { hash: recoveryHashV2(state), checkpointHash: state.checkpointHash, phase: state.phase, role, taskId, kind, ...(budget ? { budget } : {}), modelCall, ...(diagnostic ? { diagnostic } : {}) } }, entry: null };
    }
  }
  throw new Error('v2有界调用没有返回');
}
