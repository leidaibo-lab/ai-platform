/** 独立团队使用真实原生 Store 与隔离 Git fixture，验证跨项目和恢复身份。 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile, execFileSync } from 'node:child_process';
import { constants, copyFileSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import { Mastra } from '@mastra/core';
import { Hono, type Handler } from 'hono';
import { createStudioApplicationOptions } from '../src/mastra/app.js';
import { loadEngineeringProject, selectProjectConfig } from '../src/business-engineering/project.js';
import { readIntake, respondIntake } from '../src/intake/service.js';
import { resolveTeamSource, teamWorkflowIds } from '../src/team/runs.js';
import { developmentHash } from '../src/development/contracts.js';
import { executionResolver } from '../src/mastra/workflows/development-team.js';
import type { PracticeConfig } from '../src/mastra/config.js';

test('四个独立团队并发交接 Node/Python 项目，拒绝项目、来源和 Adapter 漂移', { timeout: 300000 }, /** 验证项目绑定贯穿各团队的原生 Workflow 和候选。 */async () => {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'team-isolation-')));
  /** Git 只操作本测试创建的临时仓库，不访问远端。 */
  function git(root: string, ...args: string[]) {
    return execFileSync('git', ['-C', root, '-c', 'core.hooksPath=/dev/null', '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  }
  /** 建立包含固定 Adapter、规格和登记检查的独立项目。 */
  function project(id: string, python: boolean) {
    const root = join(directory, id); mkdirSync(root);
    const source = python ? 'src/stock.py' : 'src/stock.mjs';
    const check = python ? 'tests/test_stock.py' : 'test/stock.test.mjs';
    const adapter = python ? 'python-unittest.v1' : 'node-test.v1';
    const files = {
      'AGENTS.md': '仅修改登记源码。\n',
      'specs/engineering.json': JSON.stringify({ version: adapter, sources: [source], writable: [source], checks: [check] }),
      'specs/product-sdd.md': `${id} 产品规格`, 'specs/development-sdd.md': `${id} 开发规格`, 'specs/test-sdd.md': `${id} 测试规格`,
      [source]: python ? 'def fixture_value():\n    return 1\n' : 'export const initial = 0;\n',
      [check]: python
        ? 'import unittest\nfrom stock import fixture_value\nclass StockTest(unittest.TestCase):\n    def test_stock(self):\n        self.assertEqual(fixture_value(), 1)\n'
        : 'import { test } from "node:test"; import assert from "node:assert/strict"; import { fixtureValue } from "../src/stock.mjs"; test("stock", () => assert.equal(fixtureValue(), 1));\n',
    };
    for (const [path, body] of Object.entries(files)) { mkdirSync(dirname(join(root, path)), { recursive: true }); writeFileSync(join(root, path), body); }
    git(root, 'init', '-q'); const origin = `https://github.com/fixture/${id}.git`; git(root, 'remote', 'add', 'origin', origin); git(root, 'add', '.'); git(root, 'commit', '-qm', 'test: 固定项目');
    return { id, label: id, root, origin, revision: git(root, 'rev-parse', 'HEAD'), adapter, check };
  }
  const projects = [project('team-alpha', false), project('team-beta', true)] as const;
  const config: PracticeConfig = {
    rootDir: process.cwd(), mode: 'fixture', modelId: 'openai/fixture', port: 4111, databaseUrl: `file:${join(directory, 'mastra.db')}`,
    engineeringProjects: projects.map(/** 预期检查与 Adapter 身份独立于注册输入。 */({ id, label, root, origin, revision }) => ({ id, label, root, origin, revision })),
  };
  const actor = { reviewer: 'fixture-owner', comment: '确认当前项目' };
  /** 所有来源查询都显式选择消费方项目。 */
  const selected = (index: number) => selectProjectConfig(config, projects[index]!.id);
  let app = createStudioApplicationOptions(config);
  let mastra = new Mastra(app);
  try {
    const product = app.workflows.productTeamRun;
    const runs = await Promise.all(projects.map(async item => {
      const run = await product.createRun();
      const result = await run.start({ inputData: { version: 'team-run-input.v1', team: 'product', projectId: item.id, iterationId: 'parallel', brief: `${item.id} 合成需求`, intakeMode: 'autofill' } });
      assert.equal(result.status, 'suspended');
      return run;
    }));
    const pending = await Promise.all(runs.map(run => readIntake(product, run.runId, config)));
    assert.deepEqual(pending.map(item => item.projectId), projects.map(item => item.id));
    await Promise.all(pending.map((item, index) => respondIntake(product, 'fixture', runs[index]!.runId, { reviewer: 'fixture-owner', comment: '确认当前项目', role: 'product', artifactHash: item.product!.artifact.hash, decision: 'approve' }, config)));
    const sources = await Promise.all(runs.map((run, index) => resolveTeamSource(mastra, selectProjectConfig(config, projects[index]!.id), 'development', { workflow: 'productTeamRun', runId: run.runId })));
    assert.deepEqual(sources.map(source => source.product!.correlation!.projectId), projects.map(item => item.id));
    await assert.rejects(resolveTeamSource(mastra, selectProjectConfig(config, projects[1]!.id), 'development', { workflow: 'productTeamRun', runId: runs[0]!.runId }), /绑定已变化/);
    await assert.rejects(resolveTeamSource(mastra, selectProjectConfig(config, projects[0]!.id), 'development', { workflow: 'productTeamRun', runId: runs[0]!.runId }, '0'.repeat(64)), /版本已变化/);
    const development = app.workflows.developmentTeamRun;
    const devRuns = await Promise.all(projects.map(async (item, index) => {
      const run = await development.createRun();
      const result = await run.start({ inputData: { version: 'team-run-input.v1', team: 'development', projectId: item.id, iterationId: 'parallel', source: { workflow: 'productTeamRun', runId: runs[index]!.runId, hash: sources[index]!.hash } } });
      assert.equal(result.status, 'suspended', JSON.stringify(result));
      return run;
    }));
    const before = await Promise.all(devRuns.map(run => readIntake(development, run.runId, config)));
    assert.deepEqual(before.map(item => item.projectId), projects.map(item => item.id));
    assert.ok(before.every(item => item.gate?.key === 'confirm-project-scope'));
    await app.storage.close();
    app = createStudioApplicationOptions(config); mastra = new Mastra(app);
    const store = (await app.storage.getStore('workflows'))!;
    const productSnapshot = (await store.loadWorkflowSnapshot({ workflowName: teamWorkflowIds.product, runId: runs[0]!.runId }))!;
    const productStep = productSnapshot.context['product-team'];
    assert.ok(productStep && 'output' in productStep);
    const productOutput = productStep.output;
    const originalBrief = productOutput.brief;
    productOutput.brief = '变更后的来源需求';
    await store.persistWorkflowSnapshot({ workflowName: teamWorkflowIds.product, runId: runs[0]!.runId, snapshot: productSnapshot });
    const sourceDriftRun = await app.workflows.developmentTeamRun.createRun({ runId: devRuns[0]!.runId });
    await assert.rejects(sourceDriftRun.resume({ resumeData: {} }), /来源版本已变化/);
    assert.equal((await app.workflows.developmentTeamRun.getWorkflowRunById(devRuns[0]!.runId))!.status, 'suspended');
    productOutput.brief = originalBrief;
    await store.persistWorkflowSnapshot({ workflowName: teamWorkflowIds.product, runId: runs[0]!.runId, snapshot: productSnapshot });
    const saved = (await store.loadWorkflowSnapshot({ workflowName: teamWorkflowIds.development, runId: devRuns[0]!.runId }))!;
    const initialization = saved.context['initialize-team-run'];
    assert.ok(initialization && 'output' in initialization);
    const correlation = initialization.output.correlation;
    const originalHash = correlation.adapterProfileHash;
    correlation.adapterProfileHash = '0'.repeat(64);
    await store.persistWorkflowSnapshot({ workflowName: teamWorkflowIds.development, runId: devRuns[0]!.runId, snapshot: saved });
    const restored = await app.workflows.developmentTeamRun.createRun({ runId: devRuns[0]!.runId });
    await assert.rejects(restored.resume({ resumeData: {} }), /Adapter 绑定已变化/);
    const unchanged = await app.workflows.developmentTeamRun.getWorkflowRunById(devRuns[0]!.runId);
    assert.equal(unchanged!.status, 'suspended');
    assert.equal((unchanged!.steps!['initialize-team-run'] as any).output.correlation.adapterProfileHash, '0'.repeat(64));
    correlation.adapterProfileHash = originalHash;
    await store.persistWorkflowSnapshot({ workflowName: teamWorkflowIds.development, runId: devRuns[0]!.runId, snapshot: saved });

    // 用独立进程实际启动另一位置的 Node，可执行文件路径变化，Store 冻结值保持原样。
    const relocatedNode = join(directory, process.platform === 'win32' ? 'node.exe' : 'node');
    copyFileSync(process.execPath, relocatedNode, constants.COPYFILE_FICLONE);
    const { stdout } = await promisify(execFile)(relocatedNode, ['--import', 'tsx', '--input-type=module', '--eval', `
      import assert from 'node:assert/strict';
      import { Mastra } from '@mastra/core';
      import { createStudioApplicationOptions } from './src/mastra/app.ts';
      const [serializedConfig, runId] = process.argv.slice(1);
      const config = JSON.parse(serializedConfig);
      const app = createStudioApplicationOptions(config);
      new Mastra(app);
      try {
        await app.storage.init();
        const workflow = app.workflows.developmentTeamRun;
        const run = await workflow.createRun({ runId });
        await assert.rejects(run.resume({ resumeData: {} }), /Adapter 绑定已变化/);
        assert.equal((await workflow.getWorkflowRunById(runId)).status, 'suspended');
        console.log('adapter-runtime-drift-rejected');
      } finally { await app.storage.close(); }
    `, JSON.stringify(config), devRuns[0]!.runId], { timeout: 45000 });
    assert.match(stdout, /adapter-runtime-drift-rejected/);

    const other = await readIntake(app.workflows.developmentTeamRun, devRuns[1]!.runId, config);
    assert.equal(other.gate?.gateHash, before[1]!.gate!.gateHash);

    const resumed = app.workflows.developmentTeamRun;
    const router = new Hono();
    for (const route of app.server.apiRoutes) if ('handler' in route) router.on(route.method, route.path, route.handler as Handler);
    const headers = { 'content-type': 'application/json', origin: 'http://127.0.0.1:4112' };
    const login = await router.request('/intake-api/account', { method: 'POST', headers, body: JSON.stringify({ username: actor.reviewer, password: 'fixture-local-account-password' }) });
    assert.equal(login.status, 200);
    const cookie = login.headers.get('set-cookie')?.split(';', 1)[0];
    assert.ok(cookie);
    const approvals = await Promise.all(devRuns.map(/** 从保存的原生关口并发确认各项目的登记范围。 */async (run, index) => {
      const current = await readIntake(resumed, run.runId, config);
      assert.equal(current.gate?.gateHash, before[index]!.gate!.gateHash);
      const { catalog } = loadEngineeringProject(selected(index).engineeringProject!);
      /** 通过团队 HTTP 入口提交目录散列，由服务端装配登记候选。 */
      const submit = (catalogHash: string) => router.request(`/intake-api/teams/development/runs/${run.runId}/respond`, { method: 'POST', headers: { ...headers, cookie }, body: JSON.stringify({ gateHash: current.gate!.gateHash, repositoryScope: { comment: actor.comment, catalogHash } }) });
      const otherCatalog = loadEngineeringProject(selected(1 - index).engineeringProject!).catalog;
      assert.equal((await submit(otherCatalog.catalogHash)).status, 409);
      const response = await submit(catalog.catalogHash);
      assert.equal(response.status, 200, await response.clone().text());
      return response.json();
    }));
    await Promise.all(approvals.map(/** 仅批准同一 Run 在当前关口保存的架构版本。 */async (current, index) => {
      assert.equal(current.gate?.key, 'approve-architecture', JSON.stringify(current));
      const completed = await respondIntake(resumed, 'fixture', devRuns[index]!.runId, { gateHash: current.gate!.gateHash, data: { ...actor, ...current.gate!.fixed, decision: 'approve', resolutions: [] } }, config);
      assert.equal(completed.outcome, 'development-delivered', JSON.stringify(completed));
    }));

    const testing = app.workflows.testingTeamRun;
    const qaRuns = await Promise.all(devRuns.map(/** 从各自研发交付启动测试，并执行该项目登记的保护检查。 */async (run, index) => {
      const developmentRef = { workflow: 'developmentTeamRun', runId: run.runId } as const;
      await assert.rejects(resolveTeamSource(mastra, selected(1 - index), 'testing', developmentRef), /绑定已变化/);
      const source = await resolveTeamSource(mastra, selected(index), 'testing', developmentRef);
      const project = projects[index]!;
      assert.equal(source.development!.input.correlation?.adapterId, project.adapter);
      const qa = await testing.createRun();
      const started = await qa.start({ inputData: { version: 'team-run-input.v1', team: 'testing', projectId: project.id, iterationId: 'parallel', source: { ...developmentRef, hash: source.hash } } });
      assert.equal(started.status, 'suspended', JSON.stringify(started));
      let current = await readIntake(testing, qa.runId, config);
      assert.equal(current.gate?.key, 'approve-test-cases');
      const evidence = current.gate!.evidence;
      assert.ok(evidence.registeredChecks.includes(`test:${project.check}`));
      assert.ok(!evidence.registeredChecks.includes(`test:${projects[1 - index]!.check}`));
      current = await respondIntake(testing, 'fixture', qa.runId, { gateHash: current.gate!.gateHash, data: { ...actor, ...current.gate!.fixed, decision: 'approve', cases: [{ id: 'stock', requirementRefs: evidence.requirements.map(/** 覆盖当前项目的结构化需求。 */(item: { id: string }) => item.id), expected: '保护检查通过', method: 'registered-check', checkRefs: evidence.registeredChecks }] } }, config);
      assert.equal(current.gate?.key, 'review-test-results', JSON.stringify(current));
      current = await respondIntake(testing, 'fixture', qa.runId, { gateHash: current.gate!.gateHash, data: { ...actor, ...current.gate!.fixed, decision: 'pass', manualResults: [], findings: [] } }, config);
      assert.equal(current.status, 'success', JSON.stringify(current));
      return { qa, source };
    }));

    const delivery = app.workflows.deliveryTeamRun;
    const qaSnapshot = await store.loadWorkflowSnapshot({ workflowName: teamWorkflowIds.testing, runId: qaRuns[0]!.qa.runId });
    const completedQA = qaSnapshot?.context['test-team'];
    assert.ok(qaSnapshot && completedQA && 'output' in completedQA);
    const quality = completedQA.output.quality;
    const originalReport = quality.reportHash;
    quality.reportHash = '0'.repeat(64);
    await store.persistWorkflowSnapshot({ workflowName: teamWorkflowIds.testing, runId: qaRuns[0]!.qa.runId, snapshot: qaSnapshot });
    try {
      const qaRef = { workflow: 'testingTeamRun', runId: qaRuns[0]!.qa.runId } as const;
      await assert.rejects(resolveTeamSource(mastra, selected(0), 'delivery', qaRef), /同版本 QA 放行/);
    } finally {
      quality.reportHash = originalReport;
      await store.persistWorkflowSnapshot({ workflowName: teamWorkflowIds.testing, runId: qaRuns[0]!.qa.runId, snapshot: qaSnapshot });
    }
    await Promise.all(qaRuns.map(/** 交付只消费本项目的同版本 QA，并复核三份候选归属和内容。 */async ({ qa, source }, index) => {
      const qaRef = { workflow: 'testingTeamRun', runId: qa.runId } as const;
      await assert.rejects(resolveTeamSource(mastra, selected(1 - index), 'delivery', qaRef), /绑定已变化/);
      const passed = await resolveTeamSource(mastra, selected(index), 'delivery', qaRef);
      assert.ok(passed.lifecycle!.quality.checks.some(/** 实际检查须成功退出并使用本项目的登记 ID。 */check => check.id === `test:${projects[index]!.check}` && check.exitCode === 0));
      const run = await delivery.createRun();
      const started = await run.start({ inputData: { version: 'team-run-input.v1', team: 'delivery', projectId: projects[index]!.id, iterationId: 'parallel', source: { ...qaRef, hash: passed.hash } } });
      assert.equal(started.status, 'success', JSON.stringify(started));
      assert.equal(started.result.outcome, 'fixture-completed');
      const candidates = [source.development!, passed.development!, started.result.development];
      assert.deepEqual(candidates.map(/** 候选所有权必须随团队 Run 转移。 */state => state.input.source.runId), [devRuns[index]!.runId, qa.runId, run.runId]);
      for (const state of candidates) {
        assert.equal(state.input.correlation.projectId, projects[index]!.id);
        const execution = executionResolver(selected(index), { requireExisting: true })(state.input);
        try { assert.equal(developmentHash(await execution.snapshot()), source.development!.checkpointHash); }
        finally { await execution.close(); }
      }
    }));
  } finally { await app.storage.close(); rmSync(directory, { recursive: true, force: true }); }
});
