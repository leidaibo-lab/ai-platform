/** 新版完整主链原生持久化回归；所有审批及发布回执均为合成测试数据。 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { Mastra } from '@mastra/core';
import { createStudioApplicationOptions } from '../src/mastra/app.js';
import { createProductDevelopmentWorkflow } from '../src/mastra/workflows/product-development.js';
import type { PracticeConfig } from '../src/mastra/config.js';

const actor = { reviewer: 'evaluation-policy', comment: '合成可靠性测试授权，不代表业务人工批准' };
const project = { id: 'reliability', files: { 'src/a.mjs': 'export const initial=0;', 'src/b.mjs': 'export const initial=0;', 'check.mjs': 'import {test} from "node:test"; import assert from "node:assert/strict"; import {fixtureValue as a} from "./src/a.mjs"; import {fixtureValue as b} from "./src/b.mjs"; test("two modules",/** 检查两个真实模块。 */()=>{assert.equal(a(),1);assert.equal(b(),1)});' }, writablePaths: ['src/a.mjs', 'src/b.mjs'], checkFiles: ['check.mjs'], roles: ['frontend', 'backend'] };

/** 原生嵌套暂停结果给出完整步骤路径，不从历史已完成节点猜测审批点。 */
function paused(result: any): { path: string[]; payload: any } {
  assert.equal(result.status, 'suspended', JSON.stringify(result));
  const path = result.suspended[0];
  return { path, payload: result.steps[path[0]]?.suspendPayload };
}

