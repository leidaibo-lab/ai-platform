/** 统一产研资源配置：预算、角色模板和版本路由的唯一运行时入口。 */
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { z } from 'zod';
import { resourceHash, ResourceError } from './contracts.js';

const id = z.string().min(1).max(160).regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/);
const roleSchema = z.object({
  id, cardRef: id, inputContract: id, outputContract: id,
  methodRefs: z.array(id).max(20), toolRefs: z.array(id).max(20),
  maxSteps: z.number().int().positive().max(24),
}).strict();
const budgetsSchema = z.object({
  developmentMaxCalls: z.number().int().positive().max(72), maxParallel: z.number().int().positive().max(3),
  maxDelegationsPerTask: z.number().int().nonnegative().max(3), delegationDepth: z.number().int().nonnegative().max(1),
  maxReworks: z.number().int().nonnegative().max(3), faultRetries: z.number().int().nonnegative().max(5),
}).strict();
export const runtimeResourceConfigSchema = z.object({
  schemaVersion: z.literal('mastra-resource-config.v1'), id, workflowRef: z.literal('product-development-resources-v1'),
  sourceProfile: id, modelProfile: id, budgets: budgetsSchema, roles: z.array(roleSchema).min(13).max(13),
}).strict();
export type RuntimeResourceConfig = z.infer<typeof runtimeResourceConfigSchema>;

const configuredRoleIds = [
  'product-coordinator', 'product-clarification', 'product-closure', 'product-writing',
  'context', 'architect', 'readiness', 'implementation-owner', 'implementation-member',
  'self-check', 'reviewer', 'testing', 'operations',
] as const;

/** 从固定服务端路径读取严格资源配置；缺失时返回与当前能力上限一致的内置初始配置。 */
export function loadRuntimeResourceConfig(rootDir: string, filePath?: string): RuntimeResourceConfig {
  const path = filePath ?? resolve(rootDir, 'config/workflow.runtime.json');
  if (existsSync(path)) {
    try { return runtimeResourceConfigSchema.parse(JSON.parse(readFileSync(path, 'utf8'))); }
    catch { throw new ResourceError('CONFIG_INVALID'); }
  }
  const roles = [
    ['product-coordinator', 24], ['product-clarification', 24], ['product-closure', 24], ['product-writing', 24],
    ['context', 12], ['architect', 12], ['readiness', 12], ['implementation-owner', 12], ['implementation-member', 12],
    ['self-check', 12], ['reviewer', 12], ['testing', 1], ['operations', 1],
  ].map(([name, maxSteps]) => ({ id: String(name), cardRef: `${name}.card.v1`, inputContract: `${name}.input.v1`, outputContract: `${name}.output.v1`, methodRefs: [], toolRefs: [], maxSteps: Number(maxSteps) }));
  return runtimeResourceConfigSchema.parse({ schemaVersion: 'mastra-resource-config.v1', id: 'hrm-native-v1', workflowRef: 'product-development-resources-v1', sourceProfile: 'hrm-sources.v1', modelProfile: 'default-model.v1', budgets: { developmentMaxCalls: 72, maxParallel: 3, maxDelegationsPerTask: 3, delegationDepth: 1, maxReworks: 1, faultRetries: 1 }, roles });
}

/** 验证角色集合与宿主代码职责一致，并返回不可变配置摘要。 */
export function validateRuntimeResourceConfig(config: RuntimeResourceConfig): RuntimeResourceConfig {
  const ids = config.roles.map(role => role.id);
  if (new Set(ids).size !== ids.length || ids.length !== configuredRoleIds.length || configuredRoleIds.some(id => !ids.includes(id))) throw new ResourceError('ROLE_SET_INVALID');
  if (config.budgets.maxDelegationsPerTask > 0 && config.budgets.delegationDepth === 0) throw new ResourceError('BUDGET_INVALID');
  return Object.freeze({ ...config, roles: config.roles.map(role => Object.freeze({ ...role })) }) as RuntimeResourceConfig;
}

/** 从已冻结配置读取角色步骤上限；未知职责关闭而非回退为当前代码默认值。 */
export function roleResource(config: RuntimeResourceConfig, id: typeof configuredRoleIds[number]) {
  const role = config.roles.find(item => item.id === id);
  if (!role) throw new ResourceError('ROLE_SET_INVALID');
  return role;
}

/** 只从已提交Run资源解析运行配置；恢复期不读取当前默认配置。 */
export function frozenRuntimeResourceConfig(raw: unknown): RuntimeResourceConfig {
  const parsed = runtimeResourceConfigSchema.safeParse(raw);
  if (!parsed.success) throw new ResourceError('FROZEN_BUNDLE_MISMATCH');
  return validateRuntimeResourceConfig(parsed.data);
}

/** 计算不包含凭据、临时路径和运行ID的业务配置摘要。 */
export function runtimeConfigHash(config: RuntimeResourceConfig): string { return resourceHash(config); }
