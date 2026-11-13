/** 正式主流程资源契约回归；固定模型与临时签名不代表生产部署。 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { generateKeyPairSync, sign, randomUUID } from 'node:crypto';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { Mastra } from '@mastra/core';
import { Agent } from '@mastra/core/agent';
import { MastraLanguageModelV2Mock } from '@mastra/core/test-utils/llm-mock';
import { createTool } from '@mastra/core/tools';
import { z } from 'zod';
import { createStudioApplicationOptions } from '../src/mastra/app.js';
import type { PracticeConfig } from '../src/mastra/config.js';
import { assembleRole, continuedRoleModel, invocationRoleTools } from '../src/resources/assembly.js';
import { freezeResources, loadResources } from '../src/resources/runtime.js';
import { withResources } from '../src/resources/scope.js';
import { publishRole, resolveRole } from '../src/resources/native-store.js';
import { captureArtifact, verifyArtifact } from '../src/resources/artifact.js';
import { bytesHash, canonical, endpointHash, freezeStepId, resourceHash } from '../src/resources/contracts.js';
import { sourceSnapshotContentDirectory, verifySourceSnapshot } from '../src/resources/source-snapshot.js';
import { loadRuntimeResourceConfig } from '../src/resources/resource-config.js';
import { reuseReadOnlyToolResults } from '../src/resources/readonly-tool-reuse.js';
import { createTaskContext } from '../src/delivery/task-context.js';

/** 每个实验使用独占数据库，支持重新装配相同正式入口。 */
async function application(config: PracticeConfig) {
  const options = createStudioApplicationOptions(config); new Mastra(options); await options.storage.init();
  return { ...options, workflow: options.workflows.productDevelopmentWorkflow };
}

test('产品只读工具复用：同参成功结果复用，不同分页或失败调用不复用', /** 缓存仅覆盖单个已装配角色实例，不能作为跨Run资料缓存。 */async () => {
  let calls = 0;
  const tools = { read: { execute: /** 模拟分页读取及可重试失败。 */async (input: unknown) => {
    calls++; if ((input as { offset: number }).offset === 99) throw new Error('读取失败');
    return { calls, input };
  } } };
  reuseReadOnlyToolResults(tools);
  const first = await tools.read.execute({ id: 'brief', offset: 0 });
  const same = await tools.read.execute({ offset: 0, id: 'brief' });
  const next = await tools.read.execute({ id: 'brief', offset: 100 });
  await assert.rejects(tools.read.execute({ id: 'brief', offset: 99 }));
  const retried = await tools.read.execute({ id: 'brief', offset: 99 }).catch(/** 保留失败事实以断言失败未缓存。 */error => error);
  assert.deepEqual(first, same); assert.notDeepEqual(first, next); assert.equal(calls, 4); assert.ok(retried instanceof Error);
  let writes = 0;
  const mutations = { mastra_workspace_write_file: { execute: /** 副作用工具不得被只读缓存吞掉。 */async () => ++writes } };
  reuseReadOnlyToolResults(mutations);
  await mutations.mastra_workspace_write_file.execute();
  await mutations.mastra_workspace_write_file.execute();
  assert.equal(writes, 2);
});

test('产品交接角色：梳理、闭环与写作仅保留调用期资料工具，统筹仍使用冻结角色工具', /** 阶段性收敛只减少重复发现，不扩大权限也不替换Run冻结版本。 */() => {
  const tools = { practiceInfo: {}, skill: {}, skill_read: {}, mastra_workspace_list_files: {} };
  assert.deepEqual(Object.keys(invocationRoleTools('productClosureAgent', tools)), ['practiceInfo']);
  assert.deepEqual(Object.keys(invocationRoleTools('productAgent', tools)), ['practiceInfo']);
  assert.deepEqual(Object.keys(invocationRoleTools('productClarificationAgent', tools)), ['practiceInfo']);
  assert.deepEqual(invocationRoleTools('productCoordinatorAgent', tools), tools);
});

