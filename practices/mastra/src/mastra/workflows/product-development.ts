/** 单个原生 Run 串联产品、动态开发团队、独立测试和外部发布回执。
 * ADR: docs/decisions/2026-11-07-mastra-full-delivery-lifecycle.md
 */
import { createBlockerClarificationWorkflow } from '../../intake/blocker-workflow.js';
import { blockerCycleSchema } from '../../intake/blocker-contracts.js';
import { createIntakeWorkflow } from '../../intake/workflow.js';
import { createStep, createWorkflow } from '@mastra/core/workflows';
import { existsSync, lstatSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import type { createAgents } from '../agents/index.js';
import type { PracticeConfig } from '../config.js';
import { createDevelopmentExecution } from '../../development/hrm-execution.js';
import { DevelopmentExecution } from '../../development-execution.js';
import { seedDevelopment } from '../../development-service.js';
import { developmentHash, projectSchema } from '../../development/contracts.js';
import { inputV2Schema, stateV2Schema, type InputV2 } from '../../development/v2/contracts.js';
import { createExecutionScope } from '../../development/v2/execution-scope.js';
import { generateV2, type GeneratorV2 } from '../../development/v2/agents.js';
import { deliverySchema, pendingSchema, reviewSchema, validateReview } from './delivery.js';
import { createProductWorkflow } from './product.js';
import { createDevelopmentWorkflowV2 } from './development-v2.js';
import { emptyQuality, lifecycleSchema, qualityHash, releaseHash } from '../../delivery/contracts.js';
import { assertCandidate, createTestingWorkflow } from '../../delivery/testing.js';
import { createDeploymentWorkflow } from '../../delivery/deployment.js';
import { assetIdSchema, correlationSchema } from '../../delivery/asset-identity.js';
import { registerAssetRun } from '../../delivery/asset-catalog.js';
import { withRepositoryAssets } from '../../delivery/repository-assets.js';

const inputSchema = z.object({ guidedIntake: z.boolean().optional(), iterationId: assetIdSchema.default('unassigned'), brief: z.string().trim().min(1).max(12000) });
const scopeReviewSchema = z.object({ project: projectSchema, reviewer: z.string().trim().min(1).max(100), comment: z.string().trim().min(1).max(2000), maxReworks: z.number().int().min(0).max(3).default(1) });

/** 将每个 Run 的候选目录与输入绑定，步骤结束即关闭执行环境。 */
export function executionResolver(config: PracticeConfig) {
  const parent = resolve(dirname(fileURLToPath(config.databaseUrl)), 'development-runs');
  /** 目录名仅由宿主 Run 标识派生，恢复不覆盖现有源码或输入。 */
  return (input: InputV2): DevelopmentExecution => {
    mkdirSync(parent, { recursive: true, mode: 0o700 });
    if (lstatSync(parent).isSymbolicLink()) throw new Error('运行根目录不能是符号链接');
    const base = resolve(parent, developmentHash(input.source.runId));
    const directory = input.continuation ? resolve(base, 'revisions', developmentHash(input)) : base;
    if (input.continuation) {
      for (const path of [base, resolve(base, 'revisions')]) { if (existsSync(path) && lstatSync(path).isSymbolicLink()) throw new Error('候选版本目录不能是符号链接'); }
      mkdirSync(dirname(directory), { recursive: true, mode: 0o700 });
    }
    if (!existsSync(directory)) seedDevelopment(directory, input);
    else {
      if (!lstatSync(directory).isDirectory() || lstatSync(directory).isSymbolicLink()) throw new Error('运行目录必须为普通目录');
      const inputFile = resolve(directory, 'input.json');
      if (lstatSync(inputFile).isSymbolicLink()) throw new Error('运行输入不能是符号链接');
      const saved = inputV2Schema.parse(JSON.parse(readFileSync(inputFile, 'utf8')));
      if (developmentHash(saved) !== developmentHash(input)) throw new Error('运行项目输入与保存版本不一致');
    }
    return createDevelopmentExecution(resolve(directory, 'candidate'), input.project);
  };
}

/** 采用 Workflow 嵌套和 foreach；人工批准保持为原生 suspend/resume。 */
export function createProductDevelopmentWorkflow(agents: ReturnType<typeof createAgents>, config: PracticeConfig, generate: GeneratorV2 = generateV2, options: { legacyBlocked?: boolean } = {}) {
  const initialize = createStep({ id: 'initialize-product-development', description: '从原始需求启动完整产研流程', inputSchema, outputSchema: deliverySchema,
    // 不接受客户端伪造产品稿、批准或模式。
    execute: async ({ inputData, runId }) => {
      const correlation = correlationSchema.parse({ projectId: 'hrm', iterationId: inputData.iterationId, runId, workflowId: 'productDevelopmentWorkflow' });
      if (config.hrmRepositoryRoot) registerAssetRun(config.hrmRepositoryRoot, correlation, inputData.brief);
      return { intake: { enabled: !!inputData.guidedIntake, ready: false, round: 0, history: [] }, brief: inputData.brief, correlation, mode: config.mode, artifacts: [], reviews: [], outcome: 'in-progress' as const };
    },
  });
  const review = createStep({ id: 'review-product', description: '人工确认产品需求与验收边界', inputSchema: deliverySchema, outputSchema: deliverySchema, suspendSchema: pendingSchema, resumeSchema: reviewSchema,
    // 产品拒绝或退回在当前 Run 留存终态，不进入代码执行。
    execute: async ({ inputData, resumeData, suspend, bail }) => {
      if (inputData.mode !== config.mode) throw new Error('产品运行模式发生变化');
      const pending = pendingSchema.parse({ role: 'product', artifact: inputData.artifacts.at(-1), productReworkRound: 0 });
      if (!resumeData) return suspend(pending);
      const decision = validateReview(pending, resumeData);
      const next = { ...inputData, reviews: [...inputData.reviews, decision] };
      if (decision.decision !== 'approve') return bail({ ...next, outcome: decision.decision === 'reject' ? 'rejected' as const : 'rework-requested' as const });
      return next;
    },
  });
  const scope = createStep({ id: 'confirm-project-scope', description: '确认项目文件、可写范围、检查与团队角色', inputSchema: deliverySchema, outputSchema: inputV2Schema,
    suspendSchema: z.object({ productHash: z.string(), instruction: z.string(), projectFields: z.array(z.string()) }), resumeSchema: scopeReviewSchema,
    // 从本 Run 已批准产物派生开发输入；manifest 是显式文件授权。
    execute: async ({ inputData, resumeData, suspend, runId }) => {
      if (inputData.mode !== config.mode) throw new Error('项目授权模式发生变化');
      const product = inputData.artifacts.find(
        // 产品原文只能来自当前嵌套产品流程。
        (artifact) => artifact.stage === 'product',
      );
      if (!product || !inputData.reviews.some(
        // 不接受其他产品版本的批准。
        (decision) => decision.role === 'product' && decision.decision === 'approve' && decision.artifactHash === product.hash,
      )) throw new Error('开发缺少当前产品批准');
      if (!resumeData) return suspend({ productHash: product.hash, instruction: '确认已关联仓库、当前代码版本与整体权限。技术文件拆分和实际团队由架构与开发Agent提出，后续方案批准后才实施；旧CLI的显式manifest仍兼容。', projectFields: ['id', 'files', 'writablePaths', 'checkFiles', 'roles'] });
      return inputV2Schema.parse({ repositoryHandoff: inputData.repositoryHandoff, correlation: inputData.correlation, source: { kind: 'approved-product', workflowId: 'product-development', runId, hash: product.hash, content: product.content, evidence: product.evidence }, project: resumeData.project, maxReworks: resumeData.maxReworks, scopeApproval: { reviewer: resumeData.reviewer, comment: resumeData.comment, productHash: product.hash } });
    },
  });
  const execution = createExecutionScope(executionResolver(config), config.mode === 'live' && !!config.hrmRepositoryRoot);
  const development = createDevelopmentWorkflowV2(config, execution.port, false, generate, { id: 'development-team', team: true, bind: execution.bind });
  const openClarification = createStep({ id: 'open-development-clarification', inputSchema: stateV2Schema, outputSchema: blockerCycleSchema,
    // 沿用本Run真实产品批准和原始回答，后续修订使用独立版本，不重填原始需求。
    execute: async ({ inputData, getStepResult }) => blockerCycleSchema.parse({ development: inputData, approvedProduct: getStepResult('review-product'), round: 1, history: [] }),
  });
  const clarification = createBlockerClarificationWorkflow(agents, config, executionResolver(config), generate);
  const lifecycle = createStep({ id: 'initialize-delivery-lifecycle', description: '研发交付进入独立测试和发布主链', inputSchema: stateV2Schema, outputSchema: lifecycleSchema,
    // 新生命周期保存各轮角色证据，原开发状态及累计预算保持不变。
    execute: async ({ inputData, getInitData, bail }) => { const state = lifecycleSchema.parse({ version: 'delivery-lifecycle.v1', brief: getInitData<z.infer<typeof inputSchema>>().brief, development: inputData, quality: emptyQuality(), qualityHistory: [], developmentHistory: [], release: { plan: null, qualityHash: null, approval: null, hash: null, receipt: null, health: null, rollback: null, authority: 'local-human-report' }, outcome: inputData.outcome === 'development-delivered' ? 'in-progress' : inputData.outcome === 'rework-exhausted' ? 'rework-exhausted' : 'blocked', limitations: ['自动测试仅执行项目授权的登记套件，语义覆盖由测试负责人确认，人工用例结果单独标记。', '部署、健康及回滚由外部平台执行并人工回填；当前未接入自动 CI/CD 或认证身份。'] }); return state.outcome === 'in-progress' ? state : bail(state); },
  });
  const finish = createStep({ id: 'confirm-final-delivery', description: '汇总产品、开发、测试和部署证据，确认最终交付', inputSchema: lifecycleSchema, outputSchema: lifecycleSchema,
    // 生成计划或研发自检均不能替代质量放行和实际外部发布回执。
    execute: async ({ inputData: state }) => {
      if (state.outcome !== 'delivery-confirmed') return state;
      await assertCandidate(state, execution.port);
      if (state.quality.status !== 'passed' || state.quality.review?.decision !== 'pass' || state.quality.reportHash !== qualityHash(state) || state.release.qualityHash !== state.quality.reportHash || state.release.hash !== releaseHash(state) || state.release.receipt?.status !== 'succeeded' || state.release.receipt.releaseHash !== state.release.hash || state.release.receipt.sourceHash !== state.development.checkpointHash || state.release.health?.releaseHash !== state.release.hash || state.release.health.deploymentReceiptHash !== developmentHash(state.release.receipt) || !state.release.health.checks.length || !state.release.health.checks.every(
        // 只有批准的发布后检查全部有成功回执才形成成功终态。
        (check) => check.status === 'passed',
      )) throw new Error('最终交付缺少同版本质量、发布或健康证据');
      return { ...state, outcome: config.mode === 'fixture' ? 'fixture-completed' as const : 'delivery-confirmed' as const };
    },
  });
  const main = createWorkflow({ id: 'product-development', description: '完整产研：产品 → 开发（动态团队、并行、受限委派）→ 测试（缺陷修复与回归）→ 部署（审批、外部回执、健康检查与回滚）→ 最终交付', inputSchema, outputSchema: z.union([lifecycleSchema, deliverySchema]) })
    .then(withRepositoryAssets(initialize, config)).then(createIntakeWorkflow(agents, config.mode,
      /** 澄清角色的建议与显式回答同样属于交接资产。 */
      step => withRepositoryAssets(step, config))).then(createProductWorkflow(agents, config.mode, deliverySchema,
      // 每个产品职责形成独立可追溯版本，保持原生子流程结构。
      (step) => withRepositoryAssets(step, config), config.hrmRepositoryRoot,
    )).then(withRepositoryAssets(review, config)).then(withRepositoryAssets(scope, config)).then(development);
  // 旧图选项仅用于持久化迁移回归，正式入口始终接通澄清。
  const ready = options.legacyBlocked ? main : main.then(openClarification).branch([[/** 只有尚未实施的业务阻塞进入产品澄清循环。 */async ({ inputData }) => inputData.development.outcome === 'clarification-required' && inputData.development.completedTasks.length === 0, clarification]]).map(/** 未阻塞时不调用产品模型，直接继续现有交付。 */async ({ inputData, getStepResult }) => inputData['resolve-development-blockers']?.development ?? getStepResult(openClarification).development, { id: 'continue-after-clarification' });
  return ready.then(withRepositoryAssets(lifecycle, config)).then(createTestingWorkflow(agents, config, execution, generate)).then(createDeploymentWorkflow(agents, config, execution)).then(withRepositoryAssets(execution.bind(finish), config)).commit();
}
