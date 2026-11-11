/** 隔离实验：固定制品摘要检测替换，不代表正式部署制品可信。 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { test } from 'node:test';
import { Mastra } from '@mastra/core/mastra';
import { createStep, createWorkflow } from '@mastra/core/workflows';
import { LibSQLStore } from '@mastra/libsql';
import { z } from 'zod';

/** 计算实验制品的字节摘要；不覆盖依赖和构建环境。 */
function digest(path: string) { return createHash('sha256').update(readFileSync(path)).digest('hex'); }

for (const changed of [false, true]) {
  test(`暂停恢复校验制品摘要：${changed ? '字节变化拒绝' : '字节不变继续'}`, async () => {
    const dir = mkdtempSync(resolve(tmpdir(), 'mastra-artifact-drift-'));
    const artifact = resolve(dir, 'tool.js');
    writeFileSync(artifact, 'tool v1');
    const expected = digest(artifact);
    let invocations = 0;
    /** 每次打开应用都以当前文件作为待校验制品。 */
    async function open() {
      const schema = z.object({ artifactHash: z.string() });
      const step = createStep({ id: 'verify', inputSchema: schema, suspendSchema: schema, resumeSchema: z.object({ go: z.boolean() }), outputSchema: z.object({ done: z.boolean() }),
        execute: async ({ inputData, resumeData, suspend }) => {
          if (!resumeData) return suspend(inputData);
          if (digest(artifact) !== inputData.artifactHash) throw new Error('制品摘要不一致');
          invocations++;
          return { done: true };
        } });
      const workflow = createWorkflow({ id: 'artifact-probe', inputSchema: schema, outputSchema: z.object({ done: z.boolean() }) }).then(step).commit();
      const storage = new LibSQLStore({ id: 'artifact-probe', url: `file:${resolve(dir, 'run.db')}` });
      new Mastra({ storage, workflows: { workflow } });
      await storage.init();
      return { workflow, storage };
    }
    let app = await open();
    try {
      let run = await app.workflow.createRun();
      const runId = run.runId;
      assert.equal((await run.start({ inputData: { artifactHash: expected } })).status, 'suspended');
      await app.storage.close();
      if (changed) writeFileSync(artifact, 'tool v2');
      app = await open();
      run = await app.workflow.createRun({ runId });
      const result = await run.resume({ step: 'verify', resumeData: { go: true } });
      assert.equal(result.status, changed ? 'failed' : 'success');
      assert.equal(invocations, changed ? 0 : 1);
    } finally {
      await app.storage.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
}
