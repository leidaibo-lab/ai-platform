/** 角色最小交接 DTO 注册表：模型只接收宿主投影，不接收 Store、完整状态或任意嵌套对象。 */
import { z } from 'zod';
import { resourceHash } from './contracts.js';
import type { RuntimeResourceConfig } from './resource-config.js';
import type { FrozenResources } from './contracts.js';
import { createEvidenceRecord, toolExecutionReceiptSchema } from './governance.js';

const hash = z.string().regex(/^[a-f0-9]{64}$/);
const text = z.string().trim().min(1).max(100000);
const identifier = z.string().trim().min(1).max(200);
const stringList = z.array(z.string().trim().min(1).max(1000)).max(300);
// 产品角色传递的是已保存的上游正文，不适用开发任务标签的千字短文本限制。
const productDecisionList = z.array(text).max(4);
const contentRefSchema = z.object({ id: identifier, hash, content: text }).strict();
const hashRefSchema = z.object({ id: identifier, hash }).strict();
const requirementSchema = z.object({ id: identifier, text, hash }).strict();
const fileSchema = z.object({ path: z.string().trim().min(1).max(400), hash, content: z.string().max(100000) }).strict();
const taskSchema = z.object({ id: identifier, role: z.enum(['frontend', 'backend', 'infrastructure']), paths: stringList, dependsOn: stringList, requirementRefs: stringList, acceptanceRefs: stringList, contextRefs: stringList, constraints: stringList, verificationRefs: stringList }).strict();
const findingSchema = z.object({ id: identifier, category: identifier, route: identifier, detail: text, refs: stringList }).strict();

/** 十三种固定职责分别声明字段；未知字段、Store、执行器和凭据在边界被拒绝。 */
export const roleInputSchemas = {
  'product-coordinator': z.object({ brief: text, sourceRefs: z.array(hashRefSchema).max(100), intakeReady: z.boolean(), priorEntries: z.array(contentRefSchema).max(4), reworkFeedback: text.nullable() }).strict(),
  'product-clarification': z.object({ brief: text, sourceRefs: z.array(hashRefSchema).max(100), coordination: contentRefSchema, priorEntries: z.array(contentRefSchema).max(4), reworkFeedback: text.nullable() }).strict(),
  'product-closure': z.object({ brief: text, sourceRefs: z.array(hashRefSchema).max(100), clarification: contentRefSchema, coordinationDecisions: productDecisionList, reworkFeedback: text.nullable() }).strict(),
  'product-writing': z.object({ brief: text, sourceRefs: z.array(hashRefSchema).max(100), clarification: contentRefSchema, closure: contentRefSchema, coordinationDecisions: productDecisionList, reworkFeedback: text.nullable() }).strict(),
  context: z.object({ approvedProduct: contentRefSchema, requirements: z.array(requirementSchema).max(300), projectScope: z.object({ id: identifier, files: z.array(fileSchema).max(300), writablePaths: stringList, checkFiles: stringList, roles: z.array(z.enum(['frontend', 'backend', 'infrastructure'])).max(3) }).strict(), fileManifest: z.array(hashRefSchema).max(300) }).strict(),
  architect: z.object({ approvedProduct: contentRefSchema, requirements: z.array(requirementSchema).max(300), context: z.array(contentRefSchema).max(300), projectScope: z.object({ id: identifier, writablePaths: stringList, checkFiles: stringList, roles: z.array(z.enum(['frontend', 'backend', 'infrastructure'])).max(3) }).strict(), referenceGroups: z.object({ requirements: stringList, contextFiles: stringList, registeredChecks: stringList }).strict(), priorBlockingFindings: z.array(findingSchema).max(30) }).strict(),
  readiness: z.object({ approvedProduct: contentRefSchema, requirements: z.array(requirementSchema).max(300), context: z.array(contentRefSchema).max(300), plan: z.object({ hash, summary: text, tasks: z.array(taskSchema).max(30) }).strict(), taskPackages: z.array(taskSchema).max(30), referenceGroups: z.object({ requirements: stringList, contextFiles: stringList, registeredChecks: stringList }).strict() }).strict(),
  'implementation-owner': z.object({ task: taskSchema, requiredContracts: stringList, contextRefs: stringList, dependencyOutputs: z.array(contentRefSchema).max(30), assignedFileRefs: z.array(hashRefSchema).max(100), findings: z.array(findingSchema).max(30), remainingTaskBudget: z.number().int().nonnegative().max(72) }).strict(),
  'implementation-member': z.object({ delegatedTask: taskSchema, requiredContracts: stringList, contextRefs: stringList, assignedFileRefs: z.array(hashRefSchema).max(100), relevantDependencyOutputs: z.array(contentRefSchema).max(30), findings: z.array(findingSchema).max(30) }).strict(),
  'self-check': z.object({ registeredChecks: stringList, sourceHash: hash, taskCompletionSummary: z.array(hashRefSchema).max(30) }).strict(),
  reviewer: z.object({ approvedProduct: contentRefSchema, requirements: z.array(requirementSchema).max(300), approvedPlan: z.object({ hash, summary: text, tasks: z.array(taskSchema).max(30) }).strict(), diff: z.array(fileSchema).max(300), sourceRefs: z.array(hashRefSchema).max(300), checkEvidence: z.array(hashRefSchema).max(100), unresolvedFindings: z.array(findingSchema).max(30), referenceGroups: z.object({ requirements: stringList, contextFiles: stringList, registeredChecks: stringList }).strict() }).strict(),
  testing: z.object({ approvedProduct: contentRefSchema, requirements: z.array(requirementSchema).max(300), approvedContracts: z.object({ planHash: hash, sourceHash: hash, deliveryHash: hash }).strict(), sourceRefs: z.array(fileSchema).max(300), registeredChecks: stringList, priorQualityFindings: z.array(findingSchema).max(30) }).strict(),
  operations: z.object({ productReleaseSummary: contentRefSchema, developmentDeliveryRef: z.object({ sourceHash: hash, planHash: hash, approvalHash: hash }).strict(), qualityApprovalRef: z.object({ qualityHash: hash, status: z.literal('passed') }).strict(), sourceHash: hash, releaseConstraints: z.array(hashRefSchema).max(100) }).strict(),
} as const;
export type RoleResourceId = keyof typeof roleInputSchemas;

