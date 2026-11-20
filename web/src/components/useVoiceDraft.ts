import { useEffect, useRef, useState } from 'react';

interface Recording {
  controller: AbortController;
  recorder?: MediaRecorder;
  stream?: MediaStream;
  timer?: ReturnType<typeof setTimeout>;
}

/** 关闭录音计时器和麦克风。 */
function release(recording: Recording) {
  clearTimeout(recording.timer);
  recording.stream?.getTracks().forEach(track => track.stop());
}

/** 请求同源转写服务，返回可编辑文本和样例标识。 */
async function transcribe(audio: Blob, signal: AbortSignal): Promise<{ text: string; fixture: boolean }> {
  const response = await fetch('/intake-api/voice/transcribe', {
    method: 'POST',
    body: audio,
    signal: AbortSignal.any([signal, AbortSignal.timeout(40000)]),
  });
  const result = await response.json().catch(() => null);
  if (!response.ok || typeof result?.text !== 'string' || !result.text.trim()) {
    throw new Error(typeof result?.error === 'string' ? result.error : '语音转写未完成，请稍后重试。');
  }
  return result;
}

/** 管理一次录音和转写，切离需求后释放麦克风并丢弃迟到的结果。 */
export function useVoiceDraft(onText: (text: string) => void) {
  const active = useRef<Recording | null>(null);
  const result = useRef(onText);
  result.current = onText;
  const [state, setState] = useState<'idle' | 'requesting' | 'recording' | 'processing'>('idle');
  const [message, setMessage] = useState('');
  const supported = typeof MediaRecorder !== 'undefined' && !!navigator.mediaDevices?.getUserMedia;

  useEffect(() => {
    /** 离开输入区时取消上传及录音。 */
    return () => {
      const recording = active.current;
      active.current = null;
      if (!recording) return;
      recording.controller.abort();
      release(recording);
    };
  }, []);

  /** 结束录音并等待浏览器交付最后一段音频。 */
  function stop(recording: Recording) {
    if (recording.recorder?.state !== 'recording') return;
    setState('processing');
    recording.recorder.stop();
    release(recording);
  }

  /** 请求麦克风权限，结束录音后把转写结果交给当前草稿。 */
  async function toggle() {
    if (active.current) {
      stop(active.current);
      return;
    }
    const mime = supported && ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4'].find(type => MediaRecorder.isTypeSupported(type));
    if (!mime) {
      setMessage('当前浏览器无法录音，请使用支持 WebM 或 MP4 录音的浏览器，并从本机或 HTTPS 页面打开。');
      return;
    }
    const recording = { controller: new AbortController() } as Recording;
    active.current = recording;
    setMessage('');
    setState('requesting');

    /** 结束当前会话并展示反馈。 */
    function finish(text: string = '') {
      if (active.current !== recording) return;
      active.current = null;
      release(recording);
      setMessage(text);
      setState('idle');
    }

    try {
      recording.stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      if (active.current !== recording) {
        release(recording);
        return;
      }
      const recorder = new MediaRecorder(recording.stream, { mimeType: mime });
      recording.recorder = recorder;
      const chunks: Blob[] = [];
      /** 收集浏览器产生的音频片段。 */
      recorder.ondataavailable = event => { if (event.data.size) chunks.push(event.data); };
      /** 录制失败时释放设备。 */
      recorder.onerror = () => finish('录音未完成，请重试。');
      /** 汇总音频并回填，切换需求后忽略旧响应。 */
      recorder.onstop = async () => {
        if (active.current !== recording) return;
        release(recording);
        setState('processing');
        const audio = new Blob(chunks, { type: recorder.mimeType || mime });
        if (!audio.size) return finish('录音为空，请重新录制。');
        if (audio.size > 5 * 1024 * 1024) return finish('录音超过 5 MB，请缩短后重试。');
        try {
          const data = await transcribe(audio, recording.controller.signal);
          if (active.current !== recording) return;
          result.current(data.text.trim());
          finish(data.fixture ? '已填入固定样例转写。' : '');
        } catch (error) {
          finish(error instanceof Error && error.name === 'Error' ? error.message : '语音转写未完成，请稍后重试。');
        }
      };
      recorder.start();
      setState('recording');
      recording.timer = setTimeout(() => stop(recording), 60000);
    } catch {
      finish('无法开始录音，请检查麦克风权限和设备。');
    }
  }

  return { state, message, toggle };
}
