import { createHash } from 'node:crypto';
import { z } from 'zod';
import { assetIdSchema, projectIdSchema } from '../delivery/asset-identity.js';

export const independentTeamIdSchema = z.enum(['product', 'development', 'testing', 'delivery']);
const sourceWorkflowSchema = z.enum(['product-development', 'independent-product', 'independent-development', 'independent-testing']);
const sourceRunIdSchema = z.string().uuid();

const runSourceSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('new-requirement') }).strict(),
  z.object({ kind: z.literal('approved-product'), runId: sourceRunIdSchema, workflowId: sourceWorkflowSchema.default('product-development'), artifact: z.literal('approved-product') }).strict(),
  z.object({ kind: z.literal('development-delivery'), runId: sourceRunIdSchema, workflowId: sourceWorkflowSchema.default('product-development'), artifact: z.literal('development-delivery') }).strict(),
  z.object({ kind: z.literal('quality-passed'), runId: sourceRunIdSchema, workflowId: sourceWorkflowSchema.default('product-development'), artifact: z.literal('quality-passed') }).strict(),
  z.object({ kind: z.literal('prepared-input'), packageId: sourceRunIdSchema }).strict(),
]);

const teamPayloadSchema = z.discriminatedUnion('teamId', [
  z.object({ teamId: z.literal('product'), brief: z.string().trim().min(1).max(12000), intakeMode: z.enum(['clarify', 'autofill']).default('clarify') }).strict(),
  z.object({ teamId: z.literal('development'), authorization: z.object({ reviewer: z.string().trim().min(1).max(100), comment: z.string().trim().min(1).max(2000), maxReworks: z.number().int().min(0).max(3).default(1) }).strict() }).strict(),
  z.object({ teamId: z.literal('testing'), testIntent: z.string().trim().max(12000).optional() }).strict(),
  z.object({ teamId: z.literal('delivery') }).strict(),
]);

/** 独立团队入口的规范输入；只接受来源引用，不接受来源正文和审批事实。 */
export const independentTeamRunInputSchema = z.object({
  version: z.literal('team-run-input.v1'),
  teamId: independentTeamIdSchema,
  projectId: projectIdSchema,
  iterationId: assetIdSchema.default('unassigned'),
  source: runSourceSchema,
  payload: teamPayloadSchema,
}).strict().superRefine((input, context) => {
  /** 团队阶段只允许消费它能够验证的上游来源。 */
  const allowed: Record<z.infer<typeof independentTeamIdSchema>, string[]> = {
    product: ['new-requirement', 'prepared-input'],
    development: ['approved-product', 'prepared-input'],
    testing: ['development-delivery', 'prepared-input'],
    delivery: ['quality-passed'],
  };
  if (!allowed[input.teamId].includes(input.source.kind)) context.addIssue({ code: 'custom', path: ['source'], message: '来源类型与目标团队不匹配' });
  if (input.payload.teamId !== input.teamId) context.addIssue({ code: 'custom', path: ['payload', 'teamId'], message: '团队载荷与目标团队不匹配' });
  if ('workflowId' in input.source) {
    const expected: Record<string, string> = { 'approved-product': 'independent-product', 'development-delivery': 'independent-development', 'quality-passed': 'independent-testing' };
    if (input.source.workflowId !== 'product-development' && input.source.workflowId !== expected[input.source.kind]) {
      context.addIssue({ code: 'custom', path: ['source', 'workflowId'], message: '来源 Workflow 与产物类型不匹配' });
    }
  }
  if (input.source.kind === 'prepared-input' && input.teamId === 'delivery') context.addIssue({ code: 'custom', path: ['source'], message: '交付团队必须消费已通过质量门的来源 Run' });
});

export type IndependentTeamRunInput = z.infer<typeof independentTeamRunInputSchema>;

/** 校验并冻结可审计的规范输入散列，散列不替代来源内容的服务端解析。 */
export function normalizeIndependentTeamRunInput(input: unknown) {
  const value = independentTeamRunInputSchema.parse(input);
  const canonical = JSON.stringify(value);
  return { input: value, inputHash: createHash('sha256').update(canonical).digest('hex') };
}
