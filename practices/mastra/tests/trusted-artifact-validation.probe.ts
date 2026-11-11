/** 信任边界实验：签名公钥由宿主固定；Run 只存摘要，不允许由 Run 提供信任根。 */
import assert from 'node:assert/strict';
import { generateKeyPairSync, sign, verify } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { test } from 'node:test';
import { Mastra } from '@mastra/core/mastra';
import { createStep, createWorkflow } from '@mastra/core/workflows';
import { LibSQLStore } from '@mastra/libsql';
import { z } from 'zod';
import { sha } from './stored-role-probe-helpers.js';

for (const fault of ['none', 'code', 'configuration', 'signed-new-release', 'untrusted-signer', 'role-source', 'dependency-lock'] as const) {
  test(`可信制品恢复前拒绝：${fault}`, /** 覆盖签名、Run 摘要、配置、宿主源码和依赖锁，不将标签等同实现。 */ async () => {
    const dir = mkdtempSync(resolve(tmpdir(), 'trusted-artifact-'));
    const { publicKey, privateKey } = generateKeyPairSync('ed25519');
    const untrusted = generateKeyPairSync('ed25519');
    const roleBytes = readFileSync(resolve('src/development/v2/agents.ts'));
    const lockBytes = readFileSync(resolve('package-lock.json'));
    const roleFile = resolve(dir, 'agents.ts'); const lockFile = resolve(dir, 'package-lock.json');
    writeFileSync(roleFile, roleBytes); writeFileSync(lockFile, lockBytes);
    const artifact = resolve(dir, 'enhancement.json'); const signature = resolve(dir, 'enhancement.sig');
    const payload = { version: 'enhancement.v1', implementation: '/** 返回固定增强结果，禁止导入可变依赖。 */ export function execute(config) { return config.marker; }', configuration: { marker: 'old-enhancement' }, roleHash: sha(roleBytes), lockHash: sha(lockBytes) };
    const bytes = JSON.stringify(payload); const pinned = sha(bytes);
    writeFileSync(artifact, bytes); writeFileSync(signature, sign(null, Buffer.from(bytes), privateKey));
    let invocations = 0;
    /** 重建宿主后从磁盘读取制品；验签通过前不 import，执行仅使用已核验字节。 */
    async function open() {
      const storage = new LibSQLStore({ id: 'trusted-artifact', url: `file:${resolve(dir, 'run.db')}` });
      const schema = z.object({ artifactDigest: z.string() }); const output = z.object({ result: z.string() });
      const step = createStep({ id: 'verify-artifact', inputSchema: schema, outputSchema: output, suspendSchema: schema, resumeSchema: z.object({ proceed: z.boolean() }),
        /** 签名认证来源，Run 摘要绑定旧版，宿主文件约束剩余实现；全部通过后才调用工具。 */
        execute: async ({ inputData, resumeData, suspend }) => {
          if (!resumeData) return suspend(inputData);
          const actual = readFileSync(artifact);
          assert.ok(verify(null, actual, publicKey, readFileSync(signature)), '制品签名不可信');
          assert.equal(sha(actual), inputData.artifactDigest, '制品与Run绑定不一致');
          const parsed = JSON.parse(actual.toString());
          assert.equal(sha(readFileSync(roleFile)), parsed.roleHash, '宿主角色实现漂移');
          assert.equal(sha(readFileSync(lockFile)), parsed.lockHash, '依赖锁漂移');
          const module = await import(`data:text/javascript;base64,${Buffer.from(parsed.implementation).toString('base64')}`);
          invocations++;
          return { result: module.execute(parsed.configuration) };
        },
      });
      const workflow = createWorkflow({ id: 'trusted-artifact', inputSchema: schema, outputSchema: output }).then(step).commit();
      new Mastra({ storage, workflows: { workflow } }); await storage.init();
      return { storage, workflow };
    }
    let app = await open();
    try {
      let run = await app.workflow.createRun(); const runId = run.runId;
      assert.equal((await run.start({ inputData: { artifactDigest: pinned } })).status, 'suspended');
      await app.storage.close();
      if (fault === 'code' || fault === 'signed-new-release') payload.implementation += '\n// changed implementation';
      if (fault === 'configuration') payload.configuration.marker = 'new-enhancement';
      if (['code', 'configuration', 'signed-new-release'].includes(fault)) writeFileSync(artifact, JSON.stringify(payload));
      if (fault === 'signed-new-release') writeFileSync(signature, sign(null, readFileSync(artifact), privateKey));
      if (fault === 'untrusted-signer') writeFileSync(signature, sign(null, readFileSync(artifact), untrusted.privateKey));
      if (fault === 'role-source') writeFileSync(roleFile, '// same role ID, replaced implementation');
      if (fault === 'dependency-lock') writeFileSync(lockFile, '{}');
      app = await open(); run = await app.workflow.createRun({ runId });
      const result: any = await run.resume({ step: 'verify-artifact', resumeData: { proceed: true } });
      assert.equal(result.status, fault === 'none' ? 'success' : 'failed');
      assert.equal(invocations, fault === 'none' ? 1 : 0);
      if (fault === 'none') assert.equal(result.result.result, 'old-enhancement');
    } finally { await app.storage.close(); rmSync(dir, { recursive: true, force: true }); }
  });
}
