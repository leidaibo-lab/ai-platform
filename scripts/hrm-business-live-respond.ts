/** 将用户明确确认的澄清决定提交到既有 HRM Run。 */
import { resolve } from 'node:path';
import { Mastra } from '@mastra/core';
import { readConfig } from '../src/mastra/config.js';
import { createStudioApplicationOptions } from '../src/mastra/app.js';
import { readIntake, respondIntake } from '../src/intake/service.js';

process.env.MASTRA_MODE = 'live';
process.env.NACOS_TEAM_METHOD_VERSION = '1.0.0';
const directory = resolve('.data/evaluations/hrm-business-20261122');
const config = { ...readConfig(), hrmRepositoryRoot: resolve(directory, 'repository'), databaseUrl: `file:${resolve(directory, 'workflow.db')}` };
const options = createStudioApplicationOptions(config);
new Mastra(options);
const runId = '6cf24277-a222-4854-acd2-045d62e5fe93';
try {
  await options.storage.init();
  const workflow = options.workflows.productDevelopmentWorkflow;
  const current = await readIntake(workflow, runId, config);
  if (current.intake?.hash !== '2ea0fffaaa74b7f71af46527845382dd8f6f6fae778995b2082431dec9c8d822') throw new Error('澄清版本已改变，停止提交');
  const result = await respondIntake(workflow, 'live', runId, {
    hash: current.intake.hash, action: 'finalize', reviewer: '用户授权的评测决策', supplement: '',
    answers: [
      { questionId: 'invite-correction-effect', selected: ['update-effective-state'], custom: '' },
    ],
  }, config);
  console.log(JSON.stringify({ runId, status: result.status, gate: result.gate, intake: result.intake, product: result.product }));
} finally {
  await options.storage.close();
}
