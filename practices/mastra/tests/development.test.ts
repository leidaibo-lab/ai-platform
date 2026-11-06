import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { test } from 'node:test';
import type { PracticeConfig } from '../src/mastra/config.js';
import { developmentHash, developmentInputSchema, developmentStateSchema, type DevelopmentInput } from '../src/development/contracts.js';
import { approvedDevelopmentInput, developmentStatus, openDevelopment, reviewDevelopment, seedDevelopment, type DevelopmentApplication } from '../src/development-service.js';
import { createApplication } from '../src/mastra/app.js';
import { startDelivery, reviewDelivery } from '../src/delivery-service.js';
import { developmentPrompt } from '../src/development/agents.js';

const practiceRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));

/** 显式初始源码不含 fixture 实现，暂停和拒绝用例据此检查没有提前写入。 */
const initialSource = '/** 用于验证人工关口前不改源码的初始模块。 */\nexport function fixtureValue() { return 0; }\n';

/** 生成有真实公开 smoke 的项目输入；检查文件永远不在写白名单。 */
function developmentInput(expected = 1, maxReworks = 1): DevelopmentInput {
  const content = '仅开发阶段：经人工确认方案后，通过工具写入fixtureValue=1并运行真实smoke。';
  return developmentInputSchema.parse({
    source: { kind: 'evaluation', runId: 'development-test-product', hash: developmentHash(content), content, evidence: 'evaluation-input' },
    project: {
      id: 'development-test-project',
      files: {
        'src/solution.mjs': initialSource,
        'smoke.test.mjs': `import assert from 'node:assert/strict';\nimport {test} from 'node:test';\nimport {fixtureValue} from './src/solution.mjs';\n/** 运行真实被实现函数，不接受模型通过声明。 */\nfunction smokeFixture() { assert.equal(fixtureValue(), ${expected}); }\ntest('fixture value', smokeFixture);\n`,
      },
      writablePaths: ['src/solution.mjs'], checkFiles: ['smoke.test.mjs'], roles: ['backend'],
    }, maxReworks,
  });
}

/** 为每例单独建立原生Store和OS受限执行目录，不接触已有Run。 */
async function withDevelopment(check: (app: DevelopmentApplication, directory: string, config: PracticeConfig) => Promise<void>, input = developmentInput(), evaluationPolicy = false): Promise<void> {
  const parent = mkdtempSync(resolve(tmpdir(), 'mastra-development-workflow-'));
  const directory = resolve(parent, 'run');
  seedDevelopment(directory, input);
  const config: PracticeConfig = { rootDir: practiceRoot, mode: 'fixture', databaseUrl: `file:${resolve(parent, 'unused.db')}`, port: 4111, modelId: 'openai/gpt-4o-mini' };
  const app = openDevelopment(config, directory, evaluationPolicy);
  try {
    await app.storage.init();
    await check(app, directory, config);
  } finally {
    await app.execution.close();
    await app.storage.close();
    rmSync(parent, { recursive: true, force: true });
  }
}

/** 从原生嵌套步骤中找到当前方案状态，不维护平行审批记录。 */
function planHashFrom(value: unknown): string | null {
  if (!value || typeof value !== 'object') return null;
  if ('planHash' in value && typeof value.planHash === 'string' && value.planHash.length === 64) return value.planHash;
  for (const child of Object.values(value)) {
    const found = planHashFrom(child);
    if (found) return found;
  }
  return null;
}

/** 标准本地模拟批准只绑定当前方案；不代表真实用户身份验证。 */
function approval(hash: string) {
  return { hash, decision: 'approve' as const, reviewer: 'local-development-owner', comment: '确认隔离fixture方案，仅验证控制流。' };
}

// 架构返工必须获得实际实现阻塞，不能只重新读取旧方案。
test('架构返工上下文传递最新责任角色的有界阻塞证据', () => {
  const state = developmentStateSchema.parse({ input: developmentInput(), mode: 'fixture', plan: null, planHash: null, planSourceHash: null, approvedHash: null, reviews: [], round: 1, route: 'architecture', checks: [], history: [], outcome: 'in-progress', delivery: null,
    work: [{ role: 'backend', round: 0, text: '普通历史说明。ARCHITECTURE_BLOCKER: 缺少对象级授权字段，不能按批准接口实现。' + '证据'.repeat(4000), tools: ['readFile'], steps: 1, modelId: null, inputTokens: null, outputTokens: null }] });
  const prompt = JSON.parse(developmentPrompt('architect', state));
  assert.equal(prompt.implementationBlocker.role, 'backend');
  assert.match(prompt.implementationBlocker.text, /^ARCHITECTURE_BLOCKER: 缺少对象级授权字段/);
  assert.ok(prompt.implementationBlocker.text.length <= 6000);
  assert.equal('work' in prompt, false);
  assert.equal(JSON.parse(developmentPrompt('frontend', state)).implementationBlocker, null);
});

