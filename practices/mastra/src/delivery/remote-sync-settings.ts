/** 策略注册表：页面只能选择服务端登记的仓库，不能输入路径、远端地址或Git参数。 */
import { existsSync, lstatSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { PracticeConfig } from '../mastra/config.js';

export const syncPhaseSchema = z.enum(['product', 'architecture', 'development', 'testing', 'release']);
export type SyncPhase = z.infer<typeof syncPhaseSchema>;
export const remoteSyncTargetSchema = z.object({ id: z.string().regex(/^[a-z][a-z0-9-]{0,39}$/), label: z.string().trim().min(1).max(80), root: z.string().min(1), origin: z.string().url() }).strict();
export type RemoteSyncTarget = z.infer<typeof remoteSyncTargetSchema>;
const phaseSettingSchema = z.object({ enabled: z.boolean(), targetId: z.string().regex(/^[a-z][a-z0-9-]{0,39}$/) }).strict();
export const remoteSyncSettingsSchema = z.object({ version: z.literal('remote-sync-settings.v1'), phases: z.object({ product: phaseSettingSchema, architecture: phaseSettingSchema, development: phaseSettingSchema, testing: phaseSettingSchema, release: phaseSettingSchema }) }).strict();
export type RemoteSyncSettings = z.infer<typeof remoteSyncSettingsSchema>;

/** 当前实践的兼容默认目标；未来目标必须由服务端配置登记。 */
export function remoteSyncTargets(config: PracticeConfig): RemoteSyncTarget[] {
  const configured = config.remoteSyncTargets?.map(/** 环境登记值先做结构校验。 */item => remoteSyncTargetSchema.parse(item)) ?? [];
  if (configured.length) return configured;
  return config.hrmRepositoryRoot ? [{ id: 'hrm', label: 'HRM 项目仓库', root: config.hrmRepositoryRoot, origin: 'https://github.com/leidaibo-lab/hrm.git' }] : [];
}

/** 依据原生步骤职责分类；未知节点默认不远端同步，避免新节点意外写库。 */
export function syncPhaseForStep(stepId: string): SyncPhase | undefined {
  if (['prepare-release-plan', 'approve-release-scope', 'execute-release-externally', 'verify-release-health', 'execute-rollback-externally', 'confirm-final-delivery'].includes(stepId)) return 'release';
  if (['select-development-checkpoint', 'collect-development-for-testing', 'prepare-test-plan', 'approve-test-cases', 'execute-tests', 'review-test-results', 'route-test-defects'].includes(stepId) || /^(testing|test-|quality|assess-quality)/.test(stepId)) return 'testing';
  if (['initialize-development', 'prepare-context', 'architecture', 'assemble-agent-team', 'assess-readiness', 'resolve-readiness', 'approve-architecture'].includes(stepId)) return 'architecture';
  if (['initialize-delivery-lifecycle', 'implement', 'execute-agent-team', 'development-self-check', 'review-code', 'assess-delivery', 'resolve-findings', 'recover-development'].includes(stepId)) return 'development';
  if (['initialize', 'initialize-product-development', 'review-product', 'confirm-project-scope', 'open-development-clarification', 'continue-after-clarification', 'confirm-blocker-answers', 'write-revised-product', 'review-revised-product', 'prepare-revised-product', 'collect-replanned-product', 'publish-product', 'product-approved-for-development'].includes(stepId) || /^(guided-|draft-|analyze-blocker|confirm-blocker|write-revised|review-revised|prepare-revised|collect-replanned|product-)/.test(stepId)) return 'product';
  return undefined;
}

/** 设置文件属于本实践数据目录，独立于Workflow事实；Run审批不由它保存。 */
function settingsPath(config: PracticeConfig): string {
  const database = config.databaseUrl.replace(/^file:/, '');
  return resolve(dirname(database), 'remote-sync-settings.json');
}

/** 初始策略让现有单仓库行为保持不变；无已授权仓库时全部关闭。 */
function defaults(config: PracticeConfig): RemoteSyncSettings {
  const targetId = remoteSyncTargets(config)[0]?.id ?? 'unconfigured';
  const enabled = targetId !== 'unconfigured';
  return remoteSyncSettingsSchema.parse({ version: 'remote-sync-settings.v1', phases: Object.fromEntries(syncPhaseSchema.options.map(/** 每个阶段都显式持有开关和目标。 */phase => [phase, { enabled, targetId }])) });
}

/** 读取并交叉校验目标ID，失效设置拒绝生效而不回退到任意本地路径。 */
export function readRemoteSyncSettings(config: PracticeConfig): RemoteSyncSettings {
  const file = settingsPath(config);
  const settings = existsSync(file) ? remoteSyncSettingsSchema.parse(JSON.parse(readFileSync(file, 'utf8'))) : defaults(config);
  const ids = new Set(remoteSyncTargets(config).map(/** 只读取服务端目标ID。 */target => target.id));
  for (const phase of syncPhaseSchema.options) if (settings.phases[phase].enabled && !ids.has(settings.phases[phase].targetId)) throw new Error('远端同步设置引用了未授权仓库');
  return settings;
}

/** 原子写入经过校验的策略；页面不能创建或修改服务端登记仓库。 */
export function writeRemoteSyncSettings(config: PracticeConfig, value: unknown): RemoteSyncSettings {
  const settings = remoteSyncSettingsSchema.parse(value);
  const ids = new Set(remoteSyncTargets(config).map(/** 目标来源固定在服务端配置。 */target => target.id));
  for (const phase of syncPhaseSchema.options) if (settings.phases[phase].enabled && !ids.has(settings.phases[phase].targetId)) throw new Error('只能选择已授权仓库');
  const file = settingsPath(config); mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  if (existsSync(file) && (lstatSync(file).isSymbolicLink() || !lstatSync(file).isFile())) throw new Error('远端同步设置文件必须是普通文件');
  const temporary = `${file}.${randomUUID()}.tmp`;
  try { writeFileSync(temporary, JSON.stringify(settings, null, 2) + '\n', { flag: 'wx', mode: 0o600 }); renameSync(temporary, file); }
  finally { if (existsSync(temporary)) unlinkSync(temporary); }
  return settings;
}

/** 运行时只解析当前步骤的授权目标；禁用或未知阶段没有Git副作用。 */
export function resolveRemoteSyncTarget(config: PracticeConfig, stepId: string): RemoteSyncTarget | undefined {
  const phase = syncPhaseForStep(stepId); if (!phase) return undefined;
  const choice = readRemoteSyncSettings(config).phases[phase];
  return choice.enabled ? remoteSyncTargets(config).find(/** 目标ID已在读取时校验。 */target => target.id === choice.targetId) : undefined;
}
