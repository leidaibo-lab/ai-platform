import { createIntakeRoutes } from '../intake/routes.js';
import { createAssetRoutes } from '../delivery/asset-routes.js';
import { Mastra } from '@mastra/core';
import { createDevelopmentNodeWorkflows } from '../evaluation/development-nodes.js';
import { createNodeScorers } from '../evaluation/scorers.js';
import { ConsoleLogger } from '@mastra/core/logger';
import { LibSQLStore } from '@mastra/libsql';
import type { PracticeConfig } from './config.js';
import { createAgents } from './agents/index.js';
import { createProductDeliveryV2 } from './workflows/product-delivery-v2.js';
import { createDeliveryWorkflow } from './workflows/delivery.js';
import { createRevisionWorkflow } from './workflows/revision.js';
import { createReviewRoutes } from '../review-routes.js';
import { createRecruitmentWorkspace, exportProductArtifacts, registerProjectWorkspaceViews } from './project-workspaces.js';
import { validateHrmRepository } from '../delivery/repository-assets.js';
import { join } from 'node:path';
import { createProductDevelopmentWorkflow } from './workflows/product-development.js';

/** Studio公开完整产研业务流程及具名独立评测Workflow；旧CLI保留用于历史读取。 */
export function createStudioApplicationOptions(config: PracticeConfig) {
  const repository = config.hrmRepositoryRoot ? validateHrmRepository(config.hrmRepositoryRoot) : undefined;
  const agents = createAgents(config, repository ? { workspace: createRecruitmentWorkspace(config.rootDir, join(repository, 'product/sources')) } : {});
  const productDevelopmentWorkflow = createProductDevelopmentWorkflow(agents, config);
  return {
    agents: { productCoordinatorAgent: agents.productCoordinatorAgent, productClarificationAgent: agents.productClarificationAgent, productClosureAgent: agents.productClosureAgent, productAgent: agents.productAgent, testingAgent: agents.testingAgent, operationsAgent: agents.operationsAgent },
    scorers: createNodeScorers(config),
    workflows: { productDevelopmentWorkflow, ...createDevelopmentNodeWorkflows(config) },
    storage: new LibSQLStore({ id: 'native-practice-storage', url: config.databaseUrl }),
    logger: new ConsoleLogger({ name: 'mastra-native-practice', level: 'info' }),
    server: { host: '127.0.0.1', port: config.port, apiRoutes: [...createAssetRoutes(config), ...createIntakeRoutes(productDevelopmentWorkflow, config.mode)] },
  };
}

/**
 * 装配独立 Mastra 应用；工厂允许测试替换数据库，状态仍归原生 Store 所有。
 * ADR: docs/decisions/2026-11-02-exploration-and-native-practices.md
 */
export function createApplicationOptions(config: PracticeConfig) {
  const storage = new LibSQLStore({ id: 'native-practice-storage', url: config.databaseUrl });
  const agents = createAgents(config);
  const deliveryWorkflow = createDeliveryWorkflow(agents, config.mode,
    // 仅导出草稿副本，审批权与恢复点继续归原生 Workflow。
    (runId, state) => exportProductArtifacts(config, runId, state),
  );
  const productDeliveryV2 = createProductDeliveryV2(agents, config.mode);
  const revisionWorkflow = createRevisionWorkflow(agents, config.mode);
  return {
    agents, workflows: { deliveryWorkflow, productDeliveryV2, revisionWorkflow }, storage,
    // 复用框架原生日志，向服务进程输出 info/warn/error，便于定位执行失败。
    logger: new ConsoleLogger({ name: 'mastra-native-practice', level: 'info' }),
    server: { host: '127.0.0.1', port: config.port, apiRoutes: createReviewRoutes({ deliveryWorkflow, revisionWorkflow, config }) },
  };
}

/** 为脚本与测试装配同一原生注册配置，不产生额外框架实例。 */
export function createApplication(config: PracticeConfig) {
  const options = createApplicationOptions(config);
  const mastra = new Mastra(options);
  registerProjectWorkspaceViews(mastra, config);
  return { mastra, storage: options.storage, agents: options.agents, deliveryWorkflow: options.workflows.deliveryWorkflow, productDeliveryV2: options.workflows.productDeliveryV2, revisionWorkflow: options.workflows.revisionWorkflow, config };
}
export type PracticeApplication = ReturnType<typeof createApplication>;
