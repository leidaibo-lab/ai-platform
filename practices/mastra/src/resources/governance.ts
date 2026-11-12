/**
 * ADR: docs/decisions/2026-11-12-mastra-governed-run-records.md
 *
 * 产研 Run 的最小治理对象。Mastra Store 仍是唯一持久化事实源；本模块只
 * 固定跨阶段 DTO、摘要和守卫，不创建第二套编排、审批或执行状态。
 */
import { z } from 'zod';
import { resourceHash } from './contracts.js';

const hash = z.string().regex(/^[a-f0-9]{64}$/);
const identifier = z.string().trim().min(1).max(200);
const paths = z.array(z.string().trim().min(1).max(400)).max(300);

/** 可由下游产物引用的、不可变的事实证据摘要。 */
export const evidenceRefSchema = z.object({
  id: identifier,
  kind: z.enum(['invocation', 'tool', 'check', 'approval', 'source-snapshot', 'artifact']),
  hash,
}).strict();
export type EvidenceRef = z.infer<typeof evidenceRefSchema>;

/** 统一的只读证据记录；正文仍留在对应Workflow状态，避免建立平行证据库。 */
export const evidenceRecordSchema = z.object({
  version: z.literal('evidence-record.v1'), id: identifier,
  kind: z.enum(['invocation', 'tool-receipt', 'check-result', 'deployment-receipt', 'health-receipt', 'rollback-receipt', 'approval-receipt']),
  runId: identifier, sourceHash: hash.nullable(), payloadHash: hash, refs: z.array(evidenceRefSchema).max(100), hash,
}).strict();
export type EvidenceRecord = z.infer<typeof evidenceRecordSchema>;

/** 由既有持久化事实投影引用证据；此函数不写库、不接受模型自报的hash。 */
export function createEvidenceRecord(input: Omit<EvidenceRecord, 'version' | 'id' | 'hash'>): EvidenceRecord {
  const refs = [...input.refs].sort((left, right) => `${left.kind}:${left.id}`.localeCompare(`${right.kind}:${right.id}`));
  const payload = { ...input, refs };
  const hashValue = resourceHash(payload);
  return evidenceRecordSchema.parse({ ...payload, version: 'evidence-record.v1', id: `evidence:${hashValue.slice(0, 24)}`, hash: hashValue });
}

/** 单次工具调用的统一回执投影；工具执行结果仍归原生Agent/Workflow状态所有。 */
export const toolExecutionReceiptSchema = z.object({
  version: z.literal('tool-execution-receipt.v1'), id: identifier, runId: identifier, invocationId: hash.nullable(), toolId: identifier,
  inputHash: hash.nullable(), outputHash: hash.nullable(), status: z.enum(['succeeded', 'failed', 'timed_out', 'denied']), evidence: evidenceRecordSchema,
}).strict();
export type ToolExecutionReceipt = z.infer<typeof toolExecutionReceiptSchema>;

/** 所有角色正文与宿主派生交接物的统一信封；正文不自行声明授权或执行成功。 */
export const artifactRecordSchema = z.object({
  version: z.literal('artifact.v1'),
  id: identifier,
  kind: z.enum(['product-work', 'product-document', 'context', 'task-plan', 'assessment', 'implementation-summary', 'self-check-summary', 'test-plan', 'release-plan']),
  schemaVersion: identifier,
  content: z.string().min(1).max(100000),
  hash,
  evidenceRefs: z.array(evidenceRefSchema).max(100),
}).strict();
export type ArtifactRecord = z.infer<typeof artifactRecordSchema>;

/** 建立并复核统一交接物，hash覆盖正文、契约和证据引用而不包含可变显示字段。 */
export function createArtifact(input: Omit<ArtifactRecord, 'version' | 'hash'>): ArtifactRecord {
  const evidenceRefs = [...input.evidenceRefs].sort((left, right) => `${left.kind}:${left.id}`.localeCompare(`${right.kind}:${right.id}`));
  return artifactRecordSchema.parse({ ...input, version: 'artifact.v1', evidenceRefs, hash: resourceHash({ id: input.id, kind: input.kind, schemaVersion: input.schemaVersion, content: input.content, evidenceRefs }) });
}

