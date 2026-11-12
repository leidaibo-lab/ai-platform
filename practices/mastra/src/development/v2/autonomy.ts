/** 自主开发的证据与停止策略；Adapter拥有执行，原生Store持有返回的新快照。
 * ADR: docs/decisions/2026-11-12-mastra-pluggable-autonomy-context.md
 */
import { developmentHash, commandEvidenceSchema } from '../contracts.js';
import { verificationRecordSchema, type StateV2, type RoleV2 } from './contracts.js';
import type { ExecutionPort } from './execution-scope.js';
import { unresolvedV2 } from './gates.js';
import { defaultLoopPolicy, resolveLoopPolicy, type LoopPolicy } from './loop-policy.js';

/** 预算异常只携带固定分类，不透传候选错误或宿主路径。 */
export class VerificationBudgetError extends Error {
  /** 工具错误不能被模型忽略后绕过硬上限。 */
  constructor() { super('登记检查执行额度已耗尽'); this.name = 'VerificationBudgetError'; }
}

/** 脱敏公开日志中的凭据形式；不读取环境变量或真实密钥文件。 */
function redact(text: string): string {
  return text.replace(/\b(Bearer\s+)\S+/gi, '$1[REDACTED]')
    .replace(/\b(sk-[\w-]{8,})\b/g, '[REDACTED]')
    .replace(/((?:api[_-]?key|password|secret|token)\s*[=:]\s*)[^\s,;]+/gi, '$1[REDACTED]')
    .replace(/(https?:\/\/)[^\s/@]+:[^\s/@]+@/gi, '$1[REDACTED]@').slice(0, 100000);
}

/** 用真实检查生成规范化记录；未知Adapter异常转成明确环境失败，绝不伪造通过。 */
export async function runVerification(execution: ExecutionPort, state: StateV2, role: RoleV2, taskPaths: string[], purpose: 'tool' | 'integration' | 'qa') {
  const history = state.verificationHistory ?? [];
  if (state.input.autonomy && history.length >= state.input.autonomy.maxCheckRuns) throw new VerificationBudgetError();
  const sourceHash = developmentHash(await execution.snapshot());
  const started = performance.now();
  let checks: Awaited<ReturnType<ExecutionPort['runChecks']>>;
  try { checks = await execution.runChecks(); }
  catch {
    checks = [{ id: 'environment:verification', command: 'registered-checks', exitCode: 1, processExitCode: 1, timedOut: false, stdoutTruncated: false, stderrTruncated: false, stdout: '', stderr: '登记检查环境不可用；需要核对已授权执行环境，禁止回退宿主执行。', durationMs: Math.max(0, performance.now() - started) }];
  }
  if (developmentHash(await execution.snapshot()) !== sourceHash) throw new Error('检查执行修改了候选源码');
  checks = checks.map(/** 只保留契约字段，日志有界脱敏；裁剪同样使证据不可通过。 */check => commandEvidenceSchema.parse({ ...check, command: redact(check.command), stdout: redact(check.stdout), stderr: redact(check.stderr), stdoutTruncated: check.stdoutTruncated || check.stdout.length > 100000, stderrTruncated: check.stderrTruncated || check.stderr.length > 100000 })).map(/** 保持执行Port的完整进程字段，空退出码不能变成成功。 */check => ({ ...check, exitCode: check.exitCode ?? 1, processExitCode: check.processExitCode ?? check.exitCode ?? 1, timedOut: !!check.timedOut, stdoutTruncated: !!check.stdoutTruncated, stderrTruncated: !!check.stderrTruncated }));
  const record = verificationRecordSchema.parse({ sequence: history.length + 1, sourceHash, role, taskPaths, round: state.round, purpose, checks });
  return { checks, record, state: { ...state, verificationHistory: [...history, record] } };
}

/** 给一次角色调用提供共享检查账本；任务父子、失败重试均使用同一额度。 */
export function verificationScope(execution: ExecutionPort, input: StateV2, role: RoleV2, paths: string[], allocated?: number) {
  let state = input; let used = 0; let exhausted = false; let queue: Promise<unknown> = Promise.resolve();
  const port: ExecutionPort = {
    /** 直接读取当前候选快照，不另存文件事实。 */
    snapshot: () => execution.snapshot(),
    /** 保留原Adapter的读取边界。 */
    readFile: path => execution.readFile(path),
    /** 保留原Adapter及角色的精确写入边界。 */
    writeFile: (path, content) => execution.writeFile(path, content),
    /** 无模型参数；局部分配与全Run上限同时约束。 */
    runChecks: () => {
      const result = queue.then(/** 原生模型可以并行请求工具；串行检查防止预算竞争。 */async () => {
        if (allocated !== undefined && used >= allocated) { exhausted = true; throw new VerificationBudgetError(); }
        try {
          const result = await runVerification(execution, state, role, paths, 'tool');
          state = result.state; used++;
          return result.checks;
        } catch (error) { if (error instanceof VerificationBudgetError) exhausted = true; throw error; }
      });
      queue = result.catch(/** 前次工具错误不阻断后续预算判定。 */() => undefined);
      return result;
    },
  };
  return { port,
    /** 每次返回新数组，原生步骤保存包括失败调用在内的实际证据。 */
    history: () => state.verificationHistory,
    /** 模型吞掉工具预算异常仍必须停止，不能声称任务成功。 */
    exhausted: () => exhausted,
  };
}

