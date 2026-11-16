import { z } from 'zod';

/** 产品修订来源契约；修订内容作为当前产品团队 Run 的输入事实，不创建独立产品 Workflow。 */
export const revisionSourceSchema = z
  .object({
    sourceRunId: z.string().min(1).max(200),
    sourceHash: z.string().regex(/^[a-f0-9]{64}$/),
    proposalId: z.string().min(1).max(200),
    confirmedDecisions: z.string().trim().min(1).max(8000),
    appliedBy: z.string().trim().min(1).max(100),
    content: z.string().trim().min(1).max(100000),
  })
  .strict();
