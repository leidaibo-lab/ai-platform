import { readCandidateChanges } from '../src/intake/candidate-changes.js';
import { approvalHashV2, validatePlanV2 } from '../src/development/v2/contracts.js';
import { assertApprovalV2 } from '../src/development/v2/gates.js';
import { validateQualityReview } from '../src/delivery/testing.js';
/** 新版完整主链原生持久化回归；所有审批及发布回执均为合成测试数据。 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { Mastra } from '@mastra/core';
import { createStudioApplicationOptions } from '../src/mastra/app.js';
import { createProductDevelopmentWorkflow } from '../src/mastra/workflows/product-development.js';
import { readIntake, respondIntake } from '../src/intake/service.js';
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
for (const scenario of ['success', 'stable-requirements', 'stable-revision', 'health-failure', 'health-business-gap', 'reject-product', 'stale-product', 'stale-release', 'wrong-artifact', 'missing-health', 'deploy-failure', 'qa-rework', 'qa-business-gap', 'qa-fixed', 'browser-success', 'browser-failure', 'test-plan-incomplete', 'release-plan-incomplete']) {
  test(`完整产研主链与跨Store恢复：${scenario}`, /** 在独占运行库验证当前分支。 */ async () => {
    const directory = mkdtempSync(resolve(tmpdir(), 'mastra-unified-'));
    const config: PracticeConfig = { ...(['health-failure', 'health-business-gap', 'stale-release', 'wrong-artifact', 'missing-health', 'deploy-failure', 'release-plan-incomplete'].includes(scenario) ? { legacyDeployment: true } : {}), rootDir: resolve('.'), mode: 'fixture', modelId: 'openai/fixture', port: 4111, databaseUrl: `file:${resolve(directory, 'workflow.db')}` };
    /** 重装相同Workflow与数据库，保持审批事实归原生Store。 */
    async function open() {
      const options = createStudioApplicationOptions(config);
      if (scenario.startsWith('stable-')) options.workflows.productDevelopmentWorkflow = createProductDevelopmentWorkflow(options.agents as any, config, undefined, { fixtureRequirementTracking: true, fixtureArchitectureDocument: true });
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
      if (scenario === 'test-plan-incomplete' || scenario === 'release-plan-incomplete') {
        const agent = scenario === 'test-plan-incomplete' ? options.agents.testingAgent : options.agents.operationsAgent;
        // 模拟原生压缩或模型调用中断仍带部分文本，不能进入人工批准。
        agent.generate = (async () => ({ text: '部分计划', finishReason: 'other' })) as any;
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
        if (id === 'review-product' && scenario.startsWith('stable-')) {
          assert.match(p.artifact.content, /^# 需求文档[\s\S]*REQ-FIXTURE-A[\s\S]*# 产品规格[\s\S]*TASK-FIXTURE-MODULES/);
        }
        if (id === 'review-product') data = { ...actor, role: 'product', artifactHash: scenario === 'stale-product' ? '0'.repeat(64) : p.artifact.hash, decision: scenario === 'reject-product' ? 'reject' : 'approve' };
        else if (id === 'confirm-project-scope') data = { ...actor, project: scenario.startsWith('browser-') ? { ...project, files: { ...project.files, 'page.html': '<!doctype html><p id="result">候选页面</p>' } } : project, maxReworks: 1 };
        else if (id === 'approve-architecture') {
          if (scenario === 'success') assert.equal((await readCandidateChanges(app.workflow, runId, config)).status, 'pending');
          assert.equal(p.team.members.length, 2);
          if (scenario.startsWith('stable-')) {
            assert.ok(p.plan.document.impact);
            assert.equal(p.architectureMarkdown.match(/```mermaid/g)?.length, 2);
            const gate = (await readIntake(app.workflow, runId)).gate!;
            assert.equal(gate.evidence.architectureMarkdown, p.architectureMarkdown);
          } else assert.equal(p.architectureMarkdown, undefined);
          data = { ...actor, hash: p.hash, decision: 'approve' };
        }
        else if (id === 'approve-test-cases') data = { ...actor, hash: p.plan.hash, decision: 'approve', cases: [{ id: 'automatic', requirementRefs: p.requirements.map(/** 保留所有批准原文引用。 */(r: any) => r.id), expected: '两个模块返回1', method: 'registered-check', checkRefs: p.registeredChecks }] };
        else if (id === 'review-test-results') { assert.ok(p.quality.checks.length); const firstReview = visited.filter(/** 只在首轮质量门注入缺陷。 */step => step === id).length === 1; const qaBusiness = ['qa-business-gap', 'stable-revision'].includes(scenario) && firstReview; const qaRework = ['qa-rework', 'qa-fixed'].includes(scenario) && firstReview; data = { ...actor, hash: p.hash, decision: qaBusiness || qaRework ? 'rework' : 'pass', manualResults: [], findings: qaBusiness ? [{id: 'qa-business-1', severity: 'blocking', category: 'business', route: 'product', detail: '验收口径缺少人工确认', refs: [p.quality.approval.cases[0].requirementRefs[0]], evidence: '合成 QA 业务缺口'}] : qaRework ? [{id: 'qa-1', severity: 'medium', category: 'implementation', route: 'backend', detail: '合成缺陷用于验证修复路由', refs: ['task:fixture-task-2'], evidence: '合成质量门故障注入'}] : [] }; }
        else if (id === 'confirm-blocker-answers') data = { hash: p.hash, reviewer: 'fixture', answers: p.plan.questions.filter(/** 所有必答业务阻塞都必须有显式选择。 */(question: any) => question.required).map((question: any) => ({ questionId: question.id, selected: [question.options[0].id], custom: '' })), supplement: '合成确认 QA 或发布阶段发现的业务口径' };
        else if (id === 'review-revised-product') data = { hash: p.draft.hash, decision: 'approve', reviewer: 'fixture', comment: '合成确认修订产品稿，重新规划并回归' };
        else if (id === 'approve-release-scope') data = { ...actor, hash: scenario === 'stale-release' ? '0'.repeat(64) : p.packageHash, decision: 'approve', scope: { environment: 'synthetic', artifactDigest: 'a'.repeat(64), artifactRef: 'synthetic://artifact', rollbackArtifactRef: 'synthetic://previous', healthChecks: [{ id: 'ready', expected: 'ready' }] } };
        else if (id === 'execute-release-externally') data = { releaseHash: p.releaseHash, sourceHash: p.sourceHash, artifactDigest: scenario === 'wrong-artifact' ? 'b'.repeat(64) : p.artifactDigest, environment: p.environment, status: scenario === 'deploy-failure' ? 'failed' : 'succeeded', jobRef: 'synthetic://job', operator: 'fixture', finishedAt: '2026-11-07T00:00:00Z', notes: '模拟回执，未部署' };
        else if (id === 'verify-release-health') { const releaseBusiness = scenario === 'health-business-gap' && visited.filter(/** 仅首个发布健康确认触发业务澄清。 */step => step === id).length === 1; data = { releaseHash: p.releaseHash, deploymentReceiptHash: p.deploymentReceiptHash, operator: 'fixture', checks: [{ id: scenario === 'missing-health' ? 'unknown' : 'ready', status: scenario === 'health-failure' || releaseBusiness ? 'failed' : 'passed', evidence: '合成健康结果', observedAt: '2026-11-07T00:00:00Z' }], findings: releaseBusiness ? [{ id: 'release-business-1', severity: 'blocking', category: 'business', route: 'product', detail: '健康门发现业务验收口径未确认', refs: ['product:L1'], evidence: '合成发布健康业务缺口' }] : [] }; }
        else if (id === 'execute-rollback-externally') data = { releaseHash: p.releaseHash, rollbackArtifactRef: p.rollbackArtifactRef, status: 'rolled-back', jobRef: 'synthetic://rollback', operator: 'fixture', notes: '模拟回滚' };
        else assert.fail(`未预期暂停点 ${id}`);
        if (scenario === 'success' && id === 'approve-test-cases') {
          const changes = await readCandidateChanges(app.workflow, runId, config);
          assert.equal(changes.status, 'ready');
          if (changes.status === 'ready') {
            assert.equal(changes.sourceHash, p.plan.sourceHash);
            assert.deepEqual(changes.files.map(file => file.path), ['src/a.mjs', 'src/b.mjs']);
            assert.equal(changes.files[0]?.before, project.files['src/a.mjs']);
            assert.match(changes.files[0]?.after ?? '', /fixtureValue/);
          }
        }
        if (scenario.startsWith('browser-') && id === 'approve-test-cases') data.cases.push({ id: 'browser', requirementRefs: p.requirements.map(/** 浏览器用例仍引用批准需求。 */(r: any) => r.id), expected: '页面显示候选内容', method: 'browser', checkRefs: [], browser: { entry: 'page.html', assets: [], actions: [], assertions: [{ selector: '#result', text: scenario === 'browser-failure' ? '不存在' : '候选页面' }] } });
        if (scenario.startsWith('browser-') && id === 'review-test-results') {
          assert.equal(p.quality.browser.receipts[0].status, scenario === 'browser-failure' ? 'failed' : 'passed');
          assert.ok(p.quality.browser.receipts[0].screenshot);
          if (scenario === 'browser-failure') { assert.throws(/** 失败断言不能用人工通过覆盖。 */() => validateQualityReview(p.quality ? { development: { checkpointHash: p.quality.sourceHash, requirements: [], verificationRefs: [] }, quality: p.quality } as any : {} as any, data), /测试未全部通过/); data.decision = 'stop'; }
        }
        await app.storage.close(); app = await open(); run = await app.workflow.createRun({ runId });
        result = await run.resume({ step: pending.path, resumeData: data });
      }
      if (scenario === 'test-plan-incomplete' || scenario === 'release-plan-incomplete') {
        assert.equal(result.status, 'failed');
        assert.equal(visited.includes(scenario === 'test-plan-incomplete' ? 'approve-test-cases' : 'approve-release-scope'), false);
        return;
      }
      if (['stale-release', 'wrong-artifact', 'missing-health'].includes(scenario)) { assert.equal(result.status, 'failed'); return; }
      if (scenario === 'stale-product') { assert.equal(result.status, 'failed'); assert.deepEqual(visited, ['review-product']); return; }
      assert.equal(result.status, 'success', JSON.stringify(result));
      assert.equal(result.result.outcome, scenario === 'browser-failure' || ['qa-business-gap', 'health-business-gap', 'stable-revision'].includes(scenario) ? 'blocked' : scenario === 'qa-rework' ? 'rework-exhausted' : scenario === 'reject-product' ? 'rejected' : ['health-failure', 'deploy-failure'].includes(scenario) ? 'rolled-back' : 'fixture-completed');
      if (['qa-rework', 'qa-fixed'].includes(scenario)) { assert.equal(result.result.qualityHistory.length, 1); assert.equal(result.result.development.round, 1); }
      if (scenario === 'stable-requirements') {
        const completed = result.result.development;
        const plan = completed.plan;
        assert.equal(completed.approvedHash, approvalHashV2(completed));
        assert.throws(() => validatePlanV2({ ...plan, document: undefined }, completed), /缺少待审架构文档/);
        const { dataFlow, ...document } = plan.document;
        const broken = { ...plan, document: { ...document, dataFlow: { ...dataFlow, edges: [{ ...dataFlow.edges[0], to: 'unknown' }] } } };
        assert.throws(() => validatePlanV2(broken, completed), /未知节点/);
        const changed = { ...plan, document: { ...plan.document, impact: '扩展了影响范围' } };
        assert.throws(() => assertApprovalV2({ ...completed, plan: changed }), /批准绑定无效/);
        const evidence = (await readIntake(app.workflow, runId)).acceptanceEvidence!;
        assert.equal(evidence.productHash, result.result.development.input.source.hash);
        assert.equal(evidence.planHash, result.result.development.planHash);
        assert.equal(evidence.qualityStatus, 'passed');
        assert.equal(evidence.requirements[0]!.id, 'REQ-FIXTURE-A');
        assert.deepEqual(evidence.requirements[0]!.taskIds, ['fixture-task-1', 'fixture-task-2']);
        assert.equal(evidence.requirements[0]!.cases[0]!.result?.status, 'passed');
      }
      if (scenario === 'success') {
        assert.equal(result.result.development.delegations.length, 2);
        assert.equal(result.result.quality.status, 'passed');
        assert.deepEqual(visited.slice(-2), ['approve-test-cases', 'review-test-results']);
        assert.equal(result.result.mergeRequest, undefined);
        const steps = (await app.workflow.getWorkflowRunById(runId))?.steps;
        assert.equal(steps?.['deployment-team'], undefined);
        const delivery = steps?.['delivery-team'];
        assert.ok(delivery && !Array.isArray(delivery));
        assert.equal(delivery.status, 'success');
      }
      if (['qa-business-gap', 'health-business-gap', 'stable-revision'].includes(scenario)) {
        assert.equal(result.result.development.outcome, 'clarification-required');
        assert.equal(result.result.development.delivery, null);
        assert.ok(result.result.development.plan.blockers.some((blocker: string) => blocker.includes(scenario !== 'health-business-gap' ? 'QA业务待决' : '发布业务待决')));
        assert.ok(result.result.qualityHistory.length || result.result.releaseHistory.length, '后期澄清前必须保留阶段证据');
        const intake = await readIntake(app.workflow, runId);
        assert.ok(intake.clarify); assert.match(intake.clarify!.title, /后期业务缺口/);
        const clarified = await respondIntake(app.workflow, 'fixture', runId, { clarifyHash: intake.clarify!.hash }, config);
        assert.equal(clarified.gate?.key, 'confirm-blocker-answers', '后期业务缺口必须进入既有澄清入口');
        if (scenario !== 'health-business-gap') {
          const native = await app.workflow.getWorkflowRunById(runId);
          const paused = Object.values(native!.steps!).find(/** QA 回流的原生澄清暂停点保存原发现引用。 */ step => !Array.isArray(step) && step.status === 'suspended') as any;
          const finding = result.result.qualityHistory.at(-1).review.findings[0];
          assert.equal(paused.payload.productReworkDecision.method, 'product-rework.v1');
          assert.equal(paused.payload.productReworkDecision.sourceHash, result.result.development.input.source.hash);
          assert.deepEqual(paused.payload.productReworkDecision.findingRefs, [{ id: finding.id, refs: finding.refs, evidence: finding.evidence }]);
          assert.ok(clarified.gate!.evidence.plan.questions.every(/** 下游业务缺口不得降为可选。 */ (question: { required: boolean }) => question.required));
        }
        if (scenario === 'stable-revision') {
          const gate = clarified.gate!;
          const revised = await respondIntake(app.workflow, 'fixture', runId, {
            gateHash: gate.gateHash,
            data: { ...gate.fixed, reviewer: 'fixture', supplement: '', answers: gate.evidence.plan.questions.map(
              /** 只选择当前合成卡片的有效选项。 */
              (question: { id: string; options: { id: string }[] }) => ({ questionId: question.id, selected: [question.options[0]!.id], custom: '' }),
            ) },
          }, config);
          assert.equal(revised.gate?.key, 'review-revised-product');
          const impact = revised.gate!.evidence.requirementImpact;
          assert.equal(impact.mode, 'stable-ids');
          assert.deepEqual(impact.changed, ['REQ-FIXTURE-A']);
          assert.deepEqual(impact.affectedCaseIds, ['automatic']);
          assert.deepEqual(impact.rerunCaseIds, ['automatic']);
          assert.equal(revised.acceptanceEvidence, undefined);
          const reviewGate = revised.gate!;
          const replanned = await respondIntake(app.workflow, 'fixture', runId, {
            gateHash: reviewGate.gateHash,
            data: { ...reviewGate.fixed, decision: 'approve', ...actor },
          }, config);
          assert.equal(replanned.gate?.key, 'approve-architecture');
          const architectureGate = replanned.gate!;
          const newPlan = await respondIntake(app.workflow, 'fixture', runId, {
            gateHash: architectureGate.gateHash,
            data: { ...architectureGate.fixed, decision: 'approve', resolutions: [], ...actor },
          }, config);
          const qaGate = newPlan.gate!;
          assert.equal(qaGate.key, 'approve-test-cases');
          assert.deepEqual(qaGate.evidence.requirementImpact, impact);
          assert.equal(newPlan.acceptanceEvidence?.productHash, impact.productHash);
          assert.deepEqual(newPlan.acceptanceEvidence?.requirements[0]?.cases, []);
          const cases = [{ id: 'automatic', requirementRefs: ['REQ-FIXTURE-A'], expected: '修订版检查返回 1', method: 'registered-check', checkRefs: qaGate.evidence.registeredChecks }];
          await assert.rejects(() => respondIntake(app.workflow, 'fixture', runId, {
            gateHash: qaGate.gateHash,
            data: { ...qaGate.fixed, ...actor, decision: 'approve', cases: [{ ...cases[0], requirementRefs: ['REQ-UNKNOWN'] }] },
          }, config), /测试用例引用未知需求/);
          const reexecuted = await respondIntake(app.workflow, 'fixture', runId, {
            gateHash: qaGate.gateHash,
            data: { ...qaGate.fixed, ...actor, decision: 'approve', cases },
          }, config);
          assert.equal(reexecuted.gate?.key, 'review-test-results');
          assert.equal(reexecuted.acceptanceEvidence?.requirements[0]?.cases[0]?.result?.status, 'passed');
          assert.equal(reexecuted.acceptanceEvidence?.qualityStatus, 'pending');
        }
      }
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
    const config: PracticeConfig = { ...(['health-failure', 'health-business-gap', 'stale-release', 'wrong-artifact', 'missing-health', 'deploy-failure', 'release-plan-incomplete'].includes(scenario) ? { legacyDeployment: true } : {}), rootDir: resolve('.'), mode: 'fixture', modelId: 'openai/fixture', port: 4111, databaseUrl: `file:${resolve(parent, 'workflow.db')}` };
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
