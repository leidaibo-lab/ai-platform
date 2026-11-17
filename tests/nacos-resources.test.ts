/** Nacos 产品资源适配：固定版本、权限失效和快照完整性的隔离回归。 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createServer } from 'node:http';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { loadNacosSnapshot, nacosResourceIdentity, validateNacosSnapshot, verifyNacosAccess } from '../src/mastra/nacos-resources.js';
import { createStudioApplicationOptions } from '../src/mastra/app.js';
import { Mastra } from '@mastra/core';
import { readIntake, respondIntake } from '../src/intake/service.js';
import { createAgents } from '../src/mastra/agents/index.js';
import { readNacosConfig } from '../src/mastra/config.js';
import { LibSQLStore } from '@mastra/libsql';
import { createMockModel } from '@mastra/core/test-utils/llm-mock';
import { nativeInvocationMemory } from '../src/mastra/context-memory.js';
import { createProductDevelopmentWorkflow } from '../src/mastra/workflows/product-development.js';
import { generateV2, type GeneratorV2 } from '../src/development/v2/agents.js';

test('Nacos 默认启用且缺配置时失败，只有显式关闭才使用本地兼容路径', /** 防止缺配置时静默降级。 */() => {
  assert.throws(/** 默认要求 Nacos 的连接与资源信息。 */() => readNacosConfig({}), /Nacos 默认启用/);
  assert.equal(readNacosConfig({ NACOS_RESOURCES_ENABLED: 'false' }), undefined);
  assert.throws(/** 无效开关不能被解释为关闭。 */() => readNacosConfig({ NACOS_RESOURCES_ENABLED: 'no' }));
  const base = { NACOS_URL: 'http://127.0.0.1:8848', NACOS_NAMESPACE: 'public', NACOS_USERNAME: 'fixture', NACOS_PASSWORD: 'fixture', NACOS_PROMPT_NAME: 'product', NACOS_PROMPT_VERSION: '1.0.0', NACOS_SKILL_NAME: 'primary', NACOS_SKILL_VERSION: '1.0.0' };
  const expanded = readNacosConfig({ ...base, NACOS_REVIEW_PROMPT_NAME: 'review', NACOS_REVIEW_PROMPT_VERSION: '2.0.0', NACOS_ADDITIONAL_SKILLS: '[{"name":"extra","version":"1.0.0"}]' });
  assert.equal(expanded?.reviewerPrompt?.name, 'review');
  assert.equal(expanded?.additionalSkills?.[0]?.name, 'extra');
  assert.throws(/** 两个字段不能只提供一个。 */() => readNacosConfig({ ...base, NACOS_REVIEW_PROMPT_NAME: 'review' }), /同时配置/);
  assert.throws(/** 不能重复注册同名方法。 */() => readNacosConfig({ ...base, NACOS_ADDITIONAL_SKILLS: '[{"name":"primary","version":"1.0.0"}]' }), /不能重复/);
  assert.deepEqual(readNacosConfig({ ...base, NACOS_REVIEW_SKILLS: '["primary"]' })?.reviewerSkills, ['primary']);
  assert.throws(/** 不能引用未登记的方法。 */() => readNacosConfig({ ...base, NACOS_REVIEW_SKILLS: '["missing"]' }), /绑定无效/);
});

