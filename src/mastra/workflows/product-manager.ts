import { createHash } from 'node:crypto';
import { createStep, createWorkflow, type Step } from '@mastra/core/workflows';
import { z } from 'zod';
import type { createAgents } from '../agents/index.js';
import type { Delivery } from './delivery.js';
import { deliverySchema } from './delivery.js';
import { productQualityReviewSchema, productManagerStages } from './product-contract.js';
import { createIntakeWorkflow } from '../../intake/workflow.js';
import { collectConfirmedDecisions } from '../../intake/contracts.js';
import { generateProductContent } from '../../intake/product-generation.js';
import { projectToolFacts } from '../../intake/run-timeline.js';
import { nacosResourceIdentity, type NacosSnapshot } from '../nacos-resources.js';

type StepBinder = <T extends Step<any, any, any, any, any, any>>(step: T) => T;

/** 产品经理 Workflow 的阶段职责；所有阶段使用同一个 product-manager-agent，避免重复交接上下文。 */
const managerPhaseInstructions: Record<typeof productManagerStages[number], string> = {
  analysis: '需求分析：提取目标、用户、场景、约束、范围和待决事项。',
  clarification: '需求澄清整理：吸收已确认回答，保留事实、歧义和不能自行决定的业务选择。',
  'scope-priority': '范围与优先级：明确首期范围、非目标、优先级和可检查验收边界，不代替独立质量审查。',
  writing: '产品稿写作：汇总前序事实、确认结论和范围，生成完整可审阅产品稿。',
};

