/** 使用固定测试模型驱动 Mastra 原生 MCP 工具调用；不访问业务服务。 */
import assert from 'node:assert/strict';
import { MCPClient } from '@mastra/mcp';
import { Agent } from '@mastra/core/agent';
import { MastraLanguageModelV2Mock } from '@mastra/core/test-utils/llm-mock';
import { fileURLToPath } from 'node:url';

const client = new MCPClient({ id: 'nacos-poc', servers: { fixture: { command: process.execPath, args: [fileURLToPath(new URL('./mcp-server.mjs', import.meta.url))] } } });
try {
  const tools = await client.listTools();
  assert.ok(tools.fixture_lookup, 'MCP 工具未被发现');
  let calls = 0;
  const model = new MastraLanguageModelV2Mock({
    /** 首轮触发工具，次轮生成终答。 */
    doGenerate: async () => ({ content: calls++ === 0 ? [{ type: 'tool-call', toolCallId: 'poc-1', toolName: 'fixture_lookup', input: JSON.stringify({ key: 'alpha' }) }] : [{ type: 'text', text: 'done' }], finishReason: calls === 1 ? 'tool-calls' : 'stop', usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 }, warnings: [] }),
  });
  const agent = new Agent({ id: 'nacos-poc-agent', name: 'PoC', instructions: '调用测试工具。', model, tools });
  const result = await agent.generate('读取 alpha', { maxSteps: 3 });
  assert.match(JSON.stringify(result.toolResults), /fixture:alpha/);
  console.log('PASS: MCP 工具发现、Mastra Agent 调用及真实工具结果');
} finally {
  await client.disconnect();
}
