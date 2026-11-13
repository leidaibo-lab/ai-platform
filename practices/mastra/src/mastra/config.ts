import { existsSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import type { RemoteSyncTarget } from '../delivery/remote-sync-settings.js';
import type { RuntimeResourceConfig } from '../resources/resource-config.js';
import { loadRuntimeResourceConfig, validateRuntimeResourceConfig } from '../resources/resource-config.js';

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
  /** 信任根只由宿主提供；签名私钥不得传入服务。 */
  resourceTrust?: { manifestPath: string; publicKeyPath: string; routes?: Record<string, { manifestPath: string; publicKeyPath: string }>; continuations?: Record<string, { manifestPath: string; publicKeyPath: string }> };
  /** 严格解析后的唯一运行时预算/角色资源配置。 */
  runtimeResources?: RuntimeResourceConfig;
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
  const manifestPath = process.env.MASTRA_ARTIFACT_MANIFEST;
  const publicKeyPath = process.env.MASTRA_ARTIFACT_PUBLIC_KEY;
  let routes: Record<string, { manifestPath: string; publicKeyPath: string }> | undefined;
  let continuations: Record<string, { manifestPath: string; publicKeyPath: string }> | undefined;
  try { routes = process.env.MASTRA_ARTIFACT_ROUTES ? z.record(z.string(), z.object({ manifestPath: z.string().min(1), publicKeyPath: z.string().min(1) }).strict()).parse(JSON.parse(process.env.MASTRA_ARTIFACT_ROUTES)) : undefined; } catch { throw new Error('制品版本路由配置不正确'); }
  try { continuations = process.env.MASTRA_ARTIFACT_CONTINUATIONS ? z.record(z.string().regex(/^[a-f0-9]{64}$/), z.object({ manifestPath: z.string().min(1), publicKeyPath: z.string().min(1) }).strict()).parse(JSON.parse(process.env.MASTRA_ARTIFACT_CONTINUATIONS)) : undefined; } catch { throw new Error('制品续接配置不正确'); }
  if (!!manifestPath !== !!publicKeyPath) throw new Error('制品清单与可信公钥必须同时配置');
  if (mode === 'live' && (!manifestPath || !publicKeyPath)) throw new Error('live 模式必须配置制品清单与独立可信公钥');
  const runtimeResources = validateRuntimeResourceConfig(loadRuntimeResourceConfig(root, process.env.MASTRA_RUNTIME_CONFIG ? resolve(process.env.MASTRA_RUNTIME_CONFIG) : undefined));
  return { rootDir: root, mode, port, modelId, roleModels, apiKey, baseUrl, databaseUrl: `file:${resolve(dataDir, 'mastra.db')}`, runtimeResources, ...(manifestPath && publicKeyPath ? { resourceTrust: { manifestPath: resolve(manifestPath), publicKeyPath: resolve(publicKeyPath), ...(routes ? { routes } : {}), ...(continuations ? { continuations } : {}) } } : {}) };
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