test('完整 Agent 循环：同一只读工具成功结果只执行一次且回传模型', /** 用真实Mastra循环验证缓存位于工具执行边界，不是只测包装函数。 */ async () => {
  let executions = 0;
  let calls = 0;
  let sawResult = false;
  const read = createTool({
    id: 'handoff_read',
    description: '读取固定交接资料',
    inputSchema: z.object({ id: z.string() }),
    outputSchema: z.object({ content: z.string() }),
    execute: /** 统计真正工具执行次数。 */async () => { executions++; return { content: '固定交接原文' }; },
  });
  reuseReadOnlyToolResults({ handoff_read: read });
  const model = new MastraLanguageModelV2Mock({
    doGenerate: /** 脚本模型连续请求同一工具后交付正文。 */async ({ prompt, tools }) => {
      calls++;
      const tool = tools?.find(/** 找到模型实际收到的工具定义。 */item => item.type === 'function' && item.name === 'handoff_read');
      assert.ok(tool);
      if (calls <= 2) return { content: [{ type: 'tool-call' as const, toolCallId: `read-${calls}`, toolName: 'handoff_read', input: '{"id":"clarification"}' }], finishReason: 'tool-calls' as const, usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 }, warnings: [] };
      sawResult = JSON.stringify(prompt).includes('固定交接原文');
      return { content: [{ type: 'text' as const, text: '已使用交接原文完成当前角色交付' }], finishReason: 'stop' as const, usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 }, warnings: [] };
    },
  });
  const agent = new Agent({ id: 'handoff-loop-regression', name: '交接循环回归', instructions: '只读交接', model, tools: { handoff_read: read } });
  const result = await agent.generate('读取并整理交接资料', { maxSteps: 3 });
  assert.equal(result.text, '已使用交接原文完成当前角色交付');
  assert.equal(executions, 1);
  assert.equal(calls, 3);
  assert.equal(sawResult, true);
});

test('角色工具面：受限产品交接Agent只暴露handoff与practiceInfo', /** 模型请求层验证Skill和Workspace不会因原角色版本重新出现。 */ async () => {
  const directory = mkdtempSync(resolve(tmpdir(), 'handoff-tool-face-'));
  const config: PracticeConfig = { rootDir: resolve('.'), mode: 'fixture', modelId: 'openai/fixture', port: 4111, databaseUrl: `file:${resolve(directory, 'run.db')}` };
  const app = await application(config);
  try {
    const run = await app.workflow.createRun();
    await run.start({ inputData: { brief: '交接工具面验证', iterationId: 'handoff-tool-face' } });
    const binding = await loadResources(app.storage, config, run.runId);
    const roles = ['productClarificationAgent', 'productClosureAgent', 'productAgent'] as const;
    for (const key of roles) {
      const original = app.agents[key];
      const model = new MastraLanguageModelV2Mock({
        doGenerate: /** 检查原生模型请求中没有重新注入角色发现工具。 */async ({ tools }) => {
          const names = (tools ?? []).map(/** 仅提取模型可见名称。 */tool => tool.name);
          assert.ok(names.includes('practiceInfo'));
          // Mastra将调用期toolset扁平化为read/locate；语义上仍属于handoff.read/handoff.locate。
          assert.ok(names.some(/** 必须提供调用期资料工具。 */name => /^(handoff[_.])?(read|locate)$/.test(name)), names.join(','));
          assert.ok(names.every(/** 所有可见工具必须属于允许集合。 */name => name === 'practiceInfo' || /^(handoff[_.])?(read|locate)$/.test(name)), names.join(','));
          return { content: [{ type: 'text' as const, text: '受限交接执行器已完成当前角色输出' }], finishReason: 'stop' as const, usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 }, warnings: [] };
        },
      });
      original.getModel = /** 只替换测试模型，保留冻结版本装配。 */async () => model as any;
      await withResources({ binding, storage: app.storage }, /** 在真实Run资源域中装配受限角色。 */async () => {
        const agent = await assembleRole(original, key, config);
        assert.equal(await agent.getWorkspace(), undefined);
        assert.deepEqual(await agent.listSkills(), []);
        const context = createTaskContext({ task: '受限交接', source: '已确认基线' });
        const result = await agent.generate(context.prompt, { ...context.options, maxSteps: 1 });
        assert.equal(result.text, '受限交接执行器已完成当前角色输出');
      });
    }
  } finally { await app.storage.close(); rmSync(directory, { recursive: true, force: true }); }
});

