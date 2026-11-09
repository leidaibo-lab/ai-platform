/** 仓库字典与阶段策略：管理页登记本机校验后的目标，阶段页只引用稳定ID。 */
import { existsSync, lstatSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { PracticeConfig } from '../mastra/config.js';
import { validateRepository } from './asset-files.js';

export const syncPhaseSchema = z.enum(['product', 'architecture', 'development', 'testing', 'release']);
export type SyncPhase = z.infer<typeof syncPhaseSchema>;
export const remoteSyncTargetSchema = z.object({ id: z.string().regex(/^[a-z][a-z0-9-]{0,39}$/), label: z.string().trim().min(1).max(80), root: z.string().min(1), origin: z.string().url().refine(/** 拒绝携带用户名或密码的远端地址。 */value => { const url = new URL(value); return url.protocol === 'https:' && !url.username && !url.password; }, '远端地址必须为不含凭据的 HTTPS URL') }).strict();
export type RemoteSyncTarget = z.infer<typeof remoteSyncTargetSchema>;
export const targetDictionarySchema = z.object({ version: z.literal('remote-sync-targets.v1'), targets: z.array(remoteSyncTargetSchema).min(1).max(50) }).strict();
const phaseSettingSchema = z.object({ enabled: z.boolean(), targetId: z.string().regex(/^[a-z][a-z0-9-]{0,39}$/) }).strict();
export const remoteSyncSettingsSchema = z.object({ version: z.literal('remote-sync-settings.v1'), phases: z.object({ product: phaseSettingSchema, architecture: phaseSettingSchema, development: phaseSettingSchema, testing: phaseSettingSchema, release: phaseSettingSchema }) }).strict();
export type RemoteSyncSettings = z.infer<typeof remoteSyncSettingsSchema>;

/** 当前实践的初始目标来自服务端环境；字典页首次打开前仍保持现有HRM行为。 */
function defaultTargets(config: PracticeConfig): RemoteSyncTarget[] {
  const configured = config.remoteSyncTargets?.map(/** 环境登记值先做结构校验。 */item => remoteSyncTargetSchema.parse(item)) ?? [];
  if (configured.length) return configured;
  return config.hrmRepositoryRoot ? [{ id: 'hrm', label: 'HRM 项目仓库', root: config.hrmRepositoryRoot, origin: 'https://github.com/leidaibo-lab/hrm.git' }] : [];
}

/** 仓库字典与阶段路由分开持久化，避免把项目地址放进某个Run的审批事实。 */
function targetDictionaryPath(config: PracticeConfig): string {
  const database = config.databaseUrl.replace(/^file:/, '');
  return resolve(dirname(database), 'remote-sync-targets.json');
}

/** 保证仓库ID唯一，重复ID会让阶段路由失去确定性。 */
function uniqueTargets(targets: RemoteSyncTarget[]): RemoteSyncTarget[] {
  if (new Set(targets.map(/** ID是阶段选择的稳定值。 */target => target.id)).size !== targets.length) throw new Error('仓库标识不能重复');
  return targets;
}

/** 读取独立仓库字典；不存在时使用服务端环境的初始注册表。 */
export function readRemoteSyncTargets(config: PracticeConfig): RemoteSyncTarget[] {
  const file = targetDictionaryPath(config);
  const targets = existsSync(file) ? targetDictionarySchema.parse(JSON.parse(readFileSync(file, 'utf8'))).targets : defaultTargets(config);
  return uniqueTargets(targets);
}

/** 保存完整仓库字典前校验每个本地checkout与远端，拒绝尚未准备好的项目地址。 */
export function writeRemoteSyncTargets(config: PracticeConfig, value: unknown): RemoteSyncTarget[] {
  const targets = uniqueTargets(targetDictionarySchema.parse(value).targets);
  for (const target of targets) validateRepository(target.root, target.origin);
  const active = readRemoteSyncSettings(config);
  const ids = new Set(targets.map(/** 用新字典检查现有阶段绑定。 */target => target.id));
  for (const phase of syncPhaseSchema.options) if (active.phases[phase].enabled && !ids.has(active.phases[phase].targetId)) throw new Error('仍有阶段使用该仓库；请先调整阶段同步设置');
  const file = targetDictionaryPath(config); mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  if (existsSync(file) && (lstatSync(file).isSymbolicLink() || !lstatSync(file).isFile())) throw new Error('仓库字典文件必须是普通文件');
  const temporary = `${file}.${randomUUID()}.tmp`;
  try { writeFileSync(temporary, JSON.stringify({ version: 'remote-sync-targets.v1', targets }, null, 2) + '\n', { flag: 'wx', mode: 0o600 }); renameSync(temporary, file); }
  finally { if (existsSync(temporary)) unlinkSync(temporary); }
  return targets;
}

/** 阶段执行始终从当前字典解析目标，而不是保留浏览器传入的路径。 */
export function remoteSyncTargets(config: PracticeConfig): RemoteSyncTarget[] { return readRemoteSyncTargets(config); }

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