/** 在终态中明确人工介入原因，不覆盖历史检查或批准。 */
export function stopAutonomy(state: StateV2, reason: NonNullable<StateV2['stopReason']>): StateV2 {
  return { ...state, stopReason: reason, recovery: null, outcome: ['repair-budget', 'verification-budget', 'no-progress'].includes(reason) ? 'rework-exhausted' : reason === 'business-decision' ? 'clarification-required' : 'manual-attention', delivery: null };
}

/** 选取当前角色、文件/任务引用涉及的责任任务及其依赖下游，无法定位则保守重跑批准团队。 */
export function repairTasks(state: StateV2, route: StateV2['route']): Set<string> {
  const findings = unresolvedV2(state);
  const tasks = state.plan?.tasks ?? [];
  const selected = new Set<string>();
  for (const task of tasks) {
    if (route === 'architecture' || (route !== 'all' && task.role === route) || (route === 'all' && (!findings.length || findings.some(/** 责任和精确引用共同定位跨角色修复。 */finding => finding.route === task.role || finding.refs.includes(`task:${task.id}`) || task.paths.some(/** 文件归属来自批准计划。 */path => finding.refs.includes(`file:${path}`)))))) selected.add(task.id);
  }
  if (!selected.size) for (const task of tasks) selected.add(task.id);
  for (const task of tasks) if (task.dependsOn.some(/** 上游修复使依赖输出失效。 */id => selected.has(id))) selected.add(task.id);
  return selected;
}

/** 记录可复核的失败签名；只比较失败检查/未解决问题，忽略运行时长与源码噪声。 */
export function trackRepair(state: StateV2, route: StateV2['route'], policy: LoopPolicy = defaultLoopPolicy): StateV2 {
  if (!state.input.autonomy) return state;
  const latest = state.verificationHistory?.filter(/** 分支探查不能冒充集成结论。 */record => record.purpose !== 'tool').at(-1);
  const checks = latest?.sourceHash === state.checkpointHash ? latest.checks : state.checks;
  const failures = checks.filter(/** 超时/截断同样是未完成证据。 */check => check.exitCode !== 0 || (check.processExitCode !== undefined && check.processExitCode !== 0) || check.timedOut || check.stdoutTruncated || check.stderrTruncated);
  const issues = unresolvedV2(state).map(/** 相同发现跨轮的ID/报告hash变化不算进展。 */item => ({ category: item.category, route: item.route, detail: item.detail, refs: [...item.refs].sort() }));
  const signature = developmentHash({ failures: failures.map(/** 输出保留可比较诊断，时间与临时路径归一化。 */item => ({ id: item.id, exitCode: item.exitCode, timedOut: !!item.timedOut, stdoutTruncated: !!item.stdoutTruncated, stderrTruncated: !!item.stderrTruncated, output: (item.stderr + item.stdout).replace(/\/[^\s]*mastra-[^\s/]+/g, '/candidate').replace(/duration_ms[:\s]+[\d.]+/g, 'duration_ms <duration>').replace(/\b\d+(?:\.\d+)?\s*ms\b/g, '<duration>') })).sort(/** 检查返回顺序变化不制造进展。 */(a, b) => a.id.localeCompare(b.id)), issues: [...new Map(issues.map(/** 同一未解决缺陷跨报告只比较一次。 */issue => [JSON.stringify(issue), issue])).values()].sort(/** 发现顺序变化不制造进展。 */(a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))) });
  const prior = state.repairHistory?.at(-1);
  const noProgress = prior?.signature === signature ? prior.noProgress + 1 : 0;
  // 策略仅观察已经脱敏并持久化的失败，不接触执行器或模型正文。
  const kind = resolveLoopPolicy(policy).classifyRepair({ state, failures: failures.map(item => ({ id: item.id, stdout: item.stdout, stderr: item.stderr, timedOut: !!item.timedOut })) });
  const record = { round: state.round, sourceHash: state.checkpointHash, signature, tasks: [...repairTasks(state, route)], noProgress, kind };
  const next = { ...state, repairHistory: [...(state.repairHistory ?? []), record] };
  return noProgress >= state.input.autonomy.maxNoProgress ? stopAutonomy(next, 'no-progress') : next;
}

/** 有界业务返工；总次数不因架构重新规划而重置。 */
export function reworkState(state: StateV2, route: StateV2['route'], phase: StateV2['phase'], policy: LoopPolicy = defaultLoopPolicy): StateV2 {
  state = trackRepair(state, route, policy);
  if (state.outcome !== 'in-progress') return state;
  if (state.round >= state.input.maxReworks) return state.input.autonomy ? stopAutonomy(state, 'repair-budget') : { ...state, outcome: 'rework-exhausted' };
  const invalid = repairTasks(state, route);
  return { ...state, round: state.round + 1, route, phase, completedTasks: state.completedTasks.filter(
    // 独立任务保持完成证据，避免并行返工重放无关变更。
    (id) => !invalid.has(id),
  ), checks: [], checkedSourceHash: null, ...(route === 'architecture' ? { plan: null, planHash: null, approvedHash: null, approvalHash: null, readiness: null, context: null, team: undefined } : {}) };
}
