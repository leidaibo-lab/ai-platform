import { z } from 'zod';
import type { DeliveryContext } from './delivery-service.js';
import {
  readProductDocument,
  reviewChatSchema,
  ReviewPageError,
} from './review-service.js';
import {
  revisionProposalSchema,
  type createRevisionWorkflow,
} from './mastra/workflows/revision.js';

/** 修订服务依赖两个原生流程；不引入并行审批数据库。 */
export interface RevisionContext extends DeliveryContext {
  revisionWorkflow: ReturnType<typeof createRevisionWorkflow>;
}
const proposeSchema = z
  .object({
    artifactHash: z.string().regex(/^[a-f0-9]{64}$/),
    confirmedDecisions: z.string().trim().min(1).max(8000),
    messages: z.array(z.unknown()).max(20).default([]),
  })
  .strict();
const applySchema = z
  .object({
    artifactHash: z.string().regex(/^[a-f0-9]{64}$/),
    proposalId: z.string().uuid(),
    appliedBy: z.string().trim().min(1).max(100),
  })
  .strict();

/** 检查来源版本及模型模式；运行中的交付需等待稳定暂停点后再修订。 */
async function sourceDocument(
  app: RevisionContext,
  runId: string,
  hash: string,
) {
  const document = await readProductDocument(app, runId);
  if (!document.artifact || document.artifact.hash !== hash)
    throw new ReviewPageError(
      '来源文档版本不匹配，请重新读取并生成修订提案。',
      409,
    );
  if (document.mode !== app.config.mode)
    throw new ReviewPageError('记录与当前服务模式不同，不能跨模式修订。', 409);
  if (!['suspended', 'success', 'failed', 'canceled'].includes(document.status))
    throw new ReviewPageError(
      '来源流程正在执行，请等待暂停或结束后再修订。',
      409,
    );
  return document;
}

/** 从原生快照恢复完整预览，刷新页面不丢失已生成的修订提案。 */
export async function readRevision(
  app: RevisionContext,
  runId: string,
  proposalId: string,
) {
  const snapshot = await app.revisionWorkflow.getWorkflowRunById(
    z.string().uuid().parse(proposalId),
  );
  if (!snapshot) throw new ReviewPageError('找不到这份修订提案。', 404);
  const parsed = revisionProposalSchema.safeParse(snapshot.result);
  if (snapshot.status !== 'success' || !parsed.success)
    throw new ReviewPageError(
      '修订提案尚未生成成功，请返回原稿重新生成。',
      409,
    );
  if (parsed.data.sourceRunId !== runId)
    throw new ReviewPageError('修订提案不属于当前记录。', 409);
  const document = await sourceDocument(app, runId, parsed.data.sourceHash);
  if (document.mode !== parsed.data.mode)
    throw new ReviewPageError('修订提案模式与来源不同。', 409);
  return parsed.data;
}

/** 明确结论作为变更依据，聊天只作参考；本操作仅生成持久提案。 */
export async function proposeRevision(
  app: RevisionContext,
  runId: string,
  input: unknown,
) {
  const body = proposeSchema.parse(input);
  const document = await sourceDocument(app, runId, body.artifactHash);
  const history = body.messages.length
    ? reviewChatSchema.parse({
        artifactHash: body.artifactHash,
        messages: body.messages,
      }).messages
    : [];
  // 只保存可见对话，不能通过讨论注入系统消息或工具执行能力。
  const discussion = history
    .map(
      (message) =>
        `${message.role}: ${message.parts
          .map(
            // 文本 part 已在边界严格校验。
            (part) => part.text,
          )
          .join('\n')}`,
    )
    .join('\n\n');
  const run = await app.revisionWorkflow.createRun();
  const result = await run.start({
    inputData: {
      sourceRunId: runId,
      sourceHash: body.artifactHash,
      brief: document.brief,
      originalContent: document.artifact!.content,
      mode: document.mode,
      confirmedDecisions: body.confirmedDecisions,
      discussion,
    },
  });
  const parsed = revisionProposalSchema.safeParse(
    result.status === 'success' ? result.result : undefined,
  );
  if (!parsed.success)
    throw new ReviewPageError(
      '修订提案生成失败，原交接稿未改变，请重试。',
      409,
    );
  if (parsed.data.content === parsed.data.originalContent)
    throw new ReviewPageError(
      '生成结果与原稿一致，请补充具体结论后重新生成。',
      409,
    );
  return parsed.data;
}

/** 每份提案对应固定新 Run；重试回读已持久化的新稿，不重复启动或继承审批。 */
export async function applyRevision(
  app: RevisionContext,
  runId: string,
  input: unknown,
) {
  const body = applySchema.parse(input);
  const proposal = await readRevision(app, runId, body.proposalId);
  if (proposal.sourceHash !== body.artifactHash)
    throw new ReviewPageError('提案对应的来源版本不同，请重新预览。', 409);
  const newRunId = `revision-${proposal.proposalId}`;
  const existing = await app.deliveryWorkflow.getWorkflowRunById(newRunId);
  if (existing) return readProductDocument(app, newRunId);
  const run = await app.deliveryWorkflow.createRun({ runId: newRunId });
  await run.start({
    inputData: {
      brief: proposal.brief,
      revision: {
        sourceRunId: runId,
        sourceHash: proposal.sourceHash,
        proposalId: proposal.proposalId,
        confirmedDecisions: proposal.confirmedDecisions,
        appliedBy: body.appliedBy,
        content: proposal.content,
      },
    },
  });
  return readProductDocument(app, newRunId);
}
