import { loadEngineeringProject, projectRepositoryRoot, registeredProjects } from '../business-engineering/project.js';
import { assertDeliveryContractMatchesAdapter, defaultContractForAdapter, readProjectDeliveryContract } from '../business-engineering/delivery-contract.js';
import { createIntakeVoiceRoute } from '../intake/voice.js';
import { createIntakeRoutes } from '../intake/routes.js';
import { createPlatformRecoveryRoutes } from '../intake/platform-recovery.js';
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
import { createIndependentProductWorkflow } from './workflows/independent-product.js';

/** Studio 装配原生 Store、团队 Workflow 与项目资源，公开当前完整产研业务流程。
 * ADR: docs/decisions/2026-11-19-three-layer-harness.md
 */
export function createStudioApplicationOptions(config: PracticeConfig) {
  const repository = config.engineeringProjects ? undefined : projectRepositoryRoot(config);
  for (const project of registeredProjects(config)) {
    const candidate = loadEngineeringProject(project).candidate;
    const selected = { ...config, engineeringProject: project };
    const contract = readProjectDeliveryContract(selected, undefined, defaultContractForAdapter(candidate));
    assertDeliveryContractMatchesAdapter(contract.contract, candidate);
  }
  const agents = createAgents(config, { workspace: productWorkspace(config) });
  const storage = new LibSQLStore({ id: 'native-practice-storage', url: config.databaseUrl });
  const productDevelopmentWorkflow = createProductDevelopmentWorkflow(agents, config, undefined, { storage });
  const independentProductWorkflow = createIndependentProductWorkflow(agents, config, storage);
  return {
    agents: { productManagerAgent: agents.productManagerAgent, productReviewerAgent: agents.productReviewerAgent, testingAgent: agents.testingAgent },
    scorers: createNodeScorers(config),
    workflows: { productDevelopmentWorkflow, independentProductWorkflow, ...createDevelopmentNodeWorkflows(config) },
    storage,
    logger: new ConsoleLogger({ name: 'mastra-native-practice', level: 'info' }),
    server: { host: '127.0.0.1', port: config.port, apiRoutes: [createIntakeVoiceRoute(config), ...createAssetRoutes(config), ...createIntakeRoutes(productDevelopmentWorkflow, config.mode, repository, config), ...createPlatformRecoveryRoutes(productDevelopmentWorkflow, config)] },
  };
}
