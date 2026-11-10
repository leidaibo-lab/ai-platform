/** 分类契约与恢复边界：不调用真实模型，不改写历史问题和确认事实。 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generatedPlanSchema, planSchema, validateAnswers, intakeHash, canFinalizePlan } from '../src/intake/contracts.js';
import { generatedBlockerPlanSchema, validateBlockerPlan } from '../src/intake/blocker-contracts.js';
import { createIntakeWorkflow } from '../src/intake/workflow.js';
import { Mastra } from '@mastra/core';
import { LibSQLStore } from '@mastra/libsql';

const required = { id: 'scope', title: '本期范围', reason: '范围尚未确认', required: true, kind: 'single' as const, options: [{ id: 'minimal', label: '最小范围' }], recommendation: '建议最小范围', decision: { blocks: 'product' as const, reason: '未确认时无法定义本期验收范围', unanswered: '暂停产品范围确认，不默认采用建议' } };
const optional = { ...required, id: 'preference', title: '展示偏好', required: false, decision: { blocks: 'none' as const, reason: '不改变本期流程和验收，可在后续完善', unanswered: '保留为待决，不采用推荐作为已确认规则' } };
const maturity = { decisions: { clear: true, evidence: '范围已确认' }, mainFlow: { clear: true, evidence: '主流程已确认' }, exceptions: { clear: true, evidence: '异常已确认' }, delivery: { clear: true, evidence: '剩余事项不影响交付' } };
const plan = { maturity, summary: '分类方案', assumptions: [], questions: [optional, required] };

test('新分类必须有依据、必答一致及正确阶段，旧计划不补写分类或改变hash', /** 强制新输出，兼容旧暂停点。 */() => {
  const parsed = generatedPlanSchema.parse(plan);
  assert.equal(parsed.questions[0].required, false);
  assert.throws(/** 缺失判断依据不能发布新问题。 */() => generatedPlanSchema.parse({ ...plan, questions: [{ ...required, decision: undefined }] }));
  assert.throws(/** 不能把阻塞题同时标记为可选。 */() => generatedPlanSchema.parse({ ...plan, questions: [{ ...required, required: false }] }));
  assert.throws(/** 不能把必答题声明为不阻塞。 */() => planSchema.parse({ ...plan, questions: [{ ...optional, required: true }] }));
  assert.throws(/** 初始阶段不冒充开发开工判断。 */() => generatedPlanSchema.parse({ ...plan, questions: [{ ...required, decision: { ...required.decision, blocks: 'development' } }] }));
  const { decision, ...legacyQuestion } = required;
  const legacy = { ...plan, questions: [legacyQuestion] };
  const state = { enabled: true, ready: false, round: 1, plan: legacy, history: [] };
  const hash = intakeHash('原始需求', state);
  const restored = { ...state, plan: planSchema.parse(legacy) };
  assert.equal(intakeHash('原始需求', restored), hash);
  assert.equal(restored.plan.questions[0].decision, undefined);
});

test('必答完成后可跳过可选；全可选/空问题允许继续但不生成隐式答案', /** 服务端校验仍是唯一提交门槛。 */() => {
  const state = { enabled: true, ready: false, round: 1, plan: generatedPlanSchema.parse(plan), hash: 'a'.repeat(64), history: [] };
  const response = { hash: state.hash, action: 'finalize', reviewer: 'test-human', answers: [{ questionId: 'scope', selected: [], custom: '明确采用最小范围' }], supplement: '' };
  const accepted = validateAnswers(state, response);
  assert.equal(accepted.answers.length, 1);
  assert.equal(accepted.answers.some(/** 未回答可选题不伪造默认值。 */answer => answer.questionId === 'preference'), false);
  assert.throws(/** 只回答可选不允许绕过必答。 */() => validateAnswers(state, { ...response, answers: [{ questionId: 'preference', selected: ['minimal'], custom: '' }] }));
  for (const questions of [[optional], []]) assert.equal(validateAnswers({ ...state, plan: generatedPlanSchema.parse({ ...plan, questions }) }, { ...response, answers: [] }).answers.length, 0);
});

