import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { createHash } from 'node:crypto';
import { developmentCaseInput, developmentCasesSchema, developmentOracleSchema, judgeDevelopment, runDevelopmentTrial, summarizeDevelopment, type DevelopmentCase, type DevelopmentOracle, type DevelopmentTrial } from '../src/development-evaluation.js';
import { developmentHash, developmentStateSchema } from '../src/development/contracts.js';
import type { PracticeConfig } from '../src/mastra/config.js';

const practiceRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));
const assets = resolve(practiceRoot, 'evaluations/development');
const rawInputs = JSON.parse(readFileSync(resolve(assets, 'inputs.json'), 'utf8'));
const inputs = developmentCasesSchema.parse(rawInputs);
const oracle = developmentOracleSchema.parse(JSON.parse(readFileSync(resolve(assets, 'oracle.json'), 'utf8')));

/** 人评默认全空；自动检查不得代填人工结论。 */
function plannedTrial(item: DevelopmentCase, mode: 'fixture' | 'live' = 'fixture'): DevelopmentTrial {
  return { id: `${item.id}-r1`, caseId: item.id, round: 1, mode, expectedOutcome: item.expectedOutcome, status: 'not-started', runId: null, elapsedMs: null, failure: null, state: null, hidden: null,
    review: { reviewer: null, dimensions: { traceability: null, architecture: null, correctness: null, evidence: null, securityData: null, reviewability: null }, evidence: {}, hardFailures: [], highDefects: [] } };
}

/** 组织者只为judge单元测试建立已交付状态，不通过固定模型伪造实现行为。 */
function deliveredState(item: DevelopmentCase, directory: string): NonNullable<DevelopmentTrial['state']> {
  const input = developmentCaseInput(item);
  const files = { 'src/solution.mjs': createHash('sha256').update(readFileSync(resolve(directory, 'candidate/src/solution.mjs'))).digest('hex') };
  return developmentStateSchema.parse({ input, mode: 'fixture', plan: null, planHash: null, planSourceHash: null, approvedHash: null, reviews: [], round: 1, route: 'backend', work: [], checks: [], history: [], outcome: 'development-delivered',
    delivery: { version: 'development-delivery.v1', productHash: input.source.hash, planHash: developmentHash('judge-plan'), sourceHash: developmentHash(files), files, checks: [], limitations: ['单元测试构造状态，仅验证独立judge。'] } });
}

/** 每个judge只看到一份候选代码，不共享其他案例或真实仓库文件。 */
async function withJudgeSource(source: string, check: (directory: string) => Promise<void>): Promise<void> {
  const directory = mkdtempSync(resolve(tmpdir(), 'development-judge-test-'));
  mkdirSync(resolve(directory, 'candidate/src'), { recursive: true });
  writeFileSync(resolve(directory, 'candidate/src/solution.mjs'), source);
  try { await check(directory); }
  finally { rmSync(directory, { recursive: true, force: true }); }
}

/** 使用受控的单导出行为断言检查外部judge，答案从未传给Agent。 */
function valueOracle(): DevelopmentOracle {
  return { critical: false, expectedOutcome: 'deliverable', calls: [{ export: 'value', args: [], expected: 1 }], manualCriteria: ['需要独立人评。'] };
}

