import { createTeamRunPolicy } from '../../team/run-policy.js';
import { architectureDocumentFormat } from '../../development/v2/architecture-document.js';
import { buildSuccessorBaseline, successorSource } from '../../intake/successor-run.js';
import { assertProjectCorrelation, bindProjectWorkflow, createProjectCorrelation, scopedProjectConfig, projectRepositoryRoot, projectTarget } from '../../business-engineering/project.js';
import { runArchiveLifecycle } from '../../delivery/run-archive.js';
/** 单个原生 Run 串联产品、动态开发团队、独立测试和 MR 交付。
 * ADR: docs/decisions/2026-11-19-merge-request-delivery.md
 * ADR: docs/decisions/2026-11-19-three-layer-harness.md（业务编排与团队/平台机制的职责边界）
 */
import { createStep, createWorkflow } from '@mastra/core/workflows';
import { z } from 'zod';
import type { createAgents } from '../agents/index.js';
import type { PracticeConfig } from '../config.js';
import { generateV2, type GeneratorV2 } from '../../development/v2/agents.js';
import { createProductTeamWorkflow } from './product-team.js';
import { createDevelopmentTeamWorkflow } from './development-team.js';
import { deliverySchema, successorBaselineSchema } from './delivery.js';
import { stateV2Schema } from '../../development/v2/contracts.js';
import { developmentHash } from '../../development/contracts.js';
import { emptyQuality, lifecycleSchema } from '../../delivery/contracts.js';
import { createTestingWorkflow } from '../../delivery/testing.js';
import { createMergeRequestDelivery } from '../../delivery/merge-request.js';
import { assetIdSchema, correlationSchema } from '../../delivery/asset-identity.js';
import { registerAssetRun } from '../../delivery/asset-catalog.js';
import { withRepositoryAssets } from '../../delivery/repository-assets.js';
import { intakeModeSchema } from '../../intake/contracts.js';
import { loadNacosSnapshot } from '../nacos-resources.js';
import type { MastraCompositeStore } from '@mastra/core/storage';
import { assertCompleteMethods } from '../team-methods.js';
import { readAuthorizedProductSources } from '../stage-workspace.js';
import { migrationReferenceSchema } from '../../intake/migration-contracts.js';
import { resolveRunMigration } from '../../intake/run-migration.js';

const inputSchema = z.object({ migration: migrationReferenceSchema.optional(), projectId: correlationSchema.shape.projectId.optional(), intakeMode: intakeModeSchema.optional(), guidedIntake: z.boolean().optional(), iterationId: assetIdSchema.default('unassigned'), brief: z.string().trim().min(1).max(12000), successorBaseline: successorBaselineSchema.optional() }).strict();

