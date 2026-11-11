/** 原生版本库Adapter：只导入、解析与校验，不建立第二个内容存储。
 * ADR: docs/decisions/2026-11-11-mastra-stored-role-runtime.md
 */
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { MastraCompositeStore } from '@mastra/core/storage';
import { LocalSkillSource, publishSkillFromSource, WORKSPACE_TOOLS } from '@mastra/core/workspace';
import { z } from 'zod';
import { bytesHash, resourceHash, ResourceError } from './contracts.js';

export const roleConfigSchema = z.object({
  name: z.string().min(1), instructions: z.string().min(1),
  model: z.object({ provider: z.literal('openai'), name: z.string().min(1), temperature: z.number().min(0).max(2).optional(), topP: z.number().min(0).max(1).optional(), maxCompletionTokens: z.number().int().positive().optional() }).strict(),
  tools: z.record(z.string(), z.object({ description: z.string().optional() }).strict()),
  skills: z.record(z.string(), z.object({ pin: z.string().min(1) }).strict()),
  workspace: z.object({ type: z.literal('inline'), config: z.object({ name: z.string(), filesystem: z.object({ provider: z.literal('role-sources'), config: z.object({}).strict() }).strict().optional(), tools: z.object({ enabled: z.literal(false), tools: z.record(z.string(), z.object({ enabled: z.boolean() }).strict()) }).strict().optional() }).strict() }).strict().optional(),
}).strict();
export type RoleConfig = z.infer<typeof roleConfigSchema>;

/** 原生记录中仅实体/版本元数据可额外存在；不允许条件表达式、远端工具和脚本扩张装配。 */
export function storedConfig(raw: unknown): RoleConfig {
  if (!raw || typeof raw !== 'object') throw new ResourceError('VERSION_MISSING');
  const allowed = new Set(['id', 'agentId', 'versionNumber', 'createdAt', 'updatedAt', 'status', 'activeVersionId', 'resolvedVersionId', 'visibility', 'favoriteCount', 'authorId', 'metadata', 'description', 'changeMessage']);
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (key in roleConfigSchema.shape && value !== undefined && value !== null) result[key] = value;
    else if (!allowed.has(key) && value !== undefined && value !== null) throw new ResourceError('CONFIG_UNSUPPORTED');
  }
  try { return roleConfigSchema.parse(result); } catch { throw new ResourceError('CONFIG_INVALID'); }
}

/** 使用原生Skill发布工具导入所有文件；已存在实体不因工作目录变化而覆盖发布指针。 */
export async function importSkill(storage: MastraCompositeStore, rootDir: string, name: string) {
  const domain = await storage.getStore('skills'); const blobs = await storage.getStore('blobs');
  if (!domain || !blobs) throw new ResourceError('STORE_UNAVAILABLE');
  const id = `role-skill-${name}`; const existing = await domain.getById(id);
  if (existing?.activeVersionId) return { id, pin: existing.activeVersionId };
  const split = name.indexOf('-');
  const base = name.startsWith('product-pm-') ? resolve(rootDir, '.agents/skills/product-pm') : resolve(rootDir, '../../.agents/skills', name.slice(0, split));
  const path = name.startsWith('product-pm-') ? name.slice('product-pm-'.length) : name.slice(split + 1);
  if (!/^[a-z0-9-]+$/.test(path)) throw new ResourceError('SKILL_NAME');
  const published = await publishSkillFromSource(new LocalSkillSource({ basePath: base }), path, blobs);
  if (published.snapshot.name !== name) throw new ResourceError('SKILL_NAME');
  try { await domain.create({ skill: { id, ...published.snapshot, tree: published.tree } }); }
  catch { if (!(await domain.getById(id))) throw new ResourceError('IMPORT_FAILED'); }
  const version = await domain.getLatestVersion(id); if (!version) throw new ResourceError('VERSION_MISSING');
  await domain.update({ id, status: 'published', activeVersionId: version.id });
  return { id, pin: version.id };
}

