/** 导入或执行原生评测；与Studio共用配置和Store，默认只导入，不隐式调用真实模型。 */
import { Mastra } from '@mastra/core';
import { readConfig } from '../src/mastra/config.js';
import { createStudioApplicationOptions } from '../src/mastra/app.js';
import { seedNativeDatasets } from '../src/evaluation/datasets.js';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const args = process.argv.slice(2);
for (const arg of args) if (!['--seed', '--run', '--strict'].includes(arg)) throw new Error(`未知参数：${arg}`);
const config = readConfig();
if (args.includes('--strict') && (!args.includes('--run') || config.mode !== 'live')) throw new Error('--strict要求--run与live模式，fixture不能作为语义质量准入。');
const options = createStudioApplicationOptions(config);
const mastra = new Mastra(options);
try {
  await options.storage.init();
  const datasets = await seedNativeDatasets(mastra, config.rootDir, config.mode);
  for (const entry of datasets) {
    console.log(JSON.stringify({ datasetId: entry.dataset.id, targetId: entry.targetId, mode: config.mode }));
    if (!args.includes('--run')) continue;
    const revision = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: config.rootDir, encoding: 'utf8' }).trim();
    const dirty = execFileSync('git', ['status', '--porcelain'], { cwd: config.rootDir, encoding: 'utf8' }).trim().length > 0;
    const promptHash = createHash('sha256').update(readFileSync(resolve(config.rootDir, 'src/mastra/agents/index.ts'))).update(readFileSync(resolve(config.rootDir, 'src/mastra/agents/product-roles.ts'))).digest('hex');
    const result = await entry.dataset.startExperiment({ targetType: 'agent', targetId: entry.targetId, name: `${config.mode} · ${entry.targetId} · ${new Date().toISOString()}`, maxConcurrency: 1,
      metadata: { mode: config.mode, modelId: config.modelId, revision, dirty, promptSourceHash: promptHash, sourceHash: entry.sourceHash, semanticAdmission: 'not-decided', authority: 'evaluation-only' },
    });
    console.log(JSON.stringify({ experimentId: result.experimentId, status: result.status, failedCount: result.failedCount, persistenceFailures: result.persistenceFailures }));
    if (result.failedCount || result.persistenceFailures || result.completedWithErrors || result.status !== 'completed') process.exitCode = 1;
    for (const item of result.results) {
      if (!item.scores.length) process.exitCode = 1;
      for (const score of item.scores) {
        if (score.error || score.score == null || !Number.isFinite(score.score)) process.exitCode = 1;
        if (args.includes('--strict') && score.score !== 1) process.exitCode = 1;
      }
    }
  }
} finally { await options.storage.close(); }
