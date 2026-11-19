import { engineeringProjectSchema, projectTarget } from '../business-engineering/project.js';
import { Mastra } from '@mastra/core';
import { createStudioApplicationOptions } from './app.js';
import { readConfig } from './config.js';
import { registerProjectWorkspaceViews } from './project-workspaces.js';
import { mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { z } from 'zod';
import { remoteSyncTargetSchema } from '../delivery/remote-sync-settings.js';

// CLI/Studio 的原生注册入口；不接入探索主线 Runtime 或数据库。
const config = readConfig();
// Studio 的业务资产归用户指定的 hrm；不改变旧 CLI 和评测的默认材料。
if (process.env.MASTRA_ENGINEERING_PROJECT) {
  const project = engineeringProjectSchema.parse(JSON.parse(process.env.MASTRA_ENGINEERING_PROJECT));
  config.engineeringProject = { ...project, root: resolve(config.rootDir, project.root) };
  const directory = resolve(dirname(fileURLToPath(config.databaseUrl)), 'projects', config.engineeringProject.id);
  mkdirSync(directory, { recursive: true });
  config.databaseUrl = `file:${resolve(directory, 'mastra.db')}`;
} else {
  config.hrmRepositoryRoot = resolve(process.env.MASTRA_HRM_REPOSITORY ?? resolve(config.rootDir, '../hrm'));
}
/** 额外仓库只能由本机服务端环境登记，页面设置不得带入路径或Git地址。 */
const configuredTargets = process.env.MASTRA_REMOTE_SYNC_TARGETS ? JSON.parse(process.env.MASTRA_REMOTE_SYNC_TARGETS) : [];
config.remoteSyncTargets = [projectTarget(config)!, ...z.array(remoteSyncTargetSchema).parse(configuredTargets)];
export const mastra = new Mastra(createStudioApplicationOptions(config));
registerProjectWorkspaceViews(mastra, config);
