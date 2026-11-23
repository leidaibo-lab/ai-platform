import { methodPrompt } from '../team-methods.js';
import type { TeamMethods } from '../team-method-contracts.js';
import { createNativeMemory } from '../context-memory.js';
import { Agent, type AgentExecutionOptionsBase } from '@mastra/core/agent';
import { resolveModelId, type PracticeConfig } from '../config.js';
import { practiceInfoTool } from '../tools/practice-info.js';
import { createFixtureModel } from './fixture-model.js';
import { resolve } from 'node:path';
import { loadGovernedSkill, loadProductSkillSelection, PRODUCT_MAX_STEPS } from '../skills.js';
import { productManagerProfile, productReviewerProfile, type ProductAgentRole } from './product-roles.js';
import type { AnyWorkspace } from '@mastra/core/workspace';
import type { ToolsInput } from '@mastra/core/agent';
import { createRecruitmentWorkspace } from '../project-workspaces.js';
import { createSkill, validateSkillContent } from '@mastra/core/skills';
import { validateNacosSnapshot, type NacosSnapshot } from '../nacos-resources.js';
import type { MastraCompositeStore } from '@mastra/core/storage';
import type { Mastra } from '@mastra/core';

const instructions = {
  product: methodPrompt('mastra.agents.index.5', undefined),
  testing: methodPrompt('mastra.agents.index.1', undefined),
};

/** 方法内容不授予额外工具权限，所有角色遵循同一事实与人工决定边界。 */
const productBoundaries = methodPrompt('mastra.agents.index.2', undefined);

/** 仅供内部评测装配，不暴露为 HTTP 配置；默认保留正式产品能力。 */
export interface ProductAgentOptions {
  methods?: TeamMethods;
  skillsEnabled?: boolean;
  workspace?: AnyWorkspace | false;
  workspaceTools?: ToolsInput;
  execution?: (role: ProductAgentRole) => Pick<AgentExecutionOptionsBase<unknown>, 'modelSettings' | 'onStepFinish'>;
  resources?: NacosSnapshot;
  storage?: MastraCompositeStore;
  mastra?: Mastra;
}

