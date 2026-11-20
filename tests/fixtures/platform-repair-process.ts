/** 仅由跨进程回归调用。所有文件和凭据均为临时合成数据。 */
import { appendFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { Mastra } from '@mastra/core';
import { Hono, type Handler } from 'hono';
import { createStudioApplicationOptions } from '../../src/mastra/app.js';
import { type PracticeConfig } from '../../src/mastra/config.js';
import { createProductDevelopmentWorkflow } from '../../src/mastra/workflows/product-development.js';
import { createPlatformRecoveryRoutes } from '../../src/intake/platform-recovery.js';
import { readIntake, respondIntake } from '../../src/intake/service.js';
import { generateV2, type GeneratorV2 } from '../../src/development/v2/agents.js';
import { publishHandoff } from '../../src/delivery/remote-handoff.js';

const [directory, runId, command, event] = process.argv.slice(2);
const token = 'synthetic-platform-repair-token-12345';
const config: PracticeConfig = { rootDir: resolve('.'), mode: 'fixture', modelId: 'openai/fixture', port: 4111, databaseUrl: `file:${resolve(directory, 'workflow.db')}`, platformRepairToken: token };
/** 同一个交接请求可在另一个进程回查本地 bare 远端。 */
function publishEvidence() {
  return publishHandoff(resolve(directory, 'repository'), runId, { 'product/recovery.md': '合成研发恢复证据\n' });
}
/** 依赖修复前提供实际可分类错误。修复后记录一次候选副作用。 */
const generate: GeneratorV2 = async (...args) => {
  if (args[2] === 'architect') {
    if (!existsSync(resolve(directory, 'repaired'))) throw Object.assign(new Error('synthetic dependency failure'), { statusCode: 401 });
    await publishEvidence();
    appendFileSync(resolve(directory, 'side-effect'), 'architecture\n');
  }
  return generateV2(...args);
};
const app = createStudioApplicationOptions(config);
const workflow = createProductDevelopmentWorkflow(app.agents as any, config, generate);
new Mastra({ workflows: { productDevelopmentWorkflow: workflow }, storage: app.storage, logger: false });
const router = new Hono();
for (const route of createPlatformRecoveryRoutes(workflow, config)) if ('handler' in route) router.on(route.method, route.path, route.handler as Handler);
const path = `/platform-api/runs/${runId}/dependency-repair`;
const headers = { authorization: `Bearer ${token}`, 'content-type': 'application/json' };
try {
  await app.storage.init();
  if (command === 'start') {
    const run = await workflow.createRun({ runId });
    await run.start({ inputData: { brief: '合成依赖修复回归', intakeMode: 'autofill', iterationId: 'platform-repair-fixture' } });
    let current = await readIntake(workflow, runId);
    const actor = { reviewer: 'fixture', comment: '合成批准' };
    current = await respondIntake(workflow, 'fixture', runId, { ...actor, role: 'product', artifactHash: current.product!.artifact.hash, decision: 'approve' });
    current = await respondIntake(workflow, 'fixture', runId, { gateHash: current.gate!.gateHash, data: { ...actor, project: { id: 'synthetic', files: { 'src/a.mjs': 'export const a=0;', 'check.mjs': 'export const check=1;' }, writablePaths: ['src/a.mjs'], checkFiles: ['check.mjs'], roles: ['backend'] } } });
    const waiting = await router.request(path, { headers });
    console.log(JSON.stringify({ status: current.status, gate: current.gate?.key, waiting: (await waiting.json()).waiting, awaitingPlatform: current.technicalRecovery?.awaitingPlatform }));
  } else if (command === 'inspect') {
    const current = await readIntake(workflow, runId);
    console.log(JSON.stringify({ status: current.status, gate: current.gate?.key, recovery: current.technicalRecovery, metrics: current.recoveryMetrics }));
  } else if (command === 'recheck-git') {
    console.log(JSON.stringify(await publishEvidence()));
  } else {
    const response = await router.request(path, { method: 'POST', headers: command === 'unauthorized' ? { 'content-type': 'application/json' } : headers, body: event });
    console.log(JSON.stringify({ http: response.status, ...await response.json() }));
  }
} finally { await app.storage.close(); }
