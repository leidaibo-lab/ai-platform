/** 全栈执行档的权限与自动规划回归；Docker真实验证通过独立verify:hrm执行。 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, dirname } from 'node:path';
import { projectSchema, validateArchitecture } from '../src/development/contracts.js';
import { registeredChecks, inputV2Schema } from '../src/development/v2/contracts.js';
import { createDevelopmentExecution } from '../src/development/hrm-execution.js';
const project = projectSchema.parse({ id: 'hrm', executionProfile: 'hrm-pnpm-docker-v1', planning: 'agent', writableRoots: ['apps/web/app', 'apps/api/src'], files: { 'apps/web/app/page.tsx': 'export const page=1;', 'apps/api/src/main.ts': 'export const api=1;', 'package.json': '{}' }, writablePaths: ['apps/web/app/page.tsx', 'apps/api/src/main.ts'], checkFiles: ['package.json'], roles: ['frontend', 'backend', 'infrastructure'] });

test('Agent决定最小改动与角色，不要求修改全部授权文件；新文件限授权根', /** 权限上界与实际计划分开验证。 */() => {
  const input = inputV2Schema.parse({ source: { kind: 'evaluation', runId: 'synthetic', content: '合成需求', hash: 'a'.repeat(64), evidence: 'evaluation-input' }, project });
  assert.deepEqual(registeredChecks(input), ['project:check', 'project:build', 'project:smoke']);
  const task = { id: 'one', role: 'frontend', paths: ['apps/web/app/recruitment/page.tsx'], dependsOn: [] };
  const plan: any = { summary: '只需前端任务', contracts: '合成接口', coverage: [], risks: [], blockers: [], tasks: [task] };
  assert.doesNotThrow(/** 允许开发团队只选择必要文件及单个角色。 */() => validateArchitecture(plan, input));
  for (const path of ['package.json', 'scripts/check.mjs', '../outside.ts']) assert.throws(/** 根外和检查配置不能借自动规划扩大权限。 */() => validateArchitecture({ ...plan, tasks: [{ ...task, paths: [path] }] }, input));
  assert.throws(/** 普通Node输入不能启用自动规划绕过旧边界。 */() => projectSchema.parse({ ...project, executionProfile: undefined }));
});

test('候选可新增批准源码文件，原配置只读，关闭后不可写', /** 不运行真实仓库，只核对独立候选I/O。 */async () => {
  const directory = mkdtempSync(resolve(tmpdir(), 'hrm-candidate-'));
  for (const [path, content] of Object.entries(project.files)) { const full = resolve(directory, path); mkdirSync(dirname(full), { recursive: true }); writeFileSync(full, content); }
  const execution = createDevelopmentExecution(directory, project);
  try {
    await execution.writeFile('apps/web/app/new/page.tsx', 'export const added=1;');
    assert.match(await execution.readFile('apps/web/app/new/page.tsx'), /added/);
    await assert.rejects(execution.writeFile('package.json', '{"scripts":{}}'));
    assert.equal(readFileSync(resolve(directory, 'package.json'), 'utf8'), '{}');
    await assert.rejects(execution.writeFile('scripts/escape.ts', 'bad'));
    await execution.close(); await assert.rejects(execution.writeFile('apps/web/app/page.tsx', 'bad'));
  } finally { await execution.close(); rmSync(directory, { recursive: true, force: true }); }
});

import { Mastra } from '@mastra/core';
import { createStudioApplicationOptions } from '../src/mastra/app.js';
import { createProductDevelopmentWorkflow } from '../src/mastra/workflows/product-development.js';
import { generateV2, type GeneratorV2 } from '../src/development/v2/agents.js';
import { readIntake, respondIntake } from '../src/intake/service.js';

test('主流程自动规划：新增文件与团队从架构任务派生，停在方案批准而不直接实施', /** 原生Workflow在独占候选内验证职责，无Docker或真实模型依赖。 */async () => {
  const directory = mkdtempSync(resolve(tmpdir(), 'hrm-auto-plan-'));
  const config = { rootDir: resolve('.'), mode: 'fixture' as const, modelId: 'openai/fixture' as const, port: 4111, databaseUrl: `file:${resolve(directory, 'workflow.db')}` };
  const app = createStudioApplicationOptions(config);
  /** 仅改变合成架构任务选择；其余职责、方法工具与持久化仍走正式链。 */
  const generate: GeneratorV2 = async (...args) => {
    const entry = await generateV2(...args);
    if (args[2] !== 'architect') return entry;
    const plan = JSON.parse(entry.text); plan.tasks = [{ ...plan.tasks[0], id: 'recruitment-page', role: 'frontend', paths: ['apps/web/app/recruitment/page.tsx'] }];
    return { ...entry, text: JSON.stringify(plan) };
  };
  const workflow = createProductDevelopmentWorkflow(app.agents as any, config, generate);
  new Mastra({ ...app, workflows: { productDevelopmentWorkflow: workflow } });
  try {
    const run = await workflow.createRun(); await run.start({ inputData: { brief: '合成新增招聘页面', iterationId: 'auto-plan' } });
    let current = await readIntake(workflow, run.runId);
    current = await respondIntake(workflow, 'fixture', run.runId, { role: 'product', artifactHash: current.product!.artifact.hash, decision: 'approve', reviewer: 'test', comment: '合成产品批准' });
    current = await respondIntake(workflow, 'fixture', run.runId, { gateHash: current.gate!.gateHash, data: { project, reviewer: 'test', comment: '确认项目，团队负责技术拆分', maxReworks: 1 } });
    assert.equal(current.status, 'suspended'); assert.equal(current.gate?.key, 'approve-architecture');
    assert.deepEqual(current.gate!.evidence.plan.tasks[0].paths, ['apps/web/app/recruitment/page.tsx']);
    assert.equal(current.gate!.evidence.team.members.length, 1); assert.equal(current.gate!.evidence.team.members[0].role, 'frontend');
    const snapshot = await workflow.getWorkflowRunById(run.runId); const pending = Object.values(snapshot!.steps!).find(/** 找到真正的架构暂停记录。 */(step: any) => step.status === 'suspended') as any;
    assert.equal(pending.payload.completedTasks.length, 0); assert.equal(pending.payload.reviews.length, 0);
  } finally { await app.storage.close(); rmSync(directory, { recursive: true, force: true }); }
});
