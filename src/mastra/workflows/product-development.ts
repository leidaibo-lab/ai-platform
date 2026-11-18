import { runArchiveLifecycle } from '../../delivery/run-archive.js';
/** 单个原生 Run 串联产品、动态开发团队、独立测试和外部发布回执。
 * ADR: docs/decisions/2026-11-07-mastra-full-delivery-lifecycle.md
 * ADR: docs/decisions/2026-11-18-platform-team-harness.md（业务编排与团队/平台机制的职责边界）
 */
import { createStep, createWorkflow } from '@mastra/core/workflows';
import { z } from 'zod';
import type { createAgents } from '../agents/index.js';
import type { PracticeConfig } from '../config.js';
import { generateV2, type GeneratorV2 } from '../../development/v2/agents.js';
import { createProductTeamWorkflow } from './product-team.js';
import { createDevelopmentTeamWorkflow } from './development-team.js';
import { deliverySchema } from './delivery.js';
import { stateV2Schema } from '../../development/v2/contracts.js';
import { developmentHash } from '../../development/contracts.js';
import { emptyQuality, lifecycleSchema, qualityHash, releaseHash } from '../../delivery/contracts.js';
import { assertCandidate, createTestingWorkflow } from '../../delivery/testing.js';
import { createDeploymentWorkflow } from '../../delivery/deployment.js';
import { assetIdSchema, correlationSchema } from '../../delivery/asset-identity.js';
import { registerAssetRun } from '../../delivery/asset-catalog.js';
import { withRepositoryAssets } from '../../delivery/repository-assets.js';
import { intakeModeSchema } from '../../intake/contracts.js';
import { loadNacosSnapshot } from '../nacos-resources.js';
import type { MastraCompositeStore } from '@mastra/core/storage';

const inputSchema = z.object({ intakeMode: intakeModeSchema.optional(), guidedIntake: z.boolean().optional(), iterationId: assetIdSchema.default('unassigned'), brief: z.string().trim().min(1).max(12000) });

