/** v2真实原生Workflow/Skill/LibSQL和受限工具回归，固定模型不代表业务质量。 */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { developmentHash } from '../src/development/contracts.js';
import { findingsHashV2, inputV2Schema, stateV2Schema, type StateV2 } from '../src/development/v2/contracts.js';
import { createAgentV2, generateV2, type GeneratorV2 } from '../src/development/v2/agents.js';
import { seedDevelopment, openDevelopment } from '../src/development-service.js';
import { approvedInputV2, clarifyDevelopmentV2, developmentStatusV2, openDevelopmentV2, readDevelopmentLocator, recoverDevelopmentV2, reviewDevelopmentV2, resolveDevelopmentFindingsV2, type ApplicationV2 } from '../src/development-v2-service.js';
import type { PracticeConfig } from '../src/mastra/config.js';
import { startDelivery, reviewDelivery, deliveryStatus } from '../src/delivery-service.js';
import { createApplication } from '../src/mastra/app.js';
import { startProductV2, reviewProductV2, productStatusV2 } from '../src/product-delivery-v2-service.js';
import { loadDevelopmentMethods } from '../src/development/v2/methods.js';
import { MastraLanguageModelV2Mock } from '@mastra/core/test-utils/llm-mock';
import { checksPassedV2 } from '../src/development/v2/gates.js';

const rootDir = resolve(fileURLToPath(new URL('..', import.meta.url)));
const initial = '/** 初始候选。 */\nexport function fixtureValue(){return 0;}\n';
/** 最小实际源码和不可写smoke，足以观测控制流、漂移和返工。 */
function input(maxReworks = 1) {
  const content = '固定合成需求：导出fixtureValue返回1。\n验收：调用结果为1。';
  return inputV2Schema.parse({ source: { kind: 'evaluation', runId: 'product-fixture', content, hash: developmentHash(content), evidence: 'evaluation-input' }, maxReworks, project: { id: 'v2-fixture', roles: ['backend'], writablePaths: ['src/solution.mjs'], checkFiles: ['smoke.test.mjs'], files: { 'src/solution.mjs': initial, 'smoke.test.mjs': 'import {test} from "node:test";\nimport assert from "node:assert/strict";\nimport {fixtureValue} from "./src/solution.mjs";\n/** 实际检查导出。 */\nfunction smoke(){assert.equal(fixtureValue(),1);}\ntest("fixture value",smoke);\n' } } });
}
/** 每例独占原生Store与OS隔离目录，不碰现有运行数据。 */
async function fixture(check: (app: ApplicationV2, directory: string, config: PracticeConfig) => Promise<void>, generate?: GeneratorV2, automatic = true, data = input()) {
  const parent = mkdtempSync(resolve(tmpdir(), 'mastra-development-v2-')); const directory = resolve(parent, 'run');
  seedDevelopment(directory, data);
  const config: PracticeConfig = { rootDir, mode: 'fixture', modelId: 'openai/fixture', port: 4111, databaseUrl: `file:${resolve(parent, 'product.db')}` };
  const app = openDevelopmentV2(config, directory, automatic, generate);
  try { await app.storage.init(); await check(app, directory, config); }
  finally { await app.execution.close(); await app.storage.close(); rmSync(parent, { recursive: true, force: true }); }
}
/** 从指定原生暂停点取当前状态，不递归搜索历史hash。 */
async function pending(app: ApplicationV2, runId: string, name: string): Promise<StateV2> {
  const status = await developmentStatusV2(app, runId); assert.equal(status.status, 'suspended');
  const step = status.steps?.[`development-iteration-v2.${name}`]; assert.ok(step && !Array.isArray(step));
  return stateV2Schema.parse(step.payload);
}
/** 本地标签只模拟方案批准，不作为账号认证。 */
function approval(hash: string) { return { hash, decision: 'approve', reviewer: 'fixture-owner', comment: '确认当前离线包' }; }
/** 本地故障接续必须绑定原失败phase。 */
function retry(hash: string) { return { hash, decision: 'retry', reviewer: 'fixture-owner', comment: '确认安全检查点' }; }

