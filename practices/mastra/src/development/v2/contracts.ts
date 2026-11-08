/** v2 独立契约：不可变证据快照由原生 Workflow 持有，不迁移 v1 状态。 */
import { z } from 'zod';
import { outputDiagnosticSchema } from './output-diagnostic.js';
import { correlationSchema } from '../../delivery/asset-identity.js';
import { architectureSchema, commandEvidenceSchema, developmentInputSchema, developmentReviewSchema, executionIdentitySchema, recoveryReviewSchema, validateArchitecture, developmentHash } from '../contracts.js';

export const productWorkflowIdSchema = z.enum(['product-delivery', 'product-delivery-v2']);
export const inputV2Schema = developmentInputSchema.extend({ correlation: correlationSchema.optional(), source: developmentInputSchema.shape.source.extend({ workflowId: z.enum(['product-delivery', 'product-delivery-v2', 'product-development']).optional() }), scopeApproval: z.object({ reviewer: z.string(), comment: z.string(), productHash: z.string().length(64) }).optional() });
export type InputV2 = z.infer<typeof inputV2Schema>;
export const roleV2Schema = z.enum(['context', 'architect', 'readiness', 'frontend', 'backend', 'infrastructure', 'self-check', 'reviewer']);
export type RoleV2 = z.infer<typeof roleV2Schema>;
export const taskPackageSchema = architectureSchema.shape.tasks.element.extend({
  requirementRefs: z.array(z.string()).min(1), acceptanceRefs: z.array(z.string()).min(1),
  contextRefs: z.array(z.string()).min(1), constraints: z.array(z.string().min(1)).min(1), verificationRefs: z.array(z.string()).min(1),
});
export const planV2Schema = architectureSchema.extend({ tasks: z.array(taskPackageSchema).max(30) });
export const contextDraftSchema = z.object({ rules: z.array(z.object({ text: z.string().min(1), refs: z.array(z.string()).min(1) })).min(1), unknowns: z.array(z.string().min(1)) });
export const findingSchema = z.object({ id: z.string().min(1), severity: z.enum(['blocking', 'high', 'medium', 'low']),
  category: z.enum(['business', 'architecture', 'implementation', 'verification', 'integrity']),
  route: z.enum(['product', 'architecture', 'frontend', 'backend', 'infrastructure', 'human']),
  detail: z.string().min(1), refs: z.array(z.string()).min(1), evidence: z.string().min(1),
});
export const resolutionSchema = z.object({ findingId: z.string().min(1), decision: z.enum(['fixed', 'not-an-issue', 'defer']), reason: z.string().min(1), refs: z.array(z.string()).min(1) });
export const assessmentSchema = z.object({ verdict: z.enum(['PASS', 'CONCERNS', 'FAIL']), findings: z.array(findingSchema).max(30), coverageRefs: z.array(z.string()).min(1), unchecked: z.array(z.string().min(1)), resolutions: z.array(resolutionSchema).max(30) });
export const findingDecisionSchema = resolutionSchema.extend({ reportHash: z.string().length(64) });
export const findingsReviewSchema = z.object({ hash: z.string().length(64), reviewer: z.string().trim().min(1).max(100), comment: z.string().trim().min(1).max(2000), decision: z.enum(['resolve', 'stop']), decisions: z.array(findingDecisionSchema).max(90) });
export const approvalV2Schema = developmentReviewSchema.extend({ resolutions: z.array(resolutionSchema).default([]) });
export const phaseSchema = z.enum(['prepare-context', 'architecture', 'assemble-team', 'assess-readiness', 'resolve-readiness', 'approve-architecture', 'implement', 'development-self-check', 'review-code', 'assess-delivery', 'resolve-findings']);
const hash = z.string().length(64);
export const contextV2Schema = z.object({ productHash: hash, baselineHash: hash, methodBundleHash: hash, files: z.record(z.string(), hash), rules: contextDraftSchema.shape.rules, unknowns: contextDraftSchema.shape.unknowns });
export const reportSchema = z.object({ assessment: assessmentSchema, sourceHash: hash, planHash: hash, checksHash: hash, hash });
export const gateDecisionSchema = z.object({ decision: z.enum(['deliver', 'rework', 'replan', 'clarify', 'stop']), reasons: z.array(z.string()), sourceHash: hash, reportHash: hash.nullable() });
export const teamSchema = z.object({ planHash: hash, maxParallel: z.literal(3), maxDelegations: z.literal(3), delegationDepth: z.literal(1), members: z.array(z.object({ id: z.string(), role: z.enum(['frontend', 'backend', 'infrastructure']), taskId: z.string(), paths: z.array(z.string()) })) });
export const delegationSchema = z.object({ taskId: z.string(), parentId: z.string(), memberId: z.string(), role: z.enum(['frontend', 'backend', 'infrastructure']), goal: z.string(), paths: z.array(z.string()), outputHash: hash, sourceHash: hash });
export const stateV2Schema = z.object({
  team: teamSchema.optional(), delegations: z.array(delegationSchema).optional(),
  version: z.literal('development-state.v2'), input: inputV2Schema, mode: z.enum(['fixture', 'live']), executionIdentity: executionIdentitySchema,
  methodBundleHash: hash, phase: phaseSchema,
  requirements: z.array(z.object({ id: z.string(), line: z.number().int().positive(), text: z.string().min(1), hash })),
  verificationRefs: z.array(z.string()).min(1), context: contextV2Schema.nullable(),
  plan: planV2Schema.nullable(), planHash: hash.nullable(), planSourceHash: hash.nullable(), approvalHash: hash.nullable(), approvedHash: hash.nullable(),
  readiness: reportSchema.nullable(), readinessHistory: z.array(reportSchema), findingsReviews: z.array(findingsReviewSchema), codeReviews: z.array(reportSchema),
  reviews: z.array(approvalV2Schema.extend({ authority: z.enum(['local-human-label', 'evaluation-policy']) })),
  resolutions: z.array(resolutionSchema.extend({ reportHash: hash, authority: z.enum(['reviewer', 'local-human-label']) })),
  checkpointHash: hash, completedTasks: z.array(z.string()), round: z.number().int().nonnegative(), route: z.enum(['all', 'frontend', 'backend', 'infrastructure', 'architecture', 'human']),
  calls: z.number().int().nonnegative(), maxCalls: z.literal(72),
  work: z.array(z.object({ role: roleV2Schema, round: z.number(), text: z.string(), tools: z.array(z.string()), steps: z.number(), modelId: z.string().nullable(), inputTokens: z.number().nullable(), outputTokens: z.number().nullable() })),
  faults: z.array(z.object({ sequence: z.number(), phase: phaseSchema, role: roleV2Schema, taskId: z.string().nullable(), kind: z.enum(['model-timeout', 'model-network', 'invalid-output', 'model-error']), attempt: z.number(), diagnostic: outputDiagnosticSchema.optional(), checkpointHash: hash, partialSourceHash: hash, restored: z.literal(true) })),
  recovery: z.object({ hash, checkpointHash: hash, phase: phaseSchema, role: roleV2Schema, kind: z.string(), diagnostic: outputDiagnosticSchema.optional(), taskId: z.string().nullable() }).nullable(), recoveries: z.array(recoveryReviewSchema),
  checks: z.array(commandEvidenceSchema), checkedSourceHash: hash.nullable(), gates: z.array(gateDecisionSchema),
  outcome: z.enum(['in-progress', 'clarification-required', 'rejected', 'rework-exhausted', 'manual-attention', 'development-delivered']),
  delivery: z.object({ version: z.literal('development-delivery.v2'), productHash: hash, planHash: hash, approvalHash: hash, contextHash: hash, methodBundleHash: hash, readinessHash: hash, reviewHash: hash, sourceHash: hash, files: z.record(z.string(), z.string()), checks: z.array(commandEvidenceSchema), resolutions: z.array(resolutionSchema.extend({ reportHash: hash, authority: z.enum(['reviewer', 'local-human-label']) })), limitations: z.array(z.string()) }).nullable(),
});
export type StateV2 = z.infer<typeof stateV2Schema>;
export type ReportV2 = z.infer<typeof reportSchema>;
export type AssessmentV2 = z.infer<typeof assessmentSchema>;
export type EntryV2 = StateV2['work'][number];