/** 人工确认的可审计摘要；认证身份仍由未来的外部身份系统提供。 */
export const approvalRecordSchema = z.object({
  version: z.literal('approval.v1'),
  id: identifier,
  gate: z.enum(['product', 'project-scope', 'architecture', 'quality', 'release']),
  decision: z.enum(['approve', 'reject', 'rework', 'pass', 'stop']),
  actor: identifier,
  artifactHash: hash,
  comment: z.string().trim().min(1).max(2000),
  hash,
}).strict();
export type ApprovalRecord = z.infer<typeof approvalRecordSchema>;

/** 将人工关口的角色、版本、决定与说明冻结为可被授权引用的审批摘要。 */
export function createApproval(input: Omit<ApprovalRecord, 'version' | 'id' | 'hash'>): ApprovalRecord {
  const payload = { ...input };
  const hashValue = resourceHash(payload);
  return approvalRecordSchema.parse({ ...payload, version: 'approval.v1', id: `approval:${hashValue.slice(0, 24)}`, hash: hashValue });
}

/** 所有原生暂停点的只读统一投影；gateHash绑定当时展示给人的材料。 */
export const humanGateSchema = z.object({
  version: z.literal('human-gate.v1'), id: identifier, runId: identifier,
  gateType: z.enum(['requirements', 'product', 'project-scope', 'architecture', 'finding-resolution', 'recovery', 'test-cases', 'quality', 'release', 'deployment', 'health', 'rollback', 'repository-sync', 'blocker']),
  requiredArtifactHashes: z.array(hash).max(100), gateHash: hash, status: z.enum(['open', 'resolved']),
}).strict();
export type HumanGate = z.infer<typeof humanGateSchema>;

/** 人工提交经既有schema校验后投影为回执，不能反向改变原生resume数据。 */
export const approvalReceiptSchema = z.object({
  version: z.literal('approval-receipt.v1'), id: identifier, gateId: identifier, decision: z.enum(['approve', 'reject', 'rework', 'pass', 'resolve', 'stop', 'submitted']),
  actor: identifier.nullable(), payloadHash: hash, bindingHashes: z.array(hash).max(100), evidence: evidenceRecordSchema, hash,
}).strict();
export type ApprovalReceipt = z.infer<typeof approvalReceiptSchema>;

/** 建立HumanGate投影，未知暂停点必须显式标为不可投影而非被误归类。 */
export function createHumanGate(input: Omit<HumanGate, 'version' | 'id'>): HumanGate {
  const id = `gate:${resourceHash({ runId: input.runId, gateType: input.gateType, gateHash: input.gateHash }).slice(0, 24)}`;
  return humanGateSchema.parse({ ...input, version: 'human-gate.v1', id });
}

/** 从已校验的人类输入建立回执与可引用证据；actor缺省时保持null，不伪造身份。 */
export function createApprovalReceipt(input: { gate: HumanGate; decision: ApprovalReceipt['decision']; actor?: string | null; payload: unknown; bindingHashes: readonly string[] }): ApprovalReceipt {
  const payloadHash = resourceHash(input.payload);
  const evidence = createEvidenceRecord({ kind: 'approval-receipt', runId: input.gate.runId, sourceHash: input.gate.gateHash, payloadHash, refs: [] });
  const bindingHashes = [...new Set(input.bindingHashes)].sort();
  const hashValue = resourceHash({ gateId: input.gate.id, decision: input.decision, actor: input.actor ?? null, payloadHash, bindingHashes, evidence: evidence.hash });
  return approvalReceiptSchema.parse({ version: 'approval-receipt.v1', id: `receipt:${hashValue.slice(0, 24)}`, gateId: input.gate.id, decision: input.decision, actor: input.actor ?? null, payloadHash, bindingHashes, evidence, hash: hashValue });
}

/** 宿主由项目范围确认派生的最小执行授权；模型无权创建或扩大该对象。 */
export const capabilityGrantSchema = z.object({
  version: z.literal('capability-grant.v1'),
  id: identifier,
  runId: identifier,
  sourceArtifactHash: hash,
  approvalHash: hash,
  roles: z.array(z.enum(['frontend', 'backend', 'infrastructure'])).min(1).max(3),
  writablePaths: paths,
  registeredChecks: paths,
  maxCalls: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  maxReworks: z.number().int().min(0).max(3),
  hash,
}).strict();
export type CapabilityGrant = z.infer<typeof capabilityGrantSchema>;