/** 创建初始角色；发布版本后由原生Store管理，启动不重新覆盖。 */
export async function importRole(storage: MastraCompositeStore, key: string, config: RoleConfig) {
  const domain = await storage.getStore('agents'); if (!domain) throw new ResourceError('STORE_UNAVAILABLE');
  const id = `role-${key}`;
  if (await domain.getById(id)) return id;
  try { await domain.create({ agent: { id, ...config } }); }
  catch { if (!(await domain.getById(id))) throw new ResourceError('IMPORT_FAILED'); }
  const version = await domain.getLatestVersion(id); if (!version) throw new ResourceError('VERSION_MISSING');
  await domain.update({ id, status: 'published', activeVersionId: version.id });
  return id;
}

/** 读取指定版本；校验Skill所有blob字节，防止有pin但内容丢失/变更。 */
export async function resolveRole(storage: MastraCompositeStore, agentId: string, versionId: string) {
  const agents = await storage.getStore('agents'); const skills = await storage.getStore('skills'); const blobs = await storage.getStore('blobs');
  if (!agents || !skills || !blobs) throw new ResourceError('STORE_UNAVAILABLE');
  const raw = await agents.getByIdResolved(agentId, { versionId });
  if (!raw || raw.resolvedVersionId !== versionId) throw new ResourceError('VERSION_MISSING');
  const config = storedConfig(raw);
  const readonlyWorkspaceTools = new Set<string>([WORKSPACE_TOOLS.FILESYSTEM.READ_FILE, WORKSPACE_TOOLS.FILESYSTEM.LIST_FILES, WORKSPACE_TOOLS.FILESYSTEM.FILE_STAT, WORKSPACE_TOOLS.FILESYSTEM.GREP]);
  for (const [name, options] of Object.entries(config.workspace?.config.tools?.tools ?? {})) {
    if (options.enabled && !readonlyWorkspaceTools.has(name)) throw new ResourceError('WORKSPACE_TOOL_FORBIDDEN');
  }
  if (Object.keys(config.skills).length && !config.workspace) throw new ResourceError('WORKSPACE_MISSING');
  const trees: Record<string, string> = {};
  const names = new Set<string>();
  for (const [id, ref] of Object.entries(config.skills)) {
    const skill = await skills.getByIdResolved(id, { versionId: ref.pin });
    if (!skill || skill.resolvedVersionId !== ref.pin) throw new ResourceError('SKILL_MISSING');
    if (names.has(skill.name)) throw new ResourceError('SKILL_DUPLICATE');
    names.add(skill.name);
    if (!skill?.tree?.entries?.['SKILL.md']) throw new ResourceError('SKILL_MISSING');
    for (const [path, node] of Object.entries(skill.tree.entries)) {
      if (path.startsWith('/') || path.split('/').includes('..')) throw new ResourceError('SKILL_PATH');
      const blob = await blobs.get(node.blobHash);
      if (!blob || bytesHash(Buffer.from(blob.content)) !== node.blobHash || Buffer.byteLength(blob.content) !== node.size) throw new ResourceError('BLOB_INTEGRITY');
    }
    trees[id] = resourceHash({ tree: skill.tree, name: skill.name, description: skill.description, instructions: skill.instructions });
  }
  return { config, hash: resourceHash({ config, trees }) };
}

/** 受控发布入口：引用必须可解析，通过后才移动原生发布指针。 */
export async function publishRole(storage: MastraCompositeStore, agentId: string, input: unknown) {
  const config = roleConfigSchema.parse(input); const domain = await storage.getStore('agents');
  if (!domain || !(await domain.getById(agentId))) throw new ResourceError('ROLE_UNKNOWN');
  const latest = await domain.getLatestVersion(agentId); const id = randomUUID();
  await domain.createVersion({ ...config, id, agentId, versionNumber: (latest?.versionNumber ?? 0) + 1 });
  await resolveRole(storage, agentId, id);
  await domain.update({ id: agentId, status: 'published', activeVersionId: id });
  return { agentId, versionId: id };
}
