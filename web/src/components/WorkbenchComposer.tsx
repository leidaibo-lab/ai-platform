import { ArrowUp, Mic, Plus, X } from 'lucide-react';
import { useEffect, useLayoutEffect, useRef, useState, type ClipboardEvent, type DragEvent, type KeyboardEvent } from 'react';

import { useVoiceDraft } from './useVoiceDraft';

interface Props {
  value: string;
  change: (value: string) => void;
  send: () => void;
  disabled?: boolean;
  readOnly?: boolean;
  maxLength?: number;
}

/** 通用输入区，语音转写只修改草稿，图片仅在本页预览。 */
export function WorkbenchComposer({ value, change, send, disabled, readOnly, maxLength = 12000 }: Props) {
  const input = useRef<HTMLTextAreaElement>(null);
  const picker = useRef<HTMLInputElement>(null);
  const urls = useRef(new Set<string>());
  const [images, setImages] = useState<{ name: string; url: string }[]>([]);
  const [message, setMessage] = useState('');
  /** 在当前草稿末尾追加转写内容，保留录音期间的编辑。 */
  const voice = useVoiceDraft(text => {
    change(`${value}${value.trim() ? '\n' : ''}${text}`.slice(0, maxLength));
    input.current?.focus();
  }, readOnly);
  useLayoutEffect(() => {
    const field = input.current;
    if (!field) return;
    field.style.height = 'auto';
    field.style.height = `${field.scrollHeight}px`;
  }, [value]);
  useEffect(() => {
    /** 退出草稿时释放本地预览。 */
    return () => {
      for (const url of urls.current) URL.revokeObjectURL(url);
    };
  }, []);
  /** 添加受支持的本机图片，排除脚本型图片格式。 */
  function add(files: Iterable<File>) {
    const next = [...images];
    for (const file of files) {
      if (next.length >= 4) { setMessage('最多预览 4 张图片。'); break; }
      if (!/^image\/(png|jpeg|webp|gif|avif)$/.test(file.type) || !file.size || file.size > 10 * 1024 * 1024) {
        setMessage('请选择 10 MB 以内的 PNG、JPEG、WebP、GIF 或 AVIF 图片。');
        continue;
      }
      const url = URL.createObjectURL(file);
      urls.current.add(url);
      next.push({ name: file.name, url });
    }
    setImages(next);
  }
  /** 移除当前截图并释放其浏览器引用。 */
  function remove(url: string) {
    URL.revokeObjectURL(url);
    urls.current.delete(url);
    const next = images.filter(item => item.url !== url);
    setImages(next);
  }
  const canSend = !disabled && voice.state === 'idle' && !!value.trim() && value.trim().length <= maxLength;
  /** Enter 发送，同时保留换行和输入法选词。 */
  function keyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key !== 'Enter' || event.shiftKey || event.nativeEvent.isComposing || event.keyCode === 229) return;
    event.preventDefault();
    if (!event.repeat && canSend) submitText();
  }
  /** 清理仅供预览的附件并通过明确动作提交文字。 */
  function submitText() {
    if (!canSend) return;
    for (const image of images) URL.revokeObjectURL(image.url);
    urls.current.clear();
    setImages([]);
    setMessage('');
    send();
  }
  /** 从剪贴板读取图片，其余内容沿用原生粘贴。 */
  function paste(event: ClipboardEvent<HTMLTextAreaElement>) {
    if (!event.clipboardData.files.length) return;
    event.preventDefault();
    add(event.clipboardData.files);
  }
  /** 处理明确拖入输入区的本地文件。 */
  function drop(event: DragEvent<HTMLFormElement>) {
    if (!event.dataTransfer.files.length) return;
    event.preventDefault();
    add(event.dataTransfer.files);
  }
  return <form className="workbench-composer" aria-label="需求输入区" onSubmit={event => { event.preventDefault(); submitText(); }} onDragOver={event => { if (event.dataTransfer.types.includes('Files')) event.preventDefault(); }} onDrop={drop}>
    {!!images.length && <><div className="workbench-previews">{images.map(image => <figure key={image.url}><img src={image.url} alt={image.name} /><button type="button" aria-label={`移除 ${image.name}`} onClick={() => remove(image.url)}><X size={13} /></button></figure>)}</div><small>图片仅供本页预览，提交时只发送文字。</small></>}
    <textarea ref={input} aria-label="输入内容" placeholder="输入内容…" rows={2} maxLength={maxLength} readOnly={readOnly} value={value} onChange={event => change(event.target.value)} onKeyDown={keyDown} onPaste={paste} />
    {(message || voice.message || voice.state !== 'idle') && <small role="status">{({ idle: voice.message || message, requesting: '正在请求麦克风权限…', recording: '正在录音，点击结束并转写（最长 60 秒）', processing: '正在转写…' })[voice.state]}</small>}
    <div className="workbench-composer-actions">
      <input hidden ref={picker} type="file" accept="image/png,image/jpeg,image/webp,image/gif,image/avif" multiple onChange={event => { add(event.target.files ?? []); event.target.value = ''; }} />
      <button type="button" title="预览截图" aria-label="预览截图" onClick={() => picker.current?.click()}><Plus size={17} /></button>
      <button className="workbench-mic" type="button" title="使用浏览器语音识别，音频可能由浏览器语音服务处理" aria-label={voice.state === 'recording' ? '结束录音并转写' : '语音输入'} aria-pressed={voice.state === 'recording'} disabled={readOnly || voice.state === 'requesting' || voice.state === 'processing'} onClick={() => { setMessage(''); voice.toggle(); }}>{voice.state === 'recording' ? <span className="workbench-wave" aria-hidden="true"><i /><i /><i /><i /><i /></span> : <Mic size={16} />}</button>
      <button className="primary workbench-send" type="submit" aria-label="发送" title="发送 · Enter" disabled={!canSend}><ArrowUp size={18} /></button>
    </div>
  </form>;
}
