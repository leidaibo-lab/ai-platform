import type { InputV2 } from '../development/v2/contracts.js';
import type { Delivery } from '../mastra/workflows/delivery.js';

/** 只投影由开发团队入口验证并绑定同一产品版本的审批事实。 */
export function developmentProductApproval(input: InputV2, phase?: string) {
  if (input.source.kind !== 'approved-product' || input.source.workflowId !== 'product-development' || input.scopeApproval?.productHash !== input.source.hash) return undefined;
  return { status: 'approved' as const, productHash: input.source.hash, authority: 'workflow', note: '产品正文的审批状态描述来自成稿时点；当前审批以此版本绑定的 Workflow 事实为准。产品批准不等于技术方案批准、测试完成或部署完成。', ...(['prepare-context', 'architecture', 'assess-readiness'].includes(phase ?? '') ? { nextGate: '当前处于技术方案独立审批之前；方案生成和就绪审查完成后才进入审批。就绪审查评估方案是否适合提交审批，并不授予实施权限；尚未发生的方案审批不是生成或审查方案的业务阻塞，审批前不得实施。' } : {}) };
}

/** 仅投影 Workflow 中与开发当前产品版本一致的实际批准。 */
export function blockerProductApproval(delivery: Delivery, productHash: string) {
  const artifact = delivery.artifacts.find(/** 精确匹配产品版本。 */item => item.stage === 'product' && item.hash === productHash);
  const review = delivery.reviews.find(/** 只接受该版本真实批准。 */item => item.role === 'product' && item.artifactHash === productHash && item.decision === 'approve');
  if (!artifact || !review) return undefined;
  return { status: 'approved' as const, productHash, authority: 'workflow', note: '产品正文的待审批或未执行文字是成稿时的历史描述；当前产品版本已获批准，技术方案审批及后续执行仍以各自 Workflow 事实为准。' };
}
