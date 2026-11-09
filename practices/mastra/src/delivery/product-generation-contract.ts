/** 产品生成证据契约：工作流与诊断共同依赖纯 Schema，不反向依赖执行器或展示模块。 */
import { z } from 'zod';
import { contextBudgetFailureSchema } from './context-budget.js';
import { modelFailureSchema } from './model-failure.js';

export const productFailureKindSchema = z.enum(['timeout', 'network', 'upstream', 'incomplete', 'output-limit', 'tool-loop', 'blocked', 'context-budget', 'material-read', 'empty-output', 'unknown']);
export const productFinishReasonSchema = z.enum(['stop', 'length', 'tool-calls', 'content-filter', 'error', 'other', 'unknown', 'tripwire']);
/** 尝试证据只含白名单枚举与计量；预算字段可缺失以兼容历史快照。 */
export const productAttemptSchema = z.object({
  attempt: z.number().int().min(1).max(2), durationMs: z.number().int().nonnegative(), recordedAt: z.iso.datetime(),
  kind: productFailureKindSchema, finishReason: productFinishReasonSchema.optional(), steps: z.number().int().nonnegative().optional(),
  textChars: z.number().int().nonnegative().optional(), budget: contextBudgetFailureSchema.optional(), failure: modelFailureSchema,
});
export const productFailureSchema = z.object({ version: z.literal('product-generation-failure.v1'), attempts: z.array(productAttemptSchema).min(1).max(2) });
/** 已接受生成的最小结束证据；失败尝试可选保存，最多对应一次有界自动重试。 */
export const productGenerationSchema = z.object({ version: z.literal('product-generation.v1'), finishReason: z.literal('stop'), attempts: z.number().int().min(1).max(2), durationMs: z.number().int().nonnegative(), failures: z.array(productAttemptSchema).max(1) });
export type ProductAttempt = z.infer<typeof productAttemptSchema>;
export type ProductFailureKind = z.infer<typeof productFailureKindSchema>;
export type ProductFailureEvidence = z.infer<typeof productFailureSchema>;
