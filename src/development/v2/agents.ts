import { methodPrompt, methodSkill } from '../../mastra/team-methods.js';
import { verifyTeamMethods } from '../../mastra/nacos-resources.js';
import { projectRepositoryRoot, projectSpec } from '../../business-engineering/project.js';
import { createNativeMemory } from '../../mastra/context-memory.js';
import { LibSQLStore } from '@mastra/libsql';
import { createTaskContext } from '../../delivery/task-context.js';
/** 原生 Agent 工厂；方法按角色最少注册，工具权限与模型报告相互独立。 */
import { developmentHash } from '../contracts.js';
import { developmentTimeoutPolicy, diagnoseModelResult, runWithDevelopmentDeadline } from './model-diagnostic.js';
import { developmentMaxSteps, developmentPrepareStep } from './generation-policy.js';
import { OutputValidationError } from './output-diagnostic.js';
import { Agent } from '@mastra/core/agent';
import { projectLiveOutputChunk, type LiveOutputEvent } from '../../intake/live-output.js';
import { MastraLanguageModelV2Mock } from '@mastra/core/test-utils/llm-mock';
import { noopLogger } from '@mastra/core/logger';
import { z } from 'zod';
import { resolveModelId, type PracticeConfig } from '../../mastra/config.js';
import type { ExecutionPort } from './execution-scope.js';
import { createDevelopmentTools } from './tools.js';
import { developmentInstructions } from '../agents.js';
import { classifyDevelopmentError, DevelopmentModelError, DevelopmentToolError } from '../errors.js';
import { assessmentSchema, contextDraftSchema, evidenceRefs, planV2Schema, type RoleV2, type StateV2, type EntryV2 } from './contracts.js';
import type { DevelopmentMethods } from './methods.js';
import { projectToolFacts } from '../../intake/run-timeline.js';
import { developmentProductApproval } from '../../delivery/product-approval.js';

/** 运行内成员身份和委派回调由宿主注入，模型不能构造执行器。 */
export interface MemberRuntime {
  memberId: string;
  delegate?: (request: { role: 'frontend' | 'backend' | 'infrastructure'; goal: string; paths: string[] }) => Promise<{ text: string; memberId: string }>;
}

/** 研发团队对外可见的三类 Agent；具体任务角色只用于审批、授权和路由。 */
export type DevelopmentAgentKind = 'development-lead-agent' | 'development-implementer-agent' | 'development-reviewer-agent';

/** 将运行阶段映射到固定 Agent 类型；自检是 Workflow 确定性门禁，不实例化 Agent。 */
export function developmentAgentKind(role: RoleV2): DevelopmentAgentKind | null {
  if (role === 'context' || role === 'architect') return 'development-lead-agent';
  if (role === 'readiness' || role === 'reviewer') return 'development-reviewer-agent';
  if (role === 'frontend' || role === 'backend' || role === 'infrastructure') return 'development-implementer-agent';
  return null;
}

/** 对只读角色给出结构化职责；开发原有职责与权限继续复用。 */
const instructions: Record<RoleV2, string> = {
  ...developmentInstructions,
  context: methodPrompt('development.v2.agents.1', undefined),
  architect: methodPrompt('development.v2.agents.2', undefined),
  readiness: methodPrompt('development.v2.agents.3', undefined),
  reviewer: methodPrompt('development.v2.agents.4', undefined),
};

/** 只给当前职责注册对应方法，实现和自检通过批准任务包消费方法结果。 */
function selectedMethod(role: RoleV2, state: StateV2, methods: DevelopmentMethods) {
  const remoteKey = role === 'context' ? 'context' : role === 'architect' ? 'task' : role === 'readiness' ? 'readiness' : role === 'reviewer' ? 'review' : null;
  if (state.input.teamMethods && remoteKey) return methodSkill(state.input.teamMethods, remoteKey);
  return role === 'context' ? methods.skills.context : role === 'architect' ? (methods.usesLegacyTaskHandoff(state) ? methods.legacyTask : methods.skills.task)
    : role === 'readiness' ? methods.skills.readiness : role === 'reviewer' ? methods.skills.review : null;
}

/** 返回当前角色应实际读取的受控方法及参考资料。 */
function assignedMethods(role: RoleV2, state: StateV2, methods: DevelopmentMethods) {
  const primary = selectedMethod(role, state, methods);
  const assigned = primary ? [{ skill: primary, reference: 'upstream.md' }] : [];
  if (state.input.architectureDocumentFormat && (role === 'architect' || role === 'readiness')) {
    assigned.push({ skill: state.input.teamMethods ? methodSkill(state.input.teamMethods, 'architectureDocument') : methods.skills.architectureDocument, reference: 'document-layout.md' });
  }
  return assigned;
}

