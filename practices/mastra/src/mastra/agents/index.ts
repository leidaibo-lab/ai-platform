import { Agent } from '@mastra/core/agent';
import type { PracticeConfig } from '../config.js';
import { practiceInfoTool } from '../tools/practice-info.js';
import { createFixtureModel } from './fixture-model.js';

const instructions = {
  product: '你负责产品交接。输出需求、范围、非目标和可检查验收条件。明确未知条件，不编造已确认政策。',
  development: '你负责开发提案。依据已确认需求输出代码提案、文件路径、质量检查命令和风险。没有执行环境，只能输出提案，禁止声称已修改代码或检查通过。',
  testing: '你负责测试交接。依据需求和代码提案输出需求—用例映射、正常/边界/异常用例及执行命令。没有测试执行结果，禁止声称测试已通过。',
  operations: '你负责部署方案。依据已确认交接物输出环境前提、版本/制品要求、发布步骤、健康检查、回滚与中止条件。未知项必须标明，禁止声称已发布。',
};

/** 工厂只组合框架原生 Agent；fixture/live 的变化位于模型边界。 */
export function createAgents(config: PracticeConfig) {
  /** 为各 Agent 选择官方测试模型或原生 OpenAI-compatible 模型配置。 */
  function model(stage: string) {
    if (config.mode === 'fixture') return createFixtureModel(stage);
    return { id: config.modelId, apiKey: config.apiKey, ...(config.baseUrl ? { url: config.baseUrl } : {}) };
  }
  /** 创建单一职责的交接 Agent，生成内容仍需人工负责确认。 */
  function stageAgent(stage: keyof typeof instructions) {
    return new Agent({ id: `${stage}-agent`, name: `${stage} 交接助手`, instructions: instructions[stage], model: model(stage) });
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