/** 引用只能来自已保存产品原文、已读取文件、当前任务与登记检查，不接受 shell。 */
export function evidenceRefs(state: StateV2): Set<string> {
  const refs = new Set([...state.requirements.map(
    // 行号锚点只定位原文，不声称已自动理解全部验收。
    (item) => item.id,
  ), ...Object.keys(state.context?.files ?? {}).map(
    // 上下文文件引用以明确前缀和原文引用区分。
    (path) => `file:${path}`,
  ), ...state.verificationRefs, ...(state.plan?.tasks.map(
    // 任务引用只属于当前计划。
    (task) => `task:${task.id}`,
  ) ?? [])]);
  return refs;
}

/** 对任务和可追溯引用做宿主硬校验；语义是否完整交给独立评估。 */
export function validatePlanV2(plan: z.infer<typeof planV2Schema>, state: StateV2): void {
  validateArchitecture(plan, state.input);
  const requirements = new Set(state.requirements.map(
    // 按批准原文生成的稳定锚点约束模型引用。
    (item) => item.id,
  ));
  const context = new Set(Object.keys(state.context?.files ?? {}).map(
    // 未读取文件不能成为上下文依据。
    (path) => `file:${path}`,
  ));
  for (const task of plan.tasks) {
    for (const ref of [...task.requirementRefs, ...task.acceptanceRefs]) if (!requirements.has(ref)) throw new SyntaxError('任务引用未知需求或验收');
    for (const ref of task.contextRefs) if (!context.has(ref)) throw new SyntaxError('任务引用未知上下文');
    for (const ref of task.verificationRefs) if (!state.verificationRefs.includes(ref)) throw new SyntaxError('任务引用未登记检查');
  }
  if (!plan.blockers.length) for (const ref of requirements) {
    if (!plan.tasks.some(
      // 引用存在是最低门槛，不替代就绪阶段的双向语义检查。
      (task) => task.requirementRefs.includes(ref) || task.acceptanceRefs.includes(ref),
    )) throw new SyntaxError('任务遗漏批准原文引用');
  }
}

