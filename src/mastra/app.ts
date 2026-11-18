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

/** Studio 装配原生 Store、团队 Workflow 与项目资源，公开当前完整产研业务流程。
 * ADR: docs/decisions/2026-11-18-platform-team-harness.md
 */
export function createStudioApplicationOptions(config: PracticeConfig) {
  const repository = config.hrmRepositoryRoot ? validateHrmRepository(config.hrmRepositoryRoot) : undefined;
  const agents = createAgents(config, repository ? { workspace: createRecruitmentWorkspace(config.rootDir, join(repository, 'product/sources')) } : {});
  const storage = new LibSQLStore({ id: 'native-practice-storage', url: config.databaseUrl });
  const productDevelopmentWorkflow = createProductDevelopmentWorkflow(agents, config, undefined, { storage });
  return {
    agents: { productManagerAgent: agents.productManagerAgent, productReviewerAgent: agents.productReviewerAgent, testingAgent: agents.testingAgent, operationsAgent: agents.operationsAgent },
    scorers: createNodeScorers(config),
    workflows: { productDevelopmentWorkflow, ...createDevelopmentNodeWorkflows(config) },
    storage,
    logger: new ConsoleLogger({ name: 'mastra-native-practice', level: 'info' }),
    server: { host: '127.0.0.1', port: config.port, apiRoutes: [...createAssetRoutes(config), ...createIntakeRoutes(productDevelopmentWorkflow, config.mode, repository, config)] },
  };
}
