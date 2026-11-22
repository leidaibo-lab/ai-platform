/** 历史执行通过显式计划迁入新原生 Run，原审批与 Sandbox 身份保留在来源快照。 */
import { z } from 'zod';
import type { PracticeConfig } from '../mastra/config.js';
import type { Mastra } from '@mastra/core';
import { snapshotProjectConfig } from '../business-engineering/project.js';
import { deliverySchema } from '../mastra/workflows/delivery.js';
import { stateV2Schema } from '../development/v2/contracts.js';
import { developmentHash } from '../development/contracts.js';
import { developmentSandboxPolicyVersion } from '../development/sandbox-policy.js';
import { executionResolver } from '../mastra/workflows/development-team.js';
import { usedTechnicalAttempts } from '../development/v2/recovery-policy.js';
import { collectConfirmedDecisions } from './contracts.js';

import { migrationReferenceSchema, migrationLineageSchema } from './migration-contracts.js';
type MigrationWorkflow = ReturnType<Mastra['getWorkflow']>;

/** 先核对稳定原生快照和候选，再给出可审查的迁移计划。 */
export async function prepareRunMigration(workflow: MigrationWorkflow, config: PracticeConfig, sourceRunId: string) {
  z.uuid().parse(sourceRunId);
  const snapshot = await workflow.getWorkflowRunById(sourceRunId);
  if (!snapshot || !['suspended', 'failed', 'success'].includes(snapshot.status)) throw new Error('历史 Run 尚未处于可核验状态');
  const selected = snapshotProjectConfig(config, snapshot);
  const states = Object.values(snapshot.steps ?? {}).flatMap(step => {
    if (Array.isArray(step)) return [];
    const payload = step.payload as any;
    const state = stateV2Schema.safeParse(payload?.development ?? payload?.state ?? payload);
    return state.success ? [state.data] : [];
  }).sort((left, right) => right.calls - left.calls || right.round - left.round);
  const state = states[0];
  if (!state || state.mode !== config.mode || state.executionIdentity.sandboxPolicy === developmentSandboxPolicyVersion) throw new Error('历史 Run 没有需要迁移的 Sandbox 身份');
  const product = Object.values(snapshot.steps ?? {}).flatMap(step => {
    if (Array.isArray(step) || step.status !== 'success') return [];
    const result = deliverySchema.safeParse(step.output);
    return result.success && result.data.artifacts.some(artifact => artifact.stage === 'product' && artifact.hash === state.input.source.hash && artifact.content === state.input.source.content)
      && result.data.reviews.some(review => review.role === 'product' && review.decision === 'approve' && review.artifactHash === state.input.source.hash) ? [result.data] : [];
  }).at(-1);
  if (!product) throw new Error('历史 Run 缺少可核验的当前产品批准');
  const execution = executionResolver(selected, { requireExisting: true })(state.input);
  try { if (developmentHash(await execution.snapshot()) !== state.checkpointHash) throw new Error('历史候选检查点漂移'); }
  finally { await execution.close(); }
  const budget = {
    calls: state.calls, maxCalls: state.maxCalls,
    ...(state.technicalRecovery ? { technical: { version: 'technical-recovery.v1' as const, limit: state.technicalRecovery.limit, priorAttempts: usedTechnicalAttempts(state.technicalRecovery) } } : {}),
  };
  const plan = {
    version: 'run-migration.v1' as const, sourceRunId,
    projectId: product.correlation?.projectId ?? 'hrm',
    iterationId: product.correlation?.iterationId ?? 'unassigned',
    checkpointHash: state.checkpointHash, approvedProductHash: state.input.source.hash,
    previousPolicy: state.executionIdentity.sandboxPolicy, currentPolicy: developmentSandboxPolicyVersion,
    strategy: 'restart-with-approvals' as const, budget,
    sourceVersion: developmentHash({ status: snapshot.status, state, product }),
  };
  return { plan: { ...plan, hash: developmentHash(plan) }, product };
}

/** 初始化再次重读来源，确认令牌不能替代当前原生事实或候选校验。 */
export async function resolveRunMigration(workflow: MigrationWorkflow, config: PracticeConfig, value: z.infer<typeof migrationReferenceSchema>) {
  const reference = migrationReferenceSchema.parse(value);
  const { plan, product } = await prepareRunMigration(workflow, config, reference.sourceRunId);
  if (plan.hash !== reference.planHash) throw new Error('历史 Run 迁移计划已变化');
  const lineage = migrationLineageSchema.parse({ ...reference, version: plan.version, checkpointHash: plan.checkpointHash, approvedProductHash: plan.approvedProductHash, previousPolicy: plan.previousPolicy, currentPolicy: plan.currentPolicy, budget: plan.budget });
  const files = {
    ...product.productSources,
    'migration/approved-product.md': product.artifacts.find(artifact => artifact.hash === plan.approvedProductHash)!.content,
    ...(product.intake ? { 'migration/confirmed-decisions.json': JSON.stringify(collectConfirmedDecisions(product.intake)) } : {}),
  };
  return { lineage, product, files };
}
