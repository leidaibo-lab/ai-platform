/** 六类开发单节点评测：冻结上游、正式generateV2、真实受限I/O、原生Workflow/Store拥有结果。 */
import { readFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, dirname } from 'node:path';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { createStep, createWorkflow } from '@mastra/core/workflows';
import { createScorer } from '@mastra/core/evals';
import type { Mastra } from '@mastra/core';
import type { PracticeConfig } from '../mastra/config.js';
import { DevelopmentExecution, type DevelopmentCheckResult } from '../development-execution.js';
import { parseDevelopmentJson } from '../development/agents.js';
import { developmentHash, developmentExecutionIdentity } from '../development/contracts.js';
import { inputV2Schema, stateV2Schema, contextDraftSchema, planV2Schema, assessmentSchema, registeredChecks, validatePlanV2, type StateV2, type EntryV2 } from '../development/v2/contracts.js';
import { validateAssessment } from '../development/v2/gates.js';
import { loadDevelopmentMethods } from '../development/v2/methods.js';
import { generateV2, type GeneratorV2 } from '../development/v2/agents.js';
import type { ExecutionPort } from '../development/v2/execution-scope.js';
import { judgeReviewSource } from './review-rework.js';

export const developmentNodeRoleSchema = z.enum(['context', 'architect', 'readiness', 'backend', 'self-check', 'reviewer']);
export type DevelopmentNodeRole = z.infer<typeof developmentNodeRoleSchema>;
const expectedSchema = z.object({ reportProtocol: z.enum(['native-summary-route']).optional(), kind: z.enum(['context', 'plan', 'assessment', 'code', 'checks']), unknown: z.boolean().optional(), blocked: z.boolean().optional(), passed: z.boolean().optional(), keywords: z.array(z.string()).default([]), category: z.string().nullable().optional(), route: z.string().nullable().optional() });
const caseSchema = z.object({ id: z.string(), role: developmentNodeRoleSchema, label: z.string(), requirement: z.string().min(1), files: z.object({ 'src/solution.mjs': z.string(), 'checks.mjs': z.string(), 'rules.md': z.string() }).strict(), planIssue: z.boolean(), expected: expectedSchema });
export type DevelopmentNodeCase = z.infer<typeof caseSchema>;
export const developmentNodeTargets = {
  context: { key: 'developmentContextEvaluation', name: '开发上下文评测' }, architect: { key: 'developmentArchitectureEvaluation', name: '开发架构评测' }, readiness: { key: 'developmentReadinessEvaluation', name: '开发就绪评测' }, backend: { key: 'developmentImplementationEvaluation', name: '开发实现评测' }, 'self-check': { key: 'developmentSelfCheckEvaluation', name: '开发自检评测' }, reviewer: { key: 'developmentReviewEvaluation', name: '开发代码评审测评' },
} as const;

/** 仓库资产是唯一用例源；实例内持有已校验快照，源散列约束历史用例恢复。 */
export function loadDevelopmentNodeCases(rootDir: string) {
  const raw = readFileSync(resolve(rootDir, 'evaluations/native/development-nodes/cases.v1.json'), 'utf8');
  const suite = z.object({ version: z.string(), cases: z.array(caseSchema).length(18) }).parse(JSON.parse(raw));
  const ids = new Set<string>();
  for (const item of suite.cases) {
    if (ids.has(item.id)) throw new Error('开发节点用例ID重复');
    ids.add(item.id);
  }
  for (const role of developmentNodeRoleSchema.options) if (suite.cases.filter(
    // 每类角色必须有独立的三条冻结输入。
    (item) => item.role === role,
  ).length !== 3) throw new Error('开发节点用例覆盖不完整');
  const protocolRaw = readFileSync(resolve(rootDir, 'evaluations/native/development-nodes/self-check-protocol.v2.json'), 'utf8');
  const protocol = z.object({ version: z.literal('self-check-native-contract.v2'), reportProtocol: z.literal('native-summary-route'), instruction: z.string() }).parse(JSON.parse(protocolRaw));
  for (const item of suite.cases) if (item.role === 'self-check') item.expected.reportProtocol = protocol.reportProtocol;
  return { ...suite, hash: createHash('sha256').update(raw).digest('hex'), selfCheckHash: createHash('sha256').update(raw).update(protocolRaw).digest('hex'), protocol };

}

