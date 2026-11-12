import { stopAutonomy, reworkState } from './autonomy.js';
/** 原生 foreach 执行一个依赖波次；每任务独占候选，屏障后校验并合并补丁。
 * ADR: docs/decisions/2026-11-07-mastra-unified-development-team.md
 */
import { createStep, createWorkflow, type Step } from '@mastra/core/workflows';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { z } from 'zod';
import type { PracticeConfig } from '../../mastra/config.js';
import { createDevelopmentExecution } from '../hrm-execution.js';
import { DevelopmentExecution } from '../../development-execution.js';
import { seedDevelopment } from '../../development-service.js';
import { developmentHash } from '../contracts.js';
import { generateV2, type GeneratorV2, type MemberRuntime } from './agents.js';
import { delegationSchema, recoveryHashV2, stateV2Schema, taskPackageSchema, type StateV2 } from './contracts.js';
import { pauseForCallBudget } from './recovery-policy.js';
import { assertApprovalV2, unresolvedV2, validateIdentityV2 } from './gates.js';
import { invokeV2 } from './invoke.js';
import type { ExecutionPort } from './execution-scope.js';
import type { DevelopmentMethods } from './methods.js';

const jobSchema = z.object({ state: stateV2Schema, task: taskPackageSchema.nullable(), files: z.record(z.string(), z.string()), budget: z.number().int().nonnegative(), checkBudget: z.number().int().nonnegative().optional() });
const resultSchema = z.object({ state: stateV2Schema, taskId: z.string().nullable(), patches: z.record(z.string(), z.string()), calls: z.number(), entry: stateV2Schema.shape.work.element.nullable(), faults: stateV2Schema.shape.faults, failed: z.boolean(), blocker: z.boolean(), delegations: z.array(delegationSchema), verificationHistory: stateV2Schema.shape.verificationHistory, stopReason: stateV2Schema.shape.stopReason, blockerKind: z.enum(['business-decision', 'authorization-required']).optional() });

/** 从批准任务派生具名成员，不固定启动所有角色；团队参与批准包 hash。 */
export function assembleTeam(state: StateV2, budgets?: { maxParallel: number; maxDelegationsPerTask: number; delegationDepth: number }): NonNullable<StateV2['team']> {
  return { planHash: state.planHash!, maxParallel: budgets?.maxParallel ?? 3, maxDelegations: budgets?.maxDelegationsPerTask ?? 3, delegationDepth: budgets?.delegationDepth ?? 1, members: state.plan!.tasks.map(
    // 成员ID由任务内容散列派生，避免模型提供宿主标识或路径。
    (task) => ({ id: `member-${developmentHash({ plan: state.planHash, task: task.id }).slice(0, 16)}`, role: task.role, taskId: task.id, paths: task.paths }),
  ) };
}

