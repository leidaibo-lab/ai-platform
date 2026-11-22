/** 独立团队的公开输入只包含受限引用，批准和候选始终从原生 Store 重读。 */
import { z } from 'zod';
import type { Mastra } from '@mastra/core';
import type { PracticeConfig } from '../mastra/config.js';
import { assetIdSchema, businessWorkflowSchema, projectIdSchema } from '../delivery/asset-identity.js';
import { intakeModeSchema } from '../intake/contracts.js';
import { deliverySchema, type Delivery } from '../mastra/workflows/delivery.js';
import { stateV2Schema, type StateV2 } from '../development/v2/contracts.js';
import { lifecycleSchema, qualityHash, type Lifecycle } from '../delivery/contracts.js';
import { assertProjectCorrelation, projectRepositoryRoot } from '../business-engineering/project.js';
import { contentHash, publishFormalSpecification, readHandoffFile, type FormalSpecificationReceipt } from '../delivery/remote-handoff.js';
import { canWriteProjectPath, developmentHash } from '../development/contracts.js';
import { executionResolver } from '../mastra/workflows/development-team.js';
import { validateIdentityV2 } from '../development/v2/gates.js';
import { loadDevelopmentMethods } from '../development/v2/methods.js';

export const teamIds = ['product', 'development', 'testing', 'delivery'] as const;
export const teamWorkflowKeys = { product: 'productTeamRun', development: 'developmentTeamRun', testing: 'testingTeamRun', delivery: 'deliveryTeamRun' } as const;
export const teamWorkflowIds = { product: 'team-product', development: 'team-development', testing: 'team-testing', delivery: 'team-delivery' } as const;
const sourceSchema = z.object({ workflow: businessWorkflowSchema, runId: z.uuid(), hash: z.string().regex(/^[a-f0-9]{64}$/) }).strict();
export const inputPackageReferenceSchema = z.object({ runId: z.uuid(), hash: z.string().regex(/^[a-f0-9]{64}$/) }).strict();
const common = { version: z.literal('team-run-input.v1'), projectId: projectIdSchema, iterationId: assetIdSchema, inputPackage: inputPackageReferenceSchema.optional() };
export const teamRunInputSchema = z.discriminatedUnion('team', [
  z.object({ ...common, team: z.literal('product'), brief: z.string().trim().min(1).max(12000), intakeMode: intakeModeSchema.default('clarify') }).strict(),
  z.object({ ...common, team: z.literal('development'), source: sourceSchema }).strict(),
  z.object({ ...common, team: z.literal('testing'), source: sourceSchema }).strict(),
  z.object({ ...common, team: z.literal('delivery'), source: sourceSchema }).strict(),
]);
export type TeamRunInput = z.infer<typeof teamRunInputSchema>;
export type SourceReference = z.infer<typeof sourceSchema>;
export const teamRunBindingSchema = z.object({
  version: z.literal('team-run-binding.v1'), input: teamRunInputSchema,
  sourceHash: z.string().length(64).optional(),
});
type TrustedSource = { product?: Delivery; development?: StateV2; lifecycle?: Lifecycle; hash: string };

