import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { createApplication } from '../src/mastra/app.js';
import type { PracticeConfig } from '../src/mastra/config.js';
import { reviewDelivery, startDelivery } from '../src/delivery-service.js';
import { approvedDevelopmentInput, clarifyDevelopment, developmentStatus, openDevelopment, seedDevelopment, type DevelopmentApplication } from '../src/development-service.js';
import { generateDevelopment } from '../src/development/agents.js';
import { developmentHash, developmentInputSchema, developmentStateSchema, type DevelopmentInput } from '../src/development/contracts.js';
import type { DevelopmentGenerator } from '../src/development/recovery.js';

const practiceRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));
const initialSource = '/** 尚未获批的源码保持初始值。 */\nexport function fixtureValue() { return 0; }\n';

/** 只给出真实隔离文件与公开检查，不伪造产品来源或检查结果。 */
function project(): DevelopmentInput['project'] {
  return {
    id: 'product-clarification-fixture', roles: ['backend'], writablePaths: ['src/solution.mjs'], checkFiles: ['smoke.test.mjs'],
    files: {
      'src/solution.mjs': initialSource,
      'smoke.test.mjs': 'import {test} from "node:test";\nimport assert from "node:assert/strict";\nimport {fixtureValue} from "./src/solution.mjs";\n/** 固定检查真实导出函数。 */\nfunction smoke() { assert.equal(fixtureValue(),1); }\ntest("fixture value",smoke);\n',
    },
  };
}

/** 只在架构结果注入业务阻塞，模型与文件操作均复用真实fixture入口。 */
const blockedArchitecture: DevelopmentGenerator = async (config, role, execution, state, paths, extra) => {
  const entry = await generateDevelopment(config, role, execution, state, paths, extra);
  if (role !== 'architect') return entry;
  const plan = JSON.parse(entry.text);
  return { ...entry, text: JSON.stringify({ ...plan, blockers: ['必须由产品确认字符计数及非法输入反馈规则。'] }) };
};

/** 从原生嵌套步骤精确读取待确认方案，不扫描文本猜测批准状态。 */
async function pendingArchitecture(app: DevelopmentApplication, runId: string) {
  const status = await developmentStatus(app, runId);
  const step = status.steps?.['development-iteration.approve-architecture'];
  assert.ok(step && !Array.isArray(step));
  assert.equal(step.status, 'suspended');
  return developmentStateSchema.parse(step.payload);
}

/** 产品审批仅写入本地测试标签；不代表认证身份或真实业务批准。 */
function productApproval(hash: string) {
  return { role: 'product' as const, artifactHash: hash, decision: 'approve' as const, reviewer: 'fixture-product-owner', comment: '只确认fixture版本以验证原生产品与研发门禁。' };
}

