/** 生命周期 Observer/文件 Adapter；Mastra Store 继续拥有审批与恢复事实。
 * ADR: docs/decisions/2026-11-09-mastra-run-archive.md
 */
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import type { Step, WorkflowOptions } from '@mastra/core/workflows';
import type { PracticeConfig } from '../mastra/config.js';
import { assetIdSchema, correlationSchema } from './asset-identity.js';
import { ensureAssetDirectory, safeAssetPath, validateHrmRepository, validateRepository } from './asset-files.js';
import { registerAssetRun, writeImmutableFile, readAssetCatalog } from './asset-catalog.js';
import { publishHandoff, remoteHandoffSchema } from './remote-handoff.js';
import { resolveRemoteSyncTarget } from './remote-sync-settings.js';

const identifier = z.string().regex(/^[a-zA-Z0-9_-]{1,200}$/);
const statusSchema = z.enum(['running', 'returned', 'suspended', 'success', 'failed', 'tripwire', 'canceled', 'bailed', 'waiting', 'pending', 'paused', 'skipped']);
const reasonSchema = z.enum(['repository-sync', 'human-or-recovery-gate', 'model-timeout', 'model-call-failed', 'invalid-output', 'step-failed']);
/** 显式公开字段；null 表示未采集，不从正文或异常猜测。 */
export const runArchiveSchema = z.object({
  schemaVersion: z.literal('run-archive.v1'), authority: z.literal('mastra-store-projection'),
  projectId: z.literal('hrm'), iterationId: assetIdSchema.nullable(), runId: identifier,
  workflowId: z.literal('productDevelopmentWorkflow'), workflowDefinitionId: z.literal('product-development-resources-v1'),
  workflowVersion: z.literal('product-development.archive.v1'), mode: z.enum(['fixture', 'live']),
  scope: z.enum(['run', 'step']), stage: identifier.nullable(), status: statusSchema, observedAt: z.iso.datetime(),
  reason: reasonSchema.nullable(),
  code: z.object({ revision: z.string().regex(/^[a-f0-9]{40,64}$/).nullable(), dirty: z.boolean().nullable() }),
  artifacts: z.array(remoteHandoffSchema), artifactPaths: z.array(z.string().regex(/^(product|testSet|deploy)\/runs\/[a-zA-Z0-9_/-]+\/manifest\.json$/)),
  recovery: z.object({ source: z.literal('Mastra Store'), portable: z.literal(false), condition: z.enum(['wait-for-human-or-sync', 'inspect-native-failure', 'none', 'inspect-native-state']) }),
});
export type RunArchive = z.infer<typeof runArchiveSchema>;
/** 宿主观察输入不包含配置、异常详情或模型请求。 */
export interface ArchiveObservation { runId: string; scope: 'run' | 'step'; stage?: string; status: z.infer<typeof statusSchema>; reason?: z.infer<typeof reasonSchema>; iterationId?: string; value?: unknown }

/** 只使用枚举类别，不将上游异常消息或堆栈带入档案。 */
function failureReason(error: unknown): z.infer<typeof reasonSchema> {
  const detail = z.object({ name: z.string().optional(), statusCode: z.number().optional() }).safeParse(error);
  if (!detail.success) return 'step-failed';
  if ([408, 504, 524].includes(detail.data.statusCode ?? 0)) return 'model-timeout';
  if (['SyntaxError', 'ZodError'].includes(detail.data.name ?? '')) return 'invalid-output';
  return detail.data.name === 'AI_APICallError' ? 'model-call-failed' : 'step-failed';
}

/** 只沿已知业务结构读取关联和回执，不遍历任意模型内容。 */
function businessMetadata(value: unknown): { iterationId?: string; runId?: string; artifacts: z.infer<typeof remoteHandoffSchema>[] } {
  if (Array.isArray(value)) return businessMetadata(value[0]);
  const wrapped = z.object({ state: z.unknown() }).safeParse(value);
  if (wrapped.success && wrapped.data.state) return businessMetadata(wrapped.data.state);
  const state = z.object({ correlation: correlationSchema.optional(), repositoryHandoff: remoteHandoffSchema.optional(), input: z.object({ correlation: correlationSchema.optional() }).optional(), development: z.object({ input: z.object({ correlation: correlationSchema.optional() }) }).optional() }).safeParse(value);
  if (!state.success) return { artifacts: [] };
  const correlation = state.data.correlation ?? state.data.input?.correlation ?? state.data.development?.input.correlation;
  return { iterationId: correlation?.iterationId, runId: correlation?.runId, artifacts: state.data.repositoryHandoff ? [state.data.repositoryHandoff] : [] };
}

