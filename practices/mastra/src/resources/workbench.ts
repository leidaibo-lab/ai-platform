/** 角色资源工作台应用服务：只投影原生版本并发布受限增强，不拥有另一份角色内容。 */
import { z } from 'zod';
import type { MastraCompositeStore } from '@mastra/core/storage';
import type { PracticeConfig } from '../mastra/config.js';
import type { RoleAgents } from './catalog.js';
import { ensureRoleCatalog, validateRoleTools } from './catalog.js';
import { publishRole, resolveRole, roleConfigSchema } from './native-store.js';
import { ResourceError } from './contracts.js';

const updateSchema = z.object({
  agentId: z.string().regex(/^role-[A-Za-z0-9-]+$/), baseVersionId: z.string().uuid(),
  instructions: z.string().trim().min(1).max(50000),
  model: z.object({ name: z.string().trim().min(1).max(200), temperature: z.number().min(0).max(2).optional(), topP: z.number().min(0).max(1).optional(), maxCompletionTokens: z.number().int().positive().max(32000).optional() }).strict(),
  tools: z.array(z.string().regex(/^[a-zA-Z][a-zA-Z0-9_-]{0,100}$/)).max(32),
}).strict();
export type RoleWorkbenchUpdate = z.infer<typeof updateSchema>;

/** 返回给页面的只读投影不含Skill正文、blob、凭据、来源路径或原始Store实体。 */
export async function listRoleWorkbench(storage: MastraCompositeStore, config: PracticeConfig, agents: RoleAgents) {
  const ids = await ensureRoleCatalog(storage, config, agents);
  const domain = await storage.getStore('agents');
  if (!domain) throw new ResourceError('STORE_UNAVAILABLE');
  const roles = [];
  for (const [key, agentId] of Object.entries(ids).sort(([left], [right]) => left.localeCompare(right))) {
    const entity = await domain.getById(agentId);
    if (!entity?.activeVersionId) throw new ResourceError('NOT_PUBLISHED');
    const version = await domain.getVersion(entity.activeVersionId);
    const resolved = await resolveRole(storage, agentId, entity.activeVersionId);
    roles.push({ key, agentId, versionId: entity.activeVersionId, versionNumber: version?.versionNumber ?? null, instructions: resolved.config.instructions, model: resolved.config.model, tools: Object.keys(resolved.config.tools).sort(), skillPins: Object.entries(resolved.config.skills).map(([skillId, value]) => ({ skillId, versionId: value.pin })).sort((left, right) => left.skillId.localeCompare(right.skillId)), configHash: resolved.hash });
  }
  return { roles };
}

/** 基于当前发布版本创建下一原生Agent版本；页面不能改Workspace、Skill pin、工具实现或部署信任根。 */
export async function publishRoleWorkbench(storage: MastraCompositeStore, config: PracticeConfig, agents: RoleAgents, raw: unknown) {
  const input = updateSchema.parse(raw);
  const domain = await storage.getStore('agents');
  if (!domain) throw new ResourceError('STORE_UNAVAILABLE');
  const entity = await domain.getById(input.agentId);
  if (!entity?.activeVersionId) throw new ResourceError('ROLE_UNKNOWN');
  if (entity.activeVersionId !== input.baseVersionId) throw new ResourceError('VERSION_CONFLICT');
  const current = await resolveRole(storage, input.agentId, input.baseVersionId);
  const candidate = roleConfigSchema.parse({ ...current.config, instructions: input.instructions, model: { provider: 'openai', ...input.model }, tools: Object.fromEntries(input.tools.map(name => [name, current.config.tools[name] ?? {}])) });
  await validateRoleTools(input.agentId.slice('role-'.length), candidate, agents, config.rootDir);
  const published = await publishRole(storage, input.agentId, candidate);
  return { ...published, configHash: (await resolveRole(storage, published.agentId, published.versionId)).hash };
}
