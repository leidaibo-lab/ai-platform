/**
 * 角色间共享上下文的最小投影：共享可审计事实，而不是 Agent 完整会话、推理过程或私有观察记忆。
 * ADR: docs/decisions/2026-11-12-mastra-pluggable-autonomy-context.md
 */
import { z } from 'zod';

const hash = z.string().regex(/^[a-f0-9]{64}$/);

/** 条目必须说明其来源、消费者和允许用途；正文由既有 DTO/Store 按需解析，不在这里复制。 */
export const sharedContextRefSchema = z.object({
  id: z.string().trim().min(1).max(200),
  hash,
  source: z.enum(['approval', 'task', 'verification', 'review', 'repair']),
  audience: z.array(z.enum(['architect', 'implementation', 'reviewer', 'testing', 'operations'])).min(1),
  purpose: z.enum(['plan', 'implement', 'verify', 'repair', 'release']),
}).strict();
export type SharedContextRef = z.infer<typeof sharedContextRefSchema>;

/** 宿主注入点：只输出引用，实际内容继续由对应冻结产物和最小角色 DTO 提供。 */
export interface ContextSharePolicy {
  readonly version: string;
  select(input: { audience: SharedContextRef['audience'][number]; available: readonly SharedContextRef[] }): SharedContextRef[];
}

/** 默认策略只向对应受众交付其明确可见的引用，并去重排序，使输入可复现且避免“全量 session 共享”。 */
export const leastPrivilegeContextSharePolicy: ContextSharePolicy = {
  version: 'context-share-policy.v1',
  select({ audience, available }) {
    const unique = new Map<string, SharedContextRef>();
    for (const item of available) {
      const parsed = sharedContextRefSchema.parse(item);
      if (parsed.audience.includes(audience)) unique.set(`${parsed.source}:${parsed.id}:${parsed.hash}`, parsed);
    }
    return [...unique.values()].sort((left, right) => `${left.source}:${left.id}`.localeCompare(`${right.source}:${right.id}`));
  },
};

/** 防止替换实现以不版本化或异步副作用的方式绕过最小可见范围。 */
export function resolveContextSharePolicy(policy: ContextSharePolicy | undefined): ContextSharePolicy {
  const selected = policy ?? leastPrivilegeContextSharePolicy;
  if (!/^context-share-policy\.v\d+$/.test(selected.version) || typeof selected.select !== 'function') throw new Error('共享上下文策略无效');
  return selected;
}
