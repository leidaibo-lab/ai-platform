import { Readable } from 'node:stream';
import { OpenAIVoice } from '@mastra/voice-openai';
import { registerApiRoute } from '@mastra/core/server';
import type { PracticeConfig } from '../mastra/config.js';

const maxAudioBytes = 5 * 1024 * 1024;

/** 读取有界的原始音频，客户端未提供长度时同样执行上限。 */
async function readAudio(body: ReadableStream<Uint8Array>, signal: AbortSignal) {
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  /** 请求终止或超时时结束读取。 */
  const cancel = () => { void reader.cancel().catch(() => {}); };
  if (signal.aborted) cancel();
  signal.addEventListener('abort', cancel, { once: true });
  try {
    while (true) {
      const { done, value } = await reader.read();
      signal.throwIfAborted();
      if (done) return Buffer.concat(chunks, size);
      size += value.byteLength;
      if (size > maxAudioBytes) return undefined;
      chunks.push(value);
    }
  } finally {
    signal.removeEventListener('abort', cancel);
    cancel();
    reader.releaseLock();
  }
}

/** 装配工作台语音转写，音频和转写文本仅在本次请求中流转。 */
export function createIntakeVoiceRoute(config: PracticeConfig) {
  const fixture = config.mode === 'fixture';
  const voice = !fixture && config.apiKey ? new OpenAIVoice({
    speechModel: { apiKey: config.apiKey },
    listeningModel: {
      apiKey: config.apiKey,
      name: 'whisper-1',
      options: { baseURL: config.baseUrl ?? 'https://api.openai.com/v1', timeout: 25000, maxRetries: 0 },
    },
  }) : undefined;
  let busy = false;
  return registerApiRoute('/intake-api/voice/transcribe', {
    method: 'POST',
    /** 校验浏览器来源和短录音格式后调用 Mastra Voice。 */
    handler: async c => {
      c.header('Cache-Control', 'no-store');
      const request = c.req.raw;
      const origin = request.headers.get('origin');
      if (origin && ![new URL(request.url).origin, 'http://127.0.0.1:4112'].includes(origin)) {
        return c.json({ error: '请从工作台页面使用语音输入。' }, 403);
      }
      const mime = request.headers.get('content-type')?.split(';', 1)[0].trim().toLowerCase();
      const filetype = mime === 'audio/webm' ? 'webm' : mime === 'audio/mp4' ? 'mp4' : undefined;
      if (!filetype) return c.json({ error: '语音录音仅支持 WebM 和 MP4 格式。' }, 415);
      if (!fixture && !voice) return c.json({ error: '服务端尚未配置语音转写。' }, 503);
      if (Number(request.headers.get('content-length')) > maxAudioBytes) return c.json({ error: '录音超过 5 MB，请缩短后重试。' }, 413);
      if (!request.body) return c.json({ error: '未收到录音，请重新录制。' }, 400);
      if (busy) return c.json({ error: '语音转写忙，请稍后重试。' }, 429);
      busy = true;
      try {
        const audio = await readAudio(request.body, AbortSignal.any([request.signal, AbortSignal.timeout(10000)]));
        if (!audio) return c.json({ error: '录音超过 5 MB，请缩短后重试。' }, 413);
        if (!audio.length) return c.json({ error: '未收到录音，请重新录制。' }, 400);
        const text = voice ? (await voice.listen(Readable.from([audio]), { filetype })).trim().slice(0, 12000) : '这是一条样例语音转写。';
        if (!text) return c.json({ error: '未识别到文字，请重新录制。' }, 422);
        return c.json({ text, fixture });
      } catch {
        return c.json({ error: '语音转写未完成，请稍后重试。' }, 502);
      } finally {
        busy = false;
      }
    },
  });
}