test('正式入口：暂停发布Agent和Skill新版，旧Run重新装配保留原资源，新Run选择增强版本', /** 主链首步是版本事实唯一来源。 */ async () => {
  const directory = mkdtempSync(resolve(tmpdir(), 'role-runtime-'));
  const config: PracticeConfig = { rootDir: resolve('.'), mode: 'fixture', modelId: 'openai/fixture', port: 4111, databaseUrl: `file:${resolve(directory, 'run.db')}` };
  let app = await application(config);
  try {
    const run = await app.workflow.createRun();
    const initial: any = await run.start({ inputData: { brief: '固定角色资源验证', iterationId: 'resources' } });
    assert.equal(initial.status, 'suspended');
    const binding = await loadResources(app.storage, config, run.runId);
    const pin = binding.roles.productAgent;
    const original = await resolveRole(app.storage, pin.agentId, pin.versionId);
    const skillId = Object.keys(original.config.skills)[0];
    const skills = (await app.storage.getStore('skills'))!; const blobs = (await app.storage.getStore('blobs'))!;
    const oldSkill = (await skills.getByIdResolved(skillId, { versionId: original.config.skills[skillId].pin }))!;
    const body = String((await blobs.get(oldSkill.tree!.entries['SKILL.md'].blobHash))!.content) + '\nNEW_SKILL_RESOURCE'; const hash = bytesHash(body);
    await blobs.put({ hash, size: Buffer.byteLength(body), createdAt: new Date(), content: body, mimeType: 'text/markdown' });
    const versionId = randomUUID();
    const tree = { ...oldSkill.tree!, entries: { ...oldSkill.tree!.entries, 'SKILL.md': { blobHash: hash, size: Buffer.byteLength(body) } } };
    await skills.createVersion({ id: versionId, skillId, versionNumber: 2, name: oldSkill.name, description: oldSkill.description, instructions: oldSkill.instructions + '\nNEW_SKILL_RESOURCE', tree });
    await skills.update({ id: skillId, activeVersionId: versionId, status: 'published' });
    const next = await publishRole(app.storage, pin.agentId, { ...original.config, instructions: original.config.instructions + '\nNEW_AGENT_RESOURCE', model: { provider: 'openai', name: 'frozen-model-v2', temperature: 0.2 }, skills: { ...original.config.skills, [skillId]: { pin: versionId } } });
    await app.storage.close(); app = await application({ ...config, modelId: 'openai/changed-default', apiKey: 'synthetic-rotated-credential' });
    const restored = await loadResources(app.storage, config, run.runId);
    assert.deepEqual(restored, binding);
    assert.deepEqual(await freezeResources(app.storage, config, app.agents, run.runId), binding, '重执行首步不能覆盖已冻结引用');
    await withResources({ binding, storage: app.storage }, /** 受限交接执行器按旧版本重建，但不携带旧角色资料发现能力。 */ async () => {
      const agent = await assembleRole(app.agents.productAgent, 'productAgent', config);
      assert.ok(String(await agent.getInstructions()).includes(original.config.instructions));
      assert.equal(await agent.getWorkspace(), undefined);
      assert.deepEqual(await agent.listSkills(), []);
      assert.deepEqual(Object.keys(await agent.listTools()), ['practiceInfo']);
      await assert.rejects(/** 调用参数不能替换冻结模型。 */() => agent.generate('fixture', { model: 'openai/other' } as any), /MODEL_OVERRIDE/);
      await assert.rejects(/** 同名调用期工具不能伪造宿主资料工厂身份。 */() => agent.generate('fixture', { toolsets: { handoff: {} } } as any), /RESOURCE_OVERRIDE/);
    });
    const continuationConfig = { ...config, mode: 'live' as const, apiKey: 'synthetic', baseUrl: 'https://example.test/v1', modelId: 'openai/new' as const, roleModels: { product: 'openai/terra' as const }, modelContinuations: { [`openai/${original.config.model.name}`]: 'openai/terra' as const } };
    assert.equal(continuedRoleModel(continuationConfig, 'productAgent', `openai/${original.config.model.name}`), 'openai/terra', '历史模型只有显式部署续接授权才可切换');
    assert.equal(continuedRoleModel({ ...continuationConfig, modelContinuations: undefined }, 'productAgent', `openai/${original.config.model.name}`), `openai/${original.config.model.name}`);
    const resumed: any = await (await app.workflow.createRun({ runId: run.runId })).resume({ step: initial.suspended[0], resumeData: { role: 'product', artifactHash: initial.steps['review-product'].suspendPayload.artifact.hash, decision: 'approve', reviewer: 'fixture', comment: '合成测试审批' } });
    assert.equal(resumed.status, 'suspended'); assert.equal(resumed.suspended[0].at(-1), 'confirm-project-scope');
    const fresh = await app.workflow.createRun(); const freshResult: any = await fresh.start({ inputData: { brief: '增强后新任务', iterationId: 'resources-new' } });
    assert.equal(freshResult.status, 'suspended');
    const freshBinding = await loadResources(app.storage, config, fresh.runId);
    assert.equal(freshBinding.roles.productAgent.versionId, next.versionId);
    await withResources({ binding: freshBinding, storage: app.storage }, /** 新Run解析最新发布的完整增强。 */ async () => {
      const agent = await assembleRole(app.agents.productAgent, 'productAgent', config);
      assert.match(String(await agent.getInstructions()), /NEW_AGENT_RESOURCE/);
      assert.equal((await agent.getDefaultOptions())?.modelSettings?.temperature, 0.2);
      assert.equal(await agent.getWorkspace(), undefined);
      assert.deepEqual(await agent.listSkills(), []);
      assert.deepEqual(Object.keys(await agent.listTools()), ['practiceInfo']);
    });
    await assert.rejects(/** 默认模型和凭据可轮换，端点不可漂移。 */() => loadResources(app.storage, { ...config, baseUrl: 'https://changed.invalid/v1' }, run.runId), /TRANSPORT_DRIFT/);
    const continuedEndpoint = { ...config, baseUrl: 'https://changed.invalid/v1', endpointContinuations: { [binding.endpointHash]: endpointHash('https://changed.invalid/v1') } };
    assert.deepEqual(await loadResources(app.storage, continuedEndpoint, run.runId), binding, '部署配置显式登记后才允许历史Run切换端点继续');
    const parallel = await Promise.all([binding, freshBinding].map(/** 两个Run并行装配不得共享当前角色版本。 */
      selected => withResources({ binding: selected, storage: app.storage }, /** 异步装配仍读取自己的调用上下文。 */async () => String(await (await assembleRole(app.agents.productAgent, 'productAgent', config)).getInstructions()))));
    assert.ok(parallel[0].includes(original.config.instructions)); assert.match(parallel[1], /NEW_AGENT_RESOURCE/);
    await assert.rejects(/** 无冻结记录绝不补造兼容快照。 */() => loadResources(app.storage, config, 'legacy-run'), /BINDING_MISSING/);
    await assert.rejects(/** 明确的版本缺失不能回退发布指针。 */() => resolveRole(app.storage, pin.agentId, 'missing-version'), /VERSION_MISSING/);
    const missingHash = oldSkill.tree!.entries['SKILL.md'].blobHash;
    await (await app.storage.getStore('blobs'))!.delete(missingHash);
    await assert.rejects(/** 已保存pin不能掩盖内容缺失。 */() => loadResources(app.storage, config, run.runId), /BLOB_INTEGRITY/);
  } finally { await app.storage.close(); rmSync(directory, { recursive: true, force: true }); }
});

