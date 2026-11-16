import { useChat } from '@ai-sdk/react';
import { DefaultChatTransport } from 'ai';
import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import {
  ArrowUp,
  Square,
  Sparkles,
  RotateCcw,
  MessageSquareText,
} from 'lucide-react';
import { readingFetch, type ReviewDocument } from '../lib';
import { Message, MessageContent } from './ai-elements/message';
import { Markdown } from './Markdown';
import { RevisionPanel } from './RevisionPanel';
import { readingRequest } from '../chat-request';

/** 对话生命周期绑定 Run/hash；父组件切换版本时卸载并中止当前流。 */
export function ReadingAssistant({
  document,
  pageBusy,
  onBusy,
  onApplied,
}: {
  document: ReviewDocument;
  pageBusy: boolean;
  onBusy: (busy: boolean) => void;
  onApplied: (result: ReviewDocument) => void;
}) {
  const hash = document.artifact!.hash;
  // 默认 transport 只传聊天消息和文档版本，不将正文或服务端指令交给客户端指定。
  const transport = useMemo(
    () =>
      new DefaultChatTransport({
        api: `/review-api/runs/${encodeURIComponent(document.runId)}/chat`,
        fetch: readingFetch,
        // 多轮只发送可见文字，避免 SDK 步骤 part 与服务端输入边界冲突。
        prepareSendMessagesRequest: ({ messages }) => ({
          body: readingRequest(messages, hash),
        }),
      }),
    [document.runId, hash],
  );
  const {
    messages,
    sendMessage,
    status,
    stop,
    error,
    setMessages,
    clearError,
  } = useChat({ transport });
  const [input, setInput] = useState('');
  const end = useRef<HTMLDivElement>(null);
  const busy = status === 'submitted' || status === 'streaming';
  // 新增消息时滚到末尾，流式 token 更新不抢夺文档区的阅读位置。
  useEffect(() => {
    end.current?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }, [messages.length, status]);
  // 离开该文档时停止请求，避免其他 Run 的回答混入当前对话。
  useEffect(() => {
    // 卸载清理只终止当前只读请求。
    return () => {
      void stop();
    };
  }, [stop]);
  /** 提交纯文本问题；助手的回答不能修改产品正文或审批表单。 */
  async function ask(text: string) {
    if (!text.trim() || busy || pageBusy) return;
    clearError();
    setInput('');
    await sendMessage({ text: text.trim() });
  }
  /** 表单和快捷问题复用同一 SDK 消息入口。 */
  function submit(event: FormEvent) {
    event.preventDefault();
    void ask(input);
  }
  /** 主动重置本地问答，不删除任何 Workflow 事实。 */
  function reset() {
    if (!busy) {
      setMessages([]);
      clearError();
    }
  }
  /** 快捷问题保持用户可见，不自动发起模型请求。 */
  function askCoverage() {
    void ask(
      '这份产品文档有哪些边界或验收覆盖需要我重点检查？请引用正文依据。',
    );
  }
  /** 突出影响实施的未决选择，不让模型替用户定规则。 */
  function askQuestions() {
    void ask('哪些未决问题会影响实现或验收？请区分正文已有规则和你的建议。');
  }
  return (
    <aside className="assistant-panel" aria-label="产品文档阅读助手">
      <div className="assistant-heading">
        <span className="assistant-symbol">
          <Sparkles size={18} />
        </span>
        <div>
          <h2>阅读助手</h2>
          <span>围绕当前文档提问</span>
        </div>
        <button
          className="icon-button"
          onClick={reset}
          disabled={busy || pageBusy || !messages.length}
          title="清空本地对话"
          aria-label="清空本地对话"
        >
          <RotateCcw size={15} />
        </button>
      </div>
      <div className="assistant-context">
        <span className="status-dot" />
        已关联当前产品稿 <code>{hash.slice(0, 8)}</code>
      </div>
      <div className="assistant-messages" aria-live="polite" aria-busy={busy}>
        {!messages.length && (
          <div className="assistant-welcome">
            <MessageSquareText size={26} />
            <h3>一起把需求读清楚</h3>
            <p>
              解释验收条件、梳理未决问题，
              <br />
              帮助你形成自己的审阅意见。
            </p>
            <button className="question-button" onClick={askCoverage}>
              检查边界与验收覆盖 <span>↗</span>
            </button>
            <button className="question-button" onClick={askQuestions}>
              梳理影响实现的未决项 <span>↗</span>
            </button>
          </div>
        )}
        {/* 每条 SDK 消息按角色排版，只显示文本，工具或系统内容不进入阅读区。 */}
        {messages.map((message) => (
          <Message
            key={message.id}
            align={message.role === 'user' ? 'end' : 'start'}
          >
            <MessageContent>
              <span className="message-author">
                {message.role === 'user' ? '你' : '阅读助手'}
              </span>
              <div className={`message-bubble ${message.role}`}>
                {/* SDK 流中的文本 part 复用 Markdown 渲染。 */}
                {message.parts.map((part, index) =>
                  part.type === 'text' ? (
                    <Markdown
                      key={index}
                      streaming={busy && message.role === 'assistant'}
                    >
                      {part.text}
                    </Markdown>
                  ) : null,
                )}
              </div>
            </MessageContent>
          </Message>
        ))}
        {status === 'submitted' && (
          <p className="thinking">
            <span />
            正在阅读当前文档…
          </p>
        )}
        {error && (
          <div role="alert" className="assistant-error">
            {error.message || '暂时无法回答，请稍后再试。'}
          </div>
        )}
        <div ref={end} />
      </div>
      <form className="assistant-composer" onSubmit={submit}>
        <textarea
          aria-label="向阅读助手提问"
          placeholder="对这份需求，有什么想了解的？"
          value={input}
          maxLength={8000}
          // 受控输入仅保存本地问题草稿。
          onChange={(event) => setInput(event.target.value)}
          disabled={busy || pageBusy}
        />
        <div>
          <span>回答仅供参考，决定由你作出</span>
          {busy ? (
            <button
              className="send-button"
              type="button"
              onClick={stop}
              aria-label="停止回答"
            >
              <Square size={14} />
            </button>
          ) : (
            <button
              className="send-button"
              disabled={pageBusy || !input.trim() || messages.length >= 20}
              aria-label="发送问题"
            >
              <ArrowUp size={17} />
            </button>
          )}
        </div>
        {messages.length >= 20 && (
          <p className="muted">本轮对话已达上限，请清空后继续。</p>
        )}
      </form>
      <RevisionPanel
        document={document}
        messages={messages}
        chatBusy={busy}
        pageBusy={pageBusy}
        onBusy={onBusy}
        onApplied={onApplied}
      />
      <p className="assistant-footnote">提案须人工应用 · 新稿须重新确认</p>
    </aside>
  );
}
