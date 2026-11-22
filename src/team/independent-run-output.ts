import { z } from 'zod';
import { correlationSchema } from '../delivery/asset-identity.js';
import { deliverySchema } from '../mastra/workflows/delivery.js';
import { stateV2Schema } from '../development/v2/contracts.js';
import { lifecycleSchema } from '../delivery/contracts.js';
import { developmentHash } from '../development/contracts.js';
import { developmentEnvelope } from '../development/rework-port.js';
import { teamRunEnvelopeSchema } from './contracts.js';
import { independentTeamIdSchema } from './independent-run-input.js';

const hash = z.string().regex(/^[a-f0-9]{64}$/);
/** 规范输出保留专业结果；信封只是同一 Store 结果的投影。 */
export const independentTeamRunOutputSchema = z.object({
  version: z.literal('team-run-output.v1'), teamId: independentTeamIdSchema,
  inputHash: hash, sourceHash: hash, correlation: correlationSchema,
  envelope: teamRunEnvelopeSchema,
  result: z.union([deliverySchema, stateV2Schema, lifecycleSchema]),
}).strict().superRefine((value, context) => {
  if (value.envelope.teamId !== value.teamId) context.addIssue({ code: 'custom', message: '输出团队与信封不一致' });
  const schema = value.teamId === 'product' ? deliverySchema : value.teamId === 'development' ? stateV2Schema : lifecycleSchema;
  if (!schema.safeParse(value.result).success) context.addIssue({ code: 'custom', message: '输出专业类型与团队不一致' });
});
export type IndependentTeamRunOutput = z.infer<typeof independentTeamRunOutputSchema>;

/** 由专业结果投影公共状态，fixture 交付显式保留其证据级别。 */
export function completeIndependentTeamRun(teamId: z.infer<typeof independentTeamIdSchema>, binding: { inputHash: string; sourceHash: string; correlation: z.infer<typeof correlationSchema> }, result: unknown): IndependentTeamRunOutput {
  let envelope: z.infer<typeof teamRunEnvelopeSchema>;
  if (teamId === 'development') envelope = developmentEnvelope(stateV2Schema.parse(result));
  else {
    const product = teamId === 'product' ? deliverySchema.parse(result) : undefined;
    const lifecycle = product ? undefined : lifecycleSchema.parse(result);
    const artifact = product?.artifacts.at(-1);
    const completed = product ? product.outcome === 'in-progress' && !!artifact && product.reviews.some(review => review.decision === 'approve' && review.artifactHash === artifact.hash)
      : teamId === 'testing' ? lifecycle!.quality.status === 'passed'
      : ['delivery-confirmed', 'fixture-completed'].includes(lifecycle!.outcome);
    const blocked = product ? product.outcome !== 'rejected' : lifecycle!.outcome === 'blocked';
    envelope = teamRunEnvelopeSchema.parse({ version: 'team-run-envelope.v1', teamId, status: completed ? 'completed' : blocked ? 'blocked' : 'stopped', phase: teamId === 'product' ? 'product-review' : teamId === 'testing' ? 'quality-review' : 'merge-request', inputVersion: 'team-run-input.v1', budget: { used: product?.productRework?.round ?? lifecycle?.qualityHistory.length ?? 0, limit: product ? 3 : lifecycle!.development.input.maxReworks }, evidence: artifact ? [artifact.hash] : [lifecycle!.development.checkpointHash, ...(lifecycle!.quality.reportHash ? [lifecycle!.quality.reportHash] : [])], ...(completed ? { stopReason: 'completed' } : blocked ? { blocker: { kind: 'business', detail: '团队未达到本职交付条件，需要补齐业务决定或输入' }, stopReason: 'business-decision' } : { stopReason: 'authorization-required' }) });
  }
  return independentTeamRunOutputSchema.parse({ version: 'team-run-output.v1', teamId, ...binding, envelope, result });
}

/** 从已校验专业结果计算输出摘要，不包含宿主配置。 */
export function independentOutputHash(output: IndependentTeamRunOutput) { return developmentHash(independentTeamRunOutputSchema.parse(output)); }