test('业务成熟度：任一维度未闭合、仍有关键问题或旧稿缺少评估都不能成稿', /** 空问题与大量讨论均不替代业务判断。 */() => {
  assert.equal(canFinalizePlan({ ...plan, questions: [] }), true);
  assert.equal(canFinalizePlan(plan), false);
  assert.equal(canFinalizePlan({ ...plan, maturity: undefined, questions: [] }), false);
  for (const key of ['decisions', 'mainFlow', 'exceptions', 'delivery'] as const) {
    assert.equal(canFinalizePlan({ ...plan, questions: [], maturity: { ...maturity, [key]: { clear: false, evidence: '仍缺必要业务决定' } } }), false);
  }
  assert.throws(/** 新输出缺少成熟度不能发布成可确认方案。 */() => generatedPlanSchema.parse({ ...plan, maturity: undefined }));
});

test('开发业务阻塞不能降级；附加可选细节不覆盖业务阻塞', /** 模型分类不能移除宿主实际记录的开工阻塞。 */() => {
  const blocker = { ...required, blockerIds: ['blocker-1'], decision: { ...required.decision, blocks: 'development' as const } };
  const extra = { ...optional, blockerIds: [] };
  const parsed = generatedBlockerPlanSchema.parse({ ...plan, questions: [blocker, extra] });
  const state = { business: [{ id: 'blocker-1', text: '验收边界待定' }] } as any;
  validateBlockerPlan(parsed, state);
  assert.throws(/** 已登记阻塞不允许变成可选。 */() => generatedBlockerPlanSchema.parse({ ...plan, questions: [{ ...extra, blockerIds: ['blocker-1'] }] }));
  assert.throws(/** 可选补充不能假装覆盖原阻塞。 */() => validateBlockerPlan({ ...parsed, questions: [extra] }, state));
  assert.throws(/** 不能发布无实际阻塞来源的开发必答题。 */() => generatedBlockerPlanSchema.parse({ ...plan, questions: [{ ...blocker, blockerIds: [] }] }));
});

test('新Run原生链路：生成分类、暂停、仅答必答后继续，不补造可选答案', /** 脚本模型验证完整数据链，不把结构测试当作真实模型判断质量。 */async () => {
  const storage = new LibSQLStore({ id: 'question-classification-regression', url: 'file::memory:' });
  const agents = { productCoordinatorAgent: { generate: /** 返回混合分类，确认业务入口确实请求严格结构输出。 */async (_prompt: unknown, options: any) => {
    assert.ok(options.structuredOutput.schema);
    return { object: JSON.parse(String(_prompt)).history?.length ? { ...plan, questions: [optional] } : plan };
  } } } as any;
  const workflow = createIntakeWorkflow(agents, 'live');
  new Mastra({ workflows: { workflow }, storage, logger: false });
  try {
    const run = await workflow.createRun();
    const started = await run.start({ inputData: { brief: '合成需求', mode: 'live', artifacts: [], reviews: [], outcome: 'in-progress', intake: { enabled: true, ready: false, round: 0, history: [] } } });
    assert.equal(started.status, 'suspended');
    const snapshot = await workflow.getWorkflowRunById(run.runId);
    assert.ok(snapshot?.steps);
    const entry = snapshot.steps['requirements-round.analyze-requirements'] as any;
    const intake = entry.output.intake;
    assert.equal(intake.plan.questions[0].decision.blocks, 'none');
    const reviewed = await run.resume({ resumeData: { hash: intake.hash, action: 'finalize', reviewer: 'test-human', answers: [{ questionId: 'scope', selected: ['minimal'], custom: '' }], supplement: '' } });
    assert.equal(reviewed.status, 'suspended');
    const saved = await workflow.getWorkflowRunById(run.runId);
    const next = (saved!.steps!['requirements-round.analyze-requirements'] as any).output.intake;
    const supplemented = await run.resume({ resumeData: { hash: next.hash, action: 'finalize', reviewer: 'test-human', answers: [], supplement: '新增异常规则，请重新评估' } });
    assert.equal(supplemented.status, 'suspended');
    const updated = await workflow.getWorkflowRunById(run.runId);
    const latest = (updated!.steps!['requirements-round.analyze-requirements'] as any).output.intake;
    assert.equal(latest.ready, false);
    assert.equal(latest.history.at(-1).response.supplement, '新增异常规则，请重新评估');
    const finished = await run.resume({ resumeData: { hash: latest.hash, action: 'finalize', reviewer: 'test-human', answers: [], supplement: '' } });
    assert.equal(finished.status, 'success');
    if (finished.status === 'success') {
      assert.equal(finished.result.intake?.history[0].response.answers.length, 1);
      assert.equal(finished.result.intake?.ready, true);
    }
  } finally { await storage.close(); }
});
