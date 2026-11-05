import { useRef, useState, type FormEvent } from "react";
import { Check, X, LoaderCircle, RotateCcw } from "lucide-react";
import { api, type ReviewDocument } from "../lib";

interface ReviewActionsProps {
  document: ReviewDocument;
  busy: boolean;
  onBusy: (busy: boolean) => void;
  onDone: (document: ReviewDocument) => void;
  onRefresh: () => Promise<void>;
}

/** 决定绑定显示的 hash；网络失败保留意见且只刷新，不自动重复批准。 */
export function ReviewActions({
  document,
  busy,
  onBusy,
  onDone,
  onRefresh,
}: ReviewActionsProps) {
  const [reviewer, setReviewer] = useState("");
  const [comment, setComment] = useState("");
  const [decision, setDecision] = useState<"approve" | "reject" | "rework">("approve");
  const [error, setError] = useState("");
  const dialog = useRef<HTMLDialogElement>(null);
  const canSubmit =
    document.canReview && !!reviewer.trim() && !!comment.trim() && !busy;
  /** 让用户明确批准将触发下游真实模型生成。 */
  function approve() {
    setDecision("approve");
    dialog.current?.showModal();
  }
  /** 拒绝结束本轮，不把意见当成自动修订指令。 */
  function reject() {
    setDecision("reject");
    dialog.current?.showModal();
  }
  /** 返工保留旧稿和意见，四个固定角色生成新稿后重新等待产品确认。 */
  function rework() {
    setDecision("rework");
    dialog.current?.showModal();
  }
  /** 取消确认不会写入任何流程事实。 */
  function cancel() {
    dialog.current?.close();
  }
  /** 只在用户再次确认后提交；服务端仍重新检查状态和版本。 */
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!canSubmit || !document.artifact || (decision === "rework" && !document.canRework)) return;
    dialog.current?.close();
    setError("");
    onBusy(true);
    try {
      const result = await api<ReviewDocument>(
        `/runs/${encodeURIComponent(document.runId)}/review`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            artifactHash: document.artifact.hash,
            decision,
            reviewer: reviewer.trim(),
            comment: comment.trim(),
          }),
        },
      );
      onDone(result);
    } catch (problem) {
      setError(
        problem instanceof Error
          ? problem.message
          : "提交结果未知，请刷新确认。",
      );
      await onRefresh();
    } finally {
      onBusy(false);
    }
  }
  if (!document.canReview) return null;
  return (
    <section className="review-actions" aria-label="提交产品审阅决定">
      <div className="review-actions-title">
        <span className="step-number">02</span>
        <div>
          <h3>你的审阅决定</h3>
          <p>确认当前版本后，将交给开发角色生成实现提案。</p>
        </div>
      </div>
      <div className="review-fields">
        <label>
          审阅人<span>本地标签</span>
          <input
            value={reviewer}
            maxLength={100}
            disabled={busy}
            placeholder="请输入姓名或标识"
            required
            // 标签沿用现有本地模拟规则，不宣称登录身份。
            onChange={(event) => setReviewer(event.target.value)}
          />
        </label>
        <label>
          审阅意见
          <textarea
            value={comment}
            maxLength={2000}
            disabled={busy}
            placeholder="记录确认依据，或说明需要补充的问题"
            required
            // 失败时不清空，便于确认状态后人工重试。
            onChange={(event) => setComment(event.target.value)}
          />
        </label>
      </div>
      {error && (
        <p role="alert" className="error-banner">
          {error}
        </p>
      )}
      <div className="decision-row">
        <span>
          {busy
            ? "正在处理当前操作，请稍候…"
            : "决定将绑定你正在阅读的文档版本"}
        </span>
        <button
          className="button secondary"
          onClick={rework}
          disabled={!canSubmit || !document.canRework}
          title={document.canRework ? "带审阅意见生成新稿，再次人工验收" : "已达到三次返工上限，可批准或终止本轮"}
        >
          <RotateCcw size={15} />
          退回修改
        </button>
        <button
          className="button secondary"
          onClick={reject}
          disabled={!canSubmit}
        >
          <X size={15} />
          拒绝并终止
        </button>
        <button
          className="button primary"
          onClick={approve}
          disabled={!canSubmit}
        >
          {busy ? (
            <LoaderCircle size={15} className="spin" />
          ) : (
            <Check size={15} />
          )}
          确认并交给开发
        </button>
      </div>
      <dialog ref={dialog} className="confirm-dialog">
        <form onSubmit={submit}>
          <span className="eyebrow">产品交接 · 人工决定</span>
          <h2>
            {decision === "approve"
              ? "确认这份产品交接稿？"
              : decision === "rework" ? "带着审阅意见重新修改？" : "拒绝并结束本轮？"}
          </h2>
          <p>
            {decision === "approve"
              ? "批准当前版本后，流程将调用开发 Agent 生成实现提案。这不表示代码已经实现或通过测试。"
              : decision === "rework"
                ? "旧稿和意见会保留。总产品、需求梳理、产品闭环与写作角色将生成新稿，仍需你重新确认后才进入开发。此操作将调用模型。"
                : "当前产品稿保持不变，本轮流程结束。审阅意见会保留；不会自动修改或进入开发。"}
          </p>
          <div className="dialog-review">
            <strong>{reviewer}</strong>
            <p>{comment}</p>
          </div>
          <div className="dialog-actions">
            <button type="button" className="button secondary" onClick={cancel}>
              返回阅读
            </button>
            <button
              className={`button ${decision === "reject" ? "danger" : "primary"}`}
              disabled={!canSubmit}
            >
              确定{decision === "approve" ? "批准" : decision === "rework" ? "退回修改" : "拒绝"}
            </button>
          </div>
        </form>
      </dialog>
    </section>
  );
}
