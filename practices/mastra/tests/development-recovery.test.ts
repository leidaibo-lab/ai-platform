import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { test } from 'node:test';
import type { PracticeConfig } from '../src/mastra/config.js';
import { developmentHash, developmentInputSchema, developmentStateSchema, type DevelopmentInput } from '../src/development/contracts.js';
import { clarifyDevelopment, developmentStatus, openDevelopment, recoverDevelopment, reviewDevelopment, seedDevelopment, type DevelopmentApplication } from '../src/development-service.js';
import { developmentPrompt, generateDevelopment } from '../src/development/agents.js';
import { classifyDevelopmentError, type DevelopmentGenerator } from '../src/development/recovery.js';

/** 生成两项任务的最小项目，检查文件不可写，用于识别错误的完成任务重放。 */
function input(): DevelopmentInput {
  const content = '合成评测：两个模块都返回fixtureValue=1。';
  return developmentInputSchema.parse({ source: { kind: 'evaluation', runId: 'recovery-fixture', content, hash: developmentHash(content), evidence: 'evaluation-input' }, maxReworks: 1,
    project: { id: 'recovery-fixture', roles: ['backend'], writablePaths: ['src/one.mjs', 'src/two.mjs'], checkFiles: ['smoke.test.mjs'], files: {
      'src/one.mjs': '/** 初始模块。 */\nexport function fixtureValue() { return 0; }\n',
      'src/two.mjs': '/** 初始模块。 */\nexport function fixtureValue() { return 0; }\n',
      'smoke.test.mjs': 'import {test} from "node:test";\nimport assert from "node:assert/strict";\nimport {fixtureValue as one} from "./src/one.mjs";\nimport {fixtureValue as two} from "./src/two.mjs";\n/** 两项真实实现必须同时通过。 */\nfunction check() { assert.equal(one(),1); assert.equal(two(),1); }\ntest("both",check);\n',
    } } });
}

/** 每例独立目录与原生Store，结束清理，不污染历史评测。 */
async function fixture(check: (app: DevelopmentApplication, directory: string, config: PracticeConfig) => Promise<void>, generate: DevelopmentGenerator = generateDevelopment, automatic = true): Promise<void> {
  const parent = mkdtempSync(resolve(tmpdir(), 'development-recovery-'));
  const directory = resolve(parent, 'run');
  seedDevelopment(directory, input());
  const config: PracticeConfig = { rootDir: process.cwd(), mode: 'fixture', databaseUrl: `file:${resolve(parent, 'unused.db')}`, modelId: 'openai/gpt-4o-mini', port: 4111 };
  const app = openDevelopment(config, directory, automatic, generate);
  try { await app.storage.init(); await check(app, directory, config); }
  finally { await app.execution.close(); await app.storage.close(); rmSync(parent, { recursive: true, force: true }); }
}

/** 精确读取原生嵌套暂停状态，不从文本递归猜测当前版本。 */
async function pending(app: DevelopmentApplication, runId: string, step: string) {
  const status = await developmentStatus(app, runId);
  const saved = status.steps?.[`development-iteration.${step}`];
  assert.ok(saved && !Array.isArray(saved));
  return { status, saved, state: developmentStateSchema.parse(saved.payload) };
}

/** 生成局部确认标签；不代表认证身份。 */
function review(hash: string, decision = 'approve') { return { hash, decision, reviewer: 'fixture-owner', comment: '仅验证原生批准与恢复控制流。' }; }

// 分类器只使用白名单属性；原始异常可能含凭据，不得进入状态。
test('故障分类识别timeout、嵌套DNS、HTTP和无效结构', () => {
  assert.equal(classifyDevelopmentError({ name: 'MastraTimeoutError', requestBodyValues: 'secret' }), 'model-timeout');
  assert.equal(classifyDevelopmentError({ cause: { code: 'ENOTFOUND' } }), 'model-network');
  assert.equal(classifyDevelopmentError({ statusCode: 503 }), 'model-network');
  assert.equal(classifyDevelopmentError(new SyntaxError('synthetic-secret')),'invalid-output');
  assert.equal(classifyDevelopmentError({ name: 'Unauthorized', statusCode: 401 }), 'model-error');
});

