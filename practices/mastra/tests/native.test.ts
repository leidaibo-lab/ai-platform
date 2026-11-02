import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { test } from 'node:test';
import { createApplication, type PracticeApplication } from '../src/mastra/app.js';
import { startDelivery, reviewDelivery, deliveryStatus } from '../src/delivery-service.js';
import { stages } from '../src/mastra/workflows/delivery.js';

/** 每个测试使用独立原生 LibSQL，执行完关闭连接并删除临时数据。 */
async function withApplication(check: (app: PracticeApplication) => Promise<void>) {
  const dir = mkdtempSync(resolve(tmpdir(), 'mastra-native-'));
  const app = createApplication({ mode: 'fixture', databaseUrl: `file:${resolve(dir, 'test.db')}`, port: 4111, modelId: 'openai/gpt-4o-mini' });
  try {
    await app.storage.init();
    await check(app);
  } finally {
    await app.storage.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

/** 从当前暂停点构造明确绑定版本的本地确认输入。 */
function approve(status: Awaited<ReturnType<typeof deliveryStatus>>) {
  assert.ok(status.pending);
  return { role: status.pending.role, artifactHash: status.pending.artifact.hash, decision: 'approve', reviewer: `local-${status.pending.role}`, comment: '本地样例审阅，不代表代码或部署执行通过' };
}

// 通过正式注册入口驱动真实 Mastra 工具循环，而非直接调用工具函数。
test('原生 Agent 真正执行只读工具后返回终答', async () => {
  // 在隔离应用内核对工具事实和最终回复。
  await withApplication(async (app) => {
    const result = await app.mastra.getAgent('minimalAgent').generate('读取实践范围', { maxSteps: 3 });
    assert.match(result.text, /fixture/);
    assert.equal(result.toolResults.length, 1);
    assert.deepEqual(result.toolResults[0].payload.result, { framework: 'Mastra', scope: '独立原生应用与产研交接学习', deploymentExecuted: false });
  });
});

// 四次确认分别放行下一阶段，终态仅表示方案确认。
test('四阶段交接按顺序暂停，全部确认才输出 plan-approved', async () => {
  // 检查每个持久暂停点及最终四份交接物、四份审批记录。
  await withApplication(async (app) => {
    let status = await startDelivery(app, '工单标题去首尾空格后为 1–80 字符');
    for (const stage of stages) {
      assert.equal(status.status, 'suspended');
      assert.equal(status.mode, 'fixture');
      assert.equal(status.pending?.role, stage);
      assert.equal(status.pending?.artifact.evidence, 'fixture');
      status = await reviewDelivery(app, status.runId, approve(status));
    }
    assert.equal(status.status, 'success');
    assert.equal(status.result?.outcome, 'plan-approved');
    assert.equal(status.result?.artifacts.length, 4);
    assert.equal(status.result?.reviews.length, 4);
    await assert.rejects(reviewDelivery(app, status.runId, { role: 'operations' }), /没有待审批/);
  });
});

// 无效输入必须在 resume 之前拒绝，保留原暂停快照。
test('错误角色、旧内容版本和空审阅人均不会消耗审批点', async () => {
  // 先尝试错误确认，再用当前版本确认，核对旧确认不能推进新阶段。
  await withApplication(async (app) => {
    const initial = await startDelivery(app, '标题校验');
    const valid = approve(initial);
    await assert.rejects(reviewDelivery(app, initial.runId, { ...valid, role: 'testing' }), /角色/);
    await assert.rejects(reviewDelivery(app, initial.runId, { ...valid, artifactHash: '0'.repeat(64) }), /版本/);
    await assert.rejects(reviewDelivery(app, initial.runId, { ...valid, reviewer: ' ' }));
    assert.equal((await deliveryStatus(app, initial.runId)).pending?.artifact.hash, valid.artifactHash);
    const next = await reviewDelivery(app, initial.runId, valid);
    assert.equal(next.pending?.role, 'development');
    await assert.rejects(reviewDelivery(app, initial.runId, valid), /角色|版本/);
    assert.equal((await deliveryStatus(app, initial.runId)).pending?.role, 'development');
  });
});

// 业务拒绝通过原生 bail 结束，不能把框架完成状态解释为业务批准。
test('产品拒绝后没有开发生成，拒绝记录保留且禁止重复确认', async () => {
  // 对终态、生成节点和审批内容分别核对。
  await withApplication(async (app) => {
    const initial = await startDelivery(app, '标题校验');
    const rejected = await reviewDelivery(app, initial.runId, { ...approve(initial), decision: 'reject', comment: '验收条件需要补充' });
    assert.equal(rejected.result?.outcome, 'rejected');
    assert.equal(rejected.result?.artifacts.length, 1);
    assert.equal(rejected.result?.reviews[0].decision, 'reject');
    const snapshot = await app.deliveryWorkflow.getWorkflowRunById(initial.runId);
    assert.equal(snapshot?.steps?.['draft-development'], undefined);
    await assert.rejects(reviewDelivery(app, initial.runId, approve(initial)), /没有待审批/);
  });
});

// 直接调用框架 API 也必须守住审批版本，错误会成为 failed，CLI 预校验可避免此损耗。
test('原生 resume 绕过 CLI 时，错误版本仍无法进入开发', async () => {
  // 不经业务服务预校验，直接测试 Workflow 内的最终防线。
  await withApplication(async (app) => {
    const initial = await startDelivery(app, '标题校验');
    const run = await app.deliveryWorkflow.createRun({ runId: initial.runId });
    const result = await run.resume({ step: 'review-product', resumeData: { ...approve(initial), artifactHash: '0'.repeat(64) } });
    assert.equal(result.status, 'failed');
    const snapshot = await app.deliveryWorkflow.getWorkflowRunById(initial.runId);
    assert.equal(snapshot?.steps?.['draft-development'], undefined);
  });
});

// Studio 使用流式接口，须与脚本的非流式工具循环行为一致。
test('原生 stream 同样完成工具执行和终答', async () => {
  // 消费完整流后读取结果，防止仅接口存在却无法实际聊天。
  await withApplication(async (app) => {
    const result = await app.mastra.getAgent('minimalAgent').stream('读取实践范围', { maxSteps: 3 });
    await result.consumeStream();
    assert.match(await result.text, /fixture/);
    assert.equal((await result.toolResults).length, 1);
  });
});

// 启动前校验失败不应生成半成品 Run 或调用 Agent。
test('空需求拒绝，未知 Run 返回可识别错误', async () => {
  // 核对无效输入和缺失资源两种边界。
  await withApplication(async (app) => {
    await assert.rejects(startDelivery(app, ' '));
    await assert.rejects(deliveryStatus(app, 'missing'), /找不到/);
  });
});

// 每次命令都启动新 OS 进程，证明暂停状态不依赖原进程内对象。
test('原进程退出后从 LibSQL 恢复，模式变化被拒绝', { timeout: 30000 }, async () => {
  const dir = mkdtempSync(resolve(tmpdir(), 'mastra-process-'));
  /** 使用当前 Node 运行独立 CLI；fixture 显式隔离配置与数据目录。 */
  function cli(args: string[]) {
    return JSON.parse(execFileSync(process.execPath, ['--import', 'tsx', 'scripts/delivery.ts', ...args], {
      cwd: process.cwd(), env: { ...process.env, MASTRA_MODE: 'fixture', MASTRA_DATA_DIR: dir }, encoding: 'utf8', timeout: 15000,
    }));
  }
  try {
    const started = cli(['start', '跨进程标题校验']);
    const resumedStatus = cli(['status', started.runId]);
    assert.equal(resumedStatus.pending.artifact.hash, started.pending.artifact.hash);
    const reviewed = cli(['review', started.runId, 'product', started.pending.artifact.hash, 'approve', 'local-product', '确认固定样例']);
    assert.equal(reviewed.pending.role, 'development');
    const app = createApplication({ mode: 'live', databaseUrl: `file:${resolve(dir, 'mastra.db')}`, port: 4111, modelId: 'openai/gpt-4o-mini', apiKey: 'unused-test-value' });
    try {
      await app.storage.init();
      await assert.rejects(reviewDelivery(app, started.runId, approve(reviewed)), /模式/);
      assert.equal((await deliveryStatus(app, started.runId)).pending?.role, 'development');
    } finally {
      await app.storage.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
