import { Mastra } from '@mastra/core';
import { createApplicationOptions } from './app.js';
import { readConfig } from './config.js';

// CLI/Studio 的原生注册入口；不接入探索主线 Runtime 或数据库。
export const mastra = new Mastra(createApplicationOptions(readConfig()));
