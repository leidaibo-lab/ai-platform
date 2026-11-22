import { methodPrompt } from '../mastra/team-methods.js';
import { z } from 'zod';
import { describeProductStep, productSteps } from '../mastra/workflows/product-steps.js';
import type { projectSpec } from '../business-engineering/project.js';
import { createTaskContext } from '../delivery/task-context.js';
/** 适配原生 dountil/suspend，不维护第二套状态机。
 * ADR: docs/decisions/2026-11-07-mastra-guided-intake.md
 */
import { createStep, createWorkflow, type Step } from '@mastra/core/workflows';
import { PUBSUB_SYMBOL } from '@mastra/core/workflows/_constants';
import { projectLiveOutputChunk, publishLiveOutput } from './live-output.js';
import type { createAgents } from '../mastra/agents/index.js';
import { deliverySchema, type Delivery } from '../mastra/workflows/delivery.js';
import { assessmentHistory, alignmentResumeSchema, intakeSchema, generatedPlanSchema, responseSchema, intakeHash, applyIntakeResponse, canFinalizePlan, classifyPublicationDependency, classifyWritingPrerequisite } from './contracts.js';
import { correctionPauseSchema, runInterruptibleProductAttempt } from './product-interruption.js';
import { productReworkFeedback } from '../mastra/workflows/product-rework.js';
import { maxProductReworks } from '../mastra/workflows/product-contract.js';
import { setTimeout as delay } from 'node:timers/promises';
import type { NacosSnapshot } from '../mastra/nacos-resources.js';
import type { PracticeConfig } from '../mastra/config.js';
import type { MastraCompositeStore } from '@mastra/core/storage';
import { createAgents as assembleAgents } from '../mastra/agents/index.js';
import { createStageWorkspace, hasWorkspaceRead, productWorkspaceSources, readAuthorizedProductSources, workspaceReadReceipts } from '../mastra/stage-workspace.js';
/** 旧入口未配置仓库时保持原生步骤。 */
function identity<T>(value: T): T { return value; }
type BindStep = <T extends Step<any, any, any, any, any, any>>(step: T) => T;
type ResolveAgents = (resources: NacosSnapshot) => Promise<ReturnType<typeof createAgents>>;
type ProductSpec = ReturnType<typeof projectSpec> | (() => ReturnType<typeof projectSpec>);
type WorkspaceOptions = { config?: PracticeConfig; storage?: MastraCompositeStore; repositoryRoot?: string | (() => string | undefined) };

