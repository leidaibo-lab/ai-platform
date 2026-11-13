/** 真实原生快照测试，仅使用合成模型，不操作用户已有 Run。 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { generateKeyPairSync, sign } from 'node:crypto';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { captureArtifact } from '../src/resources/artifact.js';
import { canonical } from '../src/resources/contracts.js';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { Mastra } from '@mastra/core';
import { createStudioApplicationOptions } from '../src/mastra/app.js';
import { readIntake, respondIntake } from '../src/intake/service.js';
import type { PracticeConfig } from '../src/mastra/config.js';
import { ContextBudgetError } from '../src/delivery/context-budget.js';
import { createRoleInvocation } from '../src/resources/projections.js';
import { loadRuntimeResourceConfig } from '../src/resources/resource-config.js';
import { beginExecution, readExecution } from '../src/intake/execution-control.js';
import { productToolReuseInstruction } from '../src/mastra/workflows/product.js';

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
    for (let round = 2; round <= 6; round++) {
      const previousHash = current.intake!.hash;
      current = await respondIntake(workflow, 'fixture', run.runId, { ...answer, hash: previousHash, answers: [], supplement: `第${round}轮补充` });
      assert.equal(current.step, 'guided-requirements');
      assert.equal(current.product, undefined);
      assert.equal(current.intake!.round, round + 1);
      assert.equal(current.intake!.history.length, round);
      assert.equal(current.intake!.ready, false);
      assert.equal(current.intake!.history[0].response.reviewer, 'test-human');
      await assert.rejects(respondIntake(workflow, 'fixture', run.runId, { ...answer, hash: previousHash, answers: [] }));
      if (round === 4) {
        await app.storage.close();
        app = createStudioApplicationOptions(config); mastra = new Mastra(app); workflow = app.workflows.productDevelopmentWorkflow;
        const restored = await readIntake(workflow, run.runId);
        assert.deepEqual(restored.intake, current.intake);
        current = restored;
      }
    }
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
    let draft = await (await post(`/intake-api/runs/${input.runId}/respond`, { hash: current.intake.hash, action: 'finalize', reviewer: 'test', answers: [{ questionId: 'scope', selected: [], custom: '仅人工初筛和邀约记录' }], supplement: '' })).json();
    assert.equal(draft.step, 'guided-requirements');
    draft = await (await post(`/intake-api/runs/${input.runId}/respond`, { hash: draft.intake.hash, action: 'finalize', reviewer: 'test', answers: [], supplement: '' })).json();
    assert.equal(draft.step, 'review-product');
    const decision = { role: 'product', artifactHash: draft.product.artifact.hash, decision: 'reject', reviewer: 'test', comment: '合成终止' };
    assert.equal((await post(`/intake-api/runs/${input.runId}/respond`, { ...decision, artifactHash: '0'.repeat(64) })).status, 409);
    const ended = await (await post(`/intake-api/runs/${input.runId}/respond`, decision)).json(); assert.equal(ended.status, 'success');
    assert.equal((await post(`/intake-api/runs/${input.runId}/respond`, decision)).status, 409);
  } finally { void mastra; await app.storage.close(); rmSync(directory, { recursive: true, force: true }); }
});

import { canFinalizePlan, validateAnswers, planSchema } from '../src/intake/contracts.js';
import { assertClarificationHandoff, CLARIFICATION_HANDOFF_CONVENTION } from '../src/intake/product-generation.js';

test('需求梳理交接约定：使用有界生成并保留固定章节', /** 防止中间角色重新承担完整PRD写作导致无界调用。 */() => {
  assert.deepEqual(CLARIFICATION_HANDOFF_CONVENTION.sections, ['已确认规则索引', '核心对象与关系', '状态与权限要点', '异常规则索引', '页面与验收待展开清单']);
  const sections = CLARIFICATION_HANDOFF_CONVENTION.sections.map(/** 用实际正文验证固定章节，而不是检查宿主贴的目录标签。 */title => `## ${title}\n- 已确认依据或待决项。`);
  assert.doesNotThrow(/** 五章有正文且顺序正确时允许交接。 */() => assertClarificationHandoff(sections.join('\n\n')));
  for (const content of [sections.slice(1).join('\n\n'), [...sections].reverse().join('\n\n'), sections.join('\n\n') + '\n\n## 已确认规则索引\n重复', sections.join('\n\n').replace('## 核心对象与关系\n- 已确认依据或待决项。', '## 核心对象与关系\n')]) {
    assert.throws(/** 缺章、错序、重复章和空章不得形成成功交接。 */() => assertClarificationHandoff(content), /需求梳理/);
  }
});

