/** 开发阶段独立版本契约；流程状态归 Mastra Store，不与旧提案交接混用。 */
import { createHash } from 'node:crypto';
import { z } from 'zod';

export const developmentRoleSchema = z.enum(['architect', 'frontend', 'backend', 'infrastructure', 'self-check']);
export type DevelopmentRole = z.infer<typeof developmentRoleSchema>;
export const safePathSchema = z.string().min(1).max(200).regex(/^[a-zA-Z0-9_./-]+$/).refine(
  // 路径必须相对且不包含空段、隐藏文件或父级跳转。
  (path) => !path.split('/').some((part) => !part || part.startsWith('.')),
  '只接受普通相对路径',
);
export const projectSchema = z.object({
  id: z.string().regex(/^[a-z0-9-]+$/),
  files: z.record(safePathSchema, z.string().max(100000)),
  writablePaths: z.array(safePathSchema).min(1).max(40),
  checkFiles: z.array(safePathSchema).min(1).max(20),
  roles: z.array(z.enum(['frontend', 'backend', 'infrastructure'])).min(1).max(3),
}).superRefine(
  // 公开检查必须已存在且不在写入白名单内；角色和文件集合不能含重复项。
  (project, ctx) => {
    for (const path of project.checkFiles) {
      if (!(path in project.files) || project.writablePaths.includes(path)) ctx.addIssue({ code: 'custom', message: '检查文件缺失或可写' });
    }
    if (new Set(project.roles).size !== project.roles.length || new Set(project.writablePaths).size !== project.writablePaths.length)
      ctx.addIssue({ code: 'custom', message: '角色或文件范围重复' });
    for (const path of project.writablePaths) if (!(path in project.files)) ctx.addIssue({ code: 'custom', message: '写入路径须在初始快照声明' });
  },
);
export const developmentInputSchema = z.object({
  source: z.object({ kind: z.enum(['approved-product', 'evaluation']), runId: z.string().min(1), hash: z.string().length(64), content: z.string().min(1).max(100000), evidence: z.enum(['fixture', 'model-proposal', 'evaluation-input']) }),
  project: projectSchema,
  maxReworks: z.number().int().min(0).max(3).default(1),
  continuation: z.object({ runId: z.string().min(1), sourceHash: z.string().length(64), candidateHash: z.string().length(64), reason: z.string().trim().min(1).max(2000), authority: z.enum(['approved-product-version', 'evaluation-revision']) }).optional(),
});
export type DevelopmentInput = z.infer<typeof developmentInputSchema>;
export const architectureSchema = z.object({
  summary: z.string().min(1),
  coverage: z.array(z.object({ requirement: z.string().min(1), behavior: z.string().min(1), verification: z.string().min(1) })).min(1),
  contracts: z.string().min(1),
  tasks: z.array(z.object({ id: z.string().min(1), role: z.enum(['frontend', 'backend', 'infrastructure']), paths: z.array(safePathSchema).min(1), dependsOn: z.array(z.string()) })).max(30),
  blockers: z.array(z.string().min(1)).max(20),
  risks: z.array(z.string()),
});
export type Architecture = z.infer<typeof architectureSchema>;
export const developmentReviewSchema = z.object({ hash: z.string().length(64), decision: z.enum(['approve', 'reject']), reviewer: z.string().trim().min(1).max(100), comment: z.string().trim().min(1).max(2000) });
export const commandEvidenceSchema = z.object({ id: z.string(), command: z.string(), exitCode: z.number().nullable(), processExitCode: z.number().optional(), stdout: z.string(), stderr: z.string(), durationMs: z.number().nonnegative(), timedOut: z.boolean().optional(), stdoutTruncated: z.boolean().optional(), stderrTruncated: z.boolean().optional() });
export const recoveryReviewSchema = z.object({ hash: z.string().length(64), decision: z.enum(['retry', 'stop']), reviewer: z.string().trim().min(1).max(100), comment: z.string().trim().min(1).max(2000) });
export const developmentFaultSchema = z.object({ sequence: z.number().int().positive(), role: developmentRoleSchema, taskId: z.string().nullable(), round: z.number(), attempt: z.number().int().positive(), kind: z.enum(['model-timeout', 'model-network', 'invalid-output', 'model-error']), partialSourceHash: z.string().length(64), checkpointHash: z.string().length(64), restored: z.literal(true), usage: z.literal('unknown') });
export const developmentStateSchema = z.object({
  input: developmentInputSchema, mode: z.enum(['fixture', 'live']),
  plan: architectureSchema.nullable(), planHash: z.string().nullable(),
  planSourceHash: z.string().nullable(), approvedHash: z.string().nullable(),
  checkpointHash: z.string().nullable().default(null), completedTasks: z.array(z.string()).default([]),
  faults: z.array(developmentFaultSchema).default([]),
  recovery: z.object({ hash: z.string().length(64), checkpointHash: z.string().length(64), role: developmentRoleSchema, taskId: z.string().nullable(), kind: developmentFaultSchema.shape.kind }).nullable().default(null),
  recoveries: z.array(recoveryReviewSchema).default([]),
  reviews: z.array(developmentReviewSchema.extend({ authority: z.enum(['local-human-label', 'evaluation-policy']) })),
  round: z.number().int().nonnegative(), route: z.enum(['all', 'frontend', 'backend', 'infrastructure', 'architecture', 'human']),
  work: z.array(z.object({ role: developmentRoleSchema, round: z.number(), text: z.string(), tools: z.array(z.string()), steps: z.number(), modelId: z.string().nullable(), inputTokens: z.number().nullable(), outputTokens: z.number().nullable() })),
  checks: z.array(commandEvidenceSchema),
  history: z.array(z.object({ round: z.number(), checks: z.array(commandEvidenceSchema), sourceHash: z.string(), route: z.string() })),
  outcome: z.enum(['in-progress', 'clarification-required', 'rejected', 'rework-exhausted', 'manual-attention', 'development-delivered']),
  delivery: z.object({ version: z.literal('development-delivery.v1'), productHash: z.string(), planHash: z.string(), sourceHash: z.string(), files: z.record(z.string(), z.string()), checks: z.array(commandEvidenceSchema), limitations: z.array(z.string()) }).nullable(),
});
export type DevelopmentState = z.infer<typeof developmentStateSchema>;

/** 内容散列使用确定的对象构造顺序，绑定批准方案、需求和文件快照。 */
export function developmentHash(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

/** 校验真实任务图，拒绝越界写入、未注册角色、重复/环形依赖及遗漏文件责任。 */
export function validateArchitecture(plan: Architecture, input: DevelopmentInput): void {
  const ids = new Set(plan.tasks.map(
    // 依赖基于稳定任务ID，不基于自然语言角色说明。
    (task) => task.id,
  ));
  if (ids.size !== plan.tasks.length) throw new Error('任务ID重复');
  const owned = new Set<string>();
  const completed = new Set<string>();
  for (const task of plan.tasks) {
    if (!input.project.roles.includes(task.role)) throw new Error('方案使用未注册实现角色');
    for (const path of task.paths) {
      if (!input.project.writablePaths.includes(path) || owned.has(path)) throw new Error('方案文件责任越界或重复');
      owned.add(path);
    }
    for (const dependency of task.dependsOn) if (!ids.has(dependency) || !completed.has(dependency)) throw new Error('任务须按拓扑顺序排列，依赖不能缺失或成环');
    completed.add(task.id);
  }
  if (!plan.blockers.length && owned.size !== input.project.writablePaths.length) throw new Error('方案遗漏文件责任');
}
