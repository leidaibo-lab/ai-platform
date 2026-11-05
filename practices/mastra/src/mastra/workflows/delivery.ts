import { createHash } from 'node:crypto';
import { createStep, createWorkflow } from '@mastra/core/workflows';
import { z } from 'zod';
import type { createAgents } from '../agents/index.js';
import { PRODUCT_MAX_STEPS } from '../agents/skills.js';
import { revisionSourceSchema } from './revision.js';

export const stageSchema = z.enum(['product', 'development', 'testing', 'operations']);
export type Stage = z.infer<typeof stageSchema>;
export const artifactSchema = z.object({
  stage: stageSchema, content: z.string().min(1).max(100000), hash: z.string().length(64),
  evidence: z.enum(['fixture', 'model-proposal']),
});
/** 审批绑定内容散列；role/reviewer 是本地声明，不是认证身份。 */
export const reviewSchema = z.object({
  role: stageSchema, artifactHash: z.string().length(64), decision: z.enum(['approve', 'reject']),
  reviewer: z.string().trim().min(1).max(100), comment: z.string().trim().min(1).max(2000),
});
export type Review = z.infer<typeof reviewSchema>;
/** Workflow 持有有序交接物和审阅记录；各步骤返回新数组，不更改上游快照。 */
export const deliverySchema = z.object({
  brief: z.string().trim().min(1).max(12000),
  mode: z.enum(['fixture', 'live']),
  revision: revisionSourceSchema.optional(),
  artifacts: z.array(artifactSchema).max(4),
  reviews: z.array(reviewSchema).max(4),
  outcome: z.enum(['in-progress', 'rejected', 'plan-approved']),
});
export const pendingSchema = z.object({ role: stageSchema, artifact: artifactSchema });
export type PendingReview = z.infer<typeof pendingSchema>;
export type Delivery = z.infer<typeof deliverySchema>;
export const stages: readonly Stage[] = ['product', 'development', 'testing', 'operations'];
export const deliveryInputSchema = deliverySchema.pick({ brief: true, revision: true });

/** 校验本地审批角色和版本，防止旧交接物或错误角色推进下一阶段。 */
export function validateReview(pending: PendingReview, input: unknown): Review {
  const review = reviewSchema.parse(input);
  if (review.role !== pending.role) throw new Error('审批角色与当前交接阶段不匹配');
  if (review.artifactHash !== pending.artifact.hash) throw new Error('交接物版本不匹配；请重新读取当前待审内容');
  return review;
}

/** 用原生串行 Workflow 和 suspend/resume 表达交接，不实现另一套调度器。 */
export function createDeliveryWorkflow(agents: ReturnType<typeof createAgents>, mode: Delivery['mode']) {
  const stageAgents = { product: agents.productAgent, development: agents.developmentAgent, testing: agents.testingAgent, operations: agents.operationsAgent };
  const initialize = createStep({
    id: 'initialize', inputSchema: deliveryInputSchema, outputSchema: deliverySchema,
    // 模式和空记录来自应用配置，入口不能伪造已确认内容或证据级别。
    execute: async ({ inputData }) => ({ ...inputData, mode, artifacts: [], reviews: [], outcome: 'in-progress' as const }),
  });
  /** 生成提案并绑定需求及全部上游已确认交接物，生成行为没有工程副作用。 */
  function draft(stage: Stage) {
    return createStep({
      id: `draft-${stage}`, inputSchema: deliverySchema, outputSchema: deliverySchema,
      // 将已确认内容交给对应原生 Agent，检查非空输出后生成内容版本。
      execute: async ({ inputData }) => {
        if (inputData.mode !== mode) throw new Error('模型模式变化，不能跨模式继续生成交接物');
        // 已应用的产品稿原样进入新轮次，不在预览后再次调用模型。
        const result = stage === 'product' && inputData.revision ? { text: inputData.revision.content } : await stageAgents[stage].generate(JSON.stringify({ brief: inputData.brief, approvedArtifacts: inputData.artifacts, ...(inputData.revision ? { confirmedRevision: { decisions: inputData.revision.confirmedDecisions, sourceRunId: inputData.revision.sourceRunId, note: '原始 brief 用于溯源；已确认修订及当前批准交接物是本轮规则依据。' } } : {}) }), { maxSteps: stage === 'product' ? PRODUCT_MAX_STEPS : stage === 'development' ? 3 : 1 });
        const content = z.string().trim().min(1).max(100000).parse(result.text);
        const hash = createHash('sha256').update(JSON.stringify({ stage, brief: inputData.brief, upstream: inputData.artifacts, content, ...(inputData.revision ? { revision: inputData.revision } : {}) })).digest('hex');
        return { ...inputData, artifacts: [...inputData.artifacts, { stage, content, hash, evidence: inputData.mode === 'fixture' ? 'fixture' as const : 'model-proposal' as const }] };
      },
    });
  }
  /** 人工确认点由 Mastra 保存快照；拒绝直接结束本轮，后续修改另开新 Run。 */
  function gate(stage: Stage) {
    return createStep({
      id: `review-${stage}`, inputSchema: deliverySchema, outputSchema: deliverySchema,
      suspendSchema: pendingSchema, resumeSchema: reviewSchema,
      // 第一次暂停，恢复时核对版本和角色；拒绝不会生成下一阶段。
      execute: async ({ inputData, resumeData, suspend, bail }) => {
        if (inputData.mode !== mode) throw new Error('模型模式变化，不能跨模式继续审批');
        const artifact = inputData.artifacts.at(-1)!;
        const pending = pendingSchema.parse({ role: stage, artifact });
        if (!resumeData) return suspend(pending);
        const review = validateReview(pending, resumeData);
        const next = { ...inputData, reviews: [...inputData.reviews, review] };
        if (review.decision === 'reject') return bail({ ...next, outcome: 'rejected' as const });
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
    .then(draft('product')).then(gate('product'))
    .then(draft('development')).then(gate('development'))
    .then(draft('testing')).then(gate('testing'))
    .then(draft('operations')).then(gate('operations'))
    .then(finish).commit();
}
