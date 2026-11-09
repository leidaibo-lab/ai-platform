/** 使用真实 Mastra 循环验证有界收束；模型脚本只模拟持续读资料。 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Agent } from '@mastra/core/agent';
import { createTool } from '@mastra/core/tools';
import { MastraLanguageModelV2Mock } from '@mastra/core/test-utils/llm-mock';
import { noopLogger } from '@mastra/core/logger';
import { z } from 'zod';
import { developmentMaxSteps, developmentPrepareStep } from '../src/development/v2/generation-policy.js';
import { diagnoseModelResult } from '../src/development/v2/model-diagnostic.js';

test('原生循环达到12步仍为工具调用时保存结束原因，不误报超时', /** 复现旧调用在工具循环结束时没有最终答案的行为。 */async () => {
  let reads = 0;
  const agent = new Agent({ id: 'unbounded-reading', name: 'read probe', instructions: '只验证步骤上限',
    tools: { read: createTool({ id: 'read', description: '固定只读工具', inputSchema: z.object({}),
      /** 工具执行次数来自框架真实执行。 */
      execute: async () => ({ read: ++reads }),
    }) }, model: new MastraLanguageModelV2Mock({
      /** 持续请求资料，以确定性方式复现 maxSteps 结束。 */
      doGenerate: async () => ({ content: [{ type: 'tool-call', toolCallId: `read-${reads}`, toolName: 'read', input: '{}' }], finishReason: 'tool-calls', usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 }, warnings: [] }),
    }),
  });
  agent.__setLogger(noopLogger);
  const result = await agent.generate('读取', { maxSteps: developmentMaxSteps });
  assert.equal(reads, 12); assert.equal(result.finishReason, 'tool-calls');
  assert.deepEqual(diagnoseModelResult(result, developmentMaxSteps), { source: 'tool-step-limit', finishReason: 'tool-calls', steps: 12, maxSteps: 12 });
});

test('只读角色最后一步通过原生toolChoice收束，缺口仍进入结果', /** 不增加 maxSteps，不裁剪工具历史，也不把未读资料补成事实。 */async () => {
  let reads = 0; let calls = 0;
  const agent = new Agent({ id: 'bounded-reading', name: 'read probe', instructions: '只验证最后一步',
    tools: { read: createTool({ id: 'read', description: '固定只读工具', inputSchema: z.object({}),
      /** 记录实际工具执行，不依赖模型声明。 */
      execute: async () => ({ read: ++reads }),
    }) }, model: new MastraLanguageModelV2Mock({
      /** 工具仍开放时持续请求；宿主关闭工具后才输出明确未核实范围。 */
      doGenerate: async (options) => {
        calls++;
        const final = options.toolChoice?.type === 'none';
        if (final) assert.match(JSON.stringify(options.prompt), /未读取范围|unknowns/);
        return { content: final ? [{ type: 'text' as const, text: '{"rules":[],"unknowns":["剩余资料未核实"]}' }] : [{ type: 'tool-call' as const, toolCallId: `read-${calls}`, toolName: 'read', input: '{}' }], finishReason: final ? 'stop' as const : 'tool-calls' as const, usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 }, warnings: [] };
      },
    }),
  });
  agent.__setLogger(noopLogger);
  const result = await agent.generate('读取', { maxSteps: developmentMaxSteps, prepareStep: developmentPrepareStep('context') });
  assert.equal(calls, 12); assert.equal(reads, 11); assert.equal(result.finishReason, 'stop'); assert.match(result.text, /剩余资料未核实/);
  assert.equal(result.toolResults.length, 11);
});
