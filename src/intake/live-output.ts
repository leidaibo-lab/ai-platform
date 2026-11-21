/** 工作台实时输出只允许正文增量和工具生命周期，绝不携带参数、结果或推理。 */
export type LiveOutputEvent =
  | { type: 'text'; text: string; role: string; attempt: number }
  | { type: 'tool'; action: ToolAction; object?: string; state: 'started' | 'completed' | 'failed'; role: string; attempt: number };

/** 浏览器只接收标准化操作码，不接收模型或工具提供的原始名称。 */
export type ToolAction = 'skill.load' | 'skill.read' | 'skill.search' | 'handoff.locate' | 'handoff.read' | 'file.read' | 'file.write' | 'checks.run' | 'task.delegate' | 'platform.info' | 'tool.invoke';

/** 读取原生工具调用输入，仅用于按工具白名单提取可展示对象。 */
function toolInput(payload: Record<string, unknown>): Record<string, unknown> | undefined {
  const source = payload.args ?? payload.input ?? payload.rawInput;
  let args = source;
  if (typeof source === 'string') {
    try { args = JSON.parse(source); } catch { return undefined; }
  }
  if (!args || typeof args !== 'object' || Array.isArray(args)) return undefined;
  return args as Record<string, unknown>;
}

/** 将内部工具名映射为稳定操作码及可选对象，搜索词、内容和任意参数不外传。 */
function projectTool(toolName: string, payload: Record<string, unknown>): { action: ToolAction; object?: string } {
  const input = toolInput(payload);
  const safeName = (value: unknown) => typeof value === 'string' && /^[a-zA-Z0-9_.-]{1,160}$/.test(value) ? value : undefined;
  if (toolName === 'skill') return { action: 'skill.load', ...(safeName(input?.name) ? { object: safeName(input?.name) } : {}) };
  if (toolName === 'skill_read') return { action: 'skill.read', ...(safeName(input?.skillName) ? { object: safeName(input?.skillName) } : {}) };
  if (toolName === 'skill_search') {
    const names = Array.isArray(input?.skillNames) ? input.skillNames.map(safeName).filter((name): name is string => !!name).slice(0, 5) : [];
    return { action: 'skill.search', ...(names.length ? { object: names.join('、') } : {}) };
  }
  if (/^(?:handoff_)?locate$/.test(toolName)) return { action: 'handoff.locate' };
  if (/^(?:handoff_)?read$/.test(toolName)) return { action: 'handoff.read' };
  if (/^(?:readFile|writeFile|development-v2-(?:read|write)|development-(?:read|write)|(?:filesystem\.)?(?:read_file|write_file))$/i.test(toolName)) {
    const path = input?.path ?? input?.filePath;
    const object = typeof path === 'string' && path.length <= 500 && !path.includes('\\') && !path.split('/').some(part => !part || part === '.' || part === '..') ? path.split('/').at(-1) : undefined;
    return { action: /write/i.test(toolName) ? 'file.write' : 'file.read', ...(object ? { object } : {}) };
  }
  if (/^(?:delegateTask|development-delegate-task)$/i.test(toolName)) return { action: 'task.delegate', ...(safeName(input?.role) ? { object: safeName(input?.role) } : {}) };
  if (/^(?:runChecks|development-v2-check|development-check)$/i.test(toolName)) return { action: 'checks.run' };
  if (toolName === 'practice-info') return { action: 'platform.info' };
  return { action: 'tool.invoke' };
}

/** 将 Mastra 原生流块压缩为浏览器可公开的最小事件。 */
export function projectLiveOutputChunk(chunk: any, role: string, attempt: number): LiveOutputEvent | undefined {
  if (chunk?.type === 'text-delta' && typeof chunk.payload?.text === 'string') return { type: 'text', text: chunk.payload.text, role, attempt };
  if ((chunk?.type === 'tool-call' || chunk?.type === 'tool-result') && typeof chunk.payload?.toolName === 'string') {
    const projection = projectTool(chunk.payload.toolName, chunk.payload);
    const state = chunk.type === 'tool-call' ? 'started' : chunk.payload.isError ? 'failed' : 'completed';
    return { type: 'tool', ...projection, state, role, attempt };
  }
  return undefined;
}

/** 通过 Workflow 原生 PubSub 发布易失展示投影，不修改执行事实。 */
export async function publishLiveOutput(pubsub: { publish(channel: string, value: any): unknown } | undefined, runId: string, event: LiveOutputEvent, stepId: string, taskKey?: string): Promise<void> {
  await pubsub?.publish(`workflow.events.v2.${runId}`, { type: 'watch', runId, data: { type: 'live-output.v1', data: event, stepId, taskKey } });
}
