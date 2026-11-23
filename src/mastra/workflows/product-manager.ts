import { methodPrompt } from '../team-methods.js';
import { runProductQualityLoop } from '../../team/product-quality-loop.js';
import { assertProductRepairContinuation, type ProductRepairCheckpoint } from '../../team/product-repair.js';
import { productWritingPolicy, type TeamRunPolicy } from '../../team/run-policy.js';
import { externalSourceReceipts } from '../../intake/external-evidence.js';
import { acceptanceRequirementsInstruction, ProductDraftPresentationError, productDocumentsInstruction, readProductDocuments, validateProductDraftPresentation } from '../../business-engineering/product-documents.js';
import type { projectSpec } from '../../business-engineering/project.js';
import { readAcceptanceRequirements } from '../../business-engineering/acceptance-requirements.js';
import { createHash } from 'node:crypto';
import { createStep, createWorkflow, type Step } from '@mastra/core/workflows';
import { PUBSUB_SYMBOL } from '@mastra/core/workflows/_constants';
import { z } from 'zod';
import type { createAgents } from '../agents/index.js';
import type { Delivery } from './delivery.js';
import { deliverySchema } from './delivery.js';
import { maxProductReworks, productQualityReviewSchema, productManagerStages } from './product-contract.js';
import { createIntakeWorkflow, createProductAlignmentStep } from '../../intake/workflow.js';
import { collectConfirmedDecisions } from '../../intake/contracts.js';
import { generateProductContent } from '../../intake/product-generation.js';
import { projectToolFacts } from '../../intake/run-timeline.js';
import { createStageWorkspace, hasWorkspaceRead, productWorkspaceSources, readAuthorizedProductSources, workspaceReadReceipts } from '../stage-workspace.js';
import { createAgents as assembleAgents } from '../agents/index.js';
import type { PracticeConfig } from '../config.js';
import type { MastraCompositeStore } from '@mastra/core/storage';
import { nacosResourceIdentity, type NacosSnapshot } from '../nacos-resources.js';
import { correctionPauseSchema, runInterruptibleProductAttempt } from '../../intake/product-interruption.js';
import { productReworkFeedback } from './product-rework.js';
import { publishLiveOutput } from '../../intake/live-output.js';
import { describeProductStep, productSteps } from './product-steps.js';
import { decideProductLoop } from '../../team/product-loop.js';
import { decideTeamLoop } from '../../team/loop.js';

type StepBinder = <T extends Step<any, any, any, any, any, any>>(step: T) => T;

/** 产品经理 Workflow 的阶段职责；所有阶段使用同一个 product-manager-agent，避免重复交接上下文。 */
const managerPhaseInstructions: Record<typeof productManagerStages[number], string> = {
  analysis: '需求分析：提取目标、用户、场景、约束、范围和待决事项。',
  clarification: '需求澄清整理：吸收已确认回答，保留事实、歧义和不能自行决定的业务选择。',
  'scope-priority': '范围与优先级：明确首期范围、非目标、优先级和可检查验收边界，不代替独立质量审查。',
  writing: '产品稿写作：汇总前序事实、确认结论和范围，生成完整可审阅产品稿。',
};