/** 共享需求成熟度评估，供四步流程和历史澄清图使用。 */
function createAssessment(agents: ReturnType<typeof createAgents>, mode: Delivery['mode'], resolveAgents?: ResolveAgents, specSource?: ProductSpec, workspaceOptions?: WorkspaceOptions) {
  const productManager = agents.productManagerAgent;
  /** 根据最新回答判断是否还有关键业务缺口。 */
  return async function assess(inputData: Delivery, runId: string, abortSignal: AbortSignal, pubsub?: Parameters<typeof publishLiveOutput>[0], stepId: string = productSteps[0].id) {
    const engineeringSpec = typeof specSource === 'function' ? specSource() : specSource;
    const intake = inputData.intake;
    if (!intake?.enabled || intake.ready) return { delivery: inputData };
    if (inputData.mode !== mode) throw new Error('模型模式变化');
    const fixture = { summary: '固定样例方案：先明确业务范围，再形成产品稿。本模式不理解实际需求。', assumptions: ['固定样例仅验证交互流程'], maturity: Object.fromEntries(['decisions', 'mainFlow', 'exceptions', 'delivery'].map(/** 合成判定仅验证控制流。 */key => [key, { clear: intake.history.length > 0, evidence: '固定样例，不代表真实业务已澄清' }])), questions: intake.history.length ? [] : [{ id: 'scope', title: '请确认首期业务范围', reason: '范围决定验收和后续开发', required: true, decision: { blocks: 'product', reason: '首期范围决定产品验收边界', unanswered: '范围未确认前不生成完整产品稿' }, kind: 'single', options: [{ id: 'minimal', label: '先做最小可用范围' }, { id: 'full', label: '完整范围' }], recommendation: '建议先验证最小可用范围，降低返工' }] };
    if (inputData.nacosResources && !resolveAgents) throw new Error('缺少冻结资源 Agent 装配器');
    const resolvedManager = inputData.nacosResources ? (await resolveAgents!(inputData.nacosResources)).productManagerAgent : productManager;
    const { config, storage, repositoryRoot } = workspaceOptions ?? {};
    const root = typeof repositoryRoot === 'function' ? repositoryRoot() : repositoryRoot;
    const legacySources = !inputData.productSources && config && !config.engineeringProject && !config.engineeringProjects ? readAuthorizedProductSources(root) : {};
    const sources = { ...legacySources, ...productWorkspaceSources(inputData, root ? { root, receipt: inputData.repositoryHandoff } : undefined) };
    if (engineeringSpec && Object.hasOwn(sources, engineeringSpec.path)) throw new Error('需求澄清 Workspace 材料路径冲突');
    const files = { ...sources, 'brief.md': inputData.brief, ...(engineeringSpec ? { [engineeringSpec.path]: engineeringSpec.content } : {}) };
    const stage = config ? await createStageWorkspace(`intake-${runId}`, '需求澄清 · 当前材料（只读）', files) : undefined;
    try {
    const manager = stage && config ? assembleAgents(config, { resources: inputData.nacosResources, storage, workspace: stage.workspace, workspaceTools: stage.tools }).productManagerAgent : resolvedManager;
    const taskContext = createTaskContext({ task: 'guided-requirements', engineeringSpec: stage && engineeringSpec ? { projectId: engineeringSpec.projectId, revision: engineeringSpec.revision, path: engineeringSpec.path } : engineeringSpec, ...(stage ? { workspaceFile: 'brief.md', workspaceSources: Object.keys(sources) } : { brief: inputData.brief }), successorBaseline: inputData.successorBaseline, history: assessmentHistory(intake), corrections: productReworkFeedback(inputData), instruction: (stage ? '先调用 mastra_workspace_read_file 读取 brief.md。' : '') + methodPrompt('product.question-decision', inputData.nacosResources?.methods) + methodPrompt('intake.workflow.1', inputData.nacosResources?.methods) }, mode === 'live', undefined, 0, inputData.nacosResources?.methods);
    let receipts: ReturnType<typeof workspaceReadReceipts> = [];
    const attempt = await runInterruptibleProductAttempt(runId, abortSignal, (inputData.productRework?.round ?? 0) < maxProductReworks, async signal => {
      if (mode === 'fixture') {
        if (stage) {
          const result = await manager.generate(taskContext.prompt, { ...taskContext.options, abortSignal: signal, maxSteps: 24 });
          if (!hasWorkspaceRead(result.toolResults, 'brief.md')) throw new Error('需求澄清 Agent 未读取当前 Workspace 需求');
          receipts = workspaceReadReceipts(result.toolResults, files);
        }
        return fixture;
      }
      const deadline = performance.now() + 1800000;
      for (let attemptNumber = 1; attemptNumber <= 2; attemptNumber++) {
        signal.throwIfAborted();
        try {
          const remaining = Math.max(1, Math.floor(deadline - performance.now()));
          const stream = await manager.stream(taskContext.prompt, { ...taskContext.options, abortSignal: signal, maxSteps: 24, modelSettings: { maxRetries: 0, timeout: { totalMs: remaining, stepMs: Math.min(remaining, 600000) } }, structuredOutput: { schema: generatedPlanSchema } });
          for await (const chunk of stream.fullStream) {
            const event = projectLiveOutputChunk(chunk, 'analysis', attemptNumber);
            if (event?.type === 'tool') await publishLiveOutput(pubsub, runId, event, stepId).catch(() => {});
          }
          const result = await stream.getFullOutput();
          if (result.error) throw result.error;
          if (stage && !hasWorkspaceRead(result.toolResults, 'brief.md')) throw new Error('需求澄清 Agent 未读取当前 Workspace 需求');
          receipts = workspaceReadReceipts(result.toolResults, files);
          return result.object;
        } catch (error) {
          if (attemptNumber === 2 || signal.aborted || deadline - performance.now() <= 1000 || !(error instanceof SyntaxError || error instanceof z.ZodError || (error instanceof Error && /NoObjectGenerated|output.*valid|schema|parse/i.test(error.name + ' ' + error.message)))) throw error;
          await delay(1000, undefined, { signal });
        }
      }
      throw new Error('需求结构化输出未完成');
    });
    if (attempt.correction) return { correction: attempt.correction };
    const plan = classifyWritingPrerequisite(classifyPublicationDependency(generatedPlanSchema.parse(attempt.output), intake.history));
    const lastResponse = intake.history.at(-1)?.response;
    // 只消费刚提交的推进请求。返工会清空当前方案版本，旧请求不能放行新方向。
    const ready = inputData.productFlow !== undefined && lastResponse?.action === 'finalize'
      && lastResponse.hash === intake.hash && canFinalizePlan(plan);
    const next = { ...intake, ready, round: intake.round + 1, plan, ...(stage ? { workspaceReads: receipts } : {}) };
    return { delivery: { ...inputData, intake: { ...next, hash: intakeHash(inputData.brief, next) } } };
    } finally { await stage?.close(); }
  };
}