/** 合成上游只提供单一backend任务，不伪造产品人工批准，也不调用其他角色。 */
export function developmentNodeState(config: PracticeConfig, item: DevelopmentNodeCase, files: Record<string, string>, methodHash: string): StateV2 {
  const input = inputV2Schema.parse({ source: { kind: 'evaluation', runId: 'frozen-node-upstream', content: item.requirement, hash: developmentHash(item.requirement), evidence: 'evaluation-input' }, project: { id: 'node-evaluation', files: item.files, writablePaths: ['src/solution.mjs'], checkFiles: ['checks.mjs'], roles: ['backend'] }, maxReworks: 0 });
  const requirements = [{ id: 'product:L1', line: 1, text: item.requirement, hash: developmentHash(item.requirement) }];
  const verificationRefs = registeredChecks(input);
  const task = { id: 'task-title', role: 'backend', paths: ['src/solution.mjs'], dependsOn: [], requirementRefs: ['product:L1'], acceptanceRefs: ['product:L1'], contextRefs: ['file:src/solution.mjs', 'file:rules.md'], constraints: ['只实现批准原文，不改检查，不访问网络或安装依赖'], verificationRefs };
  const plan = planV2Schema.parse({ summary: '受控上游固定单任务', coverage: [{ requirement: item.requirement, behavior: '按批准原文实现validateTitle类型、去空白、计数与错误返回', verification: '登记检查与源码评审' }], contracts: item.planIssue ? 'validateTitle按UTF-16的String.length计数，其余遵循批准原文。' : item.requirement, tasks: [task], blockers: [], risks: [] });
  const phase = { context: 'prepare-context', architect: 'architecture', readiness: 'assess-readiness', backend: 'implement', 'self-check': 'development-self-check', reviewer: 'review-code' } as const;
  const hash = developmentHash(files);
  return stateV2Schema.parse({ version: 'development-state.v2', input, mode: config.mode, executionIdentity: developmentExecutionIdentity(config), methodBundleHash: methodHash, phase: phase[item.role], requirements, verificationRefs, context: { files, productHash: input.source.hash, baselineHash: hash, methodBundleHash: methodHash, rules: [{ text: '只按原文和候选文件核实规则', refs: ['file:rules.md'] }], unknowns: [] }, plan: item.role === 'context' || item.role === 'architect' ? null : plan, planHash: developmentHash(plan), planSourceHash: hash, approvalHash: null, approvedHash: null, readiness: null, readinessHistory: [], findingsReviews: [], codeReviews: [], reviews: [], resolutions: [], checkpointHash: hash, completedTasks: [], round: 0, route: 'all', calls: 0, maxCalls: 72, work: [], faults: [], recovery: null, recoveries: [], checks: [], checkedSourceHash: null, gates: [], outcome: 'in-progress', delivery: null });
}

const checkSchema = z.object({ id: z.string(), exitCode: z.number(), processExitCode: z.number(), timedOut: z.boolean(), stdout: z.string(), stderr: z.string(), durationMs: z.number(), command: z.string(), stdoutTruncated: z.boolean(), stderrTruncated: z.boolean() });
export const developmentNodeOutputSchema = z.object({ caseId: z.string(), role: developmentNodeRoleSchema, mode: z.enum(['fixture', 'live']), suiteHash: z.string(), state: stateV2Schema, entry: z.object({ text: z.string(), tools: z.array(z.string()) }).passthrough().nullable(), reads: z.array(z.string()), writes: z.array(z.string()), toolChecks: z.array(z.array(checkSchema)), checks: z.array(checkSchema), oracle: z.object({ passed: z.boolean(), checks: z.array(checkSchema) }).nullable(), before: z.record(z.string(), z.string()), after: z.record(z.string(), z.string()), files: z.record(z.string(), z.string()), error: z.string().nullable(), manualReview: z.null() });
export type DevelopmentNodeOutput = z.infer<typeof developmentNodeOutputSchema>;

