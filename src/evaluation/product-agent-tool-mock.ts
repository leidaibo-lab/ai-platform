import { Mastra } from '@mastra/core';
import { LibSQLStore } from '@mastra/libsql';
import { createAgents } from '../mastra/agents/index.js';

/** 以隔离 Store 与固定模型验证产品经理 Agent 的原生工具替身；不读取真实模型配置。 */
export async function evaluateProductAgentToolMock(rootDir: string) {
  const config = { rootDir, mode: 'fixture' as const, modelId: 'openai/fixture' as const, port: 4111, databaseUrl: 'file::memory:' };
  const agents = createAgents(config, { workspace: false, skillsEnabled: false });
  const storage = new LibSQLStore({ id: 'product-agent-tool-mock-evaluation', url: ':memory:' });
  const mastra = new Mastra({ storage, agents: { productManagerAgent: agents.productManagerAgent }, logger: false });
  try {
    await storage.init();
    const dataset = await mastra.datasets.create({ id: 'product-agent-tool-mock', name: '产品经理工具替身试点' });
    await dataset.addItem({ input: '合成产品需求', toolMocks: [{ toolName: 'practiceInfo', args: {}, output: { framework: 'mock', scope: 'fixture', deploymentExecuted: false } }] });
    const result = await dataset.startExperiment({ targetType: 'agent', targetId: 'productManagerAgent', unmockedToolPolicy: 'deny' });
    const report = result.results[0]?.toolMockReport;
    return { status: result.status, failedCount: result.failedCount, persistenceFailures: result.persistenceFailures, itemCount: result.results.length, served: report?.served.map(item => item.toolName) ?? [], liveCalls: report?.liveCalls.length ?? -1, unconsumed: report?.unconsumed.length ?? -1 };
  } finally { await storage.close(); }
}