test('新 Run 冻结 Prompt 与 Skill，授权撤销和篡改均失败关闭', /** 使用真实 ZIP 与本机 HTTP 假服务覆盖调用边界。 */async () => {
  const directory = mkdtempSync(join(tmpdir(), 'nacos-adapter-test-'));
  writeFileSync(join(directory, 'SKILL.md'), '---\nname: sample-skill\ndescription: 本地合成方法\n---\n\n# 方法\n\n读取资料。\n');
  execFileSync('zip', ['-q', 'skill.zip', 'SKILL.md'], { cwd: directory });
  let archive = readFileSync(join(directory, 'skill.zip'));
  const otherDirectory = join(directory, 'other'); mkdirSync(otherDirectory);
  writeFileSync(join(otherDirectory, 'SKILL.md'), '---\nname: review-skill\ndescription: 审查合成方法\n---\n\n# 方法\n\n检查边界。\n');
  execFileSync('zip', ['-q', 'skill.zip', 'SKILL.md'], { cwd: otherDirectory });
  const otherArchive = readFileSync(join(otherDirectory, 'skill.zip'));
  let revoked = false; let promptContent = '原版本提示词'; const requestedPrompts: string[] = [];
  const server = createServer(/** 返回隔离资源；不记录客户端凭据。 */(req, res) => {
    const url = new URL(req.url!, 'http://localhost');
    if (url.pathname.endsWith('/login')) { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ accessToken: 'fixture-token' })); return; }
    if (revoked) { res.writeHead(403).end(); return; }
    if (url.pathname.endsWith('/prompt')) { const name = url.searchParams.get('promptKey')!; requestedPrompts.push(name); res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ code: 0, data: { promptKey: name, version: '1.0.0', template: name === 'review-prompt' ? '审查角色专属方法' : promptContent } })); return; }
    if (url.pathname.endsWith('/skills')) { res.setHeader('x-nacos-skill-resolved-version', '1.0.0'); res.end(url.searchParams.get('name') === 'review-skill' ? otherArchive : archive); return; }
    res.writeHead(404).end();
  });
  await new Promise<void>(/** 在回环地址绑定随机端口。 */resolveListen => server.listen(0, '127.0.0.1', resolveListen));
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  const nacosResources = { url: `http://127.0.0.1:${address.port}`, namespace: 'public', username: 'fixture', password: 'fixture', promptName: 'sample-prompt', promptVersion: '1.0.0', skillName: 'sample-skill', skillVersion: '1.0.0' };
  try {
    const snapshot = await loadNacosSnapshot(nacosResources);
    assert.equal(snapshot.prompt.content, '原版本提示词');
    const remoteAgents = createAgents({ rootDir: resolve('.'), mode: 'fixture', databaseUrl: 'file::memory:', port: 4111, modelId: 'openai/fixture' }, { resources: snapshot, workspace: false });
    for (const agent of [remoteAgents.productManagerAgent, remoteAgents.productReviewerAgent]) {
      const skills = await agent.listSkills();
      assert.deepEqual(skills.map(/** 新 Run 只使用注册中心中冻结的方法。 */skill => skill.name), ['sample-skill']);
      const instructions = JSON.stringify(await agent.getInstructions());
      assert.match(instructions, /原版本提示词/);
      assert.doesNotMatch(instructions, /product-pm-flow-triage-requests/);
      assert.match(instructions, /不能扩张当前权限/);
    }
    const expandedConfig = { ...nacosResources, reviewerPrompt: { name: 'review-prompt', version: '1.0.0' }, additionalSkills: [{ name: 'review-skill', version: '1.0.0' }], reviewerSkills: ['review-skill'] };
    const expanded = await loadNacosSnapshot(expandedConfig);
    assert.equal(nacosResourceIdentity(expanded).reviewerPrompt?.name, 'review-prompt');
    assert.equal(nacosResourceIdentity(expanded).additionalSkills?.[0]?.name, 'review-skill');
    assert.deepEqual(nacosResourceIdentity(expanded).reviewerSkills, ['review-skill']);
    assert.equal(JSON.stringify(nacosResourceIdentity(expanded)).includes('审查角色专属方法'), false);
    const expandedAgents = createAgents({ rootDir: resolve('.'), mode: 'fixture', databaseUrl: 'file::memory:', port: 4111, modelId: 'openai/fixture' }, { resources: expanded, workspace: false });
    assert.match(JSON.stringify(await expandedAgents.productReviewerAgent.getInstructions()), /审查角色专属方法/);
    assert.doesNotMatch(JSON.stringify(await expandedAgents.productManagerAgent.getInstructions()), /审查角色专属方法/);
    assert.deepEqual(new Set((await expandedAgents.productManagerAgent.listSkills()).map(/** 确认多项资源均可发现。 */skill => skill.name)), new Set(['sample-skill', 'review-skill']));
    assert.deepEqual((await expandedAgents.productReviewerAgent.listSkills()).map(/** 审查角色只获得已冻结的子集。 */skill => skill.name), ['review-skill']);
    assert.throws(/** 未登记或重复的绑定不能装配。 */() => validateNacosSnapshot({ ...expanded, reviewerSkills: ['missing'] }), /绑定无效/);
    await verifyNacosAccess({ ...nacosResources, additionalSkills: [] }, expanded);
    const storage = new LibSQLStore({ id: 'nacos-live-memory-test', url: `file:${join(directory, 'memory.db')}` });
    await storage.init();
    try {
      const live = createAgents({ rootDir: resolve('.'), mode: 'live', databaseUrl: `file:${join(directory, 'memory.db')}`, port: 4111, modelId: 'openai/fixture', apiKey: 'fixture' }, { resources: snapshot, storage, workspace: false });
      const answer = await live.productManagerAgent.generate('合成需求', { model: createMockModel({ mockText: '合成回答', version: 'v2' }), memory: nativeInvocationMemory() });
      assert.equal(answer.text, '合成回答');
    } finally { await storage.close(); }
    assert.equal(JSON.stringify(snapshot).includes('fixture-token'), false);
    assert.throws(/** 未同步更新摘要的篡改必须拒绝。 */() => validateNacosSnapshot({ ...snapshot, prompt: { ...snapshot.prompt, content: '伪造' } }), /摘要不匹配/);
    await verifyNacosAccess(nacosResources, snapshot);
    promptContent = '同版本被修改';
    await assert.rejects(verifyNacosAccess(nacosResources, snapshot), /版本发生漂移/);
    promptContent = '原版本提示词';
    const options = createStudioApplicationOptions({ rootDir: resolve('.'), mode: 'fixture', databaseUrl: `file:${join(directory, 'flow.db')}`, port: 4111, modelId: 'openai/fixture', nacosResources });
    new Mastra(options); await options.storage.init();
    const run = await options.workflows.productDevelopmentWorkflow.createRun();
    const result = await run.start({ inputData: { brief: '合成需求', iterationId: 'nacos-fixture' } });
    assert.equal(result.status, 'suspended', JSON.stringify(result));
    const initial = result.steps['initialize-product-development'];
    assert.equal((initial as any).output.nacosResources.prompt.sha256, snapshot.prompt.sha256);
    await options.storage.close();
    const config = { rootDir: resolve('.'), mode: 'fixture' as const, databaseUrl: `file:${join(directory, 'guided.db')}`, port: 4111, modelId: 'openai/fixture' as const, nacosResources };
    let resumedApp = createStudioApplicationOptions(config);
    new Mastra(resumedApp); await resumedApp.storage.init();
    const guidedRun = await resumedApp.workflows.productDevelopmentWorkflow.createRun();
    assert.equal((await guidedRun.start({ inputData: { brief: '合成需求', iterationId: 'nacos-guided', guidedIntake: true } })).status, 'suspended');
    let view = await readIntake(resumedApp.workflows.productDevelopmentWorkflow, guidedRun.runId);
    await resumedApp.storage.close();
    resumedApp = createStudioApplicationOptions({ ...config, nacosResources: { ...nacosResources, promptName: 'new-default' } });
    new Mastra(resumedApp); await resumedApp.storage.init();
    view = await respondIntake(resumedApp.workflows.productDevelopmentWorkflow, 'fixture', guidedRun.runId, { hash: view.intake!.hash!, action: 'refine', reviewer: 'fixture', supplement: '', answers: [{ questionId: 'scope', selected: ['minimal'], custom: '' }] });
    assert.equal(view.intake?.round, 2, '恢复时必须使用 Run 冻结的原资源名称');
    assert.equal(requestedPrompts.at(-1), 'sample-prompt');
    assert.equal(requestedPrompts.includes('new-default'), false);
    await resumedApp.storage.close();
    let plans = 0;
    /** 注入一次业务阻塞，其他步骤仍使用真实 Workflow 与合成模型。 */
    const generate: GeneratorV2 = async (...args) => { const entry = await generateV2(...args); if (args[2] !== 'architect') return entry; const plan = JSON.parse(entry.text); if (++plans === 1) plan.blockers = ['合成业务待确认：首期范围']; return { ...entry, text: JSON.stringify(plan) }; };
    const blockerConfig = { ...config, databaseUrl: `file:${join(directory, 'blocker.db')}` };
    /** 重建应用时可变更默认资源，验证阻塞回流仍读取原 Run。 */
    function openBlocker(currentConfig: typeof blockerConfig) {
      const app = createStudioApplicationOptions(currentConfig);
      const workflow = createProductDevelopmentWorkflow(app.agents as any, currentConfig, generate, { storage: app.storage });
      new Mastra({ ...app, workflows: { productDevelopmentWorkflow: workflow } });
      return { ...app, workflow };
    }
    let blockerApp = openBlocker(blockerConfig);
    const blockerRun = await blockerApp.workflow.createRun();
    await blockerRun.start({ inputData: { brief: '合成阻塞回流', iterationId: 'nacos-blocker' } });
    let blockerView = await readIntake(blockerApp.workflow, blockerRun.runId);
    blockerView = await respondIntake(blockerApp.workflow, 'fixture', blockerRun.runId, { role: 'product', artifactHash: blockerView.product!.artifact.hash, decision: 'approve', reviewer: 'fixture', comment: '批准' }, blockerConfig);
    const project = { id: 'blocker-test', files: { 'src/a.mjs': 'export const initial=0;', 'check.mjs': 'export const check=1;' }, writablePaths: ['src/a.mjs'], checkFiles: ['check.mjs'], roles: ['backend'] };
    blockerView = await respondIntake(blockerApp.workflow, 'fixture', blockerRun.runId, { gateHash: blockerView.gate!.gateHash, data: { project, reviewer: 'fixture', comment: '批准' } }, blockerConfig);
    assert.equal(blockerView.gate!.key, 'confirm-blocker-answers');
    await blockerApp.storage.close();
    const changedConfig = { ...blockerConfig, nacosResources: { ...nacosResources, promptName: 'new-default' } };
    blockerApp = openBlocker(changedConfig);
    const beforeRevision = requestedPrompts.length;
    blockerView = await respondIntake(blockerApp.workflow, 'fixture', blockerRun.runId, { gateHash: blockerView.gate!.gateHash, data: { ...blockerView.gate!.fixed, reviewer: 'fixture', answers: blockerView.gate!.evidence.plan.questions.map(/** 明确提交该轮答案。 */(question: any) => ({ questionId: question.id, selected: ['minimal'], custom: '' })), supplement: '' } }, changedConfig);
    assert.equal(blockerView.gate!.key, 'review-revised-product');
    assert.deepEqual(requestedPrompts.slice(beforeRevision), ['sample-prompt']);
    await blockerApp.storage.close();
    const safeArchive = archive;
    writeFileSync(join(directory, 'unsafe.txt'), '禁止越界');
    mkdirSync(join(directory, 'nested'));
    execFileSync('zip', ['-q', 'unsafe.zip', '../unsafe.txt'], { cwd: join(directory, 'nested') });
    archive = readFileSync(join(directory, 'nested', 'unsafe.zip'));
    await assert.rejects(loadNacosSnapshot(nacosResources), /Skill ZIP/);
    archive = safeArchive;
    revoked = true;
    await assert.rejects(verifyNacosAccess(nacosResources, snapshot), /HTTP 403/);
  } finally { await new Promise<void>(/** 关闭本机测试服务。 */resolveClose => server.close(() => resolveClose())); }
});
