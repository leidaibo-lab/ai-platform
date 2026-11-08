import { existsSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import type { RemoteSyncTarget } from '../delivery/remote-sync-settings.js';

/** 独立实践配置；数据库使用绝对路径，fixture 模式不会访问模型服务。 */
export interface PracticeConfig {
  rootDir: string;
  mode: 'fixture' | 'live';
  databaseUrl: string;
  port: number;
  modelId: `openai/${string}`;
  /** 角色组覆盖；未提供或显式留空时回退默认模型，由装配层只读消费。 */
  roleModels?: Partial<Record<'product' | 'development', `openai/${string}`>>;
  apiKey?: string;
  baseUrl?: string;
  /** Studio 显式绑定的业务仓库；旧 CLI/评测未设置时保持原材料边界。 */
  hrmRepositoryRoot?: string;
  /** 仅服务端环境登记的远端目标，页面只能引用其ID。 */
  remoteSyncTargets?: RemoteSyncTarget[];
}

/** 从实践根目录加载独立配置；不查找上级 .env，不输出凭据。 */
export function readConfig(): PracticeConfig {
  const root = resolve(fileURLToPath(new URL('../..', import.meta.url)));
  const envPath = resolve(root, '.env');
  if (existsSync(envPath)) process.loadEnvFile(envPath);
  const mode = z.enum(['fixture', 'live']).parse(process.env.MASTRA_MODE ?? 'fixture');
  const { modelId, roleModels } = readModelConfig({ ...process.env, MASTRA_MODEL: process.env.MASTRA_MODEL ?? (mode === 'fixture' ? 'openai/fixture' : undefined) });
  const port = z.coerce.number().int().min(1024).max(65535).parse(process.env.MASTRA_PORT ?? 4111);
  const dataDir = resolve(root, process.env.MASTRA_DATA_DIR ?? '.data');
  mkdirSync(dataDir, { recursive: true });
  const apiKey = process.env.OPENAI_API_KEY;
  if (mode === 'live' && !apiKey) throw new Error('真实模型尚未配置：请在本实践 .env 设置 OPENAI_API_KEY。');
  const baseUrl = process.env.MASTRA_BASE_URL || undefined;
  if (baseUrl) z.url().parse(baseUrl);
  return { rootDir: root, mode, port, modelId, roleModels, apiKey, baseUrl, databaseUrl: `file:${resolve(dataDir, 'mastra.db')}` };
}

/** 解析必填默认模型和可选角色组覆盖；缺省或空覆盖回退默认模型，非法值直接拒绝。 */
export function readModelConfig(env: Record<string, string | undefined>): Pick<PracticeConfig, 'modelId' | 'roleModels'> {
  const schema = z.string().regex(/^openai\/[^\s]+$/);
  const modelId = schema.parse(env.MASTRA_MODEL) as PracticeConfig['modelId'];
  const roleModels: NonNullable<PracticeConfig['roleModels']> = {};
  for (const [role, value] of [
    ['product', env.MASTRA_PRODUCT_MODEL ?? ''],
    ['development', env.MASTRA_DEVELOPMENT_MODEL ?? ''],
  ] as const) {
    if (value.trim()) roleModels[role] = schema.parse(value) as PracticeConfig['modelId'];
  }
  return { modelId, roleModels };
}

/** 统一解析角色实际模型；旧调用者未提供覆盖时保持默认模型语义。 */
export function resolveModelId(config: Pick<PracticeConfig, 'modelId' | 'roleModels'>, role?: 'product' | 'development'): PracticeConfig['modelId'] {
  return (role ? config.roleModels?.[role] : undefined) ?? config.modelId;
}
