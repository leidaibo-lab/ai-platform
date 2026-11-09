/** 自主开发的真实Workflow/候选I/O回归；合成模型只注入故障，不代表真实模型质量。 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { Mastra } from '@mastra/core';
import { LibSQLStore } from '@mastra/libsql';
import { MastraLanguageModelV2Mock } from '@mastra/core/test-utils/llm-mock';
import { DevelopmentExecution } from '../src/development-execution.js';
import { seedDevelopment } from '../src/development-service.js';
import { developmentHash } from '../src/development/contracts.js';
import { inputV2Schema, stateV2Schema, type InputV2, type StateV2 } from '../src/development/v2/contracts.js';
import { createDevelopmentWorkflowV2 } from '../src/mastra/workflows/development-v2.js';
import { createAgentV2, generateV2, type GeneratorV2 } from '../src/development/v2/agents.js';
import { loadDevelopmentMethods } from '../src/development/v2/methods.js';
import { runVerification, verificationScope, VerificationBudgetError } from '../src/development/v2/autonomy.js';
import type { PracticeConfig } from '../src/mastra/config.js';

/** 源码变化由真实工具完成；固定检查文件始终不可写。 */
function source(value: number, round = 0) { return `/** 第${round}轮候选。 */\nexport function fixtureValue(){return ${value};}\n`; }
/** 新政策显式绑定批准输入，历史输入不自动获得自主权限。 */
function input(): InputV2 {
  const content = '返回值为1，并由实际固定检查验证。';
  return inputV2Schema.parse({ autonomy: { version: 'autonomy.v1' }, maxReworks: 3, source: { kind: 'evaluation', runId: 'autonomy-evaluation', hash: developmentHash(content), content, evidence: 'evaluation-input' }, project: { id: 'autonomy', roles: ['backend'], files: { 'src/a.mjs': source(0), 'check.mjs': 'import {test} from "node:test";\nimport assert from "node:assert/strict";\nimport {fixtureValue} from "./src/a.mjs";\n/** 检验真实返回值。 */\nfunction checkValue(){assert.equal(fixtureValue(),1); }\ntest("value",checkValue);\n' }, writablePaths: ['src/a.mjs'], checkFiles: ['check.mjs'] } });
}
/** 每例独占目录与原生Store，业务自动批准仅用于明确合成来源。 */
async function harness(data: InputV2, generate: GeneratorV2, check: (result: any, execution: DevelopmentExecution, config: PracticeConfig, workflow: ReturnType<typeof createDevelopmentWorkflowV2>, storage: LibSQLStore) => Promise<void>, team = true, environmentFailure = false) {
  const parent = mkdtempSync(resolve(tmpdir(), 'mastra-autonomy-')); const directory = resolve(parent, 'run');
  seedDevelopment(directory, data);
  const config: PracticeConfig = { rootDir: resolve('.'), mode: 'fixture', modelId: 'openai/fixture', port: 4111, databaseUrl: `file:${resolve(parent, 'workflow.db')}` };
  const execution = new DevelopmentExecution(resolve(directory, 'candidate'), data.project.writablePaths, data.project.checkFiles);
  const actualChecks = execution.runChecks.bind(execution); let attempts = 0;
  if (environmentFailure) execution.runChecks = /** 环境中断后仍只重试同一登记检查，不修宿主或联网安装。 */async () => { if (++attempts <= 2) throw new Error('synthetic-private-error'); return actualChecks(); };
  const workflow = createDevelopmentWorkflowV2(config, execution, true, generate, { team });
  const storage = new LibSQLStore({ id: 'autonomy-test', url: config.databaseUrl }); new Mastra({ storage, workflows: { workflow } });
  try { await storage.init(); const run = await workflow.createRun(); const result = await run.start({ inputData: data }); await check({ ...result, runId: run.runId }, execution, config, workflow, storage); }
  finally { await execution.close(); await storage.close(); rmSync(parent, { recursive: true, force: true }); }
}

