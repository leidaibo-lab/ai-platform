export type ProductStreamEvent = { type: 'text'; text: string; role: string; attempt: number } | { type: 'tool'; action: string; object?: string; callId?: string; state: 'started' | 'completed' | 'failed'; role: string; attempt: number };
export interface ProductStreamView { role: string; attempt: number; entries: Array<{ type: 'text'; text: string } | { type: 'tool'; action: string; object?: string; callId?: string; state: 'started' | 'completed' | 'failed' }>; }

/** 将同一节点的文本增量合并；切换角色或重试时从新片段开始。 */
export function appendProductStream(previous: ProductStreamView | undefined, event: ProductStreamEvent): ProductStreamView {
  const entries = previous?.role === event.role && previous.attempt === event.attempt ? [...previous.entries] : [];
  if (event.type === 'text') {
    const last = entries.at(-1);
    if (last?.type === 'text') entries[entries.length - 1] = { type: 'text', text: (last.text + event.text).slice(-30000) };
    else entries.push({ type: 'text', text: event.text.slice(-30000) });
  } else {
    const index = event.callId ? entries.findIndex(entry => entry.type === 'tool' && entry.callId === event.callId) : -1;
    const old = index >= 0 ? entries[index] : undefined;
    const entry = { type: 'tool' as const, action: event.action, ...(event.object ? { object: event.object } : old?.type === 'tool' && old.object ? { object: old.object } : {}), ...(event.callId ? { callId: event.callId } : {}), state: old?.type === 'tool' && old.state !== 'started' && event.state === 'started' ? old.state : event.state };
    if (index >= 0) entries[index] = entry; else entries.push(entry);
  }
  return { role: event.role, attempt: event.attempt, entries: entries.slice(-100) };
}