// 数据集规模与类别是pilot事前计划的一部分，缺例不能静默进入分母。
test('研发评测资产固定24例12类、74隐藏断言与完整100分量表', () => {
  const counts = new Map<string, number>();
  for (const item of inputs.cases) {
    counts.set(item.category, (counts.get(item.category) ?? 0) + 1);
    const expected = oracle.cases[item.id];
    assert.ok(expected);
    assert.equal(item.expectedOutcome, expected.expectedOutcome);
    assert.equal(item.maxReworks, 1);
    if (item.expectedOutcome === 'deliverable') {
      assert.ok(item.roles.includes('architect'));
      assert.ok(item.roles.includes('self-check'));
      assert.ok(Object.keys(item.publicChecksFiles).length);
      assert.ok(expected.calls.length);
      assert.ok(item.files['src/solution.mjs']);
    } else {
      assert.equal(expected.calls.length, 0);
      assert.deepEqual(item.roles, ['architect']);
    }
  }
  assert.equal(inputs.cases.length, 24);
  assert.equal(new Set(
    // 案例ID唯一，不能用重复记录填充规模。
    inputs.cases.map((item) => item.id),
  ).size, 24);
  assert.equal(counts.size, 12);
  for (const count of counts.values()) assert.equal(count, 2);
  assert.equal(Object.keys(oracle.cases).length, 24);
  assert.equal(Object.values(oracle.cases).reduce(
    // 断言条目数绑定已登记版本；修改资产必须同步明确基线。
    (sum, item) => sum + item.calls.length, 0,
  ), 74);
  const rubric = JSON.parse(readFileSync(resolve(assets, 'rubric.json'), 'utf8'));
  assert.equal(rubric.dimensions.reduce(
    // 各项最大分累加必须严格为100。
    (sum: number, item: { maxPoints: number }) => sum + item.maxPoints, 0,
  ), 100);
  assert.equal(rubric.casePass.minimumTotal, 80);
  assert.equal(rubric.pilotAdmission.minimumDistinctCases, 24);
  assert.equal(rubric.pilotAdmission.minimumRunsPerCase, 2);
});

// v3补齐任务范围，不顺带放宽公开检查、改变候选基线或把组织者答案传入输入。
test('输入v3为22个实现案例明确输入域与域外责任，固定其他资产边界', () => {
  assert.equal(inputs.version, 3);
  assert.deepEqual(Object.keys(rawInputs).sort(), ['cases', 'version']);
  const unchangedAssets = inputs.cases.map(
    // v3只允许requirement变化；其余字段绑定v2保留资产的同一散列。
    ({ requirement: _requirement, ...rest }) => rest,
  );
  assert.equal(createHash('sha256').update(JSON.stringify(unchangedAssets)).digest('hex'), 'f99319b86e6395d2ff11575ef6ae27fadc4ea48e5ca942ec79b9c6aa2ebbe071');
  let implementationCount = 0;
  for (const item of inputs.cases) {
    assert.deepEqual(Object.keys(rawInputs.cases.find(
      // 检查原始JSON字段，避免schema去除未知字段后掩盖oracle泄漏。
      (entry: { id: string }) => entry.id === item.id,
    )).sort(), ['category', 'expectedOutcome', 'files', 'id', 'maxReworks', 'publicChecksFiles', 'requirement', 'roles', 'title']);
    if (item.expectedOutcome !== 'deliverable') continue;
    implementationCount++;
    assert.match(item.requirement, /输入域：/);
    assert.match(item.requirement, /域外：/);
    assert.deepEqual(Object.keys(item.files), ['src/solution.mjs']);
    assert.deepEqual(Object.keys(item.publicChecksFiles), ['smoke.test.mjs']);
    assert.doesNotMatch(item.requirement, /oracle\.json|manualCriteria|hidden-/);
  }
  assert.equal(implementationCount, 22);
});

