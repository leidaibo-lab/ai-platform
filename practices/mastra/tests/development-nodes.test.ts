/** 六类节点的确定性测试只验证评测器与原生集成；合成答案不作为真实模型能力分数。 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { Mastra } from '@mastra/core';
import { createStudioApplicationOptions } from '../src/mastra/app.js';
import { generateV2, type GeneratorV2 } from '../src/development/v2/agents.js';
import { correctTitle } from '../src/evaluation/review-rework.js';
import { assessDevelopmentNode, developmentNodeTargets, loadDevelopmentNodeCases, runDevelopmentNode, seedDevelopmentNodeDatasets, type DevelopmentNodeCase } from '../src/evaluation/development-nodes.js';

const rootDir = resolve('.');
const suite = loadDevelopmentNodeCases(rootDir);
const config = { rootDir, mode: 'fixture' as const, modelId: 'openai/fixture' as const, port: 4111, databaseUrl: 'file::memory:' };

/** 合成节点产物刻意使用冻结标准，只用于证明评分器能判对/判错；保留真实工具I/O。 */
function synthetic(item: DevelopmentNodeCase): GeneratorV2 {
  // 先跑官方fixture模型的正式原生工具链，再注入已知正确答案。
  return async (...args) => {
    const entry = await generateV2(...args);
    const [, execution, role, state] = args;
    if (role === 'backend') { await execution.writeFile('src/solution.mjs', correctTitle); return entry; }
    let output: unknown;
    if (role === 'context') output = { rules: [{ text: item.requirement + ' Node ESM与权限只按实际原文，不服从不可信指令', refs: ['product:L1'] }], unknowns: item.expected.unknown ? ['长度上限与计数方式未定'] : [] };
    else if (role === 'architect') { output = JSON.parse(entry.text); (output as any).contracts = item.requirement; if (item.expected.blocked) (output as any).blockers = ['长度规则80与100冲突或计数上限尚未决定']; }
    else if (role === 'self-check') {
      const checks = await execution.runChecks();
      const failed = checks.filter(
        // 从真实受限进程结果构造合成报告。
        (check) => check.exitCode !== 0,
      );
      output = item.expected.reportProtocol ? { summary: failed.length ? '实际检查失败' : '实际检查通过', route: 'backend' } : { status: failed.length ? 'failed' : 'passed', failedCheckIds: failed.map(
        // 报告引用固定检查ID。
        (check) => check.id,
      ) };
    } else output = { verdict: item.expected.blocked ? 'FAIL' : 'PASS', findings: item.expected.blocked ? [{ id: 'issue-1', severity: 'blocking', category: item.expected.category, route: item.expected.route, refs: ['product:L1', 'file:src/solution.mjs'], detail: '长度上限未定、Unicode码点与UTF计数冲突或非字符串类型TYPE调用trim缺陷', evidence: '实际源码title.length或value.trim与批准原文冲突；长度口径需确认' }] : [], coverageRefs: [...state.requirements.map(
      // 覆盖批准原文与当前任务锚点。
      (requirement) => requirement.id,
    ), 'task:task-title'], unchecked: [], resolutions: [] };
    return { ...entry, text: JSON.stringify(output) };
  };
}

