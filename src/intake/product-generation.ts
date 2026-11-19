import type { RemoteHandoff } from '../delivery/remote-handoff.js';
import { createTaskContext } from '../delivery/task-context.js';
/** 产品角色生成 Adapter：写作实时流式读取，其余角色使用同步生成。 */
import type { createAgents } from '../mastra/agents/index.js';
import { PRODUCT_MAX_STEPS } from '../mastra/agents/skills.js';
import { setTimeout as delay } from 'node:timers/promises';
import { diagnoseModelFailure } from '../delivery/model-failure.js';
import { ContextBudgetError } from '../delivery/context-budget.js';
import { ProductGenerationFailure, canRetryProductAttempt, classifyProductError, isPlanOnlyProductOutput, safeFinishReason } from './product-failure.js';
import type { ProductAttempt, ProductFailureKind } from '../delivery/product-generation-contract.js';
import { projectToolFacts } from './run-timeline.js';
import { projectLiveOutputChunk, type LiveOutputEvent } from './live-output.js';
export const WRITING_MODEL_SETTINGS = { maxRetries: 0, maxOutputTokens: 16000, timeout: { totalMs: 1800000, stepMs: 600000 } } as const;
export type ProductStreamEvent = LiveOutputEvent;
type ProductGenerationAgent = Pick<ReturnType<typeof createAgents>['productManagerAgent'], 'generate' | 'stream'>;
/** 产品团队统一验证原生结束事实；只读临时故障最多两次，单节点共享30分钟截止时间。 */
export async function generateProductContent(agent: ProductGenerationAgent, prompt: string, role: string, mode: 'fixture' | 'live', remote?: { root: string; receipt?: RemoteHandoff }, budgetLevel = 0, onProgress?: (event: ProductStreamEvent) => Promise<void>, abortSignal?: AbortSignal) {
  let input: Record<string, unknown>;
  try { input = JSON.parse(prompt); } catch { input = { task: 'product', instruction: prompt }; }
  const attempts: ProductAttempt[] = []; const invocationStarted = performance.now(); const startedAt = new Date().toISOString(); const deadline = invocationStarted + WRITING_MODEL_SETTINGS.timeout.totalMs;
  for (let attempt = 1; attempt <= 2; attempt++) {
    const started = performance.now();
    // 每次重试从相同输入新建只读资料闭包，失败片段不混入新正文。
    let context: ReturnType<typeof createTaskContext> | undefined;
    let finishReason: ProductAttempt['finishReason']; let steps: number | undefined; let textChars: number | undefined;
    let kind: ProductFailureKind | undefined;
    try {
      context = createTaskContext(input, mode === 'live', remote, budgetLevel);
      const remaining = Math.max(1, Math.floor(deadline - performance.now()));
      abortSignal?.throwIfAborted();
      const options = { ...context.options, abortSignal, maxSteps: PRODUCT_MAX_STEPS, modelSettings: { ...WRITING_MODEL_SETTINGS, timeout: { totalMs: remaining, stepMs: Math.min(remaining, WRITING_MODEL_SETTINGS.timeout.stepMs) } } };
      let result;
      if (mode === 'live' && onProgress) {
        const stream = await agent.stream(context.prompt, options);
        for await (const chunk of stream.fullStream) {
          const event = projectLiveOutputChunk(chunk, role, attempt);
          // 展示流中断不得改变模型执行、检查点或恢复语义。
          if (event) await onProgress(event).catch(() => {});
        }
        result = await stream.getFullOutput();
      } else {
        result = role === 'writing' && mode === 'live' ? await (await agent.stream(context.prompt, options)).getFullOutput() : await agent.generate(context.prompt, options);
      }
      abortSignal?.throwIfAborted();
      if (result.error) throw result.error;
      finishReason = safeFinishReason(result.finishReason); steps = result.steps.length;
      // Mastra text 汇总了所有步骤；只把最终步骤正文当交付，避免发布前置“我将检查”的计划。
      const text = result.steps.at(-1)?.text?.trim() ?? '';
      textChars = text.length;
      kind = finishReason === 'length' ? 'output-limit' : finishReason === 'tool-calls' ? 'tool-loop' : finishReason === 'tripwire' || finishReason === 'content-filter' ? 'blocked' : finishReason !== 'stop' ? 'incomplete' : !text ? 'empty-output' : role !== 'writing' && isPlanOnlyProductOutput(text) ? 'incomplete' : undefined;
      if (kind) throw new Error('产品生成结果未通过完成校验');
      const endedAt = new Date().toISOString();
      return { ...result, text, toolFacts: projectToolFacts(result.toolResults), generation: { version: 'product-generation.v1' as const, finishReason: 'stop' as const, attempts: attempt, durationMs: Math.max(0, Math.round(performance.now() - invocationStarted)), startedAt, endedAt, failures: attempts } };
    } catch (error) {
      abortSignal?.throwIfAborted();
      const detail: ProductAttempt = { attempt, durationMs: Math.max(0, Math.round(performance.now() - started)), recordedAt: new Date().toISOString(), kind: kind ?? classifyProductError(error), finishReason, steps, textChars, budget: error instanceof ContextBudgetError ? error.budget : undefined, failure: diagnoseModelFailure(error) };
      attempts.push(detail);
      if (mode !== 'live' || attempt === 2 || !canRetryProductAttempt(detail) || deadline - performance.now() <= 1000) throw new ProductGenerationFailure(attempts);
      await delay(1000, undefined, { signal: abortSignal });
    }
  }
  throw new ProductGenerationFailure(attempts);
}
