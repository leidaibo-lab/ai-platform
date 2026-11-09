/** 历史预算证据的只读格式化，不产生新的额度或恢复门槛。 */
import { type ContextBudgetFailure } from './context-budget.js';

const resources: Record<ContextBudgetFailure['resource'], string> = {
  read: '资料读取', provider: '发送给模型的上下文', catalog: '资料目录',
};

/** 仅格式化通过边界 Schema 校验的计量；不读取资料正文或推断模型 token 数。 */
export function describeContextBudgetUsage(budget: ContextBudgetFailure): string {
  return `触限项：${resources[budget.resource]}，已用 ${(budget.usedBytes / 1024).toFixed(1)} KiB / 上限 ${(budget.limitBytes / 1024).toFixed(1)} KiB`;
}
