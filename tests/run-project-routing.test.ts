import assert from 'node:assert/strict';
import { test } from 'node:test';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { Mastra } from '@mastra/core';
import { Hono, type Handler } from 'hono';
import { createStudioApplicationOptions } from '../src/mastra/app.js';
import type { PracticeConfig } from '../src/mastra/config.js';
import { createProjectCorrelation, projectSpec, projectTarget, registeredProjects, scopedProjectConfig, selectProjectConfig, withProjectConfig } from '../src/business-engineering/project.js';
import { readRemoteSyncSettings, resolveRemoteSyncTarget, writeRemoteSyncSettings } from '../src/delivery/remote-sync-settings.js';
import { deliverySchema } from '../src/mastra/workflows/delivery.js';
import { submitReviewedCandidate } from '../src/delivery/merge-request.js';
import { executionResolver } from '../src/mastra/workflows/development-team.js';
import { contentHash, formalRunBranch } from '../src/delivery/remote-handoff.js';
import { type Lifecycle } from '../src/delivery/contracts.js';
import { assetHash, registerAssetRun } from '../src/delivery/asset-catalog.js';

test('同实例 Node/Python 并发、Store 重启恢复、原生错绑拒绝和资产/同步目标隔离', { timeout: 240000 }, async () => {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'run-project-routing-')));
  /** 只在本测试临时仓库执行固定 Git 操作。 */
  function git(root: string, ...args: string[]) { return execFileSync('git', ['-C', root, '-c', 'core.hooksPath=/dev/null', '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim(); }
  /** 创建两个不同技术栈的真实固定提交项目。 */
  function project(id: string, python: boolean) {
    const root = join(directory, id); mkdirSync(root);
    const source = python ? 'src/stock.py' : 'src/stock.mjs';
    const check = python ? 'tests/test_stock.py' : 'test/stock.test.mjs';
    const files = { 'AGENTS.md': `${id}：保持纯函数。\n`, 'specs/engineering.json': JSON.stringify({ version: python ? 'python-unittest.v1' : 'node-test.v1', sources: [source], writable: [source], checks: [check] }), 'specs/product-sdd.md': `${id} 产品规格`, 'specs/development-sdd.md': `${id} 开发规格`, 'specs/test-sdd.md': `${id} 测试规格`, [source]: python ? 'def fixture_value():\n    return 1\n' : 'export const initial = 0;\n', [check]: python ? 'import unittest\nfrom stock import fixture_value\nclass StockTest(unittest.TestCase):\n    def test_stock(self):\n        self.assertEqual(fixture_value(), 1)\n' : 'import { test } from "node:test"; import assert from "node:assert/strict"; import { fixtureValue } from "../src/stock.mjs"; test("node stock", () => assert.equal(fixtureValue(), 1));\n' };
    for (const [path, body] of Object.entries(files)) { mkdirSync(dirname(join(root, path)), { recursive: true }); writeFileSync(join(root, path), body); }
    git(root, 'init', '-q'); const origin = `https://github.com/fixture/${id}.git`; git(root, 'remote', 'add', 'origin', origin); git(root, 'add', '.'); git(root, 'commit', '-qm', 'test: 固定项目');
    return { id, label: id, root, origin, revision: git(root, 'rev-parse', 'HEAD') };
  }
  const projects = [project('node-stock', false), project('python-stock', true)];
  const config: PracticeConfig = { rootDir: process.cwd(), mode: 'fixture', modelId: 'openai/fixture', port: 4111, databaseUrl: `file:${join(directory, 'mastra.db')}`, engineeringProjects: projects };
  let app = createStudioApplicationOptions(config);
  /** 连接同一 Mastra 实例的原生 HTTP 路由。 */
  function routerFor(options: typeof app) { new Mastra(options); const router = new Hono(); for (const route of options.server.apiRoutes) if ('handler' in route) router.on(route.method, route.path, route.handler as Handler); return router; }
  let router = routerFor(app);
  /** POST 保留实际响应以便定位流程失败。 */
  async function post(path: string, body: unknown, expected = 200) { const response = await router.request(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }); assert.equal(response.status, expected, await response.clone().text()); return response.json(); }
  const actor = { reviewer: 'fixture', comment: '核对当前项目固定版本' };
  const ids = projects.map(() => randomUUID());
  /** 同时推进两个原生 Run 的人工关口。 */
  async function respond(index: number, body: unknown) { return post(`/intake-api/runs/${ids[index]}/respond`, body); }
  try {
    assert.throws(() => projectTarget(config), /按 Run/);
    assert.throws(() => registeredProjects({ ...config, engineeringProjects: [projects[0]!, { ...projects[0]!, id: 'duplicate' }] }), /同一个仓库/);
    const proxy = scopedProjectConfig(config);
    const contexts = await Promise.all(projects.map(async item => withProjectConfig(selectProjectConfig(config, item.id), async () => { await new Promise(resolve => setImmediate(resolve)); return { spec: projectSpec(proxy, 'product')?.content, target: projectTarget(proxy)?.id }; })));
    assert.deepEqual(contexts, projects.map(item => ({ spec: `${item.id} 产品规格`, target: item.id })));
    for (const item of projects) {
      const selected = selectProjectConfig(config, item.id);
      assert.equal(resolveRemoteSyncTarget(selected, 'initialize-product-development')?.id, item.id);
      const disabled = readRemoteSyncSettings(selected); disabled.phases.product.enabled = false; writeRemoteSyncSettings(selected, disabled);
      assert.equal(resolveRemoteSyncTarget(selected, 'initialize-product-development'), undefined);
      disabled.phases.product.enabled = true; writeRemoteSyncSettings(selected, disabled);
    }
    await post('/intake-api/runs', { runId: randomUUID(), brief: '缺少项目' }, 409);
    await post('/intake-api/runs', { runId: randomUUID(), projectId: 'unknown', brief: '未知项目' }, 409);
    await post('/intake-api/runs', { runId: randomUUID(), projectId: projects[0]!.id, root: '/tmp/forged', brief: '伪造路径' }, 409);
    let current = await Promise.all(projects.map((item, index) => post('/intake-api/runs', { runId: ids[index], projectId: item.id, brief: `${item.id} 合成需求`, intakeMode: 'autofill' })));
    await post('/intake-api/runs', { runId: ids[0], projectId: projects[1]!.id, brief: `${projects[0]!.id} 合成需求`, intakeMode: 'autofill' }, 409);
    current = await Promise.all(current.map((run, index) => respond(index, { ...actor, role: 'product', artifactHash: run.product.artifact.hash, decision: 'approve' })));
    const catalogs = await Promise.all(ids.map(async runId => (await router.request(`/intake-api/project?runId=${runId}`)).json()));
    assert.deepEqual(catalogs.map(item => item.id), projects.map(item => item.id));
    await post(`/intake-api/runs/${ids[0]}/respond`, { gateHash: current[0].gate.gateHash, repositoryScope: { ...actor, catalogHash: catalogs[1].catalogHash } }, 409);
    current = await Promise.all(current.map((run, index) => respond(index, { gateHash: run.gate.gateHash, repositoryScope: { ...actor, catalogHash: catalogs[index].catalogHash } })));
    assert.ok(current.every(run => run.gate?.key === 'approve-architecture'), JSON.stringify(current));
    await app.storage.close();
    app = createStudioApplicationOptions({ ...config, engineeringProjects: [...projects].reverse() }); router = routerFor(app);
    current = await Promise.all(ids.map(async runId => { const response = await router.request(`/intake-api/runs/${runId}`); assert.equal(response.status, 200, await response.clone().text()); return response.json(); }));
    current = await Promise.all(current.map((run, index) => respond(index, { gateHash: run.gate.gateHash, data: { ...actor, ...run.gate.fixed, decision: 'approve', resolutions: [] } })));
    assert.ok(current.every(run => run.gate?.key === 'approve-test-cases'), JSON.stringify(current));
    current = await Promise.all(current.map((run, index) => respond(index, { gateHash: run.gate.gateHash, data: { ...actor, ...run.gate.fixed, decision: 'approve', cases: [{ id: 'stock', requirementRefs: run.gate.evidence.requirements.map((item: { id: string }) => item.id), expected: '登记检查通过', method: 'registered-check', checkRefs: run.gate.evidence.registeredChecks }] } })));
    assert.ok(current.every(run => run.gate?.key === 'review-test-results'), JSON.stringify(current));
    current = await Promise.all(current.map((run, index) => respond(index, { gateHash: run.gate.gateHash, data: { ...actor, ...run.gate.fixed, decision: 'pass', manualResults: [], findings: [] } })));
    assert.ok(current.every(run => run.status === 'success' && run.outcome === 'fixture-completed'), JSON.stringify(current));
    const mrTargets = await Promise.all(projects.map((item, index) => withProjectConfig(selectProjectConfig(config, item.id), async () => {
      const snapshot = (await app.workflows.productDevelopmentWorkflow.getWorkflowRunById(ids[index]!))!;
      const state = structuredClone(snapshot.result) as Lifecycle;
      const savedInput = structuredClone(state.development.input);
      const branch = formalRunBranch('unassigned', ids[index]!);
      /** 规格端口模拟已确认回执，保留真实候选读取与路由校验。 */
      function specification(kind: 'product' | 'development' | 'testing') { const path = `specs/${kind === 'testing' ? 'test' : kind}-spec.md`; return { kind, paths: [path], upstreamCommits: kind === 'testing' ? [item.revision, item.revision] : [], handoff: { version: 'remote-handoff.v1' as const, branch, commit: item.revision, files: { [path]: contentHash('fixture') } } }; }
      const product = specification('product'); const development = specification('development'); const testing = specification('testing');
      state.development.input.formalSpecifications = [product]; state.development.formalSpecification = development; state.formalSpecifications = [testing];
      const execution = executionResolver(selectProjectConfig(config, item.id), { requireExisting: true })(savedInput);
      const targets: string[] = [];
      try {
        const receipt = await submitReviewedCandidate(proxy, state, execution, state.development.checkpointHash, state.quality.reportHash!, {
          /** 端口只替换远端资料读取，不改当前实际候选。 */
          read: (root, _handoff, path) => { assert.equal(root, item.root); return path === 'specs/test-spec.md' ? JSON.stringify({ plan: state.quality.plan, cases: state.quality.approval!.cases, sourceHash: state.development.checkpointHash }) : 'fixture'; },
          /** 记录生产提交函数实际传来的仓库与基线，绝不访问远端。 */
          publish: async (root, _testing, candidate, _writable, _specs, revision) => { assert.equal(revision, item.revision); assert.ok(Object.keys(candidate).length); targets.push(root); return item.revision; },
          /** 记录真实 MR 路由计算结果。 */
          open: async (repository, selectedBranch, commit, sourceHash, reportHash) => { targets.push(repository); return { number: index + 1, url: `https://github.com/${repository}/pull/${index + 1}`, branch: selectedBranch, commit, base: 'main', sourceHash, reportHash }; },
        });
        assert.equal(receipt.branch, branch);
        return targets;
      } finally { await execution.close(); }
    })));
    assert.deepEqual(mrTargets, projects.map(item => [item.root, `fixture/${item.id}`]));
    assert.equal((await router.request('/delivery-assets/catalog')).status, 409);
    assert.equal((await router.request('/delivery-assets/bundle')).status, 409);
    for (const [index, item] of projects.entries()) {
      const catalog = await (await router.request(`/delivery-assets/catalog?projectId=${item.id}`)).json();
      assert.deepEqual(catalog.runs.map((run: any) => run.correlation.runId), [ids[index]]);
      const asset = catalog.assets[0]; const name = Object.keys(asset.manifest.files)[0];
      assert.equal((await router.request(`/delivery-assets/file?id=${asset.id}&name=${name}`)).status, 409);
      assert.equal((await router.request(`/delivery-assets/file?projectId=${item.id}&id=${asset.id}&name=${name}`)).status, 200);
      const archive = JSON.parse(readFileSync(join(item.root, `product/catalog/runs/${ids[index]}/run.json`), 'utf8'));
      assert.equal(archive.correlation.projectId, item.id);
      assert.ok(readdirSync(join(item.root, `product/catalog/runs/${ids[index]}/history`)).length > 5);
      const response = await router.request(`/intake-api/runs/${ids[index]}/candidate-changes`); assert.equal(response.status, 200);
      assert.equal((await response.json()).status, 'ready');
    }
    const workflow = app.workflows.productDevelopmentWorkflow;
    const runB = await workflow.getWorkflowRunById(ids[1]!);
    const initialB = deliverySchema.parse((runB!.steps!['initialize-product-development'] as any).output);
    const native = await workflow.createRun({ runId: ids[0] });
    await assert.rejects(native.timeTravel({ step: ['product-team', 'review-product'], inputData: initialB }), /项目绑定/);
    await assert.rejects(native.timeTravel({ step: ['initialize-product-development'], inputData: { projectId: projects[1]!.id, brief: '试图替换项目', iterationId: 'unassigned', intakeMode: 'autofill' } }), /重新初始化/);
    await assert.rejects(native.timeTravel({ step: 'initialize-product-development', inputData: { projectId: projects[1]!.id, brief: '字符串入口', iterationId: 'unassigned', intakeMode: 'autofill' } }), /重新初始化/);
    await assert.rejects(native.timeTravel({ step: ['product-team'], context: { 'initialize-product-development': { output: initialB } } as any }), /初始化上下文/);
    await assert.rejects(native.start({ inputData: { projectId: projects[1]!.id, brief: '试图重启', iterationId: 'unassigned', intakeMode: 'autofill' } }), /重新初始化/);
    await assert.rejects(native.startAsync({ inputData: { projectId: projects[1]!.id, brief: '异步重启', iterationId: 'unassigned', intakeMode: 'autofill' } }), /重新初始化/);
    assert.equal(existsSync(join(projects[1]!.root, `product/catalog/runs/${ids[0]}`)), false);
    const unchanged = await workflow.getWorkflowRunById(ids[0]!);
    assert.equal((unchanged!.steps!['initialize-product-development'] as any).output.correlation.projectId, projects[0]!.id);
    const sharedRun = randomUUID(); const projectionHash = '1'.repeat(64);
    const sameRelative = `product/runs/${sharedRun}/collision/${projectionHash}`;
    for (const item of projects) {
      const correlation = createProjectCorrelation(selectProjectConfig(config, item.id), { projectId: item.id, iterationId: 'collision' }, sharedRun);
      registerAssetRun(item.root, correlation, '同标识资产隔离', item);
      const destination = join(item.root, sameRelative); mkdirSync(destination, { recursive: true });
      writeFileSync(join(destination, 'body.md'), item.id);
      writeFileSync(join(destination, 'manifest.json'), JSON.stringify({ schemaVersion: 2, repository: item.origin, runId: sharedRun, stage: 'collision', mode: 'fixture', event: 'completed', projectionHash, authority: 'workflow-export', correlation, createdAt: new Date().toISOString(), files: { 'body.md': assetHash(item.id) } }));
    }
    const collidingId = assetHash(`${sameRelative}/manifest.json`);
    for (const item of projects) assert.equal(await (await router.request(`/delivery-assets/file?projectId=${item.id}&id=${collidingId}&name=body.md`)).text(), item.id);
    const store = (await app.storage.getStore('workflows'))!;
    const source = (await store.loadWorkflowSnapshot({ workflowName: 'product-development', runId: ids[0]! }))!;
    const sourcePath = 'specs/product-spec.md';
    writeFileSync(join(projects[0]!.root, sourcePath), '已确认旧产品规格\n'); git(projects[0]!.root, 'add', sourcePath); git(projects[0]!.root, 'commit', '-qm', 'test: 保存正式规格');
    const sourceCommit = git(projects[0]!.root, 'rev-parse', 'HEAD');
    source.result!.development.input.formalSpecifications = [{ kind: 'product', paths: [sourcePath], upstreamCommits: [], handoff: { version: 'remote-handoff.v1', branch: formalRunBranch('unassigned', ids[0]!), commit: sourceCommit, files: { [sourcePath]: contentHash('已确认旧产品规格\n') } } }];
    await store.persistWorkflowSnapshot({ workflowName: 'product-development', runId: ids[0]!, snapshot: source });
    writeFileSync(join(projects[0]!.root, 'specs/development-sdd.md'), '新一版开发规格'); git(projects[0]!.root, 'add', 'specs/development-sdd.md'); git(projects[0]!.root, 'commit', '-qm', 'test: 更新工程基线');
    const nextRevision = git(projects[0]!.root, 'rev-parse', 'HEAD');
    await app.storage.close();
    app = createStudioApplicationOptions({ ...config, engineeringProjects: [{ ...projects[0]!, revision: nextRevision }, projects[1]!] }); router = routerFor(app);
    const historic = await router.request(`/intake-api/runs/${ids[0]}`); assert.equal(historic.status, 200, await historic.clone().text());
    assert.equal((await router.request('/intake-api/runs')).status, 200);
    const successorId = randomUUID();
    const successor = await post(`/intake-api/runs/${ids[0]}/successors`, { runId: successorId, artifactKinds: ['product'], changeBrief: '新一轮库存调整' });
    assert.equal(successor.projectId, projects[0]!.id);
    const next = await app.workflows.productDevelopmentWorkflow.getWorkflowRunById(successorId);
    assert.equal((next!.steps!['initialize-product-development'] as any).output.correlation.engineeringRevision, nextRevision);
    const oldRun = await app.workflows.productDevelopmentWorkflow.createRun({ runId: ids[0] });
    await assert.rejects(oldRun.resume({ resumeData: {} }), /业务工程绑定/);
    const concurrentId = randomUUID();
    const concurrent = await app.workflows.productDevelopmentWorkflow.createRun({ runId: concurrentId });
    const starts = await Promise.allSettled(projects.map(item => concurrent.start({ inputData: { projectId: item.id, brief: '同标识并发初始化', iterationId: 'concurrent', intakeMode: 'autofill' } })));
    assert.equal(starts.filter(result => result.status === 'fulfilled').length, 1);
    assert.equal(starts.filter(result => result.status === 'rejected').length, 1);
    const winnerIndex = starts.findIndex(result => result.status === 'fulfilled');
    assert.equal(existsSync(join(projects[winnerIndex]!.root, `product/catalog/runs/${concurrentId}`)), true);
    assert.equal(existsSync(join(projects[1 - winnerIndex]!.root, `product/catalog/runs/${concurrentId}`)), false);
    const concurrentSnapshot = await app.workflows.productDevelopmentWorkflow.getWorkflowRunById(concurrentId);
    assert.equal((concurrentSnapshot!.steps!['initialize-product-development'] as any).output.correlation.projectId, projects[winnerIndex]!.id);
  } finally { await app.storage.close(); rmSync(directory, { recursive: true, force: true }); }
});
