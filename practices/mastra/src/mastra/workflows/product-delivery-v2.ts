/** 执行模式产品交接：复用四角色，产品批准后结束，不进入旧下游提案链。 */
import { createStep, createWorkflow } from '@mastra/core/workflows';
import { z } from 'zod';
import type { createAgents } from '../agents/index.js';
import { createProductWorkflow } from './product.js';
import { deliveryInputSchema, deliverySchema, pendingSchema, reviewSchema, validateReview, type Delivery } from './delivery.js';

export const productDeliveryV2Schema = deliverySchema.omit({ outcome: true }).extend({ workflowId: z.literal('product-delivery-v2'), outcome: z.enum(['product-approved-for-development', 'rejected', 'rework-requested']) });

/** 原生暂停点保存产品版本；显式服务验证后才能另启开发Run。 */
export function createProductDeliveryV2(agents: ReturnType<typeof createAgents>, mode: Delivery['mode']) {
  const initialize = createStep({ id: 'initialize', inputSchema: deliveryInputSchema, outputSchema: deliverySchema,
    // 模式与批准记录由宿主初始化，客户端不能传入。
    execute: async ({ inputData }) => ({ ...inputData, mode, artifacts: [], reviews: [], outcome: 'in-progress' as const }),
  });
  const review = createStep({ id: 'review-product', inputSchema: deliverySchema, outputSchema: deliverySchema, suspendSchema: pendingSchema, resumeSchema: reviewSchema,
    // 每份批准必须匹配当前产物，拒绝/返工保留终态供新Run溯源。
    execute: async ({ inputData, resumeData, suspend }) => {
      if (inputData.mode !== mode) throw new Error('产品v2不能跨模式继续');
      const pending = pendingSchema.parse({ role: 'product', artifact: inputData.artifacts.at(-1), productReworkRound: inputData.productRework?.round ?? 0 });
      if (!resumeData) return suspend(pending);
      const decision = validateReview(pending, resumeData);
      return { ...inputData, reviews: [...inputData.reviews, decision], outcome: decision.decision === 'reject' ? 'rejected' as const : decision.decision === 'rework' ? 'rework-requested' as const : 'in-progress' as const };
    },
  });
  const finish = createStep({ id: 'product-approved-for-development', inputSchema: deliverySchema, outputSchema: productDeliveryV2Schema,
    // 产品终态只说明当前版本批准交接，不声明代码已经执行。
    execute: async ({ inputData }) => ({ ...inputData, workflowId: 'product-delivery-v2' as const, outcome: inputData.outcome === 'in-progress' ? 'product-approved-for-development' as const : inputData.outcome === 'rejected' ? 'rejected' as const : 'rework-requested' as const }),
  });
  return createWorkflow({ id: 'product-delivery-v2', inputSchema: deliveryInputSchema, outputSchema: productDeliveryV2Schema }).then(initialize).then(createProductWorkflow(agents, mode, deliverySchema)).then(review).then(finish).commit();
}
