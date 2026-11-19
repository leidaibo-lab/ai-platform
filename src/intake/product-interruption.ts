import { createInterruptibleAttempts } from '../mastra/platform/interruptible-attempts.js';
import { z } from 'zod';
import { intakeSchema } from './contracts.js';

export const correctionRequestSchema = z.object({
  attempt: z.uuid(),
  reviewer: z.string().trim().min(1).max(100),
  feedback: z.string().trim().min(1).max(2000),
}).strict();
export const correctionPauseSchema = correctionRequestSchema.extend({ kind: z.literal('product-correction'), intake: intakeSchema.optional() });
type Correction = z.infer<typeof correctionPauseSchema>;

const attempts = createInterruptibleAttempts<Correction>((previous, next) =>
  previous.feedback === next.feedback && previous.reviewer === next.reviewer);

/** 投影当前产品尝试的操作能力。 */
export const productCorrectionCapability = attempts.capability;

/** 将通过校验的人工反馈传给正在执行的尝试。 */
export function interruptProductAttempt(runId: string, request: z.infer<typeof correctionRequestSchema>) {
  return attempts.interrupt(runId, request.attempt, { kind: 'product-correction', ...request });
}

/** 交还纠偏内容给产品步骤保存原生暂停点。 */
export async function runInterruptibleProductAttempt<T>(runId: string, workflowSignal: AbortSignal, supported: boolean, execute: (signal: AbortSignal) => Promise<T>) {
  const result = await attempts.run(runId, workflowSignal, supported, execute);
  return result.interruption ? { correction: result.interruption } : { output: result.output };
}
