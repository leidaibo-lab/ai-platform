/** 四个独立业务入口使用真实 Store、隔离候选与宿主固定检查。 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { Mastra } from '@mastra/core';
import { createStudioApplicationOptions } from '../src/mastra/app.js';
import { readIntake, respondIntake } from '../src/intake/service.js';
import { executionResolver } from '../src/mastra/workflows/development-team.js';
import { developmentHash } from '../src/development/contracts.js';
import { resolveTeamSource, teamRunInputSchema } from '../src/team/runs.js';
import { assertApprovalV2 } from '../src/development/v2/gates.js';
import { Hono, type Handler } from 'hono';
import { randomUUID } from 'node:crypto';
import { createTeamRunRoutes } from '../src/intake/team-routes.js';
import { createWorkbenchAccount } from '../src/intake/workbench-account.js';
import { resolveInputPackage } from '../src/team/input-packages.js';

const actor = { reviewer: 'fixture-owner', comment: '合成明确确认' };
const project = { id: 'team-fixture', files: {
  'src/a.mjs': 'export const initial=0;',
  'check.mjs': 'import {test} from "node:test"; import assert from "node:assert/strict"; import {fixtureValue} from "./src/a.mjs"; test("fixture",()=>assert.equal(fixtureValue(),1));',
}, writablePaths: ['src/a.mjs'], checkFiles: ['check.mjs'], roles: ['backend'] };

test('独立产品→研发→测试→交付入口，跨 Store 恢复并隔离来源候选', async () => {
  const directory = mkdtempSync(resolve(tmpdir(), 'independent-teams-'));
  const config = { rootDir: resolve('.'), mode: 'fixture' as const, modelId: 'openai/fixture' as const, port: 4111, databaseUrl: `file:${resolve(directory, 'workflow.db')}` };
  let app = createStudioApplicationOptions(config);
  let mastra = new Mastra(app);
  try {
    const common = { version: 'team-run-input.v1', projectId: 'hrm', iterationId: 'independent' };
    const product = app.workflows.productTeamRun;
    const productRun = await product.createRun();
    await productRun.start({ inputData: { ...common, team: 'product', brief: '合成独立团队需求', intakeMode: 'autofill' } });
    let current = await readIntake(product, productRun.runId, config);
    assert.equal(current.step, 'review-product');
    const pending = await product.getWorkflowRunById(productRun.runId);
    const review = Object.values(pending!.steps!).find(entry => !Array.isArray(entry) && entry.status === 'suspended');
    const forged = await product.createRun({ runId: productRun.runId });
    await assert.rejects(forged.timeTravel({ step: ['product-team', 'product-writing'], inputData: { ...(!Array.isArray(review) ? review?.payload as object : {}), brief: '伪造需求' } }), /检查点/);
    current = await respondIntake(product, 'fixture', productRun.runId, { ...actor, comment: '文案：明确模块返回值', role: 'product', artifactHash: current.product!.artifact.hash, decision: 'rework' }, config);
    assert.equal(current.step, 'review-product', JSON.stringify(current));
    assert.equal((await product.getWorkflowRunById(productRun.runId))!.status, 'suspended');
    await respondIntake(product, 'fixture', productRun.runId, { ...actor, role: 'product', artifactHash: current.product!.artifact.hash, decision: 'approve' }, config);
    const productSnapshot = await product.getWorkflowRunById(productRun.runId);
    assert.equal(productSnapshot!.status, 'success');
    assert.equal(productSnapshot!.steps!['development-team'], undefined);
    const productSource = await resolveTeamSource(mastra, config, 'development', { workflow: 'productTeamRun', runId: productRun.runId });
    await assert.rejects(resolveTeamSource(mastra, config, 'development', { workflow: 'productTeamRun', runId: productRun.runId }, '0'.repeat(64)), /版本/);
    const development = app.workflows.developmentTeamRun;
    const developmentRun = await development.createRun();
    await developmentRun.start({ inputData: { ...common, team: 'development', source: { workflow: 'productTeamRun', runId: productRun.runId, hash: productSource.hash } } });
    current = await readIntake(development, developmentRun.runId, config);
    assert.equal(current.gate?.key, 'confirm-project-scope', JSON.stringify(current));
    current = await respondIntake(development, 'fixture', developmentRun.runId, { gateHash: current.gate!.gateHash, data: { ...actor, project, maxReworks: 1 } }, config);
    assert.equal(current.gate?.key, 'approve-architecture', JSON.stringify(current));
    current = await respondIntake(development, 'fixture', developmentRun.runId, { gateHash: current.gate!.gateHash, data: { ...actor, ...current.gate!.fixed, decision: 'approve', resolutions: [] } }, config);
    assert.equal(current.status, 'success', JSON.stringify(current));
    assert.equal(current.outcome, 'development-delivered', JSON.stringify(await development.getWorkflowRunById(developmentRun.runId)));
    const delivered = await resolveTeamSource(mastra, config, 'testing', { workflow: 'developmentTeamRun', runId: developmentRun.runId });
    const sourceInput = delivered.development!.input;
    const original = executionResolver(config)(sourceInput);
    const originalHash = developmentHash(await original.snapshot());
    await original.close();
    await app.storage.close();
    app = createStudioApplicationOptions(config);
    mastra = new Mastra(app);
    const testing = app.workflows.testingTeamRun;
    const testingRun = await testing.createRun();
    await testingRun.start({ inputData: { ...common, team: 'testing', source: { workflow: 'developmentTeamRun', runId: developmentRun.runId, hash: delivered.hash } } });
    current = await readIntake(testing, testingRun.runId, config);
    assert.equal(current.gate?.key, 'approve-test-cases', JSON.stringify(current));
    await assert.rejects(resolveTeamSource(mastra, config, 'delivery', { workflow: 'testingTeamRun', runId: testingRun.runId }), /来源 Run 缺少/);
    const sourceExecution = executionResolver(config)(sourceInput);
    let sourceContents: string;
    try { sourceContents = await sourceExecution.readFile('src/a.mjs'); await sourceExecution.writeFile('src/a.mjs', 'export const drift=1;'); }
    finally { await sourceExecution.close(); }
    const testNative = await testing.createRun({ runId: testingRun.runId });
    await assert.rejects(testNative.resume({ step: ['test-team', 'test-and-regression-cycle', 'approve-test-cases'], resumeData: {} }), /漂移/);
    const restore = executionResolver(config)(sourceInput);
    try { await restore.writeFile('src/a.mjs', sourceContents!); }
    finally { await restore.close(); }
    assert.equal((await readIntake(testing, testingRun.runId, config)).gate?.gateHash, current.gate!.gateHash);
    const testEvidence = current.gate!.evidence;
    current = await respondIntake(testing, 'fixture', testingRun.runId, { gateHash: current.gate!.gateHash, data: { ...actor, ...current.gate!.fixed, decision: 'approve', cases: [{ id: 'all', requirementRefs: testEvidence.requirements.map((item: any) => item.id), expected: '模块返回1', method: 'registered-check', checkRefs: testEvidence.registeredChecks }] } }, config);
    assert.equal(current.gate?.key, 'review-test-results', JSON.stringify(current));
    current = await respondIntake(testing, 'fixture', testingRun.runId, { gateHash: current.gate!.gateHash, data: { ...actor, ...current.gate!.fixed, decision: 'pass', manualResults: [], findings: [] } }, config);
    assert.equal(current.status, 'success', JSON.stringify(current));
    const passed = await resolveTeamSource(mastra, config, 'delivery', { workflow: 'testingTeamRun', runId: testingRun.runId });
    assert.notEqual(passed.development!.input.source.runId, sourceInput.source.runId);
    assertApprovalV2(passed.development!);
    const delivery = app.workflows.deliveryTeamRun;
    const deliveryRun = await delivery.createRun();
    const result = await deliveryRun.start({ inputData: { ...common, team: 'delivery', source: { workflow: 'testingTeamRun', runId: testingRun.runId, hash: passed.hash } } });
    assert.equal(result.status, 'success', JSON.stringify(result));
    assert.equal(result.result.outcome, 'fixture-completed');
    const unchanged = executionResolver(config)(sourceInput);
    try { assert.equal(developmentHash(await unchanged.snapshot()), originalHash); }
    finally { await unchanged.close(); }
    const reopenedProduct = await app.workflows.productTeamRun.createRun({ runId: productRun.runId });
    await assert.rejects(reopenedProduct.start({ inputData: { ...common, team: 'product', brief: '更换需求' } }), /初始化/);
  } finally { await app.storage.close(); rmSync(directory, { recursive: true, force: true }); }
});

test('独立团队公开入参拒绝伪造审批、候选和命令', () => {
  const input = { version: 'team-run-input.v1', team: 'product', projectId: 'hrm', iterationId: 'test', brief: '合成' };
  for (const forged of [{ approved: true }, { candidate: '/tmp/other' }, { command: 'anything' }]) assert.equal(teamRunInputSchema.safeParse({ ...input, ...forged }).success, false);
});

test('独立团队 HTTP 身份、来源发现、重复启动和版本化审批', async () => {
  const directory = mkdtempSync(resolve(tmpdir(), 'team-http-'));
  const config = { rootDir: resolve('.'), mode: 'fixture' as const, modelId: 'openai/fixture' as const, port: 4111, databaseUrl: `file:${resolve(directory, 'workflow.db')}` };
  const app = createStudioApplicationOptions(config);
  const mastra = new Mastra(app);
  const router = new Hono<{ Variables: { mastra: Mastra } }>();
  router.use('*', async (c, next) => { c.set('mastra', mastra); await next(); });
  for (const route of [...createWorkbenchAccount(config.databaseUrl).routes, ...createTeamRunRoutes(app.workflows, config)]) {
    if ('handler' in route) router.on(route.method, route.path, route.handler as Handler);
  }
  try {
    const runId = randomUUID();
    const input = { version: 'team-run-input.v1', team: 'product', projectId: 'hrm', iterationId: 'http', brief: 'HTTP 合成团队需求', intakeMode: 'autofill' };
    const headers: Record<string, string> = { 'content-type': 'application/json', origin: 'http://127.0.0.1:4112' };
    /** HTTP 调用始终使用同一浏览器身份，便于验证响应丢失后的对账。 */
    const post = (path: string, body: unknown) => router.request(path, { method: 'POST', headers, body: JSON.stringify(body) });
    assert.equal((await post('/intake-api/teams/product/runs', { runId, input })).status, 401);
    const login = await post('/intake-api/account', { username: 'fixture-owner', password: 'fixture-local-account-password' });
    assert.equal(login.status, 200);
    headers.cookie = login.headers.get('set-cookie')!.split(';')[0]!;
    const created = await post('/intake-api/teams/product/runs', { runId, input });
    assert.equal(created.status, 200, await created.clone().text());
    const current = await created.json();
    assert.equal(current.step, 'review-product');
    const repeated = await post('/intake-api/teams/product/runs', { runId, input });
    assert.equal(repeated.status, 200);
    assert.equal((await repeated.json()).product.artifact.hash, current.product.artifact.hash);
    assert.equal((await post('/intake-api/teams/product/runs', { runId, input: { ...input, brief: '替换' } })).status, 409);
    assert.equal((await post('/intake-api/teams/product/runs', { runId: randomUUID(), input: { ...input, projectId: 'unknown' } })).status, 409);
    const respond = `/intake-api/teams/product/runs/${runId}/respond`;
    assert.equal((await post(respond, { role: 'product', artifactHash: '0'.repeat(64), decision: 'approve', comment: '过期' })).status, 409);
    assert.equal((await post(respond, { role: 'product', artifactHash: current.product.artifact.hash, decision: 'approve', comment: '明确批准' })).status, 200);
    const available = await router.request('/intake-api/teams/development/sources?projectId=hrm');
    assert.equal(available.status, 200);
    assert.ok((await available.json()).sources.some((item: any) => item.runId === runId));
    const list = await router.request('/intake-api/teams/product/runs?projectId=hrm');
    assert.deepEqual((await list.json()).runs.map((item: any) => item.runId), [runId]);
    const packageId = randomUUID();
    const prepared = await post('/intake-api/team-input-packages', { runId: packageId, input });
    assert.equal(prepared.status, 200, await prepared.clone().text());
    const packageHash = (await prepared.json()).steps['prepare-package'].output.hash;
    const packageRunId = randomUUID();
    const packageStart = { runId: packageRunId, inputPackage: { runId: packageId, hash: packageHash } };
    assert.equal((await post('/intake-api/teams/product/runs', packageStart)).status, 409);
    const packageRespond = `/intake-api/team-input-packages/${packageId}/respond`;
    assert.equal((await post(packageRespond, { action: 'confirm', hash: '0'.repeat(64), comment: '过期确认' })).status, 409);
    // 旧版本在恢复前拒绝，不能消耗原生确认暂停点。
    assert.equal((await post('/intake-api/teams/product/runs', packageStart)).status, 409);
    const activePackageId = randomUUID();
    const activePrepared = await post('/intake-api/team-input-packages', { runId: activePackageId, input });
    const activeHash = (await activePrepared.json()).steps['prepare-package'].output.hash;
    const activeRespond = `/intake-api/team-input-packages/${activePackageId}/respond`;
    assert.equal((await post(activeRespond, { action: 'confirm', hash: activeHash, comment: '明确确认材料' })).status, 200);
    const activeStart = { runId: packageRunId, inputPackage: { runId: activePackageId, hash: activeHash } };
    const started = await post('/intake-api/teams/product/runs', activeStart);
    assert.equal(started.status, 200, await started.clone().text());
    const active = await started.json();
    assert.equal(active.step, 'review-product');
    assert.equal((await post(activeRespond, { action: 'revoke', hash: activeHash, comment: '撤销后禁止消费' })).status, 200);
    assert.equal((await post('/intake-api/teams/product/runs', { ...activeStart, runId: randomUUID() })).status, 409);
    assert.equal((await post(`/intake-api/teams/product/runs/${packageRunId}/respond`, { role: 'product', artifactHash: active.product.artifact.hash, decision: 'approve', comment: '撤销后不得批准' })).status, 409);
    assert.equal((await readIntake(app.workflows.productTeamRun, packageRunId, config)).step, 'review-product');
    headers.origin = 'https://untrusted.invalid';
    assert.equal((await post('/intake-api/teams/product/runs', { runId: randomUUID(), input })).status, 409);
  } finally { await app.storage.close(); rmSync(directory, { recursive: true, force: true }); }
});

