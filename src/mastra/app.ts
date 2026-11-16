import { createIntakeRoutes } from '../intake/routes.js';
import { createAssetRoutes } from '../delivery/asset-routes.js';
import { Mastra } from '@mastra/core';
import { createDevelopmentNodeWorkflows } from '../evaluation/development-nodes.js';
import { createNodeScorers } from '../evaluation/scorers.js';
import { ConsoleLogger } from '@mastra/core/logger';
import { LibSQLStore } from '@mastra/libsql';
import type { PracticeConfig } from './config.js';
import { createAgents } from './agents/index.js';
import { createRecruitmentWorkspace } from './project-workspaces.js';
import { validateHrmRepository } from '../delivery/repository-assets.js';
import { join } from 'node:path';
import { createProductDevelopmentWorkflow } from './workflows/product-development.js';

/** Studio 公开当前完整产研业务流程；产品阶段只注册团队化产品 Workflow。 */
export function createStudioApplicationOptions(config: PracticeConfig) {
  const repository = config.hrmRepositoryRoot ? validateHrmRepository(config.hrmRepositoryRoot) : undefined;
  const agents = createAgents(config, repository ? { workspace: createRecruitmentWorkspace(config.rootDir, join(repository, 'product/sources')) } : {});
  const productDevelopmentWorkflow = createProductDevelopmentWorkflow(agents, config);
  return {
    agents: { productManagerAgent: agents.productManagerAgent, productReviewerAgent: agents.productReviewerAgent, testingAgent: agents.testingAgent, operationsAgent: agents.operationsAgent },
    scorers: createNodeScorers(config),
    workflows: { productDevelopmentWorkflow, ...createDevelopmentNodeWorkflows(config) },
    storage: new LibSQLStore({ id: 'native-practice-storage', url: config.databaseUrl }),
    logger: new ConsoleLogger({ name: 'mastra-native-practice', level: 'info' }),
    server: { host: '127.0.0.1', port: config.port, apiRoutes: [...createAssetRoutes(config), ...createIntakeRoutes(productDevelopmentWorkflow, config.mode, repository, config)] },
  };
}
