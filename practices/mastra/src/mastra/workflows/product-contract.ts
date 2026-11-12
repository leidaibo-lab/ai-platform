import { z } from 'zod';
import { createHash } from 'node:crypto';
import { PRODUCT_MAX_STEPS } from '../agents/skills.js';
import { productGenerationSchema } from '../../delivery/product-generation-contract.js';
import { invocationEvidenceSchema } from '../../resources/projections.js';

export const productRoles = ['coordinator', 'clarification', 'closure', 'writing'] as const;
export const maxProductReworks = 3;

/** 角色产物由原生子流程按顺序写入；工具名和步数只表达执行事实。 */
export const productWorkSchema = z.object({
  version: z.literal('product-graph.v1'),
  entries: z.array(z.object({
    role: z.enum(productRoles),
    content: z.string().trim().min(1).max(100000),
    toolNames: z.array(z.string().min(1)).max(30),
    modelSteps: z.number().int().min(1).max(PRODUCT_MAX_STEPS),
    // 旧产物不补造完成证据；后续产物记录正常结束及有界重试事实。
    generation: productGenerationSchema.optional(),
    // 正式资源主链由宿主写入输入/输出/工具/版本证据，非资源旧入口不补造。
    invocation: invocationEvidenceSchema.optional(),
  })).max(4),
});
export type ProductWork = z.infer<typeof productWorkSchema>;

/** 返工依据仅从已保存审阅生成；来源正文不可被客户端替换。 */
export const productReworkSchema = z.object({
  sourceRunId: z.string().min(1).max(200),
  sourceHash: z.string().regex(/^[a-f0-9]{64}$/),
  sourceContent: z.string().trim().min(1).max(100000),
  reviewer: z.string().trim().min(1).max(100),
  feedback: z.string().trim().min(1).max(2000),
  round: z.number().int().min(1).max(maxProductReworks),
});
export type ProductRework = z.infer<typeof productReworkSchema>;

/** 同一来源版本永远映射同一个返工轮次，供执行和只读导航共同使用。 */
export function productReworkRunId(sourceRunId: string, sourceHash: string): string {
  return `product-rework-${createHash('sha256').update(`${sourceRunId}:${sourceHash}`).digest('hex').slice(0, 32)}`;
}