test('输入包跨 Store 重启保留确认与撤销，原生入口禁止覆盖和回退', async () => {
  const directory = mkdtempSync(resolve(tmpdir(), 'team-package-reopen-'));
  const config = { rootDir: resolve('.'), mode: 'fixture' as const, modelId: 'openai/fixture' as const, port: 4111, databaseUrl: `file:${resolve(directory, 'workflow.db')}` };
  let app = createStudioApplicationOptions(config);
  let mastra = new Mastra(app);
  try {
    const input = teamRunInputSchema.parse({ version: 'team-run-input.v1', team: 'product', projectId: 'hrm', iterationId: 'reopen', brief: '重启材料', intakeMode: 'autofill' });
    if (input.team !== 'product') throw new Error('fixture 输入必须为产品');
    const run = await app.workflows.teamInputPackage.createRun();
    await run.start({ inputData: input });
    const snapshot = await app.workflows.teamInputPackage.getWorkflowRunById(run.runId);
    const hash = (snapshot!.steps!['prepare-package'] as any).output.hash;
    const reference = { runId: run.runId, hash };
    await assert.rejects(resolveInputPackage(mastra, config, reference), /确认/);
    await run.resume({ step: 'confirm-package', resumeData: { hash, reviewer: 'fixture', comment: '确认' } });
    await app.storage.close();
    app = createStudioApplicationOptions(config); mastra = new Mastra(app);
    assert.deepEqual(await resolveInputPackage(mastra, config, reference), input);
    const reopened = await app.workflows.teamInputPackage.createRun({ runId: run.runId });
    await assert.rejects(reopened.start({ inputData: { ...input, brief: '覆盖' } }), /覆盖/);
    await assert.rejects(reopened.timeTravel({ step: 'confirm-package' }), /回退/);
    await reopened.resume({ step: 'revoke-package', resumeData: { hash, reviewer: 'fixture', comment: '撤销' } });
    await app.storage.close();
    app = createStudioApplicationOptions(config); mastra = new Mastra(app);
    await assert.rejects(resolveInputPackage(mastra, config, reference), /撤销/);
  } finally { await app.storage.close(); rmSync(directory, { recursive: true, force: true }); }
});
