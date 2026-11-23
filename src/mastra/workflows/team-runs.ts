import { createTeamRunPolicy } from '../../team/run-policy.js';
/** 独立团队复用正式团队 Workflow，各自保存输入来源并在团队边界结束。 */
import { createStep, createWorkflow } from '@mastra/core/workflows';
import type { Mastra } from '@mastra/core';
import { z } from 'zod';
import type { MastraCompositeStore } from '@mastra/core/storage';
import { createAgents } from '../agents/index.js';
import type { PracticeConfig } from '../config.js';
import { assertProjectCorrelation, bindProjectWorkflow, createProjectCorrelation, projectRepositoryRoot, scopedProjectConfig, selectProjectConfig } from '../../business-engineering/project.js';
import { teamIds, teamRunBindingSchema, teamRunInputSchema, teamWorkflowIds, teamWorkflowKeys, resolveTeamSource, rehomeSpecifications, copyTeamCandidate, type TeamRunInput } from '../../team/runs.js';
import { deliverySchema } from './delivery.js';
import { createProductTeamWorkflow } from './product-team.js';
import { createDevelopmentTeamWorkflow, executionResolver } from './development-team.js';
import { createExecutionScope } from '../../development/v2/execution-scope.js';
import { createTestingWorkflow } from '../../delivery/testing.js';
import { createMergeRequestDelivery } from '../../delivery/merge-request.js';
import { emptyQuality, lifecycleSchema } from '../../delivery/contracts.js';
import { stateV2Schema } from '../../development/v2/contracts.js';
import { loadNacosSnapshot } from '../nacos-resources.js';
import { assertCompleteMethods } from '../team-methods.js';
import { architectureDocumentFormat } from '../../development/v2/architecture-document.js';
import { readAuthorizedProductSources } from '../stage-workspace.js';
import { resolveInputPackage } from '../../team/input-packages.js';
import { developmentHash } from '../../development/contracts.js';
import type { GeneratorV2 } from '../../development/v2/agents.js';

/** 登记包由 Store 重读；请求只能重复规范正文，不能替换包内资料。 */
async function validatePackageInput(mastra: Mastra, config: PracticeConfig, input: TeamRunInput) {
  if (!input.inputPackage) return;
  const saved = await resolveInputPackage(mastra, config, input.inputPackage);
  const { inputPackage, ...material } = input;
  if (developmentHash(saved) !== developmentHash(material)) throw new Error('团队输入与确认输入包不一致');
}

const initializedSchema = deliverySchema.extend({
  teamRun: teamRunBindingSchema,
  trusted: z.union([deliverySchema, stateV2Schema, lifecycleSchema]).optional(),
});

