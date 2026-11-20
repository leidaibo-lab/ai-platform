import { architectureDocumentPath, architectureMarkdown } from '../../development/v2/architecture-document.js';
import { describeDevelopmentStep, developmentSteps } from './development-steps.js';
import { projectRepositoryRoot } from '../../business-engineering/project.js';
import { reworkState, stopAutonomy, runVerification, VerificationBudgetError } from '../../development/v2/autonomy.js';
/** 版本化受限开发流水线；阶段状态由原生dountil/suspend保存，终态只由交付门写入。 */
import { createStep, createWorkflow } from '@mastra/core/workflows';
import { z } from 'zod';
import { createHash } from 'node:crypto';
import type { PracticeConfig } from '../config.js';
import type { Step } from '@mastra/core/workflows';
import { developmentExecutionIdentity, developmentHash, recoveryReviewSchema, validateEvaluationSource } from '../../development/contracts.js';
import { parseDevelopmentJson } from '../../development/agents.js';
import { approvalHashV2, approvalV2Schema, assessmentSchema, contextDraftSchema, inputV2Schema, planV2Schema, matchesRecoveryHashV2, stateV2Schema, validatePlanV2, registeredChecks, findingsHashV2, findingsReviewSchema, type StateV2 } from '../../development/v2/contracts.js';
import { applyFindingsReview, assertApprovalV2, checksPassedV2, reportV2, unresolvedV2, validateAssessment, validateIdentityV2, validateReviewResolutions } from '../../development/v2/gates.js';
import { loadDevelopmentMethods } from '../../development/v2/methods.js';
import { generateV2, type GeneratorV2 } from '../../development/v2/agents.js';
import { applyRecoveryDecision, pauseForCallBudget } from '../../development/v2/recovery-policy.js';
import { invokeV2 } from '../../development/v2/invoke.js';
import { assembleTeam, createTeamExecution } from '../../development/v2/team.js';
import type { ExecutionPort } from '../../development/v2/execution-scope.js';
import { withRepositoryAssets } from '../../delivery/repository-assets.js';
import { publishFormalSpecification, type FormalSpecificationReceipt } from '../../delivery/remote-handoff.js';
import { readAcceptanceRequirements } from '../../business-engineering/acceptance-requirements.js';
import { createProductUnits } from '../../development/v2/product-units.js';
import { PUBSUB_SYMBOL } from '@mastra/core/workflows/_constants';
import { publishLiveOutput } from '../../intake/live-output.js';

/** 与团队和独立测试共用同一返工策略；保留既有公开入口。 */
export function reworkDevelopmentV2(state: StateV2, route: StateV2['route'], phase: StateV2['phase']): StateV2 {
  return reworkState(state, route, phase);
}