// 关键规则须能从公开契约确定；真正业务未决项不能被合成规则替代。
test('输入v3公开关键决策并保留两条真实需求歧义', () => {
  const byId = new Map(inputs.cases.map(
    // 用显式ID检查本轮补充的高风险契约，不依赖案例顺序。
    (item) => [item.id, item],
  ));
  assert.match(byId.get('auth-02')!.requirement, /employee\.id及invoice\.submittedBy/);
  assert.match(byId.get('tx-01')!.requirement, /quantity非正数先拒绝.*operationId已存在.*accepted=true/);
  assert.match(byId.get('file-01')!.requirement, /MIME类型在先.*size范围0\.\.5242880/);
  assert.match(byId.get('migration-01')!.requirement, /覆盖已有同名字段/);
  assert.match(byId.get('migration-02')!.requirement, /自有status字段存在.*不能回落旧state/);
  assert.match(byId.get('api-02')!.requirement, /只接受十进制正整数字符串.*超过100回落20而非截断/);
  assert.match(byId.get('sec-01')!.requirement, /已校验安全ASCII资源id/);
  assert.equal(byId.get('amb-01')!.requirement, 'HR需更正员工姓名和银行账户；部分员工离职，财务会锁定已结算记录。未定义谁可修改、锁定后能否改、是否审计及通知。列出阻塞决策及对方案/验收影响，不得自行决定。');
  assert.equal(byId.get('amb-02')!.requirement, '主管分配班次，冲突时给建议。未定义跨午夜/时区边界、待批换班是否占用、建议能否覆盖现有安排。列出阻塞问题和对数据/验收影响，不得编造默认值。');
  for (const id of ['amb-01', 'amb-02']) {
    const item = byId.get(id)!;
    assert.equal(item.expectedOutcome, 'clarification-required');
    assert.deepEqual(item.roles, ['architect']);
    assert.deepEqual(oracle.cases[id].calls, []);
    assert.match(item.publicChecksFiles['smoke.test.mjs'], /provisioned input/);
  }
});

// fixture故意不回答案例，真实研发检查必须失败且不得自动给人评分。
test('真实fixture开发入口运行两个案例后，失败、未评与能力结论保持分离', async () => {
  const parent = mkdtempSync(resolve(tmpdir(), 'development-eval-trial-'));
  const config: PracticeConfig = { rootDir: practiceRoot, mode: 'fixture', databaseUrl: `file:${resolve(parent, 'unused.db')}`, port: 4111, modelId: 'openai/gpt-4o-mini' };
  const trials: DevelopmentTrial[] = [];
  try {
    for (const id of ['crud-01', 'a11y-01']) {
      const item = inputs.cases.find(
        // 两类代表后端/前端路由，不能只检查固定后端成功样例。
        (entry) => entry.id === id,
      )!;
      const trial = await runDevelopmentTrial(config, resolve(parent, id), item, oracle.cases[id], plannedTrial(item));
      trials.push(trial);
      assert.equal(trial.status, 'generated');
      assert.equal(trial.state?.outcome, 'rework-exhausted');
      assert.equal(trial.hidden?.passed, false);
      assert.equal(trial.state?.round, 2);
      assert.equal(trial.review.reviewer, null);
      for (const score of Object.values(trial.review.dimensions)) assert.equal(score, null);
      const candidate = readFileSync(resolve(parent, id, 'candidate/src/solution.mjs'), 'utf8');
      assert.match(candidate, /fixtureValue/);
      assert.doesNotMatch(candidate, /hidden-|oracle|manualCriteria/);
    }
    const summary = summarizeDevelopment(trials);
    assert.equal(summary.planned, 2);
    assert.equal(summary.completed, 2);
    assert.equal(summary.hiddenPassed, 0);
    assert.equal(summary.reviewed, 0);
    assert.equal(summary.capabilityPassed, null);
    assert.equal(summary.admission, null);
  } finally { rmSync(parent, { recursive: true, force: true }); }
});

// judge运行真实代码，固定正确输出仍需完整test计数才能判行为通过。
test('外部judge复制候选并执行完整隐藏断言，保留人工待评', async () => {
  // 模块不依赖原始Agent运行目录，因此隐藏答案不会污染候选工作区。
  await withJudgeSource('/** 返回受控值以验证judge成功路径。 */\nexport function value() { return 1; }\n', async (directory) => {
    const result = await judgeDevelopment(directory, valueOracle(), deliveredState(inputs.cases[0], directory));
    assert.equal(result.passed, true);
    assert.equal(result.assertions, 1);
    assert.equal(result.manualRequired, true);
    assert.equal(readFileSync(resolve(directory, 'candidate/src/solution.mjs'), 'utf8').includes('hidden-'), false);
  });
});

