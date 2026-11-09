/** 产品生成 Adapter 的故障证据；只允许枚举与计量，不保存 SDK 正文、URL、cause 或凭据。 */
import { diagnoseModelFailure } from '../delivery/model-failure.js';
import { ContextBudgetError } from '../delivery/context-budget.js';
import { describeContextBudgetUsage } from '../delivery/context-budget-presentation.js';
import { productFailureSchema, productFinishReasonSchema, type ProductAttempt, type ProductFailureEvidence, type ProductFailureKind } from '../delivery/product-generation-contract.js';
import type { z } from 'zod';
const reasons: Record<ProductFailureKind, string> = {
  'material-read': '交接资料读取失败，尚未发起本次模型调用',
  timeout: '模型调用超时', network: '模型连接中断或暂不可达', upstream: '上游模型服务返回错误',
  incomplete: '模型流未正常结束，未接受部分正文', 'output-limit': '模型输出达到长度上限，正文未完成',
  'tool-loop': '工具调用循环尚未产生最终正文', blocked: '模型或处理器拦截了本次生成',
  'context-budget': '历史资料预算限制中断了执行', 'empty-output': '模型正常结束但没有最终交付正文', unknown: '模型执行未完成，未取得明确故障来源',
};

/** 原生 Store 序列化拥有 details；不携带原始 SDK 异常，失败不会变成可发布产物。 */
export class ProductGenerationFailure extends Error {
  readonly details: ProductFailureEvidence;
  /** 每次人工恢复独立限制两次尝试；已有成功角色和人工回答归原生快照保留。 */
  constructor(attempts: ProductAttempt[]) {
    super(reasons[attempts.at(-1)!.kind]); this.name = 'ProductGenerationFailure';
    this.details = productFailureSchema.parse({ version: 'product-generation-failure.v1', attempts });
  }
}

/** 只用明确的 SDK 类型、状态码或传输代码分类，不根据敏感 message 猜原因。 */
export function classifyProductError(error: unknown): ProductFailureKind {
  if (error instanceof ContextBudgetError) return 'context-budget';
  const failure = diagnoseModelFailure(error);
  if (failure.source === 'handoff-read') return 'material-read';
  if (failure.source.startsWith('mastra-') || failure.source.startsWith('transport-') || [408, 504, 524].includes(failure.httpStatus ?? 0)) return 'timeout';
  if (failure.source === 'upstream-http') return 'upstream';
  let current = error;
  for (let depth = 0; depth < 5 && current && typeof current === 'object'; depth++) {
    const value = current as { name?: unknown; code?: unknown; cause?: unknown };
    if (value.name === 'TimeoutError') return 'timeout';
    if (['ECONNRESET', 'EAI_AGAIN', 'ECONNREFUSED', 'EPIPE', 'UND_ERR_SOCKET'].includes(String(value.code))) return 'network';
    current = value.cause;
  }
  return 'unknown';
}

/** 中间角色若只返回执行计划而没有结果事实，不能冒充成功产物进入下一角色。 */
export function isPlanOnlyProductOutput(text: string): boolean {
  return /^(?:我(?:会|将)|接下来(?:我)?(?:会|将)|下面(?:我)?(?:会|将)|先由我(?:检查|梳理|分析|整理)|我先(?:检查|梳理|分析|整理))[^\n。！？]{0,100}[。！？]?$/.test(text.trim());
}

/** 未知结束值只记 unknown，绝不把 provider 自定义字符串直接回传浏览器。 */
export function safeFinishReason(value: unknown): z.infer<typeof productFinishReasonSchema> {
  const parsed = productFinishReasonSchema.safeParse(value); return parsed.success ? parsed.data : 'unknown';
}

/** 可重试范围只包含只读模型生成的临时故障；拒绝、预算、截断与用户取消不自动重放。 */
export function canRetryProductAttempt(attempt: ProductAttempt): boolean {
  if (!['network', 'timeout', 'upstream'].includes(attempt.kind)) return false;
  if (attempt.failure.source === 'aborted' || attempt.failure.source === 'mastra-total') return false;
  const status = attempt.failure.httpStatus;
  if (status !== undefined) return [408, 429, 500, 502, 503, 504, 524].includes(status);
  return attempt.kind === 'network' || attempt.kind === 'timeout';
}

/** 失败摘要完全派生自校验后的证据；旧记录没有结束状态时明确说明不可追溯。 */
export function describeProductFailure(error: unknown, _legacyContextBudgetLevel = 0) {
  const value = error as { name?: unknown; message?: unknown; details?: unknown } | undefined;
  const parsed = productFailureSchema.safeParse(value?.details);
  if (value?.name === 'ProductGenerationFailure' && parsed.success) {
    const attempts = parsed.data.attempts;
    const last = attempts.at(-1)!;
    const next = last.kind === 'material-read'
      ? last.failure.code === 'HANDOFF_VERSION_UNAVAILABLE' ? '当前仓库缺少交接提交或登记文件；请从授权远端补齐原版本并校验散列后，从此节点继续，无需重建 Run。' : '交接资料未登记或散列校验失败；请核对原交接回执，禁止跳过校验。修复后可从此节点继续。'
      : last.kind === 'context-budget'
      ? '资料预算门槛已移除；可从当前失败角色继续，执行上下文由 Mastra 原生观察记忆管理，无需确认资料升档。'
      : undefined;
    return { reason: reasons[last.kind], additionalContextLevel: undefined, retryBlocked: false, details: attempts.map(/** 仅展示白名单字段，不暴露模型返回正文。 */item => `第${item.attempt}次尝试：${reasons[item.kind]}；耗时${(item.durationMs / 1000).toFixed(1)}秒${item.budget ? `；${describeContextBudgetUsage(item.budget)}` : item.kind === 'context-budget' ? '；旧记录未保存具体预算项和用量，无法追溯' : ''}${item.finishReason ? `；结束状态 ${item.finishReason}` : ''}${item.steps !== undefined ? `；执行${item.steps}步` : ''}${item.failure.httpStatus ? `；HTTP ${item.failure.httpStatus}` : ''}。`),
      next: next ?? (last.kind === 'output-limit' ? '请先调整写作范围或输出预算，再从此节点继续。' : last.kind === 'tool-loop' ? '请检查工具错误和循环步数，修复后再继续。' : '可以从此节点继续；仅临时网络或服务故障最多自动尝试两次，仍失败时保留检查点。') };
  }
  if (value?.message === '产品写作未正常完成；未发布部分正文') return { reason: '产品写作未正常结束，未发布部分正文', details: ['历史记录没有保存具体结束状态，无法确认是流中断、工具循环还是上游异常；不能据此判定超时或额度不足。'], next: '修复后的后续执行会记录结束状态与尝试证据；历史记录保持原样。' };
  if (value?.message === '产品生成结果未通过完成校验') return { reason: '角色结果校验未通过', details: ['模型调用可能正常结束，但只返回了执行计划，没有形成该角色的实际交付；结果未传给下一角色。'], next: '请修订角色提示或补充任务约束后再恢复；该类结果不会自动重试。' };
  if (value?.message === '产品稿达到输出预算，尚未完整生成；未发布部分正文') return { reason: reasons['output-limit'], details: ['历史错误明确记录输出达到长度上限。'], next: '请先调整写作范围或输出预算，再继续。' };
  return undefined;
}
