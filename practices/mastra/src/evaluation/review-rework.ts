/** 固定专项适配器：上游为明确标记的夹具，真实模型只负责只读评审和缺陷返工。 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { PracticeConfig } from '../mastra/config.js';
import { developmentHash } from '../development/contracts.js';
import { inputV2Schema, stateV2Schema, type StateV2 } from '../development/v2/contracts.js';
import { generateV2, type GeneratorV2 } from '../development/v2/agents.js';
import { openDevelopmentV2, developmentStatusV2 } from '../development-v2-service.js';
import { seedDevelopment } from '../development-service.js';
import { DevelopmentExecution } from '../development-execution.js';
import { z } from 'zod';
import { createScorer } from '@mastra/core/evals';

export const reviewScenarioSchema = z.enum(['clean', 'repair', 'exhausted']);
export type ReviewScenario = z.infer<typeof reviewScenarioSchema>;
export const correctTitle = '/** 校验去空白后的Unicode码点长度。 */\nexport function validateTitle(value){if(typeof value!=="string")return {ok:false,error:"TYPE"};const title=value.trim();const length=Array.from(title).length;return length>=1&&length<=80?{ok:true,title}:{ok:false,error:"LENGTH"};}\n';
export const defectiveTitle = correctTitle.replace('Array.from(title).length', 'title.length');
const requirement = 'src/solution.mjs只导出validateTitle(value)。非字符串返回{ok:false,error:"TYPE"}。字符串trim后按Unicode码点计数，1到80含边界返回{ok:true,title:去空白文本}，否则返回{ok:false,error:"LENGTH"}。不得修改输入，不涉及界面、网络、数据库或依赖安装。实现必须满足全部规则。登记smoke只覆盖普通输入，评审应检查源码的业务正确性；额外测试执行能力不足可以记unchecked，不将已知检查范围本身当成新增业务要求。';
const smoke = 'import {test} from "node:test";import assert from "node:assert/strict";import {validateTitle} from "./src/solution.mjs";test("public ordinary",/** 公开普通输入断言。 */()=>assert.deepEqual(validateTitle(" hi "),{ok:true,title:"hi"}));';

/** 固定产品、文件、单一backend角色与一次返工预算，不接入动态组队。 */
export function reviewInput(scenario: ReviewScenario) {
  return inputV2Schema.parse({ source: { kind: 'evaluation', runId: `review-${scenario}`, content: requirement, hash: developmentHash(requirement), evidence: 'evaluation-input' }, maxReworks: scenario === 'clean' ? 0 : 1, project: { id: `review-${scenario}`, roles: ['backend'], writablePaths: ['src/solution.mjs'], checkFiles: ['smoke.test.mjs'], files: { 'src/solution.mjs': scenario === 'clean' ? correctTitle : defectiveTitle, 'smoke.test.mjs': smoke } } });
}

/** 独立检查结果不回填给被测角色，包含具名断言计数，拒绝提前exit冒充通过。 */
export async function judgeReviewSource(directory: string, source: string) {
  mkdirSync(resolve(directory, 'src'), { recursive: true });
  writeFileSync(resolve(directory, 'src/solution.mjs'), source);
  const oracle = 'import {test} from "node:test";import assert from "node:assert/strict";import {validateTitle as v} from "./src/solution.mjs";test("types",/** 类型错误。 */()=>{for(const x of [null,1,{},[],undefined])assert.deepEqual(v(x),{ok:false,error:"TYPE"})});test("lengths",/** 空白与超长。 */()=>{for(const x of ["","  ","x".repeat(81),"😀".repeat(81)])assert.deepEqual(v(x),{ok:false,error:"LENGTH"})});test("unicode",/** Unicode边界与去空白。 */()=>{for(const x of ["a","x".repeat(80),"😀".repeat(80)," hi "])assert.deepEqual(v(x),{ok:true,title:x.trim()})});';
  writeFileSync(resolve(directory, 'oracle.mjs'), oracle);
  const execution = new DevelopmentExecution(directory, [], ['oracle.mjs']);
  try {
    const checks = await execution.runChecks();
    const passed = checks.length === 2 && checks.every(
      // 原始进程退出、无超时和完整执行均需成立。
      (check) => check.exitCode === 0 && check.processExitCode === 0 && !check.timedOut && !check.stdoutTruncated && !check.stderrTruncated,
    ) && /^# tests 3$/m.test(checks.at(-1)!.stdout);
    return { passed, checks };
  } finally { await execution.close(); }
}