/** 与v1隔离的原生步骤，复用执行Adapter；评测自动批准仅接受明确合成来源。 */
function createDevelopmentFlowsV2(config: PracticeConfig, execution: ExecutionPort, evaluationPolicy = false, generate: GeneratorV2 = generateV2, options: DevelopmentWorkflowOptions = {}) {
  const consolidated = options.team && !!options.id && !options.legacySequential && !config.legacyDevelopmentWorkflow;
  const methods = loadDevelopmentMethods(config.rootDir);
  // 默认保留现有 CLI 的固定执行环境；Studio 注入每步骤的运行作用域。
  const executionBind = options.bind ?? (
    // CLI 已持有固定执行环境，保持步骤对象不变。
    <T extends Step<any, any, any, any, any, any>>(step: T): T => step
  );
  /** 每个开发步骤归档完整状态，执行作用域仍由调用方管理。 */
  function bind<T extends Step<any, any, any, any, any, any>>(step: T): T {
    return withRepositoryAssets(executionBind(step), config);
  }
  /** 所有节点共用身份/源码检查，不让后续正常变更与初始baseline永久比较。 */
  async function guard(state: StateV2): Promise<void> {
    validateIdentityV2(state, config, methods.hashFor(state.input, state.methodBundleHash));
    if (state.checkpointHash !== developmentHash(await execution.snapshot())) throw new Error('v2源码检查点漂移');
  }
  /** 非当前阶段节点只传递快照，恢复从持久化phase继续。 */
  function active(state: StateV2, phase: StateV2['phase']): boolean { return state.outcome === 'in-progress' && !state.recovery && state.phase === phase; }
  const initialize = createStep({ id: 'initialize-development', inputSchema: inputV2Schema, outputSchema: stateV2Schema,
    // 初始化所有证据并确认候选与manifest一致，入口不能伪造批准。
    execute: async ({ inputData, runId, [PUBSUB_SYMBOL]: pubsub }) => {
      if (evaluationPolicy) validateEvaluationSource(inputData);
      const files = await execution.snapshot();
      const expected = Object.fromEntries(Object.entries(inputData.project.files).sort().map(
        // snapshot的文件值为原始字节SHA256，不能用JSON散列代替。
        ([path, content]) => [path, createHash('sha256').update(content).digest('hex')],
      ));
      if (developmentHash(files) !== developmentHash(expected)) throw new Error('v2初始候选与manifest不符');
      const requirements = inputData.requirementTracking
        ? readAcceptanceRequirements(inputData.source.content)
        : createProductUnits(inputData.source.content);
      if (inputData.requirementImpact && inputData.requirementImpact.productHash !== inputData.source.hash) throw new Error('需求修订影响与当前产品版本不匹配');
      return stateV2Schema.parse({ version: 'development-state.v2', input: inputData, mode: config.mode, executionIdentity: developmentExecutionIdentity(config), methodBundleHash: methods.hashFor(inputData), phase: 'prepare-context', requirements, verificationRefs: registeredChecks(inputData), context: null, plan: null, planHash: null, planSourceHash: null, approvalHash: null, approvedHash: null, readiness: null, readinessHistory: [], findingsReviews: [], codeReviews: [], reviews: [], resolutions: [], checkpointHash: developmentHash(files), completedTasks: [], round: 0, route: 'all', ...(inputData.budgetContinuation?.contextBudgetLevel !== undefined ? { contextBudgetLevel: inputData.budgetContinuation.contextBudgetLevel } : {}), calls: inputData.budgetContinuation?.calls ?? 0, maxCalls: inputData.budgetContinuation?.maxCalls ?? 72, work: [], faults: [], recovery: null, recoveries: [], checks: [], checkedSourceHash: null, gates: [], outcome: 'in-progress', delivery: null });
    },
  });
  const context = createStep({ id: 'prepare-context', description: 'plan-development｜prepare-context｜development-lead-agent 核实工程上下文', inputSchema: stateV2Schema, outputSchema: stateV2Schema,
    // 提供实际读取文件而非编造仓库概况；宿主绑定产品/方法/基线。
    execute: ({ inputData, runId, [PUBSUB_SYMBOL]: pubsub }) => prepareContext(inputData, runId, pubsub),
  });
  /** 执行 工程上下文核实。 */
  async function prepareContext(inputData: StateV2, runId: string, pubsub: Parameters<typeof publishLiveOutput>[0]): Promise<StateV2> {
    if (!active(inputData, 'prepare-context')) return inputData;
    await guard(inputData);
    const files = await execution.snapshot();
    const contents: Record<string, string> = {};
    for (const path of Object.keys(files)) if (path !== 'pnpm-lock.yaml') contents[path] = await execution.readFile(path);
    const called = await invokeV2(config, execution, 'context', inputData, [], { files: contents }, methods, generate,
      // 上下文规则只能引用实际读取文件和批准原文。
      (text) => {
        const draft = contextDraftSchema.parse(parseDevelopmentJson(text));
        const refs = new Set([...inputData.requirements.map(
          // 引用原文行避免规则脱离批准版本。
          (item) => item.id,
        ), ...Object.keys(files).map(
          // 文件引用来自此次完整读取。
          (path) => `file:${path}`,
        )]);
        for (const rule of draft.rules) for (const ref of rule.refs) if (!refs.has(ref)) throw new SyntaxError('上下文引用未知来源');
      }, undefined, event => publishLiveOutput(pubsub, runId, event, 'prepare-context'));
    if (!called.entry) return called.state;
    const draft = contextDraftSchema.parse(parseDevelopmentJson(called.entry.text));
    return { ...called.state, context: { ...draft, files, productHash: inputData.input.source.hash, baselineHash: inputData.checkpointHash, methodBundleHash: inputData.methodBundleHash }, phase: 'architecture' as const, work: [...called.state.work, called.entry] };
  }
  const architecture = createStep({ id: 'architecture', description: 'plan-development｜architecture｜development-lead-agent 产出技术方案与任务包', inputSchema: stateV2Schema, outputSchema: stateV2Schema,
    // 任务包严格按manifest和原文索引校验；计划变更清空旧批准。
    execute: ({ inputData, runId, [PUBSUB_SYMBOL]: pubsub }) => createPlan(inputData, runId, pubsub),
  });
  /** 执行 开发方案生成。 */
  async function createPlan(inputData: StateV2, runId: string, pubsub: Parameters<typeof publishLiveOutput>[0]): Promise<StateV2> {
    if (!active(inputData, 'architecture')) return inputData;
    await guard(inputData);
    const called = await invokeV2(config, execution, 'architect', inputData, [], { priorGates: inputData.gates, priorReports: inputData.codeReviews }, methods, generate,
      // 结构错误保留故障，不能跳到人工批准。
      (text) => { parsePlan(text, inputData); }, undefined, event => publishLiveOutput(pubsub, runId, event, 'architecture'));
    if (!called.entry) return called.state;
    const plan = parsePlan(called.entry.text, inputData);
    const preparationIssues = inputData.input.project.preparationIssues;
    if (inputData.input.project.planning === 'agent' && !plan.blockers.length) {
      const existing = await execution.snapshot();
      const paths = new Set(plan.tasks.flatMap(/** 接续写入的新文件只预建一次。 */task => task.paths));
      for (const path of paths) if (!(path in existing)) await execution.writeFile(path, '');
    }
    const checkpointHash = developmentHash(await execution.snapshot());
    return { ...called.state, checkpointHash, plan, planHash: developmentHash(plan), planSourceHash: inputData.checkpointHash, approvedHash: null, approvalHash: null, completedTasks: [], team: undefined, phase: options.team ? 'assemble-team' as const : 'assess-readiness' as const, work: [...called.state.work, called.entry], outcome: preparationIssues?.length ? 'manual-attention' as const : plan.blockers.length ? 'clarification-required' as const : 'in-progress' as const };
  }
  /** 先附加不可绕过的工程事实再校验任务包；未建工程时可保存零实施任务的受阻方案。 */
  function parsePlan(text: string, state: StateV2) {
    const plan = planV2Schema.parse(parseDevelopmentJson(text));
    if (state.input.project.preparationIssues?.length) plan.blockers = [...new Set([...plan.blockers, ...state.input.project.preparationIssues.map(/** 宿主工程事实不能被模型PASS、业务回答或人工评论消除。 */issue => `工程上下文缺口：${issue}`)])];
    validatePlanV2(plan, state, !methods.usesLegacyTaskHandoff(state));
    return plan;
  }
  const assemble = createStep({ id: 'assemble-agent-team', description: 'plan-development｜assemble-agent-team｜按批准任务动态组建 development-implementer-agent', inputSchema: stateV2Schema, outputSchema: stateV2Schema,
    // 团队在就绪审查前展示并进入技术方案批准绑定。
    execute: async ({ inputData }) => prepareTeam(inputData),
  });
  /** 按方案确定任务负责人，并把执行团队纳入就绪审查。 */
  function prepareTeam(state: StateV2): StateV2 {
    if (!active(state, 'assemble-team')) return state;
    return { ...state, team: assembleTeam(state), delegations: [], phase: 'assess-readiness' };
  }
  const readiness = createStep({ id: 'assess-readiness', description: 'plan-development｜assess-readiness｜development-reviewer-agent 实施前独立就绪审查', inputSchema: stateV2Schema, outputSchema: stateV2Schema,
    // 独立只读语义调用；CONCERNS需逐项证据裁决，FAIL保留阻塞。
    execute: ({ inputData, runId, [PUBSUB_SYMBOL]: pubsub }) => assessReadiness(inputData, runId, pubsub),
  });
  /** 执行 独立就绪审查。 */
  async function assessReadiness(inputData: StateV2, runId: string, pubsub: Parameters<typeof publishLiveOutput>[0]): Promise<StateV2> {
    if (!active(inputData, 'assess-readiness')) return inputData;
    await guard(inputData);
    validatePlanV2(inputData.plan!, inputData, !methods.usesLegacyTaskHandoff(inputData));
    const called = await invokeV2(config, execution, 'readiness', inputData, [], null, methods, generate,
      // 判定、发现和覆盖都必须结构一致。
      (text) => validateAssessment(assessmentSchema.parse(parseDevelopmentJson(text)), inputData), undefined, event => publishLiveOutput(pubsub, runId, event, 'assess-readiness'));
    if (!called.entry) return called.state;
    const report = reportV2(assessmentSchema.parse(parseDevelopmentJson(called.entry.text)), called.state);
    const state = { ...called.state, readiness: report, work: [...called.state.work, called.entry] };
    if (report.assessment.verdict === 'CONCERNS') return { ...state, phase: 'resolve-readiness' as const };
    if (report.assessment.verdict !== 'PASS') return { ...state, outcome: report.assessment.findings.some(
      // 业务缺口回产品，其他关注保留人工审查事实。
      (item) => item.category === 'business',
    ) ? 'clarification-required' as const : 'manual-attention' as const };
    return { ...state, approvalHash: approvalHashV2(state), phase: 'approve-architecture' as const };
  }
  const resolveReadiness = createStep({ id: 'resolve-readiness', description: 'plan-development｜resolve-readiness｜人工逐项裁决就绪问题', inputSchema: stateV2Schema, outputSchema: stateV2Schema,
    suspendSchema: z.object({ hash: z.string(), report: z.unknown() }), resumeSchema: findingsReviewSchema,
    // CONCERNS逐项引用裁决；FAIL和结构失败不能通过此节点放行。
    execute: async ({ inputData, resumeData, suspend }) => {
      if (!active(inputData, 'resolve-readiness')) return inputData;
      if (resumeData) return applyReadinessDecision(inputData, resumeData);
      await guard(inputData);
      if (inputData.readiness?.assessment.verdict !== 'CONCERNS') throw new Error('仅CONCERNS允许就绪裁决');
      return suspend({ hash: findingsHashV2(inputData), report: inputData.readiness });
    },
  });
  /** 在原候选检查点应用人工裁决。 */
  async function applyReadinessDecision(inputData: StateV2, resumeData: z.infer<typeof findingsReviewSchema>): Promise<StateV2> {
    await guard(inputData);
    if (inputData.readiness?.assessment.verdict !== 'CONCERNS') throw new Error('仅CONCERNS允许就绪裁决');
    if (resumeData.hash !== findingsHashV2(inputData)) throw new Error('就绪裁决版本不匹配');
    const resolved = applyFindingsReview(inputData, resumeData);
    if (resolved.outcome !== 'in-progress') return resolved;
    const assessment = { ...inputData.readiness!.assessment, verdict: 'PASS' as const, findings: [], resolutions: resumeData.decisions };
    const state = { ...resolved, readinessHistory: [...resolved.readinessHistory, inputData.readiness!], readiness: reportV2(assessment, resolved), phase: 'approve-architecture' as const };
    return { ...state, approvalHash: approvalHashV2(state) };
  }
  const approve = createStep({ id: 'approve-architecture', description: describeDevelopmentStep(developmentSteps[3]), inputSchema: stateV2Schema, outputSchema: stateV2Schema,
    suspendSchema: z.object({ hash: z.string(), plan: planV2Schema, architectureMarkdown: z.string().optional(), readiness: assessmentSchema, contextHash: z.string(), methodBundleHash: z.string(), team: stateV2Schema.shape.team, executionBudget: z.object({ maxReworks: z.number(), maxCalls: z.number(), autonomy: inputV2Schema.shape.autonomy }).optional() }), resumeSchema: approvalV2Schema,
    // 正式运行在原生暂停点等待对整个包的人工确认。
    execute: async ({ inputData, resumeData, suspend, runId }) => {
      if (!active(inputData, 'approve-architecture')) return inputData;
      await guard(inputData); assertApprovalV2(inputData);
      if (!resumeData && !evaluationPolicy) return suspend({ hash: inputData.approvalHash!, plan: inputData.plan!, ...(inputData.plan!.document ? { architectureMarkdown: architectureMarkdown(inputData.plan!.document) } : {}), readiness: inputData.readiness!.assessment, contextHash: developmentHash(inputData.context), methodBundleHash: inputData.methodBundleHash, team: inputData.team, executionBudget: { maxReworks: inputData.input.maxReworks, maxCalls: inputData.maxCalls, autonomy: inputData.input.autonomy } });
      const review = resumeData ?? { hash: inputData.approvalHash!, decision: 'approve' as const, reviewer: 'evaluation-organizer-policy', comment: '仅隔离fixture自动执行，不代表业务批准', resolutions: [] };
      if (review.hash !== inputData.approvalHash) throw new Error('v2批准包版本不匹配');
      if (review.resolutions.length) throw new Error('方案批准不能处理交付评审发现');
      const approved = review.decision === 'approve';
      let formalSpecification = inputData.formalSpecification;
      if (approved && config.mode === 'live') {
        const root = projectRepositoryRoot(config);
        const capability = inputData.input.correlation?.iterationId;
        const product = inputData.input.formalSpecifications?.find(item => item.kind === 'product');
        if (!root || !capability || !product) throw new Error('开发规格确认缺少已推送的产品规格或受控仓库绑定');
        const files = {
          'specs/development-spec.md': `${JSON.stringify({ plan: inputData.plan, readiness: inputData.readiness, sourceHash: inputData.input.source.hash }, null, 2)}\n`,
          ...(inputData.plan?.document ? { [architectureDocumentPath]: architectureMarkdown(inputData.plan.document) } : {}),
        };
        const handoff = await publishFormalSpecification(root, inputData.input.correlation?.runId ?? runId, capability, files, 'docs(spec): 提交已确认开发规格');
        formalSpecification = { kind: 'development', handoff, paths: Object.keys(files), upstreamCommits: [product.handoff.commit] } satisfies FormalSpecificationReceipt;
      }
      return { ...inputData, formalSpecification, approvedHash: approved ? review.hash : null, reviews: [...inputData.reviews, { ...review, authority: resumeData ? 'local-human-label' as const : 'evaluation-policy' as const }], phase: 'implement' as const, route: 'all' as const, outcome: approved ? 'in-progress' as const : 'rejected' as const };
    },
  });
  const implement = createStep({ id: 'implement', description: 'develop-and-check｜implement｜development-implementer-agent 按批准任务实施', inputSchema: stateV2Schema, outputSchema: stateV2Schema,
    // 串行任务检查点；故障恢复只重做失败任务，评审阶段不会经过此分支。
    execute: async ({ inputData, runId, [PUBSUB_SYMBOL]: pubsub }) => {
      if (!active(inputData, 'implement')) return inputData;
      await guard(inputData); assertApprovalV2(inputData);
      if (inputData.approvedHash !== inputData.approvalHash) throw new Error('v2实现缺少当前批准');
      let state = inputData;
      for (const task of inputData.plan!.tasks) {
        if (state.completedTasks.includes(task.id)) continue;
        const called = await invokeV2(config, execution, task.role, state, task.paths, { ...task, findings: unresolvedV2(state) }, methods, generate, undefined, undefined, event => publishLiveOutput(pubsub, runId, event, 'implement', developmentHash(task.id).slice(0, 16)));
        if (!called.entry) return called.state;
        state = { ...called.state, work: [...called.state.work, called.entry], completedTasks: [...called.state.completedTasks, task.id] };
        if (state.input.autonomy && called.entry.text.includes('BUSINESS_BLOCKER:')) return stopAutonomy(state, 'business-decision');
        if (state.input.autonomy && called.entry.text.includes('AUTHORIZATION_BLOCKER:')) return stopAutonomy(state, 'authorization-required');
        if (called.entry.text.includes('ARCHITECTURE_BLOCKER:')) return reworkDevelopmentV2(state, 'architecture', 'prepare-context');
      }
      return { ...state, phase: 'development-self-check' as const };
    },
  });
  const selfCheck = createStep({ id: 'development-self-check', description: 'develop-and-check｜development-self-check｜确定性固定检查，不调用 Agent', inputSchema: stateV2Schema, outputSchema: stateV2Schema,
    // 固定检查只产生证据，不调用模型或生成研发交付。
    execute: async ({ inputData }) => {
      if (!active(inputData, 'development-self-check')) return inputData;
      await guard(inputData);
      let verified;
      try { verified = await runVerification(execution, inputData, 'self-check', [], 'integration'); }
      catch (error) { if (error instanceof VerificationBudgetError) return stopAutonomy(inputData, 'verification-budget'); throw error; }
      const checks = verified.checks;
      await guard(verified.state);
      const state = { ...verified.state, checks, checkedSourceHash: verified.state.checkpointHash };
      if (!checksPassedV2(state)) {
        // 检查只说明失败事实；自动模式交回批准团队联合修复，其他模式显式等待人工定位。
        return state.input.autonomy ? reworkDevelopmentV2(state, 'all', 'implement') : { ...state, outcome: 'manual-attention' as const };
      }
      return { ...state, phase: 'review-code' as const };
    },
  });
  const review = createStep({ id: 'review-code', description: 'review-development-quality｜review-code｜development-reviewer-agent 实施后独立代码审查', inputSchema: stateV2Schema, outputSchema: stateV2Schema,
    // reviewer失败和缺失报告均保留在评审阶段，绝不降级为成功。
    execute: ({ inputData, runId, [PUBSUB_SYMBOL]: pubsub }) => reviewCandidate(inputData, runId, pubsub),
  });
  /** 执行 候选代码审查。 */
  async function reviewCandidate(inputData: StateV2, runId: string, pubsub: Parameters<typeof publishLiveOutput>[0]): Promise<StateV2> {
    if (!active(inputData, 'review-code')) return inputData;
    await guard(inputData);
    if (!checksPassedV2(inputData) || inputData.checkedSourceHash !== inputData.checkpointHash) throw new Error('v2评审缺少当前成功检查');
    const contents: Record<string, string> = {};
    for (const path of Object.keys(await execution.snapshot())) contents[path] = await execution.readFile(path);
    const called = await invokeV2(config, execution, 'reviewer', inputData, [], { files: contents, baselineFiles: inputData.input.project.files, changedFiles: Object.keys(contents).filter(
      // 变更内容与初始源码同时交给只读评审。
      (path) => contents[path] !== inputData.input.project.files[path],
    ) }, methods, generate,
      // 报告解析错误必须保存故障，不使用空数组默认通过。
      (text) => { const assessment = assessmentSchema.parse(parseDevelopmentJson(text)); validateAssessment(assessment, inputData); validateReviewResolutions(assessment, inputData); }, undefined, event => publishLiveOutput(pubsub, runId, event, 'review-code'));
    if (!called.entry) return called.state;
    const report = reportV2(assessmentSchema.parse(parseDevelopmentJson(called.entry.text)), called.state);
    const resolutions = [...inputData.resolutions];
    for (const resolution of report.assessment.resolutions) {
      const prior = inputData.codeReviews.filter(
        // 一个处理记录绑定全部同ID旧发现，但不关闭当前新报告发现。
        (item) => item.assessment.findings.some(
          // 原始发现保持原样，只追加独立结论。
          (finding) => finding.id === resolution.findingId,
        ),
      );
      if (!prior.length || resolution.decision !== 'fixed') throw new SyntaxError('评审仅可证据化确认旧发现已修复');
      for (const item of prior) resolutions.push({ ...resolution, reportHash: item.hash, authority: 'reviewer' });
    }
    return { ...called.state, codeReviews: [...inputData.codeReviews, report], resolutions, phase: 'assess-delivery' as const, work: [...called.state.work, called.entry] };
  }
  const delivery = createStep({ id: 'assess-delivery', description: 'review-development-quality｜assess-delivery｜确定性交付门', inputSchema: stateV2Schema, outputSchema: stateV2Schema,
    // 最终门只消费当前批准/检查/评审，按问题归属有界返工。
    execute: ({ inputData }) => assessDelivery(inputData),
  });
  /** 执行 候选交付判定。 */
  async function assessDelivery(inputData: StateV2): Promise<StateV2> {
    if (!active(inputData, 'assess-delivery')) return inputData;
    await guard(inputData); assertApprovalV2(inputData);
    if (inputData.plan!.tasks.some(
      // 交付前必须完成全部批准任务，不能只凭smoke和评审通过。
      (task) => !inputData.completedTasks.includes(task.id),
    )) throw new Error('v2批准任务尚未全部完成');
    const latest = inputData.codeReviews.at(-1);
    if (!latest || latest.hash !== developmentHash({ assessment: latest.assessment, sourceHash: latest.sourceHash, planHash: latest.planHash, checksHash: latest.checksHash }) || latest.sourceHash !== inputData.checkpointHash || latest.planHash !== inputData.planHash || latest.checksHash !== developmentHash(inputData.checks) || inputData.checkedSourceHash !== inputData.checkpointHash || !checksPassedV2(inputData) || inputData.approvedHash !== inputData.approvalHash) throw new Error('v2交付证据缺失或漂移');
    const findings = unresolvedV2(inputData);
    if (findings.length) {
      const routes = new Set(findings.map(
        // 新政策联合修复多责任任务；历史政策仍保留人工裁决。
        (finding) => finding.route,
      ));
      const route = findings.some(
        // 业务/完整性问题不能通过实现重试或接受风险绕过。
        (finding) => finding.category === 'business',
      ) ? 'product' : findings.some(
        // 真实完整性问题直接停止人工处理。
        (finding) => finding.category === 'integrity',
      ) ? 'human' : routes.has('architecture') ? 'architecture' : routes.size === 1 && !routes.has('human') ? [...routes][0] : inputData.input.autonomy ? 'all' : 'human';
      const decision = route === 'product' ? 'clarify' as const : route === 'architecture' ? 'replan' as const : route === 'human' ? 'stop' as const : 'rework' as const;
      const state = { ...inputData, gates: [...inputData.gates, { decision, reasons: findings.map(
        // 完整保存所有未解决发现ID。
        (finding) => finding.id,
      ), sourceHash: inputData.checkpointHash, reportHash: latest.hash }] };
      if (route === 'product') return state.input.autonomy ? stopAutonomy(state, 'business-decision') : { ...state, outcome: 'clarification-required' as const };
      if (route === 'human' && state.input.autonomy && findings.some(/** 完整性异常不得当作可修复代码问题。 */finding => finding.category === 'integrity')) return stopAutonomy(state, 'authorization-required');
      if (route === 'human') return { ...state, phase: 'resolve-findings' as const, outcome: findings.some(
        // 完整性问题不提供接受风险后通过的旁路。
        (finding) => finding.category === 'integrity',
      ) ? 'manual-attention' as const : 'in-progress' as const };
      return reworkDevelopmentV2(state, route, route === 'architecture' ? 'prepare-context' : 'implement');
    }
    // 非PASS原报告只能在全部原发现已有明确处理后进入此处；原报告保留。
    return { ...inputData, outcome: 'development-delivered' as const, gates: [...inputData.gates, { decision: 'deliver' as const, reasons: [], sourceHash: inputData.checkpointHash, reportHash: latest.hash }], delivery: { version: 'development-delivery.v2' as const, productHash: inputData.input.source.hash, planHash: inputData.planHash!, approvalHash: inputData.approvalHash!, contextHash: developmentHash(inputData.context), methodBundleHash: inputData.methodBundleHash, readinessHash: inputData.readiness!.hash, reviewHash: latest.hash, sourceHash: inputData.checkpointHash, files: await execution.snapshot(), checks: inputData.checks, resolutions: inputData.resolutions, limitations: ['受限研发交付；固定Node语法和登记smoke，不等于独立业务验收', '只读模型评审不证明完整业务质量；fixture仅验证原生控制流', '无生产部署、跨库原子交接和跨实例启动幂等'] } };
  }
  const resolveFindings = createStep({ id: 'resolve-findings', description: 'review-development-quality｜resolve-findings｜人工裁决评审发现或进入有界返工', inputSchema: stateV2Schema, outputSchema: stateV2Schema,
    suspendSchema: z.object({ hash: z.string(), reports: z.unknown() }), resumeSchema: findingsReviewSchema,
    // 无法自动归属、误报或低严重性延期由人工显式记录，源码变化即拒绝。
    execute: async ({ inputData, resumeData, suspend }) => {
      if (!active(inputData, 'resolve-findings')) return inputData;
      if (resumeData) return applyCodeReviewDecision(inputData, resumeData);
      await guard(inputData);
      return suspend({ hash: findingsHashV2(inputData), reports: inputData.codeReviews });
    },
  });
  /** 在原候选检查点应用人工裁决。 */
  async function applyCodeReviewDecision(inputData: StateV2, resumeData: z.infer<typeof findingsReviewSchema>): Promise<StateV2> {
    await guard(inputData);
    if (resumeData.hash !== findingsHashV2(inputData)) throw new Error('评审裁决版本不匹配');
    return { ...applyFindingsReview(inputData, resumeData), phase: 'assess-delivery' };
  }
  const recovery = createStep({ id: 'recover-development', inputSchema: stateV2Schema, outputSchema: stateV2Schema,
    suspendSchema: z.object({ hash: z.string(), checkpointHash: z.string(), phase: z.string(), role: z.string(), kind: z.string(), taskId: z.string().nullable(), budget: stateV2Schema.shape.recovery.unwrap().shape.budget, modelCall: stateV2Schema.shape.recovery.unwrap().shape.modelCall }), resumeSchema: recoveryReviewSchema,
    // 连续重试阈值只决定暂停；人工可多轮继续，不清零累计调用。
    execute: async ({ inputData, resumeData, suspend }) => {
      if (inputData.outcome !== 'in-progress' || !inputData.recovery) return inputData;
      await guard(inputData);
      if (!matchesRecoveryHashV2(inputData, inputData.recovery.hash)) throw new Error('v2恢复绑定漂移');
      if (!resumeData) return suspend(inputData.recovery);
      if (resumeData.hash !== inputData.recovery.hash) throw new Error('v2恢复版本不匹配');
      return applyRecoveryDecision(inputData, resumeData);
    },
  });
  const recoveryPause = z.object({ hash: z.string(), checkpointHash: z.string(), phase: z.string(), role: z.string(), kind: z.string(), taskId: z.string().nullable(), budget: stateV2Schema.shape.recovery.unwrap().shape.budget, modelCall: stateV2Schema.shape.recovery.unwrap().shape.modelCall, recoveryState: stateV2Schema });
  const findingsPause = z.object({ hash: z.string(), report: z.unknown().optional(), reports: z.unknown().optional(), findingsState: stateV2Schema });
  /** 原生暂停载荷保存恢复后的源码版本和累计预算。 */
  async function recoverState(state: StateV2, saved: StateV2 | undefined, resumeData: unknown) {
    if (!saved) return state;
    await guard(saved);
    return applyRecoveryDecision(saved, recoveryReviewSchema.parse(resumeData));
  }
  /** 达到调用边界时将当前业务步骤交还给原生暂停点。 */
  function modelCheckpoint(state: StateV2, role: StateV2['work'][number]['role']) {
    const paused = state.calls >= state.maxCalls && !state.recovery ? pauseForCallBudget(state, role) : state;
    return paused.recovery ? { ...paused.recovery, recoveryState: paused } : undefined;
  }
  /** 历史叶节点和并行实施子流程继续使用原生故障暂停。 */
  function recoverable<T extends Step<any, any, any, any, any, any>>(step: T): T {
    if (options.legacySequential) return step;
    const execute = step.execute;
    step.resumeSchema = recoveryReviewSchema;
    step.suspendSchema = recoveryPause;
    /** 人工接续只重试有效的业务检查点。 */
    step.execute = async (context) => {
      const state = await recoverState(context.inputData, context.suspendData?.recoveryState, context.resumeData);
      if (state.outcome !== 'in-progress') return state;
      const role = state.phase === 'architecture' ? 'architect' : state.phase === 'prepare-context' ? 'context' : state.phase === 'assess-readiness' ? 'readiness' : state.phase === 'review-code' ? 'reviewer' : 'backend';
      const checkpoint = modelCheckpoint(state, role);
      if (checkpoint) return context.suspend(checkpoint);
      const result = await execute.call(step, { ...context, inputData: state, resumeData: undefined, suspendData: undefined, resume: undefined, restart: false });
      return result?.recovery ? context.suspend({ ...result.recovery, recoveryState: result }) : result;
    };
    return step;
  }
  const teamExecution = options.team ? createTeamExecution(config, execution, methods, generate, bind) : null;
  const definition = createWorkflow({ id: options.id ? `${options.id}-iteration` : 'development-iteration-v2', inputSchema: stateV2Schema, outputSchema: stateV2Schema });
  let flow: any = definition;
  let prior: string | undefined;
  /** 聚合方案及评审执行，内部函数保留原有状态与权限校验。 */
  function appendConsolidatedStages(teamExecution: ReturnType<typeof createTeamExecution>) {
    const planning = createStep({
      id: developmentSteps[1].id, description: describeDevelopmentStep(developmentSteps[1]),
      inputSchema: stateV2Schema, outputSchema: stateV2Schema, suspendSchema: recoveryPause, resumeSchema: recoveryReviewSchema,
      /** 上下文完成后从结构化方案继续，故障时保存已完成的工作。 */
      execute: async ({ inputData, suspendData, resumeData, suspend, runId, [PUBSUB_SYMBOL]: pubsub }) => {
        let state = await recoverState(inputData, suspendData?.recoveryState, resumeData);
        if (active(state, 'prepare-context')) {
          const checkpoint = modelCheckpoint(state, 'context');
          if (checkpoint) return suspend(checkpoint);
          state = stateV2Schema.parse(await prepareContext(state, runId, pubsub));
        }
        if (active(state, 'architecture')) {
          const checkpoint = modelCheckpoint(state, 'architect');
          if (checkpoint) return suspend(checkpoint);
          state = await createPlan(state, runId, pubsub);
        }
        if (state.recovery) return suspend({ ...state.recovery, recoveryState: state });
        return prepareTeam(state);
      },
    });
    const ready = createStep({
      id: developmentSteps[2].id, description: describeDevelopmentStep(developmentSteps[2]),
      inputSchema: stateV2Schema, outputSchema: stateV2Schema,
      suspendSchema: z.union([recoveryPause, findingsPause]), resumeSchema: z.union([findingsReviewSchema, recoveryReviewSchema]),
      /** 在同一步骤保留独立就绪报告和人工裁决。 */
      execute: async ({ inputData, suspendData, resumeData, suspend, runId, [PUBSUB_SYMBOL]: pubsub }) => {
        const modelState = suspendData && 'recoveryState' in suspendData ? suspendData.recoveryState : undefined;
        const findingsState = suspendData && 'findingsState' in suspendData ? suspendData.findingsState : undefined;
        let state = findingsState ?? await recoverState(inputData, modelState, resumeData);
        if (active(state, 'assess-readiness')) {
          const checkpoint = modelCheckpoint(state, 'readiness');
          if (checkpoint) return suspend(checkpoint);
          state = await assessReadiness(state, runId, pubsub);
        }
        if (state.recovery) return suspend({ ...state.recovery, recoveryState: state });
        if (!active(state, 'resolve-readiness')) return state;
        if (findingsState) return applyReadinessDecision(state, findingsReviewSchema.parse(resumeData));
        await guard(state);
        return suspend({ hash: findingsHashV2(state), report: state.readiness, findingsState: state });
      },
    });
    const implementation = createWorkflow({
      id: developmentSteps[4].id, description: describeDevelopmentStep(developmentSteps[4]), inputSchema: stateV2Schema, outputSchema: stateV2Schema,
    }).then(bind(recoverable(teamExecution))).branch([[/** 完成最后一波任务后执行固定检查。 */async ({ inputData }) => active(inputData, 'development-self-check'), bind(selfCheck)]])
      .map(/** 下一波任务复用原生合并输出。 */async ({ inputData, getStepResult }) => inputData['development-self-check'] ?? getStepResult(teamExecution), { id: 'select-candidate-checkpoint' }).commit();
    const quality = createStep({
      id: developmentSteps[5].id, description: describeDevelopmentStep(developmentSteps[5]),
      inputSchema: stateV2Schema, outputSchema: stateV2Schema,
      suspendSchema: z.union([recoveryPause, findingsPause]), resumeSchema: z.union([findingsReviewSchema, recoveryReviewSchema]),
      /** 评审绑定固定检查，裁决之后在同一步骤复核交付条件。 */
      execute: async ({ inputData, suspendData, resumeData, suspend, runId, [PUBSUB_SYMBOL]: pubsub }) => {
        const modelState = suspendData && 'recoveryState' in suspendData ? suspendData.recoveryState : undefined;
        const findingsState = suspendData && 'findingsState' in suspendData ? suspendData.findingsState : undefined;
        let state = findingsState ?? await recoverState(inputData, modelState, resumeData);
        if (active(state, 'review-code')) {
          const checkpoint = modelCheckpoint(state, 'reviewer');
          if (checkpoint) return suspend(checkpoint);
          state = await reviewCandidate(state, runId, pubsub);
        }
        if (state.recovery) return suspend({ ...state.recovery, recoveryState: state });
        if (findingsState && active(state, 'resolve-findings')) {
          state = await applyCodeReviewDecision(state, findingsReviewSchema.parse(resumeData));
        }
        state = await assessDelivery(state);
        if (!active(state, 'resolve-findings')) return state;
        await guard(state);
        return suspend({ hash: findingsHashV2(state), reports: state.codeReviews, findingsState: state });
      },
    });
    append(bind(planning), 'prepare-context', 'architecture', 'assemble-team');
    append(bind(ready), 'assess-readiness', 'resolve-readiness');
    append(bind(approve), 'approve-architecture');
    append(implementation, 'implement');
    append(bind(quality), 'review-code', 'assess-delivery', 'resolve-findings');
  }
  /** 原生条件分支跳过非当前业务阶段；映射仅传递状态，不冒充业务步骤已执行。 */
  function append(step: Step<any, any, any, any, any, any>, ...phases: StateV2['phase'][]) {
    const previous = prior;
    const mapId = `state-after-${step.id}`;
    flow = flow.branch([[/** 故障优先于正常阶段，旧恢复记录仍可接续。 */async ({ inputData }: { inputData: StateV2 }) => phases.length ? phases.some(phase => active(inputData, phase)) : inputData.outcome === 'in-progress' && !!inputData.recovery, step]])
      .map(/** 未选择分支时沿用上一份原生状态，不执行该业务阶段。 */async ({ inputData, getInitData, getStepResult }: any) => {
        const values = Object.values(inputData).filter(/** 只有执行过的分支有输出。 */value => value !== undefined);
        if (values.length > 1) throw new Error('开发流程命中多个阶段');
        return stateV2Schema.parse(values[0] ?? (previous ? getStepResult(previous) : getInitData()));
      }, { id: mapId, description: '传递阶段状态；未选择的业务节点不执行' });
    prior = mapId;
  }
  if (options.legacySequential) {
    // 仅供历史图迁移回归，正式入口不使用无条件业务步骤。
    flow = definition.then(bind(context)).then(bind(architecture)).then(bind(assemble)).then(bind(readiness)).then(bind(resolveReadiness)).then(bind(approve))
      .then(teamExecution ?? bind(implement)).then(bind(selfCheck)).then(bind(review)).then(bind(delivery)).then(bind(resolveFindings)).then(bind(recovery));
  } else if (consolidated && teamExecution) {
    appendConsolidatedStages(teamExecution);
  } else {
    append(bind(recoverable(context)), 'prepare-context');
    append(bind(recoverable(architecture)), 'architecture');
    append(bind(assemble), 'assemble-team');
    append(bind(recoverable(readiness)), 'assess-readiness');
    append(bind(resolveReadiness), 'resolve-readiness');
    append(bind(approve), 'approve-architecture');
    append(teamExecution ? bind(recoverable(teamExecution)) : bind(recoverable(implement)), 'implement');
    append(bind(selfCheck), 'development-self-check');
    append(bind(recoverable(review)), 'review-code');
    append(bind(delivery), 'assess-delivery');
    append(bind(resolveFindings), 'resolve-findings');
    append(bind(recovery));
  }
  const iteration = flow.commit() as Step<string, any, StateV2, StateV2, any, any>;
  const workflow = createWorkflow({ id: options.id ?? 'development-execution-v2', description: 'development-team 内部执行｜plan-development → develop-and-check → review-development-quality', inputSchema: inputV2Schema, outputSchema: stateV2Schema }).then(bind(initialize)).dountil(iteration,
    // 原生循环只在有界返工或已确认故障接续后继续。
    async ({ inputData }) => inputData.outcome !== 'in-progress',
  ).commit();
  const continuation = createWorkflow({ id: `${options.id ?? 'development-execution-v2'}-continuation`, description: '按现有批准、源码检查点及累计预算继续缺陷修复，不重新初始化候选', inputSchema: stateV2Schema, outputSchema: stateV2Schema }).dountil(iteration,
    // QA 返工仍使用开发阶段原有总调用和返工预算。
    async ({ inputData }) => inputData.outcome !== 'in-progress',
  ).commit();
  return { workflow, continuation };
}

/** Studio 可注入每步骤执行作用域；CLI 继续使用固定 Adapter。 */
export interface DevelopmentWorkflowOptions {
  id?: string;
  team?: boolean;
  /** 历史线性图兼容回归专用，正式入口不启用。 */
  legacySequential?: boolean;
  bind?: <T extends Step<any, any, any, any, any, any>>(step: T) => T;
}

/** 新开发 Run 从显式 manifest 初始化，不改变原有 CLI 输入契约。 */
export function createDevelopmentWorkflowV2(config: PracticeConfig, execution: ExecutionPort, evaluationPolicy = false, generate: GeneratorV2 = generateV2, options: DevelopmentWorkflowOptions = {}) {
  return createDevelopmentFlowsV2(config, execution, evaluationPolicy, generate, options).workflow;
}

/** 测试退回时从原开发状态继续，不丢失任务、评审、源码和预算。 */
export function createDevelopmentContinuationV2(config: PracticeConfig, execution: ExecutionPort, options: DevelopmentWorkflowOptions = {}, generate: GeneratorV2 = generateV2) {
  return createDevelopmentFlowsV2(config, execution, false, generate, options).continuation;
}