/** 工厂只组合框架原生 Agent；fixture/live 的变化位于模型边界。 */
export function createAgents(config: PracticeConfig, options: ProductAgentOptions = {}) {
  const methods = options.methods ?? options.resources?.methods;
  const productTask = methodPrompt('product.task-boundary', methods).replace('{{maxSteps}}', String(PRODUCT_MAX_STEPS));
  const workspace = options.workspace === false ? undefined : options.workspace ?? createRecruitmentWorkspace(config.rootDir);
  const workspaceInstructions = workspace ? methodPrompt('mastra.agents.index.3', options.methods ?? options.resources?.methods) : '';
  const localSelection = options.resources ? undefined : loadProductSkillSelection(resolve(config.rootDir, 'nacos-resources/product'));
  const productSkills = localSelection?.skills ?? [];
  const availableProductSkills = new Set(
    // 装配时验证优先方法名称，避免上游迁移后提示仍指向不存在的 Skill。
    productSkills.map((skill) => skill.name),
  );
  if (localSelection) {
    for (const name of productManagerProfile.preferredSkills) {
      if (!availableProductSkills.has(name)) throw new Error(`产品经理的优先 Skill 未注册：${name}`);
    }
    for (const name of productReviewerProfile.preferredSkills) {
      if (!localSelection.reviewerSkills.includes(name)) throw new Error(`独立产品审查的优先 Skill 未注册：${name}`);
    }
  }
  /** 为各 Agent 选择官方测试模型或原生 OpenAI-compatible 模型配置。 */
  function model(stage: string) {
    if (config.mode === 'fixture') return createFixtureModel(stage);
    return { id: resolveModelId(config, stage === 'product' || stage.startsWith('product-') ? 'product' : stage === 'development' ? 'development' : stage === 'testing' || stage.startsWith('testing-') ? 'testing' : undefined), apiKey: config.apiKey, ...(config.baseUrl ? { url: config.baseUrl } : {}) };
  }
  /** 创建统一产品经理/独立产品审查 Agent；同一逻辑 Agent 可被多个 Workflow 阶段复用。 */
  function specializedProductAgent(profile: typeof productManagerProfile | typeof productReviewerProfile, id: string, stage: string, resources?: NacosSnapshot) {
    const frozen = resources ?? options.resources ? validateNacosSnapshot(resources ?? options.resources) : undefined;
    const externalSkills = frozen ? [frozen.skill, ...(frozen.additionalSkills ?? [])].filter(/** 审查绑定缺省保持旧快照共享行为。 */skill => id !== 'product-reviewer-agent' || !frozen.reviewerSkills || frozen.reviewerSkills.includes(skill.name)).map(/** 冻结方法只以 Mastra 原生 Skill 装配。 */skill => {
      const definition = validateSkillContent({ content: skill.content });
      if (!definition.metadata || !definition.instructions) throw new Error('冻结的 Nacos Skill 无效');
      return createSkill({ name: String(definition.metadata.name), description: String(definition.metadata.description), instructions: definition.instructions, references: skill.references });
    }) : [];
    return new Agent({
      id,
      ...(options.mastra ? { mastra: options.mastra } : {}),
      name: profile.name,
      instructions: frozen ? `当前角色：${profile.name}。${productTask}按当前任务需要可调用已注册的版本化 Skill。角色方法：${id === 'product-reviewer-agent' ? (frozen.reviewerPrompt ?? frozen.prompt).content : frozen.prompt.content}\n${methodPrompt('mastra.agents.index.2', methods)}${workspaceInstructions}` : `${profile.instructions}${productTask}${instructions.product}当前任务优先方法：${profile.preferredSkills.join('、')}。${productBoundaries}${workspaceInstructions}`,
      model: model(stage),
      ...(config.mode === 'live' ? { memory: createNativeMemory(model('product'), options.storage, methods) } : {}),
      ...(workspace ? { workspace } : {}),
      ...(options.skillsEnabled === false ? {} : { skills: frozen ? externalSkills : id === 'product-reviewer-agent' ? productSkills.filter(/** 独立审查只接收清单绑定。 */skill => localSelection?.reviewerSkills.includes(skill.name)) : productSkills }),
      tools: options.workspaceTools,
      defaultOptions: { ...options.execution?.(id === 'product-manager-agent' ? 'product-manager' : 'product-reviewer'), maxSteps: PRODUCT_MAX_STEPS },
    });
  }
  /** 创建单一职责的交接 Agent，生成内容仍需人工负责确认。 */
  function stageAgent(stage: 'testing') {
    return new Agent({
      id: `${stage}-agent`, name: `${stage} 交接助手`,
      instructions: methodPrompt('mastra.agents.index.1', methods), model: model(stage === 'testing' && options.workspaceTools ? 'testing-workspace' : stage),
      ...(config.mode === 'live' ? { memory: createNativeMemory(model(stage), options.storage, methods) } : {}),
      tools: options.workspaceTools,
    });
  }
  /** Studio 使用受治理方法和独立会话，不装配项目工作区或执行工具。 */
  function developmentChatAgent(id: string, name: string, responsibility: string, skillPaths: string[]) {
    return new Agent({
      id, name, model: model('development'),
      instructions: `你是${name}。${responsibility}只依据用户在对话中提供的材料工作，缺少必要上下文时明确说明。按任务使用已绑定的只读 Skill。区分已确认事实、技术建议和待决业务规则；待决规则不得写成已批准验收或确定行为。代码和补丁仅为建议；不得声称读取了仓库、修改了文件、运行了检查，或获得了审批与交付结果。`,
      memory: createNativeMemory(model('development'), options.storage, methods),
      skills: skillPaths.map(path => loadGovernedSkill(resolve(config.rootDir, '.agents/skills'), path)),
      defaultOptions: { maxSteps: PRODUCT_MAX_STEPS },
    });
  }
  return {
    minimalAgent: new Agent({
      id: 'minimal-agent', name: 'Mastra 原生最小助手',
      instructions: methodPrompt('mastra.agents.index.7', options.methods ?? options.resources?.methods),
      model: model('minimal'), tools: { practiceInfo: practiceInfoTool },
    }),
    readingAgent: new Agent({
      id: 'reading-agent', name: '产品文档阅读助手', model: model('reading'),
      instructions: methodPrompt('mastra.agents.index.4', options.methods ?? options.resources?.methods),
    }),
    testingAgent: stageAgent('testing'),
    developmentLeadAgent: developmentChatAgent('studio-development-lead-agent', '研发负责人 Agent', '分析需求、设计技术方案、拆分任务并指出待决问题。', ['development/architecture-document', 'development/bmad-task-handoff', 'development/gstack-engineering-review']),
    developmentImplementerAgent: developmentChatAgent('studio-development-implementer-agent', '研发实施 Agent', '根据提供的任务和代码给出实现或补丁建议。', ['development/implementation-handoff', 'development/gstack-engineering-review']),
    developmentReviewerAgent: developmentChatAgent('studio-development-reviewer-agent', '研发审查 Agent', '独立审查提供的方案、代码或差异，说明问题、依据和验证建议。', ['development/bmad-code-review', 'development/gstack-code-review']),
    productManagerAgent: specializedProductAgent(productManagerProfile, 'product-manager-agent', 'product-manager'),
    productReviewerAgent: specializedProductAgent(productReviewerProfile, 'product-reviewer-agent', 'product-reviewer'),
  };
}
