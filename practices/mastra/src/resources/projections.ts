/** 角色最小交接 DTO：模型只接收宿主投影，不接收 Store、完整State或审批原文之外的状态。 */
import { z } from 'zod';
import { resourceHash } from './contracts.js';
import type { RuntimeResourceConfig } from './resource-config.js';
import type { FrozenResources } from './contracts.js';

export const resourceRefSchema = z.object({ resourceId: z.string().min(1), hash: z.string().length(64), version: z.string().min(1) }).strict();
export const roleInvocationSchema = z.object({ version: z.literal('agent-invocation.v1'), runId: z.string().min(1), roleId: z.string().min(1), taskId: z.string().nullable(), round: z.number().int().nonnegative(), bundleHash: z.string().length(64), inputContract: z.string().min(1), inputHash: z.string().length(64), resourceRefs: z.array(resourceRefSchema), payload: z.record(z.string(), z.unknown()).refine(value => !('store' in value) && !('state' in value), '禁止透传运行时状态') }).strict();
export type RoleInvocation = z.infer<typeof roleInvocationSchema>;

/** 为当前角色建立不可变交接信封；不把配置正文或凭据放入模型输入。 */
export function createRoleInvocation(input: { runId: string; roleId: string; taskId?: string | null; round?: number; bundleHash: string; inputContract: string; payload: Record<string, unknown>; resources: FrozenResources; config: RuntimeResourceConfig }): RoleInvocation {
  const configured = input.config.roles.find(role => role.inputContract === input.inputContract);
  if (!configured || configured.id !== input.roleId) throw new Error('角色输入契约与冻结配置不匹配');
  const normalized = { ...input.payload };
  return roleInvocationSchema.parse({ version: 'agent-invocation.v1', runId: input.runId, roleId: input.roleId, taskId: input.taskId ?? null, round: input.round ?? 0, bundleHash: input.bundleHash, inputContract: input.inputContract, inputHash: resourceHash(normalized), resourceRefs: Object.entries(input.resources.roles).slice(0, 20).map(([resourceId, role]) => ({ resourceId, version: role.versionId, hash: role.configHash })), payload: normalized });
}
