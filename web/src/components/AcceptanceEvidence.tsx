export interface RequirementImpactData {
  mode: 'stable-ids' | 'legacy-full';
  added: string[];
  changed: string[];
  removed: string[];
  affectedCaseIds: string[];
  rerunCaseIds: string[];
}

export interface AcceptanceEvidenceData {
  productHash: string;
  sourceHash: string;
  planHash: string | null;
  reportHash: string | null;
  qualityStatus: 'pending' | 'passed' | 'rework' | 'blocked';
  impact?: RequirementImpactData;
  requirements: {
    id: string;
    text: string;
    taskIds: string[];
    cases: { id: string; expected: string; result?: { status: 'passed' | 'failed' | 'blocked'; evidence: string; authority: string } }[];
  }[];
}

/** 展示待确认修订的直接影响，以及新版质量门须重跑的历史用例。 */
export function RequirementImpact({ impact }: { impact: RequirementImpactData }) {
  return <section className="intake-assumptions">
    <h3>需求修订影响</h3>
    {impact.mode === 'legacy-full'
      ? <p>原稿使用历史行号引用。新版须重新确认全部用例并完整回归。</p>
      : <ul>
        <li>新增需求，须补齐用例：{impact.added.join('、') || '无'}</li>
        <li>修改需求，须复核用例：{impact.changed.join('、') || '无'}</li>
        <li>移除需求，须核对旧映射：{impact.removed.join('、') || '无'}</li>
      </ul>}
    <p>直接受影响的历史用例：{impact.affectedCaseIds.join('、') || '无记录'}</p>
    <p>保留覆盖时须重跑的历史用例：{impact.rerunCaseIds.join('、') || '无记录'}</p>
    <p>新版按重新批准的完整用例包执行。</p>
  </section>;
}

const resultLabels = { passed: '通过', failed: '失败', blocked: '受阻' };
const qualityLabels = { pending: '待确认', passed: '已通过', rework: '待修复', blocked: '受阻' };
const authorityLabels: Record<string, string> = { 'sandbox-process': '登记检查', 'local-human-report': '人工记录', 'browser-process': '浏览器执行' };

/** 从当前批准版本显示需求、任务与独立执行证据。 */
export function AcceptanceEvidence({ evidence }: { evidence: AcceptanceEvidenceData }) {
  return <section className="intake-card">
    <details>
      <summary>需求验收证据 · {evidence.requirements.length} 项 · 质量门{qualityLabels[evidence.qualityStatus]}</summary>
      <p>产品版本 <code>{evidence.productHash.slice(0, 12)}</code> · 开发方案 <code>{evidence.planHash?.slice(0, 12) ?? '待确认'}</code> · 候选版本 <code>{evidence.sourceHash.slice(0, 12)}</code></p>
      {evidence.impact && <RequirementImpact impact={evidence.impact} />}
      {evidence.requirements.map(item => <section key={item.id} className="gate-evidence-item">
        <h3>{item.id}</h3><p>{item.text}</p><p>研发任务：{item.taskIds.join('、') || '待关联'}</p>
        {item.cases.length ? <ul>{item.cases.map(testCase => <li key={testCase.id}>
          <strong>{testCase.id}</strong> · {testCase.expected} · {testCase.result ? `${resultLabels[testCase.result.status]}（${authorityLabels[testCase.result.authority] ?? testCase.result.authority}）` : '待执行'}
          {testCase.result && <p>{testCase.result.evidence}</p>}
        </li>)}</ul> : <p>待批准测试用例</p>}
      </section>)}
    </details>
  </section>;
}