/** 批准同时绑定上下文、任务、方法、就绪和模型身份；不绑定后续正常源码变化。 */
export function approvalHashV2(state: StateV2): string {
  return developmentHash({ input: state.input, baselineHash: state.planSourceHash, context: state.context, plan: state.plan, readiness: state.readiness, executionIdentity: state.executionIdentity, methodBundleHash: state.methodBundleHash, ...(state.team ? { team: state.team } : {}) });
}

/** 故障接续绑定失败阶段与完整证据，防止评审故障恢复时重放实现。 */
export function recoveryHashV2(state: StateV2): string {
  return developmentHash({ ...state, recovery: null });
}

/** 固定检查清单由输入派生，模型不能添加命令或降低验证范围。 */
export function registeredChecks(input: InputV2): string[] {
  if (input.project.executionProfile === 'hrm-pnpm-docker-v1') return ['project:check', 'project:build', 'project:smoke'];
  return [...Object.keys(input.project.files).filter(
    // 与受限执行 Adapter 的实际 Node 语法检查选择保持一致。
    (path) => path.startsWith('src/') && path.endsWith('.mjs'),
  ).sort().map(
    // 语法检查使用 Adapter 的固定 ID。
    (path) => `syntax:${path}`,
  ), ...input.project.checkFiles.map(
    // smoke 只引用 manifest 预登记的不可写文件。
    (path) => `test:${path}`,
  )];
}

/** 人工裁决绑定当前发现、源码和批准；旧裁决不能复用于后续代码。 */
export function findingsHashV2(state: StateV2): string {
  return developmentHash({ phase: state.phase, input: state.input, checkpointHash: state.checkpointHash, approvalHash: state.approvalHash, readiness: state.readiness, codeReviews: state.codeReviews, resolutions: state.resolutions, executionIdentity: state.executionIdentity, methodBundleHash: state.methodBundleHash });
}
