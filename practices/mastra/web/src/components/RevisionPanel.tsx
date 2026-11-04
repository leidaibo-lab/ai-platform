import { useEffect, useMemo, useRef, useState } from 'react';
import type { UIMessage } from 'ai';
import { diffLines } from 'diff';
import { FilePenLine, LoaderCircle, X } from 'lucide-react';
import { api, type ReviewDocument } from '../lib';
import { readingRequest } from '../chat-request';
import { Markdown } from './Markdown';

/** 提案由服务端快照持有，页面仅显示，不接受客户端编辑后直接应用。 */
interface Proposal {
  proposalId: string;
  sourceRunId: string;
  sourceHash: string;
  originalContent: string;
  content: string;
  confirmedDecisions: string;
  mode: 'live' | 'fixture';
}
interface RevisionPanelProps {
  document: ReviewDocument;
  messages: UIMessage[];
  chatBusy: boolean;
  pageBusy: boolean;
  onBusy: (busy: boolean) => void;
  onApplied: (result: ReviewDocument) => void;
}

/** 将明确结论转成持久提案，并让负责人比较后另起一轮产品确认。 */
export function RevisionPanel({
  document,
  messages,
  chatBusy,
  pageBusy,
  onBusy,
  onApplied,
}: RevisionPanelProps) {
  const [decisions, setDecisions] = useState('');
  const [appliedBy, setAppliedBy] = useState('');
  const [proposal, setProposal] = useState<Proposal>();
  const [error, setError] = useState('');
  const [working, setWorking] = useState<'generate' | 'apply' | 'load'>();
  const [view, setView] = useState<'diff' | 'document'>('diff');
  const dialog = useRef<HTMLDialogElement>(null);
  const disabled = pageBusy || chatBusy || !!working;
  // 使用成熟的逐行差异算法；限定计算时间，大文档退回完整正文比较。
  const differences = useMemo(
    () =>
      proposal
        ? diffLines(proposal.originalContent, proposal.content, {
            timeout: 300,
          })
        : [],
    [proposal],
  );
  /** 预览位置写入 URL，刷新后可以恢复同一提案。 */
  function proposalUrl(id?: string) {
    const url = new URL(window.location.href);
    if (id) url.searchParams.set('proposal', id);
    else url.searchParams.delete('proposal');
    window.history.replaceState(null, '', url);
  }
  // 按深链接恢复提案；不自动再次调用模型或重复应用。
  useEffect(() => {
    const id = new URLSearchParams(window.location.search).get('proposal');
    if (!id) return;
    const controller = new AbortController();
    setWorking('load');
    // 只有当前来源对应的已保存提案才能恢复预览。
    api<Proposal>(
      `/runs/${encodeURIComponent(document.runId)}/revisions/${encodeURIComponent(id)}`,
      { signal: controller.signal },
    )
      .then((result) => {
        setProposal(result);
        setDecisions(result.confirmedDecisions);
        dialog.current?.showModal();
        // 失败保留链接供刷新，不在后台重建提案。
      })
      .catch((problem: Error) => {
        if (!controller.signal.aborted) setError(problem.message);
      })
      .finally(() => {
        if (!controller.signal.aborted) setWorking(undefined);
      });
    // 离开来源后，旧响应不能打开其他记录的预览。
    return () => controller.abort();
  }, [document.runId]);
  /** 模型生成只创建提案快照，不改变旧稿和审阅记录。 */
  async function generate() {
    if (!decisions.trim() || disabled) return;
    setError('');
    setWorking('generate');
    onBusy(true);
    try {
      const result = await api<Proposal>(
        `/runs/${encodeURIComponent(document.runId)}/revisions`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            ...readingRequest(messages, document.artifact!.hash),
            confirmedDecisions: decisions.trim(),
          }),
        },
      );
      setProposal(result);
      proposalUrl(result.proposalId);
      setView('diff');
      dialog.current?.showModal();
    } catch (problem) {
      setError(
        problem instanceof Error ? problem.message : '提案生成失败，请重试。',
      );
    } finally {
      setWorking(undefined);
      onBusy(false);
    }
  }
  /** 应用只提交持久提案标识，网络失败保留预览并可幂等重试。 */
  async function apply() {
    if (!proposal || !appliedBy.trim() || disabled) return;
    setError('');
    setWorking('apply');
    onBusy(true);
    try {
      const result = await api<ReviewDocument>(
        `/runs/${encodeURIComponent(document.runId)}/apply-revision`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            proposalId: proposal.proposalId,
            artifactHash: proposal.sourceHash,
            appliedBy: appliedBy.trim(),
          }),
        },
      );
      dialog.current?.close();
      proposalUrl();
      onApplied(result);
    } catch (problem) {
      setError(
        problem instanceof Error
          ? problem.message
          : '应用结果未知，请保留提案并重试读取同一轮次。',
      );
    } finally {
      setWorking(undefined);
      onBusy(false);
    }
  }
  /** 关闭仅隐藏预览，不删除已持久化提案。 */
  function close() {
    if (!working) dialog.current?.close();
  }
  /** 重新打开既有预览不会重新请求模型。 */
  function reopen() {
    setError('');
    dialog.current?.showModal();
  }
  /** 查看逐行增删时保留原始 Markdown，便于发现规则被意外删除。 */
  function showDiff() {
    setView('diff');
  }
  /** 完整渲染用于复核修订后正文的阅读效果。 */
  function showDocument() {
    setView('document');
  }
  const canRevise = ['suspended', 'success', 'failed', 'canceled'].includes(
    document.status,
  );
  return (
    <section className="revision-panel" aria-label="修订产品交接稿">
      <h3>
        <FilePenLine size={14} />
        把结论整理进新稿
      </h3>
      <p>
        填写你已确认的规则。聊天仅作参考，生成后先比较差异，再应用到新轮次。
      </p>
      <label>
        已确认结论
        <textarea
          aria-label="已确认结论"
          placeholder="例如：首尾空白按 JavaScript trim 语义去除；校验失败保留其他已填字段。仅填写你确定采用的规则。"
          maxLength={8000}
          value={decisions}
          disabled={disabled}
          // 草稿由产品负责人明确填写，不从助手建议自动确认。
          onChange={(event) => setDecisions(event.target.value)}
        />
      </label>
      <div className="revision-buttons">
        <button
          className="button primary"
          disabled={disabled || !decisions.trim() || !canRevise}
          onClick={generate}
        >
          {working === 'generate' ? (
            <LoaderCircle size={14} className="spin" />
          ) : (
            <FilePenLine size={14} />
          )}
          生成修订提案
        </button>
        {proposal && (
          <button
            className="button secondary"
            onClick={reopen}
            disabled={disabled}
          >
            查看已存提案
          </button>
        )}
      </div>
      {error && !dialog.current?.open && (
        <p className="error-banner" role="alert">
          {error}
        </p>
      )}
      <dialog
        ref={dialog}
        className="revision-dialog"
        aria-label="产品交接稿修订预览"
        // 应用进行中不允许 Escape 隐藏结果，其他时候保留原生取消行为。
        onCancel={(event) => {
          if (working === 'apply') event.preventDefault();
        }}
      >
        <header>
          <div>
            <span className="eyebrow">产品交接 · 修订预览</span>
            <h2>比较后，再应用到新轮次</h2>
            <p>旧稿和决定保持历史，新稿需要重新进行产品确认。</p>
          </div>
          <button
            className="icon-button"
            aria-label="关闭修订预览"
            onClick={close}
            disabled={!!working}
          >
            <X size={20} />
          </button>
        </header>
        {proposal && (
          <>
            <div className="revision-summary">
              <strong>
                本次明确结论
                {proposal.mode === 'fixture'
                  ? ' · 固定样例输出，不代表理解结论'
                  : ''}
              </strong>
              <p>{proposal.confirmedDecisions}</p>
              <code>
                来源版本 {proposal.sourceHash.slice(0, 12)} · 提案{' '}
                {proposal.proposalId.slice(0, 8)}
              </code>
            </div>
            <div className="revision-tabs">
              <button onClick={showDiff} aria-pressed={view === 'diff'}>
                逐行差异
              </button>
              <button onClick={showDocument} aria-pressed={view === 'document'}>
                完整新稿
              </button>
              <span>红色删除 · 绿色新增 · 保留行不着色</span>
            </div>
            <div className="revision-preview">
              {view === 'document' ? (
                <Markdown>{proposal.content}</Markdown>
              ) : differences ? (
                <pre className="revision-diff">
                  {/* 差异只作文本显示，不执行原稿中的 HTML。 */}
                  {differences.map((part, index) => (
                    <span
                      key={index}
                      className={
                        part.added
                          ? 'added'
                          : part.removed
                            ? 'removed'
                            : 'unchanged'
                      }
                    >
                      <b>{part.added ? '+ ' : part.removed ? '− ' : '  '}</b>
                      {part.value}
                    </span>
                  ))}
                </pre>
              ) : (
                <div>
                  <p>文档较大，请对照原稿检查完整新稿。</p>
                  <Markdown>{proposal.content}</Markdown>
                </div>
              )}
            </div>
            <footer>
              <label>
                应用人（本地标签）
                <input
                  aria-label="修订应用人"
                  maxLength={100}
                  value={appliedBy}
                  disabled={disabled}
                  // 应用人随新轮次保存，用于本地追溯而非认证。
                  onChange={(event) => setAppliedBy(event.target.value)}
                />
              </label>
              <div>
                <button
                  className="button secondary"
                  onClick={close}
                  disabled={!!working}
                >
                  返回讨论
                </button>
                <button
                  className="button primary"
                  onClick={apply}
                  disabled={disabled || !appliedBy.trim()}
                >
                  {working === 'apply' && (
                    <LoaderCircle className="spin" size={14} />
                  )}
                  应用并创建新轮次
                </button>
              </div>
            </footer>
          </>
        )}
        {error && (
          <p className="error-banner" role="alert">
            {error} 可用同一提案重试，已创建的轮次会直接返回。
          </p>
        )}
      </dialog>
    </section>
  );
}
