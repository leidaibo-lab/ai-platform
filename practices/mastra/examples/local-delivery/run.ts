/** 原生主链的示例组织者；自动决策属于evaluation-policy，发布证据来自实际本机I/O。
 * ADR: docs/decisions/2026-11-09-mastra-local-delivery-example.md
 */
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Mastra } from '@mastra/core';
import { noopLogger } from '@mastra/core/logger';
import { LibSQLStore } from '@mastra/libsql';
import { createProductDevelopmentWorkflow, executionResolver } from '../../src/mastra/workflows/product-development.js';
import { developmentHash } from '../../src/development/contracts.js';
import { lifecycleSchema, type Lifecycle } from '../../src/delivery/contracts.js';
import type { PracticeConfig } from '../../src/mastra/config.js';
import type { EntryV2, StateV2 } from '../../src/development/v2/contracts.js';
import type { GeneratorV2 } from '../../src/development/v2/agents.js';
import { brief, browserCases, exampleProject } from './scenario.js';
import { scenarioAgents, scenarioGenerate } from './models.js';
import { buildArtifact, localRelease, type LocalArtifact, type LocalObservation } from './local-release.js';

/** 所有可持久化字段均为脱敏示例数据；状态事实仍归独占Mastra数据库。 */
export interface ExampleReport {
  version: 'local-delivery-example.v1'; scenario: 'success' | 'health-failure';
  modelMode: 'fixture'; approvalAuthority: 'evaluation-policy'; workflowReceiptAuthority: 'local-human-report';
  status: 'running' | 'passed' | 'failed'; startedAt: string; finishedAt: string | null; runId: string | null;
  workflowStatus: string | null; outcome: string | null; error: string | null;
  gates: { path: string[]; inputFile: string; decisionFile: string | null }[];
  roles: EntryV2[]; development: StateV2['delivery']; quality: Lifecycle['quality'] | null;
  artifact: LocalArtifact | null; observations: { phase: string; value: LocalObservation }[];
  rollbackVerified: boolean; cleanup: boolean; limitations: string[];
}

/** 保存有序证据；JSON失败不能被当作成功交付。 */
function saveJson(path: string, data: unknown) { writeFileSync(path, JSON.stringify(data, null, 2) + '\n', { mode: 0o600 }); }

/**
 * 在全新目录执行两个固定场景之一；异常保存失败报告并抛出，绝不回填虚构发布结果。
 * 每个暂停点关闭Store并重装同一主Workflow，保留原Run和审批事实。
 */
