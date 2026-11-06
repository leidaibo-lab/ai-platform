import { Mastra } from '@mastra/core';
import { createApplicationOptions } from './app.js';
import { readConfig } from './config.js';
import { registerProjectWorkspaceViews } from './project-workspaces.js';

// CLI/Studio 的原生注册入口；不接入探索主线 Runtime 或数据库。
const config = readConfig();
export const mastra = new Mastra(createApplicationOptions(config));
registerProjectWorkspaceViews(mastra, config);
