/** 平台 Team Loop 公共契约；仅投影专业状态，不拥有运行事实。
 * ADR: docs/decisions/2026-11-21-unified-team-loop-and-project-adapters.md
 */
import { z } from 'zod';
import { findingSchema } from '../development/v2/contracts.js';

const hash = z.string().regex(/^[a-f0-9]{64}$/);
export const teamIdSchema = z.enum(['product', 'development', 'testing', 'delivery']);
export const teamStopReasonSchema = z.enum(['completed', 'business-decision', 'authorization-required', 'repair-budget', 'verification-budget', 'no-progress', 'integrity']);

/** 团队状态的版本化只读投影；预算和证据都来自现有专业状态。 */
export const teamRunEnvelopeSchema = z.object({
  version: z.literal('team-run-envelope.v1'),
  teamId: teamIdSchema,
  status: z.enum(['pending', 'running', 'rework', 'blocked', 'completed', 'stopped']),
  phase: z.string().trim().min(1).max(100),
  inputVersion: z.string().trim().min(1).max(100),
  budget: z.object({ used: z.number().int().nonnegative(), limit: z.number().int().nonnegative() }),
  evidence: z.array(z.string().trim().min(1).max(300)).max(200),
  blocker: z.object({ kind: z.enum(['business', 'authorization', 'integrity', 'budget', 'no-progress']), detail: z.string().trim().min(1).max(2000) }).optional(),
  stopReason: teamStopReasonSchema.optional(),
}).strict();
export type TeamRunEnvelope = z.infer<typeof teamRunEnvelopeSchema>;

/** 测试到研发的唯一返工交接；不得携带研发 phase、plan 或 outcome 补丁。 */
export const reworkRequestSchema = z.object({
  version: z.literal('rework-request.v1'),
  sourceTeam: z.literal('testing'),
  targetTeam: z.literal('development'),
  targetStateVersion: z.literal('development-state.v2'),
  targetCheckpointHash: hash,
  sourceReportHash: hash,
  findings: z.array(findingSchema).min(1).max(30),
  evidenceRefs: z.array(z.string().trim().min(1).max(300)).min(1).max(200),
  acceptanceCases: z.array(z.object({ id: z.string().trim().min(1).max(100), requirementRefs: z.array(z.string().trim().min(1)).min(1) })).max(100).optional(),
}).strict();
export type ReworkRequest = z.infer<typeof reworkRequestSchema>;
