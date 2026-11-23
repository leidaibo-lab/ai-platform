import { createHash } from 'node:crypto';
import { z } from 'zod';

/** 产品修订的原生状态投影，候选正文只用于服务端恢复。 */
export const productRepairCheckpointSchema = z.object({
  version: z.literal('product-repair-checkpoint.v1'),
  policyVersion: z.enum(['product-writing-repair.v1', 'product-writing-repair.v2']),
  history: z.array(z.object({ candidateHash: z.string().regex(/^[a-f0-9]{64}$/), finding: z.string().max(1000), outcome: z.enum(['rework', 'no-progress', 'budget-exhausted', 'passed']) })).max(4),
  candidate: z.string().max(100000),
}).strict();
export type ProductRepairCheckpoint = z.infer<typeof productRepairCheckpointSchema>;

/** 不允许普通恢复清除终止原因，重新授权须走独立业务入口。 */
export function assertProductRepairContinuation(checkpoint: ProductRepairCheckpoint) {
  const last = checkpoint.history.at(-1);
  if (last && createHash('sha256').update(checkpoint.candidate).digest('hex') !== last.candidateHash) throw new Error('产品修订候选与检查点散列不一致');
  const limit = checkpoint.policyVersion === 'product-writing-repair.v1' ? 1 : 3;
  if (checkpoint.history.length > limit && last?.outcome === 'rework') throw new Error('产品修订检查点预算不一致');
  if (last?.outcome === 'budget-exhausted') throw new Error('产品修订预算已耗尽，不能通过重试重置预算');
  if (last?.outcome === 'no-progress') throw new Error('产品修订没有进展，不能通过重试重置预算');
}