// 每个暂停点关闭Store再装配，验证原生快照续跑而非内存闭包。
for (const scenario of ['success', 'health-failure', 'reject-product', 'stale-product', 'stale-release', 'wrong-artifact', 'missing-health', 'deploy-failure', 'qa-rework', 'qa-fixed']) {
  test(`完整产研主链与跨Store恢复：${scenario}`, /** 在独占运行库验证当前分支。 */ async () => {
    const directory = mkdtempSync(resolve(tmpdir(), 'mastra-unified-'));
    const config: PracticeConfig = { rootDir: resolve('.'), mode: 'fixture', modelId: 'openai/fixture', port: 4111, databaseUrl: `file:${resolve(directory, 'workflow.db')}` };
    /** 重装相同Workflow与数据库，保持审批事实归原生Store。 */
    async function open() {
      const options = createStudioApplicationOptions(config);
      if (scenario === 'qa-fixed') {
        /** 只注入合成评审修复结论；源码修改、自检和QA重跑均真实执行。 */
        const generate: GeneratorV2 = async (...args) => {
          const entry = await generateV2(...args);
          if (args[2] !== 'reviewer' || args[3].round === 0) return entry;
          const assessment = JSON.parse(entry.text);
          assessment.resolutions = [{ findingId: 'qa-1', decision: 'fixed', reason: '合成独立评审确认本轮重新实现及固定检查证据', refs: ['task:fixture-task-2'] }];
          return { ...entry, text: JSON.stringify(assessment) };
        };
        options.workflows.productDevelopmentWorkflow = createProductDevelopmentWorkflow(options.agents as any, config, generate);
      }
      new Mastra(options); await options.storage.init();
      return { workflow: options.workflows.productDevelopmentWorkflow, storage: options.storage };
    }
    let app = await open();
    try {
      let run = await app.workflow.createRun(); const runId = run.runId;
      let result: any = await run.start({ inputData: { brief: '固定fixture双模块工具链', iterationId: 'reliability' } });
      const visited: string[] = [];
      for (let count = 0; result.status === 'suspended' && count < 15; count++) {
        const pending = paused(result); const id = pending.path.at(-1)!; const p = pending.payload;
        assert.ok(p, `缺少暂停载荷 ${JSON.stringify(result)}`); visited.push(id);
        let data: any;
        if (id === 'review-product') data = { ...actor, role: 'product', artifactHash: scenario === 'stale-product' ? '0'.repeat(64) : p.artifact.hash, decision: scenario === 'reject-product' ? 'reject' : 'approve' };
        else if (id === 'confirm-project-scope') data = { ...actor, project, maxReworks: 1 };
        else if (id === 'approve-architecture') { assert.equal(p.team.members.length, 2); data = { ...actor, hash: p.hash, decision: 'approve' }; }
        else if (id === 'approve-test-cases') data = { ...actor, hash: p.plan.hash, decision: 'approve', cases: [{ id: 'automatic', requirementRefs: p.requirements.map(/** 保留所有批准原文引用。 */(r: any) => r.id), expected: '两个模块返回1', method: 'registered-check', checkRefs: p.registeredChecks }] };
        else if (id === 'review-test-results') { assert.ok(p.quality.checks.length); data = { ...actor, hash: p.hash, decision: ['qa-rework', 'qa-fixed'].includes(scenario) && visited.filter(/** 只在首轮质量门注入缺陷。 */(step) => step === id).length === 1 ? 'rework' : 'pass', manualResults: [], findings: ['qa-rework', 'qa-fixed'].includes(scenario) && visited.filter(/** 保留一次实际返工。 */(step) => step === id).length === 1 ? [{id: 'qa-1', severity: 'medium', category: 'implementation', route: 'backend', detail: '合成缺陷用于验证修复路由', refs: ['task:fixture-task-2'], evidence: '合成质量门故障注入'}] : [] }; }
        else if (id === 'approve-release-scope') data = { ...actor, hash: scenario === 'stale-release' ? '0'.repeat(64) : p.packageHash, decision: 'approve', scope: { environment: 'synthetic', artifactDigest: 'a'.repeat(64), artifactRef: 'synthetic://artifact', rollbackArtifactRef: 'synthetic://previous', healthChecks: [{ id: 'ready', expected: 'ready' }] } };
        else if (id === 'execute-release-externally') data = { releaseHash: p.releaseHash, sourceHash: p.sourceHash, artifactDigest: scenario === 'wrong-artifact' ? 'b'.repeat(64) : p.artifactDigest, environment: p.environment, status: scenario === 'deploy-failure' ? 'failed' : 'succeeded', jobRef: 'synthetic://job', operator: 'fixture', finishedAt: '2026-11-07T00:00:00Z', notes: '模拟回执，未部署' };
        else if (id === 'verify-release-health') data = { releaseHash: p.releaseHash, deploymentReceiptHash: p.deploymentReceiptHash, operator: 'fixture', checks: [{ id: scenario === 'missing-health' ? 'unknown' : 'ready', status: scenario === 'health-failure' ? 'failed' : 'passed', evidence: '合成健康结果', observedAt: '2026-11-07T00:00:00Z' }] };
        else if (id === 'execute-rollback-externally') data = { releaseHash: p.releaseHash, rollbackArtifactRef: p.rollbackArtifactRef, status: 'rolled-back', jobRef: 'synthetic://rollback', operator: 'fixture', notes: '模拟回滚' };
        else assert.fail(`未预期暂停点 ${id}`);
        await app.storage.close(); app = await open(); run = await app.workflow.createRun({ runId });
        result = await run.resume({ step: pending.path, resumeData: data });
      }
      if (['stale-release', 'wrong-artifact', 'missing-health'].includes(scenario)) { assert.equal(result.status, 'failed'); return; }
      if (scenario === 'stale-product') { assert.equal(result.status, 'failed'); assert.deepEqual(visited, ['review-product']); return; }
      assert.equal(result.status, 'success', JSON.stringify(result));
      assert.equal(result.result.outcome, scenario === 'qa-rework' ? 'rework-exhausted' : scenario === 'reject-product' ? 'rejected' : ['health-failure', 'deploy-failure'].includes(scenario) ? 'rolled-back' : 'fixture-completed');
      if (['qa-rework', 'qa-fixed'].includes(scenario)) { assert.equal(result.result.qualityHistory.length, 1); assert.equal(result.result.development.round, 1); }
      if (scenario === 'success') { assert.equal(result.result.development.delegations.length, 2); assert.equal(result.result.quality.status, 'passed'); assert.ok(visited.includes('verify-release-health')); }
    } finally { await app.storage.close(); rmSync(directory, { recursive: true, force: true }); }
  });
}

/** 团队故障注入仍经过真实原生Workflow、委派和候选隔离。 */
import { createDevelopmentWorkflowV2 } from '../src/mastra/workflows/development-v2.js';
import { DevelopmentExecution } from '../src/development-execution.js';
import { seedDevelopment } from '../src/development-service.js';
import { inputV2Schema } from '../src/development/v2/contracts.js';
import { developmentHash } from '../src/development/contracts.js';
import { generateV2, type GeneratorV2 } from '../src/development/v2/agents.js';
import { LibSQLStore } from '@mastra/libsql';

