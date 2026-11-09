import { withRunArchive } from './run-archive.js';
import { z } from 'zod';
import { legacyArchitectureCachePath, readLegacyArchitectureResult, validateLegacyArchitectureResult } from './legacy-sync.js';
/** HRM 业务资产投影：Git 保存交付副本，Mastra Store 继续拥有审批和恢复事实。
 * ADR: docs/decisions/2026-11-07-hrm-repository-assets.md
 */
import { readHandoffCache, writeHandoffCache, repositoryRetrySchema, repositorySyncPauseSchema, contentHash, handoffCache, publishHandoff, type RemoteHandoff } from './remote-handoff.js';
import { blockerCycleSchema } from '../intake/blocker-contracts.js';
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ensureAssetDirectory, validateHrmRepository } from './asset-files.js';
import { validateRepository } from './asset-files.js';
import { remoteSyncTargets, resolveRemoteSyncTarget, type RemoteSyncTarget } from './remote-sync-settings.js';
export { validateHrmRepository } from './asset-files.js';
import type { Step } from '@mastra/core/workflows';
import type { PracticeConfig } from '../mastra/config.js';
import { deliverySchema } from '../mastra/workflows/delivery.js';
import { inputV2Schema, stateV2Schema } from '../development/v2/contracts.js';
import { lifecycleSchema } from './contracts.js';
import type { AssetCorrelation } from './asset-identity.js';
import { assetManifestSchema, writeImmutableFile } from './asset-catalog.js';

/** 字节散列用于导出完整性，与产品业务版本散列分开。 */
function bytesHash(value: string): string { return createHash('sha256').update(value).digest('hex'); }

/** JSON 文件统一换行，保持重导出比较稳定；不序列化配置或整个执行上下文。 */
function json(value: unknown): string { return JSON.stringify(value, null, 2) + '\n'; }

