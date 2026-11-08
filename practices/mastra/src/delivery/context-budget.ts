/** 资料预算是有界本地策略，不代表上游模型精确token容量。 */
import { z } from 'zod';
import { materialPolicy } from '../../config/material-policy.js';
// 等级和倍率属于历史恢复契约；更改需要同时迁移审批Schema，不能只改配置。
const budgetPolicy = Object.freeze(z.object({ maxLevel: z.literal(4), multiplier: z.literal(2), inlineBytes: z.number().int().positive(), materialBytes: z.number().int().positive(), readChars: z.number().int().min(2).max(6000), readBytes: z.number().int().positive(), providerBytes: z.number().int().positive() }).strict().refine(
  /** 初始目录及单项折叠阈值必须在模型消息预算内。 */
  value => value.materialBytes <= value.inlineBytes && value.inlineBytes <= value.providerBytes,
  '资料预算配置层级无效',
).parse(materialPolicy.budget));
export const maxContextBudgetLevel = budgetPolicy.maxLevel;
export const contextBudgetFailureSchema = z.object({ resource: z.enum(['read', 'provider', 'catalog']), usedBytes: z.number().int().nonnegative(), limitBytes: z.number().int().positive() });
export type ContextBudgetFailure = z.infer<typeof contextBudgetFailureSchema>;
/** 只携带字节计量，不把材料正文或SDK原异常写入故障事实。 */
export class ContextBudgetError extends Error {
  readonly budget: ContextBudgetFailure;
  /** 由实际触限边界报告请求后的字节量与当前上限。 */
  constructor(resource: ContextBudgetFailure['resource'], usedBytes: number, limitBytes: number) {
    super('当前阶段资料预算不足，需要确认后继续'); this.name = 'ContextBudgetError';
    this.budget = contextBudgetFailureSchema.parse({ resource, usedBytes, limitBytes });
  }
}
/** 每级翻倍且只提高体积，不扩大文件、工具、写入或审批权限。 */
export function contextBudgetLimits(level = 0) {
  z.number().int().min(0).max(maxContextBudgetLevel).parse(level);
  const base = budgetPolicy; const factor = base.multiplier ** level;
  return { inlineBytes: base.inlineBytes * factor, materialBytes: base.materialBytes, readChars: base.readChars, readBytes: base.readBytes * factor, providerBytes: base.providerBytes * factor };
}