for (const scenario of ['repair', 'changing-error', 'no-progress']) {
  test(`失败检查证据持续传给真实修复任务：${scenario}`, /** 按真实退出码返工，保留命令、源码版本和历史，而非注入通过结论。 */async () => {
    const seen: StateV2[] = [];
    /** 只替代实现策略：首次缺陷、两种不同缺陷、或持续同一缺陷。 */
    const generate: GeneratorV2 = async (...args) => {
      const entry = await generateV2(...args); const state = args[3]; const runtime = args[7];
      if (runtime && !runtime.delegate) {
        seen.push(state);
        const value = scenario === 'no-progress' || state.round === 0 ? 0 : scenario === 'changing-error' && state.round === 1 ? 2 : 1;
        await args[1].writeFile(args[4][0], source(value, state.round));
      }
      if (args[2] === 'self-check') return { ...entry, text: JSON.stringify({ summary: '固定检查失败时由批准团队协同定位', route: scenario === 'repair' ? 'frontend' : 'human' }) };
      return entry;
    };
    await harness(input(), generate, /** 交付与停止必须由真实Workflow决定。 */async (result, execution, config, workflow, storage) => {
      assert.equal(result.status, 'success'); const state: StateV2 = result.result;
      assert.equal(state.outcome, scenario === 'no-progress' ? 'rework-exhausted' : 'development-delivered');
      assert.equal(state.round, scenario === 'repair' ? 1 : 2);
      const repaired = seen.find(/** 返工后的输入必须持有前次失败证据。 */item => item.round === 1)!;
      assert.ok(repaired.verificationHistory?.some(/** 历史失败不是当前检查数组的别名。 */item => item.checks.some(/** 退出码和公开日志来自真实进程。 */check => check.exitCode !== 0 && check.command.includes('node') && (check.stderr + check.stdout).includes('AssertionError'))));
      assert.equal(repaired.checks.length, 0);
      assert.ok(state.verificationHistory!.every(/** 每次执行都有唯一顺序及实际源码散列。 */(record, index) => record.sequence === index + 1 && record.sourceHash.length === 64));
      if (scenario === 'no-progress') { assert.equal(state.stopReason, 'no-progress'); assert.equal(state.repairHistory!.at(-1)!.noProgress, 2); assert.equal(state.delivery, null); }
      else { assert.match(await execution.readFile('src/a.mjs'), /return 1/); assert.equal(state.delivery!.sourceHash, state.verificationHistory!.at(-1)!.sourceHash); }
      await storage.close();
      const reopened = new LibSQLStore({ id: 'autonomy-reopen', url: config.databaseUrl });
      const nextWorkflow = createDevelopmentWorkflowV2(config, execution, true, generate, { team: true }); new Mastra({ storage: reopened, workflows: { workflow: nextWorkflow } });
      try { await reopened.init(); const saved = await nextWorkflow.getWorkflowRunById(result.runId); assert.deepEqual((saved!.result as StateV2).verificationHistory, state.verificationHistory); }
      finally { await reopened.close(); }
    });
  });
}

test('跨前后端共同修复并重跑依赖下游，无关已完成任务保留', /** 真实并行、补丁合并、自检及独立复评均经原生Workflow。 */async () => {
  const data = input(); data.project.roles = ['frontend', 'backend', 'infrastructure'];
  data.project.writablePaths = ['src/a.mjs', 'src/b.mjs', 'src/downstream.mjs', 'src/unrelated.mjs'];
  for (const path of data.project.writablePaths) data.project.files[path] = source(0);
  data.project.files['check.mjs'] = 'import {test} from "node:test";\nimport assert from "node:assert/strict";\nimport {fixtureValue as a} from "./src/a.mjs";\nimport {fixtureValue as b} from "./src/b.mjs";\nimport {fixtureValue as c} from "./src/downstream.mjs";\n/** 检验实际前后端及下游一致。 */\nfunction checkContract(){assert.equal(a(),b());assert.equal(b(),c());}\ntest("contract",checkContract);\n';
  const executions: string[] = [];
  /** 控制首轮共同缺陷；第二轮必须在同一批准内修复并复评旧发现。 */
  const generate: GeneratorV2 = async (...args) => {
    const entry = await generateV2(...args); const role = args[2]; const state = args[3];
    if (role === 'architect') { const plan = JSON.parse(entry.text); plan.tasks[0].role = 'frontend'; plan.tasks[1].role = 'backend'; plan.tasks[2].role = 'backend'; plan.tasks[2].dependsOn = [plan.tasks[1].id]; plan.tasks[3].role = 'infrastructure'; return { ...entry, text: JSON.stringify(plan) }; }
    if (args[7] && !args[7].delegate) { executions.push(`${state.round}:${args[4][0]}`); if (args[4][0].includes('downstream')) assert.match(await args[1].readFile('src/b.mjs'), new RegExp(`return ${state.round ? 1 : 0}`)); await args[1].writeFile(args[4][0], source(state.round ? 1 : 0)); }
    if (role === 'reviewer') {
      const report = JSON.parse(entry.text);
      if (state.round === 0) { report.verdict = 'FAIL'; report.findings = ['frontend', 'backend'].map(/** 两个实际责任归属，不能被合成PASS覆盖。 */(route, i) => ({ id: `F${i}`, category: 'implementation', severity: 'high', route, detail: '共同约定返回值应为1', refs: [`file:src/${i ? 'b' : 'a'}.mjs`], evidence: '源码返回0' })); }
      else report.resolutions = ['F0', 'F1'].map(/** 复评逐条绑定旧ID和实际代码。 */(findingId, i) => ({ findingId, decision: 'fixed', reason: '当前实际代码返回1', refs: [`file:src/${i ? 'b' : 'a'}.mjs`] }));
      return { ...entry, text: JSON.stringify(report) };
    }
    return entry;
  };
  await harness(data, generate, /** 无需重新批准方案即可共同修复，仍须重新检查与复评。 */async result => {
    assert.equal(result.status, 'success'); const state: StateV2 = result.result;
    assert.equal(state.outcome, 'development-delivered'); assert.equal(state.round, 1); assert.equal(state.reviews.length, 1);
    assert.equal(executions.filter(/** 无关基础设施任务保持完成。 */item => item.endsWith('src/unrelated.mjs')).length, 1);
    assert.ok(executions.includes('1:src/downstream.mjs')); assert.equal(state.resolutions.length, 2); assert.equal(state.codeReviews.length, 2);
  });
});

