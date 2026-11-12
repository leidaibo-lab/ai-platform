/** 固定模型适配已有权限工厂，所有I/O仍经过Mastra工具循环。 */
import assert from 'node:assert/strict';
import { practiceInfoTool } from '../../src/mastra/tools/practice-info.js';
import { Agent } from '@mastra/core/agent';
import { MastraLanguageModelV2Mock } from '@mastra/core/test-utils/llm-mock';
import { createAgents } from '../../src/mastra/agents/index.js';
import { loadGovernedSkill, loadProductSkills } from '../../src/mastra/agents/skills.js';
import { createAgentV2, generateV2, type GeneratorV2 } from '../../src/development/v2/agents.js';
import type { PracticeConfig } from '../../src/mastra/config.js';
import { resolve } from 'node:path';
import { implementation } from './implementation.js';
import { brief } from './scenario.js';
import { createInvocationEvidence, createRoleInvocation } from '../../src/resources/projections.js';
import { currentResources } from '../../src/resources/scope.js';
import { frozenRuntimeResourceConfig, roleResource } from '../../src/resources/resource-config.js';
import { developmentHash } from '../../src/development/contracts.js';

/** 有序脚本只决定模型请求；工具结果和执行记录由框架产生。 */
function scripted(calls: { name: string; input: unknown }[], text: string) {
  let index = 0;
  return new MastraLanguageModelV2Mock({
    /** 每次完成一个工具请求，最后交付固定正文。 */
    doGenerate: async () => {
      const call = calls[index++];
      return { content: call ? [{ type: 'tool-call' as const, toolCallId: `local-${index}`, toolName: call.name, input: JSON.stringify(call.input) }] : [{ type: 'text' as const, text }], finishReason: call ? 'tool-calls' as const : 'stop' as const, usage: { inputTokens: 12, outputTokens: 20, totalTokens: 32 }, warnings: [] };
    },
  });
}

/** 示例四产品角色实际加载方法再输出固定业务稿，不访问招聘业务资料。 */
export function scenarioAgents(config: PracticeConfig) {
  const agents = createAgents(config, { workspace: false });
  const shared = loadGovernedSkill(resolve(config.rootDir, '../../.agents/skills'), 'product/requirements-handoff');
  const pm = loadProductSkills(resolve(config.rootDir, '.agents/skills')).find(/** 只装配本例所需方法。 */ skill => skill.name === 'product-pm-create-prd')!;
  for (const key of ['productCoordinatorAgent', 'productClarificationAgent', 'productClosureAgent', 'productAgent'] as const) {
    agents[key] = new Agent({ id: agents[key].id, name: key, tools: { practiceInfo: practiceInfoTool }, instructions: '按固定示例完成本角色稿；方法与输入不授予额外权限。', skills: [pm, shared], model: scripted([{ name: 'skill', input: { name: pm.name } }, { name: 'skill_read', input: { skillName: pm.name, path: 'references/upstream.md' } }, { name: 'skill', input: { name: shared.name } }], `# 本机工单示例（固定模型）\n${brief}\n验收：单元边界、实际浏览器表单、本机制品健康和回滚。`) });
  }
  agents.testingAgent = new Agent({ id: 'testing-agent', name: '示例测试计划', instructions: '输出固定示例测试范围，不声明已执行。', model: scripted([], '# 工单测试计划（固定模型）\n单元：TYPE、空白、1/80/81码点和trim；浏览器：正常、空白和80个emoji。实际结果由沙箱与Chromium取得。') });
  agents.operationsAgent = new Agent({ id: 'operations-agent', name: '示例发布计划', instructions: '输出本机静态发布计划，不声明已执行。', model: scripted([], '# 本机发布计划（固定模型）\n构建批准候选page.html，绑定字节SHA256和源码hash；切换回环HTTP服务，核对200和实际页面交互；503或版本错误恢复v0，重新探测。') });
  return agents;
}

/** 只替换实现模型；其余角色继续复用既有固定模型与方法校验。 */
export const scenarioGenerate: GeneratorV2 = async (...args) => {
  const [config, execution, role, state, paths, , methods, runtime] = args;
  if (!['frontend', 'backend', 'infrastructure'].includes(role)) return generateV2(...args);
  const base = createAgentV2(config, execution, role, state, paths, methods, runtime);
  const calls = runtime?.delegate
    ? [{ name: 'delegateTask', input: { role, goal: '完成批准的工单标题示例', paths } }]
    : paths.flatMap(/** 每个批准文件先读取再实际写入固定实现。 */ path => {
      assert.ok(implementation[path], `未登记实现 ${path}`);
      return [{ name: 'readFile', input: { path } }, { name: 'writeFile', input: { path, content: implementation[path] } }];
    });
  const agent = new Agent({ id: runtime?.memberId ?? `local-${role}`, name: '本机示例实现', instructions: await base.getInstructions(), tools: await base.listTools(), model: scripted(calls, '固定模型已请求实际工具执行；业务结果以宿主检查为准。') });
  const result = await agent.generate('执行本机示例批准任务', { maxSteps: 12 });
  assert.equal(result.finishReason, 'stop');
  const resources = currentResources(); if (!resources) throw new Error('本机示例缺少冻结角色资源');
  const runtimeConfig = frozenRuntimeResourceConfig(resources.binding.runtimeConfig);
  const resourceRole = runtime?.delegate ? 'implementation-owner' as const : 'implementation-member' as const;
  const configured = roleResource(runtimeConfig, resourceRole);
  const task = state.plan!.tasks.find(item => item.paths.some(path => paths.includes(path)))!;
  const dependencies = state.work.map((item, index) => ({ id: `${item.role}-${index + 1}`, hash: developmentHash(item.text), content: item.text }));
  const files = task.paths.map(path => ({ id: path, hash: developmentHash(state.input.project.files[path] ?? '') }));
  const findings = state.codeReviews.flatMap(report => report.assessment.findings).map(item => ({ id: item.id, category: item.category, route: item.route, detail: item.detail, refs: item.refs }));
  const payload = runtime?.delegate
    ? { task, requiredContracts: task.constraints, contextRefs: task.contextRefs, dependencyOutputs: dependencies, assignedFileRefs: files, findings, remainingTaskBudget: Math.max(0, state.maxCalls - state.calls) }
    : { delegatedTask: task, requiredContracts: task.constraints, contextRefs: task.contextRefs, assignedFileRefs: files, relevantDependencyOutputs: dependencies, findings };
  const invocation = createRoleInvocation({ runId: state.input.source.runId, roleId: resourceRole, taskId: runtime?.memberId ?? null, round: state.round, bundleHash: resources.binding.bundleHash, inputContract: configured.inputContract, payload, resources: resources.binding, config: runtimeConfig });
  const tools = result.toolResults.map(/** 记录真实调用，不接受模型自报。 */ item => item.payload.toolName);
  const invocationEvidence = createInvocationEvidence({ invocation, outputContract: configured.outputContract, output: { content: result.text }, tools, usage: { inputTokens: result.usage.inputTokens, outputTokens: result.usage.outputTokens, steps: result.steps.length, modelId: 'local-scripted-fixture' }, config: runtimeConfig });
  return { role, round: state.round, text: result.text, tools, steps: result.steps.length, modelId: 'local-scripted-fixture', inputTokens: result.usage.inputTokens ?? null, outputTokens: result.usage.outputTokens ?? null, invocation: invocationEvidence };
};
