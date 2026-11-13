/** 正式主流程资源契约回归；固定模型与临时签名不代表生产部署。 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { generateKeyPairSync, sign, randomUUID } from 'node:crypto';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { Mastra } from '@mastra/core';
import { createStudioApplicationOptions } from '../src/mastra/app.js';
import type { PracticeConfig } from '../src/mastra/config.js';
import { assembleRole } from '../src/resources/assembly.js';
import { freezeResources, loadResources } from '../src/resources/runtime.js';
import { withResources } from '../src/resources/scope.js';
import { publishRole, resolveRole } from '../src/resources/native-store.js';
import { captureArtifact, verifyArtifact } from '../src/resources/artifact.js';
import { bytesHash, canonical, freezeStepId, resourceHash } from '../src/resources/contracts.js';
import { sourceSnapshotContentDirectory, verifySourceSnapshot } from '../src/resources/source-snapshot.js';
import { loadRuntimeResourceConfig } from '../src/resources/resource-config.js';

/** 每个实验使用独占数据库，支持重新装配相同正式入口。 */
async function application(config: PracticeConfig) {
  const options = createStudioApplicationOptions(config); new Mastra(options); await options.storage.init();
  return { ...options, workflow: options.workflows.productDevelopmentWorkflow };
}

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
    await withResources({ binding, storage: app.storage }, /** 真实原生解析器按旧版本装配。 */ async () => {
      const agent = await assembleRole(app.agents.productAgent, 'productAgent', config);
      assert.equal(await agent.getInstructions(), original.config.instructions);
      const pinnedSkill = await (await agent.getWorkspace())!.skills!.get(oldSkill.name);
      assert.ok(pinnedSkill); assert.equal(pinnedSkill.instructions.includes('NEW_SKILL_RESOURCE'), false);
      await assert.rejects(/** 调用参数不能替换冻结模型。 */() => agent.generate('fixture', { model: 'openai/other' } as any), /MODEL_OVERRIDE/);
      await assert.rejects(/** 同名调用期工具不能伪造宿主资料工厂身份。 */() => agent.generate('fixture', { toolsets: { handoff: {} } } as any), /RESOURCE_OVERRIDE/);
    });
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
      assert.match((await (await agent.getWorkspace())!.skills!.get(oldSkill.name))!.instructions, /NEW_SKILL_RESOURCE/);
    });
    await assert.rejects(/** 默认模型和凭据可轮换，端点不可漂移。 */() => loadResources(app.storage, { ...config, baseUrl: 'https://changed.invalid/v1' }, run.runId), /TRANSPORT_DRIFT/);
    const parallel = await Promise.all([binding, freshBinding].map(/** 两个Run并行装配不得共享当前角色版本。 */
      selected => withResources({ binding: selected, storage: app.storage }, /** 异步装配仍读取自己的调用上下文。 */async () => String(await (await assembleRole(app.agents.productAgent, 'productAgent', config)).getInstructions()))));
    assert.equal(parallel[0], original.config.instructions); assert.match(parallel[1], /NEW_AGENT_RESOURCE/);
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
