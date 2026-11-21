import { verifyTeamMethods } from '../mastra/nacos-resources.js';
import { methodPrompt } from '../mastra/team-methods.js';
import { projectRepositoryRoot, projectSpec } from '../business-engineering/project.js';
import { requirementImpactSchema } from '../business-engineering/acceptance-requirements.js';
import { runVerification, VerificationBudgetError, stopAutonomy } from '../development/v2/autonomy.js';
import { createHash } from 'node:crypto';
import { executeBrowserAgent } from '../browser-qa/agent.js';
import { loadBrowserMethod } from '../browser-qa/method.js';
import { browserCaseSchema } from '../browser-qa/contracts.js';
import { createTaskContext } from './task-context.js';
/** 独立测试角色：计划、用例确认、真实登记套件、人工质量门及开发修复回归。
 * ADR: docs/decisions/2026-11-07-mastra-full-delivery-lifecycle.md
 */
import { createStep, createWorkflow } from '@mastra/core/workflows';
import { z } from 'zod';
import { createAgents } from '../mastra/agents/index.js';
import type { PracticeConfig } from '../mastra/config.js';
import type { createExecutionScope } from '../development/v2/execution-scope.js';
import { developmentHash } from '../development/contracts.js';
import { evidenceRefs, stateV2Schema } from '../development/v2/contracts.js';
import { checksPassedV2, validateAssessment, validateIdentityV2 } from '../development/v2/gates.js';
import { loadDevelopmentMethods } from '../development/v2/methods.js';
import { createDevelopmentContinuationV2 } from '../mastra/workflows/development-v2.js';
import { requestDevelopmentRework } from '../development/rework-port.js';
import { reworkRequestSchema, teamRunEnvelopeSchema } from '../team/contracts.js';
import { decideTeamLoop } from '../team/loop.js';
import { generateV2, type GeneratorV2 } from '../development/v2/agents.js';
import { emptyQuality, lifecycleSchema, matchesAcceptancePlan, planApprovalSchema, qualityHash, qualityReviewSchema, type Lifecycle } from './contracts.js';
import { withRepositoryAssets } from './repository-assets.js';
import { publishFormalSpecification, type FormalSpecificationReceipt } from './remote-handoff.js';
import { PUBSUB_SYMBOL } from '@mastra/core/workflows/_constants';
import { projectLiveOutputChunk, publishLiveOutput } from '../intake/live-output.js';

/** 校验本轮源码和研发交付一致；测试及部署不能消费漂移候选。 */
export async function assertCandidate(state: Lifecycle, execution: ReturnType<typeof createExecutionScope>['port']): Promise<void> {
  const development = state.development;
  if (development.outcome !== 'development-delivered' || !development.delivery || development.delivery.sourceHash !== development.checkpointHash || developmentHash(await execution.snapshot()) !== development.checkpointHash || developmentHash(development.delivery.files) !== development.checkpointHash) throw new Error('测试/发布缺少同版本研发交付或候选发生漂移');
}

/** 人工确认的用例必须覆盖批准需求，自动用例只能引用已登记检查。 */
export function validateCases(state: Lifecycle, review: z.infer<typeof planApprovalSchema>): void {
  const ids = new Set<string>();
  const requirements = new Set(state.development.requirements.map(
    // 原文锚点用于结构追溯，语义覆盖由测试负责人确认。
    (item) => item.id,
  ));
  if (review.cases.filter(/** 限制浏览器单轮总预算。 */item => item.method === 'browser').length > 3) throw new Error('浏览器用例超过预算');
  for (const item of review.cases) {
    if (ids.has(item.id)) throw new Error('测试用例ID重复');
    ids.add(item.id);
    if (item.method === 'browser') {
      if (!state.quality.plan?.browserMethodHash) throw new Error('旧测试计划缺少浏览器方法绑定，请重新生成计划');
      const browser = browserCaseSchema.parse(item.browser);
      if (item.checkRefs.length || new Set([browser.entry, ...browser.assets]).size !== browser.assets.length + 1) throw new Error('浏览器资源重复或混入登记检查');
      for (const path of [browser.entry, ...browser.assets]) if (!(path in state.development.input.project.files)) throw new Error('浏览器资产未在项目声明');
    } else if (item.browser) throw new Error('非浏览器用例夹带浏览器输入');
    if (state.development.input.requirementTracking && new Set(item.requirementRefs).size !== item.requirementRefs.length) throw new Error('测试用例需求引用重复');
    if (item.requirementRefs.some(
      // 不接受模型自造需求引用。
      (ref) => !requirements.has(ref),
    )) throw new Error('测试用例引用未知需求');
    if (item.method === 'manual' && item.checkRefs.length || item.method === 'registered-check' && (!item.checkRefs.length || item.checkRefs.some(
      // 固定套件不能由模型新增、替换或降低范围。
      (ref) => !state.development.verificationRefs.includes(ref),
    ))) throw new Error('测试用例检查映射不合法');
  }
  for (const ref of requirements) if (!review.cases.some(
    // 不允许批准遗漏需求的用例包。
    (item) => item.requirementRefs.includes(ref),
  )) throw new Error('测试用例未覆盖全部产品引用');
}

