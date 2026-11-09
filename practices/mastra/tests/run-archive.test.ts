/** 原生生命周期回归，不调用模型或业务远端。 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, realpathSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Mastra } from '@mastra/core';
import { createStep, createWorkflow } from '@mastra/core/workflows';
import { LibSQLStore } from '@mastra/libsql';
import { z } from 'zod';
import type { PracticeConfig } from '../src/mastra/config.js';
import { recordRunArchive, runArchiveLifecycle, runArchiveSchema, withRunArchive } from '../src/delivery/run-archive.js';
import { registerAssetRun } from '../src/delivery/asset-catalog.js';
/** 创建本地授权目录，不执行网络请求。 */
function fixture() {
 const directory = realpathSync(mkdtempSync(join(tmpdir(), 'run-archive-'))); const root = join(directory, 'repo');
 execFileSync('git', ['init', '-b', 'main', root], {stdio:'ignore'});
 /** Git只操作临时目录。 */
 function git(args: string[]) { return execFileSync('git', ['-C',root,...args], {encoding:'utf8',stdio:['ignore','pipe','pipe']}).trim(); }
 git(['config','user.name','fixture']); git(['config','user.email','fixture@local.invalid']);
 writeFileSync(join(root,'README.md'),'baseline'); git(['add','.']); git(['commit','-m','test(workflow): 基线']); git(['remote','add','origin','https://github.com/leidaibo-lab/hrm.git']);
 const config: PracticeConfig = {rootDir:root,hrmRepositoryRoot:root,mode:'fixture',modelId:'openai/fixture',databaseUrl:'file:'+join(directory,'workflow.db'),port:4111};
 /** 回读磁盘验证公开schema。 */
 function history(runId: string) { const folder=join(root,'product/catalog/runs',runId,'history'); return readdirSync(folder).map(/** 读取不可变事件。 */name=>runArchiveSchema.parse(JSON.parse(readFileSync(join(folder,name),'utf8')))); }
 return {directory,root,config,git,history};
}
for (const fail of [false,true]) {
 test('原生开始暂停恢复与终态 '+fail, /** 框架实际调用Hook。 */async()=>{
 const f=fixture(); const input=z.object({brief:z.string(),iterationId:z.string()});
 const step=createStep({id:'review-product',inputSchema:input,outputSchema:input,resumeSchema:z.object({approved:z.boolean()}),suspendSchema:z.object({waiting:z.boolean()}),
 /** 模拟敏感错误不得进入档案。 */
 execute:async({inputData,resumeData,suspend})=>{if(!resumeData)return suspend({waiting:true});if(fail)throw new Error('secret-upstream-key');return inputData;}});
 const flow=createWorkflow({id:'product-development',inputSchema:input,outputSchema:input,options:runArchiveLifecycle(f.config)}).then(withRunArchive(step,f.config)).commit();
 const storage=new LibSQLStore({id:'archive-test',url:f.config.databaseUrl}); new Mastra({workflows:{flow},storage,logger:false});
 try {await storage.init();const run=await flow.createRun({runId:'native-run'});const paused=await run.start({inputData:{brief:'private-business-text',iterationId:'iter'}});assert.equal(paused.status,'suspended');
 assert.ok(f.history(run.runId).some(/** 根Run暂停单独记录。 */e=>e.scope==='run'&&e.status==='suspended'));
 const result=await run.resume({resumeData:{approved:true}});assert.equal(result.status,fail?'failed':'success');const history=f.history(run.runId);
 assert.ok(history.some(/** 根状态以原生结果为准。 */e=>e.scope==='run'&&e.status===result.status));
 assert.ok(history.some(/** 阶段返回不能宣称全Run成功。 */e=>e.scope==='step'&&e.status===(fail?'failed':'returned')));
 for(const e of history){assert.equal(e.iterationId,'iter');assert.equal(e.recovery.portable,false);}
 assert.ok(!JSON.stringify(history).includes('secret-upstream'));assert.ok(!JSON.stringify(history).includes('private-business-text'));
 }finally{await storage.close();rmSync(f.directory,{recursive:true,force:true});}
 });
}
test('推送失败后本地保留且下一次补推所有记录', /** publisher注入避免触及业务远端。 */async()=>{
 const f=fixture();const config={...f.config,mode:'live' as const};
 registerAssetRun(f.root,{projectId:'hrm',iterationId:'iter',runId:'retry-run',workflowId:'productDevelopmentWorkflow'},'brief');
 try{
 await assert.rejects(/** 先落盘再触发故障。 */()=>recordRunArchive(config,{runId:'retry-run',scope:'run',status:'failed',value:{apiKey:'never-export'}},/** 模拟网络故障。 */async()=>{throw new Error('offline');}));
 assert.equal(f.history('retry-run').length,1);let count=0;
 await recordRunArchive(config,{runId:'retry-run',scope:'run',status:'suspended'},/** 核对积压集合。 */async(_root,runId,files)=>{count=Object.keys(files).filter(/** 只计历史事件。 */p=>p.includes('/history/')).length;return {version:'remote-handoff.v1',branch:'codex/workflow/'+runId,commit:'a'.repeat(40),files:{}};});
 assert.equal(count,2);assert.ok(!JSON.stringify(f.history('retry-run')).includes('never-export'));
 await assert.rejects(/** 拒绝路径注入。 */()=>recordRunArchive(config,{runId:'../escape',scope:'run',status:'running'}));
 }finally{rmSync(f.directory,{recursive:true,force:true});}
});