/** 由人工范围确认的不可变输入派生授权；相同授权语义稳定得到相同摘要。 */
export function createCapabilityGrant(input: Omit<CapabilityGrant, 'version' | 'id' | 'hash'>): CapabilityGrant {
  const roles = [...new Set(input.roles)].sort();
  const writablePaths = [...new Set(input.writablePaths)].sort();
  const registeredChecks = [...new Set(input.registeredChecks)].sort();
  const payload = { ...input, roles, writablePaths, registeredChecks };
  const hashValue = resourceHash(payload);
  return capabilityGrantSchema.parse({ ...payload, version: 'capability-grant.v1', id: `grant:${hashValue.slice(0, 24)}`, hash: hashValue });
}

/** 拒绝被篡改、跨 Run 或越权的授权；调用者再按任务检查精确路径。 */
export function assertCapabilityGrant(value: unknown, runId: string, sourceArtifactHash: string): CapabilityGrant {
  const grant = capabilityGrantSchema.parse(value);
  const { version: _version, id: _id, hash: actual, ...payload } = grant;
  if (grant.runId !== runId || grant.sourceArtifactHash !== sourceArtifactHash || actual !== resourceHash(payload)) throw new Error('能力授权与当前Run或产品版本不匹配');
  return grant;
}

/** TaskPlan 是已校验架构计划的稳定摘要，不取代开发状态或原生 Workflow 任务图。 */
export const taskPlanSchema = z.object({
  version: z.literal('task-plan.v1'),
  artifactHash: hash,
  capabilityGrantHash: hash,
  taskIds: z.array(identifier).max(30),
  hash,
}).strict();
export type TaskPlan = z.infer<typeof taskPlanSchema>;

/** 将已验证的任务清单投影为下游可引用的计划摘要。 */
export function createTaskPlan(artifactHash: string, capabilityGrantHash: string, taskIds: readonly string[]): TaskPlan {
  const normalized = [...new Set(taskIds)].sort();
  return taskPlanSchema.parse({ version: 'task-plan.v1', artifactHash, capabilityGrantHash, taskIds: normalized, hash: resourceHash({ artifactHash, capabilityGrantHash, taskIds: normalized }) });
}

/** 从Mastra已保存状态生成只读Run视图；绝不将其写回或作为恢复输入。 */
export const agentRunProjectionSchema = z.object({
  version: z.literal('agent-run-projection.v1'), runId: identifier, workflowVersion: identifier, bundleHash: hash,
  phase: identifier, outcome: identifier, budget: z.object({ calls: z.number().int().nonnegative(), maxCalls: z.number().int().positive(), reworks: z.number().int().nonnegative() }).strict(),
  capabilityGrantHash: hash.nullable(), taskPlanHash: hash.nullable(), sourceHash: hash.nullable(),
}).strict();
export type AgentRunProjection = z.infer<typeof agentRunProjectionSchema>;

/** 将现有StateV2/Lifecycle中已经保存的事实汇总为只读投影。 */
export function projectAgentRun(input: { runId: string; bundleHash: string; state: { phase?: string; outcome?: string; calls?: number; maxCalls?: number; round?: number; input?: { source?: { hash?: string }; scopeApproval?: { capabilityGrant?: { hash?: string } } }; taskPlan?: { hash?: string } | null } }): AgentRunProjection {
  const state = input.state;
  return agentRunProjectionSchema.parse({ version: 'agent-run-projection.v1', runId: input.runId, workflowVersion: 'product-development-resources-v1', bundleHash: input.bundleHash, phase: state.phase ?? 'unknown', outcome: state.outcome ?? 'unknown', budget: { calls: state.calls ?? 0, maxCalls: state.maxCalls ?? 1, reworks: state.round ?? 0 }, capabilityGrantHash: state.input?.scopeApproval?.capabilityGrant?.hash ?? null, taskPlanHash: state.taskPlan?.hash ?? null, sourceHash: state.input?.source?.hash ?? null });
}
