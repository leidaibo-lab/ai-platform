/** 隔离真实模型验收：冻结 Nacos 方法，检查产品和测试角色实际输出，不批准或发布业务产物。 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { LibSQLStore } from '@mastra/libsql';
import { readConfig } from '../src/mastra/config.js';
import { loadNacosSnapshot, verifyNacosAccess } from '../src/mastra/nacos-resources.js';
import { assertCompleteMethods, methodPrompt } from '../src/mastra/team-methods.js';
import { createAgents } from '../src/mastra/agents/index.js';
import { nativeInvocationMemory } from '../src/mastra/context-memory.js';

const directory = resolve('.data/evaluations/team-method-live-20261122');
mkdirSync(directory, { recursive: false, mode: 0o700 });
process.env.MASTRA_MODE = 'live';
process.env.MASTRA_DATA_DIR = directory;
process.env.NACOS_TEAM_METHOD_VERSION = '1.0.0';
const config = readConfig();
const storage = new LibSQLStore({ id: 'team-method-live-eval', url: config.databaseUrl });
/** 每阶段落盘已完成证据，异常只写固定错误，避免泄露凭据。 */
const report: any = { version: 'team-method-live-eval.v1', startedAt: new Date().toISOString(), scope: '合成需求、独立模型调用；无业务批准、Git 推送和部署', status: 'running', stages: [] };
/** 保留阶段结果，不输出远程异常及敏感配置。 */
function save() { writeFileSync(resolve(directory, 'report.json'), JSON.stringify(report, null, 2) + '\n', { mode: 0o600 }); }
save();
try {
  await storage.init();
  if (!config.nacosResources) throw new Error('Nacos 未启用');
  const snapshot = await loadNacosSnapshot(config.nacosResources);
  if (!snapshot.methods) throw new Error('缺少团队方法目录');
  const methods = assertCompleteMethods(snapshot.methods);
  report.catalog = { source: snapshot.source, namespace: snapshot.namespace, hash: methods.sha256, prompts: Object.keys(methods.prompts).length, skills: Object.keys(methods.skills).length };
  const agents = createAgents(config, { resources: snapshot, storage, workspace: false });
  const prompt = '合成需求：为工单系统设计标题校验：仅接受字符串，去除首尾空白后按 Unicode 码点计数，长度 1–80（含边界）有效；非字符串返回 TYPE，空或超长返回 LENGTH。只做校验，不涉及数据库、网络和权限。请依据已绑定方法列出业务规则、正常/边界/异常验收及未确认项；不要声称已审批或执行测试。请实际调用需求对齐 Skill 并读取其 references/delivery-writing.md。';
  for (const stage of ['product', 'testing'] as const) {
    await verifyNacosAccess(config.nacosResources, snapshot);
    const agent = stage === 'product' ? agents.productManagerAgent : agents.testingAgent;
    const input = stage === 'product' ? prompt : JSON.stringify({ task: 'independent-test-plan', product: prompt, candidate: '尚无实现和实际执行证据', instruction: methodPrompt('delivery.testing.1', methods) });
    const result = await agent.generate(input, { memory: nativeInvocationMemory(), maxSteps: stage === 'product' ? 16 : 8, modelSettings: { maxOutputTokens: 4000, maxRetries: 0, timeout: { totalMs: 240000, stepMs: 120000 } } });
    const tools = result.toolResults.map(item => item.payload.toolName);
    report.stages.push({ stage, finishReason: result.finishReason, text: result.text, tools, steps: result.steps.length, usage: result.usage });
    save(); console.log(JSON.stringify({ stage, finishReason: result.finishReason, tools, textChars: result.text.length }));
    if (result.error || result.finishReason !== 'stop' || !result.text.trim()) throw new Error('模型阶段未完成');
  }
  report.status = 'completed-awaiting-review'; report.endedAt = new Date().toISOString(); save();
} catch {
  report.status = 'failed'; report.error = '资源校验或模型调用未完成，请结合已保存阶段证据检查'; report.endedAt = new Date().toISOString(); save(); process.exitCode = 1;
} finally { await storage.close(); }