/** 全部原始评审、自检快照与注入记录保留，失败不自动挑选重跑。 */
export async function runReviewTrial(config: PracticeConfig, directory: string, scenario: ReviewScenario, generate: GeneratorV2 = generateV2) {
  seedDevelopment(directory, reviewInput(scenario));
  const calls: { role: string; round: number; executionMode: string; sourceHash: string; checksHash: string }[] = [];
  const injections: { round: number; sourceHash: string }[] = [];
  const reviewInputs: { round: number; sourceHash: string; afterHash: string | null; checks: StateV2['checks'] }[] = [];
  /** 固定上游与自检解说，不替换真实检查；评审与返工调用正式受限Agent。 */
  const adapter: GeneratorV2 = async (...args) => {
    const [currentConfig, execution, role, state, paths, extra, methods] = args;
    const target = role === 'reviewer' || (role === 'backend' && state.round > 0);
    const before = developmentHash(await execution.snapshot());
    calls.push({ role, round: state.round, executionMode: target ? config.mode : 'controlled-fixture', sourceHash: before, checksHash: developmentHash(state.checks) });
    if (role === 'reviewer') reviewInputs.push({ round: state.round, sourceHash: before, afterHash: null, checks: structuredClone(state.checks) });
    const entry = target ? await generate(...args) : await generateV2({ ...currentConfig, mode: 'fixture' }, execution, role, state, paths, extra, methods);
    if (role === 'backend' && (state.round === 0 || scenario === 'exhausted')) {
      await execution.writeFile('src/solution.mjs', scenario === 'clean' ? correctTitle : defectiveTitle);
      injections.push({ round: state.round, sourceHash: developmentHash(await execution.snapshot()) });
    }
    if (role === 'reviewer') {
      const after = developmentHash(await execution.snapshot());
      reviewInputs.at(-1)!.afterHash = after;
      if (after !== before) throw new Error('独立评审修改了源码');
    }
    return entry;
  };
  const initial = await judgeReviewSource(resolve(directory, 'initial-oracle'), scenario === 'clean' ? correctTitle : defectiveTitle);
  const app = openDevelopmentV2(config, directory, true, adapter);
  try {
    await app.storage.init();
    const run = await app.workflow.createRun();
    const result = await run.start({ inputData: app.input });
    const status = await developmentStatusV2(app, run.runId);
    let state = status.result ?? null;
    if (!state) {
      const snapshot = await app.workflow.getWorkflowRunById(run.runId);
      const pending = Object.values(snapshot?.steps ?? {}).find(/** 兼容旧恢复节点与当前故障阶段原生暂停。 */value => !Array.isArray(value) && value.status === 'suspended' && (value.suspendPayload?.recoveryState || value.suspendPayload?.kind));
      if (pending && !Array.isArray(pending)) { const parsed = stateV2Schema.safeParse(pending.suspendPayload?.recoveryState ?? pending.payload); if (parsed.success) state = parsed.data; }
    }
    const source = await app.execution.readFile('src/solution.mjs');
    const final = await judgeReviewSource(resolve(directory, 'final-oracle'), source);
    return { version: 'review-rework.v1' as const, scenario, mode: config.mode, authority: 'controlled-upstream-real-review-and-repair', runId: run.runId, workflowStatus: result.status, state, calls, injections, reviewInputs, initial, final, sourceHash: developmentHash(await app.execution.snapshot()), manualReview: null };
  } finally { await app.execution.close(); await app.storage.close(); }
}

