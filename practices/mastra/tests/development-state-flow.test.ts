/** 原生阶段状态与旧图恢复回归；合成模型不会访问真实用户 Run。 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { Mastra } from '@mastra/core';
import { MastraTimeoutError } from '@mastra/core/loop';
import { LibSQLStore } from '@mastra/libsql';
import { seedDevelopment } from '../src/development-service.js';
import { DevelopmentExecution } from '../src/development-execution.js';
import { developmentHash } from '../src/development/contracts.js';
import { recoveryHashV2, inputV2Schema, stateV2Schema } from '../src/development/v2/contracts.js';
import { generateV2, type GeneratorV2 } from '../src/development/v2/agents.js';
import { loadDevelopmentMethods } from '../src/development/v2/methods.js';
import { createDevelopmentWorkflowV2 } from '../src/mastra/workflows/development-v2.js';
import { recoverDevelopmentV2 } from '../src/development-v2-service.js';
import { describeGate, validateGate, describeDevelopmentProgress } from '../src/intake/gates.js';

/** 固定Node项目只验证控制流，检查脚本不依赖模型输出。 */
function fixture(generate: GeneratorV2) {
  const parent = mkdtempSync(resolve(tmpdir(), 'stage-state-'));
  const directory = resolve(parent, 'run');
  const input = inputV2Schema.parse({ source: { kind: 'evaluation', runId: 'synthetic', content: '固定合成需求：fixtureValue返回1。', hash: developmentHash('合成'), evidence: 'evaluation-input' }, project: { id: 'stage-test', files: { 'src/solution.mjs': 'export function fixtureValue(){return 0;}', 'checks.mjs': 'import assert from "node:assert/strict"; import {fixtureValue} from "./src/solution.mjs"; assert.equal(fixtureValue(),1);' }, writablePaths: ['src/solution.mjs'], checkFiles: ['checks.mjs'], roles: ['backend'] } });
  seedDevelopment(directory, input);
  const config = { rootDir: resolve('.'), mode: 'fixture' as const, modelId: 'openai/fixture' as const, port: 4111, databaseUrl: `file:${resolve(directory, 'unused.db')}` };
  /** 重建同一原生Store和候选，用于验证跨装配及旧图兼容。 */
  function open(legacySequential = false) {
    const execution = new DevelopmentExecution(resolve(directory, 'candidate'), input.project.writablePaths, input.project.checkFiles);
    const workflow = createDevelopmentWorkflowV2(config, execution, false, generate, { legacySequential });
    const storage = new LibSQLStore({ id: 'stage-store', url: `file:${resolve(directory, 'workflow.db')}` });
    const mastra = new Mastra({ workflows: { developmentWorkflowV2: workflow }, storage, logger: false });
    return { config, input, execution, workflow, storage, mastra, evaluationPolicy: false, methodsHash: loadDevelopmentMethods(config.rootDir).hash };
  }
  return { open, directory, parent };
}

