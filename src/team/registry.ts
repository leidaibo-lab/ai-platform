import { z } from 'zod';
import { independentTeamIdSchema } from './independent-run-input.js';

/** 团队插件元数据；执行仍由已登记的 Mastra Workflow 工厂装配。 */
export const teamPlugins = [
  { teamId: 'product', title: '产品团队', workflowId: 'independent-product', sources: ['new-requirement', 'prepared-input'], artifact: 'approved-product' },
  { teamId: 'development', title: '研发团队', workflowId: 'independent-development', sources: ['approved-product', 'prepared-input'], artifact: 'development-delivery' },
  { teamId: 'testing', title: '测试团队', workflowId: 'independent-testing', sources: ['development-delivery', 'prepared-input'], artifact: 'quality-passed' },
  { teamId: 'delivery', title: '交付团队', workflowId: 'independent-delivery', sources: ['quality-passed'], artifact: 'merge-request' },
] as const;

/** 只允许登记团队，调用方不能指定模块路径或任意 Workflow。 */
export function teamPlugin(teamId: unknown) {
  const id = independentTeamIdSchema.parse(teamId);
  return teamPlugins.find(plugin => plugin.teamId === id)!;
}

/** 来源 Workflow 使用白名单标识，历史主流程保持默认来源。 */
export const sourceWorkflowSchema = z.enum(['product-development', 'independent-product', 'independent-development', 'independent-testing']);
