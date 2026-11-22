import assert from 'node:assert/strict';
import test from 'node:test';
import { resolve } from 'node:path';
import { normalizeIndependentTeamRunInput } from '../src/team/independent-run-input.js';
import { loadIndependentTeamSource, resolveIndependentTeamSource } from '../src/team/independent-run-source.js';
import type { PracticeConfig } from '../src/mastra/config.js';
import type { MastraCompositeStore } from '@mastra/core/storage';

const runId = '2d09f1a6-8934-44d7-a628-79abcb410981';
const config: PracticeConfig = { rootDir: resolve('.'), mode: 'fixture', modelId: 'openai/fixture', port: 4111, databaseUrl: 'file::memory:' };
const request = normalizeIndependentTeamRunInput({ version: 'team-run-input.v1', teamId: 'development', projectId: 'hrm', source: { kind: 'approved-product', runId, artifact: 'approved-product' }, payload: { teamId: 'development', authorization: { reviewer: '负责人', comment: '确认范围' } } }).input;
const productHash = '1'.repeat(64);
const product = { brief: '需求', mode: 'fixture', correlation: { projectId: 'hrm', iterationId: 'unassigned', runId, workflowId: 'productDevelopmentWorkflow' }, artifacts: [{ stage: 'product', content: '已批准内容', hash: productHash, evidence: 'fixture' }], reviews: [{ role: 'product', artifactHash: productHash, decision: 'approve', reviewer: '负责人', comment: '批准' }], outcome: 'in-progress' };

test('selects an approved product from the completed review step', () => {
  const snapshot = { status: 'suspended', steps: { 'product-team.review-product': { status: 'success', output: product } } };
  const source = resolveIndependentTeamSource(config, request, snapshot);
  assert.equal(source.kind, 'approved-product');
  assert.equal(source.sourceRunId, runId);
  assert.equal(source.sourceHash.length, 64);
});

test('rejects approval outside the review step, stale approval and wrong run identity', () => {
  assert.throws(() => resolveIndependentTeamSource(config, request, { status: 'suspended', steps: { 'product-team.product-writing': { status: 'success', output: product } } }), /没有已批准/);
  assert.throws(() => resolveIndependentTeamSource(config, request, { status: 'success', steps: { 'product-team.review-product': { status: 'success', output: { ...product, reviews: [{ ...product.reviews[0], artifactHash: '2'.repeat(64) }] } } } }), /没有已批准/);
  assert.throws(() => resolveIndependentTeamSource(config, request, { status: 'success', steps: { 'product-team.review-product': { status: 'success', output: { ...product, correlation: { ...product.correlation, runId: 'different' } } } } }), /标识/);
});

test('reads the explicitly selected, compatible workflow from the native store', async () => {
  const independent = normalizeIndependentTeamRunInput({ ...request, source: { ...request.source, workflowId: 'independent-product' } }).input;
  const calls: unknown[] = [];
  const storage = { getStore: async () => ({ loadWorkflowSnapshot: async (query: unknown) => {
    calls.push(query);
    return { status: 'success', steps: { 'product-team.review-product': { status: 'success', output: product } } };
  } }) } as unknown as MastraCompositeStore;
  const source = await loadIndependentTeamSource(storage, config, independent);
  assert.equal(source.kind, 'approved-product');
  assert.deepEqual(calls, [{ workflowName: 'independent-product', runId }]);
  await assert.rejects(() => loadIndependentTeamSource(storage, config, { ...independent, source: { ...independent.source, workflowId: 'independent-testing' } } as typeof independent));
  assert.equal(calls.length, 1);
});