// 原生Workflow首先停在技术方案关口，不能提前触发工具写入。
test('开发流程生成人工待审任务图，批准前源码保持初始状态', async () => {
  // 单个候选独占目录，读回物理文件确认没有提前实现。
  await withDevelopment(async (app, directory) => {
    const run = await app.workflow.createRun({ runId: 'architecture-pending' });
    const result = await run.start({ inputData: app.input });
    assert.equal(result.status, 'suspended');
    const status = await developmentStatus(app, run.runId);
    assert.ok(planHashFrom(status.steps));
    const serialized = JSON.stringify(status.steps);
    assert.match(serialized, /fixture-task-1/);
    assert.match(serialized, /src\/solution\.mjs/);
    assert.equal(readFileSync(resolve(directory, 'candidate/src/solution.mjs'), 'utf8'), initialSource);
  });
});

// 错误版本不能消耗暂停点，当前批准才可进入写入和自检。
test('旧方案hash被拒绝，当前批准后真实写入、自检并结束于研发交付', async () => {
  // 同一原生Run在错误恢复请求后仍可使用正确版本恢复。
  await withDevelopment(async (app, directory) => {
    const run = await app.workflow.createRun({ runId: 'architecture-approved' });
    assert.equal((await run.start({ inputData: app.input })).status, 'suspended');
    const before = await developmentStatus(app, run.runId);
    const hash = planHashFrom(before.steps);
    assert.ok(hash);
    await assert.rejects(reviewDevelopment(app, run.runId, approval('0'.repeat(64))), /版本/);
    assert.equal((await developmentStatus(app, run.runId)).status, 'suspended');
    const result = await reviewDevelopment(app, run.runId, approval(hash));
    assert.equal(result.status, 'success');
    const status = await developmentStatus(app, run.runId);
    assert.equal(status.result?.outcome, 'development-delivered');
    assert.equal(status.result?.delivery?.version, 'development-delivery.v1');
    assert.equal(status.result?.reviews[0].authority, 'local-human-label');
    assert.equal(status.result?.work.length, 3);
    assert.deepEqual(status.result?.work.map(
      // 开发流程不得创建或执行测试/运维角色。
      (entry) => entry.role,
    ), ['architect', 'backend', 'self-check']);
    assert.ok(status.result?.work[1].tools.includes('readFile'));
    assert.ok(status.result?.work[1].tools.includes('writeFile'));
    assert.ok(status.result?.work[2].tools.includes('runChecks'));
    assert.equal(status.result?.checks.length, 2);
    assert.ok(status.result?.checks.every(
      // 终态放行必须绑定真实成功退出的进程。
      (check) => check.exitCode === 0,
    ));
    assert.match(readFileSync(resolve(directory, 'candidate/src/solution.mjs'), 'utf8'), /return 1/);
    assert.equal(status.result?.delivery?.sourceHash, developmentHash(await app.execution.snapshot()));
  });
});

// 技术方案拒绝后只保存决定，不允许实现角色写文件。
test('拒绝技术方案后结束开发流程，不写源码、不运行自检', async () => {
  // 原始文件、角色记录和终态共同证明拒绝分支隔离。
  await withDevelopment(async (app, directory) => {
    const run = await app.workflow.createRun({ runId: 'architecture-rejected' });
    assert.equal((await run.start({ inputData: app.input })).status, 'suspended');
    const hash = planHashFrom((await developmentStatus(app, run.runId)).steps);
    assert.ok(hash);
    const result = await reviewDevelopment(app, run.runId, { ...approval(hash), decision: 'reject', comment: '不批准此fixture方案。' });
    assert.equal(result.status, 'success');
    const status = await developmentStatus(app, run.runId);
    assert.equal(status.result?.outcome, 'rejected');
    assert.equal(status.result?.work.length, 1);
    assert.equal(status.result?.checks.length, 0);
    assert.equal(status.result?.delivery, null);
    assert.equal(readFileSync(resolve(directory, 'candidate/src/solution.mjs'), 'utf8'), initialSource);
  });
});

