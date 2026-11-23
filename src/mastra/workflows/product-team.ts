import { decideProductLoop } from '../../team/product-loop.js';
import { describeProductStep, productSteps } from './product-steps.js';
import { publishProductHandoff } from '../../business-engineering/product-handoff.js';
import { projectRepositoryRoot, projectSpec } from '../../business-engineering/project.js';
import { deliveryContractForRun } from '../../business-engineering/delivery-contract.js';
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

/** 装配产品团队四步流程及历史流程图。 */
export function createProductTeamWorkflow(agents: ReturnType<typeof createAgents>, config: PracticeConfig, storage?: MastraCompositeStore) {
  const bind: StepBinder = (step) => withRepositoryAssets(step, config);
  const review = createStep({
    id: 'review-product',
    description: describeProductStep(productSteps[3]),
    inputSchema: deliverySchema,
    outputSchema: deliverySchema,
    suspendSchema: pendingSchema,
    resumeSchema: reviewSchema,
    // 产品审批属于产品团队的人工质量门，未批准版本不能交给研发团队。
    execute: async ({ inputData, resumeData, suspend, bail, runId }) => {
      if (inputData.mode !== config.mode) throw new Error('产品运行模式发生变化');
      const pending = pendingSchema.parse({ role: 'product', artifact: inputData.artifacts.at(-1), productReworkRound: inputData.productRework?.round ?? 0 });
      if (!resumeData && decideProductLoop('human-review', pending.artifact.hash, 'blocked') === 'block') return suspend(pending);
      if (!resumeData) throw new Error('产品审批缺少恢复数据');
      const decision = validateReview(pending, resumeData);
      if (decision.decision === 'approve' && inputData.productQualityReview?.loop && (inputData.productQualityReview.productHash !== pending.artifact.hash || inputData.productQualityReview.loop.status !== 'passed')) throw new Error('产品独立复审未通过，请提交返工意见或终止');
      const next = { ...inputData, reviews: [...inputData.reviews, decision] };
      const action = decideProductLoop('human-review', pending.artifact.hash, decision.decision === 'approve' ? 'completed' : decision.decision === 'reject' ? 'stopped' : 'rework');
      if (action === 'stop' || action === 'request-rework') return bail({ ...next, outcome: action === 'stop' ? 'rejected' as const : 'rework-requested' as const });
      if (action !== 'complete') throw new Error('产品审批状态无效');
      // 只有人工确认后的需求文档和产品 Spec 才能进入正式 Run 分支；fixture 不接触远端。
      if (config.mode !== 'live') return next;
      const root = projectRepositoryRoot(config);
      const correlation = inputData.correlation;
      if (!root || !correlation) throw new Error('产品确认后缺少受控项目仓库或主要能力标识，不能提交正式规格');
      const { iterationId: capability, engineeringRevision } = correlation;
      if (inputData.productHandoffFormat) {
        const contract = deliveryContractForRun(config, correlation).contract;
        const receipt = await publishProductHandoff(root, correlation.runId, capability, pending.artifact.content, engineeringRevision, { requirements: contract.paths.requirements, productSpecification: contract.paths.productSpecification });
        return { ...next, formalSpecifications: [...(next.formalSpecifications ?? []), receipt] };
      }
      const paths = correlation.deliveryContractHash
        ? deliveryContractForRun(config, correlation).contract.paths
        : { requirements: 'specs/requirements.md', productSpecification: 'specs/product-spec.md' };
      const files = {
        [paths.requirements.replaceAll('{iterationId}', capability)]: inputData.brief.endsWith('\n') ? inputData.brief : `${inputData.brief}\n`,
        [paths.productSpecification.replaceAll('{iterationId}', capability)]: pending.artifact.content.endsWith('\n') ? pending.artifact.content : `${pending.artifact.content}\n`,
      };
      const handoff = await publishFormalSpecification(root, runId, capability, files, 'docs(spec): 提交已确认需求与产品规格', engineeringRevision, Object.keys(files));
      const receipt: FormalSpecificationReceipt = { kind: 'product', handoff, paths: Object.keys(handoff.files), upstreamCommits: [] };
      return { ...next, formalSpecifications: [...(next.formalSpecifications ?? []), receipt] };
    },
  });
  const phases = createProductManagerPhases(agents, config.mode, bind, () => projectRepositoryRoot(config),
    /** 调用前复核授权并从 Run 快照装配。 */
    async resources => resolveProductAgents(config, resources, storage), () => projectSpec(config, 'product'),
    config.legacyProductWorkflow ? 'legacy' : config.nestedProductWorkflow ? 'nested' : config.nativeThreeStageProductWorkflow ? 'native' : 'flat', config, storage);
  const team = createWorkflow({ id: 'product-team', description: productSteps.map(step => step.title).join(' → '), inputSchema: deliverySchema, outputSchema: deliverySchema });
  if (phases.graph === 'flat') return team.then(phases.align).then(phases.writing).then(phases.qualityReview).then(bind(review)).commit();
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
