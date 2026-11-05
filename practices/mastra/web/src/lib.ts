import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

/** AI Elements 的本地样式合并入口，保留调用方覆盖能力。 */
export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

/** 页面消费的精简 API 契约；不携带模型配置、错误堆栈或内部快照。 */
export interface ReviewDocument {
  runId: string;
  brief: string;
  mode: 'fixture' | 'live';
  status: string;
  outcome: 'in-progress' | 'rejected' | 'rework-requested' | 'plan-approved';
  pendingRole?: string;
  canReview: boolean;
  canRework: boolean;
  reworkRunId?: string;
  productWork?: {
    version: 'product-graph.v1';
    entries: { role: 'coordinator' | 'clarification' | 'closure' | 'writing'; content: string; toolNames: string[]; modelSteps: number }[];
  };
  productRework?: {
    sourceRunId: string;
    sourceHash: string;
    reviewer: string;
    feedback: string;
    round: number;
  };
  revision?: {
    sourceRunId: string;
    sourceHash: string;
    proposalId: string;
    confirmedDecisions: string;
    appliedBy: string;
  };
  artifact?: {
    stage: string;
    content: string;
    hash: string;
    evidence: 'fixture' | 'model-proposal';
  };
  reviews: {
    role: string;
    artifactHash: string;
    decision: 'approve' | 'reject' | 'rework';
    reviewer: string;
    comment: string;
  }[];
}
export interface RunSummary {
  revisionOf?: string;
  reworkOf?: string;
  runId: string;
  brief: string;
  status: string;
  createdAt: string;
  updatedAt: string;
}
export interface RunPage {
  runs: RunSummary[];
  total: number;
  page: number;
}

/** 同源请求统一处理非 2xx；错误文案来自服务端的脱敏响应。 */
export async function api<T>(path: string, options?: RequestInit): Promise<T> {
  const response = await fetch(`/review-api${path}`, {
    ...options,
    cache: 'no-store',
  });
  // 代理或服务不可达时可能返回非 JSON；统一交付可操作文案。
  const body = await response.json().catch(() => {
    throw new Error('服务暂时不可用，请确认 Mastra 已启动后刷新。');
  });
  if (!response.ok)
    throw new Error(body.error ?? '服务暂时不可用，请稍后刷新。');
  return body as T;
}

/** SDK 非流式错误也解析公开文案，避免把 JSON 包装直接显示给阅读者。 */
export const readingFetch: typeof fetch = async (request, options) => {
  const response = await fetch(request, options);
  if (!response.ok) {
    // 不转发未知 HTML 或网关原始响应。
    const body = await response.json().catch(() => ({}));
    throw new Error(
      body.error ?? '阅读助手暂时不可用，请确认服务已启动后再试。',
    );
  }
  return response;
};

/** 摘要从真实需求生成，不把原始 JSON 当标题呈现。 */
export function briefTitle(brief: string) {
  return (
    brief
      .replace(/^#+\s*/u, '')
      .split(/[\n：:]/u)[0]
      .slice(0, 36) || '产品交接记录'
  );
}

/** 时间由运行事实提供，以当前浏览器本地时区显示。 */
export function formatTime(value: string) {
  return new Date(value).toLocaleString('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
}

/** 将框架状态转成页面状态；业务拒绝优先于框架 success。 */
export function documentStatus(document: ReviewDocument) {
  if (document.outcome === 'rejected') return '本轮已拒绝';
  if (document.outcome === 'rework-requested') return '已退回修改';
  if (document.status === 'failed') return '流程执行失败';
  if (document.outcome === 'plan-approved') return '四阶段方案已确认';
  if (document.canReview) return '等待产品确认';
  if (document.pendingRole)
    return `等待${({ product: '产品', development: '开发', testing: '测试', operations: '运维' } as Record<string, string>)[document.pendingRole] ?? document.pendingRole}确认`;
  return (
    (
      {
        running: '流程进行中',
        suspended: '流程已暂停',
        canceled: '流程已取消',
      } as Record<string, string>
    )[document.status] ?? '历史交接记录'
  );
}