/** 只读平台代码身份；采集失败保持 null，不输出 Git 错误。 */
function codeIdentity(root: string): RunArchive['code'] {
  try {
    const options = { encoding: 'utf8' as const, timeout: 5000, stdio: ['ignore', 'pipe', 'pipe'] as ['ignore', 'pipe', 'pipe'] };
    const revision = execFileSync('git', ['-C', root, 'rev-parse', 'HEAD'], options).trim();
    const dirty = !!execFileSync('git', ['-C', root, 'status', '--porcelain', '--untracked-files=normal'], options).trim();
    return { revision, dirty };
  } catch { return { revision: null, dirty: null }; }
}

/** 补推本地不可变历史；沿用隔离 index 的 Git Adapter，不改工作树。 */
export async function syncRunArchive(config: PracticeConfig, runId: string, publish: typeof publishHandoff = publishHandoff): Promise<'synced' | 'disabled' | 'missing'> {
  identifier.parse(runId);
  if (!config.hrmRepositoryRoot || config.mode !== 'live') return 'disabled';
  const target = resolveRemoteSyncTarget(config, 'initialize-product-development');
  if (!target) return 'disabled';
  validateRepository(target.root, target.origin);
  const root = validateHrmRepository(config.hrmRepositoryRoot);
  const relative = `product/catalog/runs/${runId}`;
  if (!existsSync(join(root, relative, 'history'))) return 'missing';
  const files: Record<string, string> = {};
  files[`${relative}/run.json`] = readFileSync(safeAssetPath(root, `${relative}/run.json`), 'utf8');
  const entries = readdirSync(safeAssetPath(root, `${relative}/history`), { withFileTypes: true });
  if (entries.length > 5000) throw new Error('运行档案超过同步预算');
  let bytes = 0;
  for (const entry of entries) {
    if (!entry.isFile() || entry.isSymbolicLink() || !/^[a-zA-Z0-9_-]+\.json$/.test(entry.name)) throw new Error('运行档案目录无效');
    const path = `${relative}/history/${entry.name}`;
    const content = readFileSync(safeAssetPath(root, path), 'utf8');
    const record = runArchiveSchema.parse(JSON.parse(content));
    if (record.runId !== runId) throw new Error('运行档案归属冲突');
    bytes += Buffer.byteLength(content);
    if (bytes > 16 * 1024 * 1024) throw new Error('运行档案超过字节预算');
    files[path] = content;
  }
  await publish(target.root, runId, files);
  return 'synced';
}

/** 先本地落盘再同步；调用方负责隔离归档失败和业务结果。 */
export async function recordRunArchive(config: PracticeConfig, observation: ArchiveObservation, publish: typeof publishHandoff = publishHandoff): Promise<void> {
  if (!config.hrmRepositoryRoot) return;
  const root = validateHrmRepository(config.hrmRepositoryRoot);
  const metadata = businessMetadata(observation.value);
  const runId = metadata.runId ?? observation.runId;
  identifier.parse(runId);
  const relative = `product/catalog/runs/${runId}`;
  const binding = existsSync(join(root, relative, 'run.json')) ? z.object({ correlation: correlationSchema }).parse(JSON.parse(readFileSync(safeAssetPath(root, `${relative}/run.json`), 'utf8'))) : undefined;
  if (!binding || binding.correlation.runId !== runId) throw new Error('运行档案缺少根 Run 关联');
  const iterationId = metadata.iterationId ?? observation.iterationId ?? binding?.correlation.iterationId ?? null;
  if (binding && iterationId !== binding.correlation.iterationId) throw new Error('运行档案迭代归属冲突');
  const status = observation.status;
  const artifactPaths = readAssetCatalog(root).assets.filter(/** 只关联本根 Run 的已完成清单。 */asset => asset.manifest.runId === runId).map(/** 只记录路径，不复制交付正文。 */asset => asset.path);
  const record = runArchiveSchema.parse({
    schemaVersion: 'run-archive.v1', authority: 'mastra-store-projection', projectId: 'hrm', iterationId, runId,
    workflowId: 'productDevelopmentWorkflow', workflowDefinitionId: 'product-development-resources-v1', workflowVersion: 'product-development.archive.v1', mode: config.mode,
    scope: observation.scope, stage: observation.stage ?? null, status, reason: observation.reason ?? null, observedAt: new Date().toISOString(), code: codeIdentity(config.rootDir), artifacts: metadata.artifacts, artifactPaths,
    recovery: { source: 'Mastra Store', portable: false, condition: status === 'suspended' ? 'wait-for-human-or-sync' : ['failed', 'tripwire'].includes(status) ? 'inspect-native-failure' : ['success', 'bailed', 'canceled'].includes(status) ? 'none' : 'inspect-native-state' },
  });
  const directory = ensureAssetDirectory(root, `${relative}/history`);
  const name = `${record.observedAt.replace(/[^0-9TZ]/g, '')}-${randomUUID()}.json`;
  writeImmutableFile(join(directory, name), JSON.stringify(record, null, 2) + '\n');
  await syncRunArchive(config, runId, publish);
}