// 就绪前后、自检与评审均有原生证据，只有交付门能设置终态。
test('v2主路径真实读取四方法、写入、自检、独立评审后交付', async () => {
  await fixture(
    // 在独占执行目录和原生存储内验证本例的运行边界。
    async (app) => {
    const run = await app.workflow.createRun(); assert.equal((await run.start({ inputData: app.input })).status, 'success');
    const status = await developmentStatusV2(app, run.runId); const state = status.result!;
    assert.equal(state.outcome, 'development-delivered'); assert.equal(state.delivery?.version, 'development-delivery.v2');
    assert.equal(state.codeReviews.length, 1); assert.equal(state.readiness?.assessment.verdict, 'PASS');
    assert.ok(checksPassedV2(state)); assert.equal(state.gates.at(-1)?.decision, 'deliver');
    for (const role of ['context', 'architect', 'readiness', 'reviewer']) {
      const work = state.work.find(
        // 校验方法来自实际工具结果。
        (entry) => entry.role === role,
      )!; assert.ok(work.tools.includes('skill')); assert.ok(work.tools.includes('skill_read'));
    }
    const step = status.steps?.['development-iteration-v2.development-self-check']; assert.ok(step && !Array.isArray(step));
    assert.equal(stateV2Schema.parse(step.output).delivery, null);
    assert.equal(stateV2Schema.parse(step.output).outcome, 'in-progress');
    assert.equal(state.delivery?.sourceHash, developmentHash(await app.execution.snapshot()));
  });
});

// 批准绑定任务/上下文/就绪包，错误请求不消耗原生暂停。
test('v2等待真实人工批准，源码漂移和旧hash被拒绝且可重开恢复', async () => {
  await fixture(
    // 在独占执行目录和原生存储内验证本例的运行边界。
    async (app, directory, config) => {
    const run = await app.workflow.createRun(); assert.equal((await run.start({ inputData: app.input })).status, 'suspended');
    const state = await pending(app, run.runId, 'approve-architecture'); assert.equal(await app.execution.readFile('src/solution.mjs'), initial);
    assert.ok(state.context); assert.ok(state.plan?.tasks[0].acceptanceRefs.length); assert.equal(state.approvedHash, null);
    await assert.rejects(reviewDevelopmentV2(app, run.runId, approval('0'.repeat(64))), /版本/);
    await app.execution.writeFile('src/solution.mjs', initial + '\n// drift');
    await assert.rejects(reviewDevelopmentV2(app, run.runId, approval(state.approvalHash!)), /漂移/);
    await app.execution.writeFile('src/solution.mjs', initial);
    writeFileSync(resolve(directory, 'run.json'), JSON.stringify({ runId: run.runId, version: 'development-execution-v2', mode: 'fixture' }));
    await app.execution.close(); await app.storage.close();
    assert.throws(
      // 不能用旧执行工厂降级当前Run。
      () => openDevelopment(config, directory), /非v1/,
    );
    const next = openDevelopmentV2(config, directory);
    try { await next.storage.init(); assert.equal((await reviewDevelopmentV2(next, run.runId, approval(state.approvalHash!))).status, 'success'); assert.equal((await developmentStatusV2(next, run.runId)).result?.outcome, 'development-delivered'); }
    finally { await next.execution.close(); await next.storage.close(); }
  }, undefined, false);
});

// 报告不是空对象默认通过；主机引用约束不能被模型PASS绕过。
for (const failure of ['unknown-check', 'readiness-fail', 'reviewer-malformed', 'reviewer-blocking', 'missing-coverage']) {
  // 分别覆盖开工前结构、开工前语义和交付前评审失败。
  test(`v2门禁阻止${failure}交付`, async () => {
    /** 只在指定边界替换固定模型输出，真实工具继续运行。 */
    const generate: GeneratorV2 = async (...args) => {
      const entry = await generateV2(...args); const role = args[2]; const state = args[3];
      if (failure === 'unknown-check' && role === 'architect') { const plan = JSON.parse(entry.text); plan.tasks[0].verificationRefs = ['shell:echo-pass']; return { ...entry, text: JSON.stringify(plan) }; }
      if (failure === 'reviewer-malformed' && role === 'reviewer') return { ...entry, text: '{}' };
      if ((failure === 'readiness-fail' && role === 'readiness') || (failure === 'reviewer-blocking' && role === 'reviewer')) {
        const report = JSON.parse(entry.text); report.verdict = 'FAIL'; report.findings = [{ id: 'boundary', severity: 'blocking', category: 'integrity', route: 'human', detail: '模拟真实完整性阻塞', refs: [state.requirements[0].id], evidence: '固定故障注入，必须停止' }]; return { ...entry, text: JSON.stringify(report) };
      }
      if (failure === 'missing-coverage' && role === 'reviewer') { const report = JSON.parse(entry.text); report.coverageRefs = [state.requirements[0].id]; return { ...entry, text: JSON.stringify(report) }; }
      return entry;
    };
    await fixture(
      // 在独占执行目录和原生存储内验证本例的运行边界。
      async (app) => {
      const run = await app.workflow.createRun(); await run.start({ inputData: app.input });
      const status = await developmentStatusV2(app, run.runId); assert.equal(status.result?.delivery ?? null, null);
      if (failure === 'readiness-fail' || failure === 'reviewer-blocking') assert.equal(status.result?.outcome, 'manual-attention');
      else { const state = await pending(app, run.runId, 'recover-development'); assert.equal(state.recovery?.kind, 'invalid-output'); }
      if (failure.startsWith('readiness') || failure === 'unknown-check') assert.equal(await app.execution.readFile('src/solution.mjs'), initial);
    }, generate);
  });
}