for (const legacy of [false, true]) test(legacy ? '历史恢复节点在新条件图中仍能恢复到方案批准' : '架构故障就地暂停、下游未执行，重开后只重试该阶段', /** 用原生持久化验证状态，不把UI字符串当作执行证据。 */async () => {
  let failing = true; const calls: string[] = [];
  /** 前两次架构调用超时，重试后切回真实fixture工具链。 */
  const generate: GeneratorV2 = async (...args) => { calls.push(args[2]); if (args[2] === 'architect' && failing) throw Object.assign(new MastraTimeoutError({ timeoutType: 'step', timeoutMs: 600000 }), { request: 'synthetic-secret-must-not-leak' }); return generateV2(...args); };
  const setup = fixture(generate); let app = setup.open(legacy);
  try {
    const run = await app.workflow.createRun(); await run.start({ inputData: app.input });
    let snapshot = await app.workflow.getWorkflowRunById(run.runId);
    const path = legacy ? 'development-iteration-v2.recover-development' : 'development-iteration-v2.architecture';
    const paused = snapshot!.steps![path] as any; assert.equal(paused.status, 'suspended');
    const state = stateV2Schema.parse(paused.suspendPayload.recoveryState ?? paused.payload);
    assert.equal(state.phase, 'architecture'); assert.equal(state.faults.length, 5); assert.equal(state.calls, 6);
    assert.equal(state.faults[0].modelCall!.policy.stepMs, 600000); assert.equal(state.faults[0].modelCall!.policy.totalMs, 1800000);
    assert.equal(state.faults[0].modelCall!.failure.source, 'mastra-step'); assert.equal(state.faults[0].modelCall!.failure.triggerLimitMs, 600000);
    if (!legacy) {
      for (const name of ['assemble-agent-team', 'assess-readiness', 'approve-architecture', 'implement', 'development-self-check', 'review-code', 'resolve-findings', 'recover-development']) assert.notEqual((snapshot!.steps![`development-iteration-v2.${name}`] as any)?.status, 'success');
      assert.deepEqual(calls, ['context', ...Array(5).fill('architect')]);
    }
    const gate = describeGate(path, paused.suspendPayload)!;
    assert.match(gate.title, /技术方案生成未完成/); assert.equal(gate.key, 'recover-development'); assert.match(gate.recoveryInfo!.reason, /规定时间/);
    assert.equal('recoveryState' in gate.evidence, false); assert.doesNotMatch(JSON.stringify(gate), /synthetic-secret/);
    assert.throws(/** 旧版本不能消耗原生暂停点。 */() => validateGate(path, paused.suspendPayload, { gateHash: gate.gateHash, data: { hash: '0'.repeat(64), decision: 'retry', reviewer: 'test', comment: '合成重试' } }, paused.payload));
    await app.execution.close(); await app.storage.close(); app = setup.open(); failing = false;
    await recoverDevelopmentV2(app, run.runId, { hash: state.recovery!.hash, decision: 'retry', reviewer: 'test', comment: '合成重试' });
    snapshot = await app.workflow.getWorkflowRunById(run.runId);
    assert.equal(snapshot!.status, 'suspended');
    assert.equal((snapshot!.steps!['development-iteration-v2.approve-architecture'] as any).status, 'suspended');
    const resumed = (snapshot!.steps!['development-iteration-v2.approve-architecture'] as any).payload;
    assert.equal(resumed.recoveries.length, 1); assert.equal(resumed.completedTasks.length, 0);
    assert.equal(calls.filter(/** 上下文已完成，不重新消费模型。 */role => role === 'context').length, 1);
  } finally { await app.execution.close(); await app.storage.close(); rmSync(setup.parent, { recursive: true, force: true }); }
});

test('停止保留检查点且不运行后续阶段；运行与失败提示从原生状态读取', /** 业务停止不是自动批准或继续实施。 */async () => {
  /** 合成架构超时用于进入决定页面。 */
  const generate: GeneratorV2 = async (...args) => { if (args[2] === 'architect') throw Object.assign(new Error('synthetic'), { name: 'MastraTimeoutError' }); return generateV2(...args); };
  const setup = fixture(generate); const app = setup.open();
  try {
    const run = await app.workflow.createRun(); await run.start({ inputData: app.input });
    const snapshot = await app.workflow.getWorkflowRunById(run.runId); const paused = snapshot!.steps!['development-iteration-v2.architecture'] as any;
    await recoverDevelopmentV2(app, run.runId, { hash: paused.suspendPayload.hash, decision: 'stop', reviewer: 'test', comment: '合成停止' });
    const stopped = await app.workflow.getWorkflowRunById(run.runId);
    assert.equal(stopped!.status, 'success'); assert.equal((stopped!.result as any).outcome, 'manual-attention'); assert.equal((stopped!.result as any).delivery, null);
    assert.notEqual((stopped!.steps!['development-iteration-v2.implement'] as any)?.status, 'success');
    assert.match(describeDevelopmentProgress('running', { architecture: { status: 'running' } })!.title, /技术方案生成/);
    assert.match(describeDevelopmentProgress('failed', { architecture: { status: 'failed' } })!.title, /执行失败/);
    assert.equal(describeDevelopmentProgress('suspended', { architecture: { status: 'suspended' } }), undefined);
  } finally { await app.execution.close(); await app.storage.close(); rmSync(setup.parent, { recursive: true, force: true }); }
});

import { createStudioApplicationOptions } from '../src/mastra/app.js';
import { createProductDevelopmentWorkflow } from '../src/mastra/workflows/product-development.js';
import { readIntake, respondIntake } from '../src/intake/service.js';

