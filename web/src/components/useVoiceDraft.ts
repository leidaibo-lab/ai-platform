import { useEffect, useRef, useState } from 'react';

interface BrowserRecognition {
  lang: string;
  onstart: (() => void) | null;
  onresult: ((event: { results: ArrayLike<{ isFinal: boolean; 0: { transcript: string } }> }) => void) | null;
  onerror: ((event: { error: string }) => void) | null;
  onend: (() => void) | null;
  start(): void;
  stop(): void;
  abort(): void;
}

type VoiceWindow = Window & {
  SpeechRecognition?: new () => BrowserRecognition;
  webkitSpeechRecognition?: new () => BrowserRecognition;
};

interface VoiceSession {
  recognition: BrowserRecognition;
  timer?: ReturnType<typeof setTimeout>;
}

/** 使用浏览器语音识别收集中文转写，结束后更新当前草稿。 */
export function useVoiceDraft(onText: (text: string) => void, readOnly?: boolean) {
  const active = useRef<VoiceSession | null>(null);
  const result = useRef(onText);
  result.current = onText;
  const [state, setState] = useState<'idle' | 'requesting' | 'recording' | 'processing'>('idle');
  const [message, setMessage] = useState('');

  useEffect(() => {
    if (readOnly) setState('idle');
    /** 切换需求或进入只读状态时停止识别并丢弃迟到的结果。 */
    return () => {
      const session = active.current;
      active.current = null;
      if (!session) return;
      clearTimeout(session.timer);
      session.recognition.abort();
    };
  }, [readOnly]);

  /** 启动浏览器识别，或结束当前录音并等待最终结果。 */
  function toggle() {
    if (readOnly) return;
    if (active.current) {
      clearTimeout(active.current.timer);
      setState('processing');
      active.current.recognition.stop();
      return;
    }
    const browser = window as VoiceWindow;
    const Recognize = browser.SpeechRecognition ?? browser.webkitSpeechRecognition;
    if (!Recognize) {
      setMessage('当前浏览器不支持语音识别，可以继续输入文字。');
      return;
    }
    const recognition = new Recognize();
    const session: VoiceSession = { recognition };
    active.current = session;
    recognition.lang = 'zh-CN';
    let transcript = '';
    setMessage('');
    setState('requesting');

    /** 清理当前识别状态，并保留文本草稿。 */
    function finish(feedback = '') {
      if (active.current !== session) return;
      active.current = null;
      clearTimeout(session.timer);
      setMessage(feedback);
      setState('idle');
    }

    /** 识别开始后显示波形，限制单次录音时长。 */
    recognition.onstart = () => {
      if (active.current !== session) return;
      setState('recording');
      /** 到达录音上限时请求浏览器返回最终结果。 */
      session.timer = setTimeout(() => {
        if (active.current === session) toggle();
      }, 60000);
    };
    /** 浏览器每次返回完整结果列表，按确认片段汇总以避免重复插入。 */
    recognition.onresult = event => {
      if (active.current !== session) return;
      transcript = Array.from(event.results, entry => entry.isFinal ? entry[0].transcript : '').join('').trim();
    };
    /** 识别结束时仅追加有效文字。 */
    recognition.onend = () => {
      if (active.current !== session) return;
      if (transcript) result.current(transcript);
      finish(transcript ? '' : '未识别到文字，可以再试一次。');
    };
    /** 区分浏览器权限、静音与识别服务失败。 */
    recognition.onerror = ({ error }) => {
      if (error === 'not-allowed' || error === 'service-not-allowed' || error === 'audio-capture') {
        finish('无法使用麦克风，请检查浏览器权限和设备。');
      } else {
        finish(error === 'no-speech' ? '未识别到文字，可以再试一次。' : '浏览器语音识别未完成，可以重试或继续输入文字。');
      }
    };
    try { recognition.start(); }
    catch { finish('无法开始语音识别，请检查麦克风权限。'); }
  }

  return { state, message, toggle };
}