import { createStudioApplicationOptions } from '../src/mastra/app.js';
test('实际产研入口自动归档角色阶段与根暂停', /** 使用真实fixture主链，确认嵌套步骤归属。 */async () => {
  const f = fixture();
  const options = createStudioApplicationOptions({ ...f.config, rootDir: process.cwd() });
  new Mastra({ ...options, logger: false });
  try {
    await options.storage.init();
    const run = await options.workflows.productDevelopmentWorkflow.createRun({ runId: 'main-run' });
    const result = await run.start({ inputData: { brief: '合成需求', iterationId: 'actual-main' } });
    assert.equal(result.status, 'suspended');
    const history = f.history(run.runId);
    assert.ok(history.some(/** 四角色实际返回应留下阶段记录。 */e => e.scope === 'step' && e.stage === 'product-writing'));
    assert.ok(history.some(/** 产品审批暂停必须明确记录。 */e => e.scope === 'run' && e.status === 'suspended'));
    assert.ok(history.every(/** 嵌套Workflow不得另建根Run档案。 */e => e.runId === 'main-run' && e.iterationId === 'actual-main'));
  } finally { await options.storage.close(); rmSync(f.directory, { recursive: true, force: true }); }
});
test('档案写入失败不覆盖业务成功或原异常', /** 直接调用装饰步骤验证finally隔离。 */async () => {
  const f = fixture();
  const config = { ...f.config, hrmRepositoryRoot: join(f.root, 'missing') };
  try {
    const step = createStep({ id: 'fixture', inputSchema: z.string(), outputSchema: z.string(),
      /** 模拟确定性业务结果。 */execute: async ({ inputData }) => inputData });
    const wrapped = withRunArchive(step, config);
    assert.equal(await wrapped.execute({ inputData: 'retained', runId: 'one' } as any), 'retained');
    const failure = new Error('original business failure');
    const failed = withRunArchive(createStep({ id: 'failed', inputSchema: z.string(), outputSchema: z.string(),
      /** 模拟原业务故障。 */execute: async () => { throw failure; } }), config);
    await assert.rejects(/** 归档失败不能替换原异常对象。 */() => failed.execute({ inputData: 'x', runId: 'two' } as any), failure);
  } finally { rmSync(f.directory, { recursive: true, force: true }); }
});
