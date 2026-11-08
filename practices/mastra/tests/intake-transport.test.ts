/** 模拟提交连接超时但后端继续运行，验证只读对账而非重复恢复。 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { intakeRequest, IntakeRequestError, reconcileWrite } from '../web/src/intake-request.js';

test('HTTP 504 不等于执行失败：只读回读 running，不重发 POST', /** 使用独立fetch stub模拟超时响应，不等待真实三分钟。 */async () => {
  const original = globalThis.fetch; const methods: string[] = [];
  globalThis.fetch = (/** 第一次写超时，第二次读返回保存状态。 */async (_url: any, init?: RequestInit) => { methods.push(init?.method ?? 'GET'); return init?.method === 'POST' ? new Response(JSON.stringify({ error: 'Gateway Timeout' }), { status: 504 }) : Response.json({ status: 'running' }); }) as typeof fetch;
  try {
    await assert.rejects(intakeRequest('/test/respond', { decision: 'approve' }), /** 不泄漏HTML或原始服务器错误。 */(error: unknown) => error instanceof IntakeRequestError && error.status === 504);
    const result = await reconcileWrite(/** 只读同一个Run。 */() => intakeRequest<{ status: string }>('/test'));
    assert.equal(result.running, true); assert.equal(result.failed, false); assert.deepEqual(methods, ['POST', 'GET']);
  } finally { globalThis.fetch = original; }
});

test('读取失败保留未知状态；只有存储 failed 才判定执行失败', /** 连接故障不伪装成业务终态。 */async () => {
  const unknown = await reconcileWrite(/** 模拟读连接暂不可达。 */async () => { throw new TypeError('network'); });
  assert.equal(unknown.uncertain, true); assert.equal(unknown.failed, false);
  const failed = await reconcileWrite(/** 明确的原生失败事实。 */async () => ({ status: 'failed' }));
  assert.equal(failed.failed, true); assert.equal(failed.running, false);
  const pending = await reconcileWrite(/** 原请求虽断开，但后台已经到达下一人工关口。 */async () => ({ status: 'suspended' }));
  assert.equal(pending.uncertain, false); assert.equal(pending.failed, false);
});
