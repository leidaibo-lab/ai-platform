import type { RemoteHandoff } from '../delivery/remote-handoff.js';
import { createTaskContext } from '../delivery/task-context.js';
/** 产品写作使用原生流，避免长文一次性返回等待网关；其他角色保持既有行为。 */
import type { createAgents } from '../mastra/agents/index.js';
import { PRODUCT_MAX_STEPS } from '../mastra/agents/skills.js';
export const WRITING_MODEL_SETTINGS = { maxRetries: 0, maxOutputTokens: 16000, timeout: { totalMs: 1800000, stepMs: 600000 } } as const;
/** 流式错误及输出截断必须使节点失败，不将部分正文发布为完整产品稿。 */
export async function generateProductContent(agent: ReturnType<typeof createAgents>['productAgent'], prompt: string, role: string, mode: 'fixture' | 'live', remote?: { root: string; receipt?: RemoteHandoff }) {
  let input: Record<string, unknown>;
  try { input = JSON.parse(prompt); } catch { input = { task: 'product', instruction: prompt }; }
  const context = createTaskContext(input, mode === 'live', remote);
  prompt = context.prompt;
  if (role !== 'writing' || mode !== 'live') return agent.generate(prompt, { ...context.options, maxSteps: PRODUCT_MAX_STEPS });
  const stream = await agent.stream(prompt, { ...context.options, maxSteps: PRODUCT_MAX_STEPS, modelSettings: WRITING_MODEL_SETTINGS });
  const result = await stream.getFullOutput();
  if (result.error) throw result.error;
  if (result.finishReason === 'length') throw new Error('产品稿达到输出预算，尚未完整生成；未发布部分正文');
  if (result.finishReason !== 'stop') throw new Error('产品写作未正常完成；未发布部分正文');
  return result;
}