test('主流程停止开发后不进入测试、发布或最终交付；原生暂停投影可直接提交决定', /** 使用正式HTTP服务依赖的命令和原生检查点，避免只验证CLI。 */async () => {
  const directory = mkdtempSync(resolve(tmpdir(), 'stage-root-'));
  const config = { rootDir: resolve('.'), mode: 'fixture' as const, modelId: 'openai/fixture' as const, port: 4111, databaseUrl: `file:${resolve(directory, 'workflow.db')}` };
  const app = createStudioApplicationOptions(config);
  /** 产品正常成稿，仅在开发架构阶段注入超时。 */
  const generate: GeneratorV2 = async (...args) => { if (args[2] === 'architect') throw Object.assign(new Error('synthetic'), { name: 'MastraTimeoutError' }); return generateV2(...args); };
  const workflow = createProductDevelopmentWorkflow(app.agents as any, config, generate);
  new Mastra({ ...app, workflows: { productDevelopmentWorkflow: workflow } });
  try {
    const run = await workflow.createRun(); await run.start({ inputData: { brief: '合成阶段停止验证', iterationId: 'state-flow-test' } });
    let current = await readIntake(workflow, run.runId);
    current = await respondIntake(workflow, 'fixture', run.runId, { role: 'product', artifactHash: current.product!.artifact.hash, reviewer: 'test', comment: '合成批准', decision: 'approve' });
    current = await respondIntake(workflow, 'fixture', run.runId, { gateHash: current.gate!.gateHash, data: { reviewer: 'test', comment: '合成项目', project: { id: 'stage-project', files: { 'src/a.mjs': 'export const a=0;', 'check.mjs': 'export const check=1;' }, writablePaths: ['src/a.mjs'], checkFiles: ['check.mjs'], roles: ['backend'] } } });
    assert.equal(current.gate!.key, 'recover-development'); assert.equal(current.gate!.recoveryInfo!.phase, '技术方案生成');
    assert.equal('recoveryState' in current.gate!.evidence, false);
    current = await respondIntake(workflow, 'fixture', run.runId, { gateHash: current.gate!.gateHash, data: { ...current.gate!.fixed, decision: 'stop', reviewer: 'test', comment: '合成停止' } });
    assert.equal(current.status, 'success'); assert.equal(current.outcome, 'blocked'); assert.equal(current.gate, undefined);
    const snapshot = await workflow.getWorkflowRunById(run.runId);
    for (const key of ['testing', 'deployment', 'confirm-final-delivery']) assert.notEqual((snapshot!.steps![key] as any)?.status, 'success');
  } finally { await app.storage.close(); rmSync(directory, { recursive: true, force: true }); }
});

import { executionResolver } from '../src/mastra/workflows/product-development.js';

test('历史failed架构受控Time travel：拒绝旧hash和源码漂移，重开后只恢复架构并等待方案批准', /** 模拟旧版本抛出的已知模型失败，不修改用户快照。 */async () => {
  const directory = mkdtempSync(resolve(tmpdir(), 'architecture-time-travel-'));
  const config = { rootDir: resolve('.'), mode: 'fixture' as const, modelId: 'openai/fixture' as const, port: 4111, databaseUrl: `file:${resolve(directory, 'workflow.db')}` };
  let app = createStudioApplicationOptions(config);
  let workflow = app.workflows.productDevelopmentWorkflow;
  const dev = workflow.steps['development-team'] as any;
  // 保持同一原生图，仅模拟旧版架构错误退出以形成真实failed持久化记录。
  let oldCalls = 0;
  // 先模拟旧版尾部恢复暂停，再在第二轮架构抛错，此时prepare-context未在当前轮被选择。
  dev.steps['development-team-iteration'].steps.architecture.execute = async ({ inputData }: any) => {
    if (++oldCalls === 1) return { ...inputData, recovery: { hash: recoveryHashV2(inputData), checkpointHash: inputData.checkpointHash, phase: 'architecture', role: 'architect', taskId: null, kind: 'model-timeout' } };
    throw new Error('开发阶段 architecture 再次未完成（model-timeout），人工恢复预算已耗尽');
  };
  new Mastra(app);
  const project = { id: 'legacy-architecture', files: { 'src/a.mjs': 'export const a=0;', 'check.mjs': 'export const check=1;' }, writablePaths: ['src/a.mjs'], checkFiles: ['check.mjs'], roles: ['backend'] };
  try {
    const run = await workflow.createRun(); await run.start({ inputData: { brief: '合成历史架构恢复', iterationId: 'architecture-travel' } });
    let current = await readIntake(workflow, run.runId);
    current = await respondIntake(workflow, 'fixture', run.runId, { role: 'product', artifactHash: current.product!.artifact.hash, decision: 'approve', reviewer: 'test', comment: '合成批准' });
    current = await respondIntake(workflow, 'fixture', run.runId, { gateHash: current.gate!.gateHash, data: { project, reviewer: 'test', comment: '合成项目' } });
    assert.equal(current.status, 'suspended');
    current = await respondIntake(workflow, 'fixture', run.runId, { gateHash: current.gate!.gateHash, data: { ...current.gate!.fixed, decision: 'retry', reviewer: 'test', comment: '模拟旧版人工重试' } });
    assert.equal(current.status, 'failed'); assert.equal(current.retry!.step, 'development-team.development-team-iteration');
    await assert.rejects(respondIntake(workflow, 'fixture', run.runId, { retryHash: '0'.repeat(64) }, config), /版本/);
    const snapshot = await workflow.getWorkflowRunById(run.runId); const state = (snapshot!.steps![(current.retry as any).checkpointStep] as any).payload;
    assert.equal(snapshot!.steps!['development-team.development-team-iteration.prepare-context'], undefined);
    let candidate = executionResolver(config)(state.input); await candidate.writeFile('src/a.mjs', 'export const drift=1;'); await candidate.close();
    await assert.rejects(respondIntake(workflow, 'fixture', run.runId, { retryHash: current.retry!.hash }, config), /检查点/);
    assert.equal((await readIntake(workflow, run.runId)).status, 'failed');
    candidate = executionResolver(config)(state.input); await candidate.writeFile('src/a.mjs', project.files['src/a.mjs']); await candidate.close();
    await app.storage.close(); app = createStudioApplicationOptions(config); new Mastra(app); workflow = app.workflows.productDevelopmentWorkflow;
    current = await respondIntake(workflow, 'fixture', run.runId, { retryHash: current.retry!.hash }, config);
    assert.equal(current.status, 'suspended'); assert.equal(current.gate!.key, 'approve-architecture');
    const resumed = await workflow.getWorkflowRunById(run.runId); const approved = Object.values(resumed!.steps!).find(/** 找到当前真实方案批准暂停状态。 */step => !Array.isArray(step) && step.status === 'suspended') as any;
    assert.equal(approved.payload.completedTasks.length, 0);
    assert.equal(approved.payload.work.filter(/** 已完成的上下文不在恢复中重放。 */(entry: any) => entry.role === 'context').length, 1);
    assert.equal(approved.payload.work.filter(/** 仅执行一次新的架构生成。 */(entry: any) => entry.role === 'architect').length, 1);
  } finally { await app.storage.close(); rmSync(directory, { recursive: true, force: true }); }
});

