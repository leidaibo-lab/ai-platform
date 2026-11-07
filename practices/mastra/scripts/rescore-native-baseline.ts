/** 用v2裁判复评原始Agent输出，保留v1实验，不重新调用被测Agent。 */
import { Mastra } from '@mastra/core';
import { readConfig } from '../src/mastra/config.js';
import { createStudioApplicationOptions } from '../src/mastra/app.js';
import { seedNativeDatasets } from '../src/evaluation/datasets.js';
const config = readConfig();
if (config.mode !== 'live') throw new Error('复评要求live裁判配置');
const options = createStudioApplicationOptions(config);
const mastra = new Mastra(options);
try {
  await options.storage.init();
  const entries = await seedNativeDatasets(mastra, config.rootDir, 'live', { legacyScoring: true });
  for (const entry of entries) {
    const experiments = await entry.dataset.listExperiments({ perPage: 100 });
    const source = experiments.experiments.find(
      // 只消费本轮首次真实执行，避免将复评分误当新Agent输出。
      (item) => item.name?.startsWith('live · ') && item.status === 'completed',
    );
    if (!source) throw new Error(`原始实验尚未完成：${entry.targetId}`);
    const prior = experiments.experiments.find(
      // 接续复评不重复消耗裁判调用，原生结果继续可查。
      (item) => item.name === `v2-rescore:${source.id}` && item.status === 'completed',
    );
    if (prior) continue;
    const records = await entry.dataset.listExperimentResults({ experimentId: source.id, perPage: 100 });
    const byInput = new Map();
    for (const record of records.results) if (!record.error) byInput.set(JSON.stringify(record.input), record.output);
    const result = await entry.dataset.startExperiment({ name: `v2-rescore:${source.id}`, maxConcurrency: 3, scorers: ['node-contract-coverage-v1', 'node-quality-rubric-v2'], metadata: { mode: 'live-judge-replay', originalExperimentId: source.id, authority: 'rescored-original-agent-output', sourceHash: entry.sourceHash },
      // 回放已持久化输出，裁判调用真实执行；不伪造缺失项为成功。
      task: ({ input }) => {
        const output = byInput.get(JSON.stringify(input));
        if (!output) throw new Error('原始输出缺失，不可复评');
        return output;
      },
    });
    console.log(JSON.stringify({ targetId: entry.targetId, experimentId: result.experimentId, status: result.status, failedCount: result.failedCount }));
    if (result.failedCount || result.persistenceFailures) process.exitCode = 1;
  }
} finally { await options.storage.close(); }