test('环境失败保留分类证据，下一轮只在原授权内重试检查', /** 不把环境异常正文写入模型或日志，也不回退宿主命令。 */async () => {
  await harness(input(), generateV2, /** 临时环境恢复后继续，不要求人工重填需求。 */async result => {
    assert.equal(result.status, 'success'); const state: StateV2 = result.result;
    assert.equal(state.outcome, 'development-delivered'); assert.equal(state.repairHistory![0].kind, 'environment');
    assert.doesNotMatch(JSON.stringify(state.verificationHistory), /synthetic-private-error/);
  }, true, true);
});

for (const marker of ['BUSINESS_BLOCKER:', 'AUTHORIZATION_BLOCKER:']) {
  test(`明确边界阻塞才升级人工：${marker}`, /** 子任务报告也必须传播，父成员不能吞掉阻塞后交付。 */async () => {
    /** 仅在真实子实现结果附加阻塞，不篡改宿主状态。 */
    const generate: GeneratorV2 = async (...args) => { const entry = await generateV2(...args); return args[7] && !args[7].delegate ? { ...entry, text: marker + '需要新的决定或授权' } : entry; };
    await harness(input(), generate, /** 终态不产生交付。 */async result => { assert.equal(result.status, 'success'); assert.equal(result.result.stopReason, marker.startsWith('BUSINESS') ? 'business-decision' : 'authorization-required'); assert.equal(result.result.delivery, null); });
  });
}

test('受控检查工具向实现者开放；执行额度不能被吞掉工具错误绕过', /** 调用真实原生工具，拒绝写检查文件及提供任意命令。 */async () => {
  const data = input(); data.autonomy!.maxCheckRuns = 2;
  await harness(data, generateV2, /** 完成后利用保存状态单独验证工具，不污染交付证据。 */async (result, execution, config) => {
    const state = stateV2Schema.parse(result.result); const methods = loadDevelopmentMethods(config.rootDir);
    const scope = verificationScope(execution, { ...state, verificationHistory: [] }, 'backend', ['src/a.mjs']);
    const agent = createAgentV2(config, scope.port, 'backend', state, ['src/a.mjs'], methods);
    assert.deepEqual(Object.keys(await agent.listTools()).sort(), ['readFile', 'runChecks', 'writeFile']);
    const calls = ['runChecks', 'runChecks', 'runChecks']; let i = 0;
    await agent.generate('执行登记检查', { maxSteps: 4, model: new MastraLanguageModelV2Mock({
      /** 第三次返回工具错误，实际进程执行仍只能两次。 */
      doGenerate: async () => { const name = calls[i++]; return { content: name ? [{ type: 'tool-call' as const, toolCallId: `check-${i}`, toolName: name, input: '{}' }] : [{ type: 'text' as const, text: 'done' }], finishReason: name ? 'tool-calls' as const : 'stop' as const, usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 }, warnings: [] }; },
    }) });
    assert.equal(scope.history()!.length, 2); assert.equal(scope.exhausted(), true);
    await assert.rejects(/** 检查文件不能改。 */() => execution.writeFile('check.mjs', 'pass'), /白名单|写入|范围/);
    await assert.rejects(/** 额度上限在模型外再次执行也必须拒绝。 */() => runVerification(execution, { ...state, verificationHistory: scope.history() }, 'backend', [], 'tool'), VerificationBudgetError);
  });
});

