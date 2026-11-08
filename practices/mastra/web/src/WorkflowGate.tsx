/** 基于已有关口契约的业务表单；版本绑定由服务端生成，不让用户填写恢复 JSON。 */
import { BlockerClarification, RevisedProductReview } from './BlockerClarification';
import { useState } from 'react';
import { DevelopmentRecovery, type RecoveryInfo } from './DevelopmentRecovery';
import { Markdown } from './components/Markdown';
export interface FormSchema { 'x-labels'?: Record<string, string>; type?: string; properties?: Record<string, FormSchema>; required?: string[]; items?: FormSchema; enum?: (string | number)[]; const?: unknown; default?: unknown; additionalProperties?: FormSchema | boolean; minimum?: number; maximum?: number; minItems?: number; maxItems?: number; minLength?: number; maxLength?: number; format?: string; anyOf?: FormSchema[] }
export interface WorkflowGate { recoveryInfo?: RecoveryInfo; key: string; title: string; description: string; gateHash: string; evidence: Record<string, any>; fixed: Record<string, unknown>; initial: Record<string, unknown>; schema: FormSchema }
const labels: Record<string, string> = { acceptanceRefs: '验收依据', contextRefs: '上下文依据', constraints: '约束条件', verificationRefs: '验证依据', requirement: '需求', behavior: '实现行为', verification: '验证方法', verdict: '评估结论', coverageRefs: '覆盖依据', unchecked: '尚未验证的内容', maxParallel: '最多并行任务', maxDelegations: '最多委派次数', delegationDepth: '委派层级', members: '团队成员', taskId: '对应任务', sourceHash: '源码版本', methodBundleHash: '方法版本', text: '需求内容', line: '原文行号', approvedProduct: '已确认产品需求', project: '项目与文件范围', id: '标识', files: '文件快照', writablePaths: '允许修改的文件', checkFiles: '不可修改的固定检查文件', roles: '参与角色', maxReworks: '最多返工次数', reviewer: '确认人（本地标签）', comment: '确认意见与依据', decision: '处理决定', resolutions: '处理记录', decisions: '逐项裁决', findingId: '问题标识', reason: '判断理由', refs: '依据引用', reportHash: '报告版本', cases: '测试用例', requirementRefs: '对应需求引用', expected: '预期结果', method: '验证方式', checkRefs: '登记检查引用', manualResults: '人工用例结果', caseId: '用例标识', status: '实际结果', evidence: '执行证据', findings: '发现的问题', severity: '严重性', category: '问题类型', route: '责任方向', detail: '问题描述', scope: '发布范围', environment: '目标环境', artifactDigest: '制品 SHA-256', artifactRef: '制品引用', rollbackArtifactRef: '回滚制品引用', healthChecks: '发布后健康检查清单', jobRef: '外部平台任务引用', operator: '执行人', finishedAt: '完成时间（UTC）', notes: '执行说明（请脱敏）', checks: '检查结果', observedAt: '观测时间（UTC）', summary: '方案摘要', plan: '方案', content: '正文', readiness: '就绪评估', team: '团队安排', risks: '风险', contracts: '接口与契约', tasks: '任务', paths: '文件范围', dependsOn: '前置依赖', role: '角色', requirements: '需求依据', registeredChecks: '登记检查', quality: '测试与质量证据', approval: '已确认内容', results: '用例执行结果', coverage: '覆盖范围', blockers: '阻塞项', requiredChecks: '必须完成的健康检查', reasonText: '说明' };
const choices: Record<string, string> = { PASS: '通过', CONCERNS: '仍有待决问题', FAIL: '未通过', approve: '批准并继续', reject: '拒绝并结束', stop: '停止本轮', retry: '从检查点重试', resolve: '提交裁决', pass: '通过质量门', rework: '退回开发修复', frontend: '前端', backend: '后端', infrastructure: '基础设施', 'registered-check': '已登记自动检查', manual: '人工验证', passed: '通过', failed: '失败', blocked: '无法完成', succeeded: '成功', cancelled: '已取消', 'rolled-back': '已回滚', 'manual-attention': '需要人工处理', fixed: '已修复（须重新验证）', 'not-an-issue': '判定非问题', defer: '延期处理', blocking: '阻塞', high: '高', medium: '中', low: '低', business: '业务', architecture: '架构', implementation: '实现', verification: '验证', integrity: '完整性', product: '产品', human: '人工' };
/** 从 schema 创建空表单，不把批准、通过或成功预选为用户决定。 */
function empty(schema: FormSchema): any {
  if (schema.default !== undefined) return schema.default;
  if (schema.const !== undefined) return schema.const;
  if (schema.type === 'object') return Object.fromEntries(Object.entries(schema.properties ?? {}).map(/** 子对象只保存明确字段。 */([key, value]) => [key, empty(value)]));
  if (schema.type === 'array') return Array.from({ length: schema.minItems ?? 0 }, /** 最低行数仍保留空输入。 */() => empty(schema.items ?? {}));
  return schema.type === 'number' || schema.type === 'integer' ? schema.minimum ?? 0 : '';
}
/** 递归业务字段；对象、列表及文件映射各自提供可操作控件。 */
function Field({ name, schema, value, change }: { name: string; schema: FormSchema; value: any; change: (value: any) => void }) {
  const title = labels[name] ?? name;
  if (schema.type === 'object' && schema.additionalProperties && !schema.properties) {
    const entries = Object.entries(value ?? {}) as [string, string][];
    /** 用户主动选择的本地文件只作为本次快照，不推导写权限。 */
    async function upload(event: React.ChangeEvent<HTMLInputElement>) {
      const next = { ...value };
      for (const file of Array.from(event.target.files ?? [])) { if (file.size > 100000) throw new Error('单个文件超过 100 KB，请缩小快照'); next[file.name] = await file.text(); }
      change(next);
    }
    return <fieldset><legend>{title}</legend><p>逐项输入相对路径与内容，或选择本地文件后核对路径。允许修改和固定检查需要在下方分别声明。</p><input aria-label="选择本地文件快照" type="file" multiple onChange={/** 读取失败在浏览器显示，保留已有内容。 */e => void upload(e).catch(/** 以控件校验提示文件问题。 */error => e.target.setCustomValidity(error.message))} />{entries.map(/** 文件路径与正文作为一组编辑。 */([path, content], index) => <div key={index} className="gate-row"><label>相对路径<input value={path} onChange={/** 改路径时保留正文，不自动授权。 */e => { const next = Object.fromEntries(entries.map(/** 仅替换本行路径。 */(entry, i) => i === index ? [e.target.value, content] : entry)); change(next); }} /></label><label>文件内容<textarea rows={4} value={content} onChange={/** 内容属于明确上传快照。 */e => change({ ...value, [path]: e.target.value })} /></label><button type="button" onClick={/** 移除文件不删除磁盘文件。 */() => change(Object.fromEntries(entries.filter(/** 保留其他快照文件。 */(_, i) => i !== index)))}>移除此文件</button></div>)}<button type="button" onClick={/** 新文件只创建空白草稿。 */() => change({ ...value, [`file-${entries.length + 1}.mjs`]: '' })}>＋ 添加文件</button></fieldset>;
  }
  if (schema.type === 'object') return <fieldset><legend>{title}</legend>{Object.entries(schema.properties ?? {}).filter(/** 已保存报告版本只读绑定，无需人工抄写。 */([key]) => key !== 'reportHash' || !value?.[key]).map(/** 结构化表单由服务端白名单生成。 */([key, child]) => <Field key={key} name={key} schema={name === 'project' && ['writablePaths', 'checkFiles'].includes(key) ? { ...child, items: { ...child.items, enum: Object.keys(value?.files ?? {}) } } : child} value={value?.[key]} change={/** 子字段更新不丢失其他输入。 */next => change({ ...value, [key]: next })} />)}</fieldset>;
  if (schema.type === 'array') return <fieldset><legend>{title}</legend>{(value ?? []).map(/** 数组行保持服务端契约顺序。 */(item: any, index: number) => <div className="gate-row" key={index}><Field name={name} schema={schema.items ?? { type: 'string' }} value={item} change={/** 只替换当前行。 */next => change(value.map(/** 其他行原样保存。 */(old: any, i: number) => i === index ? next : old))} /><button type="button" disabled={(value?.length ?? 0) <= (schema.minItems ?? 0)} onClick={/** 删除草稿行，最低数量由服务端验证。 */() => change(value.filter(/** 保留其他行。 */(_: any, i: number) => i !== index))}>移除这项</button></div>)}<button type="button" disabled={value?.length >= (schema.maxItems ?? 100)} onClick={/** 添加行不会自动给出批准结论。 */() => change([...(value ?? []), empty(schema.items ?? {})])}>＋ 添加{title}</button></fieldset>;
  if (schema.enum) return <label>{title}<select aria-label={title} required value={value ?? ''} onChange={/** 枚举必须来自实际用户选择。 */e => change(e.target.value)}><option value="">请选择</option>{schema.enum.map(/** 将契约值映射为业务用语。 */option => <option key={option} value={option}>{schema['x-labels']?.[String(option)] ?? choices[option] ?? option}</option>)}</select></label>;
  if (schema.type === 'integer' || schema.type === 'number') return <label>{title}<input aria-label={title} type="number" min={schema.minimum} max={schema.maximum} value={value ?? 0} onChange={/** 数字范围由 schema 与服务端共同校验。 */e => change(Number(e.target.value))} /></label>;
  return <label>{title}<textarea aria-label={title} required={(schema.minLength ?? 0) > 0} rows={['comment', 'expected', 'evidence', 'notes', 'detail'].includes(name) ? 3 : 1} maxLength={schema.maxLength} placeholder={schema.format === 'date-time' ? '例如 2026-11-07T12:00:00Z' : ''} value={value ?? ''} onChange={/** 自由输入只存在于当前草稿。 */e => change(e.target.value)} /></label>;
}
/** 审批材料按段落和条目呈现，正文复用安全 Markdown，不直接显示恢复 JSON。 */
function Evidence({ value, name = '确认材料' }: { value: any; name?: string }) {
  if (value == null) return null;
  if (typeof value === 'string') return <div className="gate-evidence-item"><strong>{labels[name] ?? name}</strong><Markdown>{choices[value] ?? value}</Markdown></div>;
  if (Array.isArray(value)) return <section><h3>{labels[name] ?? name}</h3>{value.length ? value.map(/** 有序证据逐项阅读。 */(item, index) => <Evidence key={index} value={item} name={`${index + 1}`} />) : <p>无</p>}</section>;
  if (typeof value === 'object') return <section>{Object.entries(value).filter(/** 内部绑定单独保存，不干扰业务阅读。 */([key]) => !/hash|fields|instruction/i.test(key)).map(/** 有意义的字段递归展开为阅读材料。 */([key, item]) => <Evidence key={key} value={item} name={key} />)}</section>;
  return <p>{labels[name] ?? name}：{String(value)}</p>;
}
/** 独立关口组件在 gateHash 变化时重建，旧草稿不会混入新审批。 */
export function WorkflowGateForm({ gate, busy, submit }: { gate: WorkflowGate; busy: boolean; submit: (data: unknown) => Promise<void> }) {
  if (gate.key === 'retry-repository-sync') return <RepositorySyncGate gate={gate} busy={busy} submit={submit} />;
  if (gate.key === 'confirm-blocker-answers') return <BlockerClarification gate={gate} busy={busy} submit={submit} />;
  if (gate.key === 'review-revised-product') return <RevisedProductReview gate={gate} busy={busy} submit={submit} />;
  return gate.recoveryInfo ? <DevelopmentRecovery gate={gate} busy={busy} submit={submit} /> : <GenericWorkflowGateForm gate={gate} busy={busy} submit={submit} />;
}
/** 同步是已完成角色产物的技术重试，不展示批准或发布决定表单。 */
function RepositorySyncGate({ gate, busy, submit }: { gate: WorkflowGate; busy: boolean; submit: (data: unknown) => Promise<void> }) {
  const [error, setError] = useState('');
  /** 版本由服务端绑定；错误保留在当前同步关口，不自动重复提交。 */
  async function retry() {
    setError('');
    try { await submit({ gateHash: gate.gateHash, data: gate.fixed }); }
    catch (reason) { setError(reason instanceof Error ? reason.message : '同步尚未完成，请稍后重试'); }
  }
  return <section className="intake-card">
    <div className="intake-eyebrow">角色资料已保存 · 等待同步</div>
    <h1>{gate.title}</h1><p>{gate.description}</p>
    <p>同步成功后继续原流程；需要你确认的产品、方案或发布关口仍会单独展示。</p>
    {error && <p role="alert">{error}</p>}
    <button className="primary" type="button" disabled={busy} onClick={/** 只提交当前同步版本。 */() => void retry()}>{busy ? '正在同步资料…' : '重试远端同步'}</button>
  </section>;
}
/** 其余人工关口沿用 schema 表单，故障恢复使用专门业务指引。 */
function GenericWorkflowGateForm({ gate, busy, submit }: { gate: WorkflowGate; busy: boolean; submit: (data: unknown) => Promise<void> }) {
  const [data, setData] = useState<Record<string, any>>({ ...empty(gate.schema), ...gate.initial, ...gate.fixed });
  const [confirm, setConfirm] = useState(false);
  const [error, setError] = useState('');
  /** 提交前展示业务后果，批准按钮与普通表单编辑区分。 */
  function preview(event: React.FormEvent) { event.preventDefault(); setError(''); setConfirm(true); }
  return <section className="intake-card"><div className="intake-eyebrow">当前待办 · 请审阅后决定</div><h1>{gate.title}</h1><p>{gate.description}</p><details open><summary>查看本次确认依据</summary><div className="gate-evidence"><Evidence value={gate.evidence} /></div></details>
    <form onSubmit={preview}><fieldset disabled={busy}><legend>填写本次决定</legend>{Object.entries(gate.schema.properties ?? {}).filter(/** 版本绑定值由服务端控制，不要求手工输入。 */([key]) => !(key in gate.fixed) && key !== 'resolutions').map(/** 按当前关口显示输入。 */([key, schema]) => <Field key={key} name={key} schema={schema} value={data[key]} change={/** 修改后必须重新预览确认。 */next => { setData({ ...data, [key]: next }); setConfirm(false); }} />)}</fieldset>
    {error && <p role="alert">{error}</p>}{confirm ? <div className="intake-assumptions" role="status"><strong>确认提交“{gate.title}”的决定？</strong><p>{gate.description}</p><p>处理决定：{choices[data.decision ?? data.status] ?? (data.decision ?? data.status ?? '确认本次范围')} · 确认人：{data.reviewer ?? data.operator}</p>{data.project && <p>项目：{data.project.id} · 文件 {Object.keys(data.project.files).length} 份<br />允许修改：{data.project.writablePaths.join('、')}<br />固定检查：{data.project.checkFiles.join('、')}</p>}{data.scope && <p>目标环境：{data.scope.environment} · 制品：{data.scope.artifactRef}<br />回滚制品：{data.scope.rollbackArtifactRef}</p>}<button className="primary" type="button" disabled={busy} onClick={/** 只提交当前材料版本，网络失败不自动重发。 */() => void submit({ gateHash: gate.gateHash, data }).then(/** 成功后由父页面读取下一关口。 */() => setConfirm(false)).catch(/** 失败保留全部输入与明确错误。 */reason => { setError(reason.message); setConfirm(false); })}>确认提交并继续</button><button type="button" disabled={busy} onClick={/** 取消不恢复 Workflow。 */() => setConfirm(false)}>返回检查</button></div> : <button className="primary" type="submit" disabled={busy}>检查并提交本次决定 →</button>}</form>
  </section>;
}