test('正式入口：未登记工具在首个模型调用之前拒绝', /** 原生Store不能绕过宿主工具注册。 */ async () => {
  const directory = mkdtempSync(resolve(tmpdir(), 'role-tools-'));
  const config: PracticeConfig = { rootDir: resolve('.'), mode: 'fixture', modelId: 'openai/fixture', port: 4111, databaseUrl: `file:${resolve(directory, 'run.db')}` };
  const app = await application(config);
  try {
    const run = await app.workflow.createRun(); await run.start({ inputData: { brief: '工具测试', iterationId: 'tools' } });
    const pin = (await loadResources(app.storage, config, run.runId)).roles.testingAgent;
    const old = await resolveRole(app.storage, pin.agentId, pin.versionId);
    await assert.rejects(/** 缺失Skill版本不得静默跳过。 */() => publishRole(app.storage, pin.agentId, { ...old.config, skills: { missing: { pin: 'missing-version' } }, workspace: { type: 'inline', config: { name: 'invalid' } } }), /SKILL_MISSING/);
    await assert.rejects(/** Workspace配置不能启用未登记的写能力。 */() => publishRole(app.storage, pin.agentId, { ...old.config, workspace: { type: 'inline', config: { name: 'invalid', tools: { enabled: false, tools: { arbitraryWrite: { enabled: true } } } } } }), /WORKSPACE_TOOL_FORBIDDEN/);
    await publishRole(app.storage, pin.agentId, { ...old.config, tools: { ...old.config.tools, arbitraryShell: {} } });
    const failed: any = await (await app.workflow.createRun()).start({ inputData: { brief: '非法配置', iterationId: 'invalid' } });
    assert.equal(failed.status, 'failed'); assert.match(failed.error.message, /TOOL_UNKNOWN/);
    assert.deepEqual(failed.stepExecutionPath, [freezeStepId]);
  } finally { await app.storage.close(); rmSync(directory, { recursive: true, force: true }); }
});

