/** 原生同Run澄清→完整修订→批准→重新规划；只用合成模型，不替用户选择业务答案。 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { Mastra } from '@mastra/core';
import { createStudioApplicationOptions } from '../src/mastra/app.js';
import { createProductDevelopmentWorkflow, executionResolver } from '../src/mastra/workflows/product-development.js';
import { generateV2, type GeneratorV2 } from '../src/development/v2/agents.js';
import { readIntake, respondIntake } from '../src/intake/service.js';

const project = { id: 'blocker-cycle', files: { 'src/a.mjs': 'export const initial=0;', 'check.mjs': 'export const check=1;' }, writablePaths: ['src/a.mjs'], checkFiles: ['check.mjs'], roles: ['backend'] };
const actor = { reviewer: 'test-human', comment: '合成明确确认' };
/** 每例独占数据库，可重建相同应用模拟跨进程读取；只改变架构的合成阻塞轮次。 */
function setup(blockerRounds = 1) {
  const directory = mkdtempSync(resolve(tmpdir(), 'blocker-clarification-'));
  const config = { rootDir: resolve('.'), mode: 'fixture' as const, modelId: 'openai/fixture' as const, port: 4111, databaseUrl: `file:${resolve(directory, 'workflow.db')}` };
  let plans = 0;
  /** 阻塞仅来自已保存模型输出，其他步骤仍执行正式工具/版本校验。 */
  const generate: GeneratorV2 = async (...args) => { const entry = await generateV2(...args); if (args[2] !== 'architect') return entry; const plan = JSON.parse(entry.text); if (++plans <= blockerRounds) plan.blockers = ['合成业务待确认：首期范围', '工程上下文缺口：docs/decisions资料待宿主关联']; return { ...entry, text: JSON.stringify(plan) }; };
  /** legacy只用于形成真实旧版本blocked记录，不编辑数据库。 */
  function open(legacyBlocked = false) { const app = createStudioApplicationOptions(config); const workflow = createProductDevelopmentWorkflow(app.agents as any, config, generate, { legacyBlocked }); new Mastra({ ...app, workflows: { productDevelopmentWorkflow: workflow } }); return { ...app, workflow }; }
  /** 真实产品批准和项目确认后到达澄清或旧blocked状态。 */
  async function start(app: ReturnType<typeof open>) {
    const run = await app.workflow.createRun(); await run.start({ inputData: { brief: '合成业务选择补齐验证', iterationId: 'blocker-cycle' } });
    let doc = await readIntake(app.workflow, run.runId); const originalHash = doc.product!.artifact.hash;
    doc = await respondIntake(app.workflow, 'fixture', run.runId, { role: 'product', artifactHash: originalHash, decision: 'approve', ...actor }, config);
    doc = await respondIntake(app.workflow, 'fixture', run.runId, { gateHash: doc.gate!.gateHash, data: { project, ...actor } }, config);
    return { runId: run.runId, doc, originalHash };
  }
  /** 卡片明确选择来自测试输入，不把推荐或默认值当作人工回答。 */
  function answers(doc: Awaited<ReturnType<typeof readIntake>>) { return { gateHash: doc.gate!.gateHash, data: { ...doc.gate!.fixed, reviewer: actor.reviewer, answers: doc.gate!.evidence.plan.questions.map(/** 使用当前版本真实问题ID。 */(question: any) => ({ questionId: question.id, selected: ['minimal'], custom: '本轮显式选择的补充' })), supplement: '合成补充说明' } }; }
  return { directory, config, open, start, answers };
}