// 真实公开检查持续失败时按次数上限结束，不能把fixture输出当成功。
test('公开smoke失败触发有界返工，达到上限后不交付', async () => {
  // 固定实现始终为1，要求2的真实smoke必须在两轮后仍失败。
  await withDevelopment(async (app) => {
    const run = await app.workflow.createRun({ runId: 'bounded-rework' });
    const result = await run.start({ inputData: app.input });
    assert.equal(result.status, 'success');
    const status = await developmentStatus(app, run.runId);
    assert.equal(status.result?.outcome, 'rework-exhausted');
    assert.equal(status.result?.round, 2);
    assert.equal(status.result?.history.length, 2);
    assert.equal(status.result?.delivery, null);
    assert.equal(status.result?.work.length, 5);
    assert.equal(status.result?.reviews.length, 1);
    assert.equal(status.result?.reviews[0].authority, 'evaluation-policy');
    assert.ok(status.result?.history.every(
      // 每轮失败证据必须来自真实公开检查。
      (round) => round.checks.some(
        // 语法成功不能抵消业务smoke失败。
        (check) => check.exitCode !== 0,
      ),
    ));
  }, developmentInput(2, 1), true);
});

// 持久化的原生暂停快照必须在销毁旧应用后由新实例恢复。
test('原生Store关闭重开后保留方案hash，并能恢复到开发交付', async () => {
  // 旧实例先关闭所有资源，新实例使用同一明确目录且无内存状态共享。
  await withDevelopment(async (app, directory, config) => {
    const run = await app.workflow.createRun({ runId: 'reopened-development' });
    assert.equal((await run.start({ inputData: app.input })).status, 'suspended');
    const hash = planHashFrom((await developmentStatus(app, run.runId)).steps);
    assert.ok(hash);
    await app.execution.close();
    await app.storage.close();
    const reopened = openDevelopment(config, directory);
    try {
      await reopened.storage.init();
      const restored = await developmentStatus(reopened, run.runId);
      assert.equal(restored.status, 'suspended');
      assert.equal(planHashFrom(restored.steps), hash);
      const result = await reviewDevelopment(reopened, run.runId, approval(hash));
      assert.equal(result.status, 'success');
      assert.equal((await developmentStatus(reopened, run.runId)).result?.outcome, 'development-delivered');
    } finally {
      await reopened.execution.close();
      await reopened.storage.close();
    }
  });
});

// 独立OS进程只能依赖已保存的LibSQL快照和输入文件恢复。
test('人工暂停后由独立OS进程恢复并完成开发交付', { timeout: 30000 }, async () => {
  // fixture没有远程模型调用；子进程使用明确输入和执行目录。
  await withDevelopment(async (app, directory, config) => {
    const run = await app.workflow.createRun({ runId: 'cross-process-development' });
    assert.equal((await run.start({ inputData: app.input })).status, 'suspended');
    const hash = planHashFrom((await developmentStatus(app, run.runId)).steps);
    assert.ok(hash);
    await app.execution.close();
    await app.storage.close();
    const source = [
      'import {openDevelopment, reviewDevelopment, developmentStatus} from "./src/development-service.ts";',
      `const app = openDevelopment(${JSON.stringify(config)}, ${JSON.stringify(directory)});`,
      'try {',
      '  await app.storage.init();',
      `  const result = await reviewDevelopment(app, ${JSON.stringify(run.runId)}, ${JSON.stringify(approval(hash))});`,
      `  const status = await developmentStatus(app, ${JSON.stringify(run.runId)});`,
      '  console.log(JSON.stringify({status:result.status,outcome:status.result?.outcome,sourceHash:status.result?.delivery?.sourceHash}));',
      '} finally { await app.execution.close(); await app.storage.close(); }',
    ].join('\n');
    const child = execFileSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', source], {
      cwd: practiceRoot, encoding: 'utf8', timeout: 15000,
      env: { PATH: process.env.PATH, HOME: process.env.HOME, TMPDIR: tmpdir(), NODE_ENV: 'test' },
    });
    const result = JSON.parse(child);
    assert.equal(result.status, 'success');
    assert.equal(result.outcome, 'development-delivered');
    assert.match(result.sourceHash, /^[a-f0-9]{64}$/);
    assert.match(readFileSync(resolve(directory, 'candidate/src/solution.mjs'), 'utf8'), /return 1/);
  });
});

// 技术方案版本同时绑定源码快照，外部文件漂移不得消耗人工暂停点。
test('人工确认前源码漂移被拒绝，原暂停点和当前方案hash保持可审阅', async () => {
  // 使用受限工具模拟批准外的物理变化，不篡改Store中的方案记录。
  await withDevelopment(async (app) => {
    const run = await app.workflow.createRun({ runId: 'source-drift-development' });
    assert.equal((await run.start({ inputData: app.input })).status, 'suspended');
    const before = await developmentStatus(app, run.runId);
    const hash = planHashFrom(before.steps);
    assert.ok(hash);
    await app.execution.writeFile('src/solution.mjs', '/** 方案生成后的外部变更。 */\nexport function fixtureValue() { return 99; }\n');
    await assert.rejects(reviewDevelopment(app, run.runId, approval(hash)), /源码.*漂移/);
    const after = await developmentStatus(app, run.runId);
    assert.equal(after.status, 'suspended');
    assert.equal(planHashFrom(after.steps), hash);
    assert.equal(after.result, null);
    await app.execution.writeFile('src/solution.mjs', initialSource);
    assert.equal((await reviewDevelopment(app, run.runId, approval(hash))).status, 'success');
    assert.equal((await developmentStatus(app, run.runId)).result?.outcome, 'development-delivered');
  });
});

