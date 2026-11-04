import { Agent } from '@mastra/core/agent';
import { createSkill, validateSkillContent } from '@mastra/core/skills';
import { z } from 'zod';
import type { PracticeConfig } from '../config.js';
import { practiceInfoTool } from '../tools/practice-info.js';
import { createFixtureModel } from './fixture-model.js';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const instructions = {
  product: '你负责将业务需求整理为产品交接稿。依据输入和已确认事实工作，不把建议或假设写成规则。输出需求目标、范围、非目标、规则和可检查的验收条件；指出会改变实现或验收结果的未决问题。交付前必须调用 product-requirements-handoff Skill 并遵循其检查方法。不要声称需求已经过人工批准。',
  development: '你负责将已确认需求整理为可审查的实现提案。交付前必须调用 development-implementation-handoff Skill 并遵循其检查方法。逐条映射验收条件到实现行为和验证方法，区分事实、建议、假设及待确认项。仅在输入证据支持时给出文件路径和项目命令；不得编造仓库事实。当前没有代码执行工具，只能输出提案，禁止声称已修改代码、运行检查或通过质量审查。',
  testing: '你负责测试交接。依据需求和代码提案输出需求—用例映射、正常/边界/异常用例及执行命令。没有测试执行结果，禁止声称测试已通过。',
  operations: '你负责部署方案。依据已确认交接物输出环境前提、版本/制品要求、发布步骤、健康检查、回滚与中止条件。未知项必须标明，禁止声称已发布。',
};

/** 工厂只组合框架原生 Agent；fixture/live 的变化位于模型边界。 */
export function createAgents(config: PracticeConfig) {
  /** 从仓库治理目录解析可复用方法，并以 Mastra 原生 Skill 注册。 */
  function loadSkill(relativePath: string) {
    const skillPath = resolve(config.rootDir, '../../.agents/skills', relativePath, 'SKILL.md');
    const skillDefinition = validateSkillContent({ content: readFileSync(skillPath, 'utf8') });
    if (!skillDefinition.valid || !skillDefinition.metadata || !skillDefinition.instructions) {
      throw new Error(`Agent Skill 无效：${skillDefinition.errors.join('；')}`);
    }
    return createSkill({
      name: z.string().parse(skillDefinition.metadata.name),
      description: z.string().parse(skillDefinition.metadata.description),
      instructions: skillDefinition.instructions,
    });
  }
  const productSkill = loadSkill('product/requirements-handoff');
  const developmentSkill = loadSkill('development/implementation-handoff');
  /** 为各 Agent 选择官方测试模型或原生 OpenAI-compatible 模型配置。 */
  function model(stage: string) {
    if (config.mode === 'fixture') return createFixtureModel(stage);
    return { id: config.modelId, apiKey: config.apiKey, ...(config.baseUrl ? { url: config.baseUrl } : {}) };
  }
  /** 创建单一职责的交接 Agent，生成内容仍需人工负责确认。 */
  function stageAgent(stage: keyof typeof instructions) {
    return new Agent({
      id: `${stage}-agent`, name: `${stage} 交接助手`, instructions: instructions[stage], model: model(stage),
      ...(stage === 'product' ? { skills: [productSkill] } : stage === 'development' ? { skills: [developmentSkill] } : {}),
    });
  }
  return {
    minimalAgent: new Agent({
      id: 'minimal-agent', name: 'Mastra 原生最小助手',
      instructions: '先调用 practiceInfo 工具，简要说明当前实践范围。明确尚未执行部署。',
      model: model('minimal'), tools: { practiceInfo: practiceInfoTool },
    }),
    productAgent: stageAgent('product'), developmentAgent: stageAgent('development'),
    testingAgent: stageAgent('testing'), operationsAgent: stageAgent('operations'),
  };
}
