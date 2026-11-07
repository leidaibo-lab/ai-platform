/** 六类开发独立节点评测的原生Dataset/Experiment入口，默认只导入，不隐式调用模型。 */
import { Mastra } from '@mastra/core';
import { readConfig } from '../src/mastra/config.js';
import { createStudioApplicationOptions } from '../src/mastra/app.js';
import { seedDevelopmentNodeDatasets, loadDevelopmentNodeCases } from '../src/evaluation/development-nodes.js';
import { loadDevelopmentMethods } from '../src/development/v2/methods.js';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const args = process.argv.slice(2);
for (const arg of args) if (!['--seed', '--run', '--live', '--strict', '--role=self-check'].includes(arg)) throw new Error(`未知参数：${arg}`);
if (args.includes('--live')) process.env.MASTRA_MODE = 'live';
const config = readConfig();
if (args.includes('--strict') && (!args.includes('--run') || config.mode !== 'live')) throw new Error('--strict需要--run和live模式，fixture不能作为能力准入');
const options = createStudioApplicationOptions(config); const mastra = new Mastra(options);
try {
  await options.storage.init();
  const datasets = await seedDevelopmentNodeDatasets(mastra, config);
  const sourceHashes: Record<string, string> = {};
  for (const path of ['src/evaluation/development-nodes.ts', 'src/evaluation/review-rework.ts', 'src/development/v2/agents.ts', 'src/development/v2/contracts.ts', 'src/development/v2/gates.ts', 'src/development-execution.ts', 'package-lock.json']) sourceHashes[path] = createHash('sha256').update(readFileSync(resolve(config.rootDir, path))).digest('hex');
  const metadata = { mode: config.mode, modelId: config.mode === 'live' ? config.modelId : 'fixture', suiteHash: loadDevelopmentNodeCases(config.rootDir).hash, methodBundleHash: loadDevelopmentMethods(config.rootDir).hash, sourceHashes, revision: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: config.rootDir, encoding: 'utf8' }).trim(), dirty: !!execFileSync('git', ['status', '--porcelain'], { cwd: config.rootDir, encoding: 'utf8' }).trim(), authority: 'evaluation-only', manualReview: null };
  for (const entry of datasets) {
    if (args.includes('--role=self-check') && entry.role !== 'self-check') continue;
    console.log(JSON.stringify({ datasetId: entry.dataset.id, targetId: entry.targetId, mode: config.mode }));
    if (!args.includes('--run')) continue;
    const result = await entry.dataset.startExperiment({ targetType: 'workflow', targetId: entry.targetId, name: `${config.mode} · ${entry.role} · 独立开发节点 · ${new Date().toISOString()}`, maxConcurrency: 3, metadata: { ...metadata, assetHash: metadata.suiteHash, suiteHash: entry.suiteHash } });
    const scores = result.results.map(
      // 输出有限结果；完整上下文、源码、检查及失败原因由原生Store持有。
      (item) => ({ input: item.input, scores: item.scores.map(
        // 不把完整SDK数据或异常正文打印到日志。
        (score) => ({ scorerId: score.scorerId, score: score.score, reason: score.reason, failed: !!score.error }),
      ) }),
    );
    console.log(JSON.stringify({ datasetId: entry.dataset.id, experimentId: result.experimentId, status: result.status, failedCount: result.failedCount, scores }));
    if (result.status !== 'completed' || result.failedCount || result.persistenceFailures || result.results.some(
      // 缺评分、评分执行失败以及strict质量失败均退出非零。
      (item) => item.scores.length !== 1 || item.scores[0].error || typeof item.scores[0].score !== 'number' || !Number.isFinite(item.scores[0].score) || (args.includes('--strict') && item.scores[0].score !== 1),
    )) process.exitCode = 1;
  }
} finally { await options.storage.close(); }
