import { useEffect, useState } from 'react';
import ReactDiffViewer, { DiffMethod } from 'react-diff-viewer-continued';
import { intakeRequest } from '../intake-request';

type ChangedFile = {
  path: string;
  taskId: string;
  taskIds?: string[];
  kind: 'added' | 'deleted' | 'modified';
  before?: string;
  after?: string;
};
type CandidateChanges = { status: 'pending' | 'unavailable' } | {
  status: 'ready'; baseline: string; sourceHash: string; files: ChangedFile[];
};
const captions = { added: '新增', deleted: '删除', modified: '修改' };

/** 文件独立折叠，打开时才计算逐行差异。 */
function FileChanges({ file, split }: { file: ChangedFile; split: boolean }) {
  const [open, setOpen] = useState(false);
  return <details className="candidate-change-file" onToggle={event => setOpen(event.currentTarget.open)}>
    <summary><span>{captions[file.kind]}</span><code>{file.path}</code><small>{(file.taskIds ?? [file.taskId]).join('、')}</small></summary>
    {open && (file.before === undefined || file.after === undefined
      ? <p>该文件正文超出预览范围。</p>
      : <div className="candidate-diff-content"><ReactDiffViewer oldValue={file.before} newValue={file.after}
          splitView={split} compareMethod={DiffMethod.LINES}
          leftTitle={split ? '开发基线' : undefined} rightTitle={split ? '已保存候选' : undefined}
          codeFoldMessageRenderer={count => <span>展开 {count} 行未改动代码</span>} /></div>)}
  </details>;
}

/** 按需请求当前 Run 的只读差异，支持逐文件浏览和切换对比布局。 */
export default function CandidateChangesPanel({ runId, close }: { runId: string; close: () => void }) {
  const [changes, setChanges] = useState<CandidateChanges>();
  const [refresh, setRefresh] = useState(0);
  const [split, setSplit] = useState(false);
  useEffect(() => {
    let current = true;
    void intakeRequest<CandidateChanges>(`/${encodeURIComponent(runId)}/candidate-changes`).then(
      data => { if (current) setChanges(data); },
      () => { if (current) setChanges({ status: 'unavailable' }); },
    );
    return () => { current = false; };
  }, [runId, refresh]);

  return <aside id="candidate-changes-panel" className="candidate-changes-panel" aria-labelledby="candidate-changes-title">
    <header className="candidate-changes-header">
      <h2 id="candidate-changes-title">代码变更</h2>
      <button type="button" onClick={close}>收起</button>
    </header>
    <div className="candidate-changes-toolbar">
      {changes?.status === 'ready' && !!changes.files.length && <div role="group" aria-label="对比布局">
        <button type="button" aria-pressed={!split} onClick={() => setSplit(false)}>行内</button>
        <button type="button" aria-pressed={split} onClick={() => setSplit(true)}>并排</button>
      </div>}
      <button type="button" disabled={!changes} onClick={() => { setChanges(undefined); setRefresh(value => value + 1); }}>刷新变更</button>
    </div>
    <div className="candidate-changes-scroll">
      {changes?.status === 'ready' ? <>
        <div className="candidate-changes-version">
          <span>开发基线 <code title={changes.baseline}>{changes.baseline.slice(0, 12)}</code></span>
          <span>候选 <code title={changes.sourceHash}>{changes.sourceHash.slice(0, 12)}</code></span>
          <span>{changes.files.length} 个文件</span>
        </div>
        {changes.files.length ? changes.files.map(file => <FileChanges key={`${changes.sourceHash}:${file.path}`} file={file} split={split} />) : <p>当前候选暂无代码变更。</p>}
      </> : <p role="status">{!changes ? '正在读取候选变更…' : changes.status === 'pending' ? '等待研发保存可对比的候选版本。' : '当前候选无法读取或版本已变化，请刷新重试。'}</p>}
    </div>
  </aside>;
}
