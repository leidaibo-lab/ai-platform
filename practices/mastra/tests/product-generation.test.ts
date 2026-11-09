import { Mastra } from '@mastra/core';
import { LibSQLStore } from '@mastra/libsql';
/** 写作传输与错误边界回归，不使用真实凭据。 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { resolve } from 'node:path';
import { createAgents } from '../src/mastra/agents/index.js';
import { generateProductContent, WRITING_MODEL_SETTINGS } from '../src/intake/product-generation.js';
import { ProductGenerationFailure, canRetryProductAttempt, classifyProductError, describeProductFailure, isPlanOnlyProductOutput } from '../src/intake/product-failure.js';
import { ContextBudgetError } from '../src/delivery/context-budget.js';
import { HandoffReadError } from '../src/delivery/remote-handoff.js';

test('缺失交接版本在模型调用前明确失败，保留检查点且不自动重试', /** 使用真实资料装配边界，禁止把本地资料错误误报为模型异常。 */async () => {
  let calls = 0;
  const agent = { stream: /** 缺失资料必须在进入模型前被拒绝。 */async () => { calls++; throw new Error('不应调用模型'); } } as any;
  await assert.rejects(generateProductContent(agent, '{}', 'writing', 'live', { root: '/nonexistent-mastra-handoff-regression', receipt: { version: 'remote-handoff.v1', branch: 'codex/workflow/regression', commit: 'a'.repeat(40), files: { 'product/regression/source.md': 'b'.repeat(64) } } }), /** 失败记录只保留固定码；恢复文案区分缺失与完整性故障。 */(error: unknown) => {
    assert.ok(error instanceof ProductGenerationFailure);
    assert.equal(error.details.attempts.length, 1);
    const attempt = error.details.attempts[0];
    assert.equal(attempt.kind, 'material-read');
    assert.equal(attempt.failure.code, 'HANDOFF_VERSION_UNAVAILABLE');
    assert.equal(canRetryProductAttempt(attempt), false);
    assert.match(describeProductFailure(error)!.next!, /无需重建 Run/);
    assert.equal(JSON.stringify(error.details).includes('/nonexistent'), false);
    return true;
  });
  assert.equal(calls, 0);
  const integrity = new ProductGenerationFailure([{ attempt: 1, durationMs: 0, recordedAt: new Date().toISOString(), kind: classifyProductError(new HandoffReadError('HANDOFF_HASH_MISMATCH')), failure: { source: 'handoff-read', code: 'HANDOFF_HASH_MISMATCH' } }]);
  assert.match(describeProductFailure(integrity)!.next!, /禁止跳过校验/);
});

test('真实Mastra写作API发送stream:true、输出上限并正确汇总SSE', /** 本机合成上游检查实际协议，不用mock声明传输已改变。 */async () => {
  const received: any[] = [];
  const server = createServer(/** 仅返回合成OpenAI兼容SSE，不接收用户数据。 */async (req, res) => {
    let body = ''; for await (const chunk of req) body += chunk;
    received.push(JSON.parse(body));
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    const base = { id: 'synthetic', object: 'chat.completion.chunk', created: 1, model: 'gpt-synthetic' };
    res.write(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: { role: 'assistant', content: '完整合成产品稿' }, finish_reason: null }] })}\n\n`);
    res.end(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`);
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const storage = new LibSQLStore({ id: 'synthetic-memory', url: 'file::memory:' });
  try {
    const port = (server.address() as { port: number }).port;
    const agents = createAgents({ rootDir: resolve('.'), mode: 'live', databaseUrl: 'file::memory:', port: 4111, modelId: 'openai/gpt-synthetic', apiKey: 'synthetic-not-a-secret', baseUrl: `http://127.0.0.1:${port}/v1` }, { skillsEnabled: false, workspace: false });
    new Mastra({ agents, storage, logger: false });
    const result = await generateProductContent(agents.productAgent, '合成写作传输验收', 'writing', 'live');
    assert.equal(result.text, '完整合成产品稿'); assert.equal(received.length, 1); assert.equal(received[0].stream, true);
    assert.equal(received[0].max_tokens ?? received[0].max_completion_tokens, WRITING_MODEL_SETTINGS.maxOutputTokens);
  } finally { await storage.close(); server.closeAllConnections(); await new Promise<void>(/** 等待独占测试端口关闭。 */done => server.close(/** 关闭不影响其他应用端口。 */() => done())); }
});

for (const scenario of ['partial-error', 'length', 'error']) test(`写作不发布不完整结果：${scenario}`, /** 流错误或截断不能当作完整产品稿。 */async () => {
  const agent = { stream: /** 只替换错误输出，保留封装的发布判定。 */async (_prompt: string, options: any) => {
    assert.equal(options.modelSettings.maxRetries, 0);
    return { getFullOutput: /** 即使存在部分文本也必须拒绝失败。 */async () => ({ text: '部分正文', finishReason: scenario === 'partial-error' ? 'stop' : scenario, error: scenario === 'partial-error' ? new Error('synthetic stream failure') : undefined }) };
  } } as any;
  await assert.rejects(generateProductContent(agent, '合成', 'writing', 'live'));
});