for (const scenario of ['dependency', 'parallel', 'failed-member', 'delegation-scope']) {
  // 对成功并行分支、依赖波次与越权委派分别保留真实执行断言。
  test(`动态团队：${scenario}`, /** 在独占运行库验证当前分支。 */ async () => {
    const parent = mkdtempSync(resolve(tmpdir(), 'mastra-team-regression-')); const directory = resolve(parent, 'run');
    const content = '合成双模块各自返回1';
    const input = inputV2Schema.parse({ source: { kind: 'evaluation', runId: 'team-evaluation', content, hash: developmentHash(content), evidence: 'evaluation-input' }, project, maxReworks: 1 });
    seedDevelopment(directory, input);
    const execution = new DevelopmentExecution(resolve(directory, 'candidate'), project.writablePaths, project.checkFiles);
    const config: PracticeConfig = { rootDir: resolve('.'), mode: 'fixture', modelId: 'openai/fixture', port: 4111, databaseUrl: `file:${resolve(parent, 'workflow.db')}` };
    const children: string[] = [];
    let recovering = false;
    let arrivals = 0; let release!: () => void;
    const barrier = new Promise<void>(/** 两个父任务均进入才允许继续，以证明真实重叠执行。 */(done) => { release = done; });
    let barrierTimeout: ReturnType<typeof setTimeout> | undefined;
    /** 只改变架构依赖或指定成员故障，不替换I/O与门禁。 */
    const generate: GeneratorV2 = async (...args) => {
      const runtime = args[7]; const paths = args[4];
      if (runtime?.delegate && scenario === 'parallel') {
        if (++arrivals === 2) release();
        await Promise.race([barrier, new Promise<void>(/** 串行退化应有界失败，不能挂住整套回归。 */(_, reject) => { barrierTimeout = setTimeout(/** 超时仅作为并行断言失败。 */() => reject(new Error('parallel barrier timeout')), 3000); })]);
      }
      if (runtime?.delegate && paths.includes('src/b.mjs') && scenario === 'failed-member' && !recovering) throw new SyntaxError('controlled-member-failure');
      if (runtime?.delegate && scenario === 'delegation-scope') await runtime.delegate({ role: 'backend', goal: '越权注入', paths: ['outside.mjs'] });
      if (runtime && !runtime.delegate) {
        if (scenario === 'dependency' && paths.includes('src/b.mjs')) assert.match(await args[1].readFile('src/a.mjs'), /fixtureValue/);
        children.push(paths[0]);
      }
      const entry = await generateV2(...args);
      if (args[2] === 'architect' && scenario === 'dependency') { const plan = JSON.parse(entry.text); plan.tasks[1].dependsOn = [plan.tasks[0].id]; return { ...entry, text: JSON.stringify(plan) }; }
      return entry;
    };
    const workflow = createDevelopmentWorkflowV2(config, execution, true, generate, { team: true });
    const storage = new LibSQLStore({ id: 'team-test', url: config.databaseUrl }); new Mastra({ storage, workflows: { workflow } });
    try {
      await storage.init(); const run = await workflow.createRun(); const result: any = await run.start({ inputData: input });
      if (scenario === 'parallel') { assert.equal(arrivals, 2); assert.equal(result.status, 'success'); assert.equal(result.result.outcome, 'development-delivered'); }
      else if (scenario === 'dependency') { assert.equal(result.status, 'success'); assert.equal(result.result.outcome, 'development-delivered'); assert.deepEqual(children, ['src/a.mjs', 'src/b.mjs']); }
      else {
        const pending = paused(result); assert.equal(pending.path.at(-1), 'execute-agent-team');
        if (scenario === 'failed-member') {
          assert.match(await execution.readFile('src/a.mjs'), /fixtureValue/); assert.equal(await execution.readFile('src/b.mjs'), project.files['src/b.mjs']);
          recovering = true;
          const resumed: any = await run.resume({ step: pending.path, resumeData: { ...actor, hash: pending.payload.hash, decision: 'retry' } });
          assert.equal(resumed.status, 'success'); assert.equal(resumed.result.outcome, 'development-delivered');
          assert.equal(children.filter(/** 成功分支不应在人工重试中重新派发。 */path => path === 'src/a.mjs').length, 1);
        }
        else { assert.equal(await execution.readFile('src/a.mjs'), project.files['src/a.mjs']); assert.deepEqual(children, []); }
      }
    } finally { if (barrierTimeout) clearTimeout(barrierTimeout); await execution.close(); await storage.close(); rmSync(parent, { recursive: true, force: true }); }
  });
}