// 需求澄清必须回到产品批准事实，不能复用旧hash、伪造评测来源或跳过新方案审批。
test('真实产品澄清经新版本批准派生研发目录，重新待审且保留旧Run', async () => {
  const parent = mkdtempSync(resolve(tmpdir(), 'development-product-clarification-'));
  const config: PracticeConfig = { rootDir: practiceRoot, mode: 'fixture', databaseUrl: `file:${resolve(parent, 'product.db')}`, modelId: 'openai/gpt-4o-mini', port: 4111 };
  const productApp = createApplication(config);
  let development: DevelopmentApplication | undefined;
  let next: DevelopmentApplication | undefined;
  try {
    await productApp.storage.init();
    const v1 = await startDelivery(productApp, '第一版：工单标题需校验，字符计数和非法反馈仍待补齐。');
    assert.equal(v1.pending?.role, 'product');
    assert.equal((await reviewDelivery(productApp, v1.runId, productApproval(v1.pending!.artifact.hash))).pending?.role, 'development');
    const input = await approvedDevelopmentInput(productApp, v1.runId, project());
    const directory = resolve(parent, 'v1-development');
    seedDevelopment(directory, input);
    development = openDevelopment(config, directory, false, blockedArchitecture);
    await development.storage.init();
    const run = await development.workflow.createRun();
    assert.equal((await run.start({ inputData: development.input })).status, 'success');
    const old = await developmentStatus(development, run.runId);
    assert.equal(old.result?.outcome, 'clarification-required');
    assert.deepEqual(old.result?.work.map(
      // 阻塞结束前不调用实现或自检角色。
      (entry) => entry.role,
    ), ['architect']);
    assert.equal(old.result?.reviews.length, 0);
    assert.equal(old.result?.checks.length, 0);
    assert.equal(old.result?.delivery, null);
    const oldSnapshot = JSON.stringify(old);
    const oldInput = readFileSync(resolve(directory, 'input.json'), 'utf8');
    const nextDirectory = resolve(parent, 'v2-development');
    const v2 = await startDelivery(productApp, '第二版：工单标题trim后按Unicode码点计数1–80，非法反馈为title。');
    assert.equal(v2.pending?.role, 'product');
    assert.notEqual(v2.pending!.artifact.hash, input.source.hash);
    await assert.rejects(clarifyDevelopment(development, run.runId, nextDirectory, { productApp, productRunId: v2.runId }, '请求采用尚未批准的第二版。'), /产品版本未.*批准/);
    assert.equal(existsSync(nextDirectory), false);
    await assert.rejects(clarifyDevelopment(development, run.runId, nextDirectory, { productApp, productRunId: v1.runId }, '尝试复用原产品hash。'), /新的已确认需求版本/);
    assert.equal(existsSync(nextDirectory), false);
    const content = '调用者伪装为评测组织者的需求正文。';
    await assert.rejects(clarifyDevelopment(development, run.runId, nextDirectory, { evaluationSource: { kind: 'evaluation', runId: 'forged-evaluation', content, hash: developmentHash(content), evidence: 'evaluation-input' } }, '不能绕过真实产品批准。'), /仅评测组织者入口/);
    assert.equal(existsSync(nextDirectory), false);
    const crossModeProduct = { ...productApp, config: { ...config, mode: 'live' as const } };
    await assert.rejects(clarifyDevelopment(development, run.runId, nextDirectory, { productApp: crossModeProduct, productRunId: v2.runId }, '产品上下文模式变化。'), /来源或模式不匹配/);
    assert.equal(existsSync(nextDirectory), false);
    const crossModeDevelopment = { ...development, config: { ...config, mode: 'live' as const } };
    await assert.rejects(clarifyDevelopment(crossModeDevelopment, run.runId, nextDirectory, { productApp, productRunId: v2.runId }, '研发上下文模式变化。'), /澄清输入或模式发生漂移/);
    assert.equal(existsSync(nextDirectory), false);
    assert.equal(JSON.stringify(await developmentStatus(development, run.runId)), oldSnapshot);
    assert.equal((await reviewDelivery(productApp, v2.runId, productApproval(v2.pending!.artifact.hash))).pending?.role, 'development');
    const revised = await clarifyDevelopment(development, run.runId, nextDirectory, { productApp, productRunId: v2.runId }, '已批准产品第二版，重新制定技术方案。');
    assert.deepEqual(revised.source, { kind: 'approved-product', runId: v2.runId, hash: v2.pending!.artifact.hash, content: v2.pending!.artifact.content, evidence: 'fixture' });
    assert.deepEqual(revised.project, input.project);
    assert.deepEqual(revised.continuation, { runId: run.runId, sourceHash: input.source.hash, candidateHash: old.result!.planSourceHash, reason: '已批准产品第二版，重新制定技术方案。', authority: 'approved-product-version' });
    assert.deepEqual(JSON.parse(readFileSync(resolve(nextDirectory, 'input.json'), 'utf8')), revised);
    next = openDevelopment(config, nextDirectory);
    await next.storage.init();
    const nextRun = await next.workflow.createRun();
    assert.notEqual(nextRun.runId, run.runId);
    assert.equal((await nextRun.start({ inputData: next.input })).status, 'suspended');
    const pending = await pendingArchitecture(next, nextRun.runId);
    assert.equal(pending.input.source.hash, v2.pending!.artifact.hash);
    assert.notEqual(pending.planHash, old.result!.planHash);
    assert.equal(pending.approvedHash, null);
    assert.deepEqual(pending.reviews, []);
    assert.deepEqual(pending.checks, []);
    assert.equal(pending.delivery, null);
    assert.deepEqual(pending.work.map(
      // 新Run当前仅生成方案，不能继承旧确认或提前进入实现。
      (entry) => entry.role,
    ), ['architect']);
    assert.equal(readFileSync(resolve(nextDirectory, 'candidate/src/solution.mjs'), 'utf8'), initialSource);
    assert.equal(readFileSync(resolve(directory, 'candidate/src/solution.mjs'), 'utf8'), initialSource);
    assert.equal(readFileSync(resolve(directory, 'input.json'), 'utf8'), oldInput);
    assert.equal(JSON.stringify(await developmentStatus(development, run.runId)), oldSnapshot);
  } finally {
    if (next) { await next.execution.close(); await next.storage.close(); }
    if (development) { await development.execution.close(); await development.storage.close(); }
    await productApp.storage.close();
    rmSync(parent, { recursive: true, force: true });
  }
});

