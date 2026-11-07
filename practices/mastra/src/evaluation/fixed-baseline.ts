/** 固定开发基线的原生证据评分；只评价已有执行事实，不伪装为重新执行或人工批准。 */
import { createScorer } from '@mastra/core/evals';
import { z } from 'zod';

export const baselineEvidenceSchema = z.object({ caseId: z.string(), mode: z.literal('live'), runId: z.string().min(1), status: z.string(), outcome: z.string().nullable(), hiddenPassed: z.boolean().nullable(), assertions: z.number().int().nonnegative(), blockers: z.array(z.string()), failure: z.string().nullable(), manualReview: z.null() });
export const baselineExpectedSchema = z.object({ expectedOutcome: z.enum(['deliverable', 'clarification-required']), assertions: z.number().int().nonnegative(), blockerKeywords: z.array(z.array(z.string())) });

/** 歧义必须给出预登记的具体阻塞原因；交付必须由隐藏断言证明，不用模型自述判通过。 */
export function baselineEvidencePassed(output: unknown, groundTruth: unknown): boolean {
  const evidence = baselineEvidenceSchema.safeParse(output);
  const expected = baselineExpectedSchema.safeParse(groundTruth);
  if (!evidence.success || !expected.success || evidence.data.status !== 'generated' || evidence.data.failure) return false;
  const value = evidence.data;
  if (expected.data.expectedOutcome === 'deliverable') return value.outcome === 'development-delivered' && value.hiddenPassed === true && value.assertions > 0 && value.assertions === expected.data.assertions;
  if (value.outcome !== 'clarification-required' || !value.blockers.length || !expected.data.blockerKeywords.length) return false;
  const text = value.blockers.join('\n');
  for (const group of expected.data.blockerKeywords) {
    let found = false;
    for (const term of group) if (text.includes(term)) found = true;
    if (!found) return false;
  }
  return true;
}

/** 注册证据评分供Studio查看；导入成功与能力验收分开记录。 */
export function createBaselineScorer() {
  return createScorer({ id: 'fixed-development-evidence-v1', name: '固定开发执行证据 v1', description: '历史真实运行的隐藏断言或具体阻塞证据；不代表独立人评通过。' })
    // 只消费导入的实际执行证据和冻结预期。
    .generateScore(({ run }) => baselineEvidencePassed(run.output, run.groundTruth) ? 1 : 0)
    // 在原生评分中明确证据来源与未完成人评的边界。
    .generateReason(({ run }) => JSON.stringify({ passed: baselineEvidencePassed(run.output, run.groundTruth), authority: 'imported-live-run-evidence', manualReview: null, limitation: run.groundTruth?.expectedOutcome === 'clarification-required' && !run.groundTruth?.blockerKeywords?.length ? '冻结资产没有阻塞关键词基准；不自动判语义通过，需按原manualCriteria审查' : null }));
}