/** 固定警告不透出异常正文；观察失败不能改写执行和审批。 */
async function observe(config: PracticeConfig, input: ArchiveObservation): Promise<void> {
  try { await recordRunArchive(config, input); }
  catch { console.warn('[run-archive] 运行档案保存或远端同步未完成；原生状态不变，请检查档案并重试同步。'); }
}

/** 服务端 Hook 同时覆盖 Studio 和工作台，无需浏览器 watch。 */
export function runArchiveLifecycle(config: PracticeConfig): WorkflowOptions {
  return {
    /** 首次执行前登记业务创建；失败不能充当执行门禁。 */
    onStart: async info => {
      if (!config.hrmRepositoryRoot) return;
      try {
        const input = z.object({ brief: z.string(), iterationId: assetIdSchema.default('unassigned') }).parse(info.getInitData());
        registerAssetRun(config.hrmRepositoryRoot, { projectId: 'hrm', iterationId: input.iterationId, runId: info.runId, workflowId: 'productDevelopmentWorkflow' }, input.brief);
        await observe(config, { runId: info.runId, scope: 'run', status: 'running', iterationId: input.iterationId });
      } catch { console.warn('[run-archive] 初始运行档案未保存；原生状态不变。'); }
    },
    /** 记录原生整体状态，错误详情仅留在 Store。 */
    onFinish: async info => {
      const active = Object.entries(info.steps).find(/** 只提取失败/暂停步骤标识。 */([, step]) => !Array.isArray(step) && ['suspended', 'failed', 'tripwire'].includes(step.status));
      const input = z.object({ iterationId: assetIdSchema.optional() }).safeParse(info.getInitData());
      const pending = active && !Array.isArray(active[1]) ? z.object({ kind: z.literal('repository-sync') }).safeParse(active[1].suspendPayload).success : false;
      const reason = info.status === 'suspended' ? pending ? 'repository-sync' : 'human-or-recovery-gate' : ['failed', 'tripwire'].includes(info.status) ? failureReason(info.error) : undefined;
      await observe(config, { runId: info.runId, scope: 'run', stage: active?.[0].split('.')[0] ?? info.stepExecutionPath?.at(-1) ?? Object.keys(info.steps).at(-1), status: info.status, reason, iterationId: input.success ? input.data.iterationId : undefined, value: info.result });
    },
  };
}

/** 阶段 returned 仅表示返回，不冒充整个 Run 成功。 */
export function withRunArchive<T extends Step<any, any, any, any, any, any>>(step: T, config: PracticeConfig): T {
  const execute = step.execute;
  /** 保留原生返回与异常，finally 观察不会修改业务结果。 */
  step.execute = async context => {
    let status: ArchiveObservation['status'] = 'returned';
    let reason: ArchiveObservation['reason'];
    let value: unknown = context.inputData;
    try {
      const result = await execute({ ...context,
        /** 暂停仍由原生引擎处理。 */
        suspend: async (...args: Parameters<typeof context.suspend>) => { status = 'suspended'; reason = z.object({ kind: z.literal('repository-sync') }).safeParse(args[0]).success ? 'repository-sync' : 'human-or-recovery-gate'; return context.suspend(...args); },
        /** bail 仅记录阶段停止，整体结果由 Hook 确定。 */
        bail: (output: Parameters<typeof context.bail>[0]) => { status = 'bailed'; return context.bail(output); },
      } as typeof context);
      value = result ?? value;
      return result;
    } catch (error) { status = 'failed'; reason = failureReason(error); throw error; }
    finally { await observe(config, { runId: context.runId, scope: 'step', stage: step.id, status, reason, value }); }
  };
  return step;
}
