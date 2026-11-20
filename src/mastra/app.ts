import { loadEngineeringProject, projectRepositoryRoot } from '../business-engineering/project.js';
import { createIntakeVoiceRoute } from '../intake/voice.js';
import { createIntakeRoutes } from '../intake/routes.js';
import { createAssetRoutes } from '../delivery/asset-routes.js';
import { Mastra } from '@mastra/core';
import { createDevelopmentNodeWorkflows } from '../evaluation/development-nodes.js';
import { createNodeScorers } from '../evaluation/scorers.js';
import { ConsoleLogger } from '@mastra/core/logger';
import { LibSQLStore } from '@mastra/libsql';
import type { PracticeConfig } from './config.js';
import { createAgents } from './agents/index.js';
import { productWorkspace } from './project-workspaces.js';
import { createProductDevelopmentWorkflow } from './workflows/product-development.js';

/** Studio 装配原生 Store、团队 Workflow 与项目资源，公开当前完整产研业务流程。
 * ADR: docs/decisions/2026-11-19-three-layer-harness.md
 */
export function createStudioApplicationOptions(config: PracticeConfig) {
  const repository = projectRepositoryRoot(config);
  if (config.engineeringProject) loadEngineeringProject(config.engineeringProject);
  const agents = createAgents(config, { workspace: productWorkspace(config) });
  const storage = new LibSQLStore({ id: 'native-practice-storage', url: config.databaseUrl });
  const productDevelopmentWorkflow = createProductDevelopmentWorkflow(agents, config, undefined, { storage });
  return {
    agents: { productManagerAgent: agents.productManagerAgent, productReviewerAgent: agents.productReviewerAgent, testingAgent: agents.testingAgent, operationsAgent: agents.operationsAgent },
    scorers: createNodeScorers(config),
    workflows: { productDevelopmentWorkflow, ...createDevelopmentNodeWorkflows(config) },
    storage,
    logger: new ConsoleLogger({ name: 'mastra-native-practice', level: 'info' }),
    server: { host: '127.0.0.1', port: config.port, apiRoutes: [createIntakeVoiceRoute(config), ...createAssetRoutes(config), ...createIntakeRoutes(productDevelopmentWorkflow, config.mode, repository, config)] },
  };
}
