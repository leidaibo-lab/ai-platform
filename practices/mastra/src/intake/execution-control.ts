/** 只读产品生成的有界易失观察 Adapter；终态与恢复仍由 Mastra 拥有。
 * ADR: docs/decisions/2026-11-10-mastra-execution-control.md
 */
import { randomUUID } from 'node:crypto';
import type { ProductAttempt } from '../delivery/product-generation-contract.js';

/** 一次调用的公开投影；时间均为服务端毫秒，失败只包含既有白名单。 */
export interface ExecutionObservation {
  token: string; role: string; startedAt: number; lastActivityAt: number;
  attempt: number; attemptStartedAt: number; steps: number;
  phase: 'generating' | 'retrying' | 'canceling' | 'stopped' | 'settled';
  failures: ProductAttempt[]; settled: boolean;
}
interface ActiveExecution { view: ExecutionObservation; controller: AbortController; requested: boolean }
const observations = new Map<string, ActiveExecution>();

/** 开始一次只读调用；不允许同Run并行生成，不淘汰活动执行。 */
export function beginExecution(runId: string, role: string, nativeSignal?: AbortSignal) {
  if (observations.get(runId)?.view.settled === false) throw new Error('该Run已有活动生成');
  for (const [id, entry] of observations) {
    if (observations.size < 200) break;
    if (entry.view.settled) observations.delete(id);
  }
  if (observations.size >= 200) throw new Error('活动观察容量已满');
  const now = Date.now();
  const entry: ActiveExecution = { controller: new AbortController(), requested: false, view: { token: randomUUID(), role, startedAt: now, lastActivityAt: now, attempt: 1, attemptStartedAt: now, steps: 0, phase: 'generating', failures: [], settled: false } };
  observations.set(runId, entry);
  const signal = nativeSignal ? AbortSignal.any([nativeSignal, entry.controller.signal]) : entry.controller.signal;
  return {
    signal,
    /** 同步取消意图也作为迟到结果门禁，早于原生取消I/O完成。 */
    check() { if (entry.requested) throw new DOMException('用户取消生成', 'AbortError'); signal.throwIfAborted(); },
    /** 只记录真实尝试开始，不以轮询伪造模型活动。 */
    attempt(attempt: number) { entry.view.attempt = attempt; entry.view.attemptStartedAt = Date.now(); entry.view.steps = 0; entry.view.lastActivityAt = Date.now(); if (!entry.requested) entry.view.phase = 'generating'; },
    /** 记录实际模型步骤完成；不保存正文、工具参数或凭据。 */
    activity() { entry.view.steps++; entry.view.lastActivityAt = Date.now(); },
    /** 失败采用既有脱敏契约，重试等待与生成明确区分。 */
    failure(detail: ProductAttempt, retry: boolean) { entry.view.failures.push(detail); entry.view.lastActivityAt = Date.now(); if (!entry.requested && retry) entry.view.phase = 'retrying'; },
    /** 只有实际调用退出才确认本地停止，不宣称上游计算或计费已停止。 */
    finish() { entry.view.settled = true; entry.view.lastActivityAt = Date.now(); entry.view.phase = entry.requested || signal.aborted ? 'stopped' : 'settled'; },
  };
}

/** 返回脱离内部对象的只读投影；历史或重启缺失不补猜。 */
export function readExecution(runId: string) {
  const entry = observations.get(runId);
  return entry ? structuredClone(entry.view) : undefined;
}

/** 仅取消匹配版本的本机活动生成；取消路由不受长HTTP写锁阻塞。 */
export async function cancelExecution(runId: string, token: string, cancelNative: () => Promise<void>) {
  const entry = observations.get(runId);
  if (!entry || entry.view.token !== token) throw new Error('执行版本已变化或不属于本进程，请刷新');
  if (entry.requested) return;
  if (entry.view.settled) throw new Error('生成已经结束，请刷新');
  entry.requested = true; entry.view.phase = 'canceling'; entry.view.lastActivityAt = Date.now();
  // 原生先落取消事实；本地信号在finally中始终传播，不依赖存储成功。
  try { await cancelNative(); }
  finally { entry.controller.abort(new DOMException('用户取消生成', 'AbortError')); }
}