/** 采用 Workflow 嵌套和 foreach；人工批准保持为原生 suspend/resume。 */
export function createProductDevelopmentWorkflow(agents: ReturnType<typeof createAgents>, config: PracticeConfig, generate: GeneratorV2 = generateV2, options: { legacyBlocked?: boolean; storage?: MastraCompositeStore } = {}) {
  const initialize = createStep({ id: 'initialize-product-development', description: '从原始需求启动完整产研流程', inputSchema, outputSchema: deliverySchema,
    // 不接受客户端伪造产品稿、批准或模式。
    execute: async ({ inputData, runId }) => {
      const correlation = correlationSchema.parse({ projectId: 'hrm', iterationId: inputData.iterationId, runId, workflowId: 'productDevelopmentWorkflow' });
      if (config.hrmRepositoryRoot) registerAssetRun(config.hrmRepositoryRoot, correlation, inputData.brief);
      const intakeMode = inputData.intakeMode ?? (inputData.guidedIntake === true ? 'clarify' : 'autofill');
      const nacosResources = config.nacosResources ? await loadNacosSnapshot(config.nacosResources) : undefined;
      return { nacosResources, intake: { intakeMode, enabled: intakeMode === 'clarify', ready: intakeMode === 'autofill', round: 0, history: [] }, intakeMode, brief: inputData.brief, correlation, mode: config.mode, contextBudgetLevel: 0, artifacts: [], reviews: [], formalSpecifications: [], outcome: 'in-progress' as const };
    },
  });
  const developmentTeam = createDevelopmentTeamWorkflow(agents, config, generate, options);
  const routeProductTeamResult = createStep({
    id: 'route-product-team-result',
    inputSchema: deliverySchema,
    outputSchema: deliverySchema,
    // 主编排只把已批准的产品交给研发团队；产品拒绝或退回在团队边界处结束本 Run。
    execute: async ({ inputData, bail }) => inputData.outcome === 'in-progress' ? inputData : bail(inputData),
  });
  const lifecycle = createStep({ id: 'initialize-delivery-lifecycle', description: '研发交付进入独立测试和发布主链', inputSchema: stateV2Schema, outputSchema: lifecycleSchema,
    // 新生命周期保存各轮角色证据，原开发状态及累计预算保持不变。
    execute: async ({ inputData, getInitData, bail }) => { const state = lifecycleSchema.parse({ version: 'delivery-lifecycle.v1', brief: getInitData<z.infer<typeof inputSchema>>().brief, development: inputData, formalSpecifications: inputData.formalSpecification ? [inputData.formalSpecification] : [], quality: emptyQuality(), qualityHistory: [], developmentHistory: [], release: { plan: null, qualityHash: null, approval: null, hash: null, receipt: null, health: null, rollback: null, authority: 'local-human-report' }, releaseHistory: [], outcome: inputData.outcome === 'development-delivered' ? 'in-progress' : inputData.outcome === 'rework-exhausted' ? 'rework-exhausted' : 'blocked', limitations: ['自动测试仅执行项目授权的登记套件，语义覆盖由测试负责人确认，人工用例结果单独标记。', '部署、健康及回滚由外部平台执行并人工回填；当前未接入自动 CI/CD 或认证身份。'] }); return state.outcome === 'in-progress' ? state : bail(state); },
  });
  const finish = createStep({ id: 'confirm-final-delivery', description: '汇总产品、开发、测试和部署证据，确认最终交付', inputSchema: lifecycleSchema, outputSchema: lifecycleSchema,
    // 生成计划或研发自检均不能替代质量放行和实际外部发布回执。
    execute: async ({ inputData: state }) => {
      if (state.outcome !== 'delivery-confirmed') return state;
      await assertCandidate(state, developmentTeam.execution.port);
      if (state.quality.status !== 'passed' || state.quality.review?.decision !== 'pass' || state.quality.reportHash !== qualityHash(state) || state.release.qualityHash !== state.quality.reportHash || state.release.hash !== releaseHash(state) || state.release.receipt?.status !== 'succeeded' || state.release.receipt.releaseHash !== state.release.hash || state.release.receipt.sourceHash !== state.development.checkpointHash || state.release.health?.releaseHash !== state.release.hash || state.release.health.deploymentReceiptHash !== developmentHash(state.release.receipt) || !state.release.health.checks.length || !state.release.health.checks.every(
        // 只有批准的发布后检查全部有成功回执才形成成功终态。
        (check) => check.status === 'passed',
      )) throw new Error('最终交付缺少同版本质量、发布或健康证据');
      return { ...state, outcome: config.mode === 'fixture' ? 'fixture-completed' as const : 'delivery-confirmed' as const };
    },
  });
  const deliveryTeam = createWorkflow({ id: 'delivery-team', description: '交付团队：汇总产品、研发、测试与发布证据并确认最终交付', inputSchema: lifecycleSchema, outputSchema: lifecycleSchema })
    .then(withRepositoryAssets(developmentTeam.execution.bind(finish), config))
    .commit();
  const main = createWorkflow({ options: runArchiveLifecycle(config), id: 'product-development', description: '完整产研：产品 → 开发（动态团队、并行、受限委派）→ 测试（缺陷修复与回归）→ 部署（审批、外部回执、健康检查与回滚）→ 最终交付', inputSchema, outputSchema: z.union([lifecycleSchema, deliverySchema]) })
    .then(withRepositoryAssets(initialize, config)).then(createProductTeamWorkflow(agents, config, options.storage)).then(withRepositoryAssets(routeProductTeamResult, config)).then(developmentTeam.workflow);
  return main.then(withRepositoryAssets(lifecycle, config)).then(createTestingWorkflow(agents, config, developmentTeam.execution, generate)).then(createDeploymentWorkflow(agents, config, developmentTeam.execution)).then(deliveryTeam).commit();
}

export { executionResolver } from './development-team.js';
