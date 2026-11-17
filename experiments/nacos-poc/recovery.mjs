/** 验证冻结内容跨独立 Node 进程恢复；不代表主流程已接入。 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { Mastra } from '@mastra/core';
import { createStep, createWorkflow } from '@mastra/core/workflows';
import { LibSQLStore } from '@mastra/libsql';
import { z } from 'zod';

const phase = process.argv[2];
if (!phase) {
  const directory = mkdtempSync(join(tmpdir(), 'mastra-resource-poc-'));
  const script = fileURLToPath(import.meta.url);
  for (const operation of ['start', 'resume']) {
    execFileSync(process.execPath, [script, operation, directory], { stdio: 'inherit' });
  }
  console.log('PASS: 独立进程恢复旧 Run v1，新 Run 采用 v2');
  console.log(`临时数据库：${directory}`);
} else {
  const url = `file:${join(process.argv[3], 'workflow.db')}`;
  const schema = z.object({ version: z.string(), content: z.string(), hash: z.string() });
  let reads = 0;
  /** 模拟当前资源，恢复进程的源版本已经更新。 */
  function resource() {
    reads++;
    const value = phase === 'start' ? 'prompt-v1' : 'prompt-v2';
    return { version: value, content: value, hash: createHash('sha256').update(value).digest('hex') };
  }
  const initial = createStep({ id: 'freeze', inputSchema: z.object({}), outputSchema: schema,
    /** 将资源正文保存为 Workflow 事实。 */
    execute: async () => resource() });
  const gate = createStep({ id: 'gate', inputSchema: schema, outputSchema: schema, resumeSchema: z.object({ approved: z.boolean() }), suspendSchema: z.object({ waiting: z.boolean() }),
    /** 恢复后传递已有冻结内容。 */
    execute: async ({ inputData, resumeData, suspend }) => !resumeData ? suspend({ waiting: true }) : inputData });
  const flow = createWorkflow({ id: 'resource-poc', inputSchema: z.object({}), outputSchema: schema }).then(initial).then(gate).commit();
  const storage = new LibSQLStore({ id: 'resource-poc-store', url });
  new Mastra({ workflows: { flow }, storage, logger: false });
  if (phase === 'start') {
    const run = await flow.createRun({ runId: 'old-run' });
    const result = await run.start({ inputData: {} });
    assert.equal(result.status, 'suspended');
    assert.equal(reads, 1);
  } else {
    const run = await flow.createRun({ runId: 'old-run' });
    const result = await run.resume({ resumeData: { approved: true } });
    assert.equal(result.status, 'success');
    assert.equal(result.result.content, 'prompt-v1');
    assert.equal(reads, 0);
    const next = await flow.createRun({ runId: 'new-run' });
    assert.equal((await next.start({ inputData: {} })).status, 'suspended');
    assert.equal((await next.resume({ resumeData: { approved: true } })).result.content, 'prompt-v2');
  }
  await storage.close();
}