for (const legacy of [false, true]) test(legacy ? '旧blocked同Run接续，回答修订后单独批准并回到技术方案确认' : '新阻塞直接生成可回答卡片，修订稿批准前不进入开发', /** 版本、源码、调用额度及前后人工关口都走原生存储。 */async () => {
  const fixture = setup(); let app = fixture.open(legacy);
  try {
    let { runId, doc, originalHash } = await fixture.start(app);
    if (legacy) {
      assert.equal(doc.status, 'success'); assert.equal(doc.outcome, 'blocked'); assert.ok(doc.clarify);
      await assert.rejects(respondIntake(app.workflow, 'fixture', runId, { clarifyHash: '0'.repeat(64) }, fixture.config), /版本/);
      await app.storage.close(); app = fixture.open();
      doc = await respondIntake(app.workflow, 'fixture', runId, { clarifyHash: doc.clarify!.hash }, fixture.config);
    }
    assert.equal(doc.status, 'suspended'); assert.equal(doc.gate!.key, 'confirm-blocker-answers');
    assert.equal(doc.gate!.evidence.plan.questions.length, 1); assert.equal(doc.gate!.evidence.engineering.length, 1); assert.equal('answers' in doc.gate!.initial, false);
    const gateHash = doc.gate!.gateHash; const body = fixture.answers(doc);
    await assert.rejects(respondIntake(app.workflow, 'fixture', runId, { ...body, data: { ...body.data, answers: [] } }, fixture.config), /必答/);
    await assert.rejects(respondIntake(app.workflow, 'fixture', runId, { ...body, data: { ...body.data, answers: [{ questionId: 'unknown', selected: [], custom: 'x' }] } }, fixture.config), /未知/);
    assert.equal((await readIntake(app.workflow, runId)).gate!.gateHash, gateHash);
    doc = await respondIntake(app.workflow, 'fixture', runId, body, fixture.config);
    assert.equal(doc.gate!.key, 'review-revised-product'); assert.match(doc.gate!.evidence.draft.content, /本轮显式选择的补充/); assert.notEqual(doc.gate!.fixed.hash, originalHash);
    const revisedHash = doc.gate!.fixed.hash;
    await assert.rejects(respondIntake(app.workflow, 'fixture', runId, { gateHash: doc.gate!.gateHash, data: { hash: originalHash, decision: 'approve', ...actor } }, fixture.config), /版本/);
    const snapshot = await app.workflow.getWorkflowRunById(runId); const pending = Object.values(snapshot!.steps!).find(/** 当前真实暂停载荷拥有旧开发基线。 */step => !Array.isArray(step) && step.status === 'suspended') as any;
    const oldInput = pending.payload.development.input; const oldCalls = pending.payload.development.calls;
    await app.storage.close(); app = fixture.open();
    doc = await respondIntake(app.workflow, 'fixture', runId, { gateHash: doc.gate!.gateHash, data: { hash: revisedHash, decision: 'approve', ...actor } }, fixture.config);
    assert.equal(doc.gate!.key, 'approve-architecture'); assert.equal(doc.runId, runId);
    const next = await app.workflow.getWorkflowRunById(runId); const approval = Object.values(next!.steps!).find(/** 重新规划仍等待独立的技术方案批准。 */step => !Array.isArray(step) && step.status === 'suspended') as any;
    assert.equal(approval.payload.input.source.hash, revisedHash); assert.equal(approval.payload.input.continuation.sourceHash, originalHash); assert.ok(approval.payload.calls > oldCalls); assert.equal(approval.payload.maxCalls, 72); assert.equal(approval.payload.completedTasks.length, 0);
    assert.deepEqual(approval.payload.input.project.writablePaths, project.writablePaths);
    const oldCandidate = executionResolver(fixture.config)(oldInput); try { assert.equal(await oldCandidate.readFile('src/a.mjs'), project.files['src/a.mjs']); } finally { await oldCandidate.close(); }
    assert.equal((next!.steps!['review-product'] as any).output.artifacts[0].hash, originalHash);
  } finally { await app.storage.close(); rmSync(fixture.directory, { recursive: true, force: true }); }
});

for (const decision of ['revise', 'stop'] as const) test(`修订产品稿可以${decision}，不会自动批准或实施`, /** 返回选择保留历史，停止则不放行任何开发。 */async () => {
  const fixture = setup(); const app = fixture.open();
  try {
    const started = await fixture.start(app); let doc = await respondIntake(app.workflow, 'fixture', started.runId, fixture.answers(started.doc), fixture.config);
    doc = await respondIntake(app.workflow, 'fixture', started.runId, { gateHash: doc.gate!.gateHash, data: { ...doc.gate!.fixed, decision, ...actor } }, fixture.config);
    if (decision === 'revise') { assert.equal(doc.status, 'suspended'); assert.equal(doc.gate!.key, 'confirm-blocker-answers'); assert.ok(doc.gate!.evidence.previousAnswers); }
    else { assert.equal(doc.status, 'success'); assert.equal(doc.outcome, 'blocked'); assert.equal(doc.gate, undefined); }
  } finally { await app.storage.close(); rmSync(fixture.directory, { recursive: true, force: true }); }
});

test('答案提交前拒绝源码漂移，修订失败时已提交回答仍可读且有只读生成恢复入口', /** 正常版本拒绝和草稿/回答保留不能依赖浏览器本地状态。 */async () => {
  const fixture = setup(); const app = fixture.open();
  try {
    const started = await fixture.start(app); const snapshot = await app.workflow.getWorkflowRunById(started.runId);
    const paused = Object.values(snapshot!.steps!).find(/** 当前暂停是补齐业务选择。 */step => !Array.isArray(step) && step.status === 'suspended') as any;
    const input = paused.payload.development.input; const execution = executionResolver(fixture.config)(input);
    try { await execution.writeFile('src/a.mjs', 'export const drift=1;'); } finally { await execution.close(); }
    await assert.rejects(respondIntake(app.workflow, 'fixture', started.runId, fixture.answers(started.doc), fixture.config), /检查点/);
    assert.equal((await readIntake(app.workflow, started.runId)).gate!.gateHash, started.doc.gate!.gateHash);
    const restore = executionResolver(fixture.config)(input); try { await restore.writeFile('src/a.mjs', project.files['src/a.mjs']); } finally { await restore.close(); }
    const root = app.workflow as any;
    // 只模拟写作节点失败，故意不附带请求数据，以验证原生回答保留与恢复白名单。
    root.steps['resolve-development-blockers'].steps['blocker-round'].steps['write-revised-product'].execute = async () => { throw new Error('synthetic-write-failure'); };
    const doc = await respondIntake(app.workflow, 'fixture', started.runId, fixture.answers(started.doc), fixture.config);
    assert.equal(doc.status, 'failed'); assert.equal(doc.retry!.title, '产品稿修订'); assert.equal(doc.retry!.preserved.at(-1)!.role, 'answers');
    const failed = await app.workflow.getWorkflowRunById(started.runId); const write = failed!.steps![doc.retry!.step] as any;
    assert.equal(write.payload.answer.answers[0].custom, '本轮显式选择的补充');
  } finally { await app.storage.close(); rmSync(fixture.directory, { recursive: true, force: true }); }
});
