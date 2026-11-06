/** 评测仅组合正式开发入口和外部隐藏行为检查，不给候选Agent提供答案或自评分。 */
import { z } from 'zod';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { DevelopmentExecution } from './development-execution.js';
import { candidateSources, developmentStatus, openDevelopment, seedDevelopment } from './development-service.js';
import { developmentHash, developmentStateSchema, type DevelopmentInput } from './development/contracts.js';
import type { PracticeConfig } from './mastra/config.js';

export const developmentCasesSchema = z.object({ version: z.number(), cases: z.array(z.object({ id: z.string().regex(/^[a-z0-9-]+$/), category: z.string(), title: z.string(), requirement: z.string(), roles: z.array(z.enum(['architect', 'frontend', 'backend', 'self-check'])), files: z.record(z.string(), z.string()), publicChecksFiles: z.record(z.string(), z.string()).refine(
  // 项目入口要求有固定检查，歧义案例也不能因空清单在架构分析前失败。
  (files) => Object.keys(files).length > 0, '每例必须提供至少一个公开检查文件',
), maxReworks: z.number(), expectedOutcome: z.enum(['deliverable', 'clarification-required']) })).min(1) });
export type DevelopmentCase = z.infer<typeof developmentCasesSchema>['cases'][number];
export const developmentOracleSchema = z.object({ version: z.number(), cases: z.record(z.string(), z.object({ critical: z.boolean(), expectedOutcome: z.enum(['deliverable', 'clarification-required']), calls: z.array(z.object({ export: z.string().regex(/^[a-zA-Z_$][a-zA-Z0-9_$]*$/), args: z.array(z.unknown()), expected: z.unknown() })), manualCriteria: z.array(z.string()), blockerKeywords: z.array(z.array(z.string())).optional() })) });
export type DevelopmentOracle = z.infer<typeof developmentOracleSchema>['cases'][string];

/** 计划项在执行前生成；失败、未开始、未评都保持独立状态，不移出分母。 */
export interface DevelopmentTrial {
  id: string; caseId: string; round: number; mode: 'fixture' | 'live';
  expectedOutcome?: 'deliverable' | 'clarification-required';
  status: 'not-started' | 'running' | 'generated' | 'failed'; runId: string | null;
  elapsedMs: number | null; failure: string | null; state: z.infer<typeof developmentStateSchema> | null;
  hidden: { passed: boolean | null; assertions: number; checks: unknown[]; manualRequired: boolean } | null;
  review: { reviewer: string | null; dimensions: Record<string, number | null>; evidence: Record<string, string>; hardFailures: string[]; highDefects: string[] };
}

/** 创建显式评测来源，和真实产品批准分开标记；只给正式Agent提供公开输入。 */
export function developmentCaseInput(item: DevelopmentCase): DevelopmentInput {
  const roles = item.roles.filter(
    // 架构和自检由Workflow固定执行，项目只声明实现角色。
    (role): role is 'frontend' | 'backend' => role === 'frontend' || role === 'backend',
  );
  return { source: { kind: 'evaluation', runId: `evaluation-${item.id}`, hash: developmentHash(item.requirement), content: item.requirement, evidence: 'evaluation-input' },
    project: { id: item.id, files: { ...item.files, ...item.publicChecksFiles }, writablePaths: Object.keys(item.files), checkFiles: Object.keys(item.publicChecksFiles), roles: roles.length ? roles : ['backend'] }, maxReworks: item.maxReworks };
}

