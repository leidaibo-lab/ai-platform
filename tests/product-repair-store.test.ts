import { describeRecovery } from '../src/intake/recovery.js';
import { productRepairDetails } from '../src/intake/product-repair-history.js';
import { createTeamRunPolicy } from '../src/team/run-policy.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Mastra } from '@mastra/core';
import { createStep, createWorkflow } from '@mastra/core/workflows';
import { LibSQLStore } from '@mastra/libsql';
import { z } from 'zod';
import { repairProductPresentation } from '../src/mastra/workflows/product-manager.js';

/** 验证真实工作流失败后重开 Store 时错误诊断是否保留。 */
test('写作失败诊断在原生 Store 重开后可检查', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'product-repair-store-'));
  const url = `file:${join(dir, 'workflow.db')}`;
  const schema = z.object({});
  /** 重建同一原生图，模拟进程恢复。 */
  function build() {
    const step = createStep({ id: 'writing', inputSchema: schema, outputSchema: schema,
      execute: async () => { await repairProductPresentation(async () => ({ text: '# 需求文档\n没有验收条目\n# 产品规格\n' }), true, createTeamRunPolicy()); return {}; },
    });
    return createWorkflow({ id: 'repair-store-check', inputSchema: schema, outputSchema: schema }).then(step).commit();
  }
  let storage = new LibSQLStore({ id: 'repair-store', url });
  try {
    let workflow = build(); new Mastra({ storage, workflows: { workflow } });
    const run = await workflow.createRun({ runId: 'repair-check' });
    const result = await run.start({ inputData: {} }); assert.equal(result.status, 'failed');
    await storage.close();
    storage = new LibSQLStore({ id: 'repair-store-reopen', url }); workflow = build(); new Mastra({ storage, workflows: { workflow } });
    const snapshot = await workflow.getWorkflowRunById('repair-check');
    const error = (snapshot?.steps?.writing as any)?.error;
    assert.ok(error); assert.match(error.message, /REQ-ID/);
    assert.equal(error.productRepairHistory.length, 2);
    assert.equal(error.productRepairHistory[0].outcome, 'rework');
    assert.equal(error.productRepairHistory[1].outcome, 'no-progress');
    assert.equal(error.productRepairHistory[0].candidateHash, error.productRepairHistory[1].candidateHash);
    assert.match(productRepairDetails(error)[1], /候选重复/);
    const retry = describeRecovery('repair-check', 'failed', { 'product-team.product-writing': { status: 'failed', payload: { brief: '合成需求', mode: 'live', productFlow: 'four-step', intake: { enabled: true, ready: true, round: 0, history: [] }, artifacts: [], reviews: [], outcome: 'in-progress' }, error } });
    assert.ok(retry && 'attemptDetails' in retry);
    assert.match(retry.attemptDetails!.join(' '), /候选重复/);
    assert.deepEqual(productRepairDetails({ productRepairHistory: [{ ...error.productRepairHistory[0], finding: 'secret' }] }), []);
  } finally { await storage.close(); rmSync(dir, { recursive: true, force: true }); }
});

/** 网络故障与原生恢复使用同一 Store 中的累计修订事实。 */
test('Store 重开后原生 timeTravel 延续修订预算', async () => {
  const { productRepairCheckpointSchema } = await import('../src/team/product-repair.js');
  const dir = mkdtempSync(join(tmpdir(), 'product-repair-resume-'));
  const url = `file:${join(dir, 'workflow.db')}`;
  const schema = z.object({ checkpoint: productRepairCheckpointSchema.optional() });
  let generation = 0;
  const invalid = '# 需求文档\n缺少验收\n# 产品规格\n';
  /** 模拟第三次调用网络故障，随后保持不同候选直到预算耗尽。 */
  function build() {
    const writing = createStep({ id: 'writing', inputSchema: schema, outputSchema: schema,
      execute: async ({ inputData }) => {
        await repairProductPresentation(async () => {
          generation++;
          if (generation === 3) throw new Error('synthetic transport');
          return { text: `${invalid}\n候选${generation}` };
        }, true, createTeamRunPolicy(), inputData.checkpoint);
        return inputData;
      },
    });
    return createWorkflow({ id: 'repair-resume-check', inputSchema: schema, outputSchema: schema }).then(writing).commit();
  }
  let storage = new LibSQLStore({ id: 'repair-resume', url });
  try {
    let workflow = build(); new Mastra({ storage, workflows: { workflow } });
    const run = await workflow.createRun({ runId: 'resume-check' });
    await run.start({ inputData: {} });
    await storage.close();
    storage = new LibSQLStore({ id: 'repair-resume-reopen', url });
    workflow = build(); new Mastra({ storage, workflows: { workflow } });
    const saved = await workflow.getWorkflowRunById('resume-check');
    const checkpoint = productRepairCheckpointSchema.parse((saved!.steps!.writing as any).error.productRepairCheckpoint);
    assert.equal(checkpoint.history.length, 2);
    const resumed = await workflow.createRun({ runId: 'resume-check' });
    const result = await resumed.timeTravel({ step: 'writing', inputData: { checkpoint } });
    assert.equal(result.status, 'failed');
    const stopped = await workflow.getWorkflowRunById('resume-check');
    const error = (stopped!.steps!.writing as any).error;
    assert.equal(error.productRepairHistory.length, 4);
    assert.equal(error.productRepairHistory.at(-1).outcome, 'budget-exhausted');
    assert.equal(generation, 5);
  } finally { await storage.close(); rmSync(dir, { recursive: true, force: true }); }
});
