import { z } from 'zod';

/** 固定在 Run 输入中的执行策略；无策略字段的历史 Run 保持原预算。 */
export const teamRunPolicySchema = z.object({
  version: z.literal('team-run-policy.v1'),
  development: z.object({ version: z.literal('development-loop.v2'), budgetSource: z.literal('approved-development-input') }).strict().optional(),
  testing: z.object({ version: z.literal('testing-loop.v1'), budgetSource: z.literal('development-verification-ledger') }).strict().optional(),
  delivery: z.object({ version: z.literal('delivery-retry.v1'), retry: z.literal('explicit-resume'), reconcile: z.literal('same-candidate-and-qa') }).strict().optional(),
  product: z.object({
    quality: z.object({ version: z.literal('product-quality-loop.v1'), maxRepairs: z.literal(2) }).strict().optional(),
    writing: z.object({ version: z.literal('product-writing-repair.v2'), maxRepairs: z.literal(3), stopOnRepeatedCandidate: z.literal(true) }).strict(),
  }).strict(),
}).strict();
export type TeamRunPolicy = z.infer<typeof teamRunPolicySchema>;

/** 每次初始化生成独立策略对象，交给原生 Store 冻结。 */
export function createTeamRunPolicy(): TeamRunPolicy {
  return teamRunPolicySchema.parse({ version: 'team-run-policy.v1', development: { version: 'development-loop.v2', budgetSource: 'approved-development-input' }, testing: { version: 'testing-loop.v1', budgetSource: 'development-verification-ledger' }, delivery: { version: 'delivery-retry.v1', retry: 'explicit-resume', reconcile: 'same-candidate-and-qa' }, product: { quality: { version: 'product-quality-loop.v1', maxRepairs: 2 }, writing: { version: 'product-writing-repair.v2', maxRepairs: 3, stopOnRepeatedCandidate: true } } });
}

/** 解析旧 Run 的一次修订语义，不以当前默认值推断历史。 */
export function productWritingPolicy(policy?: TeamRunPolicy) {
  if (!policy) return { version: 'product-writing-repair.v1' as const, maxRepairs: 1, stopOnRepeatedCandidate: false };
  return teamRunPolicySchema.parse(policy).product.writing;
}
