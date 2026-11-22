import { z } from 'zod';
import { assertProjectCorrelation, projectRepositoryRoot, selectProjectConfig } from '../business-engineering/project.js';
import { developmentHash } from '../development/contracts.js';
import { stateV2Schema } from '../development/v2/contracts.js';
import { lifecycleSchema, matchesAcceptancePlan, qualityHash } from '../delivery/contracts.js';
import { deliverySchema } from '../mastra/workflows/delivery.js';
import { readHandoffFile } from '../delivery/remote-handoff.js';
import type { PracticeConfig } from '../mastra/config.js';
import type { MastraCompositeStore } from '@mastra/core/storage';
import { independentTeamRunInputSchema, type IndependentTeamRunInput } from './independent-run-input.js';

const snapshotSchema = z.object({ status: z.string(), steps: z.record(z.string(), z.unknown()).optional(), context: z.record(z.string(), z.unknown()).optional(), result: z.unknown().optional() }).passthrough();

/** 仅选取 Store 中成功完成的步骤输出，不读取暂停载荷或调用方提供的材料。 */
function completedOutputs(snapshot: z.infer<typeof snapshotSchema>, leaf?: string) {
  return Object.entries(snapshot.steps ?? {}).flatMap(([path, value]) => {
    if (leaf && path.replace(/#\d+$/, '').split('.').at(-1) !== leaf) return [];
    const step = z.object({ status: z.string(), output: z.unknown().optional() }).safeParse(value);
    return step.success && step.data.status === 'success' && step.data.output !== undefined ? [step.data.output] : [];
  });
}

/** live 来源的正式规格必须能从已绑定仓库的固定提交读取并核对内容摘要。 */
function verifyReceipts(config: PracticeConfig, projectId: string, receipts: Array<{ handoff: { version: 'remote-handoff.v1'; branch: string; commit: string; files: Record<string, string> }; paths: string[] }> | undefined) {
  if (config.mode !== 'live') return;
  const root = projectRepositoryRoot(selectProjectConfig(config, projectId));
  if (!root || !receipts?.length) throw new Error('来源缺少正式规格回执');
  for (const receipt of receipts) for (const path of receipt.paths) readHandoffFile(root, receipt.handoff, path);
}

/** 校验来源的工程绑定与请求项目；来源版本必须能在当前登记配置下恢复。 */
function verifyProject(config: PracticeConfig, projectId: string, runId: string, correlation: unknown) {
  const selected = selectProjectConfig(config, projectId);
  const owner = z.object({ projectId: z.string(), runId: z.string() }).passthrough().parse(correlation);
  if (owner.projectId !== projectId) throw new Error('来源 Run 不属于所选项目');
  if (owner.runId !== runId) throw new Error('来源 Run 标识与冻结绑定不一致');
  assertProjectCorrelation(selected, correlation as Parameters<typeof assertProjectCorrelation>[1]);
}

/** 从服务端读取的原生快照选择团队来源，并绑定完整来源内容散列。 */
export function resolveIndependentTeamSource(config: PracticeConfig, request: IndependentTeamRunInput, rawSnapshot: unknown) {
  if (request.source.kind === 'new-requirement' || request.source.kind === 'prepared-input') throw new Error('此来源需要对应的接入流程');
  const snapshot = snapshotSchema.parse(rawSnapshot);
  const outputs = completedOutputs(snapshot);
  if (request.source.kind === 'approved-product') {
    const productTeam = z.object({ status: z.literal('success'), output: z.unknown() }).safeParse(snapshot.context?.['product-team']);
    const candidates = [...completedOutputs(snapshot, 'review-product'), ...(productTeam.success ? [productTeam.data.output] : [])].flatMap(output => {
      const parsed = deliverySchema.safeParse(output);
      if (!parsed.success) return [];
      const product = parsed.data.artifacts.find(item => item.stage === 'product');
      const approved = product && parsed.data.reviews.some(review => review.role === 'product' && review.decision === 'approve' && review.artifactHash === product.hash);
      return approved ? [parsed.data] : [];
    });
    const product = candidates.at(-1);
    if (!product) throw new Error('来源 Run 没有已批准的产品版本');
    verifyProject(config, request.projectId, request.source.runId, product.correlation);
    verifyReceipts(config, request.projectId, product.formalSpecifications?.filter(item => item.kind === 'product'));
    return { kind: request.source.kind, sourceRunId: request.source.runId, sourceHash: developmentHash(product), value: product };
  }
  if (snapshot.status !== 'success') throw new Error('来源 Run 尚未成功结束');
  if (request.source.kind === 'development-delivery') {
    const candidates = [snapshot.result, ...outputs].flatMap(value => {
      const direct = stateV2Schema.safeParse(value);
      const wrapped = lifecycleSchema.safeParse(value);
      const state = direct.success ? direct.data : wrapped.success ? wrapped.data.development : undefined;
      return state?.outcome === 'development-delivered' && state.delivery && state.delivery.sourceHash === state.checkpointHash && developmentHash(state.delivery.files) === state.checkpointHash ? [state] : [];
    });
    const development = candidates.at(-1);
    if (!development) throw new Error('来源 Run 没有同版本研发交付');
    verifyProject(config, request.projectId, request.source.runId, development.input.correlation);
    const receipts = [development.input.formalSpecifications?.find(item => item.kind === 'product'), development.formalSpecification];
    if (config.mode === 'live' && receipts.some(item => !item)) throw new Error('来源缺少产品或研发正式规格');
    verifyReceipts(config, request.projectId, receipts.filter(item => item !== undefined));
    return { kind: request.source.kind, sourceRunId: request.source.runId, sourceHash: developmentHash(development), value: development };
  }
  const candidates = [snapshot.result, ...outputs].flatMap(value => {
    const parsed = lifecycleSchema.safeParse(value);
    if (!parsed.success) return [];
    const state = parsed.data;
    return state.quality.status === 'passed' && state.quality.review?.decision === 'pass' && state.quality.sourceHash === state.development.checkpointHash && state.quality.reportHash === qualityHash(state) && matchesAcceptancePlan(state) ? [state] : [];
  });
  const quality = candidates.at(-1);
  if (!quality) throw new Error('来源 Run 没有同版本 QA 放行');
  verifyProject(config, request.projectId, request.source.runId, quality.development.input.correlation);
  const receipts = [quality.development.input.formalSpecifications?.find(item => item.kind === 'product'), quality.development.formalSpecification, quality.formalSpecifications?.filter(item => item.kind === 'testing').at(-1)];
  if (config.mode === 'live' && receipts.some(item => !item)) throw new Error('来源缺少正式规格');
  verifyReceipts(config, request.projectId, receipts.filter(item => item !== undefined));
  return { kind: request.source.kind, sourceRunId: request.source.runId, sourceHash: developmentHash(quality), value: quality };
}

/** 从 Mastra 原生 Store 获取经输入契约限定的来源；客户端不能提供快照。 */
export async function loadIndependentTeamSource(storage: MastraCompositeStore, config: PracticeConfig, request: IndependentTeamRunInput) {
  if (request.source.kind === 'new-requirement' || request.source.kind === 'prepared-input') throw new Error('此来源需要对应的接入流程');
  // 此函数也可能被内部调用，必须在访问 Store 前重新校验来源与 Workflow 的组合。
  const validated = independentTeamRunInputSchema.parse(request);
  if (validated.source.kind === 'new-requirement' || validated.source.kind === 'prepared-input') throw new Error('此来源需要对应的接入流程');
  const store = await storage.getStore('workflows');
  if (!store) throw new Error('缺少 Workflow Store');
  const snapshot = await store.loadWorkflowSnapshot({ workflowName: validated.source.workflowId, runId: validated.source.runId });
  if (!snapshot) throw new Error('来源 Run 不存在');
  return resolveIndependentTeamSource(config, validated, snapshot);
}
