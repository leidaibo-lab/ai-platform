/** 项目关联只标识资产归属，不承载审批或运行状态。 */
import { z } from 'zod';

export const assetIdSchema = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,99}$/);
export const formalSpecificationPathPattern = /^(?:specs\/[a-z0-9-]+\.(?:md|json)|product\/[a-zA-Z0-9][a-zA-Z0-9_-]{0,99}\/(?:requirements|product-spec)\.md)$/;
export const projectIdSchema = z.string().regex(/^[a-z][a-z0-9-]{0,39}$/);
export const correlationSchema = z.object({ projectId: projectIdSchema, engineeringBinding: z.string().regex(/^[a-f0-9]{64}$/).optional(), engineeringRevision: z.string().regex(/^[a-f0-9]{40}$/).optional(), adapterId: z.enum(['node-test.v1', 'python-unittest.v1']).optional(), adapterProfileVersion: z.literal('adapter-profile.v2').optional(), adapterProfileHash: z.string().regex(/^[a-f0-9]{64}$/).optional(), iterationId: assetIdSchema, runId: z.string().regex(/^[a-zA-Z0-9_-]{1,200}$/), workflowId: z.literal('productDevelopmentWorkflow') });
export type AssetCorrelation = z.infer<typeof correlationSchema>;
