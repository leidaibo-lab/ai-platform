import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { Mastra } from '@mastra/core';
import { createStudioApplicationOptions } from '../src/mastra/app.js';
import type { PracticeConfig } from '../src/mastra/config.js';
import { independentTeamRunOutputSchema } from '../src/team/independent-run-output.js';
import { loadIndependentTeamSource } from '../src/team/independent-run-source.js';
import { normalizeIndependentTeamRunInput } from '../src/team/independent-run-input.js';

test('独立产品团队保存输入、暂停审批、重启恢复并输出可交接结果', async () => {
  const dir = mkdtempSync(resolve(tmpdir(), 'independent-product-'));
  const config: PracticeConfig = { rootDir: resolve('.'), mode: 'fixture', modelId: 'openai/fixture', port: 4111, databaseUrl: `file:${resolve(dir, 'runs.db')}` };
  let app = createStudioApplicationOptions(config);
  new Mastra(app);
  const input = normalizeIndependentTeamRunInput({ version: 'team-run-input.v1', teamId: 'product', projectId: 'hrm', iterationId: 'demo', source: { kind: 'new-requirement' }, payload: { teamId: 'product', brief: '为招聘申请增加审批状态和异常提示', intakeMode: 'autofill' } });
  try {
    const run = await app.workflows.independentProductWorkflow.createRun();
    const started = await run.start({ inputData: input.input });
    assert.equal(started.status, 'suspended', JSON.stringify(started));
    const snapshot = await app.workflows.independentProductWorkflow.getWorkflowRunById(run.runId);
    const review = snapshot?.steps?.['product-team.review-product'] as any;
    assert.equal(review?.status, 'suspended');
    const artifact = review.suspendPayload.artifact;
    await app.storage.close();
    app = createStudioApplicationOptions(config);
    new Mastra(app);
    const resumed = await (await app.workflows.independentProductWorkflow.createRun({ runId: run.runId })).resume({ step: ['product-team', 'review-product'], resumeData: { role: 'product', artifactHash: artifact.hash, decision: 'approve', reviewer: '测试负责人', comment: '确认合成需求' } });
    assert.equal(resumed.status, 'success', JSON.stringify(resumed));
    if (resumed.status !== 'success') throw new Error('产品团队未完成');
    const output = independentTeamRunOutputSchema.parse(resumed.result);
    assert.equal(output.inputHash, input.inputHash);
    assert.equal(output.envelope.status, 'completed');
    const request = normalizeIndependentTeamRunInput({ version: 'team-run-input.v1', teamId: 'development', projectId: 'hrm', source: { kind: 'approved-product', workflowId: 'independent-product', runId: run.runId, artifact: 'approved-product' }, payload: { teamId: 'development', authorization: { reviewer: '研发负责人', comment: '准备确认范围' } } }).input;
    const source = await loadIndependentTeamSource(app.storage, config, request);
    assert.equal(source.kind, 'approved-product');
  } finally { await app.storage.close(); rmSync(dir, { recursive: true, force: true }); }
});
