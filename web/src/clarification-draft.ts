import { useEffect, useState } from 'react';
import type { ClarificationAnswer } from './components/QuestionFlow';

interface ClarificationDraft {
  answers: Record<string, ClarificationAnswer>;
  supplement: string;
  reviewer?: string;
}

const emptyDraft: ClarificationDraft = { answers: {}, supplement: '' };

/** 在当前标签页保存单个 Run 的当前轮草稿，版本以服务端快照为准。 */
export function useClarificationDraft(runId?: string, hash?: string) {
  const key = runId ? `intake:clarification-draft:v1:${runId}` : undefined;
  const [saved, setSaved] = useState<{
    key: string;
    hash: string;
    draft: ClarificationDraft;
    persisted: boolean;
  }>();
  const current = saved?.key === key && saved?.hash === hash ? saved : undefined;

  useEffect(() => {
    if (!key) return;
    try {
      const raw = sessionStorage.getItem(key);
      if (!raw) return;
      const stored = JSON.parse(raw) as { hash: string; draft: ClarificationDraft };
      if (!hash || stored?.hash !== hash || !stored.draft?.answers || typeof stored.draft.supplement !== 'string') {
        sessionStorage.removeItem(key);
        return;
      }
      setSaved({ key, hash, draft: stored.draft, persisted: true });
    } catch {
      // 存储不可用或损坏时仍允许输入和提交。
    }
  }, [key, hash]);

  /** 编辑时同步保存，避免用户输入后立即刷新造成丢失。 */
  function update(patch: Partial<ClarificationDraft>) {
    if (!key || !hash) return;
    const draft = { ...(current?.draft ?? emptyDraft), ...patch };
    let persisted = false;
    try {
      sessionStorage.setItem(key, JSON.stringify({ hash, draft }));
      persisted = true;
    } catch {
      // 保留页面内的输入，让用户可以继续提交。
    }
    setSaved({ key, hash, draft, persisted });
  }

  return { draft: current?.draft ?? emptyDraft, persisted: current?.persisted, update };
}
