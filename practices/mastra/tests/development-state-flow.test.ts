/** 原生阶段状态与旧图恢复回归；合成模型不会访问真实用户 Run。 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { Mastra } from '@mastra/core';
import { LibSQLStore } from '@mastra/libsql';
import { seedDevelopment } from '../src/development-service.js';
import { DevelopmentExecution } from '../src/development-execution.js';
import { developmentHash } from '../src/development/contracts.js';
import { inputV2Schema, stateV2Schema } from '../src/development/v2/contracts.js';
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
  const generate: GeneratorV2 = async (...args) => { calls.push(args[2]); if (args[2] === 'architect' && failing) throw Object.assign(new Error('synthetic-secret-must-not-leak'), { name: 'MastraTimeoutError' }); return generateV2(...args); };
  const setup = fixture(generate); let app = setup.open(legacy);
  try {
    const run = await app.workflow.createRun(); await run.start({ inputData: app.input });
    let snapshot = await app.workflow.getWorkflowRunById(run.runId);
    const path = legacy ? 'development-iteration-v2.recover-development' : 'development-iteration-v2.architecture';
    const paused = snapshot!.steps![path] as any; assert.equal(paused.status, 'suspended');
    const state = stateV2Schema.parse(paused.suspendPayload.recoveryState ?? paused.payload);
    assert.equal(state.phase, 'architecture'); assert.equal(state.faults.length, 2); assert.equal(state.calls, 3);
    if (!legacy) {
      for (const name of ['assemble-agent-team', 'assess-readiness', 'approve-architecture', 'implement', 'development-self-check', 'review-code', 'resolve-findings', 'recover-development']) assert.notEqual((snapshot!.steps![`development-iteration-v2.${name}`] as any)?.status, 'success');
      assert.deepEqual(calls, ['context', 'architect', 'architect']);
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
