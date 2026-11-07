/** HRM 业务资产投影：Git 保存交付副本，Mastra Store 继续拥有审批和恢复事实。
 * ADR: docs/decisions/2026-11-07-hrm-repository-assets.md
 */
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ensureAssetDirectory, validateHrmRepository } from './asset-files.js';
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
    return { correlation: state.input.correlation, runId: state.input.source.runId, area: 'product', files: { 'development.json': json({ mode: state.mode, productHash: state.input.source.hash, requirements: state.requirements, context: state.context, plan: state.plan, planHash: state.planHash, team: state.team, delegations: state.delegations, reviews: state.reviews, readiness: state.readiness, codeReviews: state.codeReviews, work: state.work, checks: state.checks, checkpointHash: state.checkpointHash, delivery: state.delivery, round: state.round, outcome: state.outcome }) } };
  }
  const scope = inputV2Schema.safeParse(value);
  if (scope.success) return { correlation: scope.data.correlation, runId: scope.data.source.runId, area: 'product', files: { 'project-scope.json': json({ source: scope.data.source, scopeApproval: scope.data.scopeApproval, project: { id: scope.data.project.id, roles: scope.data.project.roles, writablePaths: scope.data.project.writablePaths, checkFiles: scope.data.project.checkFiles }, maxReworks: scope.data.maxReworks }) } };
  return undefined;
}

/** 只写不可变投影目录，完成标记最后落盘；失败保留原生事实，不能假报成功。 */
function archive(config: PracticeConfig, runId: string, stage: string, value: unknown, event: 'pending' | 'completed'): void {
  if (!config.hrmRepositoryRoot) return;
  const projection = projectAssets(value);
  if (!projection) throw new Error('没有可识别的业务资产投影');
  const root = validateHrmRepository(config.hrmRepositoryRoot);
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
  const directory = ensureAssetDirectory(root, `${projection.area}/runs/${owner}/${stage}/${digest}`);
  const hashes: Record<string, string> = {};
  for (const [name, content] of Object.entries(files)) hashes[name] = bytesHash(content);
  const manifestPath = join(directory, 'manifest.json');
  const complete = existsSync(manifestPath);
  if (complete && (lstatSync(manifestPath).isSymbolicLink() || !lstatSync(manifestPath).isFile())) throw new Error('清单必须为普通文件');
  const previous = complete ? assetManifestSchema.parse(JSON.parse(readFileSync(manifestPath, 'utf8'))) : undefined;
  const manifest = { schemaVersion: 2 as const, repository: 'https://github.com/leidaibo-lab/hrm' as const, runId: owner, stage, mode: config.mode, event, projectionHash: digest, authority: 'workflow-export' as const, correlation: projection.correlation, createdAt: previous?.createdAt ?? new Date().toISOString(), files: hashes };
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
}

/** 装饰角色关口：暂停前归档输入，成功后归档输出，不改变审批 schema 和恢复权。 */
export function withRepositoryAssets<T extends Step<any, any, any, any, any, any>>(step: T, config: PracticeConfig): T {
  if (!config.hrmRepositoryRoot) return step;
  const execute = step.execute;
  // 每次执行仅保留本次调用的暂停标记，不在闭包共享 Run 状态。
  step.execute = async (context) => {
    let paused = false;
    const result = await execute({ ...context,
      // 原生暂停前先写可重建投影；不归档未经步骤校验的 resume 输入。
      suspend: async (...args: Parameters<typeof context.suspend>) => {
        archive(config, context.runId, step.id, context.inputData, 'pending');
        paused = true;
        return context.suspend(...args);
      },
      // 原生 bail 会跳过下游节点，在返回终态前保存产品拒绝/退回投影。
      bail: (value: Parameters<typeof context.bail>[0]) => {
        archive(config, context.runId, step.id, value, 'completed');
        paused = true;
        return context.bail(value);
      },
    });
    if (!paused && result !== undefined && projectAssets(result)) archive(config, context.runId, step.id, result, 'completed');
    return result;
  };
  return step;
}
