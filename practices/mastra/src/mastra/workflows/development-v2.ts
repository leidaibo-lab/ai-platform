/** 版本化受限开发流水线；阶段状态由原生dountil/suspend保存，终态只由交付门写入。 */
import { createStep, createWorkflow } from '@mastra/core/workflows';
import { z } from 'zod';
import { createHash } from 'node:crypto';
import type { PracticeConfig } from '../config.js';
import type { Step } from '@mastra/core/workflows';
import { developmentExecutionIdentity, developmentHash, recoveryReviewSchema, validateEvaluationSource } from '../../development/contracts.js';
import { parseDevelopmentJson } from '../../development/agents.js';
import { approvalHashV2, approvalV2Schema, assessmentSchema, contextDraftSchema, inputV2Schema, planV2Schema, recoveryHashV2, stateV2Schema, validatePlanV2, registeredChecks, findingsHashV2, findingsReviewSchema, type StateV2 } from '../../development/v2/contracts.js';
import { applyFindingsReview, assertApprovalV2, checksPassedV2, reportV2, unresolvedV2, validateAssessment, validateIdentityV2, validateReviewResolutions } from '../../development/v2/gates.js';
import { loadDevelopmentMethods } from '../../development/v2/methods.js';
import { generateV2, type GeneratorV2 } from '../../development/v2/agents.js';
import { invokeV2 } from '../../development/v2/invoke.js';
import { assembleTeam, createTeamExecution } from '../../development/v2/team.js';
import type { ExecutionPort } from '../../development/v2/execution-scope.js';
import { withRepositoryAssets } from '../../delivery/repository-assets.js';

/** 有界业务返工；总次数不因架构重新规划而重置。 */
export function reworkDevelopmentV2(state: StateV2, route: StateV2['route'], phase: StateV2['phase']): StateV2 {
  if (state.round >= state.input.maxReworks) return { ...state, outcome: 'rework-exhausted' };
  const invalid = new Set<string>();
  for (const task of state.plan?.tasks ?? []) {
    // 已拓扑排序，重新执行责任任务及依赖其输出的下游任务。
    if (route === 'architecture' || task.role === route || task.dependsOn.some(
      // 上游重做会使下游已完成证据失效。
      (id) => invalid.has(id),
    )) invalid.add(task.id);
  }
  return { ...state, round: state.round + 1, route, phase, completedTasks: state.completedTasks.filter(
    // 独立任务保持完成证据，避免并行返工重放无关变更。
    (id) => !invalid.has(id),
  ), checks: [], checkedSourceHash: null, ...(route === 'architecture' ? { plan: null, planHash: null, approvedHash: null, approvalHash: null, readiness: null, context: null, team: undefined } : {}) };
}

