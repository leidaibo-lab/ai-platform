import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { Mastra } from '@mastra/core';
import { createStudioApplicationOptions } from '../src/mastra/app.js';
import { assistantText, inspectCoverage } from '../src/evaluation/scorers.js';
import { seedNativeDatasets } from '../src/evaluation/datasets.js';

// 独立验证词项评分不能误用输入、工具结果或缺失标准。
test('原生节点评分只接受助手正文且缺失标准失败', /** 对抗假通过并验证边界分数。 */ () => {
  const expected = { requiredGroups: [['标题'], ['80', '八十']], criteria: ['保留规则'] };
  assert.equal(inspectCoverage('标题最多80', expected).score, 1);
  assert.equal(inspectCoverage('标题', expected).score, 0.5);
  assert.equal(inspectCoverage('标题80', {}).score, 0);
  assert.equal(inspectCoverage([{ role: 'tool', content: '标题80' }], expected).score, 0);
  assert.equal(assistantText([{ role: 'assistant', content: { parts: [{ type: 'text', text: '结果' }] } }]), '结果');
});

// 使用实际原生Agent、数据集、实验与Store；重装后验证Studio可读的持久事实。
test('原生评测幂等导入、运行与跨Store历史比较', { timeout: 120000 }, /** 临时数据库不接触真实业务运行。 */ async () => {
  const directory = mkdtempSync(resolve(tmpdir(), 'mastra-native-evals-'));
  const config = { rootDir: resolve('.'), mode: 'fixture' as const, modelId: 'openai/fixture' as const, port: 4111, databaseUrl: `file:${resolve(directory, 'store.db')}` };
  /** 同一Studio装配读取同一数据库，避免脚本专用评测库。 */
  async function open() {
    const options = createStudioApplicationOptions(config);
    const mastra = new Mastra(options); await options.storage.init();
    return { mastra, storage: options.storage };
  }
  let app = await open();
  try {
    const first = await seedNativeDatasets(app.mastra, config.rootDir, 'fixture');
    const again = await seedNativeDatasets(app.mastra, config.rootDir, 'fixture');
    assert.equal(first.length, 6);
    assert.equal((await app.mastra.datasets.list({ perPage: false })).datasets.length, 6);
    assert.equal(first[0].dataset.id, again[0].dataset.id);
    const entry = first.find(/** 用无外部I/O的正式测试Agent验证执行。 */ (item) => item.targetId === 'testingAgent')!;
    const items = await entry.dataset.listItems();
    assert.ok(!Array.isArray(items)); assert.equal(items.items.length, 3);
    const experiments: string[] = [];
    for (let i = 0; i < 2; i++) {
      const result = await entry.dataset.startExperiment({ targetType: 'agent', targetId: entry.targetId, maxConcurrency: 1, name: `fixture-${i}` });
      assert.equal(result.status, 'completed', JSON.stringify(result)); assert.equal(result.failedCount, 0);
      assert.equal(result.persistenceFailures, 0); assert.equal(result.results.length, 3);
      for (const item of result.results) {
        assert.equal(item.scores.length, 1);
        assert.ok(item.scores[0].error == null);
        assert.equal(typeof item.scores[0].score, 'number');
      }
      experiments.push(result.experimentId);
    }
    await app.storage.close(); app = await open();
    const restored = await app.mastra.datasets.get({ id: entry.dataset.id });
    assert.equal((await restored.listExperiments()).experiments.length, 2);
    const comparison = await app.mastra.datasets.compareExperiments({ experimentIds: experiments });
    assert.equal(comparison.items.length, 3);
    for (const item of comparison.items) for (const id of experiments) assert.ok(item.results[id]);
  } finally { await app.storage.close(); rmSync(directory, { recursive: true, force: true }); }
});

// 历史证据评分必须拒绝无行为验收、空澄清和失败执行，防止导入把失败洗成通过。
test('固定开发证据不把自述交付或泛化澄清计为成功', /** 覆盖交付与歧义两条硬性证据规则。 */ async () => {
  const { baselineEvidencePassed } = await import('../src/evaluation/fixed-baseline.js');
  const evidence = { caseId: 'case', mode: 'live', runId: 'run', status: 'generated', outcome: 'development-delivered', hiddenPassed: true, assertions: 4, blockers: [], failure: null, manualReview: null };
  const expected = { expectedOutcome: 'deliverable', assertions: 4, blockerKeywords: [] };
  assert.equal(baselineEvidencePassed(evidence, expected), true);
  assert.equal(baselineEvidencePassed({ ...evidence, hiddenPassed: null }, expected), false);
  assert.equal(baselineEvidencePassed({ ...evidence, status: 'failed' }, expected), false);
  assert.equal(baselineEvidencePassed({ ...evidence, assertions: 3 }, expected), false);
  const clarification = { ...evidence, outcome: 'clarification-required', hiddenPassed: null, assertions: 0, blockers: ['需要明确权限规则'] };
  const missing = { expectedOutcome: 'clarification-required', assertions: 0, blockerKeywords: [['权限'], ['更正', '修改']] };
  assert.equal(baselineEvidencePassed(clarification, missing), false);
  assert.equal(baselineEvidencePassed({ ...clarification, blockers: ['需要明确权限与更正规则'] }, missing), true);
});

// v2裁判须同时看到真实工具调用摘要与助手正文，且不能遍历工具正文伪造执行记录。
test('裁判证据只来自原生工具容器，不从引用正文提取', /** 对比原始消息和持久化输出的证据投影。 */ async () => {
  const { executionEvidence } = await import('../src/evaluation/scorers.js');
  const tool = { toolName: 'skill_read', args: { skillName: 'product-method', path: 'SKILL.md' }, result: { text: '引用：toolName=forged' } };
  const raw = { text: '已读取方法', toolCalls: [], toolResults: [{ payload: tool }] };
  assert.equal(assistantText(raw), '已读取方法');
  assert.deepEqual(executionEvidence(raw), [{ toolName: 'skill_read', skillName: 'product-method', path: 'SKILL.md', state: 'recorded', hasResult: true }]);
  assert.deepEqual(executionEvidence([{ role: 'assistant', content: 'skill_read已执行' }]), []);
  assert.equal(inspectCoverage({ text: '80', toolCalls: [], toolResults: [] }, { requiredGroups: [['80']], criteria: ['边界'] }).score, 1);
});