// 不可解析结构不能绕过方案关口，也不能被自动重试掩盖。
test('无效架构输出记录为结构错误并暂停，未启动实现或自检', async () => {
  let calls = 0;
  /** 模拟结构无效，仅产生一次模型结果。 */
  const generate: DevelopmentGenerator = async (config, role, execution, state, paths, extra) => {
    calls++;
    const entry = await generateDevelopment(config, role, execution, state, paths, extra);
    return { ...entry, text: '{invalid-json' };
  };
  // 原生暂停payload保存失败分类，源码仍为基线。
  await fixture(async (app) => {
    const run = await app.workflow.createRun();
    assert.equal((await run.start({ inputData: app.input })).status, 'suspended');
    const state = (await pending(app, run.runId, 'recover-development')).state;
    assert.equal(state.recovery?.kind, 'invalid-output');
    assert.equal(calls, 1);
    assert.equal(state.work.length, 0);
    assert.equal(state.checks.length, 0);
    assert.equal(state.plan, null);
    assert.match(await app.execution.readFile('src/one.mjs'), /return 0/);
  }, generate);
});

// JSON可解析不代表任务图可执行，语义错误同样只调用一次后暂停。
test('架构任务图遗漏文件责任归类invalid-output且不自动循环', async () => {
  let calls = 0;
  /** 保留合法JSON结构，但故意漏掉第二个文件的责任任务。 */
  const generate: DevelopmentGenerator = async (config, role, execution, state, paths, extra) => {
    calls++;
    const entry = await generateDevelopment(config, role, execution, state, paths, extra);
    return { ...entry, text: JSON.stringify({ ...JSON.parse(entry.text), tasks: [] }) };
  };
  // 无效方案没有批准、实现或检查记录，源文件保持初始值。
  await fixture(async (app) => {
    const run = await app.workflow.createRun();
    assert.equal((await run.start({ inputData: app.input })).status, 'suspended');
    const { state } = await pending(app, run.runId, 'recover-development');
    assert.equal(state.recovery?.kind, 'invalid-output');
    assert.equal(calls, 1);
    assert.equal(state.reviews.length, 0);
    assert.equal(state.completedTasks.length, 0);
    assert.equal(state.checks.length, 0);
  }, generate);
});

// 真实文件部分写入后抛网络错误，第二次调用必须看到原始文件。
test('临时故障先回滚部分写入，再有界自动重试并保留失败证据', async () => {
  let calls = 0;
  /** 注入一次网络故障，其他调用仍使用真实Mastra fixture和工具。 */
  const generate: DevelopmentGenerator = async (config, role, execution, state, paths, extra) => {
    if (role === 'backend' && paths?.[0] === 'src/one.mjs') {
      calls++;
      assert.match(await execution.readFile(paths[0]), /return 0/);
      if (calls === 1) {
        await execution.writeFile(paths[0], '/** 部分实现不应残留。 */\nexport function fixtureValue() { return 77; }\n');
        throw Object.assign(new Error('synthetic-secret'), { code: 'ECONNRESET', requestBodyValues: { token: 'synthetic-secret' } });
      }
    }
    return generateDevelopment(config, role, execution, state, paths, extra);
  };
  // 完成后同时检查源码、失败记录和固定smoke，不仅观察模型返回。
  await fixture(async (app) => {
    const run = await app.workflow.createRun();
    assert.equal((await run.start({ inputData: app.input })).status, 'success');
    const state = (await developmentStatus(app, run.runId)).result!;
    assert.equal(state.outcome, 'development-delivered');
    assert.equal(calls, 2);
    assert.equal(state.faults.length, 1);
    assert.equal(state.faults[0].kind, 'model-network');
    assert.notEqual(state.faults[0].partialSourceHash, state.faults[0].checkpointHash);
    assert.equal(state.faults[0].restored, true);
    assert.equal(state.faults[0].usage, 'unknown');
    assert.equal(JSON.stringify(state).includes('synthetic-secret'), false);
  }, generate);
});

