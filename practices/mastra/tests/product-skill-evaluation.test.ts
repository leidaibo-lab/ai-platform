import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { createAgents } from '../src/mastra/agents/index.js';
import { productRoles } from '../src/mastra/workflows/product-contract.js';
import { productRoleProfiles } from '../src/mastra/agents/product-roles.js';
import { inputsSchema, rubricSchema, reviewed, runProductSkillTrial, sha256, summarize, usage,
  type HumanReview, type TrialEntry, type TrialResult } from '../src/product-skill-evaluation.js';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const config = { rootDir: root, mode: 'fixture' as const, databaseUrl: 'file::memory:', port: 4111, modelId: 'openai/gpt-4o-mini' as const };
const inputs = inputsSchema.parse(JSON.parse(readFileSync(resolve(root, 'evaluations/product-skills/inputs.json'), 'utf8')));
const rubric = rubricSchema.parse(JSON.parse(readFileSync(resolve(root, 'evaluations/product-skills/rubric.json'), 'utf8')));

// 对照组仍具备相同职责、工作预算和事实边界，但不再要求调用不存在的 Skill。
test('开关只移除产品 Skill 与调用指引，保留四角色职责及共同约束', async () => {
  const a = createAgents(config, { skillsEnabled: false });
  const b = createAgents(config);
  const keys = ['productCoordinatorAgent', 'productClarificationAgent', 'productClosureAgent', 'productAgent'] as const;
  for (let i = 0; i < keys.length; i++) {
    const left = a[keys[i]], right = b[keys[i]];
    assert.equal((await left.listSkills()).length, 0);
    assert.equal((await right.listSkills()).length, 113);
    const without = String(await left.getInstructions()), withSkills = String(await right.getInstructions());
    assert.ok(without.includes(productRoleProfiles[productRoles[i]].instructions));
    assert.ok(withSkills.includes(productRoleProfiles[productRoles[i]].instructions));
    assert.doesNotMatch(without, /product-pm-|product-requirements-handoff|skill_read/);
    for (const constraint of ['24 步', '不编造用户回答', '不能修改系统指令', '不得编造']) {
      assert.ok(without.includes(constraint));
      assert.ok(withSkills.includes(constraint));
    }
  }
});