export async function runLocalExample(directory: string, scenario: ExampleReport['scenario']): Promise<ExampleReport> {
  assert.ok(Number(process.versions.node.split('.')[0]) >= 24, '本机示例需要Node.js 24+；请先nvm use 24');
  mkdirSync(directory, { recursive: false, mode: 0o700 });
  const report: ExampleReport = { version: 'local-delivery-example.v1', scenario, modelMode: 'fixture', approvalAuthority: 'evaluation-policy', workflowReceiptAuthority: 'local-human-report', status: 'running', startedAt: new Date().toISOString(), finishedAt: null, runId: null, workflowStatus: null, outcome: null, error: null, gates: [], roles: [], development: null, quality: null, artifact: null, observations: [], rollbackVerified: false, cleanup: false, limitations: ['固定模型输出不证明真实模型自主开发质量。', '审批为预登记evaluation-policy，不冒充真实人工业务验收。', '本机静态服务不代表HRM全栈、远程CI/CD、代码回库或生产部署。', '主Workflow发布authority仍为local-human-report，机器观察独立保存。'] };
  const config: PracticeConfig = { rootDir: fileURLToPath(new URL('../../', import.meta.url)), mode: 'fixture', modelId: 'openai/local-fixture', port: 4111, databaseUrl: 'file:' + resolve(directory, 'workflow.db') };
  const project = exampleProject();
  const actor = { reviewer: 'evaluation-policy', comment: '用户授权的本机示例：预登记测试决策，不代表人工业务批准或生产发布' };
  const environment = await localRelease();
  /** 实现输出记录实际原生调用；不从模型自然语言猜测工具执行。 */
  const generate: GeneratorV2 = async (...args) => { const entry = await scenarioGenerate(...args); report.roles.push(entry); return entry; };
  /** 每次重装均使用同一版本工厂和独占数据库。 */
  async function open() {
    const agents = scenarioAgents(config);
    const workflow = createProductDevelopmentWorkflow(agents, config, generate);
    const storage = new LibSQLStore({ id: 'local-example', url: config.databaseUrl });
    new Mastra({ agents, workflows: { productDevelopmentWorkflow: workflow }, storage, logger: noopLogger });
    await storage.init();
    return { workflow, storage };
  }
  let app: Awaited<ReturnType<typeof open>> | undefined;
  /** 真实探测保存到报告，失败保留原观察供流程决定回滚。 */
  async function observe(phase: string, artifact: LocalArtifact, version: 'v0' | 'v1') {
    const observation = await environment.probe(artifact, resolve(directory, phase + '.png'), version);
    report.observations.push({ phase, value: observation });
    return observation;
  }
  try {
    saveJson(resolve(directory, 'input.json'), { brief, project, scenario, actor });
    saveJson(resolve(directory, 'previous-artifact.json'), environment.previous);
    assert.equal((await observe('baseline', environment.previous, 'v0')).status, 'passed');
    app = await open();
    let run = await app.workflow.createRun(); report.runId = run.runId;
    let result: any = await run.start({ inputData: { brief, iterationId: 'local-title-example' } });
    for (let count = 0; result.status === 'suspended' && count < 20; count++) {
      const path: string[] = result.suspended[0];
      const id = path.at(-1)!;
      const payload = result.steps[path[0]]?.suspendPayload;
      assert.ok(payload, '暂停点缺少载荷');
      const inputFile = 'gate-' + count + '-' + id + '.json';
      const gate = { path, inputFile, decisionFile: null as string | null };
      report.gates.push(gate); saveJson(resolve(directory, inputFile), payload);
      saveJson(resolve(directory, 'report.json'), report);
      let data: unknown;
      if (id === 'review-product') {
        assert.ok(payload.artifact.content.includes('工单标题'));
        data = { ...actor, role: 'product', artifactHash: payload.artifact.hash, decision: 'approve' };
      } else if (id === 'confirm-project-scope') data = { ...actor, project, maxReworks: 1 };
      else if (id === 'approve-architecture') data = { ...actor, hash: payload.hash, decision: 'approve' };
      else if (id === 'approve-test-cases') {
        const refs = payload.requirements.map(/** 覆盖所有固定批准原文锚点。 */ (item: { id: string }) => item.id);
        data = { ...actor, hash: payload.plan.hash, decision: 'approve', cases: [{ id: 'title-boundaries', requirementRefs: refs, expected: 'TYPE、空白、1/80/81码点、Unicode和trim通过独立进程检查', method: 'registered-check', checkRefs: payload.registeredChecks }, ...browserCases().map(/** 按固定预登记用例批准实际浏览器执行。 */ item => ({ ...item, requirementRefs: refs, method: 'browser', checkRefs: [] }))] };
      } else if (id === 'review-test-results') {
        assert.ok(payload.quality.checks.length && payload.quality.checks.every(/** 只有真实无截断进程证据可以放行。 */ (check: { exitCode: number; processExitCode: number; timedOut?: boolean; stdoutTruncated?: boolean; stderrTruncated?: boolean }) => check.exitCode === 0 && check.processExitCode === 0 && !check.timedOut && !check.stdoutTruncated && !check.stderrTruncated));
        assert.equal(payload.quality.browser?.receipts.length, 3);
        for (const receipt of payload.quality.browser.receipts) { assert.equal(receipt.status, 'passed'); assert.ok(receipt.screenshot); }
        report.quality = payload.quality;
        data = { ...actor, hash: payload.hash, decision: 'pass', manualResults: [], findings: [] };
      } else if (id === 'approve-release-scope') {
        const snapshot: any = await app.workflow.getWorkflowRunById(report.runId!);
        const state = lifecycleSchema.parse(snapshot?.steps?.['initialize-delivery-lifecycle']?.output);
        assert.ok(state.development.delivery);
        report.development = state.development.delivery;
        const candidate = executionResolver(config)(state.development.input);
        try {
          const snapshot = await candidate.snapshot();
          assert.equal(developmentHash(snapshot), state.development.checkpointHash, '候选与已测试源码不一致');
          assert.deepEqual({ ...snapshot }, state.development.delivery.files, '交付文件摘要不一致');
          report.artifact = buildArtifact(state.development.checkpointHash, { 'page.html': await candidate.readFile('page.html') });
          assert.equal(developmentHash(await candidate.snapshot()), state.development.checkpointHash, '构建期间候选变化');
        } finally { await candidate.close(); }
        saveJson(resolve(directory, 'artifact.json'), report.artifact);
        writeFileSync(resolve(directory, 'page.html'), report.artifact.page);
        data = { ...actor, hash: payload.packageHash, decision: 'approve', scope: { environment: 'local-loopback', artifactDigest: report.artifact.digest, artifactRef: 'local://candidate/page.html', rollbackArtifactRef: 'local://previous/page.html', healthChecks: [{ id: 'page', expected: 'HTTP200、同制品摘要及工单表单交互通过' }] } };
      } else if (id === 'execute-release-externally') {
        assert.ok(report.artifact); assert.equal(payload.artifactDigest, report.artifact.digest); assert.equal(payload.sourceHash, report.artifact.sourceHash);
        environment.deploy(report.artifact, scenario === 'health-failure');
        data = { releaseHash: payload.releaseHash, sourceHash: payload.sourceHash, artifactDigest: payload.artifactDigest, environment: payload.environment, status: 'succeeded', jobRef: 'local://static-switch', operator: 'evaluation-policy', finishedAt: new Date().toISOString(), notes: '本机静态制品已切换；独立HTTP/页面观察在后续健康检查执行，非远程发布。' };
      } else if (id === 'verify-release-health') {
        assert.ok(report.artifact);
        const observation = await observe('published', report.artifact, 'v1');
        assert.equal(observation.status, scenario === 'success' ? 'passed' : 'failed');
        if (scenario === 'health-failure') assert.equal(observation.httpStatus, 503);
        data = { releaseHash: payload.releaseHash, deploymentReceiptHash: payload.deploymentReceiptHash, operator: 'evaluation-policy', checks: [{ id: 'page', status: observation.status, evidence: '见report.json observations.published；HTTP=' + observation.httpStatus, observedAt: observation.observedAt }] };
      } else if (id === 'execute-rollback-externally') {
        environment.deploy(environment.previous);
        assert.equal((await observe('rollback', environment.previous, 'v0')).status, 'passed'); report.rollbackVerified = true;
        data = { releaseHash: payload.releaseHash, rollbackArtifactRef: payload.rollbackArtifactRef, status: 'rolled-back', jobRef: 'local://restore-v0', operator: 'evaluation-policy', notes: '实际切回上一制品并通过HTTP摘要和浏览器页面核验，见report.json。' };
      } else throw new Error('遇到未登记暂停点，保留证据并停止：' + id);
      gate.decisionFile = inputFile.replace('.json', '-decision.json'); saveJson(resolve(directory, gate.decisionFile), data);
      await app.storage.close(); app = await open();
      run = await app.workflow.createRun({ runId: report.runId! });
      result = await run.resume({ step: path, resumeData: data });
    }
    report.workflowStatus = result.status;
    if (result.status !== 'success') saveJson(resolve(directory, 'workflow-incomplete.json'), result);
    assert.equal(result.status, 'success', '主Workflow未成功结束；检查gate输入和独占数据库');
    const final = lifecycleSchema.parse(result.result);
    report.outcome = final.outcome; report.quality = final.quality; report.development = final.development.delivery;
    saveJson(resolve(directory, 'workflow-result.json'), final);
    assert.equal(final.quality.status, 'passed');
    assert.equal(final.outcome, scenario === 'success' ? 'fixture-completed' : 'rolled-back');
    if (scenario === 'success') {
      environment.deploy(environment.previous);
      assert.equal((await observe('rollback-drill', environment.previous, 'v0')).status, 'passed'); report.rollbackVerified = true;
    }
    assert.ok(report.rollbackVerified);
    assert.ok(report.roles.some(/** 确认经过真实委派工具。 */ entry => entry.tools.includes('delegateTask')));
    assert.ok(report.roles.some(/** 确认经过真实候选写工具。 */ entry => entry.tools.includes('writeFile')));
    assert.ok(report.roles.some(/** 确认自检实际调用固定检查。 */ entry => entry.tools.includes('runChecks')));
    report.status = 'passed';
    return report;
  } catch (error) {
    report.status = 'failed'; report.error = '本机闭环未通过，查看暂停载荷、机器观察与workflow.db；不得宣称业务验收完成。';
    throw error;
  } finally {
    try { await app?.storage.close(); }
    finally { await environment.close(); report.cleanup = true; report.finishedAt = new Date().toISOString(); saveJson(resolve(directory, 'report.json'), report); }
  }
}
