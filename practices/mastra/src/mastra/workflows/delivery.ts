import { createHash } from 'node:crypto';
import { createStep, createWorkflow } from '@mastra/core/workflows';
import { z } from 'zod';
import type { createAgents } from '../agents/index.js';
import { revisionSourceSchema } from './revision.js';
import { maxProductReworks, productReworkSchema, productWorkSchema } from './product-contract.js';
import { createProductWorkflow } from './product.js';

export const stageSchema = z.enum(['product', 'development', 'testing', 'operations']);
export type Stage = z.infer<typeof stageSchema>;
export const artifactSchema = z.object({
  stage: stageSchema, content: z.string().min(1).max(100000), hash: z.string().length(64),
  evidence: z.enum(['fixture', 'model-proposal']),
});
/** 审批绑定内容散列；role/reviewer 是本地声明，不是认证身份。 */
export const reviewSchema = z.object({
  role: stageSchema, artifactHash: z.string().length(64), decision: z.enum(['approve', 'reject', 'rework']),
  reviewer: z.string().trim().min(1).max(100), comment: z.string().trim().min(1).max(2000),
});
export type Review = z.infer<typeof reviewSchema>;
/** Workflow 持有有序交接物和审阅记录；各步骤返回新数组，不更改上游快照。 */
export const deliverySchema = z.object({
  brief: z.string().trim().min(1).max(12000),
  mode: z.enum(['fixture', 'live']),
  revision: revisionSourceSchema.optional(),
  productWork: productWorkSchema.optional(),
  productRework: productReworkSchema.optional(),
  artifacts: z.array(artifactSchema).max(4),
  reviews: z.array(reviewSchema).max(4),
  outcome: z.enum(['in-progress', 'rejected', 'rework-requested', 'plan-approved']),
});
export const pendingSchema = z.object({ role: stageSchema, artifact: artifactSchema, productReworkRound: z.number().int().min(0).max(maxProductReworks).default(0) });
export type PendingReview = z.infer<typeof pendingSchema>;
export type Delivery = z.infer<typeof deliverySchema>;
export const stages: readonly Stage[] = ['product', 'development', 'testing', 'operations'];
export const deliveryInputSchema = deliverySchema.pick({ brief: true, revision: true, productRework: true }).refine(
  // 预览稿原样应用与四角色返工是两条明确路径，不接受含混的双来源。
  (input) => !(input.revision && input.productRework),
  '修订预览与产品返工不能同时作为输入来源',
);

/** 校验本地审批角色和版本，防止旧交接物或错误角色推进下一阶段。 */
export function validateReview(pending: PendingReview, input: unknown): Review {
  const review = reviewSchema.parse(input);
  if (review.role !== pending.role) throw new Error('审批角色与当前交接阶段不匹配');
  if (review.artifactHash !== pending.artifact.hash) throw new Error('交接物版本不匹配；请重新读取当前待审内容');
  if (review.decision === 'rework' && pending.role !== 'product') throw new Error('只有产品阶段支持退回修改');
  if (review.decision === 'rework' && pending.productReworkRound >= maxProductReworks) throw new Error('产品返工已达三次上限，请人工整理后另起需求，或批准/终止当前轮次');
  return review;
}

/** 用原生复合 Workflow 和 suspend/resume 表达交接，不实现另一套调度器。 */
export function createDeliveryWorkflow(agents: ReturnType<typeof createAgents>, mode: Delivery['mode']) {
  const stageAgents = { development: agents.developmentAgent, testing: agents.testingAgent, operations: agents.operationsAgent };
  const initialize = createStep({
    id: 'initialize', inputSchema: deliveryInputSchema, outputSchema: deliverySchema,
    // 模式和空记录来自应用配置，入口不能伪造已确认内容或证据级别。
    execute: async ({ inputData }) => ({ ...inputData, mode, artifacts: [], reviews: [], outcome: 'in-progress' as const }),
  });
  /** 生成提案并绑定需求及全部上游已确认交接物，生成行为没有工程副作用。 */
  function draft(stage: Exclude<Stage, 'product'>) {
    return createStep({
      id: `draft-${stage}`, inputSchema: deliverySchema, outputSchema: deliverySchema,
      // 将已确认内容交给对应原生 Agent，检查非空输出后生成内容版本。
      execute: async ({ inputData }) => {
        if (inputData.mode !== mode) throw new Error('模型模式变化，不能跨模式继续生成交接物');
        const result = await stageAgents[stage].generate(JSON.stringify({ brief: inputData.brief, approvedArtifacts: inputData.artifacts, ...(inputData.revision ? { confirmedRevision: { decisions: inputData.revision.confirmedDecisions, sourceRunId: inputData.revision.sourceRunId, note: '原始 brief 用于溯源；已确认修订及当前批准交接物是本轮规则依据。' } } : {}) }), { maxSteps: stage === 'development' ? 3 : 1 });
        const content = z.string().trim().min(1).max(100000).parse(result.text);
        const hash = createHash('sha256').update(JSON.stringify({ stage, brief: inputData.brief, upstream: inputData.artifacts, content, ...(inputData.revision ? { revision: inputData.revision } : {}) })).digest('hex');
        return { ...inputData, artifacts: [...inputData.artifacts, { stage, content, hash, evidence: inputData.mode === 'fixture' ? 'fixture' as const : 'model-proposal' as const }] };
      },
    });
  }
  /** 人工确认点由 Mastra 保存；终止和返工分别落为终态，新轮次由服务启动。 */
  function gate(stage: Stage) {
    return createStep({
      id: `review-${stage}`, inputSchema: deliverySchema, outputSchema: deliverySchema,
      suspendSchema: pendingSchema, resumeSchema: reviewSchema,
      // 第一次暂停，恢复时核对版本和角色；拒绝不会生成下一阶段。
      execute: async ({ inputData, resumeData, suspend, bail }) => {
        if (inputData.mode !== mode) throw new Error('模型模式变化，不能跨模式继续审批');
        const artifact = inputData.artifacts.at(-1)!;
        const pending = pendingSchema.parse({ role: stage, artifact, productReworkRound: inputData.productRework?.round ?? 0 });
        if (!resumeData) return suspend(pending);
        const review = validateReview(pending, resumeData);
        const next = { ...inputData, reviews: [...inputData.reviews, review] };
        if (review.decision === 'reject') return bail({ ...next, outcome: 'rejected' as const });
        if (review.decision === 'rework') return bail({ ...next, outcome: 'rework-requested' as const });
        return next;
      },
    });
  }
  const finish = createStep({
    id: 'finish', inputSchema: deliverySchema, outputSchema: deliverySchema,
    // 终态仅表示四次方案确认，不代表代码、测试或部署已执行。
    execute: async ({ inputData }) => ({ ...inputData, outcome: 'plan-approved' as const }),
  });
  return createWorkflow({ id: 'product-delivery', inputSchema: deliveryInputSchema, outputSchema: deliverySchema })
    .then(initialize)
    .then(createProductWorkflow(agents, mode, deliverySchema)).then(gate('product'))
    .then(draft('development')).then(gate('development'))
    .then(draft('testing')).then(gate('testing'))
    .then(draft('operations')).then(gate('operations'))
    .then(finish).commit();
}