/** 所有进程证据必须成功、完整且未超时，不把提前exit或截断当通过。 */
function checksPassed(checks: DevelopmentCheckResult[]): boolean {
  return checks.length > 0 && checks.every(
    // processExitCode与宿主完整性判定必须同时成立。
    (item) => item.exitCode === 0 && item.processExitCode === 0 && !item.timedOut && !item.stdoutTruncated && !item.stderrTruncated,
  );
}

/** 真实单节点执行；目录隔离，工具调用有实际I/O记录，原生步骤输出保存完整候选证据。 */
export async function runDevelopmentNode(config: PracticeConfig, item: DevelopmentNodeCase, suiteHash: string, generate: GeneratorV2 = generateV2): Promise<DevelopmentNodeOutput> {
  const directory = mkdtempSync(resolve(tmpdir(), 'mastra-development-node-'));
  const root = resolve(directory, 'candidate');
  for (const [path, content] of Object.entries(item.files)) { mkdirSync(dirname(resolve(root, path)), { recursive: true }); writeFileSync(resolve(root, path), content); }
  let execution: DevelopmentExecution | undefined;
  try {
    execution = new DevelopmentExecution(root, ['src/solution.mjs'], ['checks.mjs']);
    const engine = execution;
    const methods = loadDevelopmentMethods(config.rootDir);
    const before = await engine.snapshot();
    const state = developmentNodeState(config, item, before, methods.hash);
    if (item.role === 'reviewer') state.checks = await engine.runChecks();
    const reads: string[] = [], writes: string[] = [], toolChecks: DevelopmentCheckResult[][] = [];
    const port: ExecutionPort = {
      /** 不开放新的快照权威，只转发受限执行器事实。 */
      snapshot: () => engine.snapshot(),
      /** 保留失败的读取尝试，权限被拒绝也不能被后续输出洗掉。 */
      readFile: async (path) => { reads.push(path); return engine.readFile(path); },
      /** 写入仍受角色与执行器双重精确白名单限制。 */
      writeFile: async (path, content) => { writes.push(path); return engine.writeFile(path, content); },
      /** 记录Agent真正请求执行的检查，独立复跑不会冒充Agent调用。 */
      runChecks: async () => { const result = await engine.runChecks(); toolChecks.push(result); return result; },
    };
    let entry: EntryV2 | null = null, error: string | null = null;
    const extra = item.role === 'self-check' ? { instruction: loadDevelopmentNodeCases(config.rootDir).protocol.instruction } : item.role === 'backend' ? state.plan!.tasks[0] : item.role === 'context' ? { files: item.files } : null;
    try { entry = await generate(config, port, item.role, state, item.role === 'backend' ? ['src/solution.mjs'] : [], extra, methods); }
    catch { error = 'node-generation-failed'; }
    const after = await engine.snapshot();
    const files: Record<string, string> = {};
    for (const path of Object.keys(after)) files[path] = await engine.readFile(path);
    const checks = ['backend', 'self-check'].includes(item.role) ? await engine.runChecks() : state.checks as DevelopmentCheckResult[];
    const oracle = item.role === 'backend' ? await judgeReviewSource(resolve(directory, 'independent-oracle'), files['src/solution.mjs']) : null;
    return developmentNodeOutputSchema.parse({ caseId: item.id, role: item.role, mode: config.mode, suiteHash, state, entry, reads, writes, toolChecks, checks, oracle, before, after, files, error, manualReview: null });
  } finally { await execution?.close(); rmSync(directory, { recursive: true, force: true }); }
}

