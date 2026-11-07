/** 真实原生快照测试，仅使用合成模型，不操作用户已有 Run。 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { Mastra } from '@mastra/core';
import { createStudioApplicationOptions } from '../src/mastra/app.js';
import { readIntake, respondIntake } from '../src/intake/service.js';
import type { PracticeConfig } from '../src/mastra/config.js';

test('需求闭环：暂停、非法答案不消耗、重新装配恢复、修订、产品批准与重复拒绝', /** 隔离 LibSQL 的主流程，证明 HTTP 所依赖的服务事实。 */async () => {
  const directory = mkdtempSync(resolve(tmpdir(), 'guided-intake-'));
  const config: PracticeConfig = { rootDir: resolve('.'), mode: 'fixture', modelId: 'openai/fixture', port: 4111, databaseUrl: `file:${resolve(directory, 'workflow.db')}` };
  let app = createStudioApplicationOptions(config);
  let mastra = new Mastra(app);
  let workflow = app.workflows.productDevelopmentWorkflow;
  try {
    const run = await workflow.createRun();
    const result = await run.start({ inputData: { brief: '合成招聘需求', iterationId: 'guided-test', guidedIntake: true } });
    assert.equal(result.status, 'suspended');
    let current = await readIntake(workflow, run.runId);
    assert.equal(current.step, 'guided-requirements', JSON.stringify(current));
    assert.ok(current.intake, JSON.stringify(result));
    const originalHash = current.intake.hash!;
    const answer = { hash: originalHash, action: 'refine', reviewer: 'test-human', supplement: '', answers: [{ questionId: 'scope', selected: ['minimal'], custom: '' }] };
    await assert.rejects(respondIntake(workflow, 'fixture', run.runId, { ...answer, answers: [] }));
    await assert.rejects(respondIntake(workflow, 'fixture', run.runId, { ...answer, hash: '0'.repeat(64) }));
    await assert.rejects(respondIntake(workflow, 'live', run.runId, answer));
    assert.equal((await readIntake(workflow, run.runId)).intake?.hash, originalHash);
    await app.storage.close();
    app = createStudioApplicationOptions(config); mastra = new Mastra(app); workflow = app.workflows.productDevelopmentWorkflow;
    current = await respondIntake(workflow, 'fixture', run.runId, answer);
    assert.equal(current.intake?.round, 2);
    assert.equal(current.intake?.history.length, 1);
    assert.equal(current.intake?.history[0].response.reviewer, 'test-human');
    await assert.rejects(respondIntake(workflow, 'fixture', run.runId, answer));
    current = await respondIntake(workflow, 'fixture', run.runId, { ...answer, hash: current.intake!.hash, action: 'finalize', answers: [] });
    assert.equal(current.step, 'review-product'); assert.ok(current.product);
    const review = { role: 'product', artifactHash: current.product.artifact.hash, decision: 'approve', reviewer: 'test-human', comment: '合成批准' };
    await assert.rejects(respondIntake(workflow, 'fixture', run.runId, { ...review, artifactHash: '0'.repeat(64) }));
    current = await respondIntake(workflow, 'fixture', run.runId, review);
    assert.equal(current.step, 'confirm-project-scope');
    await assert.rejects(respondIntake(workflow, 'fixture', run.runId, review));
  } finally { void mastra; await app.storage.close(); rmSync(directory, { recursive: true, force: true }); }
});

import { Hono, type Handler } from 'hono';
import { randomUUID } from 'node:crypto';