/** 创建产品团队内部的 draft-product：需求澄清、产品经理成稿和独立产品质量审查均在此边界内完成。 */
export function createProductManagerWorkflow(
  agents: ReturnType<typeof createAgents>,
  mode: Delivery['mode'],
  bind: StepBinder = (step) => step,
  repositoryRoot?: string,
  resolveAgents?: (resources: NacosSnapshot) => Promise<ReturnType<typeof createAgents>>,
) {
  const manager = agents.productManagerAgent;
  const reviewer = agents.productReviewerAgent;

  /** 产品经理按固定阶段产出中间事实；阶段名用于审计，Agent 身份统一为 product-manager-agent。 */
  function managerPhase(role: typeof productManagerStages[number]) {
    return createStep({
      id: `product-${role}`,
      description: `product-manager-agent｜${managerPhaseInstructions[role]}`,
      inputSchema: deliverySchema,
      outputSchema: deliverySchema,
      execute: async ({ inputData }) => {
        if (inputData.mode !== mode) throw new Error('模型模式变化，不能跨模式生成产品稿');
        if (inputData.revision) return inputData;
        if (inputData.intake?.enabled && !inputData.intake.ready) throw new Error('需求尚未确认');
        const intakeMode = inputData.intake?.intakeMode ?? (inputData.intake?.enabled ? 'clarify' : 'autofill');
        const modeInstruction = intakeMode === 'autofill'
          ? '本次是“AI 主动补全”模式。不要把缺少用户回答当作继续提问的理由；请基于需求目标、常见产品实践和当前上下文主动选择一条最推荐的闭环方案。所有推断、默认值和推荐必须在产品稿中明确标注为“AI 建议”或“待确认”，不能伪装成用户已确认事实；完整产品稿必须包含目标、主流程、异常边界、非目标、指标和验收标准，供产品负责人一次性审阅。'
          : '本次是“逐项澄清”模式。只使用用户已经明确确认的业务规则；不能把推荐或假设升级为事实，关键缺口应保留为待确认项。';
        if (inputData.nacosResources && !resolveAgents) throw new Error('缺少冻结资源 Agent 装配器');
        const activeManager = inputData.nacosResources ? (await resolveAgents!(inputData.nacosResources)).productManagerAgent : manager;
        const result = await generateProductContent(activeManager, JSON.stringify({
          task: 'product-manager-phase',
          phase: role,
          phaseInstruction: managerPhaseInstructions[role],
          brief: inputData.brief,
          confirmedIntake: inputData.intake,
          confirmedDecisions: inputData.intake ? collectConfirmedDecisions(inputData.intake) : [],
          previousWork: inputData.productWork?.entries ?? [],
          rework: inputData.productRework,
          instruction: `你是同一个产品经理 Agent 的当前阶段。只完成当前阶段职责，保留事实、已确认规则、建议和待决项的区别；不得跳过人工产品审批，不得声称已完成后续研发、测试或部署。${modeInstruction}`,
        }), role, mode, repositoryRoot ? { root: repositoryRoot, receipt: inputData.repositoryHandoff } : undefined, inputData.contextBudgetLevel);
        const content = z.string().trim().min(1).max(100000).parse(result.text);
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
        return { ...inputData, productWork: { version: 'product-graph.v1' as const, entries: [...(inputData.productWork?.entries ?? []), entry] } };
      },
    });
  }

  /** 发布完整产品稿；发布只生成待审版本，不代表质量审查或人工批准。 */
  const publish = createStep({
    id: 'publish-product',
    description: 'product-manager-agent｜发布待审产品稿',
    inputSchema: deliverySchema,
    outputSchema: deliverySchema,
    execute: async ({ inputData }) => {
      const content = inputData.revision?.content ?? inputData.productWork?.entries.at(-1)?.content;
      if (!content) throw new Error('产品写作未产生可审阅正文');
      const hash = createHash('sha256').update(JSON.stringify({ stage: 'product', intake: inputData.intake, brief: inputData.brief, upstream: inputData.artifacts, content, revision: inputData.revision, productRework: inputData.productRework, productWork: inputData.productWork, ...(inputData.nacosResources ? { resources: nacosResourceIdentity(inputData.nacosResources) } : {}) })).digest('hex');
      return { ...inputData, artifacts: [...inputData.artifacts, { stage: 'product' as const, content, hash, evidence: mode === 'fixture' ? 'fixture' as const : 'model-proposal' as const }] };
    },
  });

  /** 独立产品审查只产生质量证据，不修改产品稿，也不替代人工审批。 */
  const qualityReview = createStep({
    id: 'review-product-quality',
    description: 'product-reviewer-agent｜独立闭环检查',
    inputSchema: deliverySchema,
    outputSchema: deliverySchema,
    execute: async ({ inputData }) => {
      const artifact = inputData.artifacts.at(-1);
      if (!artifact || artifact.stage !== 'product') throw new Error('产品审查缺少待审产品稿');
      if (inputData.nacosResources && !resolveAgents) throw new Error('缺少冻结资源 Agent 装配器');
      const activeReviewer = inputData.nacosResources ? (await resolveAgents!(inputData.nacosResources)).productReviewerAgent : reviewer;
      const result = await generateProductContent(activeReviewer, JSON.stringify({
        task: 'product-quality-review',
        brief: inputData.brief,
        product: artifact.content,
        instruction: '独立检查目标、范围、业务规则、正常/边界/异常流程、验收条件、非目标和风险。只输出审查发现与依据，不修改产品稿，不代替人工审批。',
      }), 'reviewer', mode, repositoryRoot ? { root: repositoryRoot, receipt: inputData.repositoryHandoff } : undefined, inputData.contextBudgetLevel);
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

  /** draft-product 内部先运行可选需求澄清，再由同一产品经理 Agent 完成四段式成稿，最后交给独立审查 Agent。 */
  return createWorkflow({
    id: 'draft-product',
    description: 'draft-product｜product-manager-agent：需求澄清、需求分析、范围与优先级、产品稿写作；product-reviewer-agent：独立闭环检查',
    inputSchema: deliverySchema,
    outputSchema: deliverySchema,
  })
    .then(createIntakeWorkflow(agents, mode, bind, resolveAgents))
    .then(bind(managerPhase('analysis')))
    .then(bind(managerPhase('clarification')))
    .then(bind(managerPhase('scope-priority')))
    .then(bind(managerPhase('writing')))
    .then(bind(publish))
    .then(bind(qualityReview))
    .commit();
}