test('澄清约束：坏表单、单多选、文本、重复问题与继续澄清', /** 纯边界断言避免用模型声明替代输入校验。 */() => {
  const plan = planSchema.parse({ summary: '方案', assumptions: [], questions: [{ id: 'a', title: '选择', reason: '影响范围', required: true, kind: 'single', options: [{ id: 'x', label: 'X' }, { id: 'y', label: 'Y' }], recommendation: 'X' }] });
  const intake = { enabled: true, ready: false, round: 4, plan, hash: 'a'.repeat(64), history: [] };
  const response = { hash: intake.hash, action: 'finalize', reviewer: 'test', answers: [{ questionId: 'a', selected: ['x'], custom: '' }], supplement: '' };
  assert.equal(validateAnswers(intake, response).action, 'finalize');
  assert.equal(canFinalizePlan({ ...plan, questions: [], maturity: { decisions: { clear: true, evidence: '已确认' }, mainFlow: { clear: true, evidence: '已确认' }, exceptions: { clear: false, evidence: '留给正式产品稿组合验收' }, delivery: { clear: false, evidence: '留给正式产品稿整理' } } }), true, '没有必答业务缺口时应允许进入正式稿，而非困在澄清循环');
  for (const answers of [[], [{ questionId: 'unknown', selected: ['x'], custom: '' }], [{ questionId: 'a', selected: ['x', 'y'], custom: '' }], [{ questionId: 'a', selected: ['bad'], custom: '' }], [response.answers[0], response.answers[0]]]) assert.throws(/** 非法答案不得被当作业务确认。 */() => validateAnswers(intake, { ...response, answers }));
  assert.equal(validateAnswers(intake, { ...response, action: 'refine' }).action, 'refine');
  assert.throws(/** 每轮仍然最多八题。 */() => planSchema.parse({ ...plan, questions: Array.from({ length: 9 }, /** 为每题提供独立标识。 */(_, index) => ({ ...plan.questions[0], id: String(index) })) }));
  assert.throws(/** 同一表单不能生成重复问题标识。 */() => planSchema.parse({ ...plan, questions: [plan.questions[0], plan.questions[0]] }));
});

test('产品闭环交接：接受上游长正文但不放宽开发短文本字段', /** 防止产品角色在模型调用前因错误复用任务标签限制而失败。 */() => {
  const config = loadRuntimeResourceConfig('/nonexistent');
  const resources = { roles: {}, sourceSnapshotHash: 'a'.repeat(64) } as never;
  const content = '总产品统筹正文'.repeat(200);
  const invocation = createRoleInvocation({ runId: 'test', roleId: 'product-closure', bundleHash: 'b'.repeat(64), inputContract: 'product-closure.input.v1', payload: { brief: 'HRM', sourceRefs: [], confirmedIntake: { ready: true, round: 0, history: [] }, clarification: { id: 'clarification', hash: 'c'.repeat(64), content: '固定交接' }, coordinationDecisions: [content], reworkFeedback: null }, resources, config });
  assert.equal((invocation.payload.coordinationDecisions as string[])[0], content);
});

