import { createStep, createWorkflow } from '@mastra/core/workflows';
import type { MastraCompositeStore } from '@mastra/core/storage';
import { bindProjectWorkflow, createProjectCorrelation, projectTarget, scopedProjectConfig } from '../../business-engineering/project.js';
import { developmentHash } from '../../development/contracts.js';
import { registerAssetRun } from '../../delivery/asset-catalog.js';
import { withRepositoryAssets } from '../../delivery/repository-assets.js';
import { independentTeamRunInputSchema, normalizeIndependentTeamRunInput } from '../../team/independent-run-input.js';
import { completeIndependentTeamRun, independentTeamRunOutputSchema } from '../../team/independent-run-output.js';
import { loadNacosSnapshot } from '../nacos-resources.js';
import { assertCompleteMethods } from '../team-methods.js';
import type { PracticeConfig } from '../config.js';
import type { createAgents } from '../agents/index.js';
import { deliverySchema } from './delivery.js';
import { createProductTeamWorkflow } from './product-team.js';

/** 装配独立产品团队，沿用原生产品审查与人工批准，不进入研发。 */
export function createIndependentProductWorkflow(agents: ReturnType<typeof createAgents>, registryConfig: PracticeConfig, storage?: MastraCompositeStore) {
  const config = scopedProjectConfig(registryConfig);
  const inputSchema = independentTeamRunInputSchema.refine(input => input.teamId === 'product' && input.source.kind === 'new-requirement' && input.payload.teamId === 'product', '独立产品入口只接受新需求');
  const initialize = createStep({
    id: 'initialize-team-run', inputSchema, outputSchema: deliverySchema,
    // 只从服务端配置和规范需求创建产品状态，不接受客户端审批。
    execute: async ({ inputData, runId }) => {
      if (inputData.payload.teamId !== 'product') throw new Error('产品输入无效');
      const correlation = createProjectCorrelation(config, inputData, runId);
      const target = projectTarget(config);
      if (target) registerAssetRun(target.root, correlation, inputData.payload.brief, target);
      if (config.mode === 'live' && config.nacosResources && !config.nacosResources.methods) throw new Error('新 live Run 必须配置完整 Nacos 团队方法目录');
      const nacosResources = config.nacosResources ? await loadNacosSnapshot(config.nacosResources) : undefined;
      if (nacosResources?.methods) assertCompleteMethods(nacosResources.methods);
      const intakeMode = inputData.payload.intakeMode;
      return deliverySchema.parse({ ...(config.mode === 'live' ? { requirementTracking: true, productHandoffFormat: 'paired-markdown.v1' } : {}), ...(!config.legacyProductWorkflow ? { productFlow: config.nestedProductWorkflow ? 'three-stage' : config.nativeThreeStageProductWorkflow ? 'native-three-stage' : 'four-step' } : {}), nacosResources, intake: { intakeMode, enabled: intakeMode === 'clarify', ready: intakeMode === 'autofill', round: 0, history: [] }, intakeMode, brief: inputData.payload.brief, correlation, mode: config.mode, contextBudgetLevel: 0, artifacts: [], reviews: [], formalSpecifications: [], outcome: 'in-progress' });
    },
  });
  const finish = createStep({
    id: 'complete-team-run', inputSchema: deliverySchema, outputSchema: independentTeamRunOutputSchema,
    // 输出仅从原生初始化输入及已审查产品结果投影。
    execute: async ({ inputData, getInitData, getStepResult }) => {
      const normalized = normalizeIndependentTeamRunInput(getInitData());
      const initial = getStepResult(initialize);
      if (!initial.correlation || normalized.input.payload.teamId !== 'product' || initial.brief !== normalized.input.payload.brief) throw new Error('独立产品输入绑定不一致');
      return completeIndependentTeamRun('product', { inputHash: normalized.inputHash, sourceHash: developmentHash({ kind: 'new-requirement', brief: initial.brief }), correlation: initial.correlation }, inputData);
    },
  });
  const workflow = createWorkflow({ id: 'independent-product', inputSchema, outputSchema: independentTeamRunOutputSchema })
    .then(withRepositoryAssets(initialize, config)).then(createProductTeamWorkflow(agents, config, storage)).then(withRepositoryAssets(finish, config)).commit();
  return bindProjectWorkflow(workflow, registryConfig, { workflowId: 'independent-product', initializeId: 'initialize-team-run', alwaysGuard: true });
}