/** 对齐方向的两个入口共享一个原生步骤。 */
export function createProductAlignmentStep(agents: ReturnType<typeof createAgents>, mode: Delivery['mode'], bind: BindStep, resolveAgents: ResolveAgents | undefined, engineeringSpec: ProductSpec | undefined, autofill: Step<string, any, Delivery, Delivery, any, any>['execute'], workspaceOptions?: WorkspaceOptions) {
  const assess = createAssessment(agents, mode, resolveAgents, engineeringSpec, workspaceOptions);
  return bind(createStep({
    id: productSteps[0].id, description: describeProductStep(productSteps[0]),
    inputSchema: deliverySchema, outputSchema: deliverySchema,
    suspendSchema: z.union([intakeSchema, correctionPauseSchema]), resumeSchema: alignmentResumeSchema,
    /** 在同一原生步骤保存每轮暂停点，恢复后消费回答并评估下一轮。 */
    execute: async context => {
      const { inputData, resumeData, suspendData, suspend, runId, abortSignal } = context;
      if (inputData.mode !== mode) throw new Error('模型模式变化');
      if (!inputData.intake?.enabled) return autofill(context);
      let delivery = inputData;
      if (resumeData) {
        const intake = intakeSchema.parse(suspendData);
        if (resumeData.intake.hash !== intake.hash || intakeHash(inputData.brief, resumeData.intake) !== intakeHash(inputData.brief, intake)) {
          throw new Error('需求确认暂停版本已变化');
        }
        delivery = { ...inputData, intake: applyIntakeResponse(intake, resumeData.response) };
      }
      const result = await assess(delivery, runId, abortSignal, context[PUBSUB_SYMBOL]);
      if (result.correction) return suspend({ ...result.correction, intake: delivery.intake });
      const intake = result.delivery.intake!;
      return intake.ready ? result.delivery : suspend(intake);
    },
  }));
}

/** 按原路径装配历史 Run 的多轮澄清流程。 */
export function createIntakeWorkflow(agents: ReturnType<typeof createAgents>, mode: Delivery['mode'], bind: BindStep = identity, resolveAgents?: ResolveAgents, engineeringSpec?: ProductSpec, workspaceOptions?: WorkspaceOptions) {
  const assess = createAssessment(agents, mode, resolveAgents, engineeringSpec, workspaceOptions);
  const analyze = createStep({ id: 'analyze-requirements', description: '需求澄清｜product-manager-agent', inputSchema: deliverySchema, outputSchema: deliverySchema, suspendSchema: correctionPauseSchema,
    // 建议不转成事实；模型无效输出明确失败，fixture 明确标识。
    execute: async ({ inputData, runId, abortSignal, suspend, [PUBSUB_SYMBOL]: pubsub }) => {
      const result = await assess(inputData, runId, abortSignal, pubsub, 'analyze-requirements');
      return result.correction ? suspend(result.correction) : result.delivery;
    },
  });
  const confirm = createStep({ id: 'confirm-requirements', description: '需求澄清人工确认｜产品团队', inputSchema: deliverySchema, outputSchema: deliverySchema, suspendSchema: intakeSchema, resumeSchema: responseSchema,
    // 新回答与补充先重新分析；仅对无关键缺口的最新评估显式确认才进入写作。
    execute: async ({ inputData, resumeData, suspend }) => {
      const intake = inputData.intake;
      if (!intake?.enabled || intake.ready) return inputData;
      if (inputData.mode !== mode) throw new Error('模型模式变化');
      if (!resumeData) return suspend(intake);
      return { ...inputData, intake: applyIntakeResponse(intake, resumeData) };
    },
  });
  const iteration = createWorkflow({ id: 'requirements-round', inputSchema: deliverySchema, outputSchema: deliverySchema }).then(bind(analyze)).then(bind(confirm)).commit();
  return createWorkflow({ id: 'guided-requirements', inputSchema: deliverySchema, outputSchema: deliverySchema }).dountil(iteration,
    // 关闭的旧调用与显式生成完整稿才退出澄清环节。
    async ({ inputData }) => !inputData.intake?.enabled || inputData.intake.ready,
  ).commit();
}