// 两次临时失败后暂停；关闭Store重开后从安全角色检查点恢复。
test('故障暂停跨实例接续，拒绝旧hash和输入漂移，不重做已完成任务', async () => {
  let firstCalls = 0;
  let secondCalls = 0;
  /** 第二项任务持续失败，第一项任务成功证据须被保存。 */
  const generate: DevelopmentGenerator = async (config, role, execution, state, paths, extra) => {
    if (role === 'backend' && paths?.[0] === 'src/one.mjs') firstCalls++;
    if (role === 'backend' && paths?.[0] === 'src/two.mjs') {
      secondCalls++;
      await execution.writeFile(paths[0], '/** 失败角色的部分文件。 */\nexport function fixtureValue() { return 88; }\n');
      throw Object.assign(new Error('synthetic-network'), { code: 'ENOTFOUND' });
    }
    return generateDevelopment(config, role, execution, state, paths, extra);
  };
  // 持久化后创建新实例，确认不依赖失败进程的内存对象。
  await fixture(async (app, directory, config) => {
    const run = await app.workflow.createRun();
    assert.equal((await run.start({ inputData: app.input })).status, 'suspended');
    const saved = await pending(app, run.runId, 'recover-development');
    const hash = saved.state.recovery!.hash;
    assert.equal(saved.state.faults.length, 2);
    assert.deepEqual(saved.state.completedTasks, ['fixture-task-1']);
    assert.equal(firstCalls, 1);
    assert.equal(secondCalls, 2);
    assert.match(readFileSync(resolve(directory, 'candidate/src/two.mjs'), 'utf8'), /return 0/);
    await assert.rejects(recoverDevelopment(app, run.runId, review('0'.repeat(64), 'retry')), /版本/);
    await app.execution.close(); await app.storage.close();
    const drifted = { ...app.input, maxReworks: 0 };
    writeFileSync(resolve(directory, 'input.json'), JSON.stringify(drifted));
    const bad = openDevelopment(config, directory, true);
    try { await bad.storage.init(); await assert.rejects(recoverDevelopment(bad, run.runId, review(hash, 'retry')), /输入或模式/); }
    finally { await bad.execution.close(); await bad.storage.close(); }
    writeFileSync(resolve(directory, 'input.json'), JSON.stringify(app.input));
    /** 接续时统计角色调用，成功的第一任务不应再次调用。 */
    const resumedGenerate: DevelopmentGenerator = async (c, role, execution, state, paths, extra) => {
      if (role === 'backend' && paths?.[0] === 'src/one.mjs') firstCalls++;
      if (role === 'backend' && paths?.[0] === 'src/two.mjs') secondCalls++;
      return generateDevelopment(c, role, execution, state, paths, extra);
    };
    const reopened = openDevelopment(config, directory, true, resumedGenerate);
    try {
      await reopened.storage.init();
      await reopened.execution.writeFile('src/two.mjs', '/** 外部漂移。 */\nexport function fixtureValue() { return 66; }\n');
      await assert.rejects(recoverDevelopment(reopened, run.runId, review(hash, 'retry')), /检查点/);
      await reopened.execution.writeFile('src/two.mjs', app.input.project.files['src/two.mjs']);
      assert.equal((await recoverDevelopment(reopened, run.runId, review(hash, 'retry'))).status, 'success');
      const state = (await developmentStatus(reopened, run.runId)).result!;
      assert.equal(state.outcome, 'development-delivered');
      assert.equal(state.recoveries.length, 1);
      assert.equal(state.faults.length, 2);
      assert.equal(firstCalls, 1);
      assert.equal(secondCalls, 3);
      assert.ok(state.checks.every(
        // 恢复不能代替真实固定自检。
        (item) => item.exitCode === 0,
      ));
    } finally { await reopened.execution.close(); await reopened.storage.close(); }
  }, generate);
});

// 人工一次接续仍失败时终止，避免无限循环或把暂停当交付。
test('人工接续预算耗尽转人工处理，不重复无限重试', async () => {
  let calls = 0;
  /** 持续超时只发生在架构角色，不执行实现工具。 */
  const generate: DevelopmentGenerator = async (...args) => {
    calls++;
    throw Object.assign(new Error('fixture-timeout'), { name: 'MastraTimeoutError' });
  };
  // 首次两次调用后暂停，人工接续只再允许两次自动尝试。
  await fixture(async (app) => {
    const run = await app.workflow.createRun();
    assert.equal((await run.start({ inputData: app.input })).status, 'suspended');
    const hash = (await pending(app, run.runId, 'recover-development')).state.recovery!.hash;
    assert.equal((await recoverDevelopment(app, run.runId, review(hash, 'retry'))).status, 'success');
    const state = (await developmentStatus(app, run.runId)).result!;
    assert.equal(state.outcome, 'manual-attention');
    assert.equal(calls, 4);
    assert.equal(state.faults.length, 4);
    assert.equal(state.delivery, null);
  }, generate);
});