/** 固定模型实际调用原生 Skill、读取和受限写入；仅验证流程，不评价业务质量。 */
function fixtureModel(role: RoleV2, state: StateV2, paths: string[], assigned: ReturnType<typeof assignedMethods>, runtime?: MemberRuntime) {
  const calls: { name: string; input: unknown }[] = [];
  for (const { skill, reference } of assigned) calls.push({ name: 'skill', input: { name: skill.name } }, { name: 'skill_read', input: { skillName: skill.name, path: `references/${reference}` } });
  if (['frontend', 'backend', 'infrastructure'].includes(role)) {
    if (runtime?.delegate) calls.push({ name: 'delegateTask', input: { role, goal: '按批准任务实现当前文件并保留接口', paths } });
    else for (const path of paths) calls.push({ name: 'mastra_workspace_read_file', input: { path, showLineNumbers: false } }, { name: 'writeFile', input: { path, content: state.input.project.adapterId === 'python-unittest.v1' ? 'def fixture_value():\n    """固定 fixture 只验证工具链，不代表业务实现。"""\n    return 1\n' : '/** 固定fixture只验证工具链，不代表业务实现。 */\nexport function fixtureValue() { return 1; }\n' } });
  } else {
    const instructionFiles = state.input.project.instructionFiles ?? [];
    for (const path of instructionFiles) calls.push({ name: 'mastra_workspace_read_file', input: { path, showLineNumbers: false } });
    if (!instructionFiles.length) calls.push({ name: 'mastra_workspace_read_file', input: { path: Object.keys(state.input.project.files)[0], showLineNumbers: false } });
  }
  const refs = state.requirements.map(
    // 固定样例完整引用批准原文，仅作为结构回归。
    (item) => item.id,
  );
  let output: unknown = { summary: 'fixture读取真实检查', route: state.input.project.roles[0] };
  if (role === 'context') output = { rules: [{ text: 'fixture使用manifest文件边界；未做真实规则推理', refs: [`file:${state.input.project.instructionFiles?.[0] ?? Object.keys(state.input.project.files)[0]}`] }], unknowns: [] };
  if (role === 'architect') output = { summary: 'fixture有序任务包', coverage: [{ requirement: state.input.source.content, behavior: '按文件实现', verification: '已登记检查' }], contracts: '只写批准路径，不修改检查文件', blockers: [], risks: ['fixture未做真实架构推理'], tasks: state.input.project.writablePaths.map(
    // 各fixture文件独立实现；真实项目的依赖由架构 Agent 明确声明。
    (path, i) => ({ id: `fixture-task-${i + 1}`, role: state.input.project.roles[i % state.input.project.roles.length], paths: [path], dependsOn: [], requirementRefs: refs, acceptanceRefs: refs, contextRefs: [`file:${path}`], constraints: ['不扩大路径与命令权限'], verificationRefs: state.verificationRefs }),
  ), ...(state.input.architectureDocumentFormat ? { document: fixtureArchitectureDocument() } : {}) };
  if (role === 'readiness' || role === 'reviewer') output = { verdict: 'PASS', findings: [], coverageRefs: [...refs, ...(state.plan?.tasks.map(
    // 代码评审显式列出所覆盖的批准任务。
    (task) => `task:${task.id}`,
  ) ?? [])], unchecked: ['fixture不评价业务质量'], resolutions: [] };
  if (['frontend', 'backend', 'infrastructure'].includes(role)) output = 'fixture已实际读取并修改批准路径。';
  let index = 0;
  return new MastraLanguageModelV2Mock({
    // 固定脚本交由 Mastra 执行所有工具；不直接替代工具结果。
    doGenerate: async () => {
      const call = calls[index++];
      return { content: call ? [{ type: 'tool-call' as const, toolCallId: `v2-${index}`, toolName: call.name, input: JSON.stringify(call.input) }] : [{ type: 'text' as const, text: typeof output === 'string' ? output : JSON.stringify(output) }], finishReason: call ? 'tool-calls' as const : 'stop' as const, usage: { inputTokens: 12, outputTokens: 20, totalTokens: 32 }, warnings: [] };
    },
  });
}