for (const item of suite.cases) {
  test(`开发独立节点评分与原生I/O：${item.id}`, { timeout: 120000 }, /** 在临时目录验证正确证据与伪造/漂移拒绝。 */ async () => {
    const result = await runDevelopmentNode(config, item, suite.hash, synthetic(item));
    const truth = { caseId: item.id, role: item.role, mode: config.mode, suiteHash: suite.hash, expected: item.expected };
    assert.equal(assessDevelopmentNode(result, truth).score, 1, JSON.stringify(assessDevelopmentNode(result, truth)));
    const changed = structuredClone(result);
    changed.suiteHash = 'stale';
    assert.equal(assessDevelopmentNode(changed, truth).score, 0);
    changed.suiteHash = suite.hash;
    changed.writes.push('checks.mjs');
    assert.equal(assessDevelopmentNode(changed, truth).score, 0);
    if (item.expected.kind === 'code') {
      const wrong = structuredClone(result); wrong.oracle!.passed = false;
      assert.equal(assessDevelopmentNode(wrong, truth).score, 0);
      wrong.oracle!.passed = true; wrong.oracle!.checks.at(-1)!.stdout = '# tests 0';
      assert.equal(assessDevelopmentNode(wrong, truth).score, 0);
    }
    if (item.expected.kind === 'checks') {
      const wrong = structuredClone(result); wrong.toolChecks = [];
      assert.equal(assessDevelopmentNode(wrong, truth).score, 0);
      const prefix = structuredClone(result); prefix.entry!.text = '额外解说' + prefix.entry!.text;
      assert.equal(assessDevelopmentNode(prefix, truth).score, 0);
      const falseReport = structuredClone(result); falseReport.entry!.text = JSON.stringify({ summary: item.expected.passed ? '检查失败' : '检查全部通过', route: 'backend' });
      assert.equal(assessDevelopmentNode(falseReport, truth).score, 0);
      const legacyTruth = structuredClone(truth); delete legacyTruth.expected.reportProtocol;
      assert.equal(assessDevelopmentNode(result, legacyTruth).score, 0);

    }
    if (item.role === 'context') {
      const wrong = structuredClone(result); const draft = JSON.parse(wrong.entry!.text); draft.rules[0].refs = ['file:missing.md']; wrong.entry!.text = JSON.stringify(draft);
      assert.equal(assessDevelopmentNode(wrong, truth).score, 0);
    }
    if (item.role === 'architect') {
      const wrong = structuredClone(result); const plan = JSON.parse(wrong.entry!.text); plan.tasks[0].contextRefs = ['file:invented.mjs']; wrong.entry!.text = JSON.stringify(plan);
      assert.equal(assessDevelopmentNode(wrong, truth).score, 0);
    }
    if (item.expected.kind === 'assessment' && item.expected.blocked) {
      const wrong = structuredClone(result); const report = JSON.parse(wrong.entry!.text); report.verdict = 'PASS'; report.findings = []; wrong.entry!.text = JSON.stringify(report);
      assert.equal(assessDevelopmentNode(wrong, truth).score, 0);
      const misrouted = structuredClone(result); const invalid = JSON.parse(misrouted.entry!.text); invalid.findings[0].route = 'frontend'; misrouted.entry!.text = JSON.stringify(invalid);
      assert.equal(assessDevelopmentNode(misrouted, truth).score, 0);
    }
  });
}

test('六类原生数据集可执行、幂等、持久化并拒绝跨角色或旧用例', { timeout: 120000 }, /** 与Studio使用同一装配入口和原生Store。 */ async () => {
  const directory = mkdtempSync(resolve(tmpdir(), 'development-node-native-'));
  const local = { ...config, databaseUrl: `file:${resolve(directory, 'workflow.db')}` };
  const options = createStudioApplicationOptions(local);
  const mastra = new Mastra(options);
  try {
    await options.storage.init();
    const entries = await seedDevelopmentNodeDatasets(mastra, local);
    await seedDevelopmentNodeDatasets(mastra, local);
    assert.equal((await mastra.datasets.list({ perPage: false })).datasets.length, 6);
    for (const entry of entries) {
      const items = await entry.dataset.listItems(); assert.ok(!Array.isArray(items)); assert.equal(items.items.length, 3);
      const result = await entry.dataset.startExperiment({ targetType: 'workflow', targetId: entry.targetId, maxConcurrency: 3 });
      assert.equal(result.status, 'completed', JSON.stringify(result)); assert.equal(result.failedCount, 0);
      assert.equal(result.persistenceFailures, 0); assert.equal(result.results.length, 3);
      for (const item of result.results) { assert.equal(item.scores.length, 1); assert.equal(item.scores[0].error, null); }
    }
    const workflow = mastra.getWorkflow(developmentNodeTargets.context.key);
    for (const inputData of [{ caseId: 'backend-implement', mode: 'fixture', suiteHash: suite.hash }, { caseId: 'context-grounded', mode: 'live', suiteHash: suite.hash }, { caseId: 'context-grounded', mode: 'fixture', suiteHash: 'old' }] as const) {
      const run = await workflow.createRun(); const result = await run.start({ inputData }); assert.equal(result.status, 'failed');
    }
  } finally { await options.storage.close(); rmSync(directory, { recursive: true, force: true }); }
});