/** 证据覆盖批准集合并绑定源码、用例与截图，人工不可覆写机器结果。 */
export function validateBrowserEvidence(state: Lifecycle): void {
  const cases = state.quality.approval?.cases.filter(/** 只消费批准的浏览器方法。 */item => item.method === 'browser') ?? [];
  if (!cases.length) { if (state.quality.browser) throw new Error('无批准用例却出现浏览器证据'); return; }
  const evidence = state.quality.browser;
  if (!evidence || evidence.hash !== developmentHash(evidence.receipts) || evidence.receipts.length !== cases.length || new Set(evidence.receipts.map(/** 每ID唯一。 */item => item.caseId)).size !== cases.length) throw new Error('浏览器证据缺失或散列不符');
  for (const item of cases) {
    const receipt = evidence.receipts.find(/** 精确匹配批准用例。 */r => r.caseId === item.id);
    const result = state.quality.results.find(/** 质量结果必须来自回执。 */r => r.caseId === item.id);
    if (!receipt || receipt.caseHash !== developmentHash(item) || receipt.sourceHash !== state.development.checkpointHash || receipt.sourceHash !== state.quality.sourceHash || receipt.methodHash !== evidence.methodHash || evidence.methodHash !== state.quality.plan?.browserMethodHash || !result || result.authority !== 'browser-process' || result.status !== receipt.status) throw new Error('浏览器结果版本或身份漂移');
    if (receipt.screenshot && createHash('sha256').update(Buffer.from(receipt.screenshot.base64, 'base64')).digest('hex') !== receipt.screenshot.sha256) throw new Error('截图证据损坏');
    if (receipt.status === 'passed' && (!receipt.screenshot || receipt.consoleErrors.length || receipt.blockedRequests || receipt.steps.filter(/** 未执行全部断言不能通过。 */step => step.action === 'assert-text').length !== item.browser!.assertions.length)) throw new Error('浏览器通过缺少执行证据');
  }
}

/** 在 HTTP 恢复前与节点内共用质量校验，非法结果不消耗暂停点。 */
export function validateQualityReview(state: Lifecycle, resumeData: z.infer<typeof qualityReviewSchema>) {
  if (state.development.input?.requirementTracking && !matchesAcceptancePlan(state)) throw new Error('测试结果与当前批准版本不一致');
  validateBrowserEvidence(state);
  const manual = state.quality.approval!.cases.filter(
    // 机器用例不能用人工回执覆盖或改成通过。
    (item) => item.method === 'manual',
  );
  if (new Set(resumeData.manualResults.map(
    // 每个用例仅接受一次结果。
    (item) => item.caseId,
  )).size !== resumeData.manualResults.length || resumeData.manualResults.some(
    // 多余及非人工用例结果一律拒绝。
    (item) => !manual.some(
      // 结果必须来自当前批准用例包。
      (testCase) => testCase.id === item.caseId,
    ),
  )) throw new Error('人工测试结果范围错误或重复');
  const results = [...state.quality.results, ...resumeData.manualResults.map(
    // 人工结果独立标注，不伪装成沙箱进程证据。
    (item) => ({ ...item, authority: 'local-human-report' as const }),
  )];
  const refs = [...evidenceRefs(state.development)];
  validateAssessment({ verdict: resumeData.findings.length ? 'FAIL' : 'PASS', findings: resumeData.findings, coverageRefs: refs, unchecked: [], resolutions: [] }, state.development);
  if (resumeData.decision === 'pass' && (resumeData.findings.length || results.length !== state.quality.approval!.cases.length || results.some(
    // 被阻塞或失败的用例不能由质量负责人直接盖成通过。
    (item) => item.status !== 'passed',
  ) || !checksPassedV2({ ...state.development, checks: state.quality.checks }))) throw new Error('测试未全部通过或存在缺陷，不能放行发布');
  if (resumeData.decision === 'rework' && !resumeData.findings.length) throw new Error('退回开发须提供具体缺陷与责任路由');
  return results;
}