// reviewer故障只能恢复review-code，不能重做写入或自检。
test('v2评审网络故障关闭重开后只重试评审，不重放已完成实现', async () => {
  let writes = 0; let reviews = 0;
  /** 前两次reviewer调用网络错误，其他角色真实运行原生fixture。 */
  const generate: GeneratorV2 = async (...args) => {
    if (args[2] === 'backend') writes++;
    if (args[2] === 'reviewer' && ++reviews <= 2) throw Object.assign(new Error('fixture-network'), { code: 'ECONNRESET' });
    return generateV2(...args);
  };
  await fixture(
    // 在独占执行目录和原生存储内验证本例的运行边界。
    async (app, directory, config) => {
    const run = await app.workflow.createRun(); await run.start({ inputData: app.input });
    const state = await pending(app, run.runId, 'recover-development'); assert.equal(state.phase, 'review-code'); assert.equal(writes, 1);
    await app.execution.close(); await app.storage.close();
    const next = openDevelopmentV2(config, directory, true, generate);
    try {
      await next.storage.init(); await assert.rejects(recoverDevelopmentV2(next, run.runId, retry('0'.repeat(64))), /版本/);
      assert.equal((await recoverDevelopmentV2(next, run.runId, retry(state.recovery!.hash))).status, 'success');
      assert.equal((await developmentStatusV2(next, run.runId)).result?.outcome, 'development-delivered'); assert.equal(writes, 1); assert.equal(reviews, 3);
    } finally { await next.execution.close(); await next.storage.close(); }
  }, generate);
});

// 实现缺陷只回责任角色，旧发现保留独立处理记录后重查才能放行。
test('v2缺陷返工重新检查和评审，保留原发现与修复结论', async () => {
  let reviews = 0;
  /** 第一次评审提出可修复问题，第二次独立确认对应ID修复。 */
  const generate: GeneratorV2 = async (...args) => {
    const entry = await generateV2(...args);
    if (args[2] !== 'reviewer') return entry;
    const report = JSON.parse(entry.text);
    if (++reviews === 1) { report.verdict = 'CONCERNS'; report.findings = [{ id: 'implementation-defect', severity: 'high', category: 'implementation', route: 'backend', detail: '模拟任务实现缺陷', refs: ['file:src/solution.mjs'], evidence: '独立固定审阅故障注入' }]; }
    else report.resolutions = [{ findingId: 'implementation-defect', decision: 'fixed', reason: '固定复查已读取当前文件并重新检查', refs: ['file:src/solution.mjs'] }];
    return { ...entry, text: JSON.stringify(report) };
  };
  await fixture(
    // 在独占执行目录和原生存储内验证本例的运行边界。
    async (app) => {
    const run = await app.workflow.createRun(); await run.start({ inputData: app.input });
    const state = (await developmentStatusV2(app, run.runId)).result!;
    assert.equal(state.outcome, 'development-delivered'); assert.equal(state.round, 1); assert.equal(state.codeReviews.length, 2); assert.equal(state.codeReviews[0].assessment.findings.length, 1); assert.equal(state.resolutions[0].findingId, 'implementation-defect');
    assert.equal(state.work.filter(
      // 责任实现按一次返工预算重跑。
      (item) => item.role === 'backend',
    ).length, 2);
  }, generate);
});