/** 与v1隔离的原生步骤，复用执行Adapter；评测自动批准仅接受明确合成来源。 */
function createDevelopmentFlowsV2(config: PracticeConfig, execution: ExecutionPort, evaluationPolicy = false, generate: GeneratorV2 = generateV2, options: DevelopmentWorkflowOptions = {}) {
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
    validateIdentityV2(state, config, methods.hash);
    if (state.checkpointHash !== developmentHash(await execution.snapshot())) throw new Error('v2源码检查点漂移');
  }
  /** 非当前阶段节点只传递快照，恢复从持久化phase继续。 */
  function active(state: StateV2, phase: StateV2['phase']): boolean { return state.outcome === 'in-progress' && !state.recovery && state.phase === phase; }
  const initialize = createStep({ id: 'initialize-development', inputSchema: inputV2Schema, outputSchema: stateV2Schema,
    // 初始化所有证据并确认候选与manifest一致，入口不能伪造批准。
    execute: async ({ inputData }) => {
      if (evaluationPolicy) validateEvaluationSource(inputData);
      const files = await execution.snapshot();
      const expected = Object.fromEntries(Object.entries(inputData.project.files).sort().map(
        // snapshot的文件值为原始字节SHA256，不能用JSON散列代替。
        ([path, content]) => [path, createHash('sha256').update(content).digest('hex')],
      ));
      if (developmentHash(files) !== developmentHash(expected)) throw new Error('v2初始候选与manifest不符');
      const requirements = inputData.source.content.split('\n').map(
        // 原文非空行作为定位锚点，模型负责解释其语义和验收覆盖。
        (text, index) => ({ id: `product:L${index + 1}`, line: index + 1, text, hash: developmentHash(text) }),
      ).filter(
        // 空行不产生虚假需求。
        (item) => item.text.trim().length > 0,
      );
      if (requirements.length > 300) throw new Error('v2产品原文超过试点锚点预算');
      return stateV2Schema.parse({ version: 'development-state.v2', input: inputData, mode: config.mode, executionIdentity: developmentExecutionIdentity(config), methodBundleHash: methods.hash, phase: 'prepare-context', requirements, verificationRefs: registeredChecks(inputData), context: null, plan: null, planHash: null, planSourceHash: null, approvalHash: null, approvedHash: null, readiness: null, readinessHistory: [], findingsReviews: [], codeReviews: [], reviews: [], resolutions: [], checkpointHash: developmentHash(files), completedTasks: [], round: 0, route: 'all', calls: 0, maxCalls: 72, work: [], faults: [], recovery: null, recoveries: [], checks: [], checkedSourceHash: null, gates: [], outcome: 'in-progress', delivery: null });
    },
  });
  const context = createStep({ id: 'prepare-context', inputSchema: stateV2Schema, outputSchema: stateV2Schema,
    // 提供实际读取文件而非编造仓库概况；宿主绑定产品/方法/基线。
    execute: async ({ inputData }) => {
      if (!active(inputData, 'prepare-context')) return inputData;
      await guard(inputData);
      const files = await execution.snapshot();
      const contents: Record<string, string> = {};
      for (const path of Object.keys(files)) contents[path] = await execution.readFile(path);
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
        });
      if (!called.entry) return called.state;
      const draft = contextDraftSchema.parse(parseDevelopmentJson(called.entry.text));
      return { ...called.state, context: { ...draft, files, productHash: inputData.input.source.hash, baselineHash: inputData.checkpointHash, methodBundleHash: methods.hash }, phase: 'architecture' as const, work: [...called.state.work, called.entry] };
    },
  });
  const architecture = createStep({ id: 'architecture', inputSchema: stateV2Schema, outputSchema: stateV2Schema,
    // 任务包严格按manifest和原文索引校验；计划变更清空旧批准。
    execute: async ({ inputData }) => {
      if (!active(inputData, 'architecture')) return inputData;
      await guard(inputData);
      const called = await invokeV2(config, execution, 'architect', inputData, [], { priorGates: inputData.gates, priorReports: inputData.codeReviews }, methods, generate,
        // 结构错误保留故障，不能跳到人工批准。
        (text) => validatePlanV2(planV2Schema.parse(parseDevelopmentJson(text)), inputData));
      if (!called.entry) return called.state;
      const plan = planV2Schema.parse(parseDevelopmentJson(called.entry.text));
      return { ...called.state, plan, planHash: developmentHash(plan), planSourceHash: inputData.checkpointHash, approvedHash: null, approvalHash: null, completedTasks: [], team: undefined, phase: options.team ? 'assemble-team' as const : 'assess-readiness' as const, work: [...called.state.work, called.entry], outcome: plan.blockers.length ? 'clarification-required' as const : 'in-progress' as const };
    },
  });
  const assemble = createStep({ id: 'assemble-agent-team', description: '按批准任务和文件范围动态生成团队成员', inputSchema: stateV2Schema, outputSchema: stateV2Schema,
    // 团队在就绪审查前展示并进入技术方案批准绑定。
    execute: async ({ inputData }) => inputData.phase !== 'assemble-team' || inputData.outcome !== 'in-progress' ? inputData : { ...inputData, team: assembleTeam(inputData), delegations: [], phase: 'assess-readiness' as const },
  });
  const readiness = createStep({ id: 'assess-readiness', inputSchema: stateV2Schema, outputSchema: stateV2Schema,
    // 独立只读语义调用；CONCERNS需逐项证据裁决，FAIL保留阻塞。
    execute: async ({ inputData }) => {
      if (!active(inputData, 'assess-readiness')) return inputData;
      await guard(inputData);
      validatePlanV2(inputData.plan!, inputData);
      const called = await invokeV2(config, execution, 'readiness', inputData, [], null, methods, generate,
        // 判定、发现和覆盖都必须结构一致。
        (text) => validateAssessment(assessmentSchema.parse(parseDevelopmentJson(text)), inputData));
      if (!called.entry) return called.state;
      const report = reportV2(assessmentSchema.parse(parseDevelopmentJson(called.entry.text)), called.state);
      const state = { ...called.state, readiness: report, work: [...called.state.work, called.entry] };
      if (report.assessment.verdict === 'CONCERNS') return { ...state, phase: 'resolve-readiness' as const };
      if (report.assessment.verdict !== 'PASS') return { ...state, outcome: report.assessment.findings.some(
        // 业务缺口回产品，其他关注保留人工审查事实。
        (item) => item.category === 'business',
      ) ? 'clarification-required' as const : 'manual-attention' as const };
      return { ...state, approvalHash: approvalHashV2(state), phase: 'approve-architecture' as const };
    },
  });
  const resolveReadiness = createStep({ id: 'resolve-readiness', inputSchema: stateV2Schema, outputSchema: stateV2Schema,
    suspendSchema: z.object({ hash: z.string(), report: z.unknown() }), resumeSchema: findingsReviewSchema,
    // CONCERNS逐项引用裁决；FAIL和结构失败不能通过此节点放行。
    execute: async ({ inputData, resumeData, suspend }) => {
      if (!active(inputData, 'resolve-readiness')) return inputData;
      await guard(inputData);
      if (inputData.readiness?.assessment.verdict !== 'CONCERNS') throw new Error('仅CONCERNS允许就绪裁决');
      const hash = findingsHashV2(inputData);
      if (!resumeData) return suspend({ hash, report: inputData.readiness });
      if (resumeData.hash !== hash) throw new Error('就绪裁决版本不匹配');
      const resolved = applyFindingsReview(inputData, resumeData);
      if (resolved.outcome !== 'in-progress') return resolved;
      const assessment = { ...inputData.readiness.assessment, verdict: 'PASS' as const, findings: [], resolutions: resumeData.decisions };
      const state = { ...resolved, readinessHistory: [...resolved.readinessHistory, inputData.readiness], readiness: reportV2(assessment, resolved), phase: 'approve-architecture' as const };
      return { ...state, approvalHash: approvalHashV2(state) };
    },
  });
  const approve = createStep({ id: 'approve-architecture', inputSchema: stateV2Schema, outputSchema: stateV2Schema,
    suspendSchema: z.object({ hash: z.string(), plan: planV2Schema, readiness: assessmentSchema, contextHash: z.string(), methodBundleHash: z.string(), team: stateV2Schema.shape.team }), resumeSchema: approvalV2Schema,
    // 正式运行在原生暂停点等待对整个包的人工确认。
    execute: async ({ inputData, resumeData, suspend }) => {
      if (!active(inputData, 'approve-architecture')) return inputData;
      await guard(inputData); assertApprovalV2(inputData);
      if (!resumeData && !evaluationPolicy) return suspend({ hash: inputData.approvalHash!, plan: inputData.plan!, readiness: inputData.readiness!.assessment, contextHash: developmentHash(inputData.context), methodBundleHash: methods.hash, team: inputData.team });
      const review = resumeData ?? { hash: inputData.approvalHash!, decision: 'approve' as const, reviewer: 'evaluation-organizer-policy', comment: '仅隔离fixture自动执行，不代表业务批准', resolutions: [] };
      if (review.hash !== inputData.approvalHash) throw new Error('v2批准包版本不匹配');
      if (review.resolutions.length) throw new Error('方案批准不能处理交付评审发现');
      return { ...inputData, approvedHash: review.decision === 'approve' ? review.hash : null, reviews: [...inputData.reviews, { ...review, authority: resumeData ? 'local-human-label' as const : 'evaluation-policy' as const }], phase: 'implement' as const, route: 'all' as const, outcome: review.decision === 'reject' ? 'rejected' as const : 'in-progress' as const };
    },
  });
  const implement = createStep({ id: 'implement', inputSchema: stateV2Schema, outputSchema: stateV2Schema,
    // 串行任务检查点；故障恢复只重做失败任务，评审阶段不会经过此分支。
    execute: async ({ inputData }) => {
      if (!active(inputData, 'implement')) return inputData;
      await guard(inputData); assertApprovalV2(inputData);
      if (inputData.approvedHash !== inputData.approvalHash) throw new Error('v2实现缺少当前批准');
      let state = inputData;
      for (const task of inputData.plan!.tasks) {
        if (state.completedTasks.includes(task.id)) continue;
        const called = await invokeV2(config, execution, task.role, state, task.paths, { ...task, findings: unresolvedV2(state) }, methods, generate);
        if (!called.entry) return called.state;
        state = { ...called.state, work: [...called.state.work, called.entry], completedTasks: [...called.state.completedTasks, task.id] };
        if (called.entry.text.includes('ARCHITECTURE_BLOCKER:')) return reworkDevelopmentV2(state, 'architecture', 'prepare-context');
      }
      return { ...state, phase: 'development-self-check' as const };
    },
  });
  const selfCheck = createStep({ id: 'development-self-check', inputSchema: stateV2Schema, outputSchema: stateV2Schema,
    // 固定检查只产生证据，不生成研发交付。
    execute: async ({ inputData }) => {
      if (!active(inputData, 'development-self-check')) return inputData;
      await guard(inputData);
      const called = await invokeV2(config, execution, 'self-check', inputData, [], null, methods, generate);
      if (!called.entry) return called.state;
      const checks = await execution.runChecks();
      await guard(called.state);
      const state = { ...called.state, checks, checkedSourceHash: called.state.checkpointHash, work: [...called.state.work, called.entry] };
      if (!checksPassedV2(state)) {
        let route: StateV2['route'] = 'human';
        try { route = z.object({ route: z.enum(['frontend', 'backend', 'infrastructure', 'architecture', 'human']) }).parse(parseDevelopmentJson(called.entry.text)).route; } catch { /* 未知归属升级人工。 */ }
        if (route === 'human' || (route !== 'architecture' && !state.input.project.roles.includes(route))) return { ...state, outcome: 'manual-attention' as const };
        return reworkDevelopmentV2(state, route, route === 'architecture' ? 'prepare-context' : 'implement');
      }
      return { ...state, phase: 'review-code' as const };
    },
  });
  const review = createStep({ id: 'review-code', inputSchema: stateV2Schema, outputSchema: stateV2Schema,
    // reviewer失败和缺失报告均保留在评审阶段，绝不降级为成功。
    execute: async ({ inputData }) => {
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
        (text) => { const assessment = assessmentSchema.parse(parseDevelopmentJson(text)); validateAssessment(assessment, inputData); validateReviewResolutions(assessment, inputData); });
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
    },
  });
  const delivery = createStep({ id: 'assess-delivery', inputSchema: stateV2Schema, outputSchema: stateV2Schema,
    // 最终门只消费当前批准/检查/评审，按问题归属有界返工。
    execute: async ({ inputData }) => {
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
          // 多责任问题保守返回人工，避免隐式选择遗漏责任。
          (finding) => finding.route,
        ));
        const route = findings.some(
          // 业务/完整性问题不能通过实现重试或接受风险绕过。
          (finding) => finding.category === 'business',
        ) ? 'product' : findings.some(
          // 真实完整性问题直接停止人工处理。
          (finding) => finding.category === 'integrity',
        ) ? 'human' : routes.size === 1 ? [...routes][0] : 'human';
        const decision = route === 'product' ? 'clarify' as const : route === 'architecture' ? 'replan' as const : route === 'human' ? 'stop' as const : 'rework' as const;
        const state = { ...inputData, gates: [...inputData.gates, { decision, reasons: findings.map(
          // 完整保存所有未解决发现ID。
          (finding) => finding.id,
        ), sourceHash: inputData.checkpointHash, reportHash: latest.hash }] };
        if (route === 'product') return { ...state, outcome: 'clarification-required' as const };
        if (route === 'human') return { ...state, phase: 'resolve-findings' as const, outcome: findings.some(
          // 完整性问题不提供接受风险后通过的旁路。
          (finding) => finding.category === 'integrity',
        ) ? 'manual-attention' as const : 'in-progress' as const };
        return reworkDevelopmentV2(state, route, route === 'architecture' ? 'prepare-context' : 'implement');
      }
      // 非PASS原报告只能在全部原发现已有明确处理后进入此处；原报告保留。
      return { ...inputData, outcome: 'development-delivered' as const, gates: [...inputData.gates, { decision: 'deliver' as const, reasons: [], sourceHash: inputData.checkpointHash, reportHash: latest.hash }], delivery: { version: 'development-delivery.v2' as const, productHash: inputData.input.source.hash, planHash: inputData.planHash!, approvalHash: inputData.approvalHash!, contextHash: developmentHash(inputData.context), methodBundleHash: methods.hash, readinessHash: inputData.readiness!.hash, reviewHash: latest.hash, sourceHash: inputData.checkpointHash, files: await execution.snapshot(), checks: inputData.checks, resolutions: inputData.resolutions, limitations: ['受限研发交付；固定Node语法和登记smoke，不等于独立业务验收', '只读模型评审不证明完整业务质量；fixture仅验证原生控制流', '无生产部署、跨库原子交接和跨实例启动幂等'] } };
    },
  });
  const resolveFindings = createStep({ id: 'resolve-findings', inputSchema: stateV2Schema, outputSchema: stateV2Schema,
    suspendSchema: z.object({ hash: z.string(), reports: z.unknown() }), resumeSchema: findingsReviewSchema,
    // 无法自动归属、误报或低严重性延期由人工显式记录，源码变化即拒绝。
    execute: async ({ inputData, resumeData, suspend }) => {
      if (!active(inputData, 'resolve-findings')) return inputData;
      await guard(inputData);
      const hash = findingsHashV2(inputData);
      if (!resumeData) return suspend({ hash, reports: inputData.codeReviews });
      if (resumeData.hash !== hash) throw new Error('评审裁决版本不匹配');
      const state = applyFindingsReview(inputData, resumeData);
      return { ...state, phase: 'assess-delivery' as const };
    },
  });
  const recovery = createStep({ id: 'recover-development', inputSchema: stateV2Schema, outputSchema: stateV2Schema,
    suspendSchema: z.object({ hash: z.string(), checkpointHash: z.string(), phase: z.string(), role: z.string(), kind: z.string(), taskId: z.string().nullable() }), resumeSchema: recoveryReviewSchema,
    // 只允许一次人工接续，保持原失败phase和任务完成集。
    execute: async ({ inputData, resumeData, suspend }) => {
      if (inputData.outcome !== 'in-progress' || !inputData.recovery) return inputData;
      await guard(inputData);
      if (inputData.recoveries.length >= 1 || inputData.calls >= inputData.maxCalls) return { ...inputData, outcome: 'manual-attention' as const };
      if (inputData.recovery.hash !== recoveryHashV2(inputData)) throw new Error('v2恢复绑定漂移');
      if (!resumeData) return suspend(inputData.recovery);
      if (resumeData.hash !== inputData.recovery.hash) throw new Error('v2恢复版本不匹配');
      return { ...inputData, recoveries: [...inputData.recoveries, resumeData], recovery: null, outcome: resumeData.decision === 'stop' ? 'manual-attention' as const : 'in-progress' as const };
    },
  });
  const teamExecution = options.team ? createTeamExecution(config, execution, methods, generate, bind) : null;
  const iteration = createWorkflow({ id: options.id ? `${options.id}-iteration` : 'development-iteration-v2', inputSchema: stateV2Schema, outputSchema: stateV2Schema })
    .then(bind(context)).then(bind(architecture)).then(bind(assemble)).then(bind(readiness)).then(bind(resolveReadiness)).then(bind(approve))
    .then(teamExecution ?? bind(implement))
    .then(bind(selfCheck)).then(bind(review)).then(bind(delivery)).then(bind(resolveFindings)).then(bind(recovery)).commit();
  const workflow = createWorkflow({ id: options.id ?? 'development-execution-v2', description: '开发：上下文、架构、动态团队、并行实现、自检评审与研发交付', inputSchema: inputV2Schema, outputSchema: stateV2Schema }).then(bind(initialize)).dountil(iteration,
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
