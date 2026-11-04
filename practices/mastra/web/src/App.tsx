import { useCallback, useEffect, useState } from 'react';
import {
  Layers2,
  FileText,
  ChevronRight,
  ChevronLeft,
  Search,
  RefreshCw,
  ArrowUpRight,
  Download,
  BookOpen,
  Check,
  Circle,
  AlertCircle,
  LoaderCircle,
} from 'lucide-react';
import {
  api,
  briefTitle,
  documentStatus,
  formatTime,
  type ReviewDocument,
  type RunPage,
} from './lib';
import {
  Artifact,
  ArtifactHeader,
  ArtifactContent,
} from './components/ai-elements/artifact';
import { Markdown } from './components/Markdown';
import { ReadingAssistant } from './components/ReadingAssistant';
import { ReviewActions } from './components/ReviewActions';

/** 专注产品审阅的业务页面；Workflow 持有事实，React 只管理当前阅读及输入状态。 */
export function App() {
  const [page, setPage] = useState(0);
  const [list, setList] = useState<RunPage>({ runs: [], total: 0, page: 0 });
  const [selected, setSelected] = useState(
    new URLSearchParams(window.location.search).get('run') ?? '',
  );
  const [document, setDocument] = useState<ReviewDocument>();
  const [filter, setFilter] = useState('');
  const [listError, setListError] = useState('');
  const [detailError, setDetailError] = useState('');
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [revision, setRevision] = useState(0);
  const [notice, setNotice] = useState('');
  /** 手动刷新沿用已选记录，不重发决定。 */
  function reload() {
    setRevision(revision + 1);
  }
  /** 分页仅查询列表，不改变当前阅读或执行流程。 */
  function previousPage() {
    setPage(page - 1);
  }
  /** 后一页仍保留当前文档，待用户显式选择其他记录。 */
  function nextPage() {
    setPage(page + 1);
  }
  /** 切换记录时清除上一轮操作反馈。 */
  function selectRun(runId: string) {
    const url = new URL(window.location.href);
    url.searchParams.delete('proposal');
    window.history.replaceState(null, '', url);
    setSelected(runId);
    setNotice('');
  }
  // 列表分页请求可取消；切换页不会让旧响应覆盖当前列表。
  useEffect(() => {
    const controller = new AbortController();
    setListError('');
    // 只有成功响应才能自动选择首条，深链接保留用户指定的 Run。
    api<RunPage>(`/runs?page=${page}`, { signal: controller.signal })
      .then((result) => {
        setList(result);
        // 初次进入时选中当前页首条，已选记录不因刷新跳动。
        setSelected((current) => current || result.runs[0]?.runId || '');
        if (!result.runs.length) setLoading(false);
        // 取消请求不展示为业务错误。
      })
      .catch((error: Error) => {
        if (!controller.signal.aborted) {
          setListError(error.message);
          setLoading(false);
        }
      });
    // 取消过期列表请求，避免卸载后回写。
    return () => controller.abort();
  }, [page, revision]);
  // 详情请求与 Run 选择绑定；旧记录在新记录载入期间不保留可点击按钮。
  useEffect(() => {
    if (!selected) return;
    const controller = new AbortController();
    setDocument(undefined);
    setDetailError('');
    setLoading(true);
    setNotice('');
    const url = new URL(window.location.href);
    url.searchParams.set('run', selected);
    window.history.replaceState(null, '', url);
    // 异步详情只接收未取消的结果。
    api<ReviewDocument>(`/runs/${encodeURIComponent(selected)}`, {
      signal: controller.signal,
    })
      .then(
        (result) => {
          setDocument(result);
          setLoading(false);
        },
        // 详情错误不影响列表继续选择其他 Run。
      )
      .catch((error: Error) => {
        if (!controller.signal.aborted) {
          setDetailError(error.message);
          setLoading(false);
        }
      });
    // 切换记录和刷新时停止旧的详情请求。
    return () => controller.abort();
  }, [selected, revision]);
  /** 失败后的状态复核保留组件中的审阅输入，不重新挂载同一份正文。 */
  const refreshDocument = useCallback(async () => {
    try {
      setDocument(
        await api<ReviewDocument>(`/runs/${encodeURIComponent(selected)}`),
      );
    } catch {
      setNotice('暂时无法复核提交结果，请恢复连接后刷新；请勿直接重复确认。');
    }
  }, [selected]);
  /** 保存完成后直接采用服务端权威状态，区分业务决定与下游生成结果。 */
  function decided(result: ReviewDocument) {
    setDocument(result);
    // 决定成功后同步当前列表摘要，不让已结束的记录继续显示等待审阅。
    setList((current) => ({
      ...current,
      // 列表仅更新框架状态，完整业务状态仍来自详情投影。
      runs: current.runs.map((run) =>
        run.runId === result.runId ? { ...run, status: result.status } : run,
      ),
    }));
    setNotice(
      result.outcome === 'rejected'
        ? '已记录拒绝意见，本轮流程结束。'
        : result.status === 'failed'
          ? '产品决定已保存，但后续生成失败。请到 Studio 查看流程。'
          : '产品决定已保存，流程已推进到下一阶段。',
    );
  }
  /** 新轮次由服务端创建后切换查看，产品确认资格从新快照重新读取。 */
  function revised(result: ReviewDocument) {
    setPage(0);
    setFilter('');
    setSelected(result.runId);
    setRevision(revision + 1);
  }
  /** 导出的内容原样来自持久化正文，不经过模型改写。 */
  function download() {
    if (!document?.artifact) return;
    const url = URL.createObjectURL(
      new Blob([document.artifact.content], {
        type: 'text/markdown;charset=utf-8',
      }),
    );
    const anchor = window.document.createElement('a');
    anchor.href = url;
    anchor.download = `product-${document.runId}.md`;
    anchor.click();
    URL.revokeObjectURL(url);
  }
  // 当前页搜索不改变后端分页语义，输入框明确限定搜索范围。
  const visibleRuns = list.runs.filter((run) =>
    `${run.brief} ${run.runId}`.toLowerCase().includes(filter.toLowerCase()),
  );
  // 产品审阅记录与下游开发审阅分开显示，避免误认为产品被再次拒绝。
  const reviews =
    document?.reviews.filter((review) => review.role === 'product') ?? [];
  const stateLabel = document ? documentStatus(document) : '';
  return (
    <div className="app-shell">
      <header className="topbar">
        <a className="brand" href="/">
          <span className="brand-mark">
            <Layers2 size={19} />
          </span>
          交接台
          <span className="brand-divider" />{' '}
          <span className="brand-scope">Mastra 实践</span>
        </a>
        <div className="local-status">
          <span />
          本地工作空间
        </div>
        <a
          className="studio-link"
          href="http://127.0.0.1:4111"
          target="_blank"
          rel="noreferrer"
        >
          打开 Studio <ArrowUpRight size={14} />
        </a>
      </header>
      <div className="workspace">
        <aside className="sidebar">
          <div className="sidebar-section-label">工作空间</div>
          <div className="nav-current">
            <FileText size={17} />
            产品交接审阅<span>{list.total}</span>
          </div>
          <div className="sidebar-list-heading">
            <span>交接记录</span>
            <button
              className="icon-button"
              aria-label="刷新记录"
              title="刷新记录"
              onClick={reload}
              disabled={busy}
            >
              <RefreshCw size={14} />
            </button>
          </div>
          <label className="search">
            <Search size={14} />
            <input
              placeholder="搜索当前页需求或 Run"
              aria-label="搜索当前页需求或 Run"
              value={filter}
              // 当前页过滤条件只影响列表展示。
              onChange={(event) => setFilter(event.target.value)}
            />
          </label>
          <div className="run-list">
            {listError && (
              <p className="list-error" role="alert">
                {listError}
              </p>
            )}
            {!listError && !list.runs.length && !loading && (
              <p className="empty-list">
                还没有交接记录。
                <br />在 Studio 发起一次产品交接流程。
              </p>
            )}
            {!listError && list.runs.length > 0 && !visibleRuns.length && (
              <p className="empty-list">当前页没有匹配记录。</p>
            )}
            {/* 记录选择不执行流程，审批进行中禁止切换上下文。 */}
            {visibleRuns.map((run) => (
              <button
                className={`run-card ${selected === run.runId ? 'selected' : ''}`}
                key={run.runId}
                disabled={busy}
                // 点击只改变阅读上下文，不恢复工作流。
                onClick={() => selectRun(run.runId)}
              >
                <span className="run-card-title">
                  <FileText size={14} />
                  {briefTitle(run.brief)}
                  {run.revisionOf && <small>修订稿</small>}
                </span>
                <span className="run-card-brief">{run.brief}</span>
                <span className="run-card-meta">
                  <span>
                    <i
                      className={
                        run.status === 'suspended' ? 'dot-pending' : ''
                      }
                    />
                    {run.status === 'suspended'
                      ? '等待审阅'
                      : run.status === 'success'
                        ? '本轮已结束'
                        : run.status === 'failed'
                          ? '执行失败'
                          : '流程记录'}
                  </span>
                  <time>{formatTime(run.createdAt)}</time>
                </span>
              </button>
            ))}
          </div>
          <div className="pagination">
            <button
              className="icon-button"
              aria-label="上一页"
              disabled={busy || page === 0}
              onClick={previousPage}
            >
              <ChevronLeft size={15} />
            </button>
            <span>
              {page + 1} / {Math.max(1, Math.ceil(list.total / 20))}
            </span>
            <button
              className="icon-button"
              aria-label="下一页"
              disabled={busy || (page + 1) * 20 >= list.total}
              onClick={nextPage}
            >
              <ChevronRight size={15} />
            </button>
          </div>
          <div className="sidebar-footer">
            <BookOpen size={16} />
            <p>
              从需求到交付<span>每一阶段，都由你确认</span>
            </p>
          </div>
        </aside>
        <main className="main-area">
          <div className="breadcrumb">
            工作空间 <ChevronRight size={13} /> 产品交接审阅
          </div>
          <div className="page-heading">
            <div>
              <span className="eyebrow">PRODUCT HANDOFF</span>
              <h1>读清需求，再交给下一步</h1>
              <p>审阅产品交接稿，确认范围、规则与验收条件。</p>
            </div>
            <div className="phase-label">
              <span>01</span>产品阶段
            </div>
          </div>
          {notice && (
            <div className="notice" role="status">
              <Check size={16} />
              {notice}
            </div>
          )}
          {loading ? (
            <div className="page-empty">
              <LoaderCircle className="spin" />
              <h2>正在读取交接稿</h2>
            </div>
          ) : detailError ? (
            <div className="page-empty" role="alert">
              <AlertCircle />
              <h2>暂时无法打开这条记录</h2>
              <p>{detailError}</p>
              <button className="button secondary" onClick={reload}>
                重新读取
              </button>
            </div>
          ) : !document ? (
            <div className="page-empty">
              <FileText />
              <h2>从一份产品交接稿开始</h2>
              <p>在左侧选择记录，或在 Studio 启动 product-delivery。</p>
              <a
                className="button primary"
                href="http://127.0.0.1:4111/workflows"
                target="_blank"
                rel="noreferrer"
              >
                前往 Studio <ArrowUpRight size={15} />
              </a>
            </div>
          ) : (
            <>
              <div className="document-meta">
                <span
                  className={`status-badge ${document.canReview ? 'pending' : ''}`}
                >
                  <span />
                  {stateLabel}
                </span>
                <span className="evidence-tag">
                  {document.mode === 'live'
                    ? '真实模型提案'
                    : '固定样例 · fixture'}
                </span>
                <code title={document.runId}>
                  Run {document.runId.replace(/^revision-/, '').slice(0, 8)}
                </code>
                <button
                  className="text-button"
                  onClick={reload}
                  disabled={busy}
                >
                  <RefreshCw size={13} />
                  刷新状态
                </button>
              </div>
              <div className="workflow-strip">
                <div className="active">
                  <span>1</span>产品整理与确认
                </div>
                <ChevronRight size={14} />
                <div>
                  <span>2</span>开发提案
                </div>
                <ChevronRight size={14} />
                <div>
                  <span>3</span>测试计划
                </div>
                <ChevronRight size={14} />
                <div>
                  <span>4</span>部署方案
                </div>
              </div>
              <details className="original-brief">
                <summary>
                  查看原始需求 <ChevronRight size={13} />
                </summary>
                <p>{document.brief}</p>
              </details>
              <Artifact className="document-artifact">
                <ArtifactHeader>
                  <div className="document-title">
                    <span className="document-icon">
                      <FileText size={17} />
                    </span>
                    <strong>产品交接稿</strong>
                    <span>只读正文</span>
                  </div>
                  <button
                    className="icon-button"
                    onClick={download}
                    disabled={!document.artifact}
                    title="下载 Markdown"
                    aria-label="下载 Markdown"
                  >
                    <Download size={17} />
                  </button>
                </ArtifactHeader>
                <ArtifactContent>
                  {document.artifact ? (
                    <article className="document-content">
                      <Markdown>{document.artifact.content}</Markdown>
                    </article>
                  ) : (
                    <p className="document-content muted">
                      当前 Run 尚未生成产品交接稿，请到 Studio 查看执行状态。
                    </p>
                  )}
                </ArtifactContent>
                <footer className="document-version">
                  <span>
                    <Circle size={10} />
                    已保存版本
                  </span>
                  <code title={document.artifact?.hash}>
                    {document.artifact?.hash.slice(0, 12) ?? '尚无正文'}
                  </code>
                  <span>审阅决定将与此版本绑定</span>
                </footer>
              </Artifact>
              {reviews.length > 0 && (
                <section className="review-history">
                  <h3>
                    <Check size={15} />
                    产品审阅记录
                  </h3>
                  {/* 历史决定只读展示，正文不会因审阅意见改变。 */}
                  {reviews.map((review) => (
                    <div className="review-record" key={review.artifactHash}>
                      <div>
                        <strong>{review.reviewer}</strong>
                        <span className="evidence-tag">
                          {review.decision === 'approve'
                            ? '已批准产品稿'
                            : '已拒绝产品稿'}
                        </span>
                      </div>
                      <p>{review.comment}</p>
                    </div>
                  ))}
                </section>
              )}
              {document.revision && (
                <section className="review-history">
                  <h3>修订来源</h3>
                  <p>
                    由 {document.revision.appliedBy}{' '}
                    应用，当前新稿需要重新审阅。
                  </p>
                  <p>{document.revision.confirmedDecisions}</p>
                  <a
                    className="text-button"
                    href={`/?run=${encodeURIComponent(document.revision.sourceRunId)}`}
                  >
                    查看原交接稿
                  </a>
                </section>
              )}
              <ReviewActions
                key={document.runId + document.artifact?.hash}
                document={document}
                busy={busy}
                onBusy={setBusy}
                onDone={decided}
                onRefresh={refreshDocument}
              />
              {!document.canReview && (
                <div className="readonly-note">
                  <AlertCircle size={15} />
                  {document.pendingRole === 'product'
                    ? '当前服务模式与记录不同，请以创建时的模式启动服务后再审阅。'
                    : '这份产品稿当前只读。后续流程及执行状态可在 Studio 查看。'}
                  <a
                    href={`http://127.0.0.1:4111/workflows/deliveryWorkflow/graph/${encodeURIComponent(document.runId)}`}
                    target="_blank"
                    rel="noreferrer"
                  >
                    查看流程 <ArrowUpRight size={13} />
                  </a>
                </div>
              )}
            </>
          )}
          <footer className="page-footer">
            产品批准确认的是需求版本；代码、测试与部署由后续阶段分别验证。
          </footer>
        </main>
        {document?.artifact && !loading ? (
          <ReadingAssistant
            key={document.runId + document.artifact.hash}
            document={document}
            pageBusy={busy}
            onBusy={setBusy}
            onApplied={revised}
          />
        ) : (
          <aside className="assistant-panel assistant-placeholder">
            <SparklesPlaceholder />
          </aside>
        )}
      </div>
    </div>
  );
}

/** 无文档时说明助手依赖，避免自动调用模型或展示虚构对话。 */
function SparklesPlaceholder() {
  return (
    <div className="assistant-welcome">
      <MessageIcon />
      <h3>阅读助手</h3>
      <p>
        选择一份产品交接稿后，
        <br />
        就可以围绕文档提问。
      </p>
    </div>
  );
}
/** 空态图标保持轻量，不引入额外插画资产。 */
function MessageIcon() {
  return <BookOpen size={26} />;
}
