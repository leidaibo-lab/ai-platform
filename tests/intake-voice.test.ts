import { once } from 'node:events';
import { createServer } from 'node:http';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Hono, type Handler } from 'hono';
import { createIntakeVoiceRoute } from '../src/intake/voice.js';
import type { PracticeConfig } from '../src/mastra/config.js';

const path = '/intake-api/voice/transcribe';
const config = { mode: 'fixture', rootDir: process.cwd(), databaseUrl: 'file::memory:', port: 4111, modelId: 'openai/fixture' } satisfies PracticeConfig;

/** 使用应用同款路由和请求上下文运行测试。 */
function createApp(options: PracticeConfig) {
  const route = createIntakeVoiceRoute(options);
  if (!('handler' in route)) throw new Error('语音路由缺少处理器');
  return new Hono().post(path, route.handler as Handler);
}

test('样例录音返回固定文字，并校验来源、格式、空音频和流式大小', async () => {
  const app = createApp(config);
  const headers = { 'Content-Type': 'audio/webm;codecs=opus' };
  const result = await app.request(path, { method: 'POST', headers, body: 'fixture audio' });
  assert.equal(result.status, 200);
  assert.equal(result.headers.get('cache-control'), 'no-store');
  assert.deepEqual(await result.json(), { text: '这是一条样例语音转写。', fixture: true });
  assert.equal((await app.request(path, { method: 'POST', headers: { ...headers, Origin: 'https://other.example' }, body: 'audio' })).status, 403);
  assert.equal((await app.request(path, { method: 'POST', body: 'audio' })).status, 415);
  assert.equal((await app.request(path, { method: 'POST', headers, body: '' })).status, 400);
  assert.equal((await app.request(path, { method: 'POST', headers, body: new Blob([new Uint8Array(5 * 1024 * 1024 + 1)]) })).status, 413);
});

test('真实模式通过 Mastra Voice 调用兼容转写接口，屏蔽提供方错误', async () => {
  const requests: { url?: string; usesConfiguredKey: boolean; body: string }[] = [];
  const upstream = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(chunk);
    requests.push({
      url: request.url,
      usesConfiguredKey: request.headers.authorization === 'Bearer test-only',
      body: Buffer.concat(chunks).toString(),
    });
    if (requests.length === 1) response.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ text: '  新增提醒  ' }));
    else response.writeHead(500, { 'Content-Type': 'application/json' }).end(JSON.stringify({ error: { message: 'internal provider details' } }));
  });
  upstream.listen(0, '127.0.0.1');
  await once(upstream, 'listening');
  try {
    const address = upstream.address();
    assert.ok(address && typeof address !== 'string');
    const app = createApp({ ...config, mode: 'live', apiKey: 'test-only', baseUrl: `http://127.0.0.1:${address.port}/v1` });
    const input = { method: 'POST', headers: { 'Content-Type': 'audio/mp4' }, body: 'test recording' };
    const result = await app.request(path, input);
    assert.equal(result.status, 200);
    assert.deepEqual(await result.json(), { text: '新增提醒', fixture: false });
    assert.equal(requests[0]?.url, '/v1/audio/transcriptions');
    assert.equal(requests[0].usesConfiguredKey, true);
    assert.match(requests[0].body, /whisper-1/);
    assert.match(requests[0].body, /filename="audio\.mp4"/);
    const failure = await app.request(path, input);
    assert.equal(failure.status, 502);
    assert.doesNotMatch(await failure.text(), /internal provider details/);
    assert.equal(requests.length, 2);
  } finally {
    upstream.close();
  }
});
