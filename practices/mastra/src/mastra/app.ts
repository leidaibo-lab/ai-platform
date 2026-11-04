import { Mastra } from '@mastra/core';
import { LibSQLStore } from '@mastra/libsql';
import type { PracticeConfig } from './config.js';
import { createAgents } from './agents/index.js';
import { createDeliveryWorkflow } from './workflows/delivery.js';
import { createRevisionWorkflow } from './workflows/revision.js';
import { createReviewRoutes } from '../review-routes.js';

/**
 * 装配独立 Mastra 应用；工厂允许测试替换数据库，状态仍归原生 Store 所有。
 * ADR: docs/decisions/2026-11-02-exploration-and-native-practices.md
 */
export function createApplicationOptions(config: PracticeConfig) {
  const storage = new LibSQLStore({ id: 'native-practice-storage', url: config.databaseUrl });
  const agents = createAgents(config);
  const deliveryWorkflow = createDeliveryWorkflow(agents, config.mode);
  const revisionWorkflow = createRevisionWorkflow(agents, config.mode);
  return {
    agents, workflows: { deliveryWorkflow, revisionWorkflow }, storage, logger: false as const,
    server: { host: '127.0.0.1', port: config.port, apiRoutes: createReviewRoutes({ deliveryWorkflow, revisionWorkflow, config }) },
  };
}

/** 为脚本与测试装配同一原生注册配置，不产生额外框架实例。 */
export function createApplication(config: PracticeConfig) {
  const options = createApplicationOptions(config);
  const mastra = new Mastra(options);
  return { mastra, storage: options.storage, agents: options.agents, deliveryWorkflow: options.workflows.deliveryWorkflow, revisionWorkflow: options.workflows.revisionWorkflow, config };
}
export type PracticeApplication = ReturnType<typeof createApplication>;
