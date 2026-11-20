/** 工作台实时输出只允许正文增量和工具生命周期，绝不携带参数、结果或推理。 */
export type LiveOutputEvent =
  | { type: 'text'; text: string; role: string; attempt: number }
  | { type: 'tool'; name: string; state: 'started' | 'completed' | 'failed'; role: string; attempt: number };

/** 将 Mastra 原生流块压缩为浏览器可公开的最小事件。 */
export function projectLiveOutputChunk(chunk: any, role: string, attempt: number): LiveOutputEvent | undefined {
  if (chunk?.type === 'text-delta' && typeof chunk.payload?.text === 'string') return { type: 'text', text: chunk.payload.text, role, attempt };
  if (chunk?.type === 'tool-call' && typeof chunk.payload?.toolName === 'string') return { type: 'tool', name: chunk.payload.toolName, state: 'started', role, attempt };
  if (chunk?.type === 'tool-result' && typeof chunk.payload?.toolName === 'string') return { type: 'tool', name: chunk.payload.toolName, state: chunk.payload.isError ? 'failed' : 'completed', role, attempt };
  return undefined;
}

/** 通过 Workflow 原生 PubSub 发布易失展示投影，不修改执行事实。 */
export async function publishLiveOutput(pubsub: { publish(channel: string, value: any): unknown } | undefined, runId: string, event: LiveOutputEvent, stepId: string, taskKey?: string): Promise<void> {
  await pubsub?.publish(`workflow.events.v2.${runId}`, { type: 'watch', runId, data: { type: 'live-output.v1', data: event, stepId, taskKey } });
}
