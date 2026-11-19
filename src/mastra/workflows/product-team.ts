import { projectRepositoryRoot, projectSpec } from '../../business-engineering/project.js';
import { createStep, createWorkflow, type Step } from '@mastra/core/workflows';
import { createAgents } from '../agents/index.js';
import { productWorkspace } from '../project-workspaces.js';
import { verifyNacosAccess } from '../nacos-resources.js';
import type { NacosSnapshot } from '../nacos-resources.js';
import type { MastraCompositeStore } from '@mastra/core/storage';
import type { PracticeConfig } from '../config.js';
import { withRepositoryAssets } from '../../delivery/repository-assets.js';
import { publishFormalSpecification, type FormalSpecificationReceipt } from '../../delivery/remote-handoff.js';
import { createProductManagerPhases } from './product-manager.js';
import { deliverySchema, pendingSchema, reviewSchema, validateReview } from './delivery.js';

type StepBinder = <T extends Step<any, any, any, any, any, any>>(step: T) => T;

/** 从原 Run 快照装配产品角色，所有回流调用共享权限校验和存储。 */
export async function resolveProductAgents(config: PracticeConfig, resources: NacosSnapshot, storage?: MastraCompositeStore) {
  await verifyNacosAccess(config.nacosResources, resources);
  if (config.mode === 'live' && !storage) throw new Error('Nacos 产品角色缺少 Mastra 记忆存储');
  return createAgents(config, { resources, storage, workspace: productWorkspace(config) });
}

/** 装配产品团队原生三阶段及历史流程图。 */
export function createProductTeamWorkflow(agents: ReturnType<typeof createAgents>, config: PracticeConfig, storage?: MastraCompositeStore) {
  const bind: StepBinder = (step) => withRepositoryAssets(step, config);
  const review = createStep({
    id: 'review-product',
    description: '审阅交接｜产品负责人批准当前版本',
    inputSchema: deliverySchema,
    outputSchema: deliverySchema,
    suspendSchema: pendingSchema,
    resumeSchema: reviewSchema,
    // 产品审批属于产品团队的人工质量门，未批准版本不能交给研发团队。
    execute: async ({ inputData, resumeData, suspend, bail, runId }) => {
      if (inputData.mode !== config.mode) throw new Error('产品运行模式发生变化');
      const pending = pendingSchema.parse({ role: 'product', artifact: inputData.artifacts.at(-1), productReworkRound: inputData.productRework?.round ?? 0 });
      if (!resumeData) return suspend(pending);
      const decision = validateReview(pending, resumeData);
      const next = { ...inputData, reviews: [...inputData.reviews, decision] };
      if (decision.decision !== 'approve') return bail({ ...next, outcome: decision.decision === 'reject' ? 'rejected' as const : 'rework-requested' as const });
      // 只有人工确认后的需求文档和产品 Spec 才能进入正式 Run 分支；fixture 不接触远端。
      if (config.mode !== 'live') return next;
      const root = projectRepositoryRoot(config);
      const capability = inputData.correlation?.iterationId;
      if (!root || !capability) throw new Error('产品确认后缺少受控项目仓库或主要能力标识，不能提交正式规格');
      const handoff = await publishFormalSpecification(root, runId, capability, {
        'specs/requirements.md': inputData.brief.endsWith('\n') ? inputData.brief : `${inputData.brief}\n`,
        'specs/product-spec.md': pending.artifact.content.endsWith('\n') ? pending.artifact.content : `${pending.artifact.content}\n`,
      }, 'docs(spec): 提交已确认需求与产品规格', inputData.correlation?.engineeringRevision);
      const receipt: FormalSpecificationReceipt = { kind: 'product', handoff, paths: ['specs/requirements.md', 'specs/product-spec.md'], upstreamCommits: [] };
      return { ...next, formalSpecifications: [...(next.formalSpecifications ?? []), receipt] };
    },
  });
  const phases = createProductManagerPhases(agents, config.mode, bind, projectRepositoryRoot(config),
    /** 调用前复核授权并从 Run 快照装配。 */
    async resources => resolveProductAgents(config, resources, storage), projectSpec(config, 'product'),
    config.legacyProductWorkflow ? 'legacy' : config.nestedProductWorkflow ? 'nested' : 'native');
  const team = createWorkflow({ id: 'product-team', description: '对齐方向 → 完善规格 → 审阅交接', inputSchema: deliverySchema, outputSchema: deliverySchema });
  if (phases.graph === 'native') return team.then(phases.direction).then(phases.specification).then(bind(review)).commit();

  const complete = createStep({
    id: 'complete-product-team',
    inputSchema: deliverySchema,
    outputSchema: deliverySchema,
    // 团队边界负责把产品拒绝/退回终态传给主编排，阻止研发团队误接未批准版本。
    execute: async ({ inputData, bail }) => inputData.outcome === 'in-progress' ? inputData : bail(inputData),
  });
  return team.then(phases.draft).then(bind(review)).then(bind(complete)).commit();
}