/** 每个入口的项目绑定和来源校验均覆盖原生 start、resume、restart 与 timeTravel。 */
export function createIndependentTeamWorkflows(agents: ReturnType<typeof createAgents>, registryConfig: PracticeConfig, storage: MastraCompositeStore, generate?: GeneratorV2) {
  const workflows = {} as Record<typeof teamWorkflowKeys[keyof typeof teamWorkflowKeys], ReturnType<Mastra['getWorkflow']>>;
  for (const team of teamIds) {
    const config = scopedProjectConfig(registryConfig);
    const initialize = createStep({
      id: 'initialize-team-run', inputSchema: teamRunInputSchema, outputSchema: initializedSchema,
      /** 只消费规范引用，来源内容、候选与审批由服务端读取。 */
      execute: async ({ inputData, runId, mastra }) => {
        if (inputData.team !== team || !mastra) throw new Error('独立团队入口与请求不一致');
        await validatePackageInput(mastra, config, inputData);
        const correlation = { ...createProjectCorrelation(config, inputData, runId), workflowId: teamWorkflowKeys[team] };
        assertProjectCorrelation(config, correlation);
        if (inputData.team === 'product') {
          if (config.mode === 'live' && config.nacosResources && !config.nacosResources.methods) throw new Error('新 live Run 必须配置完整 Nacos 团队方法目录');
          const nacosResources = config.nacosResources ? await loadNacosSnapshot(config.nacosResources) : undefined;
          if (nacosResources?.methods) assertCompleteMethods(nacosResources.methods);
          return initializedSchema.parse({
            correlation, brief: inputData.brief, mode: config.mode, teamRunPolicy: createTeamRunPolicy(),
            nacosResources, productSources: !config.engineeringProject ? readAuthorizedProductSources(projectRepositoryRoot(config)) : {},
            ...(config.mode === 'live' ? { architectureDocumentFormat, requirementTracking: true, productHandoffFormat: 'paired-markdown.v1' } : {}),
            productFlow: 'four-step', intakeMode: inputData.intakeMode,
            intake: { intakeMode: inputData.intakeMode, enabled: inputData.intakeMode === 'clarify', ready: inputData.intakeMode === 'autofill', round: 0, history: [] },
            artifacts: [], reviews: [], formalSpecifications: [], outcome: 'in-progress',
            teamRun: { version: 'team-run-binding.v1', input: inputData },
          });
        }
        if (inputData.team === 'development' && 'evaluation' in inputData) {
          if (config.mode === 'live' && config.nacosResources && !config.nacosResources.methods) throw new Error('新 live Run 必须配置完整 Nacos 团队方法目录');
          const nacosResources = config.nacosResources ? await loadNacosSnapshot(config.nacosResources) : undefined;
          if (nacosResources?.methods) assertCompleteMethods(nacosResources.methods);
          const trusted = deliverySchema.parse({ correlation, brief: inputData.evaluation.requirement, mode: config.mode, evaluationRequirement: inputData.evaluation, teamRunPolicy: createTeamRunPolicy(), nacosResources, artifacts: [], reviews: [], formalSpecifications: [], outcome: 'in-progress' });
          return initializedSchema.parse({ ...trusted, teamRun: { version: 'team-run-binding.v1', input: inputData, sourceHash: developmentHash(inputData.evaluation.requirement) }, trusted });
        }
        const source = await resolveTeamSource(mastra, config, team as Exclude<TeamRunInput['team'], 'product'>, inputData.source, inputData.source.hash);
        const binding = { version: 'team-run-binding.v1', input: inputData, sourceHash: source.hash };
        if (source.product) {
          const product = source.product;
          const receipts = await rehomeSpecifications(config, product.formalSpecifications ?? [], runId, inputData.iterationId, correlation.engineeringRevision);
          const trusted = deliverySchema.parse({ ...product, correlation, formalSpecifications: receipts });
          return initializedSchema.parse({ ...trusted, teamRun: binding, trusted });
        }
        const state = source.development!;
        const receipts = await rehomeSpecifications(config, [...(state.input.formalSpecifications ?? []), ...(state.formalSpecification ? [state.formalSpecification] : []), ...(source.lifecycle?.formalSpecifications ?? [])], runId, inputData.iterationId, correlation.engineeringRevision);
        const input = { ...state.input, correlation, repositoryHandoff: undefined, source: { ...state.input.source, runId }, formalSpecifications: receipts.filter(receipt => receipt.kind === 'product') };
        await copyTeamCandidate(config, state, input);
        const development = stateV2Schema.parse({
          ...state, input, repositoryHandoff: undefined,
          formalSpecification: receipts.find(receipt => receipt.kind === 'development'),
          upstreamAuthorization: state.upstreamAuthorization ?? { sourceRunId: inputData.source.runId, input: state.input },
        });
        const trusted = lifecycleSchema.parse({
          ...(source.lifecycle ?? {}),
          version: 'delivery-lifecycle.v1', brief: source.lifecycle?.brief ?? state.input.source.content,
          development, formalSpecifications: receipts,
          quality: source.lifecycle?.quality ?? emptyQuality(),
          qualityHistory: source.lifecycle?.qualityHistory ?? [], developmentHistory: source.lifecycle?.developmentHistory ?? [],
          release: source.lifecycle?.release ?? { plan: null, qualityHash: null, approval: null, hash: null, receipt: null, health: null, rollback: null, authority: 'local-human-report' },
          releaseHistory: [], outcome: 'in-progress', limitations: source.lifecycle?.limitations ?? [],
        });
        return initializedSchema.parse({
          correlation, brief: trusted.brief, mode: config.mode, artifacts: [], reviews: [], outcome: 'in-progress',
          teamRun: binding, trusted,
        });
      },
    });
    const workflow = createWorkflow({
      id: teamWorkflowIds[team], description: `独立${{ product: '产品', development: '研发', testing: '测试', delivery: '交付' }[team]}团队`,
      inputSchema: teamRunInputSchema, outputSchema: z.union([deliverySchema, stateV2Schema, lifecycleSchema]),
    }).then(initialize);
    let complete;
    if (team === 'product') {
      const input = createStep({ id: 'select-product-input', inputSchema: initializedSchema, outputSchema: deliverySchema,
        /** 产品入口保留完整澄清、审查和人工批准。 */
        execute: async ({ inputData }) => deliverySchema.parse(inputData),
      });
      complete = workflow.then(input).then(createProductTeamWorkflow(agents, config, storage)).commit();
    } else if (team === 'development') {
      const input = createStep({ id: 'select-approved-product', inputSchema: initializedSchema, outputSchema: deliverySchema,
        /** 已完成来源读取后才向研发交接批准产品。 */
        execute: async ({ inputData }) => deliverySchema.parse(inputData.trusted),
      });
      complete = workflow.then(input).then(createDevelopmentTeamWorkflow(agents, config, generate, { storage }).workflow).commit();
    } else {
      const input = createStep({ id: 'select-team-candidate', inputSchema: initializedSchema, outputSchema: lifecycleSchema,
        /** 候选已复制到本 Run，后续工具只访问本 Run 执行目录。 */
        execute: async ({ inputData }) => lifecycleSchema.parse(inputData.trusted),
      });
      const scope = createExecutionScope(executionResolver(config));
      const specialized = team === 'testing' ? createTestingWorkflow(agents, config, scope) : createMergeRequestDelivery(config, scope);
      complete = workflow.then(input).then(specialized).commit();
    }
    workflows[teamWorkflowKeys[team]] = bindProjectWorkflow(complete, registryConfig, {
      workflowId: teamWorkflowIds[team], initializeId: 'initialize-team-run',
      /** 原生恢复前重新校验来源引用，漂移不得消耗暂停点。 */
      validateSource: async (value, mastra) => {
        const saved = initializedSchema.parse(value);
        const input = saved.teamRun.input;
        await validatePackageInput(mastra, registryConfig, input);
        if (input.team === 'development' && 'evaluation' in input && saved.teamRun.sourceHash !== developmentHash(input.evaluation.requirement)) throw new Error('研发评测需求版本已变化');
        if ('source' in input) await resolveTeamSource(mastra, selectProjectConfig(registryConfig, input.projectId), input.team, input.source, saved.teamRun.sourceHash);
      },
    });
  }
  return workflows;
}
