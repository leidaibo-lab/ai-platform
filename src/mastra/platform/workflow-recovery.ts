import { setTimeout as delay } from 'node:timers/promises';

/** 等待原生快照离开执行态，超时由调用方继续展示当前运行事实。 */
export async function waitForWorkflowToSettle<T extends { status: string }>(
  readSnapshot: () => Promise<T | null | undefined>,
  { timeoutMs = 15000, intervalMs = 50 } = {},
) {
  const deadline = performance.now() + timeoutMs;
  while (true) {
    const snapshot = await readSnapshot();
    if (!snapshot || snapshot.status !== 'running') return { settled: true as const, snapshot };
    const remaining = deadline - performance.now();
    if (remaining <= 0) return { settled: false as const };
    await delay(Math.min(intervalMs, remaining));
  }
}
