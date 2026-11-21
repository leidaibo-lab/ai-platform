/** 在独立 HRM 检出上启动真实业务 Run，并在首个人工关口停止。 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Mastra } from '@mastra/core';
import { readConfig } from '../src/mastra/config.js';
import { createStudioApplicationOptions } from '../src/mastra/app.js';

process.env.MASTRA_MODE = 'live';
process.env.NACOS_TEAM_METHOD_VERSION = '1.0.0';
const directory = resolve('.data/evaluations/hrm-business-20261122');
const root = resolve(directory, 'repository');
const config = { ...readConfig(), hrmRepositoryRoot: root, databaseUrl: `file:${resolve(directory, 'workflow.db')}` };
const brief = readFileSync(resolve(root, 'product/sources/brief.md'), 'utf8');
const options = createStudioApplicationOptions(config);
new Mastra(options);
try {
  await options.storage.init();
  const run = await options.workflows.productDevelopmentWorkflow.createRun();
  console.log(JSON.stringify({ event: 'started', runId: run.runId }));
  const result = await run.start({ inputData: { brief, iterationId: 'hrm-screening-invitation', intakeMode: 'clarify', guidedIntake: true } });
  console.log(JSON.stringify({ event: 'stopped', runId: run.runId, status: result.status, suspended: result.status === 'suspended' ? result.suspended : undefined, steps: result.status === 'suspended' ? result.steps : undefined }));
} finally {
  await options.storage.close();
}