/** 所有模型产出均由宿主包裹为有限正文，细粒度开发结构化输出继续由原有Zod schema复核。 */
export const roleOutputSchemas = {
  'product-work.output.v1': z.object({ content: text }).strict(),
  'product-document.output.v1': z.object({ content: text }).strict(),
  'context.output.v1': z.object({ content: text }).strict(),
  'plan.output.v1': z.object({ content: text }).strict(),
  'assessment.output.v1': z.object({ content: text }).strict(),
  'implementation-summary.output.v1': z.object({ content: text }).strict(),
  'self-check-summary.output.v1': z.object({ content: text }).strict(),
  'test-plan.output.v1': z.object({ content: text }).strict(),
  'release-plan.output.v1': z.object({ content: text }).strict(),
} as const;

export const resourceRefSchema = z.object({ resourceId: z.string().min(1), hash, version: z.string().min(1) }).strict();
export const roleInvocationSchema = z.object({ version: z.literal('agent-invocation.v1'), runId: z.string().min(1), roleId: z.string().min(1), taskId: z.string().nullable(), round: z.number().int().nonnegative(), bundleHash: hash, inputContract: z.string().min(1), inputHash: hash, resourceRefs: z.array(resourceRefSchema).max(40), capabilityGrantHash: hash.nullable(), budget: z.object({ remainingCalls: z.number().int().nonnegative(), maxCalls: z.number().int().positive(), maxReworks: z.number().int().nonnegative() }).strict(), visibleArtifactRefs: z.array(hashRefSchema).max(100), visibleContextRefs: z.array(hashRefSchema).max(300), payload: z.record(z.string(), z.unknown()) }).strict();
export type RoleInvocation = z.infer<typeof roleInvocationSchema>;

/** 输出证据全部来自原生返回与宿主哈希，防止角色用文字伪造调用、工具或版本事实。 */
export const invocationEvidenceSchema = z.object({ version: z.literal('invocation-evidence.v1'), invocationId: hash, roleId: z.string().min(1), bundleHash: hash, inputHash: hash, outputContract: z.string().min(1), outputHash: hash, toolEvidenceRefs: z.array(z.string().min(1)).max(64), toolReceipts: z.array(toolExecutionReceiptSchema).max(64).optional(), usage: z.object({ inputTokens: z.number().int().nonnegative().nullable(), outputTokens: z.number().int().nonnegative().nullable(), steps: z.number().int().nonnegative(), modelId: z.string().nullable() }).strict() }).strict();
export type InvocationEvidence = z.infer<typeof invocationEvidenceSchema>;

/** 根据冻结配置的角色合同解析DTO；没有配置、合同或字段即失败关闭。 */
function inputSchema(roleId: string, inputContract: string) {
  const schema = roleInputSchemas[roleId as RoleResourceId];
  if (!schema || inputContract !== `${roleId}.input.v1`) throw new Error('角色输入契约未登记');
  return schema;
}