/** 只接受已保存且已完成的团队输出，来源工作流必须来自登记业务入口。 */
export async function resolveTeamSource(mastra: Mastra, config: PracticeConfig, team: Exclude<TeamRunInput['team'], 'product'>, reference: Omit<SourceReference, 'hash'>, expectedHash?: string): Promise<TrustedSource> {
  const workflow = mastra.getWorkflow(reference.workflow);
  const snapshot = await workflow.getWorkflowRunById(reference.runId);
  if (!snapshot || ['running', 'pending'].includes(snapshot.status)) throw new Error('来源 Run 尚未形成稳定团队产物');
  /** 根团队成功输出优先于整个业务 Run 的结果。 */
  function completedOutput(id: string) {
    const step = snapshot!.steps?.[id];
    return step && !Array.isArray(step) && step.status === 'success' ? step.output : undefined;
  }
  const product = deliverySchema.safeParse(completedOutput('product-team') ?? snapshot.result).data;
  const development = stateV2Schema.safeParse(completedOutput('development-team') ?? (snapshot.result as any)?.development ?? snapshot.result).data;
  const lifecycle = lifecycleSchema.safeParse(completedOutput('test-team') ?? snapshot.result).data;
  let source: TrustedSource;
  if (team === 'development') {
    const artifact = product?.artifacts.at(-1);
    const approval = product?.reviews.filter(review => review.role === 'product' && review.artifactHash === artifact?.hash).at(-1);
    if (!product || product.mode !== config.mode || artifact?.stage !== 'product' || approval?.decision !== 'approve') throw new Error('来源 Run 缺少当前产品的人工批准');
    assertProjectCorrelation(config, product.correlation);
    source = { product, hash: developmentHash(product) };
    verifyFormalSources(config, product.formalSpecifications ?? []);
  } else {
    const state = team === 'testing' ? development ?? lifecycle?.development : lifecycle?.development;
    if (!state?.delivery || state.outcome !== 'development-delivered') throw new Error('来源 Run 缺少研发交付');
    assertProjectCorrelation(config, state.input.correlation);
    validateIdentityV2(state, config, loadDevelopmentMethods(config.rootDir).hashFor(state.input, state.methodBundleHash));
    if (team === 'delivery' && (!lifecycle || lifecycle.quality.status !== 'passed' || lifecycle.quality.sourceHash !== state.checkpointHash || lifecycle.quality.reportHash !== qualityHash(lifecycle))) throw new Error('来源 Run 缺少同版本 QA 放行');
    source = { development: state, ...(team === 'delivery' ? { lifecycle } : {}), hash: developmentHash(team === 'delivery' ? lifecycle : state) };
    verifyFormalSources(config, [...(state.input.formalSpecifications ?? []), ...(state.formalSpecification ? [state.formalSpecification] : []), ...(lifecycle?.formalSpecifications ?? [])]);
    const execution = executionResolver(config, { requireExisting: true })(state.input);
    try {
      if (developmentHash(await execution.snapshot()) !== state.checkpointHash || developmentHash(state.delivery.files) !== state.checkpointHash) throw new Error('来源候选检查点漂移');
    } finally { await execution.close(); }
  }
  if (expectedHash && source.hash !== expectedHash) throw new Error('团队来源版本已变化');
  return source;
}

/** 固定 Git 文件必须逐字节符合 Store 回执，live 来源必须拥有正式规格。 */
function verifyFormalSources(config: PracticeConfig, receipts: FormalSpecificationReceipt[]) {
  const root = projectRepositoryRoot(config);
  if (config.mode === 'live' && (!root || !receipts.length)) throw new Error('独立团队缺少正式规格来源');
  if (!receipts.length) return;
  if (!root) throw new Error('规格来源缺少绑定仓库');
  for (const receipt of receipts) for (const path of receipt.paths) readHandoffFile(root, receipt.handoff, path);
}

/** 新团队分支重新登记上游规格，Git 端口自身对相同内容重试进行对账。 */
export async function rehomeSpecifications(config: PracticeConfig, receipts: FormalSpecificationReceipt[], runId: string, iterationId: string, revision?: string) {
  if (config.mode === 'fixture') return [];
  const root = projectRepositoryRoot(config);
  if (!root) throw new Error('独立团队缺少正式规格仓库');
  const latest = new Map(receipts.map(receipt => [receipt.kind, receipt]));
  const result: FormalSpecificationReceipt[] = [];
  for (const kind of ['product', 'development', 'testing'] as const) {
    const receipt = latest.get(kind);
    if (!receipt) continue;
    const files = Object.fromEntries(receipt.paths.map(path => [path, readHandoffFile(root, receipt.handoff, path)]));
    const handoff = await publishFormalSpecification(root, runId, iterationId, files, `docs(spec): 接入独立团队${kind}规格`, revision, Object.keys(files));
    result.push({ kind, handoff, paths: Object.keys(files), upstreamCommits: result.map(item => item.handoff.commit) });
  }
  return result;
}

/** 从已校验的研发交付复制候选，新 Run 只允许完成未中断的相同复制。 */
export async function copyTeamCandidate(config: PracticeConfig, state: StateV2, input: StateV2['input']) {
  const source = executionResolver(config, { requireExisting: true })(state.input);
  const target = executionResolver(config)(input);
  try {
    if (developmentHash(await source.snapshot()) !== state.checkpointHash) throw new Error('复制前来源候选漂移');
    const targetSnapshot = await target.snapshot();
    for (const [path, expected] of Object.entries(state.delivery!.files)) {
      const content = await source.readFile(path);
      if (contentHash(content) !== expected) throw new Error('复制时来源候选漂移');
      const current = path in targetSnapshot ? await target.readFile(path) : undefined;
      if (current !== content && current !== input.project.files[path]) throw new Error('独立团队候选已变化，拒绝覆盖');
      if (current === content) continue;
      if (!canWriteProjectPath(input.project, path)) throw new Error('来源修改了受保护检查');
      await target.writeFile(path, content);
    }
    if (developmentHash(await source.snapshot()) !== state.checkpointHash || developmentHash(await target.snapshot()) !== state.checkpointHash) throw new Error('独立候选副本与来源不一致');
  } finally { await source.close(); await target.close(); }
}