/** 构造覆盖两类图和正文的隔离测试文档。 */
function fixtureArchitectureDocument() {
  return {
    scope: '交付固定样例的批准需求。', impact: '涉及批准任务中的候选源码与既有调用方。',
    design: '保持候选接口及原有数据契约。',
    architecture: { nodes: [{ id: 'caller', label: '调用方' }, { id: 'candidate', label: '候选模块' }], edges: [{ from: 'caller', to: 'candidate', label: '调用候选接口' }] },
    dataFlow: { nodes: [{ id: 'input', label: '输入' }, { id: 'check', label: '处理' }, { id: 'result', label: '返回结果' }], edges: [{ from: 'input', to: 'check', label: '读取参数' }, { from: 'check', to: 'result', label: '生成结果' }] },
    implementation: '按计划分配文件并运行登记检查。', risks: '验证接口兼容性。必要时撤销候选变更。',
  };
}

/** 调用期工具失败只用于停止当前 Agent，不保存审批或恢复事实。 */
const invocationToolFailures = new WeakMap<Agent, DevelopmentToolError[]>();

/** 注册最小只读/写入工具与所需 Skill，方法原文不能改变工具或流程。 */
export async function createAgentV2(config: PracticeConfig, execution: ExecutionPort, role: RoleV2, state: StateV2, paths: string[], methods: DevelopmentMethods, runtime?: MemberRuntime, storage?: LibSQLStore) {
  const kind = developmentAgentKind(role);
  if (!kind) throw new Error('development-self-check 必须由 Workflow 执行固定检查，不能创建 Agent');
  const tools = await createDevelopmentTools(execution, role, state, paths, runtime);
  const failures: DevelopmentToolError[] = [];
  for (const [name, tool] of Object.entries(tools)) {
    if (!tool || !('execute' in tool) || typeof tool.execute !== 'function') continue;
    const execute = tool.execute;
    /** 宿主工具抛错即锁存本次失败，模型后续完成文本不能掩盖拒绝事实。 */
    (tool as any).execute = async (...args: any[]) => {
      try { return await (execute as any).apply(tool, args); }
      catch (error) {
        // 委派中的模型/结构故障由成员恢复策略处理，不得误标为宿主授权拒绝。
        if (error instanceof DevelopmentToolError) failures.push(error);
        else if (name !== 'delegateTask') failures.push(new DevelopmentToolError(name === 'writeFile' ? 'authorization' : name === 'runChecks' ? 'verification' : 'read'));
        throw error;
      }
    };
  }
  const assigned = assignedMethods(role, state, methods);
  const reading = assigned.map(({ skill, reference }) => `调用skill加载${skill.name}，再用skill_read读取references/${reference}。`).join('');
  const documentation = state.input.architectureDocumentFormat && role === 'architect' ? methodPrompt('development.v2.agents.8', state.input.teamMethods) : '';
  const memoryModel = { id: resolveModelId(config, 'development'), apiKey: config.apiKey, ...(config.baseUrl ? { url: config.baseUrl } : {}) };
  const agent = new Agent({ ...(config.mode === 'live' ? { memory: createNativeMemory(memoryModel, storage, state.input.teamMethods) } : {}), id: runtime?.memberId ?? kind, name: runtime ? `${kind}：${runtime.memberId}` : kind, instructions: (state.input.teamMethods ? methodPrompt(({ context: 'development.v2.agents.1', architect: 'development.v2.agents.2', readiness: 'development.v2.agents.3', reviewer: 'development.v2.agents.4', frontend: 'development.agents.2', backend: 'development.agents.3', infrastructure: 'development.agents.4', 'self-check': 'development.agents.5' })[role], state.input.teamMethods) : instructions[role]) + (state.input.autonomy ? methodPrompt('development.v2.agents.5', state.input.teamMethods) : '') + (state.technicalRecovery ? methodPrompt('development.v2.agents.6', state.input.teamMethods) : '') + reading + documentation + (runtime?.delegate ? methodPrompt('development.v2.agents.7', state.input.teamMethods) : '') + methodPrompt('development.v2.agents.9', state.input.teamMethods), model: config.mode === 'fixture' ? fixtureModel(role, state, paths, assigned, runtime) : memoryModel, workspace: execution.workspace, tools, ...(assigned.length ? { skills: assigned.map(({ skill }) => skill) } : {}), maxRetries: 0, maxProcessorRetries: 0 });
  agent.__setLogger(noopLogger);
  invocationToolFailures.set(agent, failures);
  return agent;
}

