/** 历史资料预算快照兼容层；新调用不再生成资料预算故障或使用档位门槛。 */
import { z } from 'zod';
export const maxContextBudgetLevel = 4;
export const contextBudgetFailureSchema = z.object({ resource: z.enum(['read', 'provider', 'catalog']), usedBytes: z.number().int().nonnegative(), limitBytes: z.number().int().positive() });
export type ContextBudgetFailure = z.infer<typeof contextBudgetFailureSchema>;
/** 只携带字节计量，不把材料正文或SDK原异常写入故障事实。 */
export class ContextBudgetError extends Error {
  readonly budget: ContextBudgetFailure;
  /** 由实际触限边界报告请求后的字节量与当前上限。 */
  constructor(resource: ContextBudgetFailure['resource'], usedBytes: number, limitBytes: number) {
    super('历史资料预算限制中断了执行'); this.name = 'ContextBudgetError';
    this.budget = contextBudgetFailureSchema.parse({ resource, usedBytes, limitBytes });
  }
}