test('架构返回业务阻塞时投影具体事项和产品依据，不冒充模型超时或方案已批准', /** 模型输出阻塞并不会授权实现，前端需要实际材料而非笼统结束文案。 */async () => {
  const directory = mkdtempSync(resolve(tmpdir(), 'architecture-blockage-'));
  const config = { rootDir: resolve('.'), mode: 'fixture' as const, modelId: 'openai/fixture' as const, port: 4111, databaseUrl: `file:${resolve(directory, 'workflow.db')}` };
  const app = createStudioApplicationOptions(config);
  /** 保留正式校验，只在合成架构方案中列出一个未决选择。 */
  const generate: GeneratorV2 = async (...args) => { const entry = await generateV2(...args); if (args[2] !== 'architect') return entry; const plan = JSON.parse(entry.text); plan.blockers = ['合成待确认：本期业务范围']; return { ...entry, text: JSON.stringify(plan) }; };
  const workflow = createProductDevelopmentWorkflow(app.agents as any, config, generate, { legacyBlocked: true }); new Mastra({ ...app, workflows: { productDevelopmentWorkflow: workflow } });
  try {
    const run = await workflow.createRun(); await run.start({ inputData: { brief: '合成业务阻塞反馈', iterationId: 'blockage-feedback' } });
    let current = await readIntake(workflow, run.runId);
    current = await respondIntake(workflow, 'fixture', run.runId, { role: 'product', artifactHash: current.product!.artifact.hash, decision: 'approve', reviewer: 'test', comment: '合成批准' });
    current = await respondIntake(workflow, 'fixture', run.runId, { gateHash: current.gate!.gateHash, data: { reviewer: 'test', comment: '合成项目', project: { id: 'blockage', files: { 'src/a.mjs': 'export const a=0;', 'check.mjs': 'export const c=1;' }, writablePaths: ['src/a.mjs'], checkFiles: ['check.mjs'], roles: ['backend'] } } });
    assert.equal(current.status, 'success'); assert.equal(current.outcome, 'blocked'); assert.equal(current.gate, undefined); assert.equal(current.retry, undefined);
    assert.equal(current.blockage!.phase, '技术方案生成'); assert.deepEqual(current.blockage!.blockers, ['合成待确认：本期业务范围']); assert.equal(current.blockage!.taskCount, 1); assert.ok(current.blockage!.productContent.length > 0);
    const snapshot = await workflow.getWorkflowRunById(run.runId); assert.notEqual((snapshot!.steps!['testing'] as any)?.status, 'success');
  } finally { await app.storage.close(); rmSync(directory, { recursive: true, force: true }); }
});
