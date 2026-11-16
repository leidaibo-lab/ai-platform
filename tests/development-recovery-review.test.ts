/** 独立审阅发现的恢复与来源门禁回归，使用真实原生 Workflow 暂停和持久化。 */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import type { PracticeConfig } from '../src/mastra/config.js';
import { developmentExecutionIdentity, developmentHash, developmentInputSchema, developmentStateSchema, type DevelopmentInput } from '../src/development/contracts.js';
import { developmentStatus, openDevelopment, recoverDevelopment, reviewDevelopment, seedDevelopment, type DevelopmentApplication } from '../src/development-service.js';
import { generateDevelopment } from '../src/development/agents.js';
import type { DevelopmentGenerator } from '../src/development/recovery.js';

const practiceRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));

/** 最小真实源码与公开检查用来观察重放，所有运行均为离线fixture。 */
function input(): DevelopmentInput {
  const content = '合成任务：固定导出fixtureValue=1。';
  return developmentInputSchema.parse({ source: { kind: 'evaluation', runId: 'recovery-review-fixture', content, hash: developmentHash(content), evidence: 'evaluation-input' }, maxReworks: 2,
    project: { id: 'recovery-review-fixture', roles: ['backend'], writablePaths: ['src/solution.mjs'], checkFiles: ['smoke.test.mjs'], files: {
      'src/solution.mjs': '/** 尚未实现的基线。 */\nexport function fixtureValue() { return 0; }\n',
      'smoke.test.mjs': 'import {test} from "node:test";\nimport assert from "node:assert/strict";\nimport {fixtureValue} from "./src/solution.mjs";\n/** 检查真实被实现函数。 */\nfunction smoke() { assert.equal(fixtureValue(),1); }\ntest("fixture value",smoke);\n',
    } } });
}

/** 每次运行独占原生Store与候选目录，清理不触及正在执行的live批次。 */
async function fixture(check: (app: DevelopmentApplication, directory: string, config: PracticeConfig) => Promise<void>, generate: DevelopmentGenerator, data = input(), automatic = true): Promise<void> {
  const parent = mkdtempSync(resolve(tmpdir(), 'development-recovery-review-'));
  const directory = resolve(parent, 'run');
  const config: PracticeConfig = { rootDir: practiceRoot, mode: 'fixture', databaseUrl: `file:${resolve(parent, 'unused.db')}`, port: 4111, modelId: 'openai/original-fixture-model', baseUrl: 'http://127.0.0.1/original-fixture' };
  seedDevelopment(directory, data);
  const app = openDevelopment(config, directory, automatic, generate);
  try { await app.storage.init(); await check(app, directory, config); }
  finally { await app.execution.close(); await app.storage.close(); rmSync(parent, { recursive: true, force: true }); }
}

/** 只读取原生当前故障暂停点，不能从历史嵌套文本猜测恢复版本。 */
async function recovery(app: DevelopmentApplication, runId: string) {
  const status = await developmentStatus(app, runId);
  const step = status.steps?.['development-iteration.recover-development'];
  assert.equal(status.status, 'suspended');
  assert.ok(step && !Array.isArray(step));
  assert.equal(step.status, 'suspended');
  const state = developmentStateSchema.parse(step.payload);
  assert.ok(state.recovery);
  return state;
}

/** 人工接续只使用测试身份标签与当前恢复hash。 */
function retry(hash: string) { return { hash, decision: 'retry' as const, reviewer: 'fixture-review-owner', comment: '确认离线fixture安全检查点。' }; }

// URL等价写法不制造漂移，凭据不属于持久化身份。
test('执行身份归一化端点且不持久化凭据，支持key轮转', () => {
  const config: PracticeConfig = { rootDir: practiceRoot, mode: 'live', databaseUrl: 'file:unused', port: 4111, modelId: 'openai/model', apiKey: 'synthetic-original-key', baseUrl: 'https://EXAMPLE.com:443/v1/' };
  const identity = developmentExecutionIdentity(config);
  assert.deepEqual(identity, developmentExecutionIdentity({ ...config, apiKey: 'synthetic-rotated-key', baseUrl: 'https://example.com/v1' }));
  assert.notEqual(identity.endpointHash, developmentExecutionIdentity({ ...config, baseUrl: 'https://example.com/other' }).endpointHash);
  assert.doesNotMatch(JSON.stringify(identity), /synthetic|example\.com|https/);
});

