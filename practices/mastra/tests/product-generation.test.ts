/** 写作传输与错误边界回归，不使用真实凭据。 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { resolve } from 'node:path';
import { createAgents } from '../src/mastra/agents/index.js';
import { generateProductContent, WRITING_MODEL_SETTINGS } from '../src/intake/product-generation.js';

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
  try {
    const port = (server.address() as { port: number }).port;
    const agents = createAgents({ rootDir: resolve('.'), mode: 'live', databaseUrl: 'file::memory:', port: 4111, modelId: 'openai/gpt-synthetic', apiKey: 'synthetic-not-a-secret', baseUrl: `http://127.0.0.1:${port}/v1` }, { skillsEnabled: false, workspace: false });
    const result = await generateProductContent(agents.productAgent, '合成写作传输验收', 'writing', 'live');
    assert.equal(result.text, '完整合成产品稿'); assert.equal(received.length, 1); assert.equal(received[0].stream, true);
    assert.equal(received[0].max_tokens ?? received[0].max_completion_tokens, WRITING_MODEL_SETTINGS.maxOutputTokens);
  } finally { server.closeAllConnections(); await new Promise<void>(/** 等待独占测试端口关闭。 */done => server.close(/** 关闭不影响其他应用端口。 */() => done())); }
});

for (const scenario of ['partial-error', 'length', 'error']) test(`写作不发布不完整结果：${scenario}`, /** 流错误或截断不能当作完整产品稿。 */async () => {
  const agent = { stream: /** 只替换错误输出，保留封装的发布判定。 */async (_prompt: string, options: any) => {
    assert.equal(options.modelSettings.maxRetries, 0);
    return { getFullOutput: /** 即使存在部分文本也必须拒绝失败。 */async () => ({ text: '部分正文', finishReason: scenario === 'partial-error' ? 'stop' : scenario, error: scenario === 'partial-error' ? new Error('synthetic stream failure') : undefined }) };
  } } as any;
  await assert.rejects(generateProductContent(agent, '合成', 'writing', 'live'));
});
