import { deliverySchema } from '../mastra/workflows/delivery.js';
import { stateV2Schema } from '../development/v2/contracts.js';
import { deliveryAttemptSchema, lifecycleSchema } from '../delivery/contracts.js';
import { z } from 'zod';

/** 从各原生专业状态派生团队预算视图，只返回版本、计量和结果。 */
export function projectTeamRunViews(snapshot: { steps?: Record<string, unknown>; result?: unknown }) {
  const views = new Map<string, { team: string; policyVersion?: string; used: number; limit?: number; status: string; inputVersion?: string }>();
  const entries = Object.values(snapshot.steps ?? {}).filter((entry): entry is Record<string, unknown> => !!entry && typeof entry === 'object' && !Array.isArray(entry));
  const values = [...entries.flatMap(entry => [entry.payload, entry.output]), snapshot.result];
  for (const value of values) {
    const product = deliverySchema.safeParse(value);
    if (product.success && product.data.productQualityReview?.loop) {
      const review = product.data.productQualityReview;
      views.set('product', { team: 'product', policyVersion: product.data.teamRunPolicy?.product.quality?.version, used: review.loop!.repairs, limit: product.data.teamRunPolicy?.product.quality?.maxRepairs, status: review.loop!.status, inputVersion: review.productHash });
    }
    const lifecycle = lifecycleSchema.safeParse(value);
    const development = stateV2Schema.safeParse(lifecycle.success ? lifecycle.data.development : value);
    if (!development.success) continue;
    const state = development.data;
    const prior = views.get('development');
    if (!prior || prior.used <= state.calls) views.set('development', { team: 'development', policyVersion: state.input.teamRunPolicy?.development?.version, used: state.calls, limit: state.maxCalls, status: state.stopReason ?? state.outcome, inputVersion: state.checkpointHash });
    if (lifecycle.success) {
      const testPrior = views.get('testing');
      if (!testPrior || testPrior.used <= (state.verificationHistory?.length ?? 0)) views.set('testing', { team: 'testing', policyVersion: state.input.teamRunPolicy?.testing?.version, used: state.verificationHistory?.length ?? 0, limit: state.input.autonomy?.maxCheckRuns, status: lifecycle.data.quality.status, inputVersion: state.checkpointHash });
      if (lifecycle.data.deliveryAttempts?.length) views.set('delivery', { team: 'delivery', policyVersion: state.input.teamRunPolicy?.delivery?.version, used: lifecycle.data.deliveryAttempts.length, status: lifecycle.data.deliveryAttempts.at(-1)!.outcome, inputVersion: state.checkpointHash });
    }
  }
  for (const entry of entries) {
    const attempts = z.object({ attempts: z.array(deliveryAttemptSchema) }).safeParse(entry.suspendPayload);
    if (entry.status === 'suspended' && attempts.success && attempts.data.attempts.length) views.set('delivery', { team: 'delivery', policyVersion: 'delivery-retry.v1', used: attempts.data.attempts.length, status: attempts.data.attempts.at(-1)!.outcome, inputVersion: attempts.data.attempts.at(-1)!.sourceHash });
  }
  return [...views.values()];
}