/** 单分支只访问当前波次快照；委派可选择已登记角色，但子成员不能继续委派。 */
async function executeMember(config: PracticeConfig, job: z.infer<typeof jobSchema>, methods: DevelopmentMethods, generate: GeneratorV2): Promise<z.infer<typeof resultSchema>> {
  const base = { state: job.state, taskId: job.task?.id ?? null, patches: {}, calls: 0, entry: null, faults: [], failed: false, blocker: false, delegations: [] };
  if (!job.task) return base;
  const task = job.task;
  const member = job.state.team!.members.find(
    // 只能使用已批准团队中的当前任务成员。
    (item) => item.taskId === task.id,
  );
  if (!member || member.role !== task.role || developmentHash(member.paths) !== developmentHash(task.paths)) throw new Error('任务与批准团队不一致');
  const temporary = mkdtempSync(resolve(tmpdir(), 'mastra-team-member-'));
  const directory = resolve(temporary, 'run');
  let execution: DevelopmentExecution | undefined;
  try {
    seedDevelopment(directory, { ...job.state.input, project: { ...job.state.input.project, files: job.files, writablePaths: task.paths } });
    execution = createDevelopmentExecution(resolve(directory, 'candidate'), { ...job.state.input.project, writablePaths: task.paths });
    const branch = execution;
    let activeExecution: ExecutionPort = branch;
    let calls = 0; let delegates = 0; let queue: Promise<unknown> = Promise.resolve();
    let delegatedBlocker = false;
    let blockerKind: 'business-decision' | 'authorization-required' | undefined;
    let delegationError: Error | undefined;
    const delegated: NonNullable<StateV2['delegations']> = [];
    /** 每次真实父/子模型调用共用分支预算，不依赖模型自报用量。 */
    async function counted(role: typeof task.role, state: StateV2, paths: string[], extra: unknown, runtime: MemberRuntime) {
      if (calls >= job.budget) throw new Error('团队任务模型预算耗尽');
      calls++;
      const entry = await generate(config, activeExecution, role, state, paths, extra, methods, runtime);
      if (entry.text.includes('BUSINESS_BLOCKER:')) blockerKind = 'business-decision';
      if (entry.text.includes('AUTHORIZATION_BLOCKER:')) blockerKind = 'authorization-required';
      return entry;
    }
    const runtime: MemberRuntime = { memberId: member.id,
      /** 所有子委派串行执行，防止同一父任务内部的文件重叠写入。 */
      delegate: (request) => {
        if (++delegates > job.state.team!.maxDelegations || !job.state.input.project.roles.includes(request.role) || new Set(request.paths).size !== request.paths.length || request.paths.some(
          // 子权限是父批准路径的子集，不能借角色切换扩大写权限。
          (path) => !task.paths.includes(path),
        )) { delegationError = new Error('委派超出已批准角色、路径或次数'); throw delegationError; }
        const sequence = delegates;
        const result = queue.then(
          // 子成员只获得读写工具，不注册 delegateTask，递归深度固定为1。
          async () => {
            const memberId = `${member.id}-delegate-${sequence}`;
            const checkpointHash = developmentHash(await branch.snapshot());
            const entry = await counted(request.role, { ...job.state, checkpointHash }, request.paths, { ...task, goal: request.goal, parentId: member.id, findings: unresolvedV2(job.state) }, { memberId });
            delegatedBlocker ||= entry.text.includes('ARCHITECTURE_BLOCKER:');
            delegated.push({ taskId: task.id, parentId: member.id, memberId, role: request.role, goal: request.goal, paths: request.paths, outputHash: developmentHash(entry), sourceHash: developmentHash(await branch.snapshot()) });
            return { memberId, text: entry.text };
          },
        );
        // 即使模型忽略工具失败，也不能使整个任务被认为已成功。
        queue = result;
        return result;
      },
    };
    /** 外层检查点负责父任务整体回滚，失败不会影响其他并行候选。 */
    const parent: GeneratorV2 = async (_config, _execution, role, state, paths, extra) => {
      activeExecution = _execution;
      const previousCount = delegated.length;
      try {
        const entry = await counted(role as typeof task.role, state, paths, extra, runtime);
        await queue;
        if (delegationError) throw delegationError;
        if (delegated.length === previousCount) throw new SyntaxError('团队任务未实际委派实现');
        const delegatedPaths = delegated.slice(previousCount).flatMap(
          // 父任务由子成员完整分工，路径各自唯一且必须覆盖整个批准任务。
          (item) => item.paths,
        );
        if (new Set(delegatedPaths).size !== delegatedPaths.length || developmentHash([...delegatedPaths].sort()) !== developmentHash([...task.paths].sort())) throw new SyntaxError('子任务路径必须无重叠地覆盖父批准任务');
        return entry;
      } catch (error) {
        await queue.catch(
          // 等待所有已发起子调用结束后才能回滚父任务快照。
          () => undefined,
        );
        queue = Promise.resolve();
        delegated.splice(previousCount);
        delegatedBlocker = false;
        blockerKind = undefined;
        delegationError = undefined;
        throw error;
      }
    };
    const called = await invokeV2(config, branch, task.role, job.state, task.paths, { ...task, findings: unresolvedV2(job.state) }, methods, parent, undefined, job.checkBudget);
    const patches: Record<string, string> = {};
    if (called.entry) for (const path of task.paths) patches[path] = await branch.readFile(path);
    const faults = called.state.faults.slice(job.state.faults.length);
    return { state: job.state, taskId: task.id, patches, calls, entry: called.entry, faults, failed: !called.entry, blocker: (called.entry?.text.includes('ARCHITECTURE_BLOCKER:') ?? false) || delegatedBlocker, delegations: called.entry ? delegated : [], verificationHistory: called.state.verificationHistory?.slice(job.state.verificationHistory?.length ?? 0), stopReason: called.state.stopReason, blockerKind };
  } finally { if (execution) await execution.close(); rmSync(temporary, { recursive: true, force: true }); }
}