/** 保留单独测试职责；原生循环处理测试退回后的开发继续与回归。 */
export function createTestingWorkflow(agents: ReturnType<typeof createAgents>, config: PracticeConfig, scope: ReturnType<typeof createExecutionScope>, generate: GeneratorV2 = generateV2) {
  const methods = loadDevelopmentMethods(config.rootDir);
  /** 每个有作用节点检查模式、方法与当前候选，不沿用过期测试证据。 */
  async function guard(state: Lifecycle): Promise<void> {
    validateIdentityV2(state.development, config, methods.hashFor(state.development.input, state.development.methodBundleHash));
    await assertCandidate(state, scope.port);
  }
  const extract = createStep({ id: 'select-development-checkpoint', description: '初次消费研发交付；缺陷回归时继续原开发状态', inputSchema: lifecycleSchema, outputSchema: stateV2Schema,
    // 只选择保存的开发状态，修复不重新创建运行目录或预算。
    execute: async ({ inputData }) => inputData.development,
  });
  const continued = createDevelopmentContinuationV2(config, scope.port, { id: 'qa-defect-repair', team: true, bind: scope.bind }, generate);
  const attach = createStep({ id: 'collect-development-for-testing', inputSchema: stateV2Schema, outputSchema: lifecycleSchema,
    // 原生循环初始数据保存本轮测试/历史，开发只更新其负责的状态。
    execute: async ({ inputData, getInitData }) => {
      const prior = lifecycleSchema.parse(getInitData<Lifecycle>());
      return { ...prior, development: inputData, brief: prior.brief, outcome: inputData.outcome === 'development-delivered' ? 'in-progress' as const : inputData.outcome === 'rework-exhausted' ? 'rework-exhausted' as const : 'blocked' as const };
    },
  });
  const plan = createStep({ id: 'prepare-test-plan', description: '测试 Agent 独立分析需求、实现与用例覆盖', inputSchema: lifecycleSchema, outputSchema: lifecycleSchema,
    // 只读源码和研发证据交给测试角色，生成计划不声明测试通过。
    execute: async ({ inputData: state, runId, [PUBSUB_SYMBOL]: pubsub }) => {
      if (state.outcome !== 'in-progress') return state;
      await guard(state);
      const files: Record<string, string> = {};
      for (const path of Object.keys(await scope.port.snapshot())) files[path] = await scope.port.readFile(path);
      const taskContext = createTaskContext({ task: 'independent-test-plan', engineeringSpec: projectSpec(config, 'testing'), product: state.development.input.source, requirements: state.development.requirements, plan: state.development.plan, files, registeredChecks: state.development.verificationRefs, developmentDelivery: state.development.delivery, previousQuality: state.qualityHistory, requirementImpact: state.development.input.requirementImpact, browserSupport: '可批准method=browser用例，提供browser={entry,assets,actions:[{action:click或fill,selector,value}],assertions:[{selector,text}]}；只支持候选内静态HTML、显式资源与文本包含断言。HRM动态全栈暂缺同版本启动Adapter，不能声称可执行。', instruction: methodPrompt('delivery.testing.1', state.development.input.teamMethods) }, config.mode === 'live', projectRepositoryRoot(config) ? { root: projectRepositoryRoot(config)!, receipt: state.repositoryHandoff ?? state.development.repositoryHandoff } : undefined, 0, state.development.input.teamMethods);
      const catalog = state.development.input.teamMethods;
      if (catalog) await verifyTeamMethods(config.nacosResources, catalog);
      const activeAgent = catalog ? createAgents(config, { methods: catalog, workspace: false }).testingAgent : agents.testingAgent;
      const options = { ...taskContext.options, maxSteps: 8, modelSettings: { maxOutputTokens: 6000 } };
      const response = config.mode === 'live'
        ? await (async () => { const stream = await activeAgent.stream(taskContext.prompt, options); for await (const chunk of stream.fullStream) { const event = projectLiveOutputChunk(chunk, 'testing', 1); if (event) await publishLiveOutput(pubsub, runId, event, 'prepare-test-plan').catch(() => {}); } return stream.getFullOutput(); })()
        : await activeAgent.generate(taskContext.prompt, options);
      if (response.finishReason === 'length') throw new Error('测试计划生成被截断，不能进入用例批准');
      if (response.error || response.finishReason !== 'stop') throw new Error('测试计划模型执行未正常完成，不能进入人工批准');
      const content = z.string().trim().min(1).max(100000).parse(response.text);
      const binding = { content, sourceHash: state.development.checkpointHash,
        ...(state.development.input.requirementTracking ? { productHash: state.development.input.source.hash, developmentPlanHash: state.development.planHash! } : {}),
        browserMethodHash: loadBrowserMethod(config.rootDir, state.development.input.teamMethods).hash };
      return { ...state, quality: { ...emptyQuality(), plan: { ...binding, hash: developmentHash(binding) } } };
    },
  });
  const approve = createStep({ id: 'approve-test-cases', description: '测试负责人确认用例、预期与检查映射', inputSchema: lifecycleSchema, outputSchema: lifecycleSchema, suspendSchema: z.object({ plan: lifecycleSchema.shape.quality.shape.plan, requirements: stateV2Schema.shape.requirements, registeredChecks: z.array(z.string()), requirementImpact: requirementImpactSchema.optional() }), resumeSchema: planApprovalSchema,
    // 人工确认覆盖及执行方式，生成计划不能自动充当批准。
    execute: async ({ inputData: state, resumeData, suspend, runId }) => {
      if (state.outcome !== 'in-progress') return state;
      await guard(state);
      if (!state.quality.plan || state.quality.plan.sourceHash !== state.development.checkpointHash) throw new Error('缺少当前测试计划');
      if (!matchesAcceptancePlan(state)) throw new Error('测试计划与批准需求或开发方案版本不一致');
      if (!resumeData) return suspend({ plan: state.quality.plan, requirements: state.development.requirements, registeredChecks: state.development.verificationRefs, requirementImpact: state.development.input.requirementImpact });
      if (resumeData.hash !== state.quality.plan.hash) throw new Error('测试用例批准版本不匹配');
      if (resumeData.decision === 'stop') return { ...state, outcome: 'blocked' as const };
      validateCases(state, resumeData);
      let formalSpecifications = state.formalSpecifications;
      if (config.mode === 'live') {
        const root = projectRepositoryRoot(config);
        const capability = state.development.input.correlation?.iterationId;
        const development = state.development.formalSpecification;
        const product = state.development.input.formalSpecifications?.find(item => item.kind === 'product');
        if (!root || !capability || !development || !product) throw new Error('测试规格确认缺少已推送的需求、产品或开发规格');
        const handoff = await publishFormalSpecification(root, state.development.input.correlation?.runId ?? runId, capability, { 'specs/test-spec.md': `${JSON.stringify({ plan: state.quality.plan, cases: resumeData.cases, sourceHash: state.development.checkpointHash }, null, 2)}\n` }, 'docs(spec): 提交已确认测试规格');
        const receipt: FormalSpecificationReceipt = { kind: 'testing', handoff, paths: ['specs/test-spec.md'], upstreamCommits: [product.handoff.commit, development.handoff.commit] };
        formalSpecifications = [...(state.formalSpecifications ?? []), receipt];
      }
      return { ...state, formalSpecifications, quality: { ...state.quality, approval: resumeData } };
    },
  });
  const execute = createStep({ id: 'execute-tests', description: '在隔离环境实际执行登记套件，保留退出码与日志', inputSchema: lifecycleSchema, outputSchema: lifecycleSchema,
    // 使用当前源码重跑登记检查，绝不拷贝开发自检为独立测试记录。
    execute: async ({ inputData: state }) => {
      if (state.outcome !== 'in-progress') return state;
      await guard(state);
      if (!state.quality.approval) throw new Error('执行测试缺少用例批准');
      validateCases(state, state.quality.approval);
      let verified;
      try { verified = await runVerification(scope.port, state.development, 'self-check', [], 'qa'); }
      catch (error) { if (error instanceof VerificationBudgetError) return { ...state, development: stopAutonomy(state.development, 'verification-budget'), outcome: 'rework-exhausted' as const }; throw error; }
      const checks = verified.checks;
      await guard(state);
      const results: Lifecycle['quality']['results'] = state.quality.approval.cases.filter(
        // 人工用例由质量门收取逐项执行回执。
        (item) => item.method === 'registered-check',
      ).map(
        // 用例映射是人工确认的最低覆盖，不能证明未登记业务路径。
        (item) => ({ caseId: item.id, status: item.checkRefs.every(
          // 同一检查的实际退出与证据完整性由已有固定检查规则判定。
          (id) => checks.some(
            // 失败、超时、截断均不能成为通过证据。
            (check) => check.id === id && check.exitCode === 0 && check.processExitCode === 0 && !check.timedOut && !check.stdoutTruncated && !check.stderrTruncated,
          ),
        ) ? 'passed' : 'failed', evidence: `登记检查：${item.checkRefs.join(', ')}`, authority: 'sandbox-process' }),
      );
      const next = { ...state, development: verified.state, quality: { ...state.quality, checks, results, sourceHash: state.development.checkpointHash } };
      return { ...next, quality: { ...next.quality, reportHash: qualityHash(next) } };
    },
  });
  const browser = createStep({ id: 'execute-browser-qa', description: 'QA Agent读取固定方法并实际执行批准浏览器用例', inputSchema: lifecycleSchema, outputSchema: lifecycleSchema,
    /** 仅从同版本候选读取批准资产，不测试宿主已有服务。 */
    execute: async ({ inputData: state }) => {
      if (state.outcome !== 'in-progress') return state;
      const cases = state.quality.approval?.cases.filter(/** 无浏览器用例时维持旧流程。 */item => item.method === 'browser') ?? [];
      if (!cases.length) return state;
      await guard(state);
      const files: Record<string, string> = {};
      for (const item of cases) for (const path of [item.browser!.entry, ...item.browser!.assets]) files[path] = await scope.port.readFile(path);
      await guard(state);
      const method = loadBrowserMethod(config.rootDir, state.development.input.teamMethods);
      if (state.quality.plan?.browserMethodHash !== method.hash) throw new Error('批准后浏览器方法版本漂移');
      const evidence = await executeBrowserAgent(config, cases.map(/** 绑定批准用例、源码和方法，不接受外部URL。 */item => ({ caseId: item.id, caseHash: developmentHash(item), sourceHash: state.development.checkpointHash, methodHash: method.hash, browser: item.browser!, files, supported: !state.development.input.project.executionProfile })), state.development.input.teamMethods);
      await guard(state);
      const results = [...state.quality.results, ...evidence.receipts.map(/** 结果仅来自真实工具回执。 */receipt => ({ caseId: receipt.caseId, status: receipt.status, evidence: receipt.reason, authority: 'browser-process' as const }))];
      const next = { ...state, quality: { ...state.quality, browser: evidence, results } };
      validateBrowserEvidence(next);
      return { ...next, quality: { ...next.quality, reportHash: qualityHash(next) } };
    },
  });
  const review = createStep({ id: 'review-test-results', description: '补充人工用例结果，确认质量或提交缺陷退回开发', inputSchema: lifecycleSchema, outputSchema: lifecycleSchema, suspendSchema: z.object({ hash: z.string(), quality: lifecycleSchema.shape.quality }), resumeSchema: qualityReviewSchema,
    // 质量通过必须全部用例有结果、登记检查成功且没有未解决发现。
    execute: async ({ inputData: state, resumeData, suspend }) => {
      if (state.outcome !== 'in-progress') return state;
      await guard(state);
      const hash = qualityHash(state);
      if (hash !== state.quality.reportHash) throw new Error('测试报告绑定漂移');
      if (!resumeData) return suspend({ hash, quality: state.quality });
      if (resumeData.hash !== hash) throw new Error('测试结果审批版本不匹配');
      const results = validateQualityReview(state, resumeData);
      const quality = { ...state.quality, results, review: resumeData, status: resumeData.decision === 'pass' ? 'passed' as const : resumeData.decision === 'rework' ? 'rework' as const : 'blocked' as const };
      const next = { ...state, quality, outcome: resumeData.decision === 'stop' ? 'blocked' as const : state.outcome };
      return { ...next, quality: { ...quality, reportHash: qualityHash(next) } };
    },
  });
  const route = createStep({ id: 'route-test-defects', description: '保留测试历史，按缺陷责任及依赖图退回开发并回归', inputSchema: lifecycleSchema, outputSchema: lifecycleSchema,
    // 测试只提交版本化返工请求；研发 Port 独占内部状态与累计预算策略。
    execute: async ({ inputData: state }) => {
      if (state.outcome !== 'in-progress' || state.quality.status !== 'rework') return state;
      const review = state.quality.review!;
      const development = state.development;
      const testing = teamRunEnvelopeSchema.parse({ version: 'team-run-envelope.v1', teamId: 'testing', status: 'rework', phase: 'route-test-defects', inputVersion: state.version, budget: { used: state.qualityHistory.length, limit: development.input.maxReworks }, evidence: [...evidenceRefs(development)], blocker: { kind: 'business', detail: '质量审阅要求返工' } });
      if (decideTeamLoop(testing) !== 'request-rework') throw new Error('测试返工状态不能创建交接请求');
      const request = reworkRequestSchema.parse({ version: 'rework-request.v1', sourceTeam: 'testing', targetTeam: 'development', targetStateVersion: development.version, targetCheckpointHash: development.checkpointHash, sourceReportHash: state.quality.reportHash, findings: review.findings, evidenceRefs: [...evidenceRefs(development)], acceptanceCases: state.quality.approval?.cases.map(/** 只交接修订影响计算需要的稳定映射。 */({ id, requirementRefs }) => ({ id, requirementRefs })) });
      const result = requestDevelopmentRework(development, request, { reportHash: qualityHash(state), checks: state.quality.checks });
      return lifecycleSchema.parse({ ...state, development: result.state, developmentHistory: [...state.developmentHistory, development.delivery!], qualityHistory: [...state.qualityHistory, state.quality], quality: emptyQuality(), outcome: result.disposition === 'exhausted' ? 'rework-exhausted' : result.disposition === 'rework' ? 'in-progress' : 'blocked' });
    },
  });
  const cycle = createWorkflow({ id: 'test-and-regression-cycle', description: '独立测试 → 缺陷修复 → 回归，沿用累计返工预算', inputSchema: lifecycleSchema, outputSchema: lifecycleSchema })
    .then(extract).then(continued).then(withRepositoryAssets(attach, config)).then(withRepositoryAssets(scope.bind(plan), config)).then(withRepositoryAssets(scope.bind(approve), config)).then(withRepositoryAssets(scope.bind(execute), config)).then(withRepositoryAssets(scope.bind(browser), config)).then(withRepositoryAssets(scope.bind(review), config)).then(withRepositoryAssets(route, config)).commit();
  return createWorkflow({ id: 'test-team', description: '测试团队：测试计划、用例确认、执行、质量确认及缺陷回归', inputSchema: lifecycleSchema, outputSchema: lifecycleSchema }).dountil(cycle,
    // 未通过质量门不能进入部署；业务阻塞和预算耗尽明确停止。
    async ({ inputData }) => inputData.quality.status === 'passed' || inputData.outcome !== 'in-progress',
  ).commit();
}
