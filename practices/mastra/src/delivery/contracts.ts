import { browserCaseSchema, browserReceiptSchema } from '../browser-qa/contracts.js';
import { remoteHandoffSchema } from './remote-handoff.js';
/** 全链路版本化快照：原生 Store 拥有事实，自动进程与人工外部回执分开标记。 */
import { z } from 'zod';
import { commandEvidenceSchema, developmentHash } from '../development/contracts.js';
import { findingSchema, stateV2Schema } from '../development/v2/contracts.js';
import { invocationEvidenceSchema } from '../resources/projections.js';
import { artifactRecordSchema } from '../resources/governance.js';
import { evidenceRecordSchema } from '../resources/governance.js';
import { roleExecutionSchema, testingRoleExtensionSchema, operationsRoleExtensionSchema } from '../diagnostics/role-execution.js';

export const hashSchema = z.string().regex(/^[a-f0-9]{64}$/);
/** 原生 Store 拥有源码推送回执；版本与质量门绑定，不能由模型自行声明。 */
/** 候选源码先入Run交接分支；质量回执稍后绑定同一不可变commit。 */
export const codePublicationSchema = z.object({ version: z.literal('code-publication.v2'), status: z.enum(['candidate', 'quality-attested']), baselineCommit: z.string().regex(/^[a-f0-9]{40,64}$/), sourceHash: hashSchema, qualityHash: hashSchema.nullable(), receipt: remoteHandoffSchema });
const text = z.string().trim().min(1).max(2000);
export const actorSchema = z.object({ reviewer: z.string().trim().min(1).max(100), comment: text });
export const testCaseSchema = z.object({ id: z.string().min(1).max(100), requirementRefs: z.array(z.string()).min(1), expected: text, method: z.enum(['registered-check', 'manual', 'browser']), checkRefs: z.array(z.string()), browser: browserCaseSchema.optional() });
export const caseResultSchema = z.object({ caseId: z.string().min(1), status: z.enum(['passed', 'failed', 'blocked']), evidence: text, authority: z.enum(['sandbox-process', 'local-human-report', 'browser-process']) });
export const testPlanSchema = z.object({ content: z.string().min(1).max(100000), sourceHash: hashSchema, hash: hashSchema, browserMethodHash: hashSchema.optional(), invocation: invocationEvidenceSchema.optional(), artifact: artifactRecordSchema.optional(), execution: roleExecutionSchema.optional(), roleExtension: z.union([testingRoleExtensionSchema, operationsRoleExtensionSchema]).optional() });
export const planApprovalSchema = actorSchema.extend({ hash: hashSchema, decision: z.enum(['approve', 'stop']), cases: z.array(testCaseSchema).min(1).max(100) });
export const qualityReviewSchema = actorSchema.extend({ hash: hashSchema, decision: z.enum(['pass', 'rework', 'stop']), manualResults: z.array(caseResultSchema.omit({ authority: true })).max(100), findings: z.array(findingSchema).max(30) });
export const browserQualitySchema = z.object({ methodHash: hashSchema, receipts: z.array(browserReceiptSchema).max(3), report: z.string().max(10000), tools: z.array(z.string()), hash: hashSchema });
export const qualityStateSchema = z.object({ status: z.enum(['pending', 'rework', 'passed', 'blocked']), plan: testPlanSchema.nullable(), approval: planApprovalSchema.nullable(), checks: z.array(commandEvidenceSchema), results: z.array(caseResultSchema), sourceHash: hashSchema.nullable(), reportHash: hashSchema.nullable(), review: qualityReviewSchema.nullable(), browser: browserQualitySchema.optional() });
export const releaseScopeSchema = z.object({ environment: z.string().trim().min(1).max(100), artifactDigest: hashSchema, artifactRef: text, rollbackArtifactRef: text, healthChecks: z.array(z.object({ id: z.string().min(1).max(100), expected: text })).min(1).max(30) });
export const releaseApprovalSchema = actorSchema.extend({ hash: hashSchema, decision: z.enum(['approve', 'stop']), scope: releaseScopeSchema });
export const deploymentReceiptSchema = z.object({ releaseHash: hashSchema, sourceHash: hashSchema, artifactDigest: hashSchema, environment: z.string(), status: z.enum(['succeeded', 'failed', 'cancelled']), jobRef: text, operator: text, finishedAt: z.iso.datetime(), notes: text });
export const healthReceiptSchema = z.object({ releaseHash: hashSchema, deploymentReceiptHash: hashSchema, operator: text, checks: z.array(z.object({ id: z.string(), status: z.enum(['passed', 'failed']), evidence: text, observedAt: z.iso.datetime() })).min(1).max(30) });
export const rollbackReceiptSchema = z.object({ releaseHash: hashSchema, rollbackArtifactRef: text, status: z.enum(['rolled-back', 'manual-attention']), jobRef: text, operator: text, notes: text });
/** 外部PR平台回执；Workflow不保存平台凭据，也不直接合并main。 */
export const pullRequestReceiptSchema = z.object({ sourceBranch: z.string().regex(/^codex\/workflow\/[a-zA-Z0-9_-]{1,200}$/), sourceCommit: z.string().regex(/^[a-f0-9]{40,64}$/), targetBranch: z.literal('main'), url: text, status: z.enum(['merged', 'closed']), approvedBy: text, mergeCommit: z.string().regex(/^[a-f0-9]{40,64}$/), targetBranchHead: z.string().regex(/^[a-f0-9]{40,64}$/), operator: text, finishedAt: z.iso.datetime(), notes: text });
export const releaseStateSchema = z.object({ plan: testPlanSchema.nullable(), qualityHash: hashSchema.nullable(), approval: releaseApprovalSchema.nullable(), hash: hashSchema.nullable(), receipt: deploymentReceiptSchema.nullable(), receiptEvidence: evidenceRecordSchema.optional(), health: healthReceiptSchema.nullable(), healthEvidence: evidenceRecordSchema.optional(), rollback: rollbackReceiptSchema.nullable(), rollbackEvidence: evidenceRecordSchema.optional(), pullRequest: pullRequestReceiptSchema.nullable().optional(), authority: z.literal('local-human-report') });
export const lifecycleSchema = z.object({ codePublication: codePublicationSchema.optional(), repositoryHandoff: remoteHandoffSchema.optional(), version: z.literal('delivery-lifecycle.v1'), bundleHash: hashSchema.optional(), brief: z.string().min(1), development: stateV2Schema, quality: qualityStateSchema, qualityHistory: z.array(qualityStateSchema), developmentHistory: z.array(stateV2Schema.shape.delivery.unwrap()), release: releaseStateSchema, outcome: z.enum(['in-progress', 'blocked', 'rework-exhausted', 'rejected', 'rolled-back', 'manual-attention', 'delivery-confirmed', 'fixture-completed']), limitations: z.array(z.string()) });
export type Lifecycle = z.infer<typeof lifecycleSchema>;

/** QA 审阅绑定计划、用例批准、源码及真实检查，不能重用旧版本通过记录。 */
export function qualityHash(state: Lifecycle): string {
  // 与原生步骤持久化使用同一 schema 字段顺序，避免对象构造顺序造成假漂移。
  const quality = qualityStateSchema.parse(state.quality);
  return developmentHash({ bundleHash: state.bundleHash, sourceHash: quality.sourceHash, plan: quality.plan, approval: quality.approval, checks: quality.checks, results: quality.results, review: quality.review, ...(quality.browser ? { browser: quality.browser } : {}) });
}

/** 发布绑定测试通过记录、源码与整个发布范围；外部回执只能匹配此版本。 */
export function releaseHash(state: Lifecycle): string {
  return developmentHash({ bundleHash: state.bundleHash, sourceHash: state.development.checkpointHash, qualityHash: state.release.qualityHash, plan: state.release.plan, approval: state.release.approval });
}

/** 每次回归清空本轮证据；旧状态由调用者追加历史后保留。 */
export function emptyQuality(): Lifecycle['quality'] {
  return { status: 'pending', plan: null, approval: null, checks: [], results: [], sourceHash: null, reportHash: null, review: null };
}