test('产品写作仅对临时上游故障重试一次并记录脱敏证据', /** 重试复用只读输入，不跨越产品节点或泄露SDK错误。 */async () => {
  let calls = 0;
  const agent = { stream: /** 合成503后返回完整终态。 */async () => {
    if (++calls === 1) throw Object.assign(new Error('private response body'), { name: 'AI_APICallError', statusCode: 503, url: 'https://private.invalid/?key=secret' });
    return { getFullOutput: /** 结束正文来自最后模型步骤。 */async () => ({ text: 'first-step plan plus full product', finishReason: 'stop', steps: [{ text: '完整产品需求正文', finishReason: 'stop' }], error: undefined }) };
  } } as any;
  const result = await generateProductContent(agent, '合成', 'writing', 'live');
  assert.equal(calls, 2); assert.equal(result.text, '完整产品需求正文');
  assert.equal(result.generation.attempts, 2); assert.equal(result.generation.failures[0].failure.httpStatus, 503);
  assert.equal(JSON.stringify(result.generation).includes('private'), false);
  assert.equal(JSON.stringify(result.generation).includes('secret'), false);
});

test('中间角色拒绝把计划句或工具循环保存为已完成产物', /** 工具调用结束和“接下来我会”都不是角色交付。 */async () => {
  assert.equal(isPlanOnlyProductOutput('我会用需求测试场景检查覆盖，再检查风险。'), true);
  assert.equal(isPlanOnlyProductOutput('正常路径：用户提交需求；失败路径：输入不完整时拒绝推进。'), false);
  const agent = { generate: /** 模拟调用停止于工具调用，没有最终答案。 */async () => ({ text: '我会检查规则。', finishReason: 'tool-calls', steps: [{ text: '我会检查规则。', finishReason: 'tool-calls' }] }) } as any;
  await assert.rejects(generateProductContent(agent, '合成', 'closure', 'fixture'), (error: unknown) => {
    assert.ok(error instanceof ProductGenerationFailure);
    const summary = describeProductFailure(error);
    assert.equal(summary?.reason, '工具调用循环尚未产生最终正文');
    assert.equal(summary?.details[0].includes('tool-calls'), true);
    return true;
  });
});

test('上下文预算故障不重试并给出明确原因', /** 扩大重试不会改变固定资料预算，必须保留失败事实。 */() => {
  const error = new ContextBudgetError('provider', 2000, 1000);
  assert.equal(classifyProductError(error), 'context-budget');
  assert.equal(canRetryProductAttempt({ attempt: 1, durationMs: 50, recordedAt: new Date().toISOString(), kind: 'context-budget', failure: { source: 'unknown' } }), false);
});

test('旧预算故障可解释且无需升档恢复', /** 预算恢复显式扩容且不触碰权限；旧快照说明证据缺口。 */async () => {
  const error = new ContextBudgetError('read', 50000, 48000);
  const agent = { generate: /** 触发合成资料预算故障，不调用网络模型。 */async () => { throw error; } } as any;
  await assert.rejects(generateProductContent(agent, '合成', 'closure', 'live'), (failure: unknown) => {
    assert.ok(failure instanceof ProductGenerationFailure);
    assert.deepEqual(failure.details.attempts[0].budget, { resource: 'read', usedBytes: 50000, limitBytes: 48000 });
    const summary = describeProductFailure(failure, 0);
    assert.equal(summary?.additionalContextLevel, undefined);
    assert.match(summary!.details[0], /资料读取，已用 48\.8 KiB \/ 上限 46\.9 KiB/);
    assert.match(summary!.next, /资料预算门槛已移除/);
    const capped = describeProductFailure(failure, 4);
    assert.equal(capped?.additionalContextLevel, undefined);
    assert.equal(capped?.retryBlocked, false);
    assert.match(capped!.next, /无需确认资料升档/);
    const legacy = describeProductFailure({ name: 'ProductGenerationFailure', details: { version: 'product-generation-failure.v1', attempts: [{ attempt: 1, durationMs: 100, recordedAt: new Date().toISOString(), kind: 'context-budget', failure: { source: 'unknown' } }] } }, 0);
    assert.match(legacy!.details[0], /旧记录未保存具体预算项和用量/);
    return true;
  });
});

test('旧写作失败只说明已保存证据能证明的内容', /** 历史快照缺少结束状态时不得推断超时、额度或具体上游故障。 */() => {
  const legacy = describeProductFailure({ name: 'Error', message: '产品写作未正常完成；未发布部分正文' });
  assert.equal(legacy?.reason, '产品写作未正常结束，未发布部分正文');
  assert.match(legacy!.details[0], /无法确认是流中断、工具循环还是上游异常/);
  assert.match(legacy!.next, /历史记录保持原样/);
});
