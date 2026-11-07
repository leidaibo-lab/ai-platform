/** 确定性门禁；模型提供语义发现，宿主拥有批准和交付决定。 */
import { z } from 'zod';
import { developmentExecutionIdentity, developmentHash } from '../contracts.js';
import type { PracticeConfig } from '../../mastra/config.js';
import { approvalHashV2, assessmentSchema, evidenceRefs, findingsReviewSchema, type AssessmentV2, type StateV2, type ReportV2 } from './contracts.js';

/** 每个可执行阶段重新校验输入、模型和方法，不允许运行中漂移。 */
export function validateIdentityV2(state: StateV2, config: PracticeConfig, methodHash: string): void {
  if (developmentHash(state.executionIdentity) !== developmentHash(developmentExecutionIdentity(config)) || state.mode !== config.mode || state.methodBundleHash !== methodHash) throw new Error('v2模型、模式或方法发生漂移');
}

/** 报告必须带真实覆盖和可定位证据，不能把空报告或非法PASS当作无问题。 */
export function validateAssessment(assessment: AssessmentV2, state: StateV2): void {
  const refs = evidenceRefs(state);
  for (const ref of assessment.coverageRefs) if (!refs.has(ref)) throw new SyntaxError('报告覆盖引用未知');
  const ids = new Set<string>();
  for (const finding of assessment.findings) {
    if (ids.has(finding.id)) throw new SyntaxError('报告发现ID重复');
    ids.add(finding.id);
    for (const ref of finding.refs) if (!refs.has(ref)) throw new SyntaxError('发现引用未知');
    if (['frontend', 'backend', 'infrastructure'].includes(finding.route) && !state.input.project.roles.includes(finding.route as 'frontend' | 'backend' | 'infrastructure')) throw new SyntaxError('发现指向未登记角色');
  }
  if ((assessment.verdict === 'PASS') !== (assessment.findings.length === 0)) throw new SyntaxError('报告判定与发现不一致');
  const required = [...state.requirements.map(
    // 原文锚点只能证明结构覆盖，真实语义仍属模型评估范围。
    (item) => item.id,
  ), ...(state.plan?.tasks.map(
    // 就绪和评审都要求显式覆盖当前任务。
    (task) => `task:${task.id}`,
  ) ?? [])];
  for (const ref of required) if (!assessment.coverageRefs.includes(ref)) throw new SyntaxError('报告遗漏需求或任务覆盖');
  for (const resolution of assessment.resolutions) for (const ref of resolution.refs) if (!refs.has(ref)) throw new SyntaxError('处理记录引用未知');
}

/** 将宿主版本绑定附加到已校验报告，不信任模型自填hash。 */
export function reportV2(assessment: AssessmentV2, state: StateV2): ReportV2 {
  const normalized = assessmentSchema.parse(assessment);
  validateAssessment(normalized, state);
  const binding = { assessment: normalized, sourceHash: state.checkpointHash, planHash: state.planHash!, checksHash: developmentHash(state.checks) };
  return { ...binding, hash: developmentHash(binding) };
}

/** 全部登记检查必须恰好执行且成功，缺失或陈旧证据不交付。 */
export function checksPassedV2(state: StateV2): boolean {
  if (state.checks.length !== state.verificationRefs.length) return false;
  const ids = state.checks.map(
    // 只比较宿主登记的实际检查ID。
    (check) => check.id,
  );
  return ids.length === state.verificationRefs.length && new Set(ids).size === ids.length && state.verificationRefs.every(
    // 每项检查必须唯一、成功、未超时和未截断。
    (id) => state.checks.some(
      // 非零原始进程状态同样失败关闭。
      (check) => check.id === id && check.exitCode === 0 && (check.processExitCode === undefined || check.processExitCode === 0) && !check.timedOut && !check.stdoutTruncated && !check.stderrTruncated,
    ),
  );
}

