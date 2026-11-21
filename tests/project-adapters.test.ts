import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { loadEngineeringProject } from '../src/business-engineering/project.js';
import { createDevelopmentExecution } from '../src/development/hrm-execution.js';
import { seedDevelopment } from '../src/development-service.js';
import { developmentHash } from '../src/development/contracts.js';
import { inputV2Schema, registeredChecks } from '../src/development/v2/contracts.js';
import { createStudioApplicationOptions } from '../src/mastra/app.js';
import { Mastra } from '@mastra/core';
import { Hono, type Handler } from 'hono';
import { randomUUID } from 'node:crypto';
import { adapterChecks, adapterImplementationIdentity } from '../src/business-engineering/adapters.js';

test('Python Adapter 从固定 Git 版本装配并在隔离候选中实际运行保护检查', async () => {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'python-adapter-')));
  const repository = join(directory, 'repository');
  mkdirSync(repository);
  /** 只操作本测试创建的临时仓库。 */
  function git(...args: string[]) {
    return execFileSync('git', ['-C', repository, '-c', 'core.hooksPath=/dev/null', '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  }
  try {
    const files = {
      'AGENTS.md': '项目规则：保持纯函数。\n',
      'specs/engineering.json': JSON.stringify({ version: 'python-unittest.v1', sources: ['src/stock.py'], writable: ['src/stock.py'], checks: ['tests/test_stock.py'] }),
      'specs/product-sdd.md': '库存业务规格。', 'specs/development-sdd.md': '库存开发规格。', 'specs/test-sdd.md': '库存测试规格。',
      'src/stock.py': 'def fixture_value():\n    return 1\n',
      'tests/test_stock.py': 'import unittest\nfrom stock import fixture_value\nclass StockTest(unittest.TestCase):\n    def test_stock(self):\n        self.assertEqual(fixture_value(), 1)\n',
    };
    for (const [path, body] of Object.entries(files)) { mkdirSync(dirname(join(repository, path)), { recursive: true }); writeFileSync(join(repository, path), body); }
    git('init', '-q'); git('remote', 'add', 'origin', 'https://example.invalid/python.git'); git('add', 'AGENTS.md', 'specs', 'src', 'tests'); git('commit', '-qm', 'test: 固定 Python 工程');
    const project = loadEngineeringProject({ id: 'python-stock', label: 'Python 库存', root: repository, origin: 'https://example.invalid/python.git', revision: git('rev-parse', 'HEAD') });
    assert.equal(project.candidate.adapterId, 'python-unittest.v1');
    const implementation = adapterImplementationIdentity('python-unittest.v1');
    assert.match(implementation.runtime.version, /^Python \d+\.\d+\.\d+/);
    assert.match(implementation.runtime.sha256, /^[a-f0-9]{64}$/);
    assert.deepEqual(adapterChecks('python-unittest.v1', ['src/stock.py'], ['tests/test_stock.py'], 25000).map(check => check.id), ['syntax:src/stock.py', 'test:tests/test_stock.py']);
    assert.deepEqual(project.candidate.instructionFiles, ['AGENTS.md']);
    const content = '合成库存需求';
    const input = inputV2Schema.parse({ source: { kind: 'evaluation', runId: 'python-adapter', content, hash: developmentHash(content), evidence: 'evaluation-input' }, project: project.candidate });
    const candidate = join(directory, 'run');
    seedDevelopment(candidate, input);
    const execution = createDevelopmentExecution(join(candidate, 'candidate'), input.project);
    try {
      const results = await execution.runChecks();
      assert.deepEqual(results.map(item => item.id), registeredChecks(input));
      assert.ok(results.every(item => item.exitCode === 0), JSON.stringify(results));
      assert.match(results[1]!.stderr, /test_stock/);
      await assert.rejects(execution.writeFile('tests/test_stock.py', 'pass'), /白名单/);
    } finally { await execution.close(); }
    const config = { rootDir: process.cwd(), mode: 'fixture' as const, modelId: 'openai/fixture' as const, port: 4111, databaseUrl: `file:${join(directory, 'workflow.db')}`, engineeringProject: { id: 'python-stock', label: 'Python 库存', root: repository, origin: 'https://example.invalid/python.git', revision: git('rev-parse', 'HEAD') } };
    const app = createStudioApplicationOptions(config);
    new Mastra(app);
    const router = new Hono();
    for (const route of app.server.apiRoutes) if ('handler' in route) router.on(route.method, route.path, route.handler as Handler);
    const runId = randomUUID();
    const actor = { reviewer: 'fixture', comment: '确认测试项目' };
    /** 从工作台 HTTP 入口推进真实原生 Workflow 和人工关口。 */
    async function post(path: string, body: unknown) {
      const response = await router.request(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      assert.equal(response.status, 200, await response.clone().text());
      return response.json();
    }
    const endpoint = `/intake-api/runs/${runId}/respond`;
    try {
      let current = await post('/intake-api/runs', { runId, brief: '合成 Python 库存需求', iterationId: 'stock', intakeMode: 'autofill' });
      current = await post(endpoint, { ...actor, role: 'product', artifactHash: current.product.artifact.hash, decision: 'approve' });
      current = await post(endpoint, { gateHash: current.gate.gateHash, repositoryScope: { ...actor, catalogHash: project.catalog.catalogHash } });
      assert.equal(current.gate?.key, 'approve-architecture', JSON.stringify(current));
      current = await post(endpoint, { gateHash: current.gate.gateHash, data: { ...actor, ...current.gate.fixed, decision: 'approve', resolutions: [] } });
      assert.equal(current.gate?.key, 'approve-test-cases', JSON.stringify(current));
      const evidence = current.gate.evidence;
      current = await post(endpoint, { gateHash: current.gate.gateHash, data: { ...actor, ...current.gate.fixed, decision: 'approve', cases: [{ id: 'stock', requirementRefs: evidence.requirements.map((item: { id: string }) => item.id), expected: '库存检查通过', method: 'registered-check', checkRefs: evidence.registeredChecks }] } });
      assert.equal(current.gate?.key, 'review-test-results', JSON.stringify(current));
      assert.match(JSON.stringify(current.gate.evidence), /test_stock/);
      current = await post(endpoint, { gateHash: current.gate.gateHash, data: { ...actor, ...current.gate.fixed, decision: 'pass', manualResults: [], findings: [] } });
      assert.equal(current.outcome, 'fixture-completed');
    } finally { await app.storage.close(); }
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