// 恢复时检查执行配置必须与持久化方案批准的输入相同。
test('重开后替换smoke清单不能绕过原批准方案', async () => {
  // 同一脱敏目录的另一个公开smoke故意不验证业务行为。
  await withDevelopment(async (app, directory, config) => {
    const noop = 'import {test} from "node:test";\n/** 漂移smoke不检查候选行为。 */\nfunction noop() {}\ntest("noop", noop);\n';
    writeFileSync(resolve(directory, 'candidate/noop.test.mjs'), noop);
    const run = await app.workflow.createRun({ runId: 'execution-config-drift' });
    assert.equal((await run.start({ inputData: app.input })).status, 'suspended');
    const hash = planHashFrom((await developmentStatus(app, run.runId)).steps);
    assert.ok(hash);
    await app.execution.close();
    await app.storage.close();
    const tampered = { ...app.input, project: { ...app.input.project, files: { ...app.input.project.files, 'noop.test.mjs': noop }, checkFiles: ['noop.test.mjs'] } };
    writeFileSync(resolve(directory, 'input.json'), JSON.stringify(tampered, null, 2));
    const reopened = openDevelopment(config, directory);
    try {
      await reopened.storage.init();
      await assert.rejects(reviewDevelopment(reopened, run.runId, approval(hash)), /输入或执行配置发生漂移/);
      assert.equal((await developmentStatus(reopened, run.runId)).status, 'suspended');
      writeFileSync(resolve(directory, 'input.json'), JSON.stringify(app.input, null, 2));
      const restored = openDevelopment(config, directory);
      try {
        await restored.storage.init();
        assert.equal((await reviewDevelopment(restored, run.runId, approval(hash))).status, 'success');
        assert.equal((await developmentStatus(restored, run.runId)).result?.outcome, 'development-delivered');
      } finally { await restored.execution.close(); await restored.storage.close(); }
    } finally { await reopened.execution.close(); await reopened.storage.close(); }
  });
});

// 开发业务入口必须使用已保存在产品Workflow中的批准，调用者不能自传正文替代。
test('产品未批准时拒绝开发输入，批准后从已保存产品版本派生', async () => {
  const parent = mkdtempSync(resolve(tmpdir(), 'mastra-development-product-'));
  const config: PracticeConfig = { rootDir: practiceRoot, mode: 'fixture', databaseUrl: `file:${resolve(parent, 'product.db')}`, port: 4111, modelId: 'openai/gpt-4o-mini' };
  const app = createApplication(config);
  try {
    await app.storage.init();
    const product = await startDelivery(app, '工单标题去首尾空格后为1–80字符，非法输入显示原因。');
    assert.equal(product.status, 'suspended');
    assert.equal(product.pending?.role, 'product');
    await assert.rejects(approvedDevelopmentInput(app, product.runId, developmentInput().project), /产品版本未.*批准/);
    const hash = product.pending!.artifact.hash;
    const content = product.pending!.artifact.content;
    const approved = await reviewDelivery(app, product.runId, { role: 'product', artifactHash: hash, decision: 'approve', reviewer: 'local-product-owner', comment: '确认隔离fixture产品版本用于开发交接入口验证。' });
    assert.equal(approved.pending?.role, 'development');
    const input = await approvedDevelopmentInput(app, product.runId, developmentInput().project);
    assert.equal(input.source.kind, 'approved-product');
    assert.equal(input.source.runId, product.runId);
    assert.equal(input.source.hash, hash);
    assert.equal(input.source.content, content);
    assert.equal(input.source.evidence, 'fixture');
    assert.deepEqual(input.project, developmentInput().project);
    const developmentDirectory = resolve(parent, 'development');
    seedDevelopment(developmentDirectory, input);
    assert.throws(
      // 真业务来源不能使用评测自动批准捷径。
      () => openDevelopment(config, developmentDirectory, true),
      /自动批准规则仅允许评测案例/,
    );
  } finally {
    await app.storage.close();
    rmSync(parent, { recursive: true, force: true });
  }
});
