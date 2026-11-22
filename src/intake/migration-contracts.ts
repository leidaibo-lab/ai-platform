/** 迁移确认与原生 Store 谱系契约，缺省字段兼容历史 Run。 */
import { z } from 'zod';

export const migrationReferenceSchema = z.object({ sourceRunId: z.uuid(), planHash: z.string().regex(/^[a-f0-9]{64}$/), reviewer: z.string().trim().min(1).max(100) }).strict();
export const migrationLineageSchema = migrationReferenceSchema.extend({
  version: z.literal('run-migration.v1'), checkpointHash: z.string().length(64), approvedProductHash: z.string().length(64),
  previousPolicy: z.string().optional(), currentPolicy: z.string(),
  budget: z.object({ calls: z.number().int().nonnegative(), maxCalls: z.number().int().positive(), technical: z.object({ version: z.literal('technical-recovery.v1'), limit: z.number().int().min(0).max(72), priorAttempts: z.number().int().min(0).max(72) }).optional() }),
});
