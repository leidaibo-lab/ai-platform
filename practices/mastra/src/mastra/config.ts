import { existsSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';

/** 独立实践配置；数据库使用绝对路径，fixture 模式不会访问模型服务。 */
export interface PracticeConfig {
  rootDir: string;
  mode: 'fixture' | 'live';
  databaseUrl: string;
  port: number;
  modelId: `openai/${string}`;
  apiKey?: string;
  baseUrl?: string;
}

/** 从实践根目录加载独立配置；不查找上级 .env，不输出凭据。 */
export function readConfig(): PracticeConfig {
  const root = resolve(fileURLToPath(new URL('../..', import.meta.url)));
  const envPath = resolve(root, '.env');
  if (existsSync(envPath)) process.loadEnvFile(envPath);
  const mode = z.enum(['fixture', 'live']).parse(process.env.MASTRA_MODE ?? 'fixture');
  const modelId = z.string().regex(/^openai\/.+/).parse(process.env.MASTRA_MODEL ?? 'openai/gpt-4o-mini') as `openai/${string}`;
  const port = z.coerce.number().int().min(1024).max(65535).parse(process.env.MASTRA_PORT ?? 4111);
  const dataDir = resolve(root, process.env.MASTRA_DATA_DIR ?? '.data');
  mkdirSync(dataDir, { recursive: true });
  const apiKey = process.env.OPENAI_API_KEY;
  if (mode === 'live' && !apiKey) throw new Error('真实模型尚未配置：请在本实践 .env 设置 OPENAI_API_KEY。');
  const baseUrl = process.env.MASTRA_BASE_URL || undefined;
  if (baseUrl) z.url().parse(baseUrl);
  return { rootDir: root, mode, port, modelId, apiKey, baseUrl, databaseUrl: `file:${resolve(dataDir, 'mastra.db')}` };
}