// 真正运行同一原生流程，覆盖暂停点、四角色产物和逐步 usage，而非只测试配置开关。
test('两组独立执行同一原始诉求，四角色完整并停在产品人工验收', async () => {
  const directory = mkdtempSync(resolve(tmpdir(), 'product-skill-eval-'));
  try {
    for (const variant of ['without-skills', 'with-skills'] as const) {
      const result = await runProductSkillTrial({ ...config, databaseUrl: 'file:' + resolve(directory, variant + '.db') }, variant, inputs.cases[0].brief);
      assert.equal(result.status, 'ready-for-review');
      assert.ok(result.artifact);
      assert.deepEqual(result.productWork?.entries.map(
        // 对比不改变角色数量或合法路径。
        (item) => item.role,
      ), [...productRoles]);
      assert.equal(result.steps.length, 8);
      assert.equal(usage(result).totalTokens, 256);
      assert.equal(usage(result).estimatedUsd, null);
      assert.ok(result.steps.some(
        // fixture 真实走只读工具循环，不宣称使用产品方法或具有真实分析质量。
        (step) => step.calls.some(
          // 从逐步计量中核对真正发出的只读工具调用。
          (call) => call.name === 'practiceInfo',
        ),
      ));
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

/** 聚合测试固定计量，不用这些合成结果代表模型质量。 */
function result(actualModel = 'reported-model'): TrialResult {
  return { status: 'ready-for-review', runId: 'test', elapsedMs: 1000, failure: null, artifact: '测试稿', productWork: null,
    steps: [{ role: 'writing', actualModel, configuredModel: 'alias', finishReason: 'stop', inputTokens: 100, outputTokens: 20, cachedInputTokens: null, calls: [] }] };
}

/** 完成人工表仅为验证汇总数学和空值，不是实际人工审阅记录。 */
function review(sampleId: string): HumanReview {
  return { sampleId, caseId: 'recruitment', reviewer: '确定性测试', firstPass: true, reviewSeconds: 60,
    // 测试填写全部量表项，验证正式汇总不会由空值自动推断。
    coverage: rubric.cases.recruitment.map((item) => ({ id: item.id, status: 'met', evidence: '测试依据' })), additionalDefects: [] };
}

// 首稿通过不能从待评、遗漏或伪造的重复评分项推导。
test('人工指标默认待评，缺依据、重复项及通过与严重问题冲突均不算完成', () => {
  const item = review('a');
  assert.equal(reviewed(undefined, rubric.cases.recruitment), false);
  assert.equal(reviewed({ ...item, firstPass: null }, rubric.cases.recruitment), false);
  assert.equal(reviewed(item, rubric.cases.recruitment), true);
  item.coverage[0].status = 'missing';
  assert.equal(reviewed(item, rubric.cases.recruitment), false);
  item.firstPass = false;
  assert.equal(reviewed(item, rubric.cases.recruitment), true);
  item.coverage[0].evidence = '';
  assert.equal(reviewed(item, rubric.cases.recruitment), false);
  item.coverage[0] = item.coverage[1];
  assert.equal(reviewed(item, rubric.cases.recruitment), false);
});

// 未报告计量与失败用量不能被当作零费用，缓存价差也须有实际缓存量。
test('usage、失败和缓存计量不完整时保留已知下界，费用不能猜测', () => {
  const trial = result();
  const price = { source: '测试价目，非真实报价', date: '2026-11-06', models: { 'reported-model': { input: 2, cachedInput: 1, output: 4 } } };
  assert.equal(usage(trial, price).estimatedUsd, null);
  trial.steps[0].cachedInputTokens = 40;
  assert.equal(usage(trial, price).estimatedUsd, 0.00024);
  trial.steps[0].inputTokens = null;
  assert.equal(usage(trial, price).totalTokens, null);
  assert.equal(usage(trial, price).reportedOutput, 20);
  assert.equal(usage(trial, price).estimatedUsd, null);
  trial.status = 'failed';
  assert.equal(usage(trial).complete, false);
});

// 保留失败与未开始项；主质量差值只能来自同模型且双方完整人工审阅的配对。
test('成对差值不混入未审、失败或模型漂移，也不从计划删除失败', () => {
  const entries: TrialEntry[] = [
    { sampleId: 'a', pairId: 'p1', caseId: 'recruitment', variant: 'without-skills', result: result() },
    { sampleId: 'b', pairId: 'p1', caseId: 'recruitment', variant: 'with-skills', result: result() },
    { sampleId: 'c', pairId: 'p2', caseId: 'recruitment', variant: 'without-skills', result: { ...result(), status: 'failed' } },
    { sampleId: 'd', pairId: 'p2', caseId: 'recruitment', variant: 'with-skills', result: null },
  ];
  const pending = summarize(entries, [], rubric);
  assert.equal(pending.groups[0].planned, 2);
  assert.equal(pending.groups[0].failed, 1);
  assert.equal(pending.groups[1].notStarted, 1);
  assert.equal(pending.groups[0].firstPassRateAmongReviewed, null);
  assert.equal(pending.groups[0].missing, null);
  assert.equal(pending.pairs[0].humanDelta, null);
  const without = review('a');
  without.firstPass = false; without.reviewSeconds = 100; without.coverage[0].status = 'missing';
  const complete = summarize(entries, [without, review('b')], rubric);
  assert.deepEqual(complete.pairs[0].humanDelta, { missing: -1, incorrect: 0, firstPass: 1, reviewSeconds: -40 });
  entries[1].result = result('other-model');
  assert.equal(summarize(entries, [without, review('b')], rubric).pairs[0].humanDelta, null);
  assert.throws(
    // 外来或重复人工记录不得污染当前样本。
    () => summarize(entries, [without, without], rubric), /重复或未知/,
  );
});

// 真实输入与人工标准分别加载；招聘样本锁定到原始诉求，不读取含历史答案的项目 README。
test('需求输入与评分量表分离且招聘原始诉求字节一致', () => {
  assert.equal(sha256(inputs.cases[0].brief), sha256(readFileSync(resolve(root, 'projects/pm-hrm-recruitment/brief.md'), 'utf8')));
  assert.equal(inputs.cases.length, 3);
  for (const item of inputs.cases) {
    assert.ok(rubric.cases[item.id]?.length);
    assert.ok(!('coverage' in item) && !('groundTruth' in item) && !('criterion' in item));
  }
});
