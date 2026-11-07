/** 固定评审返工专项的原生Experiment入口；上游夹具与真实评审/修复分开标记。 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { Mastra } from '@mastra/core';
import { z } from 'zod';
import { readConfig } from '../src/mastra/config.js';
import { createStudioApplicationOptions } from '../src/mastra/app.js';
import { reviewScenarioSchema, reviewInput, runReviewTrial } from '../src/evaluation/review-rework.js';
import { loadDevelopmentMethods } from '../src/development/v2/methods.js';

if (process.argv.slice(2).join(' ') !== '--live') throw new Error('专项要求显式--live；确定性控制流由测试执行');
process.env.MASTRA_MODE = 'live';
const config = readConfig();
const raw = readFileSync(resolve(config.rootDir, 'evaluations/native/review-rework/cases.v1.json'), 'utf8');
const suite = z.object({ version: z.string(), cases: z.array(z.object({ scenario: reviewScenarioSchema, expected: z.string() })).length(3) }).parse(JSON.parse(raw));
const directory = resolve(config.rootDir, '.data/evaluations', `review-rework-${new Date().toISOString().replace(/[:.]/g, '-')}`);
mkdirSync(directory, { recursive: true, mode: 0o700 });
const sourceHashes: Record<string, string> = {};
for (const path of ['src/evaluation/review-rework.ts','src/mastra/workflows/development-v2.ts','src/development/v2/agents.ts','src/development/v2/gates.ts','src/development-execution.ts','package-lock.json']) sourceHashes[path] = createHash('sha256').update(readFileSync(resolve(config.rootDir, path))).digest('hex');
const hash = createHash('sha256').update(raw).update(JSON.stringify(sourceHashes)).digest('hex');
const manifest = { version: suite.version, mode: 'controlled-upstream-live-review-and-repair', modelId: config.modelId, sourceHashes, methodBundleHash: loadDevelopmentMethods(config.rootDir).hash, suiteHash: hash, cases: suite.cases, manualReview: null, authority: 'evaluation-policy-not-human-approval' };
writeFileSync(resolve(directory, 'manifest.json'), JSON.stringify(manifest, null, 2));
const options = createStudioApplicationOptions(config); const mastra = new Mastra(options);
try {
  await options.storage.init();
  const id = `${suite.version}-${hash.slice(0, 12)}`;
  const found = await mastra.datasets.list({ perPage: false, filters: { datasetIds: [id] } });
  const dataset = found.datasets.length ? await mastra.datasets.get({ id }) : await mastra.datasets.create({ id, name: '固定专项 · 独立评审与缺陷返工', description: '受控上游与源码注入；真实只读评审和backend返工；不代表全链真实模型或动态团队通过。通过CLI重新运行，在原生面板查看逐例结果。', scorerIds: ['fixed-review-rework-v1'], metadata: manifest });
  for (const item of suite.cases) await dataset.addItem({ externalId: item.scenario, input: { scenario: item.scenario }, groundTruth: { expected: item.expected }, scorerIds: ['fixed-review-rework-v1'], metadata: { input: reviewInput(item.scenario), mode: manifest.mode } });
  const result = await dataset.startExperiment<{ scenario: z.infer<typeof reviewScenarioSchema> }>({ name: `固定评审与返工 · ${new Date().toISOString()}`, maxConcurrency: 3, metadata: { ...manifest, directory },
    // 三例目录隔离并行，仅是评测并发；每例业务流程仍为单backend固定串行流程。
    task: async ({ input }) => {
      const trial = await runReviewTrial(config, resolve(directory, input.scenario), input.scenario);
      writeFileSync(resolve(directory, `${input.scenario}.json`), JSON.stringify(trial, null, 2));
      return trial;
    },
  });
  writeFileSync(resolve(directory, 'experiment.json'), JSON.stringify(result, null, 2));
  console.log(JSON.stringify({ directory, datasetId: id, experimentId: result.experimentId, status: result.status, failedCount: result.failedCount, scores: result.results.map(
    // 只输出有限分数，原生Store与本地脱敏文件保存完整证据。
    (item) => ({ input: item.input, scores: item.scores }),
  ) }));
  if (result.failedCount || result.persistenceFailures || result.results.some(
    // completed仅表示实验执行结束，缺评分或0分均使CLI失败。
    (item) => item.scores.length !== 1 || item.scores[0].score !== 1 || item.scores[0].error,
  )) process.exitCode = 1;
} finally { await options.storage.close(); }