/** 记录实际工具/用量并强制方法读取；结构失败走相同安全检查点。 */
export async function generateV2(config: PracticeConfig, execution: ExecutionPort, role: RoleV2, state: StateV2, paths: string[], extra: unknown, methods: DevelopmentMethods, runtime?: MemberRuntime, onProgress?: (event: LiveOutputEvent) => Promise<void>): Promise<EntryV2> {
  const invocationStarted = performance.now();
  const startedAt = new Date().toISOString();
  const storage = config.mode === 'live' ? new LibSQLStore({ id: 'development-context-memory', url: config.databaseUrl }) : undefined;
  try {
    if (state.input.teamMethods) await verifyTeamMethods(config.nacosResources, state.input.teamMethods);
    await execution.workspace.init();
    const agent = await createAgentV2(config, execution, role, state, paths, methods, runtime, storage);
    const taskContext = createTaskContext({ engineeringSpec: projectSpec(config, 'development'), repositoryHandoff: state.repositoryHandoff ?? state.input.repositoryHandoff, currentProductApproval: developmentProductApproval(state.input, state.phase), source: state.input.source, project: role === 'context' || state.input.project.executionProfile ? { ...state.input.project, files: Object.fromEntries(Object.entries(state.input.project.files).map(/** 上下文优先从候选工具读原文，避免文件在project与extra中重复装配。 */([path, content]) => [path, role === 'context' || path === 'pnpm-lock.yaml' ? { chars: content.length, hash: developmentHash(content), note: '可通过readFile读取原文' } : content])) } : state.input.project, requirements: state.requirements, hostReferencePolicy: '若工程参考快照包含engineering/repository-observation.json，它是宿主固定Git命令的只读观察；结合docs/decisions和docs/delivery-assets.md原文核对，不要求Agent获得任意Git或shell工具，不得声称候选已自动同步宿主变化。', referenceGroups: {
      requirements: state.requirements.map(
        /** 需求与验收只消费批准原文锚点。 */
        (item) => item.id,
      ),
      contextFiles: Object.keys(state.context?.files ?? {}).map(
        /** 上下文依据严格限于已读取文件，不能混用规则的来源引用。 */
        (path) => `file:${path}`,
      ),
      registeredChecks: state.verificationRefs,
    }, knownRefs: [...state.requirements.map(
      // 提供稳定原文锚点。
      (item) => item.id,
    ), ...Object.keys(state.context?.files ?? state.input.project.files).map(
      // 仅允许候选路径作为上下文依据。
      (path) => `file:${path}`,
    ), ...state.verificationRefs, ...(state.plan?.tasks.map(
      // 给评审提供当前任务集合。
      (task) => `task:${task.id}`,
    ) ?? [])], context: state.context, plan: state.plan, checks: state.checks, verificationHistory: state.verificationHistory, repairHistory: state.repairHistory, priorReports: state.codeReviews, round: state.round, taskPaths: paths, extra: role === 'context' ? { retryDiagnostic: (extra as { retryDiagnostic?: unknown } | null)?.retryDiagnostic, candidateFiles: Object.keys(state.input.project.files), note: '候选原文通过readFile读取；重复归档无需通读' } : extra }, config.mode === 'live', projectRepositoryRoot(config) ? { root: projectRepositoryRoot(config)!, receipt: state.repositoryHandoff ?? state.input.repositoryHandoff } : undefined, state.contextBudgetLevel ?? 0, state.input.teamMethods);
    const prompt = taskContext.prompt;
    const schema = role === 'context' ? contextOutputSchema(state) : role === 'architect' ? (state.input.architectureDocumentFormat ? planV2Schema : planV2Schema.omit({ document: true })) : role === 'readiness' || role === 'reviewer' ? assessmentOutputSchema(state) : null;
    const timeout = developmentTimeoutPolicy(role);
    const options = { ...taskContext.options, maxSteps: developmentMaxSteps, prepareStep: developmentPrepareStep(role), modelSettings: { maxOutputTokens: role === 'architect' && state.input.architectureDocumentFormat ? 10000 : 6000, maxRetries: 0, timeout: { totalMs: timeout.totalMs, stepMs: timeout.stepMs } } };
    /** SDK结构输出失败在边界转为固定诊断，禁止把原cause带入Workflow日志。 */
    async function call(abortSignal: AbortSignal) {
      try {
        if (config.mode === 'live' && onProgress) {
          const stream = schema
            ? await agent.stream(prompt, { ...options, abortSignal, structuredOutput: { schema: schema as z.ZodType<unknown>, errorStrategy: 'strict', logger: noopLogger } })
            : await agent.stream(prompt, { ...options, abortSignal });
          for await (const chunk of stream.fullStream) {
            const event = projectLiveOutputChunk(chunk, role, 1);
            if (event) await onProgress(event).catch(() => {});
          }
          return await stream.getFullOutput();
        }
        return config.mode === 'live' && schema
          ? await agent.generate(prompt, { ...options, abortSignal, structuredOutput: { schema: schema as z.ZodType<unknown>, errorStrategy: 'strict', logger: noopLogger } })
          : await agent.generate(prompt, { ...options, abortSignal });
      } catch (error) {
        const hostFailure = invocationToolFailures.get(agent)?.[0];
        if (hostFailure) throw hostFailure;
        if (classifyDevelopmentError(error) === 'invalid-output') throw new OutputValidationError({ stage: 'structured-output', code: 'structured-output-invalid' });
        throw error;
      }
    }
    const result = await runWithDevelopmentDeadline(timeout.totalMs, call);
    const hostFailure = invocationToolFailures.get(agent)?.[0];
    if (hostFailure) throw hostFailure;
    const failedTool = result.toolResults.find(item => item.payload.isError === true);
    if (failedTool) {
      const name = failedTool.payload.toolName;
      throw new DevelopmentToolError(name === 'writeFile' || name === 'delegateTask' ? 'authorization' : name === 'runChecks' ? 'verification' : 'read');
    }
    if (result.finishReason !== 'stop') throw new DevelopmentModelError(result.finishReason === 'error' ? classifyDevelopmentError(result.error) : 'model-error', diagnoseModelResult(result, developmentMaxSteps));
    const tools = result.toolResults.map(
      // 工具名来自实际原生结果，而非模型自报。
      (item) => item.payload.toolName,
    );
    if (paths.length && !runtime?.delegate && !tools.includes('mastra_workspace_read_file')) throw new OutputValidationError({ stage: 'method', code: 'method-read-missing' });
    for (const { skill, reference } of assignedMethods(role, state, methods)) {
      const prefix = JSON.stringify(skill.__referenceContents[reference].slice(0, 80)).slice(1, -1);
      const read = result.toolResults.find(
        // 比对实际注册原文内容，只有未知路径或工具名不算方法读取成功。
        (item) => item.payload.toolName === 'skill_read' && JSON.stringify(item.payload.result).includes(prefix),
      );
      if (!tools.includes('skill')) throw new OutputValidationError({ stage: 'method', code: 'method-load-missing' });
      if (!read) throw new OutputValidationError({ stage: 'method', code: 'method-read-missing' });
    }
    const endedAt = new Date().toISOString();
    const facts = projectToolFacts(result.toolResults);
    if (role === 'context') assertProjectInstructionsRead(state.input.project.instructionFiles ?? [], facts.files);
    return { role, round: state.round, text: result.object ? JSON.stringify(result.object) : result.text, tools, files: facts.files, startedAt, endedAt, durationMs: Math.max(0, Math.round(performance.now() - invocationStarted)), steps: result.steps.length, modelId: result.response?.modelId ?? null, inputTokens: result.usage?.inputTokens ?? null, outputTokens: result.usage?.outputTokens ?? null };
  } finally { await storage?.close(); }
}
/** 将宿主允许的引用绑定到本次结构化输出；方法资料和材料位置不进入事实引用域。 */
export function contextOutputSchema(state: StateV2) {
  const refs = [...state.requirements.map(/** 产品引用绑定批准原文行。 */item => item.id), ...Object.keys(state.input.project.files).map(/** 文件引用绑定候选路径。 */path => `file:${path}`)];
  return contextDraftSchema.extend({ rules: z.array(contextDraftSchema.shape.rules.element.extend({ refs: z.array(z.enum(refs)).min(1) })).min(1) });
}

/** 项目规则必须有真实读取回执；正文自述或只读部分层级都不能进入规划。 */
export function assertProjectInstructionsRead(instructionFiles: string[], readFiles: string[]) {
  if (instructionFiles.some(path => !readFiles.includes(path))) throw new OutputValidationError({ stage: 'method', code: 'project-instruction-read-missing' });
}

/** 结构输出声明引用域和覆盖数量；实际逐项覆盖仍由宿主独立校验。 */
export function assessmentOutputSchema(state: StateV2) {
  const refs = [...evidenceRefs(state)];
  const requiredCount = state.requirements.length + (state.plan?.tasks.length ?? 0);
  return assessmentSchema.extend({ coverageRefs: z.array(z.enum(refs)).min(Math.max(1, requiredCount)) });
}
export type GeneratorV2 = typeof generateV2;
