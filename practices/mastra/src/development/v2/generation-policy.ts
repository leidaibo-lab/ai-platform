/** 原生 prepareStep 策略：保留有界调用，为只读角色预留最后一步交付结果。 */
import type { AgentExecutionOptions } from '@mastra/core/agent';
import type { RoleV2 } from './contracts.js';

export const developmentMaxSteps = 12;

/** 不裁剪消息或伪造读取事实；未核实范围必须保留，后续校验和审批仍生效。 */
export function developmentPrepareStep(role: RoleV2): NonNullable<AgentExecutionOptions['prepareStep']> {
  // 仅结构化只读角色收束输出，实现角色仍需真实执行其批准工具。
  return ({ stepNumber, messageList }) => {
    if (!['context', 'architect', 'readiness', 'reviewer'].includes(role) || stepNumber < developmentMaxSteps - 1) return;
    messageList.addSystem('这是本次角色调用的最后一步。根据已经实际读取的证据提交最终JSON，不再调用工具；不能把未读取范围声称为已核实。上下文缺口写入unknowns；方案缺口写入blockers；评估未核实范围写入unchecked并据实判定，不能用PASS隐藏缺口。', 'development-final-step');
    return { toolChoice: 'none' };
  };
}
