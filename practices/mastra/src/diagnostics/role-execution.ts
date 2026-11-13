import { z } from 'zod';

const hash = z.string().regex(/^[a-f0-9]{64}$/);
const refSchema = z.object({ id: z.string().trim().min(1).max(200), hash }).strict();

/** 所有角色共用的执行事实基座；只保存可审计事实，不保存模型私有推理。 */
export const roleExecutionSchema = z.object({
  version: z.literal('role-execution.v1'),
  runId: z.string().trim().min(1).max(200),
  phaseId: z.string().trim().min(1).max(200),
  phase: z.string().trim().min(1).max(100),
  role: z.string().trim().min(1).max(100),
  objective: z.string().trim().min(1).max(1000),
  status: z.enum(['completed', 'waiting', 'failed', 'blocked']),
  round: z.number().int().nonnegative(),
  attempt: z.number().int().positive().max(5),
  startedAt: z.iso.datetime(),
  completedAt: z.iso.datetime(),
  durationMs: z.number().int().nonnegative(),
  input: z.object({
    artifactRefs: z.array(refSchema).max(300),
    requirementRefs: z.array(refSchema).max(300),
    sourceRefs: z.array(refSchema).max(300),
    taskRefs: z.array(refSchema).max(100),
    contextRefs: z.array(refSchema).max(300),
  }).strict(),
  model: z.object({
    modelId: z.string().trim().max(200).nullable(),
    attempts: z.number().int().positive().max(5).optional(),
    inputTokens: z.number().int().nonnegative().nullable(),
    outputTokens: z.number().int().nonnegative().nullable(),
    steps: z.number().int().nonnegative().max(100),
    finishReason: z.string().trim().min(1).max(100),
  }).strict(),
  tools: z.array(z.object({
    name: z.string().trim().min(1).max(200),
    inputHash: hash.optional(),
    returned: z.boolean(),
    repeated: z.boolean(),
    callCount: z.number().int().positive().max(100),
  }).strict()).max(100),
  outputs: z.object({
    artifactRefs: z.array(refSchema).max(100),
    contentHash: hash.optional(),
    contentChars: z.number().int().nonnegative().max(100000).optional(),
    sections: z.array(z.string().trim().min(1).max(300)).max(100),
  }).strict(),
  findings: z.array(z.object({ id: z.string().trim().min(1).max(200), status: z.enum(['open', 'resolved', 'deferred']), refs: z.array(z.string().trim().min(1).max(300)).max(100) }).strict()).max(100),
  failures: z.array(z.object({ attempt: z.number().int().positive(), kind: z.string().trim().min(1).max(100), durationMs: z.number().int().nonnegative(), detail: z.string().trim().min(1).max(500) }).strict()).max(5),
  blockers: z.array(z.string().trim().min(1).max(1000)).max(50),
  nextAction: z.string().trim().min(1).max(1000),
}).strict();
export type RoleExecution = z.infer<typeof roleExecutionSchema>;

/** 产品角色扩展：承接需求确认、方案假设和待决问题。 */
export const productRoleExtensionSchema = z.object({
  kind: z.literal('product-role-execution.v1'),
  intakeRound: z.number().int().nonnegative(),
  priorRoles: z.array(z.string().trim().min(1).max(100)).max(4),
  assumptions: z.array(z.string().trim().min(1).max(1000)).max(100),
  openQuestions: z.array(z.object({ id: z.string().trim().min(1).max(200), title: z.string().trim().min(1).max(1000), required: z.boolean() }).strict()).max(100),
}).strict();

/** 开发角色扩展：承接任务、修改文件、检查点和依赖产物。 */
export const developmentRoleExtensionSchema = z.object({
  kind: z.literal('development-role-execution.v1'),
  taskId: z.string().trim().min(1).max(200).nullable(),
  taskPaths: z.array(z.string().trim().min(1).max(400)).max(100),
  changedFiles: z.array(refSchema).max(300),
  checkpointHash: hash,
  dependencyRefs: z.array(refSchema).max(100),
  checkRefs: z.array(z.string().trim().min(1).max(300)).max(100),
}).strict();

/** 测试角色扩展：承接用例、执行环境、通过失败计数和质量发现。 */
export const testingRoleExtensionSchema = z.object({
  kind: z.literal('testing-role-execution.v1'),
  caseIds: z.array(z.string().trim().min(1).max(100)).max(100),
  sourceHash: hash,
  environment: z.string().trim().min(1).max(200),
  passed: z.number().int().nonnegative(),
  failed: z.number().int().nonnegative(),
  blocked: z.number().int().nonnegative(),
  findingRefs: z.array(z.string().trim().min(1).max(300)).max(100),
}).strict();

/** 发布角色扩展：承接环境、制品、外部回执、健康检查和回滚引用。 */
export const operationsRoleExtensionSchema = z.object({
  kind: z.literal('operations-role-execution.v1'),
  environment: z.string().trim().min(1).max(100),
  artifactDigest: hash.nullable(),
  sourceHash: hash,
  qualityHash: hash,
  deploymentRef: z.string().trim().max(500).nullable(),
  healthCheckRefs: z.array(z.string().trim().min(1).max(300)).max(100),
  rollbackRef: z.string().trim().max(500).nullable(),
}).strict();