test('需求 HTTP：同源、固定标识创建、坏答案与完整稿版本门禁', /** 使用生产注册 handler 和隔离模型运行库。 */async () => {
  const directory = mkdtempSync(resolve(tmpdir(), 'guided-http-'));
  const app = createStudioApplicationOptions({ rootDir: resolve('.'), mode: 'fixture', modelId: 'openai/fixture', port: 4111, databaseUrl: `file:${resolve(directory, 'workflow.db')}` });
  const mastra = new Mastra(app); const router = new Hono();
  for (const route of app.server.apiRoutes) if ('handler' in route) router.on(route.method, route.path, route.handler as Handler);
  /** 模拟浏览器 JSON 请求，不传可替换正文或步骤。 */
  function post(path: string, data: unknown, origin = 'http://127.0.0.1:4112') { return router.request(path, { method: 'POST', headers: { 'Content-Type': 'application/json', origin }, body: JSON.stringify(data) }); }
  try {
    const input = { runId: randomUUID(), brief: 'HTTP 合成需求', iterationId: 'http-test' };
    assert.equal((await post('/intake-api/runs', input, 'https://untrusted.example')).status, 409);
    assert.equal((await post('/intake-api/runs', { ...input, brief: '' })).status, 409);
    const started = await post('/intake-api/runs', input); assert.equal(started.status, 200);
    const current = await started.json();
    const again = await (await post('/intake-api/runs', input)).json(); assert.equal(again.intake.hash, current.intake.hash);
    assert.equal((await post(`/intake-api/runs/${input.runId}/respond`, { hash: current.intake.hash, action: 'finalize', reviewer: 'test', answers: [], supplement: '' })).status, 409);
    const read = await router.request(`/intake-api/runs/${input.runId}`); assert.equal(read.headers.get('cache-control'), 'no-store'); assert.equal((await read.json()).intake.hash, current.intake.hash);
    const draft = await (await post(`/intake-api/runs/${input.runId}/respond`, { hash: current.intake.hash, action: 'finalize', reviewer: 'test', answers: [{ questionId: 'scope', selected: [], custom: '仅人工初筛和邀约记录' }], supplement: '' })).json();
    assert.equal(draft.step, 'review-product');
    const decision = { role: 'product', artifactHash: draft.product.artifact.hash, decision: 'reject', reviewer: 'test', comment: '合成终止' };
    assert.equal((await post(`/intake-api/runs/${input.runId}/respond`, { ...decision, artifactHash: '0'.repeat(64) })).status, 409);
    const ended = await (await post(`/intake-api/runs/${input.runId}/respond`, decision)).json(); assert.equal(ended.status, 'success');
    assert.equal((await post(`/intake-api/runs/${input.runId}/respond`, decision)).status, 409);
  } finally { void mastra; await app.storage.close(); rmSync(directory, { recursive: true, force: true }); }
});

import { validateAnswers, planSchema } from '../src/intake/contracts.js';

test('澄清约束：坏表单、单多选、文本、重复问题与四轮上限', /** 纯边界断言避免用模型声明替代输入校验。 */() => {
  const plan = planSchema.parse({ summary: '方案', assumptions: [], questions: [{ id: 'a', title: '选择', reason: '影响范围', required: true, kind: 'single', options: [{ id: 'x', label: 'X' }, { id: 'y', label: 'Y' }], recommendation: 'X' }] });
  const intake = { enabled: true, ready: false, round: 4, plan, hash: 'a'.repeat(64), history: [] };
  const response = { hash: intake.hash, action: 'finalize', reviewer: 'test', answers: [{ questionId: 'a', selected: ['x'], custom: '' }], supplement: '' };
  assert.equal(validateAnswers(intake, response).action, 'finalize');
  for (const answers of [[], [{ questionId: 'unknown', selected: ['x'], custom: '' }], [{ questionId: 'a', selected: ['x', 'y'], custom: '' }], [{ questionId: 'a', selected: ['bad'], custom: '' }], [response.answers[0], response.answers[0]]]) assert.throws(/** 非法答案不得被当作业务确认。 */() => validateAnswers(intake, { ...response, answers }));
  assert.throws(/** 上限后禁止继续分析，但可以生成完整稿。 */() => validateAnswers(intake, { ...response, action: 'refine' }));
  assert.throws(/** 同一表单不能生成重复问题标识。 */() => planSchema.parse({ ...plan, questions: [plan.questions[0], plan.questions[0]] }));
});

