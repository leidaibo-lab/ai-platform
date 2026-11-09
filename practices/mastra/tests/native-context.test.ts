/** 原生观察记忆确定性回归；不使用真实模型，不将脚本摘要视为业务质量验收。 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Agent } from '@mastra/core/agent';
import { createTool } from '@mastra/core/tools';
import { MastraLanguageModelV2Mock } from '@mastra/core/test-utils/llm-mock';
import { LibSQLStore } from '@mastra/libsql';
import { noopLogger } from '@mastra/core/logger';
import { z } from 'zod';
import { createNativeMemory, nativeInvocationMemory } from '../src/mastra/context-memory.js';

/** 返回原生 Mock 模型的完整输出；摘要正文由 fixture 明确提供。 */
function output(text: string) {
  return { content: [{ type: 'text' as const, text }], finishReason: 'stop' as const, usage: { inputTokens: 10, outputTokens: 20, totalTokens: 30 }, warnings: [] };
}

test('原生OM实际压缩工具历史并隔离调用线程，原始资料仍保存在Store', /** 低于门槛不触发观察，工具结果跨阈值后下一步模型收到观察而非巨大正文。 */async () => {
  const storage = new LibSQLStore({ id: 'native-context-test', url: 'file::memory:' });
  let observations = 0;
  const observer = new MastraLanguageModelV2Mock({
    /** 原生观察器调用脚本模型，保留来源与尚未批准事实。 */
    doGenerate: async () => { observations++; return output('<observations>\nDate: 2026-11-09\n* 🔴 资料 material-1 原文规定审批不可跳过；尚未批准。\n</observations>\n<current-task>继续核实材料</current-task>'); },
    /** Observer 使用原生流式调用；与同步fixture返回相同摘要。 */
    doStream: async () => {
      observations++;
      return { stream: new ReadableStream({
        /** 模拟 provider 协议，压缩与持久化由原生处理器执行。 */
        start(controller) {
          controller.enqueue({ type: 'stream-start', warnings: [] });
          controller.enqueue({ type: 'text-start', id: 'observation' });
          controller.enqueue({ type: 'text-delta', id: 'observation', delta: '<observations>\nDate: 2026-11-09\n* 🔴 资料 material-1 原文规定审批不可跳过；尚未批准。\n</observations>\n<current-task>继续核实材料</current-task>' });
          controller.enqueue({ type: 'text-end', id: 'observation' });
          controller.enqueue({ type: 'finish', finishReason: 'stop', usage: { inputTokens: 10, outputTokens: 20, totalTokens: 30 } });
          controller.close();
        },
      }) };
    },
  });
  const memory = createNativeMemory(observer, storage);
  const prompts: string[] = [];
  let calls = 0;
  const actor = new MastraLanguageModelV2Mock({
    /** 首步读取资料，后续仅验证经过原生处理器后的请求。 */
    doGenerate: async ({ prompt }) => {
      prompts.push(JSON.stringify(prompt));
      if (++calls <= 3) return { content: [{ type: 'tool-call' as const, toolCallId: `read-${calls}`, toolName: 'read', input: '{}' }], finishReason: 'tool-calls' as const, usage: { inputTokens: 10, outputTokens: 10, totalTokens: 20 }, warnings: [] };
      return output('已核实资料；等待人工批准。');
    },
  });
  const raw = 'UNIQUE_RAW_MATERIAL ' + '业务事实及验收条件 '.repeat(16000);
  const read = createTool({ id: 'read', description: '读取合成材料', inputSchema: z.object({}),
    /** 合成一次超阈值工具结果，覆盖OM在同一次执行内的压缩。 */
    execute: async () => ({ id: `material-${calls}`, content: calls === 1 ? raw : '后续待核实内容 '.repeat(1000) }),
  });
  const agent = new Agent({ id: 'native-context-test', name: '原生上下文回归', instructions: '核实资料，不能自行批准。', model: actor, memory, tools: { read } });
  agent.__setLogger(noopLogger);
  const first = nativeInvocationMemory();
  try {
    const result = await agent.generate('读取材料并继续分析', { memory: first, maxSteps: 5 });
    assert.equal(result.finishReason, 'stop'); assert.ok(observations > 0);
    assert.match(prompts.at(-1)!, /尚未批准/);
    assert.equal(prompts.at(-1)!.includes('UNIQUE_RAW_MATERIAL'), false);
    const record = await (await storage.getStore('memory'))!.getObservationalMemory(first.thread, first.resource);
    assert.match(record!.activeObservations, /material-1/);
    const saved = await memory.recall({ threadId: first.thread, resourceId: first.resource });
    assert.match(JSON.stringify(saved), /UNIQUE_RAW_MATERIAL/);
    const second = nativeInvocationMemory();
    await agent.generate('另一个任务，独立开始', { memory: second, maxSteps: 1 });
    assert.equal(/material-1|UNIQUE_RAW_MATERIAL|尚未批准/.test(prompts.at(-1)!), false);
  } finally { await memory.settled(); await storage.close(); }
});

test('观察器失败中止当前执行，不把部分角色正文当成功交付', /** 原生观察失败必须传播，不能忽略压缩错误继续生成。 */async () => {
  const storage = new LibSQLStore({ id: 'native-context-failure', url: 'file::memory:' });
  const observer = new MastraLanguageModelV2Mock({
    /** 注入观察器上游错误，不访问网络。 */
    doStream: async () => { throw new Error('synthetic-observer-failure'); },
  });
  const memory = createNativeMemory(observer, storage);
  let calls = 0;
  const actor = new MastraLanguageModelV2Mock({
    /** 第一个工具结果超阈值；第二次主模型调用不能在压缩失败后执行。 */
    doGenerate: async () => {
      calls++;
      return { content: [{ type: 'tool-call' as const, toolCallId: 'read-1', toolName: 'read', input: '{}' }], finishReason: 'tool-calls' as const, usage: { inputTokens: 10, outputTokens: 10, totalTokens: 20 }, warnings: [] };
    },
  });
  const agent = new Agent({ id: 'native-context-failure', name: '观察失败回归', instructions: '只核实资料，不自行批准。', model: actor, memory, tools: {
    read: createTool({ id: 'read', description: '合成资料', inputSchema: z.object({}),
      /** 保持资料可读取，失败仅发生在框架压缩。 */
      execute: async () => ({ content: '业务事实及验收条件 '.repeat(16000) }),
    }),
  } });
  agent.__setLogger(noopLogger);
  try {
    let rejected = false;
    try {
      const result = await agent.generate('核实资料', { memory: nativeInvocationMemory(), maxSteps: 3 });
      rejected = result.finishReason !== 'stop';
    } catch { rejected = true; }
    assert.equal(rejected, true); assert.equal(calls, 1);
  } finally { await memory.settled(); await storage.close(); }
});
