import { formalSpecificationReceiptSchema, remoteHandoffSchema } from '../../delivery/remote-handoff.js';
import { intakeSchema, intakeModeSchema } from '../../intake/contracts.js';
import { z } from 'zod';
import { revisionSourceSchema } from './revision-contract.js';
import { maxProductReworks, productQualityReviewSchema, productReworkSchema, productWorkSchema } from './product-contract.js';
import { correlationSchema } from '../../delivery/asset-identity.js';
import { maxContextBudgetLevel } from '../../delivery/context-budget.js';
import { nacosSnapshotSchema } from '../nacos-resources.js';

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
  nacosResources: nacosSnapshotSchema.optional(),
  intake: intakeSchema.optional(),
  // 顶层保留入口策略，便于恢复和页面投影不依赖当前暂停点。
  intakeMode: intakeModeSchema.optional(),
  repositoryHandoff: remoteHandoffSchema.optional(),
  /** 已确认规格的远端回执；Store 保留其与审批、恢复的关系。 */
  formalSpecifications: z.array(formalSpecificationReceiptSchema).max(4).optional(),
  correlation: correlationSchema.optional(),
  brief: z.string().trim().min(1).max(12000),
  mode: z.enum(['fixture', 'live']),
  revision: revisionSourceSchema.optional(),
  productWork: productWorkSchema.optional(),
  productQualityReview: productQualityReviewSchema.optional(),
  productRework: productReworkSchema.optional(),
  contextBudgetLevel: z.number().int().min(0).max(maxContextBudgetLevel).optional(),
  artifacts: z.array(artifactSchema).max(4),
  reviews: z.array(reviewSchema).max(4),
  outcome: z.enum(['in-progress', 'rejected', 'rework-requested', 'plan-approved']),
});
export const pendingSchema = z.object({ role: stageSchema, artifact: artifactSchema, productReworkRound: z.number().int().min(0).max(maxProductReworks).default(0) });
export type PendingReview = z.infer<typeof pendingSchema>;
export type Delivery = z.infer<typeof deliverySchema>;
export const stages: readonly Stage[] = ['product', 'development', 'testing', 'operations'];
export const deliveryInputSchema = deliverySchema.pick({ brief: true, revision: true, productRework: true }).refine(
  // 修订稿原样应用与产品团队返工是两条明确路径，不接受含混的双来源。
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
