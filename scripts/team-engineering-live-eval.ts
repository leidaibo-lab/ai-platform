/** 对冻结团队方法执行隔离真实研发 Workflow 与浏览器 QA 评测。 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Mastra } from '@mastra/core';
import { LibSQLStore } from '@mastra/libsql';
import { readConfig } from '../src/mastra/config.js';
import { loadNacosSnapshot } from '../src/mastra/nacos-resources.js';
import { assertCompleteMethods } from '../src/mastra/team-methods.js';
import { executeBrowserAgent } from '../src/browser-qa/agent.js';
import { developmentHash } from '../src/development/contracts.js';
import { inputV2Schema } from '../src/development/v2/contracts.js';
import { seedDevelopment } from '../src/development-service.js';
import { DevelopmentExecution } from '../src/development-execution.js';
import { createDevelopmentWorkflowV2 } from '../src/mastra/workflows/development-v2.js';

const directory = resolve('.data/evaluations', `team-engineering-live-${new Date().toISOString().replaceAll(/[:.]/g, '-')}`);
mkdirSync(directory, { recursive: false, mode: 0o700 });
process.env.MASTRA_MODE = 'live'; process.env.MASTRA_DATA_DIR = directory; process.env.NACOS_TEAM_METHOD_VERSION = '1.0.0';
const config = readConfig();
if (!config.nacosResources || config.engineeringProject || config.engineeringProjects || config.hrmRepositoryRoot) throw new Error('评测需要隔离的未登记工程配置');
const snapshot = await loadNacosSnapshot(config.nacosResources);
if (!snapshot.methods) throw new Error('缺少冻结团队方法');
const methods = assertCompleteMethods(snapshot.methods);
const report: any = { version: 'team-engineering-live.v1', startedAt: new Date().toISOString(), catalogHash: methods.sha256, status: 'running', browser: null, development: null };
/** 保存可审阅的真实回执，不输出凭据或原始错误。 */
function save() { writeFileSync(resolve(directory, 'report.json'), JSON.stringify(report, null, 2) + '\n', { mode: 0o600 }); }
save();
const browserFiles = { 'index.html': '<!doctype html><html><body><h1 id="title">合成工单</h1><button id="save" onclick="document.querySelector(\'#result\').textContent=\'已保存\'">保存</button><p id="result">待处理</p></body></html>' };
const browserCase = { entry: 'index.html', assets: [], actions: [{ action: 'click' as const, selector: '#save', value: '' }], assertions: [{ selector: '#result', text: '已保存' }] };
/** 浏览器使用固定批准用例和真实 Chromium，模型不能更改动作。 */
async function browser() {
  try {
    const result = await executeBrowserAgent(config, [{ caseId: 'synthetic-save', caseHash: developmentHash(browserCase), sourceHash: developmentHash(browserFiles), methodHash: methods.sha256, browser: browserCase, files: browserFiles, supported: true }], methods);
    report.browser = result; save(); console.log(JSON.stringify({ stage: 'browser', statuses: result.receipts.map(receipt => receipt.status), tools: result.tools }));
  } catch { report.browser = { status: 'failed', reason: '浏览器评测未完成' }; save(); }
}
/** 使用真实模型、固定测试和显式评测自动批准；结果不是人工业务验收。 */
async function development() {
  const content = '实现标题校验：导出 validateTitle(value)，非字符串返回 {ok:false,error:"TYPE"}；字符串 trim 后按 Unicode 码点计数，1 到 80 返回 {ok:true,title:处理后的字符串}，否则返回 {ok:false,error:"LENGTH"}。只修改 src/title.mjs，不依赖网络。';
  const check = 'import {test} from "node:test";import assert from "node:assert/strict";import {validateTitle} from "./src/title.mjs";test("fixed behavior",()=>{for(const value of [null,undefined,1,true,{},[]])assert.deepEqual(validateTitle(value),{ok:false,error:"TYPE"});for(const value of ["","  ","x".repeat(81),"😀".repeat(81)])assert.deepEqual(validateTitle(value),{ok:false,error:"LENGTH"});for(const [value,title] of [[" a ","a"],[" hello ","hello"],["x".repeat(80),"x".repeat(80)],["😀".repeat(80),"😀".repeat(80)],["e\u0301","e\u0301"]])assert.deepEqual(validateTitle(value),{ok:true,title});});';
  const input = inputV2Schema.parse({ teamMethods: methods, source: { kind: 'evaluation', runId: 'team-engineering-live', hash: developmentHash(content), content, evidence: 'evaluation-input' }, project: { id: 'team-live-eval', files: { 'src/title.mjs': 'export const placeholder = 0;\n', 'check.mjs': check }, writablePaths: ['src/title.mjs'], checkFiles: ['check.mjs'], roles: ['backend'] }, maxReworks: 1 });
  const runDirectory = resolve(directory, 'development'); seedDevelopment(runDirectory, input);
  const execution = new DevelopmentExecution(resolve(runDirectory, 'candidate'), input.project.writablePaths, input.project.checkFiles);
  const store = new LibSQLStore({ id: 'team-engineering-live', url: `file:${resolve(directory, 'development.db')}` });
  const workflow = createDevelopmentWorkflowV2(config, execution, true, undefined, { team: true });
  new Mastra({ storage: store, workflows: { workflow }, logger: false });
  try {
    await store.init(); const run = await workflow.createRun(); report.development = { runId: run.runId, status: 'running' }; save();
    const result = await run.start({ inputData: input });
    report.development = { runId: run.runId, status: result.status, result: result.status === 'success' ? result.result : null, suspended: result.status === 'suspended' ? result.suspended : undefined };
    save(); console.log(JSON.stringify({ stage: 'development', status: result.status, outcome: result.status === 'success' ? result.result?.outcome : undefined }));
  } catch { report.development = { ...report.development, status: 'failed', reason: '研发评测未完成' }; save(); }
  finally { await execution.close(); await store.close(); }
}
await Promise.all([browser(), development()]);
report.status = 'finished'; report.endedAt = new Date().toISOString(); save();
console.log(JSON.stringify({ directory, status: report.status }));