/** 汇总旧报告中尚未以证据处理的发现，原始报告保留不可变。 */
export function unresolvedV2(state: StateV2) {
  return state.codeReviews.flatMap(
    // 相同ID跨轮保留源报告绑定，处理不能覆盖其他版本。
    (report) => report.assessment.findings.filter(
      // 逐项处理必须绑定报告；延期仅在人工门允许的严重性内生效。
      (finding) => !state.resolutions.some(
        // 自动修复结论必须来自后续独立评审。
        (resolution) => resolution.reportHash === report.hash && resolution.findingId === finding.id,
      ),
    ),
  );
}

/** 人工批准只针对当前绑定包，确定性结构与FAIL不提供评论绕过。 */
export function assertApprovalV2(state: StateV2): void {
  if (!state.plan || !state.readiness || state.readiness.assessment.verdict !== 'PASS' || state.approvalHash !== approvalHashV2(state)) throw new Error('当前方案包未就绪或批准绑定无效');
}

/** 报告处理记录必须指向旧发现；自动处理只允许后续评审确认修复。 */
export function validateReviewResolutions(assessment: AssessmentV2, state: StateV2): void {
  const seen = new Set<string>();
  for (const resolution of assessment.resolutions) {
    if (seen.has(resolution.findingId) || resolution.decision !== 'fixed' || !state.codeReviews.some(
      // 自动关闭只存在于此前持久化报告的发现。
      (report) => report.assessment.findings.some(
        // ID按原始发现精确匹配，不从文本猜测。
        (finding) => finding.id === resolution.findingId,
      ),
    )) throw new SyntaxError('评审处理记录未引用唯一旧发现或不是修复结论');
    seen.add(resolution.findingId);
  }
}

/** 人工裁决必须逐项、有引用且不可越过完整性、检查或严重问题延期门禁。 */
export function applyFindingsReview(state: StateV2, review: z.infer<typeof findingsReviewSchema>): StateV2 {
  const reports = state.phase === 'resolve-readiness' ? [state.readiness!] : state.codeReviews;
  const pending = reports.flatMap(
    // 保存报告绑定，重复ID不会覆盖另一个源报告。
    (report) => report.assessment.findings.filter(
      // 已解决条目无需再次处理。
      (finding) => !state.resolutions.some(
        // 只接受匹配版本的结论。
        (resolution) => resolution.reportHash === report.hash && resolution.findingId === finding.id,
      ),
    ).map(
      // 将原发现和源报告一起交给裁决校验。
      (finding) => ({ report, finding }),
    ),
  );
  if (review.decision === 'stop') return { ...state, findingsReviews: [...state.findingsReviews, review], outcome: 'manual-attention' };
  if (pending.length !== review.decisions.length) throw new Error('裁决必须逐项处理全部当前发现');
  const refs = evidenceRefs(state); const seen = new Set<string>();
  for (const decision of review.decisions) {
    const key = `${decision.reportHash}:${decision.findingId}`;
    const entry = pending.find(
      // 错误版本在resume前拒绝，暂停点不消耗。
      (item) => item.report.hash === decision.reportHash && item.finding.id === decision.findingId,
    );
    if (!entry || seen.has(key)) throw new Error('裁决引用未知或重复发现');
    seen.add(key);
    if (entry.finding.category === 'integrity' || decision.decision === 'fixed') throw new Error('完整性问题或源码修复必须重新实现和验证');
    if (decision.decision === 'defer' && (state.phase === 'resolve-readiness' || ['blocking', 'high'].includes(entry.finding.severity))) throw new Error('就绪问题或严重发现不得延期放行');
    for (const ref of decision.refs) if (!refs.has(ref)) throw new Error('裁决依据引用未知');
  }
  return { ...state, findingsReviews: [...state.findingsReviews, review], resolutions: [...state.resolutions, ...review.decisions.map(
    // 人工标签与独立评审结论分开记录，原发现不修改。
    (decision) => ({ ...decision, authority: 'local-human-label' as const }),
  )] };
}
