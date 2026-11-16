/** 将已结束固定开发真实运行的脱敏证据导入Studio；不重新调用模型或重写原运行结论。 */
import { readFileSync } from 'node:fs';
import { resolve, relative } from 'node:path';
import { createHash } from 'node:crypto';
import { Mastra } from '@mastra/core';
import { readConfig } from '../src/mastra/config.js';
import { createStudioApplicationOptions } from '../src/mastra/app.js';
import { developmentOracleSchema, type DevelopmentTrial } from '../src/development-evaluation.js';

const config = readConfig();
if (!process.argv[2]) throw new Error('请指定.data/evaluations下已完成的固定基线目录');
const directory = resolve(process.argv[2]);
const child = relative(resolve(config.rootDir, '.data/evaluations'), directory);
if (!child || child.startsWith('..') || child.startsWith('/')) throw new Error('证据目录超出评测范围');
const raw = readFileSync(resolve(directory, 'trials.json'), 'utf8');
const trials = JSON.parse(raw) as DevelopmentTrial[];
if (!trials.length || trials.some(
  // 运行中或fixture不能导入为真实模型已结束基线。
  (trial) => trial.mode !== 'live' || ['running', 'not-started'].includes(trial.status),
)) throw new Error('基线尚未结束或不是真实模型运行');
const oracle = developmentOracleSchema.parse(JSON.parse(readFileSync(resolve(config.rootDir, 'evaluations/development/oracle.json'), 'utf8')));
const hash = createHash('sha256').update(raw).digest('hex');
const options = createStudioApplicationOptions(config);
const mastra = new Mastra(options);
try {
  await options.storage.init();
  const id = `fixed-development-evidence-${hash.slice(0, 16)}`;
  const found = await mastra.datasets.list({ perPage: false, filters: { datasetIds: [id] } });
  const dataset = found.datasets.length ? await mastra.datasets.get({ id }) : await mastra.datasets.create({ id, name: '固定开发真实模型基线 · 执行证据', description: '导入既有真实运行证据，不重新执行开发；原生Experiment可查看评分与历史，不能冒充完整业务链通过。', scorerIds: ['fixed-development-evidence-v1'], metadata: { sourceHash: hash, sourceDirectory: child, authority: 'imported-live-run-evidence', manualReview: null } });
  const evidence: Record<string, unknown> = {};
  for (const trial of trials) {
    const standard = oracle.cases[trial.caseId];
    if (!standard) throw new Error('固定基线缺少冻结预期');
    evidence[trial.id] = { caseId: trial.caseId, mode: trial.mode, runId: trial.runId ?? 'no-run-created', status: trial.status, outcome: trial.state?.outcome ?? null, hiddenPassed: trial.hidden?.passed ?? null, assertions: trial.hidden?.assertions ?? 0, blockers: trial.state?.plan?.blockers ?? [], failure: trial.failure, manualReview: null };
    await dataset.addItem({ externalId: trial.id, input: { trialId: trial.id }, groundTruth: { expectedOutcome: standard.expectedOutcome, assertions: standard.calls.length, blockerKeywords: standard.blockerKeywords ?? [] }, metadata: { sourceHash: hash, caseId: trial.caseId }, scorerIds: ['fixed-development-evidence-v1'] });
  }
  const result = await dataset.startExperiment<{ trialId: string }>({ name: '真实运行证据导入 · 无模型重跑', metadata: { mode: 'live-evidence-import', sourceHash: hash, authority: 'imported-live-run-evidence', manualReview: null },
    // task只回放冻结证据，业务执行仍由原有Workflow事实证明。
    task: ({ input }) => evidence[input.trialId],
  });
  console.log(JSON.stringify({ datasetId: id, experimentId: result.experimentId, status: result.status, scores: result.results.map(
    // 输出有限结果，不打印源文件、凭据或原始SDK异常。
    (item) => ({ itemId: item.itemId, scores: item.scores }),
  ) }));
  if (result.failedCount || result.persistenceFailures) process.exitCode = 1;
} finally { await options.storage.close(); }
