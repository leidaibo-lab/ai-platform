import { productDocumentsInstruction, readProductDocuments } from '../../business-engineering/product-documents.js';
import type { projectSpec } from '../../business-engineering/project.js';
import { acceptanceRequirementsInstruction, readAcceptanceRequirements } from '../../business-engineering/acceptance-requirements.js';
import { createHash } from 'node:crypto';
import { createStep, createWorkflow, type Step } from '@mastra/core/workflows';
import { PUBSUB_SYMBOL } from '@mastra/core/workflows/_constants';
import { z } from 'zod';
import type { createAgents } from '../agents/index.js';
import type { Delivery } from './delivery.js';
import { deliverySchema } from './delivery.js';
import { maxProductReworks, productQualityReviewSchema, productManagerStages } from './product-contract.js';
import { createIntakeWorkflow } from '../../intake/workflow.js';
import { collectConfirmedDecisions } from '../../intake/contracts.js';
import { generateProductContent } from '../../intake/product-generation.js';
import { projectToolFacts } from '../../intake/run-timeline.js';
import { nacosResourceIdentity, type NacosSnapshot } from '../nacos-resources.js';
import { correctionPauseSchema, runInterruptibleProductAttempt } from '../../intake/product-interruption.js';
import { productReworkFeedback } from './product-rework.js';
import { publishLiveOutput } from '../../intake/live-output.js';

type StepBinder = <T extends Step<any, any, any, any, any, any>>(step: T) => T;

/** 产品经理 Workflow 的阶段职责；所有阶段使用同一个 product-manager-agent，避免重复交接上下文。 */
const managerPhaseInstructions: Record<typeof productManagerStages[number], string> = {
  analysis: '需求分析：提取目标、用户、场景、约束、范围和待决事项。',
  clarification: '需求澄清整理：吸收已确认回答，保留事实、歧义和不能自行决定的业务选择。',
  'scope-priority': '范围与优先级：明确首期范围、非目标、优先级和可检查验收边界，不代替独立质量审查。',
  writing: '产品稿写作：汇总前序事实、确认结论和范围，生成完整可审阅产品稿。',
};