/** 显式选择各阶段字段，避免将模型密钥/原始响应或运行数据库写入仓库。 */
function projectAssets(value: unknown): { correlation?: AssetCorrelation; runId?: string; area: 'product' | 'testSet' | 'deploy'; files: Record<string, string> } | undefined {
  const product = deliverySchema.safeParse(value);
  if (product.success) {
    const state = product.data;
    const files: Record<string, string> = { 'brief.md': state.brief, 'reviews.json': json(state.reviews), 'outcome.json': json({ mode: state.mode, outcome: state.outcome }) };
    if (state.intake) files['intake.json'] = json(state.intake);
    if (state.revision) files['revision.json'] = json(state.revision);
    if (state.productRework) files['product-rework.json'] = json(state.productRework);
    for (const entry of state.productWork?.entries ?? []) files[`role-${entry.role}.md`] = entry.content;
    for (const artifact of state.artifacts) if (artifact.stage === 'product') { files['product.md'] = artifact.content; files['product-version.json'] = json({ hash: artifact.hash, evidence: artifact.evidence }); }
    return { correlation: state.correlation, area: 'product', files };
  }
  const lifecycle = lifecycleSchema.safeParse(value);
  if (lifecycle.success) {
    const state = lifecycle.data;
    const files: Record<string, string> = { 'quality.json': json(state.quality), 'quality-history.json': json(state.qualityHistory), 'source.json': json({ productHash: state.development.input.source.hash, sourceHash: state.development.checkpointHash, planHash: state.development.planHash }), 'outcome.json': json({ mode: state.development.mode, outcome: state.outcome, limitations: state.limitations }) };
    if (state.quality.plan) files['test-plan.md'] = state.quality.plan.content;
    if (state.quality.approval) files['test-cases.json'] = json(state.quality.approval.cases);
    if (state.release.plan) {
      files['release-plan.md'] = state.release.plan.content;
      files['release.json'] = json(state.release);
    }
    return { correlation: state.development.input.correlation, runId: state.development.input.source.runId, area: state.release.plan ? 'deploy' : 'testSet', files };
  }
  const development = stateV2Schema.safeParse(value);
  if (development.success) {
    const state = development.data;
    const candidate = z.object({ repositoryCandidate: z.record(z.string(), z.string()) }).safeParse(value);
    const candidateFiles: Record<string, string> = candidate.success ? { 'candidate-files.json': json({ sourceHash: state.checkpointHash, files: candidate.data.repositoryCandidate }) } : {};
    return { correlation: state.input.correlation, runId: state.input.source.runId, area: 'product', files: { ...candidateFiles, 'development.json': json({ mode: state.mode, productHash: state.input.source.hash, requirements: state.requirements, context: state.context, plan: state.plan, planHash: state.planHash, team: state.team, delegations: state.delegations, reviews: state.reviews, readiness: state.readiness, codeReviews: state.codeReviews, work: state.work, checks: state.checks, checkpointHash: state.checkpointHash, delivery: state.delivery, round: state.round, outcome: state.outcome }) } };
  }
  const clarification = blockerCycleSchema.safeParse(value);
  if (clarification.success) {
    const state = clarification.data;
    const approved = state.review?.decision === 'approve' ? state.draft : state.approvedProduct.artifacts.at(-1);
    const files: Record<string, string> = { 'clarification-history.json': json(state.history), 'engineering-references.json': json({ note: state.referenceNote, references: Object.fromEntries(Object.entries(state.references).map(/** 文档正文仍在只读候选，投影只记录版本。 */([path, content]) => [path, { hash: createHash('sha256').update(content).digest('hex'), bytes: Buffer.byteLength(content) }])) }) };
    if (approved) { files['product.md'] = approved.content; files['product-version.json'] = json({ hash: approved.hash, evidence: approved.evidence }); }
    if (state.plan) files['clarification-plan.json'] = json(state.plan);
    if (state.answer) files['clarification-answers.json'] = json(state.answer);
    if (state.draft) { files['product-revision-draft.md'] = state.draft.content; files['product-revision-version.json'] = json({ hash: state.draft.hash, approved: state.review?.decision === 'approve' }); }
    if (state.review) files['product-revision-review.json'] = json(state.review);
    return { correlation: state.development.input.correlation, runId: state.development.input.source.runId, area: 'product', files };
  }
  const scope = inputV2Schema.safeParse(value);
  if (scope.success) return { correlation: scope.data.correlation, runId: scope.data.source.runId, area: 'product', files: { 'project-scope.json': json({ source: scope.data.source, scopeApproval: scope.data.scopeApproval, project: { id: scope.data.project.id, roles: scope.data.project.roles, writablePaths: scope.data.project.writablePaths, checkFiles: scope.data.project.checkFiles }, maxReworks: scope.data.maxReworks }) } };
  return undefined;
}