for (const scenario of ['success', 'rollback']) test(`业务前端接口连续推进：${scenario}，非法输入保留暂停点`, /** 合成项目通过 HTTP handler 串联真实检查与人工回执。 */async () => {
  const directory = mkdtempSync(resolve(tmpdir(), 'guided-all-gates-'));
  const app = createStudioApplicationOptions({ rootDir: resolve('.'), mode: 'fixture', modelId: 'openai/fixture', port: 4111, databaseUrl: `file:${resolve(directory, 'workflow.db')}` });
  new Mastra(app); const router = new Hono();
  for (const route of app.server.apiRoutes) if ('handler' in route) router.on(route.method, route.path, route.handler as Handler);
  const runId = randomUUID(); const actor = { reviewer: 'test-human', comment: '仅合成测试，不代表真实业务授权' };
  const project = { id: 'ui-test', files: { 'src/a.mjs': 'export const initial=0;', 'src/b.mjs': 'export const initial=0;', 'check.mjs': 'import {test} from "node:test"; import assert from "node:assert/strict"; import {fixtureValue as a} from "./src/a.mjs"; import {fixtureValue as b} from "./src/b.mjs"; test("two modules",/** 合成检查。 */()=>{assert.equal(a(),1);assert.equal(b(),1)});' }, writablePaths: ['src/a.mjs', 'src/b.mjs'], checkFiles: ['check.mjs'], roles: ['frontend', 'backend'] };
  /** 与页面相同的同源提交，不调用原生 resume 绕过业务服务。 */
  async function post(body: unknown, start = false) { return router.request(`/intake-api/runs${start ? '' : `/${runId}/respond`}`, { method: 'POST', headers: { 'Content-Type': 'application/json', origin: 'http://127.0.0.1:4112' }, body: JSON.stringify(body) }); }
  try {
    let current = await (await post({ runId, brief: '合成全流程', iterationId: 'ui-test' }, true)).json();
    current = await (await post({ hash: current.intake.hash, action: 'finalize', reviewer: actor.reviewer, supplement: '', answers: [{ questionId: 'scope', selected: ['minimal'], custom: '' }] })).json();
    current = await (await post({ ...actor, role: 'product', artifactHash: current.product.artifact.hash, decision: 'approve' })).json();
    const visited: string[] = [];
    while (current.gate && visited.length < 12) {
      const g = current.gate; const p = g.evidence; visited.push(g.key);
      let data: any = { ...actor, ...g.fixed };
      if (g.key === 'confirm-project-scope') data = { ...data, project, maxReworks: 1 };
      else if (g.key === 'approve-architecture') data = { ...data, decision: 'approve', resolutions: [] };
      else if (g.key === 'approve-test-cases') data = { ...data, decision: 'approve', cases: [{ id: 'all', requirementRefs: p.requirements.map(/** 覆盖已批准原文引用。 */(r: any) => r.id), expected: '两个模块返回1', method: 'registered-check', checkRefs: p.registeredChecks }] };
      else if (g.key === 'review-test-results') data = { ...data, decision: 'pass', manualResults: [], findings: [] };
      else if (g.key === 'approve-release-scope') data = { ...data, decision: 'approve', scope: { environment: 'synthetic', artifactDigest: 'a'.repeat(64), artifactRef: 'synthetic://build', rollbackArtifactRef: 'synthetic://previous', healthChecks: [{ id: 'ready', expected: '可用' }] } };
      else if (g.key === 'execute-release-externally') data = { ...data, status: 'succeeded', jobRef: 'synthetic://job', operator: 'test', finishedAt: '2026-11-07T00:00:00Z', notes: '合成回执，没有实际部署' };
      else if (g.key === 'verify-release-health') data = { ...data, operator: 'test', checks: [{ id: 'ready', status: scenario === 'rollback' ? 'failed' : 'passed', evidence: '合成健康检查', observedAt: '2026-11-07T00:00:00Z' }] };
      else if (g.key === 'execute-rollback-externally') data = { ...data, status: 'rolled-back', jobRef: 'synthetic://rollback', operator: 'test', notes: '合成回滚回执，未实际部署' };
      else assert.fail(`未预期关口 ${g.key}`);
      const stale = await post({ gateHash: '0'.repeat(64), data }); assert.equal(stale.status, 409);
      if (g.key === 'confirm-project-scope') assert.equal((await post({ gateHash: g.gateHash, data: { ...data, project: { ...project, checkFiles: ['src/a.mjs'] } } })).status, 409);
      if (g.key === 'approve-test-cases') assert.equal((await post({ gateHash: g.gateHash, data: { ...data, cases: [{ ...data.cases[0], requirementRefs: ['unknown'] }] } })).status, 409);
      if (g.key === 'verify-release-health') assert.equal((await post({ gateHash: g.gateHash, data: { ...data, checks: [{ ...data.checks[0], id: 'unknown' }] } })).status, 409);
      assert.equal((await readIntake(app.workflows.productDevelopmentWorkflow, runId)).gate?.gateHash, g.gateHash);
      const response = await post({ gateHash: g.gateHash, data }); assert.equal(response.status, 200, `${g.key}: ${await response.clone().text()}`); current = await response.json();
      assert.notEqual(current.status, 'failed', JSON.stringify(current));
    }
    assert.deepEqual(visited, ['confirm-project-scope', 'approve-architecture', 'approve-test-cases', 'review-test-results', 'approve-release-scope', 'execute-release-externally', 'verify-release-health', ...(scenario === 'rollback' ? ['execute-rollback-externally'] : [])]);
    assert.equal(current.status, 'success');
    const snapshot = await app.workflows.productDevelopmentWorkflow.getWorkflowRunById(runId); assert.equal((snapshot!.result as any).outcome, scenario === 'rollback' ? 'rolled-back' : 'fixture-completed');
  } finally { await app.storage.close(); rmSync(directory, { recursive: true, force: true }); }
});