test('工具轨迹观察：仅保存散列并标记重复调用', /** 观察循环不读取或回传工具入参、结果正文和任何凭据。 */() => {
  const runId = randomUUID(); const observation = beginExecution(runId, 'closure');
  const event = { toolCalls: [{ payload: { toolName: 'skill_read', args: { skillName: 'product-pm-test-scenarios' }, toolCallId: 'call-1' } }], toolResults: [{ payload: { toolCallId: 'call-1' } }] };
  observation.activity(event); observation.activity(event);
  const trace = readExecution(runId)!.toolTrace;
  assert.equal(trace.length, 2); assert.equal(trace[0]!.returned, true); assert.equal(trace[0]!.newCallSignature, true); assert.equal(trace[1]!.newCallSignature, false);
  assert.doesNotMatch(JSON.stringify(trace), /product-pm-test-scenarios/);
  observation.finish();
});

test('产品角色执行约定：已成功的相同只读调用必须复用', /** 以提示补足模型行为边界，不关闭工具或缩减步骤预算。 */() => {
  assert.match(productToolReuseInstruction, /同一工具、同一入参且已有成功结果时不得重复调用/);
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
    assert.equal(current.step, 'guided-requirements');
    current = await (await post({ hash: current.intake.hash, action: 'finalize', reviewer: actor.reviewer, supplement: '', answers: [] })).json();
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

for (const failureKind of ['invalid-output', 'timeout']) test(`需求分析${failureKind}后保留回答，仅恢复生成而不结束澄清`, /** 注入结构化输出失败，验证真实快照恢复而不重填答案。 */async () => {
  const directory = mkdtempSync(resolve(tmpdir(), 'guided-retry-'));
  let calls = 0;
  let allowRecovery = false;
  const plan = { maturity: { decisions: { clear: true, evidence: '合成' }, mainFlow: { clear: true, evidence: '合成' }, exceptions: { clear: true, evidence: '合成' }, delivery: { clear: true, evidence: '合成' } }, summary: '受控合成方案', assumptions: [], questions: [] };
  const server = createServer(/** 本地合成HTTP模型，保留live装配、结构化解析和错误恢复。 */async (request, response) => {
    for await (const _chunk of request) { /* 消费请求，不记录正文或凭据。 */ }
    if (++calls >= 2 && !allowRecovery && failureKind === 'timeout') { response.writeHead(408, { 'content-type': 'application/json' }); response.end(JSON.stringify({ error: { message: 'synthetic timeout' } })); return; }
    response.writeHead(200, { 'content-type': 'application/json' });
    const invalid = calls === 2 || (failureKind === 'invalid-output' && calls === 3);
    response.end(JSON.stringify({ id: 'synthetic', object: 'chat.completion', created: 1, model: 'synthetic', choices: [{ index: 0, message: { role: 'assistant', content: invalid ? 'invalid structured output' : JSON.stringify(plan) }, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 } }));
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const pair = generateKeyPairSync('ed25519'); const manifest = captureArtifact(resolve('.'), true);
  const manifestPath = resolve(directory, 'manifest.json'); const publicKeyPath = resolve(directory, 'public.pem');
  writeFileSync(publicKeyPath, pair.publicKey.export({ type: 'spki', format: 'pem' }));
  writeFileSync(manifestPath, JSON.stringify({ manifest, signature: sign(null, Buffer.from(canonical(manifest)), pair.privateKey).toString('base64') }));
  const config: PracticeConfig = { rootDir: resolve('.'), mode: 'live', modelId: 'openai/synthetic', apiKey: 'synthetic', baseUrl: `http://127.0.0.1:${(server.address() as import('node:net').AddressInfo).port}/v1`, resourceTrust: { manifestPath, publicKeyPath }, port: 4111, databaseUrl: `file:${resolve(directory, 'workflow.db')}` };
  const app = createStudioApplicationOptions(config); const workflow = app.workflows.productDevelopmentWorkflow;
  new Mastra(app);
  try {
    const run = await workflow.createRun(); await run.start({ inputData: { brief: '合成恢复需求', iterationId: 'retry-test', guidedIntake: true } });
    let current = await readIntake(workflow, run.runId);
    current = await respondIntake(workflow, 'live', run.runId, { hash: current.intake!.hash, action: 'refine', reviewer: 'test-human', answers: [], supplement: '真实人工补充（合成测试）' });
    assert.equal(current.status, 'failed'); assert.ok(current.retry); assert.equal(current.retry.savedAnswers, 1);
    await assert.rejects(respondIntake(workflow, 'live', run.runId, { retryHash: '0'.repeat(64) }));
    allowRecovery = true;
    current = await respondIntake(workflow, 'live', run.runId, { retryHash: current.retry.hash });
    assert.equal(current.status, 'suspended'); assert.equal(current.intake?.history.length, 1); assert.equal(current.intake.history[0].response.supplement, '真实人工补充（合成测试）');
    assert.equal(current.intake.round, 2); assert.equal(current.intake.ready, false); assert.equal(current.product, undefined); assert.ok(calls >= 3);
  } finally { await app.storage.close(); server.closeAllConnections(); await new Promise<void>(/** 等待本地测试服务释放端口。 */done => server.close(/** 关闭回执无需传播测试请求。 */() => done())); rmSync(directory, { recursive: true, force: true }); }
});

test('需求分析非 JSON 输出自动修复一次并继续澄清', /** 验证兼容端点返回自然语言时由同一模型调用一次格式修复，且不形成无限重试。 */async () => {
  const directory = mkdtempSync(resolve(tmpdir(), 'guided-json-repair-'));
  let calls = 0;
  const plan = { maturity: { decisions: { clear: true, evidence: '合成' }, mainFlow: { clear: true, evidence: '合成' }, exceptions: { clear: true, evidence: '合成' }, delivery: { clear: true, evidence: '合成' } }, summary: '修复后的合成方案', assumptions: [], questions: [] };
  const server = createServer(async (request, response) => {
    for await (const _chunk of request) { /* 消费请求，不记录正文或凭据。 */ }
    calls += 1;
    const content = calls === 2 ? '下面是分析说明，暂未按 JSON 输出。' : JSON.stringify(plan);
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ id: 'synthetic', object: 'chat.completion', created: 1, model: 'synthetic', choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 } }));
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const pair = generateKeyPairSync('ed25519'); const manifest = captureArtifact(resolve('.'), true);
  const manifestPath = resolve(directory, 'manifest.json'); const publicKeyPath = resolve(directory, 'public.pem');
  writeFileSync(publicKeyPath, pair.publicKey.export({ type: 'spki', format: 'pem' }));
  writeFileSync(manifestPath, JSON.stringify({ manifest, signature: sign(null, Buffer.from(canonical(manifest)), pair.privateKey).toString('base64') }));
  const config: PracticeConfig = { rootDir: resolve('.'), mode: 'live', modelId: 'openai/synthetic', apiKey: 'synthetic', baseUrl: `http://127.0.0.1:${(server.address() as import('node:net').AddressInfo).port}/v1`, resourceTrust: { manifestPath, publicKeyPath }, port: 4111, databaseUrl: `file:${resolve(directory, 'workflow.db')}` };
  const app = createStudioApplicationOptions(config); const workflow = app.workflows.productDevelopmentWorkflow;
  new Mastra(app);
  try {
    const run = await workflow.createRun(); await run.start({ inputData: { brief: '合成 JSON 修复需求', iterationId: 'json-repair', guidedIntake: true } });
    const first = await readIntake(workflow, run.runId);
    const current = await respondIntake(workflow, 'live', run.runId, { hash: first.intake!.hash, action: 'refine', reviewer: 'test-human', answers: [], supplement: '触发一次格式修复' });
    assert.equal(current.status, 'suspended');
    assert.equal(current.step, 'guided-requirements');
    assert.equal(current.intake?.plan?.summary, plan.summary);
    assert.equal(calls, 3, '首次生成、修复调用和后续流程的调用次数应有界');
  } finally { await app.storage.close(); server.closeAllConnections(); await new Promise<void>(/** 等待本地测试服务释放端口。 */done => server.close(/** 关闭回执无需传播测试请求。 */() => done())); rmSync(directory, { recursive: true, force: true }); }
});

test('产品写作 Time travel：前序三角色不重跑、旧令牌拒绝、恢复后重新待审', /** 使用原生嵌套快照与真实业务服务，不对用户 Run 提交决定。 */async () => {
  const directory = mkdtempSync(resolve(tmpdir(), 'product-writing-retry-'));
  const app = createStudioApplicationOptions({ rootDir: resolve('.'), mode: 'fixture', modelId: 'openai/fixture', port: 4111, databaseUrl: `file:${resolve(directory, 'workflow.db')}` });
  const calls: Record<string, number> = {};
  for (const name of ['productCoordinatorAgent', 'productClarificationAgent', 'productClosureAgent', 'productAgent'] as const) {
    const agent = app.agents[name]; const original = agent.getModel.bind(agent);
    agent.getModel = (/** 在fixture模型装配边界注入首次故障，其余保留原生Stored Agent循环。 */async () => { calls[name] = (calls[name] ?? 0) + 1; if (name === 'productAgent' && calls[name] === 1) throw new Error('synthetic upstream failure'); return original(); }) as any;
  }
  new Mastra(app); const workflow = app.workflows.productDevelopmentWorkflow;
  try {
    const run = await workflow.createRun(); await run.start({ inputData: { brief: '合成产品写作故障', iterationId: 'writing-recovery' } });
    const before = await readIntake(workflow, run.runId);
    assert.equal(before.status, 'failed'); assert.equal(before.retry?.step, 'draft-product.product-writing'); assert.equal(before.retry?.preserved.length, 3);
    assert.equal(before.retry?.reason, '模型执行未完成，未取得明确故障来源');
    const attemptDetails = before.retry && 'attemptDetails' in before.retry ? before.retry.attemptDetails : undefined;
    assert.equal(attemptDetails?.length, 1);
    assert.match(attemptDetails![0], /模型执行未完成/);
    assert.equal(attemptDetails![0].includes('synthetic upstream failure'), false);
    await assert.rejects(respondIntake(workflow, 'fixture', run.runId, { retryHash: '0'.repeat(64) }));
    await assert.rejects(respondIntake(workflow, 'live', run.runId, { retryHash: before.retry!.hash }));
    const after = await respondIntake(workflow, 'fixture', run.runId, { retryHash: before.retry!.hash });
    assert.equal(after.status, 'suspended'); assert.equal(after.step, 'review-product'); assert.ok(after.product); assert.equal(after.retry, undefined);
    assert.deepEqual(calls, { productCoordinatorAgent: 1, productClarificationAgent: 1, productClosureAgent: 1, productAgent: 2 });
    await assert.rejects(respondIntake(workflow, 'fixture', run.runId, { retryHash: before.retry!.hash }));
    const snapshot = await workflow.getWorkflowRunById(run.runId);
    const writing = snapshot!.steps!['draft-product.product-writing'] as any;
    assert.equal(writing.output.productWork.entries.length, 4); assert.equal(writing.output.reviews.length, 0);
  } finally { await app.storage.close(); rmSync(directory, { recursive: true, force: true }); }
});

test('需求梳理失败恢复：保留七轮确认，只重跑梳理及下游并交接五章对象', /** 新Run从失败叶节点恢复，统筹产物和澄清历史来自同一原生快照。 */async () => {
  const directory = mkdtempSync(resolve(tmpdir(), 'product-clarification-retry-'));
  const app = createStudioApplicationOptions({ rootDir: resolve('.'), mode: 'fixture', modelId: 'openai/fixture', port: 4111, databaseUrl: `file:${resolve(directory, 'workflow.db')}` });
  const calls: Record<string, number> = {};
  for (const name of ['productCoordinatorAgent', 'productClarificationAgent', 'productClosureAgent', 'productAgent'] as const) {
    const agent = app.agents[name]; const original = agent.getModel.bind(agent);
    // 在模型装配处注入一次梳理失败，并统计恢复是否重复执行上游。
    agent.getModel = async () => {
      calls[name] = (calls[name] ?? 0) + 1;
      if (name === 'productClarificationAgent' && calls[name] === 1) throw new Error('synthetic clarification failure');
      return original();
    };
  }
  new Mastra(app); const workflow = app.workflows.productDevelopmentWorkflow;
  try {
    const run = await workflow.createRun();
    let current = await run.start({ inputData: { brief: '合成需求梳理恢复', iterationId: 'clarification-recovery', guidedIntake: true } }).then(/** 从原生快照读取当前暂停点。 */() => readIntake(workflow, run.runId));
    assert.equal(current.step, 'guided-requirements');
    const first = { hash: current.intake!.hash, action: 'refine' as const, reviewer: 'test-human', answers: [{ questionId: 'scope', selected: ['minimal'], custom: '' }], supplement: '' };
    current = await respondIntake(workflow, 'fixture', run.runId, first);
    for (let round = 2; round <= 6; round++) {
      current = await respondIntake(workflow, 'fixture', run.runId, { hash: current.intake!.hash, action: 'refine', reviewer: 'test-human', answers: [], supplement: `第${round}轮确认` });
    }
    current = await respondIntake(workflow, 'fixture', run.runId, { hash: current.intake!.hash, action: 'finalize', reviewer: 'test-human', answers: [], supplement: '' });
    assert.equal(current.status, 'failed');
    assert.equal(current.retry?.step, 'draft-product.product-clarification');
    assert.equal(current.retry?.preserved.length, 1);
    const failedSnapshot = await workflow.getWorkflowRunById(run.runId);
    assert.equal((failedSnapshot?.steps?.['draft-product.product-clarification'] as any)?.payload.intake.history.length, 7);
    assert.equal((failedSnapshot?.steps?.['draft-product.product-coordinator'] as any)?.output.productWork.entries.length, 1);

    current = await respondIntake(workflow, 'fixture', run.runId, { retryHash: current.retry!.hash });
    assert.equal(current.status, 'suspended');
    assert.equal(current.step, 'review-product');
    const recoveredSnapshot = await workflow.getWorkflowRunById(run.runId);
    assert.equal((recoveredSnapshot?.steps?.['draft-product.product-writing'] as any)?.output.intake.history.length, 7);
    const productWork = (recoveredSnapshot?.steps?.['draft-product.product-writing'] as any)?.output.productWork;
    assert.deepEqual(productWork?.entries.map(/** 核对恢复后四角色的唯一顺序。 */(entry: any) => entry.role), ['coordinator', 'clarification', 'closure', 'writing']);
    assert.deepEqual(productWork?.entries[1].handoffSections, CLARIFICATION_HANDOFF_CONVENTION.sections);
    assert.equal(calls.productCoordinatorAgent, 1, '恢复不得重跑总产品统筹');
    assert.equal(calls.productClarificationAgent, 2);
    assert.equal(calls.productClosureAgent, 1);
    assert.equal(calls.productAgent, 1);
    // 同一个恢复Run继续走正式业务服务；所有批准与发布回执只属于隔离fixture。
    const actor = { reviewer: 'test-human', comment: '合成恢复链路验证，不代表真实部署' };
    const productHash = current.product!.artifact.hash;
    await assert.rejects(respondIntake(workflow, 'fixture', run.runId, { ...actor, role: 'product', artifactHash: '0'.repeat(64), decision: 'approve' }));
    current = await respondIntake(workflow, 'fixture', run.runId, { ...actor, role: 'product', artifactHash: productHash, decision: 'approve' });
    const project = { id: 'recovered-chain', files: { 'src/a.mjs': 'export const initial=0;', 'src/b.mjs': 'export const initial=0;', 'check.mjs': 'import {test} from "node:test"; import assert from "node:assert/strict"; import {fixtureValue as a} from "./src/a.mjs"; import {fixtureValue as b} from "./src/b.mjs"; test("two modules",/** 验证实际实现的两个模块。 */()=>{assert.equal(a(),1);assert.equal(b(),1)});' }, writablePaths: ['src/a.mjs', 'src/b.mjs'], checkFiles: ['check.mjs'], roles: ['frontend', 'backend'] };
    const visited: string[] = [];
    while (current.gate && visited.length < 10) {
      const gate = current.gate; const evidence = gate.evidence as any; visited.push(gate.key);
      let data: any = { ...actor, ...gate.fixed };
      if (gate.key === 'confirm-project-scope') data = { ...data, project, maxReworks: 1 };
      else if (gate.key === 'approve-architecture') data = { ...data, decision: 'approve', resolutions: [] };
      else if (gate.key === 'approve-test-cases') data = { ...data, decision: 'approve', cases: [{ id: 'recovered', requirementRefs: evidence.requirements.map(/** 测试覆盖本次批准的需求引用。 */(item: any) => item.id), expected: '两个模块返回1', method: 'registered-check', checkRefs: evidence.registeredChecks }] };
      else if (gate.key === 'review-test-results') data = { ...data, decision: 'pass', manualResults: [], findings: [] };
      else if (gate.key === 'approve-release-scope') data = { ...data, decision: 'approve', scope: { environment: 'synthetic', artifactDigest: 'a'.repeat(64), artifactRef: 'synthetic://build', rollbackArtifactRef: 'synthetic://previous', healthChecks: [{ id: 'ready', expected: '可用' }] } };
      else if (gate.key === 'execute-release-externally') data = { ...data, status: 'succeeded', jobRef: 'synthetic://job', operator: 'test', finishedAt: '2026-11-13T00:00:00Z', notes: '合成回执，未实际部署' };
      else if (gate.key === 'verify-release-health') data = { ...data, operator: 'test', checks: [{ id: 'ready', status: 'passed', evidence: '合成健康检查', observedAt: '2026-11-13T00:00:00Z' }] };
      else assert.fail(`恢复后出现未预期关口 ${gate.key}`);
      await assert.rejects(respondIntake(workflow, 'fixture', run.runId, { gateHash: '0'.repeat(64), data }));
      assert.equal((await readIntake(workflow, run.runId)).gate?.gateHash, gate.gateHash);
      current = await respondIntake(workflow, 'fixture', run.runId, { gateHash: gate.gateHash, data });
    }
    assert.equal(current.status, 'success', JSON.stringify(current));
    const completed = await workflow.getWorkflowRunById(run.runId);
    const result = completed!.result as any;
    assert.equal(result.outcome, 'fixture-completed', JSON.stringify(result.development.checks));
    assert.deepEqual(visited, ['confirm-project-scope', 'approve-architecture', 'approve-test-cases', 'review-test-results', 'approve-release-scope', 'execute-release-externally', 'verify-release-health']);
    assert.equal(result.development.input.source.hash, productHash);
    assert.equal(result.development.outcome, 'development-delivered');
    assert.equal(result.quality.status, 'passed');
    assert.equal(calls.productCoordinatorAgent, 1);
    assert.equal(calls.productAgent, 1);
  } finally { await app.storage.close(); rmSync(directory, { recursive: true, force: true }); }
});

test('历史产品预算失败无需升档恢复且不重跑前序角色', /** 旧预算门槛已移除，只恢复失败节点且保留权限与人工关口。 */async () => {
  const directory = mkdtempSync(resolve(tmpdir(), 'product-budget-recovery-'));
  const app = createStudioApplicationOptions({ rootDir: resolve('.'), mode: 'fixture', modelId: 'openai/fixture', port: 4111, databaseUrl: `file:${resolve(directory, 'workflow.db')}` });
  const counts: Record<string, number> = {};
  const writing = app.agents.productAgent; const original = writing.getModel.bind(writing);
  writing.getModel = (/** 第一次装配命中预算故障，恢复后使用原生固定模型。 */async () => { counts.writing = (counts.writing ?? 0) + 1; if (counts.writing === 1) throw new ContextBudgetError('read', 50000, 48000); return original(); }) as any;
  new Mastra(app); const workflow = app.workflows.productDevelopmentWorkflow;
  try {
    const run = await workflow.createRun(); await run.start({ inputData: { brief: '合成产品预算恢复', iterationId: 'budget-recovery' } });
    const before = await readIntake(workflow, run.runId);
    assert.equal(before.status, 'failed'); assert.equal(before.retry && 'additionalContextLevel' in before.retry ? before.retry.additionalContextLevel : undefined, undefined);
    await assert.rejects(respondIntake(workflow, 'fixture', run.runId, { retryHash: before.retry!.hash, additionalContextLevel: 2 }), /资料预算门槛已移除/);
    const after = await respondIntake(workflow, 'fixture', run.runId, { retryHash: before.retry!.hash });
    assert.equal(after.status, 'suspended'); assert.equal(after.step, 'review-product'); assert.ok(after.product);
    assert.deepEqual(counts, { writing: 2 });
    const snapshot = await workflow.getWorkflowRunById(run.runId);
    assert.equal((snapshot!.steps!['draft-product.product-writing'] as any).output.contextBudgetLevel, 0);
    assert.equal((snapshot!.steps!['review-product'] as any).status, 'suspended');
  } finally { await app.storage.close(); rmSync(directory, { recursive: true, force: true }); }
});

import { describeRecovery } from '../src/intake/recovery.js';
test('Time travel 不开放开发副作用、错误状态、不完整前序或已有批准版本', /** 固定边界防止将产品重试扩张为任意节点回放。 */() => {
  const payload = { brief: '合成需求', mode: 'fixture', artifacts: [], reviews: [], outcome: 'in-progress', productWork: { version: 'product-graph.v1', entries: [] } };
  const steps = { 'draft-product.product-writing': { status: 'failed', payload } };
  assert.equal(describeRecovery('test', 'failed', steps), undefined);
  assert.equal(describeRecovery('test', 'running', steps), undefined);
  assert.equal(describeRecovery('test', 'failed', { 'development-team.implement': { status: 'failed', payload } }), undefined);
  assert.equal(describeRecovery('test', 'failed', { 'draft-product.product-coordinator': { status: 'failed', payload: { ...payload, artifacts: [{ stage: 'product', content: '已有交付', hash: 'a'.repeat(64), evidence: 'fixture' }] } } }), undefined);
});

test('旧产品快照中的闭环执行计划不显示为已完成检查', /** 计划句被保留为历史事实，但不冒充角色交付。 */() => {
  const entries = [
    { role: 'coordinator', content: '已完成统筹结果', toolNames: [], modelSteps: 1 },
    { role: 'clarification', content: '已完成需求梳理结果', toolNames: [], modelSteps: 1 },
    { role: 'closure', content: '我会检查产品需求中的验收标准和异常流程。', toolNames: [], modelSteps: 1 },
  ];
  const payload = { brief: '合成需求', mode: 'fixture', artifacts: [], reviews: [], outcome: 'in-progress', productWork: { version: 'product-graph.v1', entries } };
  const retry = describeRecovery('test', 'failed', { 'draft-product.product-writing': { status: 'failed', payload } })!;
  assert.deepEqual(retry.preserved.map(item => 'complete' in item ? item.complete : undefined), [true, true, false]);
});
