/** 按原生恢复入口重试已记录的 HRM 产品阶段故障。 */
import { resolve } from 'node:path';
import { Mastra } from '@mastra/core';
import { readConfig } from '../src/mastra/config.js';
import { createStudioApplicationOptions } from '../src/mastra/app.js';
import { readIntake, respondIntake } from '../src/intake/service.js';
process.env.MASTRA_MODE = 'live'; process.env.NACOS_TEAM_METHOD_VERSION = '1.0.0';
const directory = resolve('.data/evaluations/hrm-business-20261122');
const config = { ...readConfig(), hrmRepositoryRoot: resolve(directory, 'repository'), databaseUrl: `file:${resolve(directory, 'workflow.db')}` };
const options = createStudioApplicationOptions(config); new Mastra(options);
const runId = '6cf24277-a222-4854-acd2-045d62e5fe93';
try {
  await options.storage.init(); const workflow = options.workflows.productDevelopmentWorkflow;
  const current = await readIntake(workflow, runId, config);
  if (current.status !== 'failed' || current.retry?.step !== 'product-team.product-writing') throw new Error('产品写作检查点不符合预期');
  const result = await respondIntake(workflow, 'live', runId, { retryHash: current.retry.hash }, config);
  console.log(JSON.stringify({ runId, status: result.status, intake: result.intake, gate: result.gate, product: result.product, retry: result.retry }));
} finally { await options.storage.close(); }