/** 只写不可变投影目录，完成标记最后落盘；失败保留原生事实，不能假报成功。 */
async function archive(config: PracticeConfig, target: RemoteSyncTarget, runId: string, stage: string, value: unknown, event: 'pending' | 'completed', publish: typeof publishHandoff = publishHandoff): Promise<RemoteHandoff | undefined> {
  const projection = projectAssets(value);
  if (!projection) throw new Error('没有可识别的业务资产投影');
  const root = validateRepository(target.root, target.origin);
  const owner = projection.correlation?.runId ?? projection.runId ?? runId;
  if (projection.correlation && projection.runId && projection.runId !== owner) throw new Error('归档 Run 关联漂移');
  if (!/^[a-zA-Z0-9_-]{1,200}$/.test(owner)) throw new Error('非法资产 Run 标识');
  const files: Record<string, string> = { ...projection.files, 'event.json': json({ stage, event }) };
  if (projection.area === 'product') {
    const sourceManifest = join(root, 'product/sources/manifest.json');
    if (existsSync(sourceManifest)) {
      if (lstatSync(sourceManifest).isSymbolicLink() || !lstatSync(sourceManifest).isFile()) throw new Error('资料清单必须为普通文件');
      files['sources-observed-at-export.json'] = json({ authority: 'export-time-only', note: '不是生成时实际读取证据', manifest: JSON.parse(readFileSync(sourceManifest, 'utf8')) });
    }
  }
  const digest = bytesHash(json({ correlation: projection.correlation, files }));
  const relative = `${projection.area}/runs/${owner}/${stage}/${digest}`;
  const directory = ensureAssetDirectory(root, relative);
  const hashes: Record<string, string> = {};
  for (const [name, content] of Object.entries(files)) hashes[name] = bytesHash(content);
  const manifestPath = join(directory, 'manifest.json');
  const complete = existsSync(manifestPath);
  if (complete && (lstatSync(manifestPath).isSymbolicLink() || !lstatSync(manifestPath).isFile())) throw new Error('清单必须为普通文件');
  const previous = complete ? assetManifestSchema.parse(JSON.parse(readFileSync(manifestPath, 'utf8'))) : undefined;
  const manifest = { schemaVersion: 2 as const, repository: target.origin, runId: owner, stage, mode: config.mode, event, projectionHash: digest, authority: 'workflow-export' as const, correlation: projection.correlation, createdAt: previous?.createdAt ?? new Date().toISOString(), files: hashes };
  for (const [name, content] of Object.entries(files)) {
    const path = join(directory, name);
    if (complete && !existsSync(path)) throw new Error('已完成资产缺失文件');
    writeImmutableFile(path, content);
  }
  // 清单最后写入形成完成标记，并发相同投影采用首个成功写入的时间。
  try { writeFileSync(manifestPath, json(manifest), { flag: 'wx', mode: 0o600 }); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
  if (lstatSync(manifestPath).isSymbolicLink() || !lstatSync(manifestPath).isFile()) throw new Error('清单必须为普通文件');
  const saved = assetManifestSchema.parse(JSON.parse(readFileSync(manifestPath, 'utf8')));
  if (json({ ...saved, createdAt: undefined }) !== json({ ...manifest, createdAt: undefined })) throw new Error('资产清单冲突');
  if (config.mode !== 'live') return;
  const remoteFiles: Record<string, string> = {};
  for (const [name, content] of Object.entries(files)) remoteFiles[`${relative}/${name}`] = content;
  remoteFiles[`${relative}/manifest.json`] = json(saved);
  return publish(root, owner, remoteFiles);
}

/** 装饰角色关口：暂停前归档输入，成功后归档输出，保留原审批并增加同步暂停类型。 */
export function withRepositoryAssets<T extends Step<any, any, any, any, any, any>>(step: T, config: PracticeConfig, publish: typeof publishHandoff = publishHandoff): T {
  if (!remoteSyncTargets(config).length) return withRunArchive(step, config);
  const execute = step.execute;
  const originalResumeSchema = step.resumeSchema;
  if (config.mode === 'live') {
    // 新暂停类型与原生人工关口并存，恢复同步不能伪造原关口决定。
    (step as any).resumeSchema = z.union([(step.resumeSchema as z.ZodType | undefined) ?? z.never(), repositoryRetrySchema]);
    (step as any).suspendSchema = z.union([(step.suspendSchema as z.ZodType | undefined) ?? z.never(), repositorySyncPauseSchema]);
  }
  /** 生成检查点先于网络副作用，原生 suspend/resume 继续拥有调度权。 */
  step.execute = async (context) => {
    const target = resolveRemoteSyncTarget(config, step.id);
    if (!target) return execute(context);
    const root = validateRepository(target.root, target.origin);
    const pausedSync = repositorySyncPauseSchema.safeParse(context.suspendData);
    if (!pausedSync.success && context.resumeData !== undefined) {
      if (!originalResumeSchema) throw new Error('该业务步骤没有恢复输入');
      const checked = await originalResumeSchema['~standard'].validate(context.resumeData);
      if (checked.issues) throw new Error('原业务关口输入不符合要求，资料重试不能替代业务审批');
      context = { ...context, resumeData: checked.value };
    }
    const key = pausedSync.success ? pausedSync.data.retryKey : contentHash(json({ runId: context.runId, stage: step.id, input: context.inputData, resume: context.resumeData, suspend: context.suspendData }));
    const cache = config.mode === 'live' ? join(handoffCache(root), `result-${key}.json`) : undefined;
    if (pausedSync.success && repositoryRetrySchema.parse(context.resumeData).repositoryRetry !== key) throw new Error('同步恢复版本已变化');
    type Checkpoint = { runId: string; stage: string; inputHash: string; action: 'result' | 'suspend' | 'bail'; value: unknown; args?: unknown[] };
    /** 成功推送后才返回/暂停业务关口；失败仅开放同步重试，不重放角色。 */
    async function deliver(checkpoint: Checkpoint) {
      let receipt: RemoteHandoff | undefined;
      try { receipt = await archive(config, target!, context.runId, step.id, checkpoint.value, checkpoint.action === 'suspend' ? 'pending' : 'completed', publish); }
      catch (error) {
        if (!cache) throw error;
        return context.suspend({ kind: 'repository-sync', mode: config.mode, retryKey: key, stage: step.id, reason: '产物已生成并保存，远端同步未完成；重试仅同步资料，不重新生成或批准。' });
      }
      // 候选正文只用于远端归档，Workflow 保存原有源码检查点和交接回执。
      const { repositoryCandidate: _candidate, ...saved } = checkpoint.value as Record<string, unknown>;
      const value = receipt ? { ...saved, repositoryHandoff: receipt } : saved;
      if (checkpoint.action === 'suspend') return context.suspend(...(checkpoint.args as Parameters<typeof context.suspend>));
      if (checkpoint.action === 'bail') return context.bail(value);
      return value;
    }
    /** 检查点必须属于本步骤及原输入，不能借重试标识读取其他Run。 */
    function validate(checkpoint: Checkpoint) {
      if (checkpoint.runId !== context.runId || checkpoint.stage !== step.id || checkpoint.inputHash !== contentHash(json(context.inputData))) throw new Error('同步检查点归属不一致');
      return checkpoint;
    }
    if (cache && existsSync(cache)) {
      const cached = JSON.parse(readHandoffCache(cache));
      if (cached.action === undefined && step.id === 'architecture') {
        const value = validateLegacyArchitectureResult(stateV2Schema.parse(context.inputData), cached);
        return deliver({ runId: context.runId, stage: step.id, inputHash: contentHash(json(context.inputData)), action: 'result', value });
      }
      return deliver(validate(cached));
    }
    // 历史架构缓存使用早期键格式；只允许精确同Run、同输入的只读适配，不能因此跳过源码或审批校验。
    if (config.mode === 'live' && step.id === 'architecture' && existsSync(legacyArchitectureCachePath(root, context.runId, stateV2Schema.parse(context.inputData)))) {
      const value = readLegacyArchitectureResult(root, context.runId, stateV2Schema.parse(context.inputData));
      return deliver({ runId: context.runId, stage: step.id, inputHash: contentHash(json(context.inputData)), action: 'result', value });
    }
    if (pausedSync.success) throw new Error('同步检查点缺失，拒绝重新生成角色产物');
    let intercepted = false;
    /** 只缓存业务产物，不缓存未校验的人工请求或模型配置。 */
    function checkpoint(action: Checkpoint['action'], value: unknown, args?: unknown[]) {
      const record: Checkpoint = { runId: context.runId, stage: step.id, inputHash: contentHash(json(context.inputData)), action, value, ...(args ? { args } : {}) };
      if (cache) writeHandoffCache(cache, json(record));
      return deliver(record);
    }
    const result = await execute({ ...context,
      /** 原关口仍由原生状态保存，远端成功后才向人展示。 */
      suspend: async (...args: Parameters<typeof context.suspend>) => { intercepted = true; return checkpoint('suspend', context.inputData, args); },
      /** 拒绝和终止也必须留下远端版本，不丢弃已完成角色产物。 */
      bail: (value: Parameters<typeof context.bail>[0]) => { intercepted = true; return checkpoint('bail', value); },
    } as any);
    if (!intercepted && result !== undefined && projectAssets(result)) return checkpoint('result', result);
    return result;
  };
  return withRunArchive(step, config);
}
