import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

// 本地合成401响应覆盖真实SDK错误日志路径，禁止输出请求和响应中的敏感串。
test('真实SDK失败只保存脱敏分类，stdout和stderr均不暴露请求或响应详情', { timeout: 30000 }, async () => {
  const directory = mkdtempSync(resolve(tmpdir(), 'development-sdk-log-'));
  const root = fileURLToPath(new URL('..', import.meta.url));
  const code = `
    import {createServer} from 'node:http';
    import {seedDevelopment, openDevelopment, developmentStatus} from './src/development-service.ts';
    import {developmentHash} from './src/development/contracts.ts';
    // 合成服务只返回认证失败，不访问外网。
    const server = createServer((request,response) => { response.writeHead(401,{'content-type':'application/json'}); response.end(JSON.stringify({error:{message:'synthetic-private-response',type:'authentication_error'}})); });
    // 等待本地服务可接受请求。
    await new Promise((done) => server.listen(0,'127.0.0.1',done));
    const content='synthetic-private-request';
    const input={source:{kind:'evaluation',runId:'logging',hash:developmentHash(content),content,evidence:'evaluation-input'},project:{id:'logging',roles:['backend'],files:{'src/solution.mjs':'export const value=0;','smoke.test.mjs':'import {test} from "node:test"; test("noop",()=>{});'},writablePaths:['src/solution.mjs'],checkFiles:['smoke.test.mjs']},maxReworks:0};
    seedDevelopment(${JSON.stringify(resolve(directory, 'run'))},input);
    const app=openDevelopment({rootDir:process.cwd(),mode:'live',databaseUrl:'file:unused',port:4111,modelId:'openai/synthetic-model',apiKey:'synthetic-private-key',baseUrl:'http://127.0.0.1:'+server.address().port+'/v1'},${JSON.stringify(resolve(directory, 'run'))},true);
    try { await app.storage.init(); const run=await app.workflow.createRun(); const result=await run.start({inputData:app.input}); const status=await developmentStatus(app,run.runId); const pending=status.steps['development-iteration.recover-development']; console.log(JSON.stringify({status:result.status,kind:pending.payload.recovery.kind})); }
    finally { await app.execution.close(); await app.storage.close(); server.close(); }
  `;
  try {
    // 子进程隔离SDK日志，宿主不替换console或打印原始错误。
    const result = await new Promise<{ stdout: string; stderr: string }>((accept, reject) => {
      execFile(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', code], { cwd: root, timeout: 25000, env: { PATH: process.env.PATH, HOME: process.env.HOME, TMPDIR: tmpdir(), NODE_ENV: 'test' } },
        // 仅返回捕获输出，不在失败分支打印可能含敏感串的SDK异常。
        (error, stdout, stderr) => error ? reject(new Error('合成SDK子进程未完成')) : accept({ stdout, stderr }));
    });
    assert.equal(JSON.parse(result.stdout).status, 'suspended');
    assert.equal(JSON.parse(result.stdout).kind, 'model-error');
    assert.doesNotMatch(result.stdout + result.stderr, /synthetic-private|requestBodyValues|apiKey/);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