/** 采用 Workflow 嵌套和 foreach；人工批准保持为原生 suspend/resume。 */
export function createProductDevelopmentWorkflow(agents: ReturnType<typeof createAgents>, config: PracticeConfig, generate: GeneratorV2 = generateV2, options: { legacyBlocked?: boolean; fixtureRequirementTracking?: boolean; fixtureArchitectureDocument?: boolean; storage?: MastraCompositeStore } = {}) {
  const registryConfig = config;
  config = scopedProjectConfig(config);
  const initialize = createStep({ id: 'initialize-product-development', description: '从原始需求启动完整产研流程', inputSchema, outputSchema: deliverySchema,
    // 不接受客户端伪造产品稿、批准或模式。
    execute: async ({ inputData, runId, mastra }) => {
      const project = projectTarget(config);
      const engineering = config.engineeringProject;
      const correlation = correlationSchema.parse(createProjectCorrelation(config, inputData, runId));
      const migrated = inputData.migration ? await resolveRunMigration(mastra!.getWorkflow('productDevelopmentWorkflow'), config, inputData.migration) : undefined;
      if (migrated && (migrated.lineage.sourceRunId === runId || migrated.product.correlation?.projectId !== correlation.projectId || inputData.brief !== migrated.product.brief || inputData.successorBaseline)) throw new Error('迁移目标与来源项目、需求或版本不一致');
      const baseline = inputData.successorBaseline;
      if (baseline && (engineering || baseline.projectId)) {
        const storage = options.storage ?? mastra?.getStorage();
        const store = await storage?.getStore('workflows');
        const source = await store?.loadWorkflowSnapshot({ workflowName: 'product-development', runId: baseline.sourceRunId });
        const root = projectRepositoryRoot(config);
        if (!root || source?.status !== 'success') throw new Error('后继 Run 缺少已结束且可读取的项目来源');
        const product = source.context['product-team'];
        const delivery = successorSource(source.result, product?.status === 'success' ? product.output : undefined);
        assertProjectCorrelation(config, delivery?.correlation, { allowEarlierRevision: true });
        const confirmed = buildSuccessorBaseline(root, baseline.sourceRunId, delivery, baseline.artifacts.map(/** 只用申请的规格类型，正文和版本由服务端重读。 */item => item.kind), inputData.brief);
        if (developmentHash(confirmed) !== developmentHash(baseline)) throw new Error('后继 Run 规格与来源证据不一致');
      }
      if (project) registerAssetRun(project.root, correlation, inputData.brief, project);
      const intakeMode = inputData.intakeMode ?? (inputData.guidedIntake === true ? 'clarify' : 'autofill');
      if (config.mode === 'live' && config.nacosResources && !config.nacosResources.methods) throw new Error('新 live Run 必须配置完整 Nacos 团队方法目录');
      const nacosResources = config.nacosResources ? await loadNacosSnapshot(config.nacosResources) : undefined;
      if (nacosResources?.methods) assertCompleteMethods(nacosResources.methods);
      return { teamRunPolicy: createTeamRunPolicy(), ...(migrated ? { migration: migrated.lineage } : {}), productSources: migrated?.files ?? (!config.engineeringProject && !config.engineeringProjects ? readAuthorizedProductSources(projectRepositoryRoot(config)) : {}), ...(!config.legacyDevelopmentWorkflow && (config.mode === 'live' || options.fixtureArchitectureDocument) ? { architectureDocumentFormat } as const : {}), ...(config.mode === 'live' || options.fixtureRequirementTracking ? { requirementTracking: true as const, productHandoffFormat: 'paired-markdown.v1' as const } : {}), ...(!config.legacyProductWorkflow ? { productFlow: config.nestedProductWorkflow ? 'three-stage' as const : config.nativeThreeStageProductWorkflow ? 'native-three-stage' as const : 'four-step' as const } : {}), nacosResources, intake: { intakeMode, enabled: intakeMode === 'clarify', ready: intakeMode === 'autofill', round: 0, history: [] }, intakeMode, brief: inputData.brief, successorBaseline: inputData.successorBaseline, correlation, mode: config.mode, contextBudgetLevel: 0, artifacts: [], reviews: [], formalSpecifications: [], outcome: 'in-progress' as const };
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
  const lifecycle = createStep({ id: 'initialize-delivery-lifecycle', description: '研发交付进入独立测试与交付', inputSchema: stateV2Schema, outputSchema: lifecycleSchema,
    // 新生命周期保存各轮角色证据，原开发状态及累计预算保持不变。
    execute: async ({ inputData, getInitData, bail }) => { const state = lifecycleSchema.parse({ version: 'delivery-lifecycle.v1', brief: getInitData<z.infer<typeof inputSchema>>().brief, development: inputData, formalSpecifications: inputData.formalSpecification ? [inputData.formalSpecification] : [], quality: emptyQuality(), qualityHistory: [], developmentHistory: [], release: { plan: null, qualityHash: null, approval: null, hash: null, receipt: null, health: null, rollback: null, authority: 'local-human-report' }, releaseHistory: [], outcome: inputData.outcome === 'development-delivered' ? 'in-progress' : inputData.outcome === 'rework-exhausted' ? 'rework-exhausted' : 'blocked', limitations: ['自动测试仅执行项目授权的登记套件，语义覆盖由测试负责人确认，人工用例结果单独标记。', '交付终点为向 main 提交 MR 并记录回执。'] }); return state.outcome === 'in-progress' ? state : bail(state); },
  });
  const main = createWorkflow({ options: runArchiveLifecycle(config), id: 'product-development', description: '产研主线：产品 → 研发 → 测试 → 交付 MR', inputSchema, outputSchema: z.union([lifecycleSchema, deliverySchema]) })
    .then(withRepositoryAssets(initialize, config)).then(createProductTeamWorkflow(agents, config, options.storage)).then(withRepositoryAssets(routeProductTeamResult, config)).then(developmentTeam.workflow);
  const tested = main.then(withRepositoryAssets(lifecycle, config)).then(createTestingWorkflow(agents, config, developmentTeam.execution, generate));
  return bindProjectWorkflow(tested.then(createMergeRequestDelivery(config, developmentTeam.execution)).commit(), registryConfig);
}

export { executionResolver } from './development-team.js';