// 版本定位只负责路由，缺省旧版本不自动升级，未知版本拒绝。
test('版本定位缺省为v1且拒绝未知或伪造版本', () => {
  const directory = mkdtempSync(resolve(tmpdir(), 'development-locator-'));
  try {
    writeFileSync(resolve(directory, 'run.json'), JSON.stringify({ runId: 'old', mode: 'fixture' })); assert.equal(readDevelopmentLocator(directory).version, 'development-execution');
    writeFileSync(resolve(directory, 'run.json'), JSON.stringify({ runId: 'bad', mode: 'fixture', version: 'newest' })); assert.throws(
      // 不允许未知版本静默降级。
      () => readDevelopmentLocator(directory),
    );
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

// 新产品入口复用四角色，批准后不再生成开发/测试/运维提案。
test('产品v2批准后结束并可验证来源，未批准/错误Workflow拒绝', async () => {
  const directory = mkdtempSync(resolve(tmpdir(), 'product-delivery-v2-'));
  const app = createApplication({ rootDir, mode: 'fixture', modelId: 'openai/fixture', port: 4111, databaseUrl: `file:${resolve(directory, 'product.db')}` });
  try {
    await app.storage.init(); const product = await startProductV2(app, '工单标题校验'); assert.equal(product.pending?.role, 'product');
    await assert.rejects(approvedInputV2(app, product.runId, input().project), /未.*批准/);
    const hash = product.pending!.artifact.hash;
    const result = await reviewProductV2(app, product.runId, { role: 'product', artifactHash: hash, decision: 'approve', reviewer: 'owner', comment: '确认当前fixture产品' });
    assert.equal(result.result?.outcome, 'product-approved-for-development'); assert.equal(result.result?.artifacts.length, 1);
    assert.equal(result.result?.productWork?.entries.length, 4); assert.equal((await productStatusV2(app, product.runId)).pending, null);
    const approved = await approvedInputV2(app, product.runId, input().project); assert.equal(approved.source.workflowId, 'product-delivery-v2'); assert.equal(approved.source.hash, hash);
    const developmentDir = resolve(directory, 'development'); seedDevelopment(developmentDir, approved);
    assert.throws(
      // 真实产品来源不能使用评测自动批准。
      () => openDevelopmentV2(app.config, developmentDir, true), /自动批准规则/,
    );
    const development = openDevelopmentV2(app.config, developmentDir);
    try {
      await development.storage.init(); const run = await development.workflow.createRun();
      assert.equal((await run.start({ inputData: development.input })).status, 'suspended');
      const state = await pending(development, run.runId, 'approve-architecture');
      await reviewDevelopmentV2(development, run.runId, approval(state.approvalHash!));
      assert.equal((await developmentStatusV2(development, run.runId)).result?.delivery?.productHash, hash);
    } finally { await development.execution.close(); await development.storage.close(); }
    await assert.rejects(approvedInputV2(app, product.runId, input().project, 'unknown'));
    await assert.rejects(approvedInputV2(app, product.runId, input().project, 'product-delivery'), /未.*批准/);
  } finally { await app.storage.close(); rmSync(directory, { recursive: true, force: true }); }
});

// 关注项逐项裁决后产生新版就绪证据，批准仍需单独进行。
test('v2就绪关注项先暂停裁决，再等待新的方案包批准', async () => {
  /** 只在只读就绪报告注入需引用原文核实的误报。 */
  const generate: GeneratorV2 = async (...args) => {
    const entry = await generateV2(...args);
    if (args[2] !== 'readiness') return entry;
    const report = JSON.parse(entry.text); report.verdict = 'CONCERNS';
    report.findings = [{ id: 'ambiguous-rule', severity: 'medium', category: 'architecture', route: 'human', detail: '固定误报：规则可能未记录', refs: [args[3].requirements[0].id], evidence: '人工必须引用批准原文核实' }];
    return { ...entry, text: JSON.stringify(report) };
  };
  await fixture(
    // 在独占执行目录和原生存储内验证本例的运行边界。
    async (app) => {
    const run = await app.workflow.createRun(); await run.start({ inputData: app.input });
    const state = await pending(app, run.runId, 'resolve-readiness'); assert.equal(await app.execution.readFile('src/solution.mjs'), initial);
    const review = { hash: findingsHashV2(state), decision: 'resolve', reviewer: 'fixture-human', comment: '批准原文已明确', decisions: [{ reportHash: state.readiness!.hash, findingId: 'ambiguous-rule', decision: 'not-an-issue', reason: '批准原文第一行明确给出返回值', refs: [state.requirements[0].id] }] };
    await assert.rejects(resolveDevelopmentFindingsV2(app, run.runId, { ...review, decisions: [] }), /逐项/);
    assert.equal((await resolveDevelopmentFindingsV2(app, run.runId, review)).status, 'suspended');
    const approved = await pending(app, run.runId, 'approve-architecture'); assert.equal(approved.readinessHistory.length, 1); assert.equal(approved.readiness?.assessment.verdict, 'PASS');
    assert.equal((await reviewDevelopmentV2(app, run.runId, approval(approved.approvalHash!))).status, 'success');
    assert.equal((await developmentStatusV2(app, run.runId)).result?.outcome, 'development-delivered');
  }, generate, false);
});

// 低严重性延期必须显式披露，严重问题不能使用同样的人工评论放行。
for (const severity of ['low', 'high'] as const) {
  // 每例保留实际自检和评审报告，单独验证裁决门的严重性边界。
  test(`v2人工裁决对${severity}问题执行延期约束并绑定源码`, async () => {
    /** 只注入需人工判断的发现，不篡改检查结果。 */
    const generate: GeneratorV2 = async (...args) => {
      const entry = await generateV2(...args);
      if (args[2] !== 'reviewer') return entry;
      const report = JSON.parse(entry.text); report.verdict = 'CONCERNS'; report.findings = [{ id: 'review-finding', severity, category: 'verification', route: 'human', detail: '固定待处理评审问题', refs: ['file:src/solution.mjs'], evidence: 'fixture注入一项需人工决策的关注' }];
      return { ...entry, text: JSON.stringify(report) };
    };
    await fixture(
      // 在独占执行目录和原生存储内验证本例的运行边界。
      async (app) => {
      const run = await app.workflow.createRun(); await run.start({ inputData: app.input });
      const state = await pending(app, run.runId, 'resolve-findings');
      const review = { hash: findingsHashV2(state), reviewer: 'fixture-owner', comment: '逐项处理审阅', decision: 'resolve', decisions: [{ reportHash: state.codeReviews.at(-1)!.hash, findingId: 'review-finding', decision: 'defer', reason: '保留低优先级改进待后续验证', refs: ['file:src/solution.mjs'] }] };
      const current = await app.execution.readFile('src/solution.mjs');
      await app.execution.writeFile('src/solution.mjs', initial);
      await assert.rejects(resolveDevelopmentFindingsV2(app, run.runId, review), /漂移/);
      await app.execution.writeFile('src/solution.mjs', current);
      if (severity === 'high') {
        await assert.rejects(resolveDevelopmentFindingsV2(app, run.runId, review), /严重/);
        await resolveDevelopmentFindingsV2(app, run.runId, { ...review, decision: 'stop', decisions: [] });
        assert.equal((await developmentStatusV2(app, run.runId)).result?.delivery, null);
      } else {
        await resolveDevelopmentFindingsV2(app, run.runId, review);
        const result = (await developmentStatusV2(app, run.runId)).result!;
        assert.equal(result.delivery?.resolutions.at(-1)?.decision, 'defer'); assert.equal(result.codeReviews[0].assessment.findings.length, 1);
      }
    }, generate);
  });
}

// 持续故障接续一次后终止，预算不因失败阶段重新进入而重置。
test('v2故障接续预算耗尽不会无限循环或直接交付', async () => {
  /** 只读角色持续超时，不写候选文件。 */
  const generate: GeneratorV2 = async () => { throw Object.assign(new Error('fixture-timeout'), { name: 'MastraTimeoutError' }); };
  await fixture(
    // 在独占执行目录和原生存储内验证本例的运行边界。
    async (app) => {
    const run = await app.workflow.createRun(); await run.start({ inputData: app.input });
    const state = await pending(app, run.runId, 'recover-development');
    await recoverDevelopmentV2(app, run.runId, retry(state.recovery!.hash));
    const result = (await developmentStatusV2(app, run.runId)).result!;
    assert.equal(result.outcome, 'manual-attention'); assert.equal(result.calls, 4); assert.equal(result.delivery, null);
  }, generate);
});

// 缺失检查和超时不能用零退出码或模型通过声明掩盖。
test('v2缺失或失败检查证据不能通过宿主交付门', async () => {
  await fixture(
    // 在独占执行目录和原生存储内验证本例的运行边界。
    async (app) => {
    const run = await app.workflow.createRun(); await run.start({ inputData: app.input });
    const state = (await developmentStatusV2(app, run.runId)).result!;
    assert.equal(checksPassedV2({ ...state, checks: [] }), false);
    assert.equal(checksPassedV2({ ...state, checks: state.checks.slice(1) }), false);
    assert.equal(checksPassedV2({ ...state, checks: state.checks.map(
      // 超时即便原始退出码0也不得放行。
      (check) => ({ ...check, timedOut: true }),
    ) }), false);
  });
});

// 架构重新规划始终重新准备上下文/就绪和人工批准，预算不重置。
test('v2架构阻塞重新生成绑定包并拒绝旧批准', async () => {
  let implementations = 0;
  /** 第一次实现报告架构阻塞，后续保留实际工具执行。 */
  const generate: GeneratorV2 = async (...args) => {
    const entry = await generateV2(...args);
    if (args[2] === 'backend' && ++implementations === 1) return { ...entry, text: 'ARCHITECTURE_BLOCKER: 固定契约变更，必须重新批准' };
    return entry;
  };
  await fixture(
    // 在独占执行目录和原生存储内验证本例的运行边界。
    async (app) => {
    const run = await app.workflow.createRun(); await run.start({ inputData: app.input });
    const first = await pending(app, run.runId, 'approve-architecture');
    await reviewDevelopmentV2(app, run.runId, approval(first.approvalHash!));
    const next = await pending(app, run.runId, 'approve-architecture');
    assert.notEqual(next.approvalHash, first.approvalHash); assert.equal(next.round, 1); assert.ok(next.calls > first.calls);
    await assert.rejects(reviewDevelopmentV2(app, run.runId, approval(first.approvalHash!)), /版本/);
    await reviewDevelopmentV2(app, run.runId, approval(next.approvalHash!));
    assert.equal((await developmentStatusV2(app, run.runId)).result?.outcome, 'development-delivered');
  }, generate, false);
});

// 就绪语义调用重开后停在原阶段，不重跑已完成上下文/架构。
test('v2就绪故障恢复只接续就绪且拒绝执行身份漂移', async () => {
  const calls: Record<string, number> = {};
  /** 就绪前两次失败，其他调用按实际原生模型与工具执行。 */
  const generate: GeneratorV2 = async (...args) => {
    const role = args[2]; calls[role] = (calls[role] ?? 0) + 1;
    if (role === 'readiness' && calls[role] <= 2) throw Object.assign(new Error('fixture-network'), { code: 'ECONNRESET' });
    return generateV2(...args);
  };
  await fixture(
    // 在独占执行目录和原生存储内验证本例的运行边界。
    async (app, directory, config) => {
    const run = await app.workflow.createRun(); await run.start({ inputData: app.input });
    const state = await pending(app, run.runId, 'recover-development'); assert.equal(state.phase, 'assess-readiness');
    await app.execution.close(); await app.storage.close();
    const changed = openDevelopmentV2({ ...config, modelId: 'openai/other-model' }, directory, true, generate);
    try { await changed.storage.init(); await assert.rejects(recoverDevelopmentV2(changed, run.runId, retry(state.recovery!.hash)), /漂移/); }
    finally { await changed.execution.close(); await changed.storage.close(); }
    const next = openDevelopmentV2(config, directory, true, generate);
    try {
      await next.storage.init(); await recoverDevelopmentV2(next, run.runId, retry(state.recovery!.hash));
      assert.equal((await developmentStatusV2(next, run.runId)).result?.outcome, 'development-delivered'); assert.equal(calls.context, 1); assert.equal(calls.architect, 1); assert.equal(calls.readiness, 3);
    } finally { await next.execution.close(); await next.storage.close(); }
  }, generate);
});

// 自检失败不可进入只读评审，真实失败证据决定有界返工。
test('v2检查持续失败按业务预算停止，不生成评审和交付', async () => {
  const data = input(); data.project.files['smoke.test.mjs'] = data.project.files['smoke.test.mjs'].replace('fixtureValue(),1', 'fixtureValue(),2');
  await fixture(
    // 在独占执行目录和原生存储内验证本例的运行边界。
    async (app) => {
    const run = await app.workflow.createRun(); await run.start({ inputData: app.input });
    const state = (await developmentStatusV2(app, run.runId)).result!;
    assert.equal(state.outcome, 'rework-exhausted'); assert.equal(state.round, 1); assert.equal(state.codeReviews.length, 0); assert.equal(state.delivery, null);
  }, undefined, true, data);
});

// v2开发显式兼容旧产品批准来源，不截断旧提案链或读取未知Workflow。
test('v2来源resolver可读取显式指定的旧产品批准事实', async () => {
  const directory = mkdtempSync(resolve(tmpdir(), 'development-v2-old-source-'));
  const app = createApplication({ rootDir, mode: 'fixture', modelId: 'openai/fixture', port: 4111, databaseUrl: `file:${resolve(directory, 'product.db')}` });
  try {
    await app.storage.init(); const product = await startDelivery(app, '工单标题校验');
    await reviewDelivery(app, product.runId, { role: 'product', artifactHash: product.pending!.artifact.hash, decision: 'approve', reviewer: 'owner', comment: '批准fixture' });
    const source = await approvedInputV2(app, product.runId, input().project, 'product-delivery'); assert.equal(source.source.workflowId, 'product-delivery');
    assert.equal((await deliveryStatus(app, product.runId)).pending?.role, 'development');
  } finally { await app.storage.close(); rmSync(directory, { recursive: true, force: true }); }
});

// 业务澄清使用新批准产品和独立后继，旧运行证据保持原样。
test('v2业务澄清只接受新批准产品，后继重新准备和批准且保留旧Run', async () => {
  const directory = mkdtempSync(resolve(tmpdir(), 'development-v2-clarification-'));
  const config: PracticeConfig = { rootDir, mode: 'fixture', modelId: 'openai/fixture', port: 4111, databaseUrl: `file:${resolve(directory, 'product.db')}` };
  const product = createApplication(config);
  /** 固定业务歧义只阻塞当前架构，不写入源码。 */
  const blocked: GeneratorV2 = async (...args) => {
    const entry = await generateV2(...args);
    if (args[2] !== 'architect') return entry;
    const plan = JSON.parse(entry.text); plan.blockers = ['批准产品未明确异常输入边界'];
    return { ...entry, text: JSON.stringify(plan) };
  };
  try {
    await product.storage.init();
    const original = await startProductV2(product, '工单标题校验');
    await reviewProductV2(product, original.runId, { role: 'product', artifactHash: original.pending!.artifact.hash, decision: 'approve', reviewer: 'owner', comment: '批准初版' });
    const previousDirectory = resolve(directory, 'previous');
    seedDevelopment(previousDirectory, await approvedInputV2(product, original.runId, input().project));
    const previous = openDevelopmentV2(config, previousDirectory, false, blocked);
    try {
      await previous.storage.init(); const run = await previous.workflow.createRun();
      await run.start({ inputData: previous.input });
      const before = (await developmentStatusV2(previous, run.runId)).result!;
      assert.equal(before.outcome, 'clarification-required'); assert.equal(before.delivery, null);
      assert.equal(await previous.execution.readFile('src/solution.mjs'), initial);
      const nextDirectory = resolve(directory, 'next');
      await assert.rejects(clarifyDevelopmentV2(previous, run.runId, nextDirectory, product, original.runId, '补充边界'), /新的批准产品版本/);
      const revised = await startProductV2(product, '工单标题校验：明确空标题拒绝');
      await reviewProductV2(product, revised.runId, { role: 'product', artifactHash: revised.pending!.artifact.hash, decision: 'approve', reviewer: 'owner', comment: '确认异常边界' });
      await previous.execution.writeFile('src/solution.mjs', initial + '\n// drift');
      await assert.rejects(clarifyDevelopmentV2(previous, run.runId, nextDirectory, product, revised.runId, '补充边界'), /漂移/);
      await previous.execution.writeFile('src/solution.mjs', initial);
      const nextInput = await clarifyDevelopmentV2(previous, run.runId, nextDirectory, product, revised.runId, '补充边界');
      assert.notEqual(nextInput.source.hash, before.input.source.hash);
      assert.equal(nextInput.continuation?.runId, run.runId); assert.equal(nextInput.continuation?.sourceHash, before.input.source.hash);
      assert.equal(nextInput.continuation?.candidateHash, before.checkpointHash); assert.equal(nextInput.maxReworks, before.input.maxReworks);
      const next = openDevelopmentV2(config, nextDirectory);
      try {
        await next.storage.init(); const successor = await next.workflow.createRun();
        await successor.start({ inputData: next.input });
        const state = await pending(next, successor.runId, 'approve-architecture');
        assert.equal(state.approvedHash, null); assert.equal(state.reviews.length, 0); assert.equal(state.codeReviews.length, 0);
        assert.equal(state.context?.productHash, revised.pending!.artifact.hash);
        await reviewDevelopmentV2(next, successor.runId, approval(state.approvalHash!));
        assert.equal((await developmentStatusV2(next, successor.runId)).result?.outcome, 'development-delivered');
      } finally { await next.execution.close(); await next.storage.close(); }
      assert.deepEqual((await developmentStatusV2(previous, run.runId)).result, before);
    } finally { await previous.execution.close(); await previous.storage.close(); }
  } finally { await product.storage.close(); rmSync(directory, { recursive: true, force: true }); }
});

// 新产品退回在独立后继重走四角色，不覆盖旧批准事实。
test('产品v2退回生成唯一后继并重新等待产品批准', async () => {
  const directory = mkdtempSync(resolve(tmpdir(), 'product-v2-rework-'));
  const app = createApplication({ rootDir, mode: 'fixture', modelId: 'openai/fixture', port: 4111, databaseUrl: `file:${resolve(directory, 'product.db')}` });
  try {
    await app.storage.init(); const product = await startProductV2(app, '工单标题校验');
    const review = { role: 'product', artifactHash: product.pending!.artifact.hash, decision: 'rework', reviewer: 'owner', comment: '补充异常边界' };
    const next = await reviewProductV2(app, product.runId, review); assert.notEqual(next.runId, product.runId); assert.equal(next.pending?.role, 'product');
    assert.equal((await productStatusV2(app, product.runId)).result?.outcome, 'rework-requested');
    assert.equal((await reviewProductV2(app, product.runId, review)).runId, next.runId);
    await assert.rejects(approvedInputV2(app, product.runId, input().project), /未.*批准/);
  } finally { await app.storage.close(); rmSync(directory, { recursive: true, force: true }); }
});

// 所选方法的原生读取不能扩展为其他技能或宿主路径读取。
test('v2只读评审角色只注册必要方法且原生skill_read拒绝越界', async () => {
  await fixture(
    // 在独占执行目录和原生存储内验证本例的运行边界。
    async (app) => {
    const run = await app.workflow.createRun(); await run.start({ inputData: app.input });
    const state = await pending(app, run.runId, 'approve-architecture');
    const agent = createAgentV2(app.config, app.execution, 'reviewer', state, [], loadDevelopmentMethods(rootDir));
    assert.deepEqual((await agent.listSkills()).map(
      // 不挂完整产品套件或其他开发方法。
      (item) => item.name,
    ), ['development-bmad-code-review']);
    assert.deepEqual(Object.keys(await agent.listTools()).sort(), ['readFile']);
    let index = 0;
    const calls = [
      { name: 'skill', input: { name: 'development-bmad-code-review' } },
      { name: 'skill_read', input: { skillName: 'development-bmad-code-review', path: '../../../../../package.json' } },
      { name: 'skill_read', input: { skillName: 'unregistered-method', path: 'references/upstream.md' } },
    ];
    const result = await agent.generate('只验证原生方法权限', { maxSteps: 6, model: new MastraLanguageModelV2Mock({
      // 第一次违规结果必须进入原生错误工具上下文，后续返回固定终答。
      doGenerate: async (options) => {
        if (index === 2) assert.match(JSON.stringify(options.prompt), /Invalid asset path/);
        const call = calls[index++];
        return { content: call ? [{ type: 'tool-call' as const, toolCallId: `scope-${index}`, toolName: call.name, input: JSON.stringify(call.input) }] : [{ type: 'text' as const, text: '已完成范围验证' }], finishReason: call ? 'tool-calls' as const : 'stop' as const, usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 }, warnings: [] };
      },
    }) });
    assert.match(JSON.stringify(result.toolResults.at(-1)?.payload.result), /not found/);
    assert.equal(await app.execution.readFile('src/solution.mjs'), initial);
  }, undefined, false);
});

// 不记录模型正文、任意错误或SDK请求，只持久化固定约束代码。
for (const mismatch of [{ field: 'verificationRefs', code: 'check-ref-unregistered' }, { field: 'contextRefs', code: 'context-ref-unknown' }]) {
// 两种引用域错误都必须持久化诊断并保持失败关闭。
test(`v2架构诊断持久化且脱敏：${mismatch.code}`, async () => {
  /** 仍真实读取方法，随后注入一个未登记检查引用。 */
  const generate: GeneratorV2 = async (...args) => {
    const entry = await generateV2(...args);
    if (args[2] !== 'architect') return entry;
    const plan = JSON.parse(entry.text); plan.tasks[0][mismatch.field] = ['secret-injected-check'];
    return { ...entry, text: JSON.stringify(plan) };
  };
  await fixture(
    /** 从原生持久快照核对脱敏诊断，不信任内存错误对象。 */
    async (app) => {
      const run = await app.workflow.createRun(); assert.equal((await run.start({ inputData: app.input })).status, 'suspended');
      const state = await pending(app, run.runId, 'recover-development');
      assert.deepEqual(state.faults[0].diagnostic, { stage: 'constraint', code: mismatch.code });
      assert.deepEqual(state.recovery?.diagnostic, state.faults[0].diagnostic);
      assert.ok(!JSON.stringify(state.faults).includes('secret-injected-check'));
      assert.equal(state.work.some(/** 失败方案不能形成有效方案证据。 */(entry) => entry.role === 'architect'), false);
    }, generate,
  );
});

}
