/** 项目关联只标识资产归属，不承载审批或运行状态。 */
import { z } from 'zod';

export const assetIdSchema = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,99}$/);
export const correlationSchema = z.object({ projectId: z.literal('hrm'), iterationId: assetIdSchema, runId: z.string().regex(/^[a-zA-Z0-9_-]{1,200}$/), workflowId: z.literal('productDevelopmentWorkflow') });
export type AssetCorrelation = z.infer<typeof correlationSchema>;