/** 对原生流程事实做硬判定；错误归属、旧报告未处理或隐藏验收失败均不能通过。 */
export function reviewTrialPassed(value: Awaited<ReturnType<typeof runReviewTrial>>): boolean {
  const state = value.state;
  if (!state || value.workflowStatus !== 'success' || state.team || !state.codeReviews.length || value.calls.some(
    // 不允许前端或基础设施任务混进固定单角色专项。
    (call) => ['frontend', 'infrastructure'].includes(call.role),
  )) return false;
  if (state.codeReviews.length !== value.reviewInputs.length) return false;
  for (let i = 0; i < state.codeReviews.length; i++) {
    const report = state.codeReviews[i];
    const snapshot = value.reviewInputs[i];
    if (snapshot.sourceHash !== snapshot.afterHash || report.sourceHash !== snapshot.sourceHash || report.checksHash !== developmentHash(snapshot.checks) || !snapshot.checks.length || snapshot.checks.some(
      // 每次评审必须绑定实际成功自检，旧检查或未执行均不得计通过。
      (check) => check.exitCode !== 0 || check.timedOut || check.stdoutTruncated || check.stderrTruncated,
    )) return false;
  }
  if (value.scenario === 'clean') return value.initial.passed && value.final.passed && state.round === 0 && state.outcome === 'development-delivered' && state.codeReviews[0].assessment.findings.length === 0;
  const first = state.codeReviews[0];
  const findings = first.assessment.findings.filter(
    // 业务缺陷必须正确归属backend并定位当前文件，不能靠泛化检查缺口得分。
    (finding) => finding.category === 'implementation' && finding.route === 'backend' && finding.refs.includes('file:src/solution.mjs') && /Unicode|码点|UTF.?16|emoji|代理|字符/i.test(finding.detail + finding.evidence),
  );
  if (value.initial.passed || !findings.length || state.codeReviews.length < 2 || state.round !== 1 || !state.gates.some(
    // 真实交付门必须产生返工决策，而非测试代码直接推进。
    (gate) => gate.decision === 'rework' && gate.reportHash === first.hash,
  )) return false;
  if (value.scenario === 'exhausted') return !value.final.passed && state.outcome === 'rework-exhausted' && !state.delivery;
  return value.final.passed && state.outcome === 'development-delivered' && state.delivery?.sourceHash === value.sourceHash && value.reviewInputs.length >= 2 && value.reviewInputs[0].sourceHash !== value.reviewInputs.at(-1)!.sourceHash && findings.every(
    // 每条原发现须由后续只读评审基于原报告ID确认修复。
    (finding) => state.resolutions.some(
      // 人工接受或延期不能冒充源码修复。
      (resolution) => resolution.findingId === finding.id && resolution.reportHash === first.hash && resolution.authority === 'reviewer' && resolution.decision === 'fixed',
    ),
  );
}

/** 原生实验评分只是专项证据通过，不授予业务批准。 */
export function createReviewReworkScorer() {
  return createScorer({ id: 'fixed-review-rework-v1', name: '固定独立评审与返工 v1', description: '真实评审发现、backend归属、一次返工、复评绑定与独立隐藏验收。' })
    // 类型结构由专项Runner生成，异常或缺少状态采用失败关闭。
    .generateScore(({ run }) => { try { return reviewTrialPassed(run.output) ? 1 : 0; } catch { return 0; } })
    // 保留失败终态与人工未评边界，不用实验completed代替能力通过。
    .generateReason(({ run }) => JSON.stringify({ scenario: run.output?.scenario, outcome: run.output?.state?.outcome, hiddenPassed: run.output?.final?.passed, manualReview: null }));
}
