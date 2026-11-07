import { Mastra } from '@mastra/core';
import { createStudioApplicationOptions } from './app.js';
import { readConfig } from './config.js';
import { registerProjectWorkspaceViews } from './project-workspaces.js';
import { resolve } from 'node:path';

// CLI/Studio 的原生注册入口；不接入探索主线 Runtime 或数据库。
const config = readConfig();
// Studio 的业务资产归用户指定的 hrm；不改变旧 CLI 和评测的默认材料。
config.hrmRepositoryRoot = resolve(process.env.MASTRA_HRM_REPOSITORY ?? resolve(config.rootDir, '../../../hrm'));
export const mastra = new Mastra(createStudioApplicationOptions(config));
registerProjectWorkspaceViews(mastra, config);
