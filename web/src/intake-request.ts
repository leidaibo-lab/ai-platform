/** 页面通信与执行状态分开：HTTP 超时不能被解释为 Workflow 失败。 */
export class IntakeRequestError extends Error {
  /** 只保留公开状态码和脱敏业务提示。 */
  constructor(message: string, public readonly status: number) { super(message); }
}
/** 读请求有界等待；写请求不自动重发，超时后由调用者回读事实。 */
export async function intakeRequest<T>(path: string, body?: unknown): Promise<T> {
  const response = await fetch(`/intake-api/runs${path}`, body === undefined ? { signal: AbortSignal.timeout(15000) } : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const raw = await response.text();
  let data;
  try { data = JSON.parse(raw); }
  catch { throw new IntakeRequestError('服务响应暂不可读，请回读流程状态确认。', response.status); }
  if (!response.ok) throw new IntakeRequestError(response.status === 504 ? '提交连接等待超时，后台执行状态需要另外确认。' : data.error ?? '请求未完成', response.status);
  return data;
}
/** 写响应丢失后只读取权威状态，既不补发批准，也不假定执行失败或成功。 */
export async function reconcileWrite<T extends { status: string }>(read: () => Promise<T>) {
  try {
    const document = await read();
    return { document, uncertain: false, running: document.status === 'running', failed: document.status === 'failed' };
  } catch {
    return { document: undefined, uncertain: true, running: false, failed: false };
  }
}
