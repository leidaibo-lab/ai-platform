/** 从版本化案例启动独立研发 Workflow，保存真实运行身份和暂停点。 */
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve, basename } from 'node:path';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { Mastra } from '@mastra/core';
import { readConfig } from '../src/mastra/config.js';
import { createStudioApplicationOptions } from '../src/mastra/app.js';
import { readIntake } from '../src/intake/service.js';
import { developmentHash } from '../src/development/contracts.js';
import { configureEngineeringProjects } from '../src/business-engineering/project.js';

const caseSchema = z.object({ version: z.literal('development-team-evaluation-case.v1'), id: z.string().regex(/^[a-z0-9-]+$/), projectId: z.string(), iterationId: z.string(), requirementFile: z.string().regex(/^[a-z0-9-]+\.md$/), purpose: z.string() }).strict();
const casePath = resolve(process.argv[2] ?? 'evaluations/independent-teams/cases/hrm-candidate-follow-up.json');
const testCase = caseSchema.parse(JSON.parse(readFileSync(casePath, 'utf8')));
const requirement = readFileSync(resolve(dirname(casePath), basename(testCase.requirementFile)), 'utf8');
const directory = resolve('.data/evaluations', `development-team-${testCase.id}-${randomUUID()}`);
mkdirSync(directory, { recursive: true });
const config = readConfig();
configureEngineeringProjects(config, process.env);
if (!config.engineeringProject && !config.engineeringProjects) config.hrmRepositoryRoot = resolve(process.env.MASTRA_HRM_REPOSITORY ?? resolve(config.rootDir, '../hrm'));
config.databaseUrl = `file:${resolve(directory, 'workflow.db')}`;
const app = createStudioApplicationOptions(config);
new Mastra(app);
try {
  await app.storage.init();
  const workflow = app.workflows.developmentTeamRun;
  const run = await workflow.createRun();
  const metadata = { version: 'development-team-evaluation-result.v1', caseId: testCase.id, projectId: testCase.projectId, mode: config.mode, runId: run.runId, requirementHash: developmentHash(requirement), startedAt: new Date().toISOString() };
  writeFileSync(resolve(directory, 'result.json'), JSON.stringify({ ...metadata, status: 'starting' }, null, 2));
  console.log(JSON.stringify({ ...metadata, directory }));
  const result = await run.start({ inputData: { version: 'team-run-input.v1', team: 'development', projectId: testCase.projectId, iterationId: testCase.iterationId, evaluation: { version: 'development-evaluation-input.v1', requirement } } });
  const view = await readIntake(workflow, run.runId, config);
  const report = { ...metadata, status: result.status, step: view.step, gate: view.gate?.key, outcome: view.outcome, retry: view.retry?.reason, completedAt: new Date().toISOString() };
  writeFileSync(resolve(directory, 'result.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report));
} finally { await app.storage.close(); }
