import { productQualityRoundSchema } from '../../team/product-quality-loop.js';
import { z } from 'zod';
import { createHash } from 'node:crypto';
import { PRODUCT_MAX_STEPS } from '../skills.js';
import { externalSourceSchema } from '../../intake/external-evidence.js';
import { productGenerationSchema } from '../../delivery/product-generation-contract.js';

/** 产品经理阶段是同一 Agent 的工作切片，不对应独立角色或独立 Agent。 */
export const productManagerStages = ['analysis', 'clarification', 'scope-priority', 'writing'] as const;
export const maxProductReworks = 3;

/** 角色产物由原生子流程按顺序写入；工具名和步数只表达执行事实。 */
export const productWorkSchema = z.object({
  version: z.literal('product-graph.v1'),
  entries: z.array(z.object({
    role: z.enum(productManagerStages),
    agent: z.string().min(1).max(100).optional(),
    content: z.string().trim().min(1).max(100000),
    toolNames: z.array(z.string().min(1)).max(30),
    files: z.array(z.string().min(1)).max(100).optional(),
    startedAt: z.string().datetime().optional(),
    endedAt: z.string().datetime().optional(),
    durationMs: z.number().nonnegative().optional(),
    modelSteps: z.number().int().min(1).max(PRODUCT_MAX_STEPS),
    // 旧产物不补造完成证据；后续产物记录正常结束及有界重试事实。
    generation: productGenerationSchema.optional(),
    presentationRepairs: z.number().int().min(0).max(3).optional(),
    presentationRepairHistory: z.array(z.object({ candidateHash: z.string().length(64), finding: z.string().max(1000), outcome: z.enum(['rework', 'no-progress', 'budget-exhausted', 'passed']) })).max(4).optional(),
    externalSources: z.array(externalSourceSchema).max(30).optional(),
    workspaceReads: z.array(z.object({ path: z.string(), sourceHash: z.string().length(64) })).optional(),
  })).max(4),
});
export type ProductWork = z.infer<typeof productWorkSchema>;

/** 独立产品审查的持久化结果；它是质量证据，不等同于人工产品批准。 */
export const productQualityReviewSchema = z.object({
  version: z.literal('product-quality-review.v1'),
  agent: z.literal('product-reviewer-agent'),
  productHash: z.string().length(64).optional(),
  loop: z.object({ repairs: z.number().int().min(0).max(2), status: z.enum(['passed', 'business-decision', 'repair-budget', 'no-progress']), rounds: z.array(productQualityRoundSchema).max(3) }).optional(),
  content: z.string().trim().min(1).max(100000),
  hash: z.string().regex(/^[a-f0-9]{64}$/),
  toolNames: z.array(z.string().min(1)).max(30),
  files: z.array(z.string().min(1)).max(100).optional(),
  generation: productGenerationSchema.optional(),
  externalSources: z.array(externalSourceSchema).max(30).optional(),
  workspaceReads: z.array(z.object({ path: z.string(), sourceHash: z.string().length(64) })).optional(),
});
export type ProductQualityReview = z.infer<typeof productQualityReviewSchema>;

/** 返工依据仅从已保存审阅生成；来源正文不可被客户端替换。 */
export const productReworkSchema = z.object({
  sourceRunId: z.string().min(1).max(200),
  sourceHash: z.string().regex(/^[a-f0-9]{64}$/),
  sourceContent: z.string().trim().min(1).max(100000).optional(),
  attempt: z.uuid().optional(),
  target: z.enum(['guided-requirements', ...productManagerStages]).optional(),
  reason: z.string().trim().min(1).max(500).optional(),
  method: z.literal('product-rework.v1').optional(),
  reviewer: z.string().trim().min(1).max(100),
  feedback: z.string().trim().min(1).max(2000),
  round: z.number().int().min(1).max(maxProductReworks),
});
export type ProductRework = z.infer<typeof productReworkSchema>;

/** 同一来源版本永远映射同一个返工轮次，供执行和只读导航共同使用。 */
export function productReworkRunId(sourceRunId: string, sourceHash: string): string {
  return `product-rework-${createHash('sha256').update(`${sourceRunId}:${sourceHash}`).digest('hex').slice(0, 32)}`;
}
