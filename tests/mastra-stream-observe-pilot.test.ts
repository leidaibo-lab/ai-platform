import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Mastra } from '@mastra/core';
import { createStep, createWorkflow } from '@mastra/core/workflows';
import { LibSQLStore } from '@mastra/libsql';
import { z } from 'zod';

/** 验证同一 Workflow 实例可观察已启动的原生流。 */
test('observeStream 观察同一 Workflow 实例中已启动的流', async () => {
  let entered!: () => void;
  let release!: () => void;
  const ready = new Promise<void>(resolve => { entered = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  const step = createStep({ id: 'stream-pilot-step', inputSchema: z.string(), outputSchema: z.string(),
    /** 在确定性屏障中模拟仍在运行的工作流。 */
    execute: async ({ inputData }) => { entered(); await gate; return inputData; },
  });
  const workflow = createWorkflow({ id: 'stream-pilot', inputSchema: z.string(), outputSchema: z.string() }).then(step).commit();
  const storage = new LibSQLStore({ id: 'stream-pilot-store', url: ':memory:' });
  new Mastra({ workflows: { workflow }, storage, logger: false });
  try {
    const run = await workflow.createRun();
    const execution = run.stream({ inputData: 'fixture' });
    await ready;
    const other = await workflow.createRun({ runId: run.runId });
    const reader = other.observeStream().getReader();
    const first = await reader.read();
    assert.equal(other, run);
    assert.equal(first.done, false);
    assert.equal(first.value?.type, 'workflow-start');
    reader.releaseLock();
    release();
    assert.equal((await execution.result).status, 'success');
  } finally { release(); await storage.close(); }
});
