/** 新版完整产研真实业务小切片；组织者按预登记规则推进，不冒充人工验收或远程发布。 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Mastra } from '@mastra/core';
import { readConfig } from '../src/mastra/config.js';
import { createStudioApplicationOptions } from '../src/mastra/app.js';
import { developmentHash } from '../src/development/contracts.js';
import { DevelopmentExecution } from '../src/development-execution.js';

const directory = process.argv[2] ? resolve(process.argv[2]) : resolve('.data/evaluations', `unified-${new Date().toISOString().replace(/[:.]/g, '-')}`);
mkdirSync(directory, { recursive: true });
const config = { ...readConfig(), mode: 'live' as const, databaseUrl: `file:${resolve(directory, 'workflow.db')}`, hrmRepositoryRoot: undefined };
if (!config.apiKey) throw new Error('真实评测缺少凭据；不回退fixture');
const brief = '实现受限Node ESM工单标题校验业务切片，不涉及界面、数据库和网络。src/title.mjs导出validateTitle(value)：非字符串返回{ok:false,error:"TYPE"}；字符串trim后按Unicode码点计数，1到80含边界返回{ok:true,title:去空白后的文本}，否则返回{ok:false,error:"LENGTH"}。src/view.mjs导出titleMessage(value)，调用validateTitle，成功返回title，TYPE返回"请输入文本"，LENGTH返回"标题须为1–80个字符"。不修改输入。只允许修改这两个文件，不安装依赖，不修改检查。所有需求已明确，不扩展HRM或React功能。';
const check = 'import {test} from "node:test";import assert from "node:assert/strict";import {validateTitle} from "./src/title.mjs";import {titleMessage} from "./src/view.mjs";test("public smoke",/** 执行固定业务断言。 */()=>{assert.deepEqual(validateTitle(" hi "),{ok:true,title:"hi"});assert.equal(titleMessage("hi"),"hi")});';
const project = { id: 'title-slice', files: { 'src/title.mjs': 'export const placeholder=0;', 'src/view.mjs': 'export const placeholder=0;', 'smoke.mjs': check }, writablePaths: ['src/title.mjs', 'src/view.mjs'], checkFiles: ['smoke.mjs'], roles: ['backend', 'frontend'] };
const actor = { reviewer: 'evaluation-policy', comment: '仅按固定合成需求推进隔离评测，人工质量评分待评，不授权发布' };
const options = createStudioApplicationOptions(config); new Mastra(options);
const record: any = process.argv[2] ? JSON.parse(readFileSync(resolve(directory, 'report.json'), 'utf8')) : { version: 'unified-evaluation.v1', mode: 'live', modelId: config.modelId, brief, project, inputHash: developmentHash({ brief, project }), authority: 'evaluation-policy', admission: null, humanReview: null, stages: [], result: null };
/** 每一步保留脱敏组织者记录，完整框架事实留在独立数据库。 */
function save() { writeFileSync(resolve(directory, 'report.json'), JSON.stringify(record, null, 2)); }
try {
  await options.storage.init(); const workflow = options.workflows.productDevelopmentWorkflow; const run = await workflow.createRun(record.runId ? {runId: record.runId} : undefined); record.runId = run.runId; save();
  const last = record.stages.at(-1);
  if (process.argv[2] && (last?.step !== 'recover-development' && !last?.payload?.recoveryState || record.recoveryAttempted)) throw new Error('没有可安全接续的首次故障');
  if (process.argv[2]) { record.recoveryAttempted = true; save(); }
  let result: any = process.argv[2]
    ? await run.resume({ step: ['development-team', ...last.payload.__workflow_meta.path], resumeData: { ...actor, hash: last.payload.hash, decision: 'retry' } })
    : await run.start({ inputData: { brief, iterationId: 'title-evaluation' } });
  for (let count = 0; result.status === 'suspended' && count < 10; count++) {
    const path: string[] = result.suspended[0]; const id = path.at(-1)!; const p = result.steps[path[0]].suspendPayload;
    record.stages.push({ step: id, payload: p }); save(); console.log(JSON.stringify({ step: id, runId: run.runId }));
    let data: any;
    if (id === 'review-product') data = { ...actor, role: 'product', artifactHash: p.artifact.hash, decision: 'approve' };
    else if (id === 'confirm-project-scope') data = { ...actor, project, maxReworks: 1 };
    else if (id === 'approve-architecture') data = { ...actor, hash: p.hash, decision: 'approve' };
    else if (id === 'approve-test-cases') data = { ...actor, hash: p.plan.hash, decision: 'approve', cases: [{ id: 'public-smoke', requirementRefs: p.requirements.map(/** 固定评测保存全部需求锚点。 */(r: any) => r.id), expected: '公开普通输入通过；完整行为由独立judge验证', method: 'registered-check', checkRefs: p.registeredChecks }] };
    else if (id === 'review-test-results') data = { ...actor, hash: p.hash, decision: 'pass', manualResults: [], findings: [] };
    else { record.stoppedAt = id; break; }
    result = await run.resume({ step: path, resumeData: data });
  }
  record.status = result.status;
  record.businessOutcome = result.status === 'success' ? result.result?.outcome : null;
  // 从生命周期输出或暂停输入取得研发交付；不向被评Agent透露额外断言。
  const snapshot: any = await workflow.getWorkflowRunById(run.runId);
  const lifecycle = snapshot.steps?.['initialize-delivery-lifecycle']?.output;
  if (lifecycle?.development?.delivery) {
    const files = lifecycle.development.delivery.files;
    const judge = resolve(directory, 'judge'); mkdirSync(resolve(judge, 'src'), { recursive: true });
    for (const path of project.writablePaths) writeFileSync(resolve(judge, path), files[path]);
    const oracle = 'import {test} from "node:test";import assert from "node:assert/strict";import {validateTitle as v} from "./src/title.mjs";import {titleMessage as m} from "./src/view.mjs";test("independent behavior",/** 独立检查类型、长度、Unicode及提示文本。 */()=>{for(const x of [null,1,{},[],undefined])assert.deepEqual(v(x),{ok:false,error:"TYPE"});for(const x of ["","  ","x".repeat(81)])assert.deepEqual(v(x),{ok:false,error:"LENGTH"});for(const x of ["a","x".repeat(80),"😀".repeat(80)," hi "])assert.deepEqual(v(x),{ok:true,title:x.trim()});assert.equal(m(null),"请输入文本");assert.equal(m(" "),"标题须为1–80个字符");assert.equal(m(" ok "),"ok")});';
    writeFileSync(resolve(judge, 'acceptance.mjs'), oracle);
    const execution = new DevelopmentExecution(judge, project.writablePaths, ['acceptance.mjs']);
    try { record.independentChecks = await execution.runChecks(); } finally { await execution.close(); }
    record.development = lifecycle.development;
  }
  record.result = result.status === 'success' ? result.result : null;
  save(); console.log(JSON.stringify({ directory, runId: record.runId, status: record.status, businessOutcome: record.businessOutcome, stoppedAt: record.stoppedAt, independentPassed: record.independentChecks?.every(/** 所有真实检查均成功才标记行为通过。 */(c: any) => c.exitCode === 0), humanReview: null }));
} catch { record.error = '评测执行失败；排查独立运行库，未保存原始远程异常'; save(); process.exitCode = 1; }
finally { await options.storage.close(); }