/** 装配产品方向和规格阶段，历史图复用相同的业务执行逻辑。 */
export function createProductManagerPhases(
  agents: ReturnType<typeof createAgents>,
  mode: Delivery['mode'],
  bind: StepBinder = (step) => step,
  repositoryRoot?: string,
  resolveAgents?: (resources: NacosSnapshot) => Promise<ReturnType<typeof createAgents>>,
  engineeringSpec?: ReturnType<typeof projectSpec>,
  graph: 'native' | 'nested' | 'legacy' = 'native',
) {
  const legacy = graph === 'legacy';
  const manager = agents.productManagerAgent;
  const reviewer = agents.productReviewerAgent;

  /** 产品经理按固定阶段产出中间事实；阶段名用于审计，Agent 身份统一为 product-manager-agent。 */
  function managerPhase(role: typeof productManagerStages[number]) {
    return createStep({
      id: `product-${role}`,
      description: `product-manager-agent｜${managerPhaseInstructions[role]}`,
      inputSchema: deliverySchema,
      outputSchema: deliverySchema,
      suspendSchema: correctionPauseSchema,
      execute: async ({ inputData, runId, abortSignal, suspend, [PUBSUB_SYMBOL]: pubsub }) => {
        if (inputData.mode !== mode) throw new Error('模型模式变化，不能跨模式生成产品稿');
        if (inputData.revision) return graph === 'native' && role === 'writing' ? publishDraft(inputData) : inputData;
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
        const activeManager = inputData.nacosResources ? (await resolveAgents!(inputData.nacosResources)).productManagerAgent : manager;
        const attempt = await runInterruptibleProductAttempt(runId, abortSignal, (inputData.productRework?.round ?? 0) < maxProductReworks, signal => generateProductContent(activeManager, JSON.stringify({
          task: 'product-manager-phase',
          phase: role,
          engineeringSpec,
          phaseInstruction,
          brief: inputData.brief,
          confirmedIntake: inputData.intake,
          confirmedDecisions: inputData.intake ? collectConfirmedDecisions(inputData.intake) : [],
          successorBaseline: inputData.successorBaseline ? { sourceRunId: inputData.successorBaseline.sourceRunId, changeBrief: inputData.successorBaseline.changeBrief, artifacts: inputData.successorBaseline.artifacts.map(item => ({ kind: item.kind, path: item.path, commit: item.commit, content: item.content })) } : undefined,
          previousWork: inputData.productWork?.entries ?? [],
          rework: inputData.productRework,
          priorFeedback: inputData.productReworkHistory?.map(({ round, feedback }) => ({ round, feedback })),
          instruction: `你是同一个产品经理 Agent 的当前阶段。只完成当前阶段职责，保留事实、已确认规则、建议和待决项的区别；不得跳过人工产品审批，不得声称已完成后续研发、测试或部署。${modeInstruction}${role === 'writing' ? (inputData.productHandoffFormat ? productDocumentsInstruction : inputData.requirementTracking ? acceptanceRequirementsInstruction : '') : ''}`,
        }), role, mode, repositoryRoot ? { root: repositoryRoot, receipt: inputData.repositoryHandoff } : undefined, inputData.contextBudgetLevel, event => publishLiveOutput(pubsub, runId, event), signal));
        if (attempt.correction) return suspend(attempt.correction);
        const result = attempt.output;
        const content = z.string().trim().min(1).max(100000).parse(result.text);
        if (graph !== 'native' && role === 'writing') {
          if (inputData.productHandoffFormat) readProductDocuments(content);
          else if (inputData.requirementTracking) readAcceptanceRequirements(content);
        }
        const facts = projectToolFacts(result.toolResults);
        const entry = {
          role,
          agent: 'product-manager-agent',
          content,
          toolNames: facts.tools,
          files: facts.files,
          startedAt: result.generation?.startedAt,
          endedAt: result.generation?.endedAt,
          durationMs: result.generation?.durationMs,
          modelSteps: result.steps.length,
          generation: result.generation,
        };
        const resultState = { ...inputData, productWork: { version: 'product-graph.v1' as const, entries: [...(inputData.productWork?.entries ?? []), entry] } };
        return graph === 'native' && role === 'writing' ? publishDraft(resultState) : resultState;
      },
    });
  }

  /** 将写作结果固化为待审版本。 */
  function publishDraft(inputData: Delivery): Delivery {
    const content = inputData.revision?.content ?? inputData.productWork?.entries.at(-1)?.content;
    if (!content) throw new Error('产品写作未产生可审阅正文');
    if (inputData.productHandoffFormat) readProductDocuments(content);
    else if (inputData.requirementTracking) readAcceptanceRequirements(content);
    const hash = createHash('sha256').update(JSON.stringify({ stage: 'product', intake: inputData.intake, brief: inputData.brief, upstream: inputData.artifacts, content, revision: inputData.revision, productRework: inputData.productRework, productWork: inputData.productWork, ...(inputData.nacosResources ? { resources: nacosResourceIdentity(inputData.nacosResources) } : {}) })).digest('hex');
    return { ...inputData, artifacts: [...inputData.artifacts, { stage: 'product' as const, content, hash, evidence: mode === 'fixture' ? 'fixture' as const : 'model-proposal' as const }] };
  }

  /** 独立产品审查只产生质量证据，不修改产品稿，也不替代人工审批。 */
  const qualityReview = createStep({
    id: 'review-product-quality',
    description: 'product-reviewer-agent｜独立闭环检查',
    inputSchema: deliverySchema,
    outputSchema: deliverySchema,
    suspendSchema: correctionPauseSchema,
    execute: async ({ inputData, runId, abortSignal, suspend, [PUBSUB_SYMBOL]: pubsub }) => {
      const artifact = inputData.artifacts.at(-1);
      if (!artifact || artifact.stage !== 'product') throw new Error('产品审查缺少待审产品稿');
      if (inputData.nacosResources && !resolveAgents) throw new Error('缺少冻结资源 Agent 装配器');
      const activeReviewer = inputData.nacosResources ? (await resolveAgents!(inputData.nacosResources)).productReviewerAgent : reviewer;
      const attempt = await runInterruptibleProductAttempt(runId, abortSignal, (inputData.productRework?.round ?? 0) < maxProductReworks, signal => generateProductContent(activeReviewer, JSON.stringify({
        task: 'product-quality-review',
        engineeringSpec,
        brief: inputData.brief,
        product: artifact.content,
        corrections: productReworkFeedback(inputData),
        instruction: '独立检查目标、范围、业务规则、正常/边界/异常流程、验收条件、非目标和风险。检查需求文档中的场景是否忠实覆盖确认的业务规则，产品规格中的交付任务是否与需求对应。只输出审查发现与依据，不修改产品稿，不代替人工审批。',
      }), 'reviewer', mode, repositoryRoot ? { root: repositoryRoot, receipt: inputData.repositoryHandoff } : undefined, inputData.contextBudgetLevel, event => publishLiveOutput(pubsub, runId, event), signal));
      if (attempt.correction) return suspend(attempt.correction);
      const result = attempt.output;
      const facts = projectToolFacts(result.toolResults);
      const review = productQualityReviewSchema.parse({
        version: 'product-quality-review.v1',
        agent: 'product-reviewer-agent',
        content: result.text,
        hash: createHash('sha256').update(JSON.stringify({ productHash: artifact.hash, content: result.text })).digest('hex'),
        toolNames: facts.tools,
        files: facts.files,
        generation: result.generation,
      });
      return { ...inputData, productQualityReview: review };
    },
  });

  const intake = createIntakeWorkflow(agents, mode, bind, resolveAgents, engineeringSpec);
  const analysis = bind(managerPhase('analysis'));
  const writing = bind(managerPhase('writing'));
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
