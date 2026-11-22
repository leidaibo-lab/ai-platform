import { randomBytes } from 'node:crypto';
import { readFileSync, renameSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import type { PracticeConfig } from './config.js';

const modelIdSchema = z.string().regex(/^openai\/[^\s]+$/).max(200);
export const teamSettingsSchema = z.object({ version: z.literal('team-settings.v1'), developmentContinuationLimit: z.number().int().min(0).max(72), models: z.object({ default: modelIdSchema, product: modelIdSchema.nullable(), development: modelIdSchema.nullable(), testing: modelIdSchema.optional() }).strict().optional() }).strict();
type TeamSettings = z.infer<typeof teamSettingsSchema>;

/** 工作台配置只保存可调整的默认值，Workflow 状态仍由 Mastra Store 持有。 */
function settingsPath(config: PracticeConfig): string | undefined {
  return config.databaseUrl === 'file::memory:' ? undefined : `${fileURLToPath(config.databaseUrl)}.team-settings.json`;
}

/** 缺省使用环境配置；损坏配置必须报错，不能静默回退。 */
export function readTeamSettings(config: PracticeConfig): TeamSettings {
  const path = settingsPath(config);
  if (path) {
    try { return teamSettingsSchema.parse(JSON.parse(readFileSync(path, 'utf8'))); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  }
  return teamSettingsSchema.parse({ version: 'team-settings.v1', developmentContinuationLimit: config.developmentContinuationLimit ?? 4 });
}

/** 同目录原子替换配置，禁止将内存测试库误认为持久化配置。 */
export function writeTeamSettings(config: PracticeConfig, input: unknown): TeamSettings {
  const settings = teamSettingsSchema.parse(input);
  const path = settingsPath(config);
  if (!path) throw new Error('当前数据目录不支持保存团队配置');
  const temporary = `${path}.${randomBytes(8).toString('hex')}.tmp`;
  writeFileSync(temporary, JSON.stringify(settings), { flag: 'wx', mode: 0o600 });
  renameSync(temporary, path);
  return settings;
}


/** 启动时装配页面保存的模型；缺省时沿用环境变量。 */
export function applyTeamModelSettings(config: PracticeConfig): PracticeConfig {
  const models = readTeamSettings(config).models;
  if (!models) return config;
  return { ...config, modelId: models.default as PracticeConfig['modelId'], roleModels: { ...(models.product ? { product: models.product as PracticeConfig['modelId'] } : {}), ...(models.development ? { development: models.development as PracticeConfig['modelId'] } : {}), ...(models.testing ? { testing: models.testing as PracticeConfig['modelId'] } : {}) } };
}