/** 从原始输出重算四项硬判定；不信任模型自行提供的passed字段。 */
export function assessDevelopmentNode(value: unknown, expected: unknown) {
  const issues: string[] = [];
  const parsed = developmentNodeOutputSchema.safeParse(value);
  const truth = z.object({ caseId: z.string(), role: developmentNodeRoleSchema, mode: z.enum(['fixture', 'live']), suiteHash: z.string(), expected: expectedSchema }).safeParse(expected);
  if (!parsed.success || !truth.success) return { score: 0, issues: ['missing-or-invalid-evidence'] };
  const out = parsed.data, target = truth.data, rule = target.expected;
  if (out.error || !out.entry || out.caseId !== target.caseId || out.role !== target.role || out.mode !== target.mode || out.suiteHash !== target.suiteHash) return { score: 0, issues: ['execution-or-identity-mismatch'] };
  const state = out.state;
  const allowed = Object.keys(state.input.project.files);
  if (out.reads.some(
    // 失败的越界尝试仍是行为违例。
    (path) => !allowed.includes(path),
  ) || out.writes.some(
    // 只有实现节点拥有精确写入路径。
    (path) => out.role !== 'backend' || path !== 'src/solution.mjs',
  )) issues.push('io-boundary');
  if (Object.keys(out.before).length !== Object.keys(out.after).length) issues.push('file-set-changed');
  for (const path of allowed) {
    if (out.after[path] !== createHash('sha256').update(out.files[path] ?? '').digest('hex')) issues.push('source-evidence-mismatch');
    if ((out.role !== 'backend' || path !== 'src/solution.mjs') && out.before[path] !== out.after[path]) issues.push('readonly-source-changed');
  }
  if (developmentHash(out.before) !== state.checkpointHash) issues.push('upstream-source-mismatch');
  /** 关键问题必须有预登记词项之一；这只是定位信号，不宣称完整语义判定。 */
  function mentions(text: string) { return !rule.keywords.length || rule.keywords.some(
    // 词项来自冻结预期，不回填给被测Agent。
    (word) => text.toLowerCase().includes(word.toLowerCase()),
  ); }
  try {
    if (rule.kind === 'context') {
      const draft = contextDraftSchema.parse(JSON.parse(out.entry.text));
      const refs = new Set(['product:L1', ...allowed.map(
        // 上下文来源必须对应当前输入实际提供的文件。
        (path) => `file:${path}`,
      )]);
      for (const entry of draft.rules) for (const ref of entry.refs) if (!refs.has(ref)) issues.push('unknown-context-ref');
      if (rule.unknown && (!draft.unknowns.length || !mentions(draft.unknowns.join('\n')))) issues.push('missing-unknown');
      if (!rule.unknown && !mentions(draft.rules.map(
        // 规则文本用于检查本案例的核心依据是否进入产物。
        (entry) => entry.text,
      ).join('\n'))) issues.push('missing-grounded-rule');
    } else if (rule.kind === 'plan') {
      const plan = planV2Schema.parse(JSON.parse(out.entry.text)); validatePlanV2(plan, state);
      if (rule.blocked ? !plan.blockers.length || !mentions(plan.blockers.join('\n')) : plan.blockers.length > 0 || !plan.tasks.length) issues.push('incorrect-plan-blocking');
      if (!rule.blocked && !/Unicode|码点/i.test(JSON.stringify(plan.coverage) + plan.contracts)) issues.push('missing-count-contract');
    } else if (rule.kind === 'assessment') {
      const report = assessmentSchema.parse(JSON.parse(out.entry.text)); validateAssessment(report, state);
      if (!rule.blocked && (report.verdict !== 'PASS' || report.findings.length)) issues.push('false-positive');
      if (rule.blocked && (report.verdict === 'PASS' || !report.findings.some(
        // 必须发现具体问题、正确归属、明确阻断，并有当前引用与原始证据。
        (finding) => ['blocking', 'high'].includes(finding.severity) && finding.category === rule.category && (finding.route === rule.route || (rule.route === 'product' && finding.route === 'human')) && mentions(finding.detail + finding.evidence) && finding.refs.length > 0,
      ))) issues.push('missed-or-misrouted-defect');
    } else if (rule.kind === 'code') {
      if (!out.writes.includes('src/solution.mjs') || !checksPassed(out.checks) || !out.oracle?.passed || !checksPassed(out.oracle.checks) || !/^# tests 3$/m.test(out.oracle.checks.at(-1)?.stdout ?? '')) issues.push('behavior-acceptance-failed');
    } else {
      if (rule.reportProtocol === 'native-summary-route') {
        const report = z.object({ summary: z.string().min(1), route: z.enum(['frontend', 'backend', 'infrastructure', 'architecture', 'human']) }).parse(parseDevelopmentJson(out.entry.text));
        if (!out.entry.tools.includes('runChecks') || !out.toolChecks.length) issues.push('checks-not-executed');
        const last = out.toolChecks.at(-1) ?? [];
        if (checksPassed(last) !== rule.passed || checksPassed(out.checks) !== rule.passed) issues.push('incorrect-check-result');
        const failure = /检查失败|测试失败|语法错误|未通过|不通过|失败|failed/i.test(report.summary);
        const success = /通过|成功|passed|success/i.test(report.summary);
        if (rule.passed ? !success || failure : !failure || report.route !== 'backend') issues.push('incorrect-check-summary-or-route');
        if (JSON.stringify(last.map(
          // 比较两次真实检查的ID与退出结果，不比较不同进程的耗时。
          (check) => [check.id, check.exitCode, check.processExitCode, check.timedOut],
        )) !== JSON.stringify(out.checks.map(
          // 宿主复跑只能用于交叉核实，不冒充模型执行。
          (check) => [check.id, check.exitCode, check.processExitCode, check.timedOut],
        ))) issues.push('check-evidence-mismatch');
      } else {
      const report = z.object({ status: z.enum(['passed', 'failed']), failedCheckIds: z.array(z.string()) }).parse(JSON.parse(out.entry.text));
      if (!out.entry.tools.includes('runChecks') || !out.toolChecks.length) issues.push('checks-not-executed');
      const toolResult = out.toolChecks.at(-1) ?? [];
      const ids = toolResult.filter(
        // 不接受模型伪造或遗漏实际失败检查。
        (check) => check.exitCode !== 0,
      ).map(
        // 只比较固定检查ID，不采用模型提供的命令。
        (check) => check.id,
      ).sort();
      if (checksPassed(toolResult) !== rule.passed || checksPassed(out.checks) !== rule.passed || report.status !== (rule.passed ? 'passed' : 'failed') || JSON.stringify([...report.failedCheckIds].sort()) !== JSON.stringify(ids)) issues.push('incorrect-check-report');
      }
    }
  } catch { issues.push('invalid-structure-or-reference'); }
  return { score: issues.length ? 0 : 1, issues: [...new Set(issues)] };
}

/** 六类共享透明硬判定评分器，每项输出缺陷原因；不以词项均值掩盖代码失败。 */
export function createDevelopmentNodeScorer(version: 'v1' | 'v2' = 'v1') {
  return createScorer({ id: `development-node-evidence-${version}`, name: `开发单节点结构、引用与执行证据 ${version}`, description: '架构/评审验证结构引用、缺陷与阻断；实现/自检验证实际沙箱代码结果。不替代人工语义审查。' })
    // 原生评分从步骤持久化的原始证据重新判定。
    .generateScore(({ run }) => assessDevelopmentNode(run.output, run.groundTruth).score)
    // 保存具体失败原因，拒绝把实验completed当质量通过。
    .generateReason(({ run }) => JSON.stringify(assessDevelopmentNode(run.output, run.groundTruth)));
}

/** 原生评测Workflow只接收已登记caseId；不接受任意源码、shell或业务批准。 */
export function createDevelopmentNodeWorkflows(config: PracticeConfig, generate: GeneratorV2 = generateV2) {
  const suite = loadDevelopmentNodeCases(config.rootDir);
  const inputSchema = z.object({ caseId: z.string(), mode: z.enum(['fixture', 'live']), suiteHash: z.string() });
  /** 每个角色独立注册，面板可直接执行对应数据集，不经过整条业务链。 */
  function workflow(role: DevelopmentNodeRole) {
    const target = developmentNodeTargets[role];
    const step = createStep({ id: 'evaluate-development-node', inputSchema, outputSchema: developmentNodeOutputSchema,
      // 当前模式与资产散列由服务端校验，旧数据集不能静默换题或换模型模式。
      execute: async ({ inputData }) => {
        const item = suite.cases.find(
          // 角色由注册闭包决定，客户端不能借caseId扩大权限。
          (entry) => entry.id === inputData.caseId && entry.role === role,
        );
        if (!item || inputData.mode !== config.mode || inputData.suiteHash !== (role === 'self-check' ? suite.selfCheckHash : suite.hash)) throw new Error('评测角色、模式或用例版本不匹配');
        return runDevelopmentNode(config, item, role === 'self-check' ? suite.selfCheckHash : suite.hash, generate);
      },
    });
    return createWorkflow({ id: target.key, description: `${target.name}：冻结上游与隔离候选，仅评估当前角色；不批准业务交付`, inputSchema, outputSchema: developmentNodeOutputSchema }).then(step).commit();
  }
  return { developmentContextEvaluation: workflow('context'), developmentArchitectureEvaluation: workflow('architect'), developmentReadinessEvaluation: workflow('readiness'), developmentImplementationEvaluation: workflow('backend'), developmentSelfCheckEvaluation: workflow('self-check'), developmentReviewEvaluation: workflow('reviewer') };
}

/** 幂等导入六个原生Dataset，绑定可从Studio重跑的Workflow目标与评分器。 */
export async function seedDevelopmentNodeDatasets(mastra: Mastra, config: PracticeConfig) {
  const suite = loadDevelopmentNodeCases(config.rootDir);
  const entries = [];
  for (const role of developmentNodeRoleSchema.options) {
    const target = developmentNodeTargets[role];
    mastra.getWorkflow(target.key);
    const hash = role === 'self-check' ? suite.selfCheckHash : suite.hash;
    const version = role === 'self-check' ? 'development-nodes.v2' : suite.version;
    const scorerId = role === 'self-check' ? 'development-node-evidence-v2' : 'development-node-evidence-v1';
    const id = `${version}-${config.mode}-${role}-${hash.slice(0, 12)}`;
    const found = await mastra.datasets.list({ perPage: false, filters: { datasetIds: [id] } });
    const dataset = found.datasets.length ? await mastra.datasets.get({ id }) : await mastra.datasets.create({ id, name: `${target.name} · ${config.mode} · ${version}`, description: '固定上游单节点独立测评，正式Agent与真实沙箱；fixture分数不作为能力结论。', targetType: 'workflow', targetIds: [target.key], scorerIds: [scorerId], metadata: { mode: config.mode, suiteHash: hash, authority: 'evaluation-only' } });
    for (const item of suite.cases) if (item.role === role) await dataset.addItem({ externalId: item.id, input: { caseId: item.id, mode: config.mode, suiteHash: hash }, groundTruth: { caseId: item.id, role, mode: config.mode, suiteHash: hash, expected: item.expected }, scorerIds: [scorerId], metadata: { upstream: 'frozen-evaluation-input', manualReview: null } });
    entries.push({ dataset, targetId: target.key, role, suiteHash: hash });
  }
  return entries;
}