/** 按候选散列和固定诊断记录修订进展；预算限制模型调用而非替代审批。 */
export async function repairProductPresentation<T extends { text: string }>(generate: (repair?: { candidate: string; finding: string }) => Promise<T>, enabled: boolean, policy?: TeamRunPolicy, checkpoint?: ProductRepairCheckpoint) {
  const strategy = productWritingPolicy(policy);
  const limit = strategy.maxRepairs;
  if (checkpoint && checkpoint.policyVersion !== strategy.version) throw new Error('产品修订策略与检查点版本不一致');
  if (checkpoint) assertProductRepairContinuation(checkpoint);
  let repair = checkpoint?.history.length ? { candidate: checkpoint.candidate, finding: checkpoint.history.at(-1)!.finding } : undefined;
  const history: ProductRepairCheckpoint['history'] = [...(checkpoint?.history ?? [])];
  const seen = new Set(history.map(item => `${item.candidateHash}:${item.finding}`));
  for (;;) {
    let result: T;
    try { result = await generate(repair); }
    catch (error) {
      if (error instanceof Error && history.length && repair) Object.assign(error, { productRepairCheckpoint: { version: 'product-repair-checkpoint.v1', policyVersion: strategy.version, candidate: repair.candidate, history }, productRepairHistory: history });
      throw error;
    }
    if (!enabled) return { result, repairs: 0, history };
    const candidateHash = createHash('sha256').update(result.text).digest('hex');
    try {
      validateProductDraftPresentation(result.text); readProductDocuments(result.text);
      history.push({ candidateHash, finding: '', outcome: 'passed' });
      return { result, repairs: history.length - 1, history };
    } catch (error) {
      if (!productDraftValidationMessage(error)) throw error;
      const key = `${candidateHash}:${error.message}`;
      const exhausted = history.length >= limit;
      const repeated = strategy.stopOnRepeatedCandidate && seen.has(key);
      const action = decideTeamLoop({ version: 'team-run-envelope.v1', teamId: 'product', status: exhausted || repeated ? 'stopped' : 'rework', phase: 'product-writing', inputVersion: candidateHash, budget: { used: Math.min(history.length, limit), limit }, evidence: [error.message], ...(exhausted || repeated ? { stopReason: repeated ? 'no-progress' : 'repair-budget' } : {}) });
      const outcome = action === 'request-rework' ? 'rework' : repeated ? 'no-progress' : 'budget-exhausted';
      history.push({ candidateHash, finding: error.message, outcome });
      if (outcome !== 'rework') {
        Object.assign(error, { productRepairHistory: history, productRepairPolicy: strategy.version, productRepairCheckpoint: { version: 'product-repair-checkpoint.v1', policyVersion: strategy.version, candidate: result.text, history } });
        throw error;
      }
      seen.add(key);
      repair = { candidate: result.text, finding: error.message };
    }
  }
}

