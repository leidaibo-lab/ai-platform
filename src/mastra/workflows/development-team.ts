import { describeDevelopmentStep, developmentSteps } from './development-steps.js';
import { verifyProductHandoff } from '../../business-engineering/product-handoff.js';
import { cipGit } from '../../business-engineering/hrm-cip.js';
import { projectRepositoryRoot, assertProjectCorrelation, loadEngineeringProject } from '../../business-engineering/project.js';
import { createStep, createWorkflow, type Step } from '@mastra/core/workflows';
import { existsSync, lstatSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import type { createAgents } from '../agents/index.js';
import type { PracticeConfig } from '../config.js';
import { createBlockerClarificationWorkflow } from '../../intake/blocker-workflow.js';
import { blockerCycleSchema } from '../../intake/blocker-contracts.js';
import { createDevelopmentExecution } from '../../development/hrm-execution.js';
import { DevelopmentExecution } from '../../development-execution.js';
import { seedDevelopment } from '../../development-service.js';
import { developmentHash, projectSchema } from '../../development/contracts.js';
import { inputV2Schema, autonomyPolicySchema, stateV2Schema, type InputV2 } from '../../development/v2/contracts.js';
import { createExecutionScope, type ExecutionPort } from '../../development/v2/execution-scope.js';
import { generateV2, type GeneratorV2 } from '../../development/v2/agents.js';
import { createDevelopmentWorkflowV2 } from './development-v2.js';
import { deliverySchema } from './delivery.js';
import { withRepositoryAssets } from '../../delivery/repository-assets.js';
import { readHandoffFile } from '../../delivery/remote-handoff.js';
import type { MastraCompositeStore } from '@mastra/core/storage';
import { resolveProductAgents } from './product-team.js';
import { deliveryContractForRun } from '../../business-engineering/delivery-contract.js';

const scopeReviewSchema = z.object({ autonomy: autonomyPolicySchema.optional(), project: projectSchema, reviewer: z.string().trim().min(1).max(100), comment: z.string().trim().min(1).max(2000), maxReworks: z.number().int().min(0).max(3).default(1) });

/** 将每个开发 Run 的候选目录与输入绑定，步骤结束即关闭执行环境。 */
export function executionResolver(config: PracticeConfig, options: { requireExisting?: boolean } = {}) {
  const parent = resolve(dirname(fileURLToPath(config.databaseUrl)), 'development-runs');
  /** 目录名仅由宿主 Run 标识派生，恢复不覆盖现有源码或输入。 */
  return (input: InputV2): DevelopmentExecution => {
    assertProjectCorrelation(config, input.correlation);
    mkdirSync(parent, { recursive: true, mode: 0o700 });
    if (lstatSync(parent).isSymbolicLink()) throw new Error('运行根目录不能是符号链接');
    const base = resolve(parent, developmentHash(input.source.runId));
    const preparationRoot = resolve(parent, 'preparation');
    const directory = input.continuation ? resolve(base, 'revisions', developmentHash(input)) : input.project.preparationIssues?.length ? resolve(preparationRoot, developmentHash(input)) : base;
    if (input.continuation || input.project.preparationIssues?.length) {
      for (const path of [base, resolve(base, 'revisions'), preparationRoot]) if (existsSync(path) && lstatSync(path).isSymbolicLink()) throw new Error('候选版本目录不能是符号链接');
      mkdirSync(dirname(directory), { recursive: true, mode: 0o700 });
    }
    if (!existsSync(directory) && options.requireExisting) throw new Error('原候选检查点不存在，不能恢复');
    if (!existsSync(directory)) seedDevelopment(directory, input);
    else {
      if (!lstatSync(directory).isDirectory() || lstatSync(directory).isSymbolicLink()) throw new Error('运行目录必须为普通目录');
      const inputFile = resolve(directory, 'input.json');
      if (lstatSync(inputFile).isSymbolicLink()) throw new Error('运行输入不能是符号链接');
      const saved = inputV2Schema.parse(JSON.parse(readFileSync(inputFile, 'utf8')));
      if (developmentHash(saved) !== developmentHash(input)) throw new Error('运行项目输入与保存版本不一致');
    }
    return createDevelopmentExecution(resolve(directory, 'candidate'), input.project, projectRepositoryRoot(config));
  };
}

/** 研发团队的唯一边界：负责人规划、动态实施、确定性门禁、独立审查、阻塞澄清和研发交付均在此子 Workflow 内完成。 */
export function createDevelopmentTeamWorkflow(agents: ReturnType<typeof createAgents>, config: PracticeConfig, generate: GeneratorV2 = generateV2, options: { legacyBlocked?: boolean; storage?: MastraCompositeStore } = {}) {
  const resolveExecution = executionResolver(config);
  const execution = createExecutionScope(resolveExecution, config.mode === 'live' && !!(config.engineeringProjects || projectRepositoryRoot(config)));
  const bind = <T extends Step<any, any, any, any, any, any>>(step: T): T => withRepositoryAssets(execution.bind(step), config);
  const scope = createStep({
    id: 'confirm-project-scope',
    description: describeDevelopmentStep(developmentSteps[0]),
    inputSchema: deliverySchema,
    outputSchema: inputV2Schema,
    suspendSchema: z.object({ productHash: z.string(), instruction: z.string(), projectFields: z.array(z.string()) }),
    resumeSchema: scopeReviewSchema,
    // 项目范围是研发团队的开工授权，不再作为主流程的孤立节点。
    execute: async ({ inputData, resumeData, suspend, runId }) => {
      if (inputData.mode !== config.mode) throw new Error('项目授权模式发生变化');
      const product = inputData.artifacts.find((artifact) => artifact.stage === 'product');
      if (!product || !inputData.reviews.some((review) => review.role === 'product' && review.decision === 'approve' && review.artifactHash === product.hash)) throw new Error('开发缺少当前产品批准');
      assertProjectCorrelation(config, inputData.correlation);
      if (config.mode === 'live') {
        const root = projectRepositoryRoot(config);
        const correlation = inputData.correlation;
        const formal = inputData.formalSpecifications?.find(/** 读取当前 Run 的产品回执。 */item => item.kind === 'product');
        if (!root || !correlation || !formal) throw new Error('开发缺少已发布的产品交接版本');
        const contract = correlation.deliveryContractHash ? deliveryContractForRun(config, correlation).contract : undefined;
        const paths = contract?.paths ?? { requirements: 'specs/requirements.md', productSpecification: 'specs/product-spec.md' };
        if (inputData.productHandoffFormat) verifyProductHandoff(root, correlation.runId, correlation.iterationId, formal, product.content, contract ? { requirements: paths.requirements, productSpecification: paths.productSpecification } : undefined);
        else {
          const requirementsPath = paths.requirements.replaceAll('{iterationId}', correlation.iterationId);
          const productPath = paths.productSpecification.replaceAll('{iterationId}', correlation.iterationId);
          if (!formal.paths.includes(requirementsPath) || !formal.paths.includes(productPath)) throw new Error('开发缺少已推送的需求文档或产品规格');
          const remoteProduct = readHandoffFile(root, formal.handoff, productPath);
          if (remoteProduct !== `${product.content.endsWith('\n') ? product.content : `${product.content}\n`}`) throw new Error('已推送产品规格与当前人工批准版本不一致');
        }
      }
      if (!resumeData) return suspend({ productHash: product.hash, instruction: '确认已关联仓库、当前代码版本与整体权限。技术文件拆分和实际团队由研发团队提出，方案批准后才实施。', projectFields: ['id', 'files', 'writablePaths', 'checkFiles', 'roles'] });
      if (config.engineeringProject && developmentHash(resumeData.project) !== developmentHash(loadEngineeringProject(config.engineeringProject).candidate)) throw new Error('已确认项目与登记的候选或保护检查不一致');
      if (config.mode === 'live' && resumeData.project.engineeringRevision) {
        const formal = inputData.formalSpecifications!.find(item => item.kind === 'product')!;
        const revision = resumeData.project.engineeringRevision;
        if (cipGit(projectRepositoryRoot(config)!, ['merge-base', revision, formal.handoff.commit]).trim() !== revision) throw new Error('开发范围必须使用产品规格分支的工程基线');
      }
      return inputV2Schema.parse({ teamMethods: inputData.nacosResources?.methods, ...(inputData.architectureDocumentFormat ? { architectureDocumentFormat: inputData.architectureDocumentFormat } : {}), productHandoffFormat: inputData.productHandoffFormat, ...(inputData.requirementTracking ? { requirementTracking: inputData.requirementTracking } : {}), repositoryHandoff: inputData.repositoryHandoff, formalSpecifications: inputData.formalSpecifications, correlation: inputData.correlation, source: { kind: 'approved-product', workflowId: 'product-development', runId, hash: product.hash, content: product.content, evidence: product.evidence }, project: resumeData.project, maxReworks: resumeData.maxReworks, autonomy: resumeData.autonomy, scopeApproval: { reviewer: resumeData.reviewer, comment: resumeData.comment, productHash: product.hash } });
    },
  });
  const development = createDevelopmentWorkflowV2(config, execution.port, false, generate, { id: 'development-execution', team: true, bind: execution.bind });
  const openClarification = createStep({
    id: 'open-development-clarification',
    inputSchema: stateV2Schema,
    outputSchema: blockerCycleSchema,
    // 产品来源由研发团队的输入快照提供，阻塞澄清仍在研发团队边界内回流产品职责。
    execute: async ({ inputData, getInitData }) => blockerCycleSchema.parse({ development: inputData, approvedProduct: getInitData(), round: 1, history: [] }),
  });
  const clarification = createBlockerClarificationWorkflow(agents, config, resolveExecution, generate, /** 阻塞回流使用原产品 Run 的资源和存储。 */async resources => resolveProductAgents(config, resources, options.storage));
  const main = createWorkflow({ id: 'development-team', description: developmentSteps.map(step => step.title).join(' → '), inputSchema: deliverySchema, outputSchema: stateV2Schema })
    .then(withRepositoryAssets(scope, config))
    .then(development);
  const ready = options.legacyBlocked ? main : main.then(openClarification).branch([[/** 无论发现时点，业务阻塞都须回流产品澄清；澄清子流程会保留原候选与证据。 */async ({ inputData }) => inputData.development.outcome === 'clarification-required', clarification]]).map(async ({ inputData, getStepResult }) => inputData['resolve-development-blockers']?.development ?? getStepResult(openClarification).development, { id: 'continue-after-clarification' });
  return { workflow: ready.commit(), execution, executionPort: execution.port };
}

/** 研发团队对外只暴露团队 Workflow，内部执行作用域供测试、发布和最终交付复用。 */
export type DevelopmentTeam = ReturnType<typeof createDevelopmentTeamWorkflow>;
