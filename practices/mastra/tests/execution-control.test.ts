import { Hono, type Handler } from 'hono';
import { createIntakeRoutes } from '../src/intake/routes.js';
/** 实际取消信号、重试和原生嵌套Workflow回归，不使用业务Run。 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Mastra } from '@mastra/core';
import { createStep, createWorkflow } from '@mastra/core/workflows';
import { LibSQLStore } from '@mastra/libsql';
import { z } from 'zod';
import { beginExecution, cancelExecution, readExecution } from '../src/intake/execution-control.js';
import { generateProductContent } from '../src/intake/product-generation.js';

test('旧token和其他Run不能取消，重复取消不重复写原生状态', /** 版本和归属检查在副作用前执行。 */async () => {
  const id = randomUUID(); const observation = beginExecution(id, 'writing'); let calls = 0;
  const cancel = /** 模拟原生取消并计数。 */async () => { calls++; };
  await assert.rejects(cancelExecution(id, randomUUID(), cancel));
  await assert.rejects(cancelExecution(randomUUID(), readExecution(id)!.token, cancel));
  assert.equal(calls, 0);
  await cancelExecution(id, readExecution(id)!.token, cancel);
  assert.equal(readExecution(id)!.phase, 'canceling');
  await cancelExecution(id, readExecution(id)!.token, cancel);
  assert.equal(calls, 1); assert.equal(observation.signal.aborted, true);
  observation.finish(); assert.equal(readExecution(id)!.phase, 'stopped');
});

test('模型忽略信号并迟到返回时仍拒绝交付', /** 使用真实生成Adapter，确保不是仅浏览器断开。 */async () => {
  const id = randomUUID(); let release!: () => void;
  const wait = new Promise<void>(/** 控制合成模型返回时点。 */resolve => { release = resolve; });
  const agent = { generate: /** 故意忽略信号模拟上游迟到。 */async (_prompt: string, options: any) => { assert.ok(options.abortSignal); await wait; return { finishReason: 'stop', steps: [{ text: '完整正文' }] }; } } as any;
  const result = generateProductContent(agent, '{}', 'closure', 'live', undefined, 0, { runId: id, abortSignal: new AbortController().signal });
  const rejected = assert.rejects(result, { name: 'AbortError' });
  await cancelExecution(id, readExecution(id)!.token, /** 取消原生状态的测试替身。 */async () => {});
  release(); await rejected; assert.equal(readExecution(id)!.phase, 'stopped');
});

test('重试退避期间取消不会开始第二次模型尝试', /** 真实503分类进入退避，取消必须立即停止等待。 */async () => {
  const id = randomUUID(); let calls = 0;
  const agent = { generate: /** 合成可重试上游错误，不输出原始响应。 */async () => { calls++; throw Object.assign(new Error('private'), { statusCode: 503 }); } } as any;
  const pending = generateProductContent(agent, '{}', 'closure', 'live', undefined, 0, { runId: id, abortSignal: new AbortController().signal });
  const rejected = assert.rejects(pending);
  await new Promise<void>(/** 等待已排队的失败处理进入退避。 */resolve => setTimeout(resolve, 20));
  assert.equal(readExecution(id)!.phase, 'retrying'); assert.equal(readExecution(id)!.failures[0].failure.httpStatus, 503);
  await cancelExecution(id, readExecution(id)!.token, /** 独立测试无持久化写入。 */async () => {});
  await rejected; assert.equal(calls, 1); assert.equal(readExecution(id)!.phase, 'stopped');
});

test('完成后不能取消下一阶段，观察快照不可变', /** 防止旧确认框影响后续执行。 */async () => {
  const id = randomUUID(); const first = beginExecution(id, 'coordinator'); const old = readExecution(id)!;
  old.role = 'tampered'; assert.equal(readExecution(id)!.role, 'coordinator');
  first.finish(); await assert.rejects(cancelExecution(id, old.token, /** 不应执行原生写入。 */async () => { throw new Error('must not call'); }));
  const next = beginExecution(id, 'closure');
  await assert.rejects(cancelExecution(id, old.token, /** 旧版本不调用原生取消。 */async () => {}));
  assert.equal(next.signal.aborted, false); next.finish();
});

test('原生嵌套Run取消落库且不执行下游', /** 真实Mastra和LibSQL验证createRun复用及嵌套信号行为。 */async () => {
  const id = randomUUID(); let entered!: () => void; let downstream = 0;
  const ready = new Promise<void>(/** 生成开始后再取消。 */resolve => { entered = resolve; });
  const model = createStep({ id: 'model', inputSchema: z.object({}), outputSchema: z.object({}),
    execute: /** 等待真实信号，模拟正在运行的模型请求。 */async ({ abortSignal }) => {
      const observation = beginExecution(id, 'writing', abortSignal); entered();
      try { await new Promise<void>(/** 本地取消必须传达至此。 */(_resolve, reject) => { observation.signal.addEventListener('abort', /** 模拟模型退出。 */() => reject(new DOMException('stop', 'AbortError')), { once: true }); }); return {}; }
      finally { observation.finish(); }
    } });
  const child = createWorkflow({ id: 'child', inputSchema: z.object({}), outputSchema: z.object({}) }).then(model).commit();
  const tail = createStep({ id: 'tail', inputSchema: z.object({}), outputSchema: z.object({}), execute: /** 取消后禁止进入下游。 */async () => { downstream++; return {}; } });
  const workflow = createWorkflow({ id: 'root', inputSchema: z.object({}), outputSchema: z.object({}) }).then(child).then(tail).commit();
  const storage = new LibSQLStore({ id: 'cancel-test', url: 'file::memory:' });
  new Mastra({ workflows: { workflow }, storage, logger: false });
  try {
    const router = new Hono();
    for (const route of createIntakeRoutes(workflow as any, 'fixture')) if ('handler' in route) router.on(route.method, route.path, route.handler as Handler);
    const pending = router.request('/intake-api/runs', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ runId: id, brief: '独立取消测试' }) });
    await ready;
    const path = `/intake-api/runs/${id}/cancel`;
    const body = JSON.stringify({ token: readExecution(id)!.token });
    assert.equal((await router.request(path, { method: 'POST', headers: { origin: 'https://untrusted.example', 'Content-Type': 'application/json' }, body })).status, 409);
    const canceled = await router.request(path, { method: 'POST', headers: { origin: 'http://127.0.0.1:4112', 'Content-Type': 'application/json' }, body });
    assert.equal(canceled.status, 200);
    assert.equal((await pending).status, 200); assert.equal(downstream, 0); assert.equal(readExecution(id)!.phase, 'stopped');
    assert.equal((await workflow.getWorkflowRunById(id))!.status, 'canceled');
  } finally { await storage.close(); }
});
