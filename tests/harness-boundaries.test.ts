import { randomUUID } from 'node:crypto';
import { Hono, type Handler } from 'hono';
import { Mastra } from '@mastra/core';
import { assertProjectCorrelation, loadEngineeringProject, projectSpec } from '../src/business-engineering/project.js';
import { createStudioApplicationOptions } from '../src/mastra/app.js';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { test } from 'node:test';
import { compareAcceptanceRequirements, readAcceptanceRequirements } from '../src/business-engineering/acceptance-requirements.js';
import { contentHash, formalRunBranch } from '../src/delivery/remote-handoff.js';
import { buildSuccessorBaseline } from '../src/intake/successor-run.js';
import { waitForWorkflowToSettle } from '../src/mastra/platform/workflow-recovery.js';
import { deliverySchema, type Delivery } from '../src/mastra/workflows/delivery.js';
import { productManagerStages } from '../src/mastra/workflows/product-contract.js';
import { planProductRework, prepareProductRework } from '../src/mastra/workflows/product-rework.js';

const runId = 'a84353b9-e22c-4ea9-b412-c6f28800c567';
const draft: Delivery = { brief: '处理业务条目', mode: 'live', artifacts: [], reviews: [], outcome: 'in-progress' };

test('业务工程可只更换 Git 规格和用例，团队使用相同的版本读取和影响规则', () => {
  const directory = mkdtempSync(join(tmpdir(), 'harness-engineering-'));
  const productPath = 'specs/product-spec.md';
  const testPath = 'specs/test-spec.md';
  try {
    /** 在每个合成项目仓库提交版本，再走正式规格回执读取入口。 */
    function readSpec(project: string, repository: string, content: string, cases: { id: string; requirementRefs: string[] }[]) {
      /** 只对测试创建的本地仓库执行 Git 命令。 */
      function git(...args: string[]) {
        return execFileSync('git', ['-C', repository, '-c', 'core.hooksPath=/dev/null', '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
      }
      const files = { [productPath]: content, [testPath]: JSON.stringify({ cases }) + '\n' };
      for (const [path, body] of Object.entries(files)) writeFileSync(join(repository, path), body);
      git('add', productPath, testPath);
      git('commit', '-m', 'test(spec): 保存合成业务规格');
      const commit = git('rev-parse', 'HEAD');
      const branch = formalRunBranch(project, runId);
      const source: Delivery = {
        ...draft,
        formalSpecifications: [
          { kind: 'product', paths: [productPath], upstreamCommits: [], handoff: { version: 'remote-handoff.v1', branch, commit, files: { [productPath]: contentHash(files[productPath]) } } },
          { kind: 'testing', paths: [testPath], upstreamCommits: [], handoff: { version: 'remote-handoff.v1', branch, commit, files: { [testPath]: contentHash(files[testPath]) } } },
        ],
      };
      const [product, testing] = buildSuccessorBaseline(repository, runId, source, ['product', 'testing'], '修改本期业务规则').artifacts;
      assert.equal(product.commit, commit);
      assert.equal(testing.commit, commit);
      return { hash: product.hash, requirements: readAcceptanceRequirements(product.content), cases: (JSON.parse(testing.content) as { cases: typeof cases }).cases };
    }

    for (const scenario of [
      { project: 'recruitment', rule: 'REQ-SCREEN', baseline: '人工初筛', expected: '可筛选候选人', updated: '可记录初筛意见', testCase: 'screen-notes' },
      { project: 'warehouse', rule: 'REQ-STOCK', baseline: '库存盘点', expected: '可列出盘点项', updated: '可登记库存差异', testCase: 'stock-difference' },
    ]) {
      const repository = join(directory, scenario.project);
      mkdirSync(join(repository, 'specs'), { recursive: true });
      execFileSync('git', ['init', '-q', repository]);
      const cases = [{ id: scenario.testCase, requirementRefs: [scenario.rule] }];
      const before = readSpec(scenario.project, repository, `- ${scenario.rule}: ${scenario.baseline} | 验收: ${scenario.expected}\n`, cases);
      const after = readSpec(scenario.project, repository, `- ${scenario.rule}: ${scenario.baseline} | 验收: ${scenario.updated}\n`, cases);
      const impact = compareAcceptanceRequirements(before, after, before.cases);
      assert.deepEqual(impact.changed, [scenario.rule]);
      assert.deepEqual(impact.affectedCaseIds, [scenario.testCase]);
      assert.equal(impact.productHash, after.hash);
      assert.notEqual(after.hash, before.hash);
    }
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('产品团队可改变返工起点，复用同一份规格输入和上游产物', async () => {
  const source: Delivery = { ...draft, productWork: { version: 'product-graph.v1', entries: productManagerStages.map(role => ({ role, content: role, modelSteps: 1, toolNames: [] })) } };
  const rework = { sourceRunId: runId, sourceHash: contentHash('来源稿'), reviewer: 'fixture', feedback: '调整首期规则', round: 1 };
  const memoryScopes: { thread: string; resource: string }[] = [];
  const writing = await planProductRework(source, rework.feedback, /** 捕获调用参数并模拟仅修改表述的分类结果。 */ async (_prompt, options) => {
    memoryScopes.push(options.memory);
    return { target: 'writing', reason: '只需更正表述' };
  });
  const scope = await planProductRework(source, rework.feedback, /** 捕获第二次调用的独立记忆范围。 */ async (_prompt, options) => {
    memoryScopes.push(options.memory);
    return { target: 'scope-priority', reason: '需重做范围结论' };
  });
  assert.equal(memoryScopes.length, 2);
  for (const memory of memoryScopes) {
    assert.match(memory.thread, /^invocation-/);
    assert.match(memory.resource, /^task-/);
  }
  assert.notEqual(memoryScopes[0]!.thread, memoryScopes[1]!.thread);
  assert.notEqual(memoryScopes[0]!.resource, memoryScopes[1]!.resource);
  const narrow = prepareProductRework(source, rework, writing);
  const broad = prepareProductRework(source, rework, scope);
  assert.equal(narrow.step.at(-1), 'product-writing');
  assert.equal(broad.step.at(-1), 'product-scope-priority');
  assert.deepEqual(narrow.input.productWork?.entries, source.productWork?.entries.slice(0, 3));
  assert.deepEqual(broad.input.productWork?.entries, source.productWork?.entries.slice(0, 2));
  assert.equal(narrow.input.productRework.sourceHash, broad.input.productRework.sourceHash);
});

test('平台可调整等待恢复的时机，凭原生状态识别暂停和超时', async () => {
  const checkpoint = { status: 'suspended', checkpoint: 'persisted' };
  let reads = 0;
  /** 模拟同一快照读取接口在第一次观察后完成持久化。 */
  async function readSnapshot() { return reads++ ? checkpoint : { status: 'running' }; }
  assert.deepEqual(await waitForWorkflowToSettle(readSnapshot, { timeoutMs: 0 }), { settled: false });
  reads = 0;
  assert.deepEqual(await waitForWorkflowToSettle(readSnapshot, { intervalMs: 1 }), { settled: true, snapshot: checkpoint });
  assert.deepEqual(await waitForWorkflowToSettle(async () => ({ status: 'failed' })), { settled: true, snapshot: { status: 'failed' } });
});

test('登记的库存项目从正常工作台入口进入研发和测试，并运行固定 Git 版本的保护检查', async () => {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'warehouse-workflow-')));
  const origin = 'https://example.invalid/warehouse.git';
  const check = 'test/stock.test.mjs';
  /** 只在临时仓库写合成文件和提交。 */
  function git(...args: string[]) {
    return execFileSync('git', ['-C', directory, '-c', 'core.hooksPath=/dev/null', '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  }
  const files = {
    'specs/engineering.json': JSON.stringify({ version: 'node-test.v1', sources: ['src/stock.mjs'], writable: ['src/stock.mjs'], checks: [check] }),
    'specs/product-sdd.md': '库存范围以仓内差异为准。',
    'specs/development-sdd.md': '库存计算采用纯函数。',
    'specs/test-sdd.md': '库存差异覆盖正常和异常输入。',
    'specs/product-spec.md': '已确认库存产品规格。\n',
    'src/stock.mjs': 'export const initial = 0;\n',
    [check]: 'import { test } from "node:test"; import assert from "node:assert/strict"; import { fixtureValue } from "../src/stock.mjs"; test("stock check", () => assert.equal(fixtureValue(), 1));\n',
  };
  try {
    git('init', '-q'); git('remote', 'add', 'origin', origin);
    for (const [path, body] of Object.entries(files)) {
      mkdirSync(dirname(join(directory, path)), { recursive: true });
      writeFileSync(join(directory, path), body);
    }
    git('add', 'specs', 'src', 'test'); git('commit', '-qm', 'test(spec): 保存库存样例');
    const revision = git('rev-parse', 'HEAD');
    writeFileSync(join(directory, check), 'throw new Error("未提交的检查");\n');
    const engineeringProject = { id: 'warehouse', label: '仓储盘点', root: directory, origin, revision };
    const config = { rootDir: resolve('.'), mode: 'fixture' as const, modelId: 'openai/fixture' as const, port: 4111, databaseUrl: `file:${join(directory, 'workflow.db')}`, engineeringProject };
    const app = createStudioApplicationOptions(config);
    new Mastra(app);
    const router = new Hono();
    for (const route of app.server.apiRoutes) if ('handler' in route) router.on(route.method, route.path, route.handler as Handler);
    const runId = randomUUID();
    const actor = { reviewer: 'test', comment: '验证库存项目授权' };
    /** 使用正常工作台请求推进原生 Run。 */
    function post(body: unknown, start = false) {
      return router.request(`/intake-api/runs${start ? '' : `/${runId}/respond`}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    }
    /** 业务成功时读取当前关口，失败保留真实响应。 */
    async function accepted(body: unknown, start = false) {
      const response = await post(body, start);
      assert.equal(response.status, 200, await response.clone().text());
      return response.json();
    }
    try {
      const catalog = await (await router.request('/intake-api/project')).json();
      assert.equal(catalog.id, 'warehouse');
      assert.equal(catalog.revision, revision);
      for (const [role, path] of [['product', 'product'], ['development', 'development'], ['testing', 'test']] as const) {
        assert.equal(projectSpec(config, role)?.content, files[`specs/${path}-sdd.md`]);
      }
      let current = await accepted({ runId, brief: '合成库存业务', iterationId: 'stock', intakeMode: 'autofill' }, true);
      current = await accepted({ ...actor, role: 'product', artifactHash: current.product.artifact.hash, decision: 'approve' });
      assert.equal(current.gate.key, 'confirm-project-scope');
      const gateHash = current.gate.gateHash;
      const otherProjectCatalog = loadEngineeringProject({ ...engineeringProject, id: 'other' }).catalog;
      assert.equal((await post({ gateHash, repositoryScope: { ...actor, catalogHash: otherProjectCatalog.catalogHash } })).status, 409);
      assert.equal((await post({ gateHash, data: { ...actor, project: { id: 'warehouse', checkFiles: [] } } })).status, 409);
      current = await accepted({ gateHash, repositoryScope: { ...actor, catalogHash: catalog.catalogHash } });
      assert.equal(current.gate?.key, 'approve-architecture', JSON.stringify(current));
      current = await accepted({ gateHash: current.gate.gateHash, data: { ...actor, ...current.gate.fixed, decision: 'approve', resolutions: [] } });
      assert.equal(current.gate?.key, 'approve-test-cases', JSON.stringify(current));
      const evidence = current.gate.evidence;
      assert.ok(evidence.registeredChecks.includes(`test:${check}`));
      current = await accepted({ gateHash: current.gate.gateHash, data: { ...actor, ...current.gate.fixed, decision: 'approve', cases: [{ id: 'stock', requirementRefs: evidence.requirements.map(/** 绑定当前批准的需求。 */(item: { id: string }) => item.id), expected: '登记检查通过', method: 'registered-check', checkRefs: evidence.registeredChecks }] } });
      assert.equal(current.gate?.key, 'review-test-results', JSON.stringify(current));
      assert.match(JSON.stringify(current.gate.evidence), /stock check/);
      const snapshot = await app.workflows.productDevelopmentWorkflow.getWorkflowRunById(runId);
      const initial = snapshot!.steps!['initialize-product-development'];
      assert.ok(!Array.isArray(initial));
      const correlation = deliverySchema.parse(initial.output).correlation;
      assert.equal(correlation?.projectId, 'warehouse');
      assert.equal(correlation?.engineeringRevision, revision);
      assert.throws(() => assertProjectCorrelation({ ...config, engineeringProject: { ...engineeringProject, id: 'other' } }, correlation), /业务工程绑定/);
      const updatedConfig = { ...config, engineeringProject: { ...engineeringProject, revision: '0'.repeat(40) } };
      assert.throws(() => assertProjectCorrelation(updatedConfig, correlation), /业务工程绑定/);
      assert.doesNotThrow(() => assertProjectCorrelation(updatedConfig, correlation, { allowEarlierRevision: true }));
      assert.equal((await (await router.request('/delivery-assets/catalog')).json()).runs[0].correlation.projectId, 'warehouse');
      current = await accepted({ gateHash: current.gate.gateHash, data: { ...actor, ...current.gate.fixed, decision: 'pass', manualResults: [], findings: [] } });
      assert.equal(current.gate, undefined);
      assert.equal(current.outcome, 'fixture-completed');
      assert.equal(current.mergeRequest, undefined);
      assert.equal(current.status, 'success');
      // fixture 不推送，以固定本地提交模拟 live 正式规格回执进入原生 Store。
      const store = (await app.storage.getStore('workflows'))!;
      const workflowName = 'product-development';
      const source = (await store.loadWorkflowSnapshot({ workflowName, runId }))!;
      const path = 'specs/product-spec.md';
      source.result!.development.input.formalSpecifications = [{ kind: 'product', paths: [path], upstreamCommits: [], handoff: { version: 'remote-handoff.v1', branch: formalRunBranch('stock', runId), commit: revision, files: { [path]: contentHash(files[path]) } } }];
      await store.persistWorkflowSnapshot({ workflowName, runId, snapshot: source });
      const successorRequest = { runId: randomUUID(), artifactKinds: ['product'], changeBrief: '调整库存差异规则' };
      const response = await router.request(`/intake-api/runs/${runId}/successors`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(successorRequest) });
      assert.equal(response.status, 200, await response.clone().text());
      const successor = await response.json();
      assert.equal(successor.step, 'guided-requirements');
      assert.equal(successor.successorBaseline.artifacts[0].commit, revision);
    } finally { await app.storage.close(); }
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