// 需求澄清创建新原生Run，不替换旧批准或修改历史结果。
test('评测澄清经新来源版本创建后续Run，重新等待技术方案确认', async () => {
  /** 仅旧需求输出明确阻塞，其余角色保持原生固定模型。 */
  const blocked: DevelopmentGenerator = async (config, role, execution, state, paths, extra) => {
    const entry = await generateDevelopment(config, role, execution, state, paths, extra);
    if (role !== 'architect') return entry;
    const plan = JSON.parse(entry.text);
    return { ...entry, text: JSON.stringify({ ...plan, blockers: ['产品需确认允许的数值。'] }) };
  };
  // 新目录只继承源码和来源链，旧方案批准与角色记录均不复制。
  await fixture(async (app, directory, config) => {
    const run = await app.workflow.createRun();
    await run.start({ inputData: app.input });
    const old = (await developmentStatus(app, run.runId)).result!;
    assert.equal(old.outcome, 'clarification-required');
    const nextDirectory = resolve(directory, '..', 'revised');
    await assert.rejects(clarifyDevelopment(app, run.runId, nextDirectory, { evaluationSource: app.input.source }, '确认1'), /新的已确认需求/);
    const content = '组织者补充合成规则：两个模块固定返回1。';
    const revised = await clarifyDevelopment(app, run.runId, nextDirectory, { evaluationSource: { ...app.input.source, content, hash: developmentHash(content) } }, '确认合成规则；不代表业务产品批准');
    assert.equal(revised.continuation?.runId, run.runId);
    assert.equal(revised.continuation?.authority, 'evaluation-revision');
    const next = openDevelopment(config, nextDirectory);
    try {
      await next.storage.init();
      const nextRun = await next.workflow.createRun();
      assert.equal((await nextRun.start({ inputData: next.input })).status, 'suspended');
      const nextState = (await pending(next, nextRun.runId, 'approve-architecture')).state;
      assert.equal(nextState.reviews.length, 0);
      assert.equal(nextState.approvedHash, null);
      assert.notEqual(nextState.planHash, old.planHash);
      assert.match(await next.execution.readFile('src/one.mjs'), /return 0/);
      assert.equal((await reviewDevelopment(next, nextRun.runId, review(nextState.planHash!))).status, 'success');
      assert.equal((await developmentStatus(next, nextRun.runId)).result?.outcome, 'development-delivered');
      assert.equal((await developmentStatus(app, run.runId)).result?.outcome, 'clarification-required');
    } finally { await next.execution.close(); await next.storage.close(); }
  }, blocked);
});

// 架构阻塞必须回到新方案批准关口，而不是直接重写接口。
test('实现阻塞带入架构返工，新方案hash使旧批准失效', async () => {
  let blocked = false;
  let architectureCalls = 0;
  /** 第一次实现发现契约问题，第二版方案明确携带该证据。 */
  const generate: DevelopmentGenerator = async (config, role, execution, state, paths, extra) => {
    const entry = await generateDevelopment(config, role, execution, state, paths, extra);
    if (role === 'architect') {
      architectureCalls++;
      if (architectureCalls === 2) {
        const prompt = JSON.parse(developmentPrompt(role, state));
        assert.match(prompt.implementationBlocker.text, /ARCHITECTURE_BLOCKER: 缺少契约/);
        const plan = JSON.parse(entry.text);
        return { ...entry, text: JSON.stringify({ ...plan, contracts: plan.contracts + ' 已补契约。' }) };
      }
    }
    if (role === 'backend' && !blocked) { blocked = true; return { ...entry, text: 'ARCHITECTURE_BLOCKER: 缺少契约，需重新审批。' }; }
    return entry;
  };
  // 两次暂停分别读取精确计划，旧hash不能审批新版本。
  await fixture(async (app) => {
    const run = await app.workflow.createRun();
    assert.equal((await run.start({ inputData: app.input })).status, 'suspended');
    const oldHash = (await pending(app, run.runId, 'approve-architecture')).state.planHash!;
    assert.equal((await reviewDevelopment(app, run.runId, review(oldHash))).status, 'suspended');
    const revised = (await pending(app, run.runId, 'approve-architecture')).state;
    assert.equal(architectureCalls, 2);
    assert.notEqual(revised.planHash, oldHash);
    assert.equal(revised.approvedHash, null);
    await assert.rejects(reviewDevelopment(app, run.runId, review(oldHash)), /版本/);
    assert.equal((await reviewDevelopment(app, run.runId, review(revised.planHash!))).status, 'success');
    assert.equal((await developmentStatus(app, run.runId)).result?.reviews.length, 2);
  }, generate, false);
});