test('可信制品：签名、代码、依赖、额外文件与live降级均严格核验', /** 临时Ed25519密钥仅用于本地负向回归。 */ () => {
  const directory = mkdtempSync(resolve(tmpdir(), 'role-artifact-'));
  const root = resolve(directory, 'artifact'); mkdirSync(resolve(root, 'src'), { recursive: true }); mkdirSync(resolve(root, 'node_modules'));
  writeFileSync(resolve(root, 'src/tool.ts'), 'export const schema = 1'); writeFileSync(resolve(root, 'package.json'), '{}'); writeFileSync(resolve(root, 'package-lock.json'), '{}'); writeFileSync(resolve(root, 'node_modules/dependency.js'), 'original');
  const pair = generateKeyPairSync('ed25519'); const manifest = captureArtifact(root, true);
  const manifestPath = resolve(directory, 'manifest.json'); const publicKeyPath = resolve(directory, 'public.pem');
  writeFileSync(publicKeyPath, pair.publicKey.export({ type: 'spki', format: 'pem' }));
  writeFileSync(manifestPath, JSON.stringify({ manifest, signature: sign(null, Buffer.from(canonical(manifest)), pair.privateKey).toString('base64') }));
  const config: PracticeConfig = { rootDir: root, mode: 'live', modelId: 'openai/test', databaseUrl: ':memory:', port: 4111, resourceTrust: { manifestPath, publicKeyPath } };
  try {
    assert.equal(verifyArtifact(config).assurance, 'signed');
    const staleManifestPath = resolve(directory, 'stale-manifest.json');
    const staleManifest = { ...manifest, node: 'v0.0.0' };
    writeFileSync(staleManifestPath, JSON.stringify({ manifest: staleManifest, signature: sign(null, Buffer.from(canonical(staleManifest)), pair.privateKey).toString('base64') }));
    const routed: PracticeConfig = { ...config, resourceTrust: { manifestPath: staleManifestPath, publicKeyPath, routes: { [resourceHash(manifest)]: { manifestPath, publicKeyPath } } } };
    assert.equal(verifyArtifact(routed, resourceHash(manifest)).digest, resourceHash(manifest), '冻结摘要应选择对应可信清单');
    assert.throws(/** 未登记的冻结摘要不能借默认清单继续。 */() => verifyArtifact(routed, 'f'.repeat(64)), /ARTIFACT_DRIFT/);
    const historicalDigest = resourceHash(staleManifest);
    const continued: PracticeConfig = { ...config, resourceTrust: { manifestPath, publicKeyPath, continuations: { [historicalDigest]: { manifestPath, publicKeyPath } } } };
    assert.equal(verifyArtifact(continued, historicalDigest).digest, resourceHash(manifest), '部署配置可显式授权历史制品续接到当前签名制品');
    assert.throws(/** 未在部署配置登记的历史制品不能续接。 */() => verifyArtifact(config, historicalDigest), /ARTIFACT_DRIFT/);
    assert.throws(/** live不可借fixture降级绕过独立签名。 */() => verifyArtifact({ ...config, resourceTrust: undefined }), /TRUST_REQUIRED/);
    for (const path of ['src/tool.ts', 'node_modules/dependency.js']) {
      const original = path.startsWith('src') ? 'export const schema = 1' : 'original';
      writeFileSync(resolve(root, path), 'changed'); assert.throws(/** 同名实现或依赖字节变化必须拒绝。 */() => verifyArtifact(config), /ARTIFACT_DRIFT/); writeFileSync(resolve(root, path), original);
    }
    writeFileSync(resolve(root, 'src/extra.ts'), 'extra'); assert.throws(/** 文件清单必须完整，不能只检查旧条目。 */() => verifyArtifact(config), /ARTIFACT_DRIFT/); rmSync(resolve(root, 'src/extra.ts'));
    const other = generateKeyPairSync('ed25519'); writeFileSync(publicKeyPath, other.publicKey.export({ type: 'spki', format: 'pem' }));
    assert.throws(/** Run不能自行提供公钥来信任其他签名者。 */() => verifyArtifact(config), /SIGNATURE_INVALID/);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('资源快照：资料在首Agent前复制，恢复只读取副本且副本漂移拒绝', /** 快照是Run输入的一部分，不能只保存来源目录摘要。 */ async () => {
  const directory = mkdtempSync(resolve(tmpdir(), 'role-sources-'));
  const config: PracticeConfig = { rootDir: resolve('.'), mode: 'fixture', modelId: 'openai/fixture', port: 4111, databaseUrl: `file:${resolve(directory, 'run.db')}` };
  const app = await application(config);
  try {
    const run = await app.workflow.createRun();
    await run.start({ inputData: { brief: '资料快照验证', iterationId: 'sources' } });
    const binding = await loadResources(app.storage, config, run.runId);
    const frozen = resolve(sourceSnapshotContentDirectory(config, run.runId));
    const first = Object.keys(verifySourceSnapshot(config, run.runId, binding.sourceSnapshotHash).files)[0]!;
    const frozenFile = resolve(frozen, first);
    assert.ok(readFileSync(frozenFile, 'utf8').length > 0);
    assert.deepEqual(await loadResources(app.storage, config, run.runId), binding, '恢复只校验Run副本，不重新读取可变来源');
    writeFileSync(frozenFile, 'Run副本被修改');
    await assert.rejects(/** 副本不完整或被改都不能用当前来源自动修复。 */() => loadResources(app.storage, config, run.runId), /SOURCE_INTEGRITY/);
  } finally { await app.storage.close(); rmSync(directory, { recursive: true, force: true }); }
});

test('资源配置：新Run冻结统一预算，后续当前配置变化不能覆盖已批准团队', /** 预算属于Run绑定，而不是可变服务端默认值。 */ async () => {
  const directory = mkdtempSync(resolve(tmpdir(), 'role-config-'));
  const base = loadRuntimeResourceConfig(resolve('.'));
  const runtimeResources = { ...base, budgets: { ...base.budgets, developmentMaxCalls: 64, maxParallel: 2, maxDelegationsPerTask: 1 } };
  const config: PracticeConfig = { rootDir: resolve('.'), mode: 'fixture', modelId: 'openai/fixture', port: 4111, databaseUrl: `file:${resolve(directory, 'run.db')}`, runtimeResources };
  const app = await application(config);
  try {
    const run = await app.workflow.createRun(); const result: any = await run.start({ inputData: { brief: '预算冻结验证', iterationId: 'budget' } });
    const binding = await loadResources(app.storage, config, run.runId);
    assert.equal((binding.runtimeConfig as any).budgets.maxParallel, 2);
    assert.equal((binding.runtimeConfig as any).budgets.developmentMaxCalls, 64);
    const restarted = { ...config, runtimeResources: { ...runtimeResources, budgets: { ...runtimeResources.budgets, maxParallel: 3, developmentMaxCalls: 72 } } };
    assert.deepEqual(await loadResources(app.storage, restarted, run.runId), binding);
    assert.equal(result.status, 'suspended');
  } finally { await app.storage.close(); rmSync(directory, { recursive: true, force: true }); }
});