// 退出码0不能抵消断言未执行，错误函数行为也不能被模型报告掩盖。
test('外部judge拒绝错误输出和提前process.exit(0)', async () => {
  for (const source of [
    '/** 故意返回错误值。 */\nexport function value() { return 2; }\n',
    '/** 模拟恶意候选绕过测试运行。 */\nprocess.exit(0);\nexport function value() { return 1; }\n',
  ]) {
    // 每份候选使用独立judge，防止首次结果被复用。
    await withJudgeSource(source, async (directory) => {
      const result = await judgeDevelopment(directory, valueOracle(), deliveredState(inputs.cases[0], directory));
      assert.equal(result.passed, false);
      assert.equal(result.manualRequired, true);
    });
  }
});

// 无效工作流产物和需求阻塞不可用零断言自动变成质量通过。
test('未交付与澄清案例不会被空隐藏验收自动判通过', async () => {
  assert.deepEqual(await judgeDevelopment('/unused', valueOracle(), null), { passed: false, assertions: 0, checks: [], manualRequired: true });
  const ambiguous = oracle.cases['amb-01'];
  assert.deepEqual(await judgeDevelopment('/unused', ambiguous, null), { passed: null, assertions: 0, checks: [], manualRequired: true });
  const item = inputs.cases[0];
  const planned = plannedTrial(item);
  const failed = { ...plannedTrial(item), id: 'failed', status: 'failed' as const, failure: 'workflow-or-model-error' };
  const summary = summarizeDevelopment([planned, failed]);
  assert.equal(summary.planned, 2);
  assert.equal(summary.failed, 1);
  assert.equal(summary.notStarted, 1);
  assert.equal(summary.reviewed, 0);
  assert.equal(summary.capabilityPassed, null);
});

// 候选在交付后被修改时不可复用旧开发报告来证明新代码通过。
test('外部judge核对交付hash，拒绝检查后源码变化', async () => {
  // 保存原始版本报告后修改物理候选，即使新代码行为正确也拒绝版本错绑。
  await withJudgeSource('/** 原始交付版本。 */\nexport function value() { return 1; }\n', async (directory) => {
    const state = deliveredState(inputs.cases[0], directory);
    writeFileSync(resolve(directory, 'candidate/src/solution.mjs'), '/** 未经开发报告覆盖的另一个版本。 */\nexport function value() { return 1; }\n');
    const result = await judgeDevelopment(directory, valueOracle(), state);
    assert.equal(result.passed, false);
    assert.equal(result.assertions, 0);
    assert.deepEqual(result.checks, []);
  });
});

// 纯函数案例要求不改变调用者对象，输出正确不能抵消输入突变。
test('隐藏验收拒绝会修改输入的候选函数', async () => {
  const expected: DevelopmentOracle = { critical: false, expectedOutcome: 'deliverable', calls: [{ export: 'value', args: [{ count: 1 }], expected: 2 }], manualCriteria: ['输入不可变。'] };
  // 外部judge保存参数快照，在函数返回后对比原参数。
  await withJudgeSource('/** 故意修改输入。 */\nexport function value(input) { input.count++; return input.count; }\n', async (directory) => {
    const result = await judgeDevelopment(directory, expected, deliveredState(inputs.cases[0], directory));
    assert.equal(result.passed, false);
    assert.equal(result.assertions, 1);
  });
});

