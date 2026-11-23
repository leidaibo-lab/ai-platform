import { applyTeamModelSettings } from './team-settings.js';
import { existsSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import type { EngineeringProject } from '../business-engineering/project.js';
import type { RemoteSyncTarget } from '../delivery/remote-sync-settings.js';
import type { NacosResourceConfig } from './nacos-resources.js';
import { defaultMethodBindings } from './team-methods.js';
import { methodBindingsSchema } from './team-method-contracts.js';

/** 独立实践配置；数据库使用绝对路径，fixture 模式不会访问模型服务。 */
export interface PracticeConfig {
  rootDir: string;
  mode: 'fixture' | 'live';
  databaseUrl: string;
  port: number;
  modelId: `openai/${string}`;
  /** 角色组覆盖；未提供或显式留空时回退默认模型，由装配层只读消费。 */
  roleModels?: Partial<Record<'product' | 'development' | 'testing', `openai/${string}`>>;
  /** 在后端桌面会话显示独立的浏览器 QA 窗口。 */
  browserQaHeaded?: boolean;
  /** 显式启用仅写入本地 Store 的最小化 Trace。 */
  localTrace?: boolean;
  /** 使用收敛前的研发执行图恢复历史 Run。 */
  legacyDevelopmentWorkflow?: true;
  /** 新研发 Run 的技术接续预算。 */
  developmentContinuationLimit?: number;
  /** 平台集成专用凭据，配置后启用依赖修复通知。 */
  platformRepairToken?: string;
  /** 使用历史四段产品图恢复已有暂停点。 */
  legacyProductWorkflow?: true;
  /** 使用此前嵌套的三阶段产品图恢复已有 Run。 */
  nestedProductWorkflow?: true;
  /** 使用上一个版本的原生三阶段图恢复已有 Run。 */
  nativeThreeStageProductWorkflow?: true;
  /** 可选外部资料服务密钥，仅由服务端使用。 */
  externalResearchKey?: string;
  apiKey?: string;
  baseUrl?: string;
  /** Studio 显式绑定的业务仓库；旧 CLI/评测未设置时保持原材料边界。 */
  hrmRepositoryRoot?: string;
  /** 服务端登记的固定版本业务工程。 */
  engineeringProject?: EngineeringProject;
  /** 服务端项目注册表；多个项目共用 Mastra Store，运行期按 Run 冻结绑定隔离。 */
  engineeringProjects?: EngineeringProject[];
  /** 仅由服务端注册表选择器标记，阶段设置按项目隔离；历史单项目保持旧路径。 */
  projectRegistrySelection?: true;
  /** 仅服务端环境登记的远端目标，页面只能引用其ID。 */
  remoteSyncTargets?: RemoteSyncTarget[];
  /** 仅服务端持有的 Nacos 配置与凭据；关闭时不访问网络。 */
  nacosResources?: NacosResourceConfig;
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
  const externalResearchKey = process.env.TAVILY_API_KEY?.trim() || undefined;
  const baseUrl = process.env.MASTRA_BASE_URL || undefined;
  if (baseUrl) z.url().parse(baseUrl);
  const nacosResources = readNacosConfig(process.env);
  const browserQaHeaded = z.enum(['true', 'false']).default('false').parse(process.env.MASTRA_BROWSER_QA_HEADED) === 'true';
  const localTrace = readLocalTraceConfig(process.env);
  if (process.env.MASTRA_LEGACY_DEPLOYMENT === 'true') throw new Error('旧部署流程已退役，请移除 MASTRA_LEGACY_DEPLOYMENT');
  const legacyDevelopmentWorkflow = z.enum(['true', 'false']).default('false').parse(process.env.MASTRA_LEGACY_DEVELOPMENT_WORKFLOW) === 'true';
  const developmentContinuationLimit = z.coerce.number().int().min(0).max(72).default(4).parse(process.env.MASTRA_DEVELOPMENT_CONTINUATION_LIMIT);
  const platformRepairToken = process.env.MASTRA_PLATFORM_REPAIR_TOKEN || undefined;
  if (platformRepairToken && !/^[A-Za-z0-9_-]{32,256}$/.test(platformRepairToken)) throw new Error('平台修复通知凭据格式无效');
  const legacyProductWorkflow = z.enum(['true', 'false']).default('false').parse(process.env.MASTRA_LEGACY_PRODUCT_WORKFLOW) === 'true';
  const nestedProductWorkflow = z.enum(['true', 'false']).default('false').parse(process.env.MASTRA_NESTED_PRODUCT_WORKFLOW) === 'true';
  const nativeThreeStageProductWorkflow = z.enum(['true', 'false']).default('false').parse(process.env.MASTRA_NATIVE_THREE_STAGE_PRODUCT_WORKFLOW) === 'true';
  if ([legacyProductWorkflow, nestedProductWorkflow, nativeThreeStageProductWorkflow].filter(Boolean).length > 1) throw new Error('只能选择一种历史产品流程图');
  return applyTeamModelSettings({ rootDir: root, mode, port, browserQaHeaded, localTrace, developmentContinuationLimit, platformRepairToken, ...(legacyDevelopmentWorkflow ? { legacyDevelopmentWorkflow: true } : {}), ...(nativeThreeStageProductWorkflow ? { nativeThreeStageProductWorkflow: true } : {}), ...(nestedProductWorkflow ? { nestedProductWorkflow: true } : {}), ...(legacyProductWorkflow ? { legacyProductWorkflow: true } : {}), modelId, roleModels, apiKey, baseUrl, externalResearchKey, nacosResources, databaseUrl: `file:${resolve(dataDir, 'mastra.db')}` });
}

/** 本地 Trace 默认开启；非法配置失败关闭。 */
export function readLocalTraceConfig(env: Record<string, string | undefined>): boolean {
  return z.enum(['true', 'false']).default('true').parse(env.MASTRA_LOCAL_TRACE) === 'true';
}

/** 默认启用注册中心；只有明确关闭才允许本地兼容路径。 */
export function readNacosConfig(env: Record<string, string | undefined>): NacosResourceConfig | undefined {
  const enabled = z.enum(['true', 'false']).default('true').parse(env.NACOS_RESOURCES_ENABLED);
  if (enabled === 'false') return undefined;
  const required = z.string().trim().min(1);
  const parsed = z.object({ url: z.url(), namespace: required, username: required, password: required, promptName: required, promptVersion: required, skillName: required, skillVersion: required }).safeParse({ url: env.NACOS_URL, namespace: env.NACOS_NAMESPACE, username: env.NACOS_USERNAME, password: env.NACOS_PASSWORD, promptName: env.NACOS_PROMPT_NAME, promptVersion: env.NACOS_PROMPT_VERSION, skillName: env.NACOS_SKILL_NAME, skillVersion: env.NACOS_SKILL_VERSION });
  if (!parsed.success) throw new Error('Nacos 默认启用，请在服务端配置地址、命名空间、凭据及 Prompt/Skill 的名称和版本。');
  const reviewerName = env.NACOS_REVIEW_PROMPT_NAME?.trim(); const reviewerVersion = env.NACOS_REVIEW_PROMPT_VERSION?.trim();
  if (!!reviewerName !== !!reviewerVersion) throw new Error('Nacos 审查角色 Prompt 名称和版本必须同时配置。');
  let additionalSkills: NacosResourceConfig['additionalSkills'];
  if (env.NACOS_ADDITIONAL_SKILLS) {
    try { additionalSkills = z.array(z.object({ name: required, version: required }).strict()).max(127).parse(JSON.parse(env.NACOS_ADDITIONAL_SKILLS)); }
    catch { throw new Error('Nacos 额外 Skill 配置必须为名称和版本数组。'); }
  }
  const names = [parsed.data.skillName, ...(additionalSkills ?? []).map(/** 禁止重复注册 Skill。 */skill => skill.name)];
  if (new Set(names).size !== names.length) throw new Error('Nacos Skill 名称不能重复。');
  let reviewerSkills: string[] | undefined;
  if (env.NACOS_REVIEW_SKILLS) {
    try { reviewerSkills = z.array(required).max(128).parse(JSON.parse(env.NACOS_REVIEW_SKILLS)); }
    catch { throw new Error('Nacos 审查角色 Skill 绑定必须为名称数组。'); }
    if (new Set(reviewerSkills).size !== reviewerSkills.length || reviewerSkills.some(/** 只能绑定已配置的资源。 */name => !names.includes(name))) throw new Error('Nacos 审查角色 Skill 绑定无效。');
  }
  let methods: NacosResourceConfig['methods'];
  if (env.NACOS_TEAM_METHODS) {
    try { methods = methodBindingsSchema.parse(JSON.parse(env.NACOS_TEAM_METHODS)); }
    catch { throw new Error('Nacos 全团队方法绑定格式无效'); }
  } else if (env.NACOS_TEAM_METHOD_VERSION?.trim()) methods = defaultMethodBindings(env.NACOS_TEAM_METHOD_VERSION.trim());
  return { ...parsed.data, ...(methods ? { methods } : {}), ...(reviewerName && reviewerVersion ? { reviewerPrompt: { name: reviewerName, version: reviewerVersion } } : {}), ...(additionalSkills ? { additionalSkills } : {}), ...(reviewerSkills ? { reviewerSkills } : {}) };
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
export function resolveModelId(config: Pick<PracticeConfig, 'modelId' | 'roleModels'>, role?: 'product' | 'development' | 'testing'): PracticeConfig['modelId'] {
  return (role ? config.roleModels?.[role] : undefined) ?? config.modelId;
}
