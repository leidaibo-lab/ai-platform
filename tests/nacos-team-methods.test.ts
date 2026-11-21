/** 全团队方法的真实 ZIP、原生 Store/Agent/Workflow 与撤权边界回归。 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createServer } from 'node:http';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Mastra } from '@mastra/core';
import { LibSQLStore } from '@mastra/libsql';
import { prepareTeamMethods } from '../scripts/prepare-nacos-team-methods.js';
import { defaultMethodBindings, assertCompleteMethods, methodPrompt, methodSkill } from '../src/mastra/team-methods.js';
import { loadNacosSnapshot, verifyTeamMethods, validateTeamMethods, verifyNacosAccess, type NacosResourceConfig } from '../src/mastra/nacos-resources.js';
import { createAgents } from '../src/mastra/agents/index.js';
import { inputV2Schema, stateV2Schema } from '../src/development/v2/contracts.js';
import { loadDevelopmentMethods } from '../src/development/v2/methods.js';
import { createDevelopmentWorkflowV2 } from '../src/mastra/workflows/development-v2.js';
import { createAgentV2 } from '../src/development/v2/agents.js';
import { DevelopmentExecution } from '../src/development-execution.js';
import { seedDevelopment } from '../src/development-service.js';
import { developmentHash } from '../src/development/contracts.js';
import { loadBrowserMethod } from '../src/browser-qa/method.js';
import { executeBrowserAgent } from '../src/browser-qa/agent.js';
import { readNacosConfig, type PracticeConfig } from '../src/mastra/config.js';

test('统一目录贯穿真实方法调用、恢复身份与撤权；准备候选不发布', async () => {
  const root = resolve('.'); const temp = mkdtempSync(join(tmpdir(), 'team-nacos-')); const output = join(temp, 'candidate');
  const manifest = await prepareTeamMethods(root, output, '1.0.0');
  assert.equal(manifest.skills.length, 6); assert.ok(manifest.prompts.length >= 44);
  await assert.rejects(prepareTeamMethods(root, output, '1.0.0'), /拒绝覆盖/);
  assert.equal(manifest.status, 'prepared-not-reviewed-or-published');
  const prompts = new Map(manifest.prompts.map(prompt => [prompt.name, readFileSync(prompt.source, 'utf8')]));
  const archives = new Map<string, Buffer>(manifest.skills.map(skill => [skill.name, readFileSync(join(output, skill.archive))]));
  const testingName = defaultMethodBindings('1.0.0').prompts['mastra.agents.index.1'].name;
  prompts.set(testingName, '远端测试职责：只做独立分析，不执行命令。');
  let revoked = false; let missing = false; let drift = false; const versions: string[] = [];
  const server = createServer((req, res) => {
    const url = new URL(req.url!, 'http://localhost');
    if (url.pathname.endsWith('/login')) { res.end(JSON.stringify({ accessToken: 'fixture-only' })); return; }
    if (revoked) { res.writeHead(403).end(); return; }
    const version = url.searchParams.get('version')!; versions.push(version);
    if (url.pathname.endsWith('/prompt')) {
      const name = url.searchParams.get('promptKey')!;
      if (missing && name === testingName) { res.writeHead(404).end(); return; }
      const text = prompts.get(name) ?? '产品角色原版本方法';
      res.end(JSON.stringify({ code: 0, data: { promptKey: name, version, template: text + (drift && name === testingName ? '漂移' : '') } })); return;
    }
    if (url.pathname.endsWith('/skills')) {
      const archive = archives.get(url.searchParams.get('name')!);
      if (!archive) { res.writeHead(404).end(); return; }
      res.setHeader('x-nacos-skill-resolved-version', version); res.end(archive); return;
    }
    res.writeHead(404).end();
  });
  await new Promise<void>(done => server.listen(0, '127.0.0.1', done));
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  const nacosResources: NacosResourceConfig = { url: `http://127.0.0.1:${address.port}`, namespace: 'public', username: 'fixture', password: 'fixture', promptName: 'manager', promptVersion: '1.0.0', skillName: 'development-bmad-context', skillVersion: '1.0.0', methods: defaultMethodBindings('1.0.0') };
  try {
    const snapshot = await loadNacosSnapshot(nacosResources); const catalog = assertCompleteMethods(snapshot.methods!);
    assert.match(methodPrompt('mastra.agents.index.1', catalog), /远端测试职责/);
    assert.equal(JSON.stringify(snapshot).includes('fixture-only'), false);
    assert.throws(() => methodPrompt('mastra.agents.index.1', { ...catalog, prompts: {} }), /缺少/);
    assert.throws(() => validateTeamMethods({ ...catalog, namespace: 'other' }), /摘要/);
    const config: PracticeConfig = { rootDir: root, mode: 'fixture', databaseUrl: `file:${join(temp, 'workflow.db')}`, port: 4111, modelId: 'openai/fixture', nacosResources };
    const agents = createAgents(config, { resources: snapshot, workspace: false });
    assert.match(JSON.stringify(await agents.testingAgent.getInstructions()), /远端测试职责/);
    assert.deepEqual(Object.keys(await agents.testingAgent.listTools()), []);
    assert.equal(methodSkill(catalog, 'review').name, 'development-bmad-code-review');
    assert.equal(loadBrowserMethod(root, catalog).hash, catalog.sha256);
    const input = inputV2Schema.parse({ teamMethods: catalog, source: { kind: 'evaluation', runId: 'team-catalog', hash: developmentHash('实现返回值1'), content: '实现返回值1', evidence: 'evaluation-input' }, project: { id: 'catalog', roles: ['backend'], files: { 'src/a.mjs': 'export function fixtureValue(){return 0;}', 'check.mjs': 'import {test} from "node:test"; test("loaded",()=>{});' }, writablePaths: ['src/a.mjs'], checkFiles: ['check.mjs'] }, maxReworks: 2 });
    seedDevelopment(join(temp, 'run'), input);
    const execution = new DevelopmentExecution(join(temp, 'run', 'candidate'), input.project.writablePaths, input.project.checkFiles);
    const store = new LibSQLStore({ id: 'team-catalog-test', url: config.databaseUrl });
    const workflow = createDevelopmentWorkflowV2(config, execution, true, undefined, { team: true });
    new Mastra({ storage: store, workflows: { workflow } });
    let runId: string;
    try {
      await store.init(); const run = await workflow.createRun(); runId = run.runId;
      const result = await run.start({ inputData: input });
      assert.equal(result.status, 'success', JSON.stringify(result));
      const state = stateV2Schema.parse(result.result);
      assert.equal(state.methodBundleHash, catalog.sha256);
      assert.equal(state.outcome, 'development-delivered');
      const tools = Object.keys(await createAgentV2(config, execution, 'reviewer', state, [], loadDevelopmentMethods(root)).listTools());
      assert.ok(!tools.includes('writeFile') && !tools.includes('runChecks'));
      const browser = await executeBrowserAgent(config, [{ caseId: 'page', caseHash: developmentHash('case'), sourceHash: developmentHash('source'), methodHash: catalog.sha256, files: { 'index.html': '<h1>统一方法</h1>' }, supported: true, browser: { entry: 'index.html', assets: [], actions: [], assertions: [{ selector: 'h1', text: '统一方法' }] } }], catalog);
      assert.equal(browser.receipts[0].status, 'passed', JSON.stringify(browser));
    } finally { await execution.close(); await store.close(); }
    const reopened = new LibSQLStore({ id: 'team-catalog-reopen', url: config.databaseUrl });
    try {
      await reopened.init(); const saved = await (await reopened.getStore('workflows'))!.loadWorkflowSnapshot({ workflowName: workflow.id, runId: runId! });
      assert.ok(JSON.stringify(saved).includes(catalog.sha256));
    } finally { await reopened.close(); }
    versions.length = 0;
    await verifyNacosAccess({ ...nacosResources, methods: defaultMethodBindings('9.9.9'), promptVersion: '9.9.9' }, snapshot);
    assert.ok(versions.length >= manifest.prompts.length + manifest.skills.length && versions.every(version => version === '1.0.0'));
    drift = true; await assert.rejects(verifyTeamMethods(nacosResources, catalog), /漂移/); drift = false;
    missing = true; await assert.rejects(verifyTeamMethods(nacosResources, catalog), /404/); missing = false;
    revoked = true; await assert.rejects(verifyTeamMethods(nacosResources, catalog), /403/);
  } finally { await new Promise<void>((done, reject) => server.close(error => error ? reject(error) : done())); }
});

test('环境绑定选择明确版本，旧配置仍可用于历史快照', () => {
  const base = { NACOS_URL: 'http://127.0.0.1:8848', NACOS_NAMESPACE: 'public', NACOS_USERNAME: 'fixture', NACOS_PASSWORD: 'fixture', NACOS_PROMPT_NAME: 'manager', NACOS_PROMPT_VERSION: '1.0.0', NACOS_SKILL_NAME: 'primary', NACOS_SKILL_VERSION: '1.0.0' };
  assert.equal(readNacosConfig(base)?.methods, undefined);
  assert.equal(readNacosConfig({ ...base, NACOS_TEAM_METHOD_VERSION: '1.0.0' })?.methods?.skills.browser.version, '1.0.0');
  assert.throws(() => readNacosConfig({ ...base, NACOS_TEAM_METHODS: '{}' }), /格式无效/);
});

test('团队候选可由本机注册器核验，同版本内容不同则拒绝', async () => {
  const temp = mkdtempSync(join(tmpdir(), 'team-publish-')); const output = join(temp, 'candidate');
  const manifest = await prepareTeamMethods(resolve('.'), output, '1.0.0');
  const prompt = manifest.prompts[0];
  writeFileSync(join(output, 'manifest.json'), JSON.stringify({ ...manifest, prompts: [prompt], skills: [] }));
  let remote = readFileSync(prompt.source, 'utf8'); let writes = 0;
  const server = createServer((req, res) => {
    const url = new URL(req.url!, 'http://localhost');
    if (url.pathname.endsWith('/login')) { res.end(JSON.stringify({ accessToken: 'fixture' })); return; }
    if (url.pathname.endsWith('/client/ai/prompt')) { res.end(JSON.stringify({ code: 0, data: { promptKey: prompt.name, version: prompt.version, template: remote } })); return; }
    writes++; res.writeHead(500).end();
  });
  await new Promise<void>(done => server.listen(0, '127.0.0.1', done));
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  const port = address.port;
  /** 在独立进程运行现有注册器，让模拟服务处理请求。 */
  async function run() {
    const child = spawn(process.execPath, ['--import', 'tsx', 'scripts/register-nacos-product-resources.ts', output, '--apply'], { cwd: resolve('.'), env: { ...process.env, NACOS_PUBLISH_URL: `http://127.0.0.1:${port}`, NACOS_PUBLISH_NAMESPACE: 'fixture', NACOS_PUBLISH_USERNAME: 'fixture', NACOS_PUBLISH_PASSWORD: 'fixture' }, stdio: 'ignore' });
    return await new Promise<number | null>(done => child.on('close', done));
  }
  try {
    assert.equal(await run(), 0); assert.equal(writes, 0);
    remote = '同版本内容冲突'; assert.notEqual(await run(), 0); assert.equal(writes, 0);
  } finally { await new Promise<void>(done => server.close(() => done())); }
});