// 人评必须范围有效且字段完整，不能通过额外键或无限分绕过量表。
test('研发汇总拒绝人评分数越界、非有限值和额外评分键', async () => {
  // 使用固定候选状态只测试汇总规则，不为真实模型能力评分。
  await withJudgeSource('/** 汇总测试候选。 */\nexport function value() { return 1; }\n', async (directory) => {
    const base = plannedTrial(inputs.cases[0], 'live');
    base.status = 'generated';
    base.state = deliveredState(inputs.cases[0], directory);
    base.hidden = { passed: true, assertions: 1, checks: [], manualRequired: true };
    base.review = { reviewer: 'independent-test-reviewer', dimensions: { traceability: 20, architecture: 20, correctness: 20, evidence: 20, securityData: 15, reviewability: 5 }, evidence: { traceability: '需求映射', architecture: '方案', correctness: '断言', evidence: '执行记录', securityData: '拒绝路径', reviewability: '代码注释' }, hardFailures: [], highDefects: [] };
    assert.equal(summarizeDevelopment([base]).capabilityPassed, 1);
    for (const dimensions of [
      { ...base.review.dimensions, architecture: 200 },
      { ...base.review.dimensions, traceability: -1 },
      { ...base.review.dimensions, correctness: Number.POSITIVE_INFINITY },
      { ...base.review.dimensions, bonus: 100 },
    ]) {
      const trial = { ...base, review: { ...base.review, dimensions } };
      const summary = summarizeDevelopment([trial]);
      assert.equal(summary.reviewed, 0);
      assert.equal(summary.capabilityPassed, null);
    }
    const fixture = { ...base, mode: 'fixture' as const };
    assert.equal(summarizeDevelopment([fixture]).capabilityPassed, 0);
    const rejected = { ...base, review: { ...base.review, hardFailures: ['伪造执行报告'] } };
    assert.equal(summarizeDevelopment([rejected]).capabilityPassed, 0);
  });
});

// 是否允许澄清成功由显式案例契约决定，不能耦合固定ID前缀。
test('澄清结果汇总使用expectedOutcome而非项目id命名', async () => {
  // 故意使用普通crud项目ID但声明澄清预期，防止命名成为业务规则。
  await withJudgeSource('/** 本测试不会执行实现。 */\nexport function value() { return 1; }\n', async (directory) => {
    const trial = plannedTrial(inputs.cases[0], 'live');
    trial.expectedOutcome = 'clarification-required';
    trial.status = 'generated';
    trial.state = { ...deliveredState(inputs.cases[0], directory), outcome: 'clarification-required', delivery: null };
    trial.hidden = { passed: null, assertions: 0, checks: [], manualRequired: true };
    trial.review = { reviewer: 'independent-reviewer', dimensions: { traceability: 20, architecture: 20, correctness: 20, evidence: 20, securityData: 15, reviewability: 5 }, evidence: { traceability: '规则阻塞', architecture: '说明影响', correctness: '没有伪造默认', evidence: '保留阻塞', securityData: '没有写入', reviewability: '可读说明' }, hardFailures: [], highDefects: [] };
    const summary = summarizeDevelopment([trial]);
    assert.equal(summary.reviewed, 1);
    assert.equal(summary.capabilityPassed, 1);
    assert.equal(summary.admission, null);
  });
});

// 初始化失败也必须写入该计划项的固定失败分类，不中断其余案例。
test('评测运行初始化失败返回失败项，不向外泄漏原始异常', async () => {
  const directory = mkdtempSync(resolve(tmpdir(), 'development-eval-existing-'));
  const config: PracticeConfig = { rootDir: practiceRoot, mode: 'fixture', databaseUrl: `file:${resolve(directory, 'unused.db')}`, port: 4111, modelId: 'openai/gpt-4o-mini' };
  try {
    const result = await runDevelopmentTrial(config, directory, inputs.cases[0], oracle.cases['crud-01'], plannedTrial(inputs.cases[0]));
    assert.equal(result.status, 'failed');
    assert.equal(result.failure, 'workflow-or-execution-error');
    assert.equal(result.state, null);
    assert.equal(result.hidden, null);
    assert.equal(result.review.reviewer, null);
    assert.ok(result.elapsedMs! >= 0);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
