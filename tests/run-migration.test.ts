/** 隔离持久化历史 Run，迁移只创建新 Run 并重新审批。 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { Mastra } from '@mastra/core';
import { createStudioApplicationOptions } from '../src/mastra/app.js';
import { readIntake, respondIntake } from '../src/intake/service.js';
import { prepareRunMigration } from '../src/intake/run-migration.js';
import { developmentHash } from '../src/development/contracts.js';
import { executionResolver } from '../src/mastra/workflows/development-team.js';

test('历史 Run 迁移冻结来源、保留旧暂停并继承消费预算后重新审批', async () => {
  const directory = mkdtempSync(resolve(tmpdir(), 'run-migration-'));
  const config = { rootDir: resolve('.'), mode: 'fixture' as const, modelId: 'openai/fixture' as const, port: 4111, databaseUrl: `file:${resolve(directory, 'workflow.db')}` };
  let app = createStudioApplicationOptions(config); new Mastra(app);
  try {
    let workflow = app.workflows.productDevelopmentWorkflow;
    const source = await workflow.createRun();
    await source.start({ inputData: { brief: '合成历史迁移需求', iterationId: 'migration' } });
    let current = await readIntake(workflow, source.runId);
    const actor = { reviewer: 'fixture-owner', comment: '合成确认' };
    current = await respondIntake(workflow, 'fixture', source.runId, { ...actor, role: 'product', artifactHash: current.product!.artifact.hash, decision: 'approve' }, config);
    current = await respondIntake(workflow, 'fixture', source.runId, { gateHash: current.gate!.gateHash, data: { ...actor, project: { id: 'migration', files: { 'src/a.mjs': 'export const initial=0;', 'check.mjs': 'export const check=1;' }, writablePaths: ['src/a.mjs'], checkFiles: ['check.mjs'], roles: ['backend'] } } }, config);
    assert.equal(current.gate?.key, 'approve-architecture');
    const store = (await app.storage.getStore('workflows'))!;
    const snapshot = (await store.loadWorkflowSnapshot({ workflowName: 'product-development', runId: source.runId }))!;
    /** 仅移除隔离 Store 的历史字段来模拟旧版本快照。 */
    function removePolicy(value: unknown) {
      if (!value || typeof value !== 'object') return;
      if ('sandboxPolicy' in value) delete (value as any).sandboxPolicy;
      for (const child of Object.values(value)) removePolicy(child);
    }
    removePolicy(snapshot);
    await store.persistWorkflowSnapshot({ workflowName: 'product-development', runId: source.runId, snapshot });
    /** 嵌套 Workflow 各自持久化暂停载荷，同步构造旧版本来源。 */
    async function migrateNested(parent: typeof snapshot) {
      for (const [id, step] of Object.entries(parent.context)) {
        const nestedId = (step as any)?.metadata?.nestedRunId ?? source.runId;
        const nested = await store.loadWorkflowSnapshot({ workflowName: id, runId: nestedId });
        if (!nested) continue;
        removePolicy(nested);
        await store.persistWorkflowSnapshot({ workflowName: id, runId: nestedId, snapshot: nested });
        await migrateNested(nested);
      }
    }
    await migrateNested(snapshot);
    const before = developmentHash(snapshot);
    await app.storage.close();
    app = createStudioApplicationOptions(config); new Mastra(app); workflow = app.workflows.productDevelopmentWorkflow;
    const { plan, product } = await prepareRunMigration(workflow, config, source.runId);
    assert.equal(plan.previousPolicy, undefined);
    assert.ok(plan.budget.calls > 0);
    const target = await workflow.createRun();
    const result = await target.start({ inputData: { projectId: plan.projectId, iterationId: plan.iterationId, brief: product.brief, intakeMode: 'clarify', migration: { sourceRunId: source.runId, planHash: plan.hash, reviewer: actor.reviewer } } });
    assert.equal(result.status, 'suspended');
    const migrated = await workflow.getWorkflowRunById(target.runId);
    const initialized = (migrated!.steps!['initialize-product-development'] as any).output;
    assert.equal(initialized.migration.budget.calls, plan.budget.calls);
    assert.equal(initialized.migration.planHash, plan.hash);
    assert.ok(initialized.productSources['migration/approved-product.md']);
    assert.equal(initialized.reviews.length, 0);
    const reopenedStore = (await app.storage.getStore('workflows'))!;
    assert.equal(developmentHash(await reopenedStore.loadWorkflowSnapshot({ workflowName: 'product-development', runId: source.runId })), before);
    const historical = Object.values(snapshot.context).flatMap((step: any) => step.payload?.input?.source ? [step.payload] : []);
    const state = historical[0] ?? Object.values((await workflow.getWorkflowRunById(source.runId))!.steps!).map((step: any) => step.payload).find((payload: any) => payload?.input?.source);
    const execution = executionResolver(config)(state.input);
    try { await execution.writeFile('src/a.mjs', 'export const drift=1;'); }
    finally { await execution.close(); }
    await assert.rejects(prepareRunMigration(workflow, config, source.runId), /漂移/);
  } finally { await app.storage.close(); rmSync(directory, { recursive: true, force: true }); }
});