test('格式错误自主带诊断修正，保留schema门禁和失败调用', /** 同一阶段修正报告，不重放实现。 */async () => {
  let reviews = 0;
  /** 首次无效，第二次必须拿到安全诊断。 */
  const generate: GeneratorV2 = async (...args) => {
    if (args[2] === 'reviewer' && ++reviews === 1) return { role: 'reviewer', round: args[3].round, text: '{}', tools: [], steps: 1, modelId: null, inputTokens: null, outputTokens: null };
    if (args[2] === 'reviewer') assert.ok((args[5] as any).retryDiagnostic);
    return generateV2(...args);
  };
  await harness(input(), generate, /** 实际实现只执行一次，格式修正消耗累计调用。 */async result => { assert.equal(result.status, 'success'); assert.equal(result.result.outcome, 'development-delivered'); assert.equal(reviews, 2); assert.equal(result.result.faults.length, 1); assert.equal(result.result.faults[0].kind, 'invalid-output'); });
});

for (const scenario of ['verification-budget', 'repair-budget', 'failed-branch-evidence']) {
  test(`失败分支和硬预算：${scenario}`, /** 经过父子委派与原生持久化，不能仅在工具单测里验证额度。 */async () => {
    const data = input(); if (scenario === 'verification-budget') data.autonomy!.maxCheckRuns = 2;
    if (scenario === 'repair-budget') data.maxReworks = 0;
    /** 用真实候选缺陷或工具故障触发宿主处理。 */
    const generate: GeneratorV2 = async (...args) => {
      const entry = await generateV2(...args);
      if (args[7] && !args[7].delegate) {
        if (scenario === 'repair-budget') await args[1].writeFile(args[4][0], source(0));
        else { await args[1].runChecks(); if (scenario === 'failed-branch-evidence') throw new SyntaxError('controlled-invalid-member'); }
      }
      return entry;
    };
    await harness(data, generate, /** 失败分支的检查事实必须保留，即使补丁被回滚。 */async result => {
      if (scenario === 'failed-branch-evidence') {
        assert.equal(result.status, 'suspended');
        const payload = Object.values(result.steps as Record<string, any>).find(/** 读取原生叶节点暂停载荷。 */step => step.suspendPayload?.recoveryState)?.suspendPayload;
        assert.ok(payload); const state = stateV2Schema.parse(payload.recoveryState);
        assert.equal(state.verificationHistory!.length, 3);
        assert.ok(state.faults.length >= state.verificationHistory!.length);
        assert.ok(state.faults.every(/** 每次失败调用均保留回滚证明，不绑定内部重试次数。 */fault => fault.restored));
        assert.equal(state.completedTasks.length, 0);
        assert.equal(state.delivery, null);
      } else { assert.equal(result.status, 'success'); assert.equal(result.result.stopReason, scenario); assert.equal(result.result.delivery, null); }
    });
  });
}

test('检查并发请求共享额度，输出脱敏', /** Adapter注入仅用于公开日志反例，仍经过真实记录和预算代码。 */async () => {
  await harness(input(), generateV2, /** 从真实初始状态派生工具作用域。 */async (result, execution) => {
    const state = stateV2Schema.parse(result.result); state.input.autonomy!.maxCheckRuns = 2; state.verificationHistory = [];
    let calls = 0; const real = execution.runChecks.bind(execution);
    execution.runChecks = /** 合成敏感文本不是真实凭据，验证不会传给模型。 */async () => { calls++; const checks = await real(); checks[0].stderr = 'Authorization: Bearer synthetic-private token=synthetic-value https://user:password@example.invalid/x sk-synthetic123456'; return checks; };
    const scope = verificationScope(execution, state, 'backend', ['src/a.mjs']);
    const outcomes = await Promise.allSettled([scope.port.runChecks(), scope.port.runChecks(), scope.port.runChecks()]);
    assert.equal(calls, 2); assert.equal(outcomes.filter(/** 只有预算内的实际检查成功返回。 */item => item.status === 'fulfilled').length, 2);
    assert.equal(scope.history()!.length, 2); assert.equal(scope.exhausted(), true);
    assert.doesNotMatch(JSON.stringify(scope.history()), /synthetic-private|synthetic-value|user:password|sk-synthetic/);
    assert.match(JSON.stringify(scope.history()), /REDACTED/);
  });
});
