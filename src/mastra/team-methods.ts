/** 统一方法消费入口；本地仅是离线/历史源，远端快照存在时禁止回退。 */
import prompts from '../../nacos-resources/teams/prompts.json' with { type: 'json' };
import { createSkill, validateSkillContent } from '@mastra/core/skills';
import { methodBindingsSchema, type TeamMethods } from './team-method-contracts.js';
import { validateTeamMethods } from './nacos-resources.js';

export const teamPromptSources: Record<string, { name: string; content: string; source: string }> = prompts;
const source = teamPromptSources;
export const teamSkillSources = {
  context: { path: 'development/bmad-context', name: 'development-bmad-context' },
  task: { path: 'development/bmad-task-handoff', name: 'development-bmad-task-handoff' },
  readiness: { path: 'development/bmad-readiness', name: 'development-bmad-readiness' },
  architectureDocument: { path: 'development/architecture-document', name: 'development-architecture-document' },
  review: { path: 'development/bmad-code-review', name: 'development-bmad-code-review' },
  browser: { path: 'testing/gstack-browser-qa', name: 'testing-gstack-browser-qa' },
} as const;

/** 发布版本由配置明确选择，不查询 latest。 */
export function defaultMethodBindings(version: string) {
  return methodBindingsSchema.parse({ prompts: Object.fromEntries(Object.entries(source).map(([key, value]) => [key, { name: value.name, version }])), skills: Object.fromEntries(Object.entries(teamSkillSources).map(([key, value]) => [key, { name: value.name, version }])) });
}

/** 初始化必须具有全部宿主登记的方法槽位，防止部分迁移冒充全团队。 */
export function assertCompleteMethods(methods: TeamMethods): TeamMethods {
  const frozen = validateTeamMethods(methods);
  for (const key of Object.keys(source)) if (!frozen.prompts[key]) throw new Error(`缺少团队 Prompt 绑定：${key}`);
  for (const [key, skill] of Object.entries(teamSkillSources)) if (frozen.skills[key]?.name !== skill.name) throw new Error(`缺少或错误的团队 Skill 绑定：${key}`);
  if (Object.keys(frozen.prompts).length !== Object.keys(source).length || Object.keys(frozen.skills).length !== Object.keys(teamSkillSources).length) throw new Error('团队方法包含未知绑定');
  return frozen;
}

/** 只返回本次任务所需正文，不把整个目录注入模型。 */
export function methodPrompt(key: string, methods?: TeamMethods): string {
  if (!source[key]) throw new Error(`未知方法槽位：${key}`);
  if (!methods) return source[key].content;
  const resource = methods.prompts[key];
  if (!resource) throw new Error(`冻结目录缺少方法：${key}`);
  return resource.content;
}

/** 将可信宿主选择的冻结 Skill 装配为 Mastra 原生方法。 */
export function methodSkill(methods: TeamMethods, key: keyof typeof teamSkillSources) {
  const resource = methods.skills[key];
  if (!resource || resource.name !== teamSkillSources[key].name) throw new Error('冻结目录缺少登记 Skill');
  const definition = validateSkillContent({ content: resource.content });
  if (!definition.valid || !definition.instructions || definition.metadata?.name !== resource.name) throw new Error('冻结 Skill 无效');
  return createSkill({ name: resource.name, description: String(definition.metadata.description), instructions: definition.instructions, references: resource.references });
}