/** 在模型结束后，外部独立目录运行固定隐藏断言；不将错误结果回填返工。 */
export async function judgeDevelopment(directory: string, oracle: DevelopmentOracle, state: DevelopmentTrial['state']) {
  if (oracle.expectedOutcome === 'clarification-required') return { passed: null, assertions: 0, checks: [], manualRequired: true };
  if (!state || state.outcome !== 'development-delivered') return { passed: false, assertions: 0, checks: [], manualRequired: true };
  const candidate = new DevelopmentExecution(resolve(directory, 'candidate'), [], state.input.project.checkFiles);
  try {
    if (developmentHash(await candidate.snapshot()) !== state.delivery?.sourceHash)
      return { passed: false, assertions: 0, checks: [], manualRequired: true };
  } finally { await candidate.close(); }
  const judge = resolve(directory, 'judge');
  mkdirSync(judge);
  const files = candidateSources(directory);
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(resolve(judge, path, '..'), { recursive: true });
    writeFileSync(resolve(judge, path), content, { mode: 0o600 });
  }
  const declarations = oracle.calls.map(
    // 断言各有具名原生test，完整计数由宿主核对，提前exit不能冒充成功。
    (call, index) => `/** 验证隐藏行为${index + 1}，输入不可变。 */\nasync function check${index}() {\n const args = ${JSON.stringify(call.args)};\n const before=JSON.stringify(args);\n const actual=await solution[${JSON.stringify(call.export)}](...args);\n assert.deepEqual(actual, ${JSON.stringify(call.expected)});\n assert.equal(JSON.stringify(args),before,'候选实现修改输入');\n}\ntest('hidden-${index + 1}',check${index});`,
  ).join('\n');
  writeFileSync(resolve(judge, 'acceptance.test.mjs'), `import assert from 'node:assert/strict';\nimport {test} from 'node:test';\nimport * as solution from './src/solution.mjs';\n${declarations}\n`);
  const execution = new DevelopmentExecution(judge, [], ['acceptance.test.mjs']);
  try {
    const checks = await execution.runChecks();
    const last = checks.at(-1)!;
    const count = Number(last.stdout.match(/^# tests (\d+)$/m)?.[1]);
    return { passed: count === oracle.calls.length && count > 0 && checks.every(
      // 退出码、完整断言计数和超时均检查，隐藏通过仍不代表完整人评通过。
      (check) => check.exitCode === 0 && !check.timedOut,
    ), assertions: oracle.calls.length, checks, manualRequired: true };
  } finally { await execution.close(); }
}

/** 正式Workflow完成后再单独调用judge；失败仅保存固定分类，不暴露provider凭据。 */
export async function runDevelopmentTrial(config: PracticeConfig, directory: string, item: DevelopmentCase, oracle: DevelopmentOracle, trial: DevelopmentTrial): Promise<DevelopmentTrial> {
  const started = performance.now();
  let app: ReturnType<typeof openDevelopment> | undefined;
  try {
    seedDevelopment(directory, developmentCaseInput(item));
    app = openDevelopment(config, directory, true);
    await app.storage.init();
    const run = await app.workflow.createRun();
    trial.runId = run.runId;
    const result = await run.start({ inputData: app.input });
    const status = await developmentStatus(app, run.runId);
    const pending = status.steps?.['development-iteration.recover-development'];
    const state = result.status === 'success' ? developmentStateSchema.parse(result.result) : pending && !Array.isArray(pending) && pending.status === 'suspended' ? developmentStateSchema.parse(pending.payload) : null;
    const hidden = await judgeDevelopment(directory, oracle, state);
    return { ...trial, expectedOutcome: item.expectedOutcome, status: result.status === 'success' ? 'generated' : 'failed', state, hidden, elapsedMs: Math.round(performance.now() - started), failure: result.status === 'success' ? null : state?.recovery ? `recovery-required:${state.recovery.kind}` : 'workflow-or-model-error' };
  } catch {
    return { ...trial, status: 'failed', elapsedMs: Math.round(performance.now() - started), failure: 'workflow-or-execution-error' };
  } finally {
    if (app) {
      await app.execution.close();
      await app.storage.close();
    }
  }
}

/** 只有完整独立人评、真实模型和确定性检查均通过才能计为能力通过。 */
export function summarizeDevelopment(trials: DevelopmentTrial[]) {
  let completed = 0;
  let reviewed = 0;
  let passed = 0;
  let hiddenPassed = 0;
  for (const trial of trials) {
    if (trial.status === 'generated') completed++;
    if (trial.hidden?.passed === true) hiddenPassed++;
    const scores = trial.review.dimensions;
    const maxima: Record<string, number> = { traceability: 20, architecture: 20, correctness: 20, evidence: 20, securityData: 15, reviewability: 5 };
    const complete = !!trial.review.reviewer?.trim() && ['traceability', 'architecture', 'correctness', 'evidence', 'securityData', 'reviewability'].every(
      // 评分与依据均需完整，不把null计为零分或通过。
      (id) => typeof scores[id] === 'number' && Number.isFinite(scores[id]) && scores[id]! >= 0 && scores[id]! <= maxima[id] && !!trial.review.evidence[id]?.trim(),
    ) && Object.keys(scores).length === Object.keys(maxima).length;
    if (complete) {
      reviewed++;
      const total = Object.values(scores).reduce<number>(
        // 缺失评分在complete前已排除，不生成伪精确的默认分数。
        (sum, score) => sum + (score ?? 0), 0,
      );
      const minima = scores.traceability! >= 16 && scores.correctness! >= 16 && scores.evidence! >= 16 && scores.securityData! >= 12;
      const expected = trial.expectedOutcome === 'clarification-required' ? trial.state?.outcome === 'clarification-required' : trial.state?.outcome === 'development-delivered' && trial.hidden?.passed === true;
      if (trial.mode === 'live' && expected && total >= 80 && minima && !trial.review.hardFailures.length && !trial.review.highDefects.length) passed++;
    }
  }
  return { planned: trials.length, completed, failed: trials.filter(
    // 失败和未开始始终出现在结果里。
    (trial) => trial.status === 'failed',
  ).length, notStarted: trials.filter(
    // 生成中状态在进程中断时也保留，不能当作成功。
    (trial) => trial.status === 'not-started' || trial.status === 'running',
  ).length, hiddenPassed, reviewed, capabilityPassed: reviewed ? passed : null, admission: null,
    reason: '准入需至少24不同案例各两次、完整独立人评且安全数据项全部通过；报告不自动代替人评或整栈验证' };
}
