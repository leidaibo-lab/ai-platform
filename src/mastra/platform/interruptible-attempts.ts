import { randomUUID } from 'node:crypto';

interface ActiveAttempt<T> {
  id: string;
  controller: AbortController;
  interruption?: T;
}

/** 关联进程内中止信号和执行尝试。业务回执仍由 Workflow 快照保存。 */
export function createInterruptibleAttempts<T extends object>(matches: (previous: T, next: T) => boolean) {
  const attempts = new Map<string, ActiveAttempt<T>>();

  /** 返回当前进程能够中止的尝试。 */
  function capability(runId: string) {
    const active = attempts.get(runId);
    return active && { attempt: active.id, stopping: !!active.interruption };
  }

  /** 只接受当前尝试的中止信号，重复请求复用已提交的指令。 */
  function interrupt(runId: string, attempt: string, interruption: T) {
    const active = attempts.get(runId);
    if (!active || active.id !== attempt) return false;
    if (active.interruption) return matches(active.interruption, interruption);
    active.interruption = interruption;
    active.controller.abort();
    return true;
  }

  /** 等执行结束后返回中止指令或有效产物，由调用步骤决定如何保存。 */
  async function run<Output>(runId: string, workflowSignal: AbortSignal, enabled: boolean, execute: (signal: AbortSignal) => Promise<Output>) {
    if (!enabled) return { output: await execute(workflowSignal) };
    const active: ActiveAttempt<T> = { id: randomUUID(), controller: new AbortController() };
    attempts.set(runId, active);
    try {
      const output = await execute(AbortSignal.any([workflowSignal, active.controller.signal]));
      if (active.interruption) return { interruption: active.interruption };
      return { output };
    } catch (error) {
      if (active.interruption && !workflowSignal.aborted) return { interruption: active.interruption };
      throw error;
    } finally {
      if (attempts.get(runId) === active) attempts.delete(runId);
    }
  }

  return { capability, interrupt, run };
}
