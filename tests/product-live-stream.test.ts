import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Mastra } from '@mastra/core';
import { createStep, createWorkflow } from '@mastra/core/workflows';
import { PUBSUB_SYMBOL } from '@mastra/core/workflows/_constants';
import { LibSQLStore } from '@mastra/libsql';
import { z } from 'zod';
import { projectLiveOutputChunk, publishLiveOutput } from '../src/intake/live-output.js';
import { generateProductContent } from '../src/intake/product-generation.js';
import { projectLiveOutputEvent, projectLiveOutputFrame, projectProductStreamEvent } from '../src/intake/run-timeline.js';

test('模型文本和工具事件经原生 Workflow watch 投影，隐藏参数不进入事件', async () => {
  const events: unknown[] = [];
  const sources: unknown[] = [];
  const agent = { stream: async () => ({
    fullStream: (async function* () {
      yield { type: 'text-delta', payload: { text: '模型输出片段' } };
      yield { type: 'reasoning-delta', payload: { text: 'hidden-reasoning' } };
      yield { type: 'tool-call', payload: { toolName: 'readFile', args: { secret: 'hidden-args' } } };
      yield { type: 'tool-result', payload: { toolName: 'readFile', result: 'hidden-result' } };
    })(),
    getFullOutput: async () => ({ finishReason: 'stop', steps: [{ text: '最终合成结果' }], toolResults: [] }),
  }) } as any;
  const step = createStep({ id: 'test-product-stream', inputSchema: z.object({}), outputSchema: z.object({ text: z.string() }), execute: async ({ runId, [PUBSUB_SYMBOL]: pubsub }) => {
    const result = await generateProductContent(agent, '{}', 'analysis', 'live', undefined, 0, event => publishLiveOutput(pubsub, runId, event, 'test-product-stream', '0123456789abcdef'));
    return { text: result.text };
  } });
  const child = createWorkflow({ id: 'test-product-child', inputSchema: z.object({}), outputSchema: z.object({ text: z.string() }) }).then(step).commit();
  const workflow = createWorkflow({ id: 'test-product-stream-flow', inputSchema: z.object({}), outputSchema: z.object({ text: z.string() }) }).then(child).commit();
  const storage = new LibSQLStore({ id: 'test-product-stream-store', url: 'file::memory:' });
  new Mastra({ workflows: { workflow }, storage, logger: false });
  try {
    const run = await workflow.createRun();
    const unwatch = await run.watchAsync(event => { const frame = projectLiveOutputFrame(event); if (frame) { events.push(frame.output); sources.push([frame.stepId, frame.taskKey]); } });
    const result = await run.start({ inputData: {} });
    await new Promise(resolve => setTimeout(resolve, 100));
    unwatch();
    assert.equal(result.status, 'success');
    assert.deepEqual(events, [{ type: 'text', text: '模型输出片段', role: 'analysis', attempt: 1 }, { type: 'tool', action: 'file.read', state: 'started', role: 'analysis', attempt: 1 }, { type: 'tool', action: 'file.read', state: 'completed', role: 'analysis', attempt: 1 }]);
    assert.deepEqual(sources, Array.from({ length: 3 }, () => ['test-product-stream', '0123456789abcdef']));
    assert.doesNotMatch(JSON.stringify(events), /hidden-/);
  } finally { await storage.close(); }
});

test('完整团队角色的流式投影受白名单和最小字段约束', () => {
  for (const role of ['context', 'architect', 'readiness', 'frontend', 'backend', 'infrastructure', 'testing', 'operations']) {
    assert.deepEqual(projectLiveOutputEvent({ type: 'live-output.v1', data: { type: 'text', text: `${role} 输出`, role, attempt: 1, secret: 'must-not-leak' } }), { type: 'text', text: `${role} 输出`, role, attempt: 1 });
  }
  assert.equal(projectLiveOutputEvent({ type: 'live-output.v1', data: { type: 'text', text: '拒绝', role: 'self-check', attempt: 1 } }), undefined);
  assert.equal(projectLiveOutputEvent({ type: 'live-output.v1', data: { type: 'tool', action: 'file.read', state: 'completed', role: 'unknown', attempt: 1 } }), undefined);
  assert.equal(projectLiveOutputEvent({ type: 'live-output.v1', data: { type: 'text', text: '越界重试', role: 'testing', attempt: 3 } }), undefined);
  assert.deepEqual(projectProductStreamEvent({ type: 'product-live-output.v1', data: { type: 'text', text: '兼容旧产品流', role: 'analysis', attempt: 1 } }), { type: 'text', text: '兼容旧产品流', role: 'analysis', attempt: 1 });
});

test('工具实时输出仅提取白名单对象字段，不携带搜索词、路径或文件正文', () => {
  const project = (toolName: string, args: unknown) => projectLiveOutputChunk({ type: 'tool-call', payload: { toolName, args } }, 'writing', 1);
  assert.deepEqual(project('skill', { name: 'product-pm-requirements-alignment', extra: 'secret' }), { type: 'tool', action: 'skill.load', object: 'product-pm-requirements-alignment', state: 'started', role: 'writing', attempt: 1 });
  assert.deepEqual(project('skill_read', { skillName: 'product-pm-requirements-alignment', path: 'references/private.md' }), { type: 'tool', action: 'skill.read', object: 'product-pm-requirements-alignment', state: 'started', role: 'writing', attempt: 1 });
  assert.deepEqual(project('skill_search', { query: 'private search term', skillNames: ['product-pm-requirements-alignment'], topK: 5 }), { type: 'tool', action: 'skill.search', object: 'product-pm-requirements-alignment', state: 'started', role: 'writing', attempt: 1 });
  assert.deepEqual(project('handoff_locate', { id: 'material-1-abcdef123456', query: 'private text' }), { type: 'tool', action: 'handoff.locate', state: 'started', role: 'writing', attempt: 1 });
  assert.deepEqual(project('handoff_read', { id: 'material-1-abcdef123456', offset: 0, length: 100 }), { type: 'tool', action: 'handoff.read', state: 'started', role: 'writing', attempt: 1 });
  assert.deepEqual(project('writeFile', { path: 'src/private.ts', content: 'private source' }), { type: 'tool', action: 'file.write', object: 'private.ts', state: 'started', role: 'writing', attempt: 1 });
  assert.doesNotMatch(JSON.stringify([project('skill_search', { query: 'private search term' }), project('writeFile', { path: 'src/private.ts', content: 'private source' })]), /private search term|private source/);
});
