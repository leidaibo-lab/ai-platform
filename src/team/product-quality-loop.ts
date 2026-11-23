import { createHash } from 'node:crypto';
import { z } from 'zod';
import { readProductDocuments, validateProductDraftPresentation } from '../business-engineering/product-documents.js';

const hash = z.string().regex(/^[a-f0-9]{64}$/);
export const productFindingSchema = z.object({
  id: z.string().regex(/^[A-Z0-9-]{1,80}$/),
  productHash: hash,
  detail: z.string().trim().min(1).max(2000),
  quote: z.string().trim().min(1).max(2000),
  action: z.enum(['repair', 'business-decision']),
}).strict();
export const productAssessmentSchema = z.object({
  productHash: hash,
  summary: z.string().trim().min(1).max(4000),
  findings: z.array(productFindingSchema).max(20),
}).strict();
export const productFindingVerificationSchema = z.object({
  productHash: hash,
  decisions: z.array(z.object({ id: z.string(), decision: z.enum(['confirmed', 'false-positive', 'business-decision']), reason: z.string().trim().min(1).max(2000) }).strict()).max(20),
}).strict();
export const productQualityRoundSchema = z.object({
  productHash: hash, content: z.string().max(100000),
  assessment: productAssessmentSchema,
  verification: productFindingVerificationSchema,
});
export const productQualityCheckpointSchema = z.object({
  version: z.literal('product-quality-checkpoint.v1'),
  content: z.string().max(100000), productHash: hash,
  rounds: z.array(productQualityRoundSchema).max(3),
  repairs: z.number().int().min(0).max(2),
});
export type ProductQualityCheckpoint = z.infer<typeof productQualityCheckpointSchema>;
export type ProductAssessment = z.infer<typeof productAssessmentSchema>;
export type ProductFindingVerification = z.infer<typeof productFindingVerificationSchema>;

/** 发现逐项绑定正文，缺失判断也须引用相邻规则，禁止无依据断言。 */
export function validateProductAssessment(content: string, productHash: string, value: unknown) {
  const assessment = productAssessmentSchema.parse(value);
  if (assessment.productHash !== productHash) throw new Error('产品审查版本不一致');
  if (new Set(assessment.findings.map(item => item.id)).size !== assessment.findings.length) throw new Error('产品审查发现 ID 重复');
  for (const finding of assessment.findings) {
    if (finding.productHash !== productHash || !content.includes(finding.quote)) throw new Error('产品审查发现缺少当前版本正文证据');
  }
  return assessment;
}

/** 核验必须覆盖全部发现，误报与业务升级均保留理由。 */
export function validateProductFindingVerification(assessment: ProductAssessment, value: unknown) {
  const verification = productFindingVerificationSchema.parse(value);
  if (verification.productHash !== assessment.productHash || verification.decisions.length !== assessment.findings.length
    || new Set(verification.decisions.map(item => item.id)).size !== verification.decisions.length
    || verification.decisions.some(item => !assessment.findings.some(finding => finding.id === item.id))) throw new Error('产品发现核验未覆盖同版本全部发现');
  return verification;
}

/** 执行有界审查、逐项核验、写作及完整复验；调用方负责原生步骤持久化。 */
export async function runProductQualityLoop(input: { content: string; hash: string; maxRepairs: number; checkpoint?: ProductQualityCheckpoint }, ports: {
  review(content: string, hash: string): Promise<unknown>;
  verify(content: string, assessment: ProductAssessment): Promise<unknown>;
  repair(content: string, assessment: ProductAssessment, verification: ProductFindingVerification): Promise<string>;
}) {
  if (!Number.isInteger(input.maxRepairs) || input.maxRepairs < 0 || input.maxRepairs > 2) throw new Error('产品复审预算无效');
  const saved = input.checkpoint ? productQualityCheckpointSchema.parse(input.checkpoint) : undefined;
  if (saved && (saved.rounds[0]?.productHash ?? saved.productHash) !== input.hash) throw new Error('产品复审检查点来源不一致');
  if (saved && saved.repairs > input.maxRepairs) throw new Error('产品复审检查点预算漂移');
  let content = saved?.content ?? input.content;
  let productHash = saved?.productHash ?? input.hash;
  let repairs = saved?.repairs ?? 0;
  const rounds: z.infer<typeof productQualityRoundSchema>[] = [...(saved?.rounds ?? [])];
  const seen = new Set([input.content, ...rounds.map(item => item.content)].map(text => createHash('sha256').update(text).digest('hex')));
  try {
    for (;;) {
      const prior = rounds.at(-1);
      const assessment = prior?.productHash === productHash ? prior.assessment : validateProductAssessment(content, productHash, await ports.review(content, productHash));
      const verification = prior?.productHash === productHash ? prior.verification : validateProductFindingVerification(assessment, await ports.verify(content, assessment));
      if (prior?.productHash !== productHash) rounds.push({ productHash, content, assessment, verification });
      const confirmed = verification.decisions.filter(item => item.decision !== 'false-positive');
      const business = confirmed.some(item => item.decision === 'business-decision' || assessment.findings.find(finding => finding.id === item.id)?.action === 'business-decision');
      if (business) return { content, productHash, rounds, repairs, status: 'business-decision' as const };
      if (!confirmed.length) return { content, productHash, rounds, repairs, status: 'passed' as const };
      if (repairs >= input.maxRepairs) return { content, productHash, rounds, repairs, status: 'repair-budget' as const };
      repairs++;
      const candidate = await ports.repair(content, assessment, verification);
      validateProductDraftPresentation(candidate); readProductDocuments(candidate);
      const candidateHash = createHash('sha256').update(candidate).digest('hex');
      if (seen.has(candidateHash)) return { content, productHash, rounds, repairs, status: 'no-progress' as const };
      seen.add(candidateHash);
      productHash = createHash('sha256').update(JSON.stringify({ parent: productHash, candidate, assessment, verification })).digest('hex');
      content = candidate;
    }
  } catch (error) {
    if (error instanceof Error) Object.assign(error, { productQualityCheckpoint: { version: 'product-quality-checkpoint.v1', content, productHash, rounds, repairs } });
    throw error;
  }
}
