import { beginExecution } from './execution-control.js';
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
export const WRITING_MODEL_SETTINGS = { maxRetries: 0, maxOutputTokens: 16000, timeout: { totalMs: 1800000, stepMs: 600000 } } as const;
/** 需求梳理的简短固定交接约定：只将可追溯规则移交给后续闭环与写作，不重复生成完整PRD。 */
export type ClarificationHandoffSections = ['已确认规则索引', '核心对象与关系', '状态与权限要点', '异常规则索引', '页面与验收待展开清单'];
export const CLARIFICATION_HANDOFF_CONVENTION: { readonly sections: ClarificationHandoffSections } = {
  sections: ['已确认规则索引', '核心对象与关系', '状态与权限要点', '异常规则索引', '页面与验收待展开清单'],
};

/** 检查模型实际交接正文的五章标题和内容，不用宿主目录标签冒充已生成章节。 */
export function assertClarificationHandoff(content: string): void {
  const headings = [...content.matchAll(/^#{1,6}\s+(?:[一二三四五1-5][、.．)）]\s*)?(.+?)\s*#*\s*$/gm)];
  const sections = CLARIFICATION_HANDOFF_CONVENTION.sections;
  const selected = headings.filter(/** 顶层文档标题可保留，交接章节必须来自固定目录。 */heading => sections.includes(heading[1].trim() as ClarificationHandoffSections[number]));
  if (selected.length !== sections.length || selected.some(/** 拒绝缺章、重复章和错序交接。 */(heading, index) => heading[1].trim() !== sections[index])) throw new Error('需求梳理未生成五章固定交接正文');
  for (let index = 0; index < selected.length; index++) {
    const heading = selected[index];
    const next = selected[index + 1];
    const body = content.slice(heading.index! + heading[0].length, next?.index ?? content.length).trim();
    if (!body) throw new Error('需求梳理固定交接章节缺少正文');
  }
}
/** 四角色统一验证原生结束事实；只读临时故障最多两次，单节点共享一小时截止时间。 */
export async function generateProductContent(agent: ReturnType<typeof createAgents>['productAgent'], prompt: string, role: string, mode: 'fixture' | 'live', remote?: { root: string; receipt?: RemoteHandoff }, budgetLevel = 0, execution?: { runId: string; abortSignal: AbortSignal }) {
  const observation = execution ? beginExecution(execution.runId, role, execution.abortSignal) : undefined;
  const signal = observation?.signal ?? execution?.abortSignal;
  try {
    let input: Record<string, unknown>;
    try { input = JSON.parse(prompt); } catch { input = { task: 'product', instruction: prompt }; }
    const attempts: ProductAttempt[] = []; const invocationStarted = performance.now(); const deadline = invocationStarted + WRITING_MODEL_SETTINGS.timeout.totalMs;
    for (let attempt = 1; attempt <= 2; attempt++) {
      observation?.check(); signal?.throwIfAborted();
      observation?.attempt(attempt);
      const started = performance.now();
      // 每次重试从相同输入新建只读资料闭包，失败片段不混入新正文。
      let context: ReturnType<typeof createTaskContext> | undefined;
      let finishReason: ProductAttempt['finishReason']; let steps: number | undefined; let textChars: number | undefined;
      let kind: ProductFailureKind | undefined;
      try {
        context = createTaskContext(input, mode === 'live', remote, budgetLevel);
        const remaining = Math.max(1, Math.floor(deadline - performance.now()));
        const defaults = await agent.getDefaultOptions?.();
        const options = { ...context.options, abortSignal: signal,
          // 步骤完成才更新最近活动，不把轮询当作模型心跳。
          onStepFinish: async (event: Parameters<NonNullable<Awaited<ReturnType<typeof agent.getDefaultOptions>>['onStepFinish']>>[0]) => { observation?.activity(event); await defaults?.onStepFinish?.(event); }, maxSteps: PRODUCT_MAX_STEPS,
          modelSettings: { ...WRITING_MODEL_SETTINGS, timeout: { totalMs: remaining, stepMs: Math.min(remaining, WRITING_MODEL_SETTINGS.timeout.stepMs) } } };
        const result = role === 'writing' && mode === 'live'
          ? await (await agent.stream(context.prompt, options)).getFullOutput()
          : await agent.generate(context.prompt, options);
        observation?.check(); signal?.throwIfAborted();
        if (result.error) throw result.error;
        finishReason = safeFinishReason(result.finishReason); steps = result.steps.length;
        // Mastra text 汇总了所有步骤；只把最终步骤正文当交付，避免发布前置“我将检查”的计划。
        const text = result.steps.at(-1)?.text?.trim() ?? '';
        textChars = text.length;
        kind = finishReason === 'length' ? 'output-limit' : finishReason === 'tool-calls' ? 'tool-loop' : finishReason === 'tripwire' || finishReason === 'content-filter' ? 'blocked' : finishReason !== 'stop' ? 'incomplete' : !text ? 'empty-output' : role !== 'writing' && isPlanOnlyProductOutput(text) ? 'incomplete' : undefined;
        if (kind) throw new Error('产品生成结果未通过完成校验');
        return { ...result, text, generation: { version: 'product-generation.v1' as const, finishReason: 'stop' as const, attempts: attempt, durationMs: Math.max(0, Math.round(performance.now() - invocationStarted)), failures: attempts } };
      } catch (error) {
        const detail: ProductAttempt = { attempt, durationMs: Math.max(0, Math.round(performance.now() - started)), recordedAt: new Date().toISOString(), kind: kind ?? classifyProductError(error), finishReason, steps, textChars, budget: error instanceof ContextBudgetError ? error.budget : undefined, failure: diagnoseModelFailure(error) };
        attempts.push(detail);
        observation?.check(); signal?.throwIfAborted();
        const retry = mode === 'live' && attempt < 2 && canRetryProductAttempt(detail) && deadline - performance.now() > 1000;
        observation?.failure(detail, retry);
        if (!retry) throw new ProductGenerationFailure(attempts);
        await delay(1000, undefined, { signal });
      }
    }
    throw new ProductGenerationFailure(attempts);
  } finally { observation?.finish(); }
}