// 合成修订只能来自显式开启的评测入口，来源类型、证据和内容hash均不可伪造。
test('合成澄清拒绝缺少评测授权及伪造来源证据或hash', async () => {
  const parent = mkdtempSync(resolve(tmpdir(), 'development-evaluation-clarification-'));
  const directory = resolve(parent, 'original');
  const content = '原合成需求缺少计数规则。';
  const input = developmentInputSchema.parse({ source: { kind: 'evaluation', runId: 'original-evaluation', content, hash: developmentHash(content), evidence: 'evaluation-input' }, project: project(), maxReworks: 1 });
  seedDevelopment(directory, input);
  const config: PracticeConfig = { rootDir: practiceRoot, mode: 'fixture', databaseUrl: `file:${resolve(parent, 'unused.db')}`, modelId: 'openai/gpt-4o-mini', port: 4111 };
  const app = openDevelopment(config, directory, true, blockedArchitecture);
  try {
    await app.storage.init();
    const run = await app.workflow.createRun();
    assert.equal((await run.start({ inputData: app.input })).status, 'success');
    const old = JSON.stringify(await developmentStatus(app, run.runId));
    const revisedContent = '组织者公开补齐计数规则。';
    const source: DevelopmentInput['source'] = { ...input.source, content: revisedContent, hash: developmentHash(revisedContent) };
    const withoutPolicy = { ...app, evaluationPolicy: false };
    const nextDirectory = resolve(parent, 'revised');
    await assert.rejects(clarifyDevelopment(withoutPolicy, run.runId, nextDirectory, { evaluationSource: source }, '没有评测组织者授权。'), /仅评测组织者入口/);
    const forgeries: DevelopmentInput['source'][] = [
      { ...source, evidence: 'fixture' },
      { ...source, kind: 'approved-product', evidence: 'model-proposal' },
      { ...source, hash: '0'.repeat(64) },
    ];
    for (const evaluationSource of forgeries) {
      await assert.rejects(clarifyDevelopment(app, run.runId, nextDirectory, { evaluationSource }, '伪造来源应失败关闭。'), /仅评测组织者入口/);
      assert.equal(existsSync(nextDirectory), false);
      assert.equal(JSON.stringify(await developmentStatus(app, run.runId)), old);
    }
  } finally {
    await app.execution.close(); await app.storage.close();
    rmSync(parent, { recursive: true, force: true });
  }
});