/** 根据冻结配置的输出合同解析模型正文的宿主封装。 */
function outputSchema(outputContract: string) {
  const schema = roleOutputSchemas[outputContract as keyof typeof roleOutputSchemas];
  if (!schema) throw new Error('角色输出契约未登记');
  return schema;
}

/** 为当前角色建立不可变交接信封；不把配置正文、运行状态、工具实现或凭据放入模型输入。 */
export function createRoleInvocation(input: { runId: string; roleId: RoleResourceId; taskId?: string | null; round?: number; bundleHash: string; inputContract: string; payload: Record<string, unknown>; resources: FrozenResources; config: RuntimeResourceConfig; capabilityGrantHash?: string | null; budget?: { remainingCalls: number; maxCalls: number; maxReworks: number }; visibleArtifactRefs?: { id: string; hash: string }[]; visibleContextRefs?: { id: string; hash: string }[] }): RoleInvocation {
  const configured = input.config.roles.find(role => role.id === input.roleId);
  if (!configured || configured.inputContract !== input.inputContract) throw new Error('角色输入契约与冻结配置不匹配');
  const payload = inputSchema(input.roleId, input.inputContract).parse(input.payload);
  return roleInvocationSchema.parse({ version: 'agent-invocation.v1', runId: input.runId, roleId: input.roleId, taskId: input.taskId ?? null, round: input.round ?? 0, bundleHash: input.bundleHash, inputContract: input.inputContract, inputHash: resourceHash(payload), resourceRefs: Object.entries(input.resources.roles).map(([resourceId, role]) => ({ resourceId, version: role.versionId, hash: role.configHash })), capabilityGrantHash: input.capabilityGrantHash ?? null, budget: input.budget ?? { remainingCalls: 0, maxCalls: 1, maxReworks: 0 }, visibleArtifactRefs: input.visibleArtifactRefs ?? [], visibleContextRefs: input.visibleContextRefs ?? [], payload });
}

/** 固化调用完成证据；输出合同和工具事实由宿主验证后再进入Workflow状态。 */
export function createInvocationEvidence(input: { invocation: RoleInvocation; outputContract: string; output: { content: string }; tools: readonly string[]; usage: { inputTokens?: number | null; outputTokens?: number | null; steps: number; modelId?: string | null }; config: RuntimeResourceConfig }): InvocationEvidence {
  const configured = input.config.roles.find(role => role.id === input.invocation.roleId);
  if (!configured || configured.outputContract !== input.outputContract) throw new Error('角色输出契约与冻结配置不匹配');
  const output = outputSchema(input.outputContract).parse(input.output);
  const invocationId = resourceHash({ runId: input.invocation.runId, roleId: input.invocation.roleId, taskId: input.invocation.taskId, round: input.invocation.round, inputHash: input.invocation.inputHash });
  const toolNames = [...new Set(input.tools)].sort();
  const toolReceipts = toolNames.map(toolId => {
    const evidence = createEvidenceRecord({ kind: 'tool-receipt', runId: input.invocation.runId, sourceHash: input.invocation.inputHash, payloadHash: resourceHash({ invocationId, toolId }), refs: [] });
    return { version: 'tool-execution-receipt.v1' as const, id: `tool:${evidence.hash.slice(0, 24)}`, runId: input.invocation.runId, invocationId, toolId, inputHash: null, outputHash: null, status: 'succeeded' as const, evidence };
  });
  return invocationEvidenceSchema.parse({ version: 'invocation-evidence.v1', invocationId, roleId: input.invocation.roleId, bundleHash: input.invocation.bundleHash, inputHash: input.invocation.inputHash, outputContract: input.outputContract, outputHash: resourceHash(output), toolEvidenceRefs: toolNames, toolReceipts, usage: { inputTokens: input.usage.inputTokens ?? null, outputTokens: input.usage.outputTokens ?? null, steps: input.usage.steps, modelId: input.usage.modelId ?? null } });
}

/** 恢复和下游门禁复核输入、输出和冻结bundle属于同一个调用。 */
export function assertInvocationEvidence(evidence: unknown, bundleHash: string, outputContract?: string): InvocationEvidence {
  const parsed = invocationEvidenceSchema.parse(evidence);
  if (parsed.bundleHash !== bundleHash || (outputContract && parsed.outputContract !== outputContract)) throw new Error('角色调用证据与冻结资源不匹配');
  return parsed;
}