// 原生暂停状态重开后，单独更换key仍可接续，不会放行模型身份变化。
test('故障恢复允许凭据轮转且沿用已保存执行身份', async () => {
  /** 第一次应用只制造网络错误，以便重新打开同一原生暂停点。 */
  const timeout: DevelopmentGenerator = async () => { throw Object.assign(new Error('synthetic-error'), { code: 'ECONNRESET' }); };
  // 同一输入/模型/端点重开，仅替换API key。
  await fixture(async (app, directory, config) => {
    const run = await app.workflow.createRun();
    await run.start({ inputData: app.input });
    const before = await recovery(app, run.runId);
    await app.execution.close(); await app.storage.close();
    const reopened = openDevelopment({ ...config, apiKey: 'synthetic-rotated-key' }, directory, true);
    try {
      await reopened.storage.init();
      assert.equal((await recoverDevelopment(reopened, run.runId, retry(before.recovery!.hash))).status, 'success');
      const state = (await developmentStatus(reopened, run.runId)).result!;
      assert.equal(state.outcome, 'development-delivered');
      assert.deepEqual(state.executionIdentity, before.executionIdentity);
      assert.doesNotMatch(JSON.stringify(state), /synthetic-rotated-key/);
    } finally { await reopened.execution.close(); await reopened.storage.close(); }
  }, timeout);
});

// 身份门禁同样保护人工方案确认，拒绝请求不消耗原生暂停点。
test('方案审批拒绝模型和端点漂移，原身份可继续确认', async () => {
  // 持久化后逐个更改身份，再用原配置完成方案确认。
  await fixture(async (app, directory, config) => {
    const run = await app.workflow.createRun();
    await run.start({ inputData: app.input });
    const before = await developmentStatus(app, run.runId);
    const pending = before.steps?.['development-iteration.approve-architecture'];
    assert.ok(pending && !Array.isArray(pending));
    const state = developmentStateSchema.parse(pending.payload);
    const approval = { ...retry(state.planHash!), decision: 'approve' };
    await app.execution.close(); await app.storage.close();
    for (const change of [{ modelId: 'openai/changed' as const }, { baseUrl: 'https://example.com/changed' }]) {
      const changed = openDevelopment({ ...config, ...change }, directory);
      try {
        await changed.storage.init();
        await assert.rejects(reviewDevelopment(changed, run.runId, approval), /身份/);
        assert.equal((await developmentStatus(changed, run.runId)).status, 'suspended');
      } finally { await changed.execution.close(); await changed.storage.close(); }
    }
    const restored = openDevelopment(config, directory);
    try {
      await restored.storage.init();
      assert.equal((await reviewDevelopment(restored, run.runId, approval)).status, 'success');
    } finally { await restored.execution.close(); await restored.storage.close(); }
  }, generateDevelopment, input(), false);
});

// 新方案获批并完成实现后，自检故障接续不能再次生成方案或重放已完成实现。
test('架构返工后自检故障恢复只重试自检，不重新规划或实现', async () => {
  let architectureCalls = 0;
  let backendCalls = 0;
  let selfCheckCalls = 0;
  /** 首个实现回报架构阻塞，新方案实现成功后让自检连续两次超时。 */
  const generate: DevelopmentGenerator = async (config, role, execution, state, paths, extra) => {
    if (role === 'architect') architectureCalls++;
    if (role === 'backend') backendCalls++;
    if (role === 'self-check' && ++selfCheckCalls <= 2) throw Object.assign(new Error('synthetic-self-check-timeout'), { name: 'TimeoutError' });
    const entry = await generateDevelopment(config, role, execution, state, paths, extra);
    if (role === 'backend' && backendCalls === 1) return { ...entry, text: 'ARCHITECTURE_BLOCKER: 缺少已确认接口契约。' };
    return entry;
  };
  // 用角色调用计数和完整状态识别重放，不能只看最终smoke成功。
  await fixture(async (app) => {
    const run = await app.workflow.createRun();
    assert.equal((await run.start({ inputData: app.input })).status, 'suspended');
    const before = await recovery(app, run.runId);
    assert.equal(before.recovery!.role, 'self-check');
    assert.deepEqual(before.completedTasks, ['fixture-task-1']);
    assert.equal(architectureCalls, 2);
    assert.equal(backendCalls, 2);
    assert.equal(selfCheckCalls, 2);
    assert.equal((await recoverDevelopment(app, run.runId, retry(before.recovery!.hash))).status, 'success');
    const after = (await developmentStatus(app, run.runId)).result!;
    assert.equal(after.outcome, 'development-delivered');
    assert.equal(architectureCalls, 2, '自检接续不得重新生成方案');
    assert.equal(backendCalls, 2, '自检接续不得重放已完成实现');
    assert.equal(selfCheckCalls, 3);
    assert.equal(after.planHash, before.planHash);
    assert.equal(after.approvedHash, before.approvedHash);
    assert.equal(after.reviews.length, before.reviews.length);
  }, generate);
});

