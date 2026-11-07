/** 确定性专项只验证控制流与评分拒绝条件；真实模型结果由独立原生实验保存。 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { generateV2, type GeneratorV2 } from '../src/development/v2/agents.js';
import { correctTitle, runReviewTrial, reviewTrialPassed, type ReviewScenario } from '../src/evaluation/review-rework.js';

/** 仅在fixture测试中提供有源码依据的合成评审，正式live入口不使用本生成器。 */
const fixtureReview: GeneratorV2 = async (...args) => {
  const entry = await generateV2(...args);
  const [, execution, role, state] = args;
  if (role === 'backend') await execution.writeFile('src/solution.mjs', correctTitle);
  if (role !== 'reviewer') return entry;
  const faulty = (await execution.readFile('src/solution.mjs')).includes('const length=title.length');
  const assessment = JSON.parse(entry.text);
  assessment.verdict = faulty ? 'CONCERNS' : 'PASS';
  assessment.findings = faulty ? [{ id: `unicode-${state.round}`, category: 'implementation', severity: 'high', route: 'backend', detail: 'Unicode码点错误：80个emoji应通过，但UTF-16长度为160被拒绝', refs: ['file:src/solution.mjs'], evidence: 'const length=title.length 使用UTF-16而非码点' }] : [];
  assessment.resolutions = faulty ? [] : state.codeReviews.flatMap(
    // 后续合成评审逐条引用原发现，不能以PASS覆盖历史。
    (report) => report.assessment.findings.map(
      // 只有实际源码已修复时才生成修复结论。
      (finding) => ({ findingId: finding.id, decision: 'fixed', reason: '实际源码使用Array.from计数码点', refs: ['file:src/solution.mjs'] }),
    ),
  );
  return { ...entry, text: JSON.stringify(assessment) };
};

for (const scenario of ['clean', 'repair', 'exhausted'] as ReviewScenario[]) {
  test(`固定专项真实Store/沙箱闭环：${scenario}`, { timeout: 120000 }, /** 合成评审与真实文件执行分开标记。 */ async () => {
    const parent = mkdtempSync(resolve(tmpdir(), 'review-rework-test-'));
    try {
      const config = { rootDir: resolve('.'), mode: 'fixture' as const, modelId: 'openai/fixture' as const, port: 4111, databaseUrl: `file:${resolve(parent, 'store.db')}` };
      const result = await runReviewTrial(config, resolve(parent, 'run'), scenario, fixtureReview);
      assert.equal(reviewTrialPassed(result), true, JSON.stringify({ outcome: result.state?.outcome, recovery: result.state?.recovery, reviews: result.state?.codeReviews, gates: result.state?.gates }));
      if (scenario === 'repair') {
        const mutated = structuredClone(result);
        mutated.state!.resolutions = [];
        assert.equal(reviewTrialPassed(mutated), false);
        mutated.state = structuredClone(result.state);
        mutated.final.passed = false;
        assert.equal(reviewTrialPassed(mutated), false);
        mutated.final.passed = true;
        mutated.state!.codeReviews[0].assessment.findings[0].route = 'frontend';
        assert.equal(reviewTrialPassed(mutated), false);
      }
      if (scenario === 'exhausted') assert.equal(result.state?.delivery, null);
    } finally { rmSync(parent, { recursive: true, force: true }); }
  });
}

// 固化真实专项暴露的边界：代码修好不能替代有效复评报告。
test('修复后复评结构无效仍暂停，隐藏断言通过也不得计交付', { timeout: 120000 }, /** 不放宽门禁或自动重试来制造通过。 */ async () => {
  const parent = mkdtempSync(resolve(tmpdir(), 'review-invalid-report-'));
  /** 第一次评审照常发现缺陷，复评只注入无效报告以验证宿主阻断。 */
  const malformed: GeneratorV2 = async (...args) => {
    const entry = await fixtureReview(...args);
    return args[2] === 'reviewer' && args[3].round === 1 ? { ...entry, text: '{}' } : entry;
  };
  try {
    const config = { rootDir: resolve('.'), mode: 'fixture' as const, modelId: 'openai/fixture' as const, port: 4111, databaseUrl: `file:${resolve(parent, 'store.db')}` };
    const result = await runReviewTrial(config, resolve(parent, 'run'), 'repair', malformed);
    assert.equal(result.workflowStatus, 'suspended');
    assert.equal(result.final.passed, true);
    assert.equal(result.state?.recovery?.phase, 'review-code');
    assert.equal(result.state?.delivery, null);
    assert.equal(reviewTrialPassed(result), false);
  } finally { rmSync(parent, { recursive: true, force: true }); }
});
