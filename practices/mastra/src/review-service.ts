import { z } from 'zod';
import {
  deliveryStatus,
  reviewDelivery,
  type DeliveryContext,
} from './delivery-service.js';
import { deliverySchema, type Delivery } from './mastra/workflows/delivery.js';

/** 页面使用的只读投影；正文/hash 来自快照，审阅资格每次在服务端重新计算。 */
export interface ProductReviewDocument {
  runId: string;
  brief: string;
  mode: Delivery['mode'];
  status: string;
  outcome: Delivery['outcome'];
  pendingRole?: string;
  artifact?: Delivery['artifacts'][number];
  reviews: Delivery['reviews'];
  canReview: boolean;
  revision?: Omit<NonNullable<Delivery['revision']>, 'content'>;
}

/** 业务输入/冲突可公开；其他异常不向浏览器暴露内部错误。 */
export class ReviewPageError extends Error {
  /** 保存 HTTP 分类，让 Adapter 无需猜测底层异常文本。 */
  constructor(
    message: string,
    public readonly status: 400 | 404 | 409,
  ) {
    super(message);
  }
}

/** 从串行步骤的已提交输出取得最新业务状态，支持暂停点和历史终态。 */
export async function readProductDocument(
  app: DeliveryContext,
  runId: string,
): Promise<ProductReviewDocument> {
  const snapshot = await app.deliveryWorkflow.getWorkflowRunById(runId);
  if (!snapshot) throw new ReviewPageError('找不到这条交接记录。', 404);
  let state: Delivery | undefined;
  const orderedSteps = [
    'initialize',
    'draft-product',
    'review-product',
    'draft-development',
    'review-development',
    'draft-testing',
    'review-testing',
    'draft-operations',
    'review-operations',
    'finish',
  ];
  for (const name of orderedSteps) {
    const step = snapshot.steps?.[name];
    if (step && !Array.isArray(step)) {
      const parsed = deliverySchema.safeParse(step.output);
      if (parsed.success) state = parsed.data;
    }
  }
  const finalState = deliverySchema.safeParse(snapshot.result);
  if (finalState.success) state = finalState.data;
  if (!state)
    throw new ReviewPageError(
      '这条记录还没有可阅读的交接内容，请稍后刷新。',
      409,
    );
  const status = await deliveryStatus(app, runId);
  // 阶段唯一，产品正文取最早生成且始终不变的交接物。
  const artifact = state.artifacts.find((item) => item.stage === 'product');
  return {
    runId,
    brief: state.brief,
    mode: state.mode,
    status: snapshot.status,
    outcome: state.outcome,
    pendingRole: status.pending?.role,
    artifact,
    reviews: state.reviews,
    revision: state.revision
      ? {
          sourceRunId: state.revision.sourceRunId,
          sourceHash: state.revision.sourceHash,
          proposalId: state.revision.proposalId,
          confirmedDecisions: state.revision.confirmedDecisions,
          appliedBy: state.revision.appliedBy,
        }
      : undefined,
    canReview:
      snapshot.status === 'suspended' &&
      status.pending?.step === 'review-product' &&
      state.mode === app.config.mode,
  };
}

export const productDecisionSchema = z
  .object({
    artifactHash: z.string().regex(/^[a-f0-9]{64}$/),
    decision: z.enum(['approve', 'reject']),
    reviewer: z.string().trim().min(1).max(100),
    comment: z.string().trim().min(1).max(2000),
  })
  .strict();

/** HTTP 入口固定产品角色，不接受客户端指定其他审批角色。 */
export async function decideProduct(
  app: DeliveryContext,
  runId: string,
  input: unknown,
) {
  const decision = productDecisionSchema.parse(input);
  const current = await readProductDocument(app, runId);
  if (!current.canReview)
    throw new ReviewPageError(
      '当前记录已不在可确认的产品阶段，或运行模式不同。请刷新后查看。',
      409,
    );
  if (current.artifact?.hash !== decision.artifactHash)
    throw new ReviewPageError('文档版本已变化，请刷新并重新审阅。', 409);
  await reviewDelivery(app, runId, { ...decision, role: 'product' });
  return readProductDocument(app, runId);
}

/** 助手只接受有限纯文本历史，拒绝系统角色、工具 part 及客户端执行选项。 */
export const reviewChatSchema = z
  .object({
    artifactHash: z.string().regex(/^[a-f0-9]{64}$/),
    messages: z
      .array(
        z
          .object({
            id: z.string().min(1).max(200),
            role: z.enum(['user', 'assistant']),
            parts: z
              .array(
                z
                  .object({
                    type: z.literal('text'),
                    text: z.string().min(1).max(8000),
                    state: z.enum(['streaming', 'done']).optional(),
                  })
                  .strict(),
              )
              .min(1)
              .max(8),
          })
          .strict(),
      )
      .min(1)
      .max(20),
    // 总历史限额避免逐条合法却累计无限增长的提示输入。
  })
  .strict()
  .refine(
    (body) =>
      body.messages.reduce(
        // 只计用户和助手可见正文，模型上下文由服务端另行装配。
        (total, message) =>
          total +
          message.parts.reduce(
            // 同条消息可以包含多个由 AI SDK 聚合的文本 part。
            (length, part) => length + part.text.length,
            0,
          ),
        0,
      ) <= 32000,
    '对话过长，请清空后重新提问。',
  );

/** 锁定当前产品版本；问题或文档内容不能取得 Workflow 恢复能力。 */
export async function prepareReadingChat(
  app: DeliveryContext,
  runId: string,
  input: unknown,
) {
  const body = reviewChatSchema.parse(input);
  if (body.messages.at(-1)?.role !== 'user')
    throw new ReviewPageError('请发送一个产品文档问题。', 400);
  const document = await readProductDocument(app, runId);
  if (!document.artifact)
    throw new ReviewPageError('当前记录尚未生成产品文档。', 409);
  if (document.artifact.hash !== body.artifactHash)
    throw new ReviewPageError('文档版本已变化，请刷新后重新提问。', 409);
  if (document.mode !== app.config.mode)
    throw new ReviewPageError(
      '记录与当前服务运行模式不同，请使用相同模式的服务。',
      409,
    );
  const context = JSON.stringify({
    brief: document.brief,
    content: document.artifact.content,
    hash: document.artifact.hash,
    reviews: document.reviews,
    status: document.status,
    outcome: document.outcome,
  });
  return { messages: body.messages, context };
}