// 自动批准的原始入口与澄清入口必须使用相同的评测来源证据及正文hash约束。
for (const field of ['evidence', 'hash'] as const) {
  // 每个非法来源单独执行，使一种拒绝不会掩盖另一种漏洞。
  test(`评测自动批准入口拒绝错误来源${field}`, async () => {
    const parent = mkdtempSync(resolve(tmpdir(), 'development-evaluation-source-review-'));
    const config: PracticeConfig = { rootDir: practiceRoot, mode: 'fixture', databaseUrl: `file:${resolve(parent, 'unused.db')}`, port: 4111, modelId: 'openai/fixture-model' };
    let app: DevelopmentApplication | undefined;
    try {
      const original = input();
      const source = field === 'evidence' ? { ...original.source, evidence: 'fixture' as const } : { ...original.source, hash: '0'.repeat(64) };
      const directory = resolve(parent, 'invalid');
      seedDevelopment(directory, { ...original, source });
      assert.throws(
        // 捕获意外创建的应用，测试失败时仍须关闭其独占执行资源。
        () => { app = openDevelopment(config, directory, true); },
        /评测.*来源|来源.*评测|hash|哈希|证据/,
      );
      // 正确拒绝在执行环境构造前完成，不应创建应用。
      assert.equal(app, undefined);
    } finally {
      if (app) { await app.execution.close(); await app.storage.close(); }
      rmSync(parent, { recursive: true, force: true });
    }
  });
}

// 模式、模型身份和端点是执行批准的一部分，换凭据不应顺带允许换模型或端点。
for (const field of ['mode', 'modelId', 'baseUrl'] as const) {
  // 各字段独立使用持久化Store和真实暂停点，避免一次拒绝掩盖其他漂移。
  test(`故障恢复拒绝${field}漂移且保留原暂停点`, async () => {
    /** 第一次应用只制造架构调用超时，不写文件。 */
    const timeout: DevelopmentGenerator = async () => { throw Object.assign(new Error('synthetic-timeout'), { name: 'TimeoutError' }); };
    // 关闭后以不同配置重开同一Store，验证恢复不依赖旧进程内存。
    await fixture(async (app, directory, config) => {
      const run = await app.workflow.createRun();
      assert.equal((await run.start({ inputData: app.input })).status, 'suspended');
      const before = await recovery(app, run.runId);
      await app.execution.close(); await app.storage.close();
      const changed: PracticeConfig = { ...config };
      if (field === 'mode') changed.mode = 'live';
      if (field === 'modelId') changed.modelId = 'openai/changed-fixture-model';
      if (field === 'baseUrl') changed.baseUrl = 'http://127.0.0.1/changed-fixture';
      const reopened = openDevelopment(changed, directory, true);
      try {
        await reopened.storage.init();
        await assert.rejects(recoverDevelopment(reopened, run.runId, retry(before.recovery!.hash)), /输入|模式|配置|身份|端点|模型/);
        const after = await recovery(reopened, run.runId);
        assert.equal(after.recovery!.hash, before.recovery!.hash);
        assert.equal(after.faults.length, before.faults.length);
        assert.equal(after.recoveries.length, 0);
      } finally { await reopened.execution.close(); await reopened.storage.close(); }
    }, timeout);
  });
}