/** 仅允许本平台固定的文档校验诊断进入模型反馈，不传播任意异常正文。 */
function productDraftValidationMessage(error: unknown): error is Error {
  if (error instanceof ProductDraftPresentationError) return true;
  if (!(error instanceof Error)) return false;
  return /^(?:产品稿须包含 1 至 100 项带 REQ-ID 和验收预期的需求|第 \d+ 行的可验收需求格式无效|可验收需求 ID 重复：REQ-[A-Z0-9-]+|待审稿须依次包含「# 需求文档」和「# 产品规格」两份正文|需求条目必须声明在需求文档中|产品任务格式无效或 ID 重复|产品任务 TASK-[A-Z0-9-]+ 的需求引用未知或重复|产品任务须覆盖需求文档中的全部需求 ID)$/.test(error.message);
}

/** 装配产品方向和规格阶段，历史图复用相同的业务执行逻辑。 */
export function createProductManagerPhases(
  agents: ReturnType<typeof createAgents>,
  mode: Delivery['mode'],
  bind: StepBinder = (step) => step,
  repositoryRoot?: string | (() => string | undefined),
  resolveAgents?: (resources: NacosSnapshot) => Promise<ReturnType<typeof createAgents>>,
  engineeringSpec?: ReturnType<typeof projectSpec> | (() => ReturnType<typeof projectSpec>),
  graph: 'flat' | 'native' | 'nested' | 'legacy' = 'flat',
  config?: PracticeConfig,
  storage?: MastraCompositeStore,
) {
  const legacy = graph === 'legacy';
  const inlinePublish = graph === 'flat' || graph === 'native';
  const manager = agents.productManagerAgent;
  const reviewer = agents.productReviewerAgent;
  /** 每次调用从步骤绑定读取工程资料，避免装配闭包捕获其他项目。 */
  function currentRoot() { return typeof repositoryRoot === 'function' ? repositoryRoot() : repositoryRoot; }
  /** SDD 正文仅由当前 Run 固定版本产生。 */
  function currentSpec() { return typeof engineeringSpec === 'function' ? engineeringSpec() : engineeringSpec; }

  /** 产品经理按固定阶段产出中间事实；阶段名用于审计，Agent 身份统一为 product-manager-agent。 */
  function managerPhase(role: typeof productManagerStages[number]) {
    return createStep({
      id: `product-${role}`,
      description: graph === 'flat' && role === 'writing' ? describeProductStep(productSteps[1]) : `product-manager-agent｜${managerPhaseInstructions[role]}`,
      inputSchema: deliverySchema,
      outputSchema: deliverySchema,
      suspendSchema: correctionPauseSchema,
      execute: async ({ inputData, runId, abortSignal, suspend, mastra, tracingContext, [PUBSUB_SYMBOL]: pubsub }) => {
        if (inputData.mode !== mode) throw new Error('模型模式变化，不能跨模式生成产品稿');
        if (inputData.revision) return inlinePublish && role === 'writing' ? publishDraft(inputData) : inputData;
        if (!legacy && role === 'analysis' && inputData.intake?.enabled && inputData.intake.ready) return inputData;
        const phaseInstruction = !legacy && role === 'analysis'
          ? '对齐方向：用简短结构梳理目标、用户与场景、本期范围、非目标和关键假设。明确区分用户已给出的事实与 AI 建议，不擅自选择需要人决定的业务规则。'
          : managerPhaseInstructions[role];
        if (inputData.intake?.enabled && !inputData.intake.ready) throw new Error('需求尚未确认');
        const intakeMode = inputData.intake?.intakeMode ?? (inputData.intake?.enabled ? 'clarify' : 'autofill');
        const modeInstruction = intakeMode === 'autofill'
          ? '本次是“AI 主动补全”模式。不要把缺少用户回答当作继续提问的理由；请基于需求目标、常见产品实践和当前上下文主动选择一条最推荐的闭环方案。所有推断、默认值和推荐必须在产品稿中明确标注为“AI 建议”或“待确认”，不能伪装成用户已确认事实；完整产品稿必须包含目标、主流程、异常边界、非目标、指标和验收标准，供产品负责人一次性审阅。'
          : '本次是“逐项澄清”模式。只使用用户已经明确确认的业务规则；不能把推荐或假设升级为事实，关键缺口应保留为待确认项。';
        if (inputData.nacosResources && !resolveAgents) throw new Error('缺少冻结资源 Agent 装配器');
        if (inputData.nacosResources) await resolveAgents!(inputData.nacosResources);
        const spec = currentSpec();
        const sources = { ...(!inputData.productSources && config && !config.engineeringProject && !config.engineeringProjects ? readAuthorizedProductSources(currentRoot()) : {}), ...productWorkspaceSources(inputData, currentRoot() ? { root: currentRoot()!, receipt: inputData.repositoryHandoff } : undefined) };
        const files = { ...sources, ...(spec ? { [spec.path]: spec.content } : {}), 'brief.md': inputData.brief };
        const stage = config ? await createStageWorkspace(`product-${runId}`, '产品团队 · 当前材料（只读）', files) : undefined;
        const activeManager = stage && config ? assembleAgents(config, { ...(inputData.nacosResources ? { resources: inputData.nacosResources } : {}), storage, mastra, workspace: stage.workspace, workspaceTools: stage.tools }).productManagerAgent : manager;
        try {
        const prompt = {
          task: 'product-manager-phase',
          phase: role,
          engineeringSpec: spec ? { projectId: spec.projectId, revision: spec.revision, path: spec.path } : undefined,
          workspaceFile: stage ? (spec?.path ?? 'brief.md') : undefined,
          workspaceSources: Object.keys(sources),
          phaseInstruction,
          brief: inputData.brief,
          confirmedIntake: inputData.intake,
          confirmedDecisions: inputData.intake ? collectConfirmedDecisions(inputData.intake) : [],
          successorBaseline: inputData.successorBaseline ? { sourceRunId: inputData.successorBaseline.sourceRunId, changeBrief: inputData.successorBaseline.changeBrief, artifacts: inputData.successorBaseline.artifacts.map(item => ({ kind: item.kind, path: item.path, commit: item.commit, content: item.content })) } : undefined,
          previousWork: inputData.productWork?.entries ?? [],
          rework: inputData.productRework,
          priorFeedback: inputData.productReworkHistory?.map(({ round, feedback }) => ({ round, feedback })),
          instruction: `你是同一个产品经理 Agent 的当前阶段。${stage ? `先调用 mastra_workspace_read_file 读取 ${spec?.path ?? 'brief.md'}。` : ''}只完成当前阶段职责，保留事实、已确认规则、建议和待决项的区别；不得跳过人工产品审批，不得声称已完成后续研发、测试或部署。${modeInstruction}${role === 'writing' ? (inputData.productHandoffFormat ? productDocumentsInstruction : inputData.requirementTracking ? acceptanceRequirementsInstruction : '') : ''}`,
        };
        let presentationRepairs = 0;
        let presentationRepairHistory: Awaited<ReturnType<typeof repairProductPresentation>>['history'] = [];
        const attempt = await runInterruptibleProductAttempt(runId, abortSignal, (inputData.productRework?.round ?? 0) < maxProductReworks, async signal => {
          const repaired = await repairProductPresentation(repair => generateProductContent(activeManager, JSON.stringify({ ...prompt, ...(repair ? { presentationRepair: repair, instruction: `${prompt.instruction} 请根据校验发现修订完整候选，保留已确认业务规则及需求与任务引用；仅输出完整正式双文档，禁止输出制作过程。` } : {}) }), role, mode, currentRoot() ? { root: currentRoot()!, receipt: inputData.repositoryHandoff } : undefined, inputData.contextBudgetLevel, event => publishLiveOutput(pubsub, runId, event, `product-${role}`), signal, undefined, tracingContext, config?.externalResearchKey), role === 'writing' && !!inputData.productHandoffFormat && mode === 'live', inputData.teamRunPolicy, inputData.productRepairCheckpoint);
          presentationRepairs = repaired.repairs;
          presentationRepairHistory = repaired.history;
          return repaired.result;
        });
        if (attempt.correction) return suspend(attempt.correction);
        const result = attempt.output;
        const content = z.string().trim().min(1).max(100000).parse(result.text);
        if (!inlinePublish && role === 'writing') {
          if (inputData.productHandoffFormat) { validateProductDraftPresentation(content); readProductDocuments(content); }
          else if (inputData.requirementTracking) readAcceptanceRequirements(content);
        }
        const facts = projectToolFacts(result.toolResults);
        const externalSources = externalSourceReceipts(result.toolResults);
        if (stage && !hasWorkspaceRead(result.toolResults, spec?.path ?? 'brief.md')) throw new Error('产品 Agent 未读取当前 Workspace 材料');
        const entry = {
          role,
          agent: 'product-manager-agent',
          content,
          toolNames: facts.tools,
          files: facts.files,
          ...(externalSources.length ? { externalSources } : {}),
          startedAt: result.generation?.startedAt,
          endedAt: result.generation?.endedAt,
          durationMs: result.generation?.durationMs,
          modelSteps: result.steps.length,
          generation: result.generation,
          ...(presentationRepairs ? { presentationRepairs, presentationRepairHistory } : {}),
          ...(stage ? { workspaceReads: workspaceReadReceipts(result.toolResults, files) } : {}),
        };
        const resultState = { ...inputData, productWork: { version: 'product-graph.v1' as const, entries: [...(inputData.productWork?.entries ?? []), entry] } };
        return inlinePublish && role === 'writing' ? publishDraft(resultState) : resultState;
        } finally { await stage?.close(); }
      },
    });
  }

  /** 将写作结果固化为待审版本。 */
  function publishDraft(inputData: Delivery): Delivery {
    const content = inputData.revision?.content ?? inputData.productWork?.entries.at(-1)?.content;
    if (!content) throw new Error('产品写作未产生可审阅正文');
    if (inputData.productHandoffFormat) { validateProductDraftPresentation(content); readProductDocuments(content); }
    else if (inputData.requirementTracking) readAcceptanceRequirements(content);
    const hash = createHash('sha256').update(JSON.stringify({ stage: 'product', intake: inputData.intake, brief: inputData.brief, upstream: inputData.artifacts, content, revision: inputData.revision, productRework: inputData.productRework, productWork: inputData.productWork, ...(inputData.nacosResources ? { resources: nacosResourceIdentity(inputData.nacosResources) } : {}) })).digest('hex');
    return { ...inputData, artifacts: [...inputData.artifacts, { stage: 'product' as const, content, hash, evidence: mode === 'fixture' ? 'fixture' as const : 'model-proposal' as const }] };
  }

  /** 独立产品审查只产生质量证据，不修改产品稿，也不替代人工审批。 */
  const qualityReview = createStep({
    id: 'review-product-quality',
    description: describeProductStep(productSteps[2]),
    inputSchema: deliverySchema,
    outputSchema: deliverySchema,
    suspendSchema: correctionPauseSchema,
    execute: async ({ inputData, runId, abortSignal, suspend, mastra, tracingContext, [PUBSUB_SYMBOL]: pubsub }) => {
      const artifact = inputData.artifacts.at(-1);
      if (!artifact || artifact.stage !== 'product') throw new Error('产品审查缺少待审产品稿');
      if (inputData.nacosResources && !resolveAgents) throw new Error('缺少冻结资源 Agent 装配器');
      if (inputData.nacosResources) await resolveAgents!(inputData.nacosResources);
      const spec = currentSpec();
      const sources = { ...(!inputData.productSources && config && !config.engineeringProject && !config.engineeringProjects ? readAuthorizedProductSources(currentRoot()) : {}), ...productWorkspaceSources(inputData, currentRoot() ? { root: currentRoot()!, receipt: inputData.repositoryHandoff } : undefined) };
      const documents = inputData.productHandoffFormat ? readProductDocuments(artifact.content) : undefined;
      const files = { ...sources, ...(spec ? { [spec.path]: spec.content } : {}), 'product.md': artifact.content, ...(documents ? { 'requirements.md': documents.requirements, 'product-spec.md': documents.specification } : {}) };
      const stage = config ? await createStageWorkspace(`product-review-${runId}`, '产品审查 · 当前材料（只读）', files) : undefined;
      const activeReviewer = stage && config ? assembleAgents(config, { ...(inputData.nacosResources ? { resources: inputData.nacosResources } : {}), storage, mastra, workspace: stage.workspace, workspaceTools: stage.tools }).productReviewerAgent : reviewer;
      try {
      const structuredQuality = !!inputData.teamRunPolicy?.product.quality && !!inputData.productHandoffFormat && mode === 'live';
      const attempt = structuredQuality ? undefined : await runInterruptibleProductAttempt(runId, abortSignal, (inputData.productRework?.round ?? 0) < maxProductReworks, signal => generateProductContent(activeReviewer, JSON.stringify({
        task: 'product-quality-review',
        engineeringSpec: spec ? { projectId: spec.projectId, revision: spec.revision, path: spec.path } : undefined,
        workspaceFile: stage ? 'product.md' : undefined,
        workspaceSources: Object.keys(sources),
        brief: inputData.brief,
        product: artifact.content,
        ...(documents ? { documentStructureEvidence: '完整双文档已通过确定性校验：每项 REQ 均有 TASK 引用。该证据仅说明格式和引用覆盖，不证明业务语义完整。', documentFiles: ['requirements.md', 'product-spec.md'] } : {}),
        corrections: productReworkFeedback(inputData),
        instruction: `${stage ? '先调用 mastra_workspace_read_file 读取 product.md。' : ''}${documents && stage ? '分别读取 requirements.md 和 product-spec.md 的完整正文，核对上述确定性映射证据；不能把局部读取或未找到当作全文缺失。' : ''}独立检查目标、范围、业务规则、正常/边界/异常流程、验收条件、非目标和风险。检查需求文档中的场景是否忠实覆盖确认的业务规则，产品规格中的交付任务是否与需求对应。只输出审查发现与依据，不修改产品稿，不代替人工审批。`,
      }), 'reviewer', mode, currentRoot() ? { root: currentRoot()!, receipt: inputData.repositoryHandoff } : undefined, inputData.contextBudgetLevel, event => publishLiveOutput(pubsub, runId, event, 'review-product-quality'), signal, undefined, tracingContext, config?.externalResearchKey));
      if (attempt?.correction) return suspend(attempt.correction);
      if (inputData.teamRunPolicy?.product.quality && inputData.productHandoffFormat && mode === 'live') {
        const strategy = inputData.teamRunPolicy.product.quality;
        const qualityTools = new Set<string>();
        const qualityReads: { path: string; sourceHash: string }[] = [];
        /** 每次审查及核验都装配当前版本工作区，避免读取初稿旧文件。 */
        const generateQuality = async (content: string, task: string, payload: Record<string, unknown>, instruction: string) => {
          const current = await createStageWorkspace(`product-quality-${runId}`, '产品审查与核验（只读）', { 'product.md': content, 'brief.md': inputData.brief });
          try {
            const agent = config ? assembleAgents(config, { ...(inputData.nacosResources ? { resources: inputData.nacosResources } : {}), storage, mastra, workspace: current.workspace, workspaceTools: current.tools }).productReviewerAgent : reviewer;
            const generated = await generateProductContent(agent, JSON.stringify({ task, workspaceFile: 'product.md', ...payload, confirmedDecisions: inputData.intake ? collectConfirmedDecisions(inputData.intake) : [], instruction: `读取 product.md 的当前正文。${instruction}` }), 'reviewer', mode, undefined, 0, undefined, abortSignal, inputData.nacosResources?.methods, tracingContext, config?.externalResearchKey);
            if (!hasWorkspaceRead(generated.toolResults, 'product.md')) throw new Error('产品审查未读取当前版本');
            for (const tool of projectToolFacts(generated.toolResults).tools) qualityTools.add(tool);
            qualityReads.push(...workspaceReadReceipts(generated.toolResults, { 'product.md': content }));
            return JSON.parse(generated.text);
          } finally { await current.close(); }
        };
        const loop = await runProductQualityLoop({ content: artifact.content, hash: artifact.hash, maxRepairs: strategy.maxRepairs, checkpoint: inputData.productQualityCheckpoint }, {
          review: (content, hash) => generateQuality(content, 'product-structured-quality-review', { productHash: hash, structureEvidence: '当前候选已通过需求条目、任务引用和全需求覆盖的确定性校验。仍需核对语义。' }, methodPrompt('product.quality-review', inputData.nacosResources?.methods)),
          verify: (content, assessment) => generateQuality(content, 'product-finding-verification', { assessment }, methodPrompt('product.quality-verify', inputData.nacosResources?.methods)),
          repair: async (content, assessment, verification) => {
            const current = await createStageWorkspace(`product-repair-${runId}`, '产品修订（只读材料）', { 'product.md': content, 'brief.md': inputData.brief });
            try {
              const agent = config ? assembleAgents(config, { ...(inputData.nacosResources ? { resources: inputData.nacosResources } : {}), storage, mastra, workspace: current.workspace, workspaceTools: current.tools }).productManagerAgent : manager;
              const generated = await generateProductContent(agent, JSON.stringify({ task: 'product-quality-repair', workspaceFile: 'product.md', product: content, assessment, verification, confirmedDecisions: inputData.intake ? collectConfirmedDecisions(inputData.intake) : [], instruction: `${methodPrompt('product.quality-repair', inputData.nacosResources?.methods)}${productDocumentsInstruction}` }), 'writing', mode, undefined, 0, undefined, abortSignal, inputData.nacosResources?.methods, tracingContext, config?.externalResearchKey);
              if (!hasWorkspaceRead(generated.toolResults, 'product.md')) throw new Error('产品修订未读取当前版本');
              for (const tool of projectToolFacts(generated.toolResults).tools) qualityTools.add(tool);
              qualityReads.push(...workspaceReadReceipts(generated.toolResults, { 'product.md': content }));
              return generated.text;
            } finally { await current.close(); }
          },
        });
        const revised = { ...artifact, content: loop.content, hash: loop.productHash };
        const quality = productQualityReviewSchema.parse({ version: 'product-quality-review.v1', agent: 'product-reviewer-agent', productHash: loop.productHash, content: loop.rounds.at(-1)!.assessment.summary, hash: createHash('sha256').update(JSON.stringify(loop)).digest('hex'), toolNames: [...qualityTools], workspaceReads: qualityReads, loop: { status: loop.status, rounds: loop.rounds, repairs: loop.repairs } });
        return { ...inputData, artifacts: [...inputData.artifacts.slice(0, -1), revised], productQualityReview: quality };
      }
      if (!attempt?.output) throw new Error('产品审查缺少执行结果');
      const result = attempt.output;
      const facts = projectToolFacts(result.toolResults);
      const externalSources = externalSourceReceipts(result.toolResults);
      if (stage && !hasWorkspaceRead(result.toolResults, 'product.md')) throw new Error('产品审查未读取当前 Workspace 产品稿');
      const review = productQualityReviewSchema.parse({
        version: 'product-quality-review.v1',
        agent: 'product-reviewer-agent',
        content: result.text,
        hash: createHash('sha256').update(JSON.stringify({ productHash: artifact.hash, content: result.text })).digest('hex'),
        toolNames: facts.tools,
        files: facts.files,
        ...(externalSources.length ? { externalSources } : {}),
        generation: result.generation,
        ...(stage ? { workspaceReads: workspaceReadReceipts(result.toolResults, files) } : {}),
      });
      if (decideProductLoop('quality-review', artifact.hash, 'running', [review.hash]) !== 'continue') throw new Error('产品独立审查无法继续');
      return { ...inputData, productQualityReview: review };
      } finally { await stage?.close(); }
    },
  });

  const writing = bind(managerPhase('writing'));
  if (graph === 'flat') {
    const align = createProductAlignmentStep(agents, mode, bind, resolveAgents, engineeringSpec, managerPhase('analysis').execute, { config, storage, repositoryRoot });
    return { graph, align, writing, qualityReview: bind(qualityReview) } as const;
  }
  const intake = createIntakeWorkflow(agents, mode, bind, resolveAgents, engineeringSpec, { config, storage, repositoryRoot });
  const analysis = bind(managerPhase('analysis'));
  if (graph === 'native') {
    const direction = createWorkflow({ id: 'product-direction', description: '对齐方向', inputSchema: deliverySchema, outputSchema: deliverySchema })
      .then(intake).then(analysis).commit();
    const specification = createWorkflow({ id: 'product-specification', description: '完善规格', inputSchema: deliverySchema, outputSchema: deliverySchema })
      .then(writing).then(bind(qualityReview)).commit();
    return { graph, direction, specification } as const;
  }

  const publish = createStep({ id: 'publish-product', description: '发布待审产品稿', inputSchema: deliverySchema, outputSchema: deliverySchema,
    /** 历史图保留原发布检查点。 */
    execute: async ({ inputData }) => publishDraft(inputData),
  });
  const direction = createWorkflow({ id: 'draft-product', description: '产品成稿与质量检查', inputSchema: deliverySchema, outputSchema: deliverySchema })
    .then(intake).then(analysis);
  const aligned = legacy ? direction.then(bind(managerPhase('clarification'))).then(bind(managerPhase('scope-priority'))) : direction;
  return { graph, draft: aligned.then(writing).then(bind(publish)).then(qualityReview).commit() } as const;
}