/** 原生调度与持久化 foreach 分支，业务代码仅选择依赖就绪任务并执行补丁屏障。 */
export function createTeamExecution(config: PracticeConfig, execution: ExecutionPort, methods: DevelopmentMethods, generate: GeneratorV2 = generateV2, bind: <T extends Step<any, any, any, any, any, any>>(step: T) => T = (step) => step) {
  const select = createStep({ id: 'dispatch-ready-tasks', description: '从批准团队选择依赖已完成的任务，最多3个并行', inputSchema: stateV2Schema, outputSchema: z.array(jobSchema),
    // 本波次所有分支读取同一源码基线，预留最坏父子调用预算。
    execute: async ({ inputData: state }) => {
      const noop = [{ state, task: null, files: {}, budget: 0 }];
      if (state.phase !== 'implement' || state.outcome !== 'in-progress' || state.recovery) return noop;
      assertApprovalV2(state); validateIdentityV2(state, config, methods.hash);
      if (state.approvedHash !== state.approvalHash || !state.team) throw new Error('开发团队未经当前方案批准');
      if (developmentHash(await execution.snapshot()) !== state.checkpointHash) throw new Error('团队派发基线漂移');
      const remaining = state.plan!.tasks.filter(
        // 已完成分支只回读，不在故障接续时重放。
        (task) => !state.completedTasks.includes(task.id),
      );
      if (!remaining.length) return noop;
      const capacity = Math.min(state.team.maxParallel, Math.floor((state.maxCalls - state.calls) / 8));
      if (capacity < 1) return [{ state: pauseForCallBudget(state, 'backend'), task: null, files: {}, budget: 0 }];
      const ready = remaining.filter(
        // 架构声明的依赖全部完成后才进入下一波次。
        (task) => task.dependsOn.every(
          // 依赖完成集由宿主维护，不能靠自然语言宣称。
          (id) => state.completedTasks.includes(id),
        ),
      ).slice(0, capacity);
      const checkBudget = state.input.autonomy ? Math.floor(Math.max(0, state.input.autonomy.maxCheckRuns - (state.verificationHistory?.length ?? 0) - 2) / ready.length) : undefined;
      if (!ready.length) throw new Error('团队任务图没有可执行节点');
      const files: Record<string, string> = {};
      for (const path of Object.keys(await execution.snapshot())) files[path] = await execution.readFile(path);
      return ready.map(
        // 每分支最多8次父子模型调用，聚合后全Run仍不超过72次。
        (task) => ({ state, task, files, budget: 8, checkBudget }),
      );
    },
  });
  const worker = createStep({ id: 'execute-team-member', description: '动态任务负责人 → 受限 delegateTask 子成员 → 独立候选补丁', inputSchema: jobSchema, outputSchema: resultSchema,
    // 原生foreach负责并发，成员只处理自己的输入，不共享候选目录。
    execute: async ({ inputData }) => executeMember(config, inputData, methods, generate),
  });
  const merge = createStep({ id: 'merge-team-results', description: '等待所有分支、校验范围、合并补丁并保存已完成任务', inputSchema: z.array(resultSchema), outputSchema: stateV2Schema,
    // 只有当前源码仍等于派发基线时才能提交本波次补丁。
    execute: async ({ inputData: results }) => {
      const state = results[0].state;
      if (results.length === 1 && results[0].taskId === null) return state.phase === 'implement' && state.outcome === 'in-progress' && !state.recovery ? { ...state, phase: 'development-self-check' as const } : state;
      if (developmentHash(await execution.snapshot()) !== state.checkpointHash) throw new Error('团队合并基线漂移');
      const patches: Record<string, string> = {};
      for (const result of results) {
        if (developmentHash(result.state) !== developmentHash(state)) throw new Error('团队分支输入版本不一致');
        const task = state.plan!.tasks.find(
          // 按批准任务核对补丁归属，禁止未知或重复路径。
          (item) => item.id === result.taskId,
        );
        if (!task) throw new Error('未知团队任务');
        for (const [path, content] of Object.entries(result.patches)) {
          if (!task.paths.includes(path) || path in patches) throw new Error('团队补丁范围冲突');
          patches[path] = content;
        }
      }
      const originals: Record<string, string> = {};
      for (const path of Object.keys(patches)) originals[path] = await execution.readFile(path);
      try { for (const [path, content] of Object.entries(patches)) await execution.writeFile(path, content); }
      catch (error) {
        for (const [path, content] of Object.entries(originals)) await execution.writeFile(path, content);
        if (developmentHash(await execution.snapshot()) !== state.checkpointHash) throw new Error('团队合并回滚失败');
        throw error;
      }
      const next = { ...state, calls: state.calls + results.reduce(
        // 计数包含动态子成员，不只计算父Agent调用。
        (sum, result) => sum + result.calls, 0,
      ), checkpointHash: developmentHash(await execution.snapshot()), completedTasks: [...state.completedTasks], work: [...state.work], faults: [...state.faults], delegations: [...(state.delegations ?? [])], verificationHistory: [...(state.verificationHistory ?? [])] };
      for (const result of results) {
        for (const record of result.verificationHistory ?? []) next.verificationHistory.push({ ...record, sequence: next.verificationHistory.length + 1 });
        if (result.entry) { next.completedTasks.push(result.taskId!); next.work.push(result.entry); next.delegations.push(...result.delegations); }
        for (const fault of result.faults) next.faults.push({ ...fault, sequence: next.faults.length + 1 });
      }
      const stopped = results.find(/** 分支额度耗尽或明确业务/权限阻塞不能当作普通模型故障重试。 */result => result.stopReason || (next.input.autonomy && result.blockerKind));
      if (stopped) return stopAutonomy(next, stopped.stopReason ?? stopped.blockerKind!);
      const failed = results.find(
        // 已成功分支持久化完成；人工接续只派发失败任务。
        (result) => result.failed,
      );
      if (failed) {
        const task = state.plan!.tasks.find(
          // 故障恢复沿用原任务责任和当前合并源码检查点。
          (item) => item.id === failed.taskId,
        )!;
        return { ...next, recovery: { hash: recoveryHashV2(next), checkpointHash: next.checkpointHash, phase: next.phase, role: task.role, taskId: task.id, kind: failed.faults.at(-1)?.kind ?? 'model-error', budget: failed.faults.at(-1)?.budget, modelCall: failed.faults.at(-1)?.modelCall, ...(failed.faults.at(-1)?.diagnostic ? { diagnostic: failed.faults.at(-1)!.diagnostic } : {}) } };
      }
      if (results.some(
        // 任一实现成员遇到契约阻塞即重规划，不能继续自检交付。
        (result) => result.blocker,
      )) {
        return reworkState(next, 'architecture', 'prepare-context');
      }
      const complete = next.plan!.tasks.every(
        // 仅全部批准任务完成后进入整体自检。
        (task) => next.completedTasks.includes(task.id),
      );
      return { ...next, phase: complete ? 'development-self-check' as const : 'implement' as const };
    },
  });
  return createWorkflow({ id: 'execute-agent-team', description: '动态团队按依赖波次并发实现，受限委派并合并', inputSchema: stateV2Schema, outputSchema: stateV2Schema }).then(bind(select)).foreach(worker, { concurrency: 3 }).then(bind(merge)).commit();
}
