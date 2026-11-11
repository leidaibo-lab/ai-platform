/** 唯一角色目录；静态描述与运行内执行器分离，原生Store拥有发布版本。 */
import type { MastraCompositeStore } from '@mastra/core/storage';
import { WORKSPACE_TOOLS } from '@mastra/core/workspace';
import type { createAgents } from '../mastra/agents/index.js';
import { resolveModelId, type PracticeConfig } from '../mastra/config.js';
import { developmentRoleTemplate } from '../development/v2/agents.js';
import type { RoleV2 } from '../development/v2/contracts.js';
import { loadDevelopmentMethods } from '../development/v2/methods.js';
import { importRole, importSkill, type RoleConfig } from './native-store.js';
import { ResourceError, developmentResourceKey } from './contracts.js';

export const staticRoles = ['productCoordinatorAgent', 'productClarificationAgent', 'productClosureAgent', 'productAgent', 'testingAgent', 'operationsAgent'] as const;
export type RoleAgents = Pick<ReturnType<typeof createAgents>, typeof staticRoles[number]>;

/** 校验可插拔增强不能删掉核心工具，也不能引入宿主未登记能力。 */
export async function validateRoleTools(key: string, config: RoleConfig, agents: RoleAgents, rootDir: string) {
  let required: string[];
  if ((staticRoles as readonly string[]).includes(key)) required = Object.keys(await agents[key as typeof staticRoles[number]].listTools());
  else {
    const match = /^development-(context|architect|readiness|reviewer|frontend|backend|infrastructure|self-check)-(standard|autonomous)-(member|owner)$/.exec(key);
    if (!match) throw new ResourceError('ROLE_UNKNOWN');
    required = developmentRoleTemplate(match[1] as RoleV2, loadDevelopmentMethods(rootDir), match[2] === 'autonomous', match[3] === 'owner').tools;
  }
  const allowed = new Set([...required, 'practiceInfo']);
  for (const name of Object.keys(config.tools)) if (!allowed.has(name)) throw new ResourceError('TOOL_UNKNOWN');
  for (const name of required) if (!(name in config.tools)) throw new ResourceError('TOOL_MISSING');
}

/** 导入初始角色库存；后续发布使用原生版本，不随应用重启覆盖。 */
export async function ensureRoleCatalog(storage: MastraCompositeStore, config: PracticeConfig, agents: RoleAgents) {
  const ids: Record<string, string> = {};
  const imported = new Map<string, { id: string; pin: string }>();
  /** 同一Skill一次导入供多角色复用。 */
  async function skills(names: string[]) {
    const refs: Record<string, { pin: string }> = {};
    for (const name of names) {
      let ref = imported.get(name);
      if (!ref) { ref = await importSkill(storage, config.rootDir, name); imported.set(name, ref); }
      refs[ref.id] = { pin: ref.pin };
    }
    return refs;
  }
  /** 初始模型取宿主配置，发布后该字段由原生版本唯一拥有。 */
  function model(group?: 'product' | 'development') { return { provider: 'openai' as const, name: resolveModelId(config, group).slice('openai/'.length) }; }
  for (const key of staticRoles) {
    const agent = agents[key]; const selected = await agent.listSkills(); const refs = await skills(selected.map(/** 仅取目录身份，正文从原生发布接口导入。 */skill => skill.name));
    const workspace = await agent.getWorkspace();
    const tools = Object.fromEntries(Object.keys(await agent.listTools()).map(/** 初始工具描述沿用宿主实现。 */name => [name, {}]));
    const definition: RoleConfig = { name: key, instructions: String(await agent.getInstructions()), model: model(key.startsWith('product') ? 'product' : undefined), tools, skills: refs };
    if (selected.length || workspace) definition.workspace = { type: 'inline', config: { name: key,
      ...(workspace?.filesystem ? { filesystem: { provider: 'role-sources', config: {} }, tools: { enabled: false, tools: Object.fromEntries([WORKSPACE_TOOLS.FILESYSTEM.READ_FILE, WORKSPACE_TOOLS.FILESYSTEM.LIST_FILES, WORKSPACE_TOOLS.FILESYSTEM.FILE_STAT, WORKSPACE_TOOLS.FILESYSTEM.GREP].map(/** 仅保留现有只读资料工具。 */name => [name, { enabled: true }])) } } : {}),
    } };
    ids[key] = await importRole(storage, key, definition);
  }
  const methods = loadDevelopmentMethods(config.rootDir);
  for (const role of ['context', 'architect', 'readiness', 'reviewer', 'frontend', 'backend', 'infrastructure', 'self-check'] as const) {
    for (const autonomy of [false, true]) for (const parent of ['frontend', 'backend', 'infrastructure'].includes(role) ? [false, true] : [false]) {
      const key = developmentResourceKey(role, autonomy, parent); const template = developmentRoleTemplate(role, methods, autonomy, parent);
      const refs = await skills(template.skill ? [template.skill.name] : []);
      ids[key] = await importRole(storage, key, { name: key, instructions: template.instructions, model: model('development'), tools: Object.fromEntries(template.tools.map(/** 只引用执行期可注入的受限工具。 */name => [name, {}])), skills: refs,
        ...(template.skill ? { workspace: { type: 'inline', config: { name: key } } } : {}),
      });
    }
  }
  return ids;
}
