/** 开发阶段独立版本契约；流程状态归 Mastra Store，不与旧提案交接混用。 */
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { cipProfile, cipRoots, cipWritable, engineeringRevisionSchema } from '../business-engineering/hrm-cip.js';
import { resolveModelId, type PracticeConfig } from '../mastra/config.js';
import { developmentSandboxPolicyVersion } from './sandbox-policy.js';

export const developmentRoleSchema = z.enum(['architect', 'frontend', 'backend', 'infrastructure', 'self-check']);
export type DevelopmentRole = z.infer<typeof developmentRoleSchema>;
export const safePathSchema = z.string().min(1).max(200).regex(/^[a-zA-Z0-9_./()\[\]-]+$/).refine(
  // 路径必须相对且不包含空段、隐藏文件或父级跳转。
  (path) => !path.split('/').some((part) => !part || part.startsWith('.')),
  '只接受普通相对路径',
);
export const projectSchema = z.object({
  id: z.string().regex(/^[a-z0-9-]+$/),
  adapterId: z.enum(['node-test.v1', 'python-unittest.v1']).optional(),
  executionProfile: z.enum(['hrm-pnpm-docker-v1', cipProfile]).optional(),
  engineeringRevision: engineeringRevisionSchema.optional(),
  planning: z.literal('agent').optional(),
  /** 服务端检查得到的工程缺口随输入冻结；存在时仅可规划，不能批准或实施。 */
  preparationIssues: z.array(z.string().min(1)).min(1).max(20).optional(),
  engineeringAssessment: z.object({ stackStatus: z.enum(['matched', 'unknown', 'mismatch', 'ambiguous']), evidence: z.array(z.string().min(1)).max(20), expectedProfile: z.enum(['hrm-pnpm-docker-v1', cipProfile]) }).optional(),
  writableRoots: z.array(safePathSchema).max(5).optional(),
  files: z.record(safePathSchema, z.string().max(100000)),
  /** 固定工程版本中适用于候选路径的项目规则；只读且最多8份，为方法读取和最终输出保留有界步骤。 */
  instructionFiles: z.array(safePathSchema.refine(
    /** 只接受根或目录级 AGENTS.md，避免把普通 Markdown 冒充项目权限契约。 */
    path => path === 'AGENTS.md' || path.endsWith('/AGENTS.md'),
    '项目规则文件必须命名为 AGENTS.md',
  )).max(8).optional(),
  writablePaths: z.array(safePathSchema).max(40),
  checkFiles: z.array(safePathSchema).min(1).max(200),
  roles: z.array(z.enum(['frontend', 'backend', 'infrastructure'])).min(1).max(3),
}).superRefine(
  // 公开检查必须已存在且不在写入白名单内；角色和文件集合不能含重复项。
  (project, ctx) => {
    if (project.adapterId === 'python-unittest.v1' && (project.executionProfile || project.writablePaths.some(path => !/^src\/(?:[a-zA-Z0-9_-]+\/)*[a-zA-Z0-9_-]+\.py$/.test(path)) || project.checkFiles.some(path => !/^tests\/(?:[a-zA-Z0-9_-]+\/)*test_[a-zA-Z0-9_-]+\.py$/.test(path)))) ctx.addIssue({ code: 'custom', message: 'Python Adapter 的源码或检查路径不合法' });
    if ((!project.writablePaths.length || project.preparationIssues) && project.planning !== 'agent') ctx.addIssue({ code: 'custom', message: '空源码或工程准备缺口仅适用于已登记项目规划' });
    if (project.planning === 'agent' && !project.executionProfile) ctx.addIssue({ code: 'custom', message: '自动技术规划需要已登记项目执行档' });
    if (project.executionProfile && (project.planning !== 'agent' || !project.writableRoots?.length || project.writableRoots.some(/** 全栈档不能把脚本或配置目录变成源码授权根。 */root => !(project.executionProfile === cipProfile ? cipRoots : ['apps/web/app', 'apps/api/src', 'packages/database/src', 'packages/database/prisma']).includes(root)))) ctx.addIssue({ code: 'custom', message: 'HRM源码授权根不合法' });
    if (project.executionProfile === cipProfile && (!project.engineeringRevision || project.writablePaths.some(path => !cipWritable(path)))) ctx.addIssue({ code: 'custom', message: 'CIP 需要固定版本和受控源码' });
    for (const path of project.checkFiles) {
      if (!(path in project.files) || project.writablePaths.includes(path)) ctx.addIssue({ code: 'custom', message: '检查文件缺失或可写' });
    }
    if (new Set(project.roles).size !== project.roles.length || new Set(project.writablePaths).size !== project.writablePaths.length || new Set(project.instructionFiles ?? []).size !== (project.instructionFiles?.length ?? 0))
      ctx.addIssue({ code: 'custom', message: '角色或文件范围重复' });
    for (const path of project.writablePaths) if (!(path in project.files)) ctx.addIssue({ code: 'custom', message: '写入路径须在初始快照声明' });
    for (const path of project.instructionFiles ?? []) {
      if (!(path in project.files) || project.writablePaths.includes(path) || project.checkFiles.includes(path)) ctx.addIssue({ code: 'custom', message: '项目规则文件必须存在且保持只读' });
    }
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
export const recoveryReviewSchema = z.object({ hash: z.string().length(64), decision: z.enum(['retry', 'stop']), reviewer: z.string().trim().min(1).max(100), comment: z.string().trim().min(1).max(2000), additionalCalls: z.number().int().min(1).max(72).optional(), additionalContextLevel: z.number().int().min(1).max(4).optional() });
export const developmentFaultSchema = z.object({ sequence: z.number().int().positive(), role: developmentRoleSchema, taskId: z.string().nullable(), round: z.number(), attempt: z.number().int().positive(), kind: z.enum(['model-timeout', 'model-network', 'invalid-output', 'model-error']), partialSourceHash: z.string().length(64), checkpointHash: z.string().length(64), restored: z.literal(true), usage: z.literal('unknown') });
/** 持久化模型执行身份；端点只存 SHA256，凭据不属于批准内容。旧快照缺失时禁止恢复。 */
export const executionIdentitySchema = z.object({ mode: z.enum(['fixture', 'live']), modelId: z.string().min(1), endpointHash: z.string().length(64), sandboxPolicy: z.string().optional() });
export const developmentStateSchema = z.object({
  input: developmentInputSchema, mode: z.enum(['fixture', 'live']),
  executionIdentity: executionIdentitySchema.nullable().default(null),
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

/** 归一化等价端点；不保存 URL、账号密码或 API key，允许单独轮转凭据。 */
export function developmentExecutionIdentity(config: PracticeConfig): z.infer<typeof executionIdentitySchema> {
  const endpoint = new URL(config.baseUrl ?? 'https://api.openai.com/v1');
  endpoint.username = '';
  endpoint.password = '';
  endpoint.hash = '';
  endpoint.pathname = endpoint.pathname.replace(/\/+$/, '');
  endpoint.searchParams.sort();
  return { mode: config.mode, modelId: resolveModelId(config, 'development'), endpointHash: developmentHash(endpoint.toString()), sandboxPolicy: developmentSandboxPolicyVersion };
}

/** 审批、调用与故障接续共用同一身份校验；旧快照不得猜测原模型身份。 */
export function validateDevelopmentIdentity(state: DevelopmentState, config: PracticeConfig): void {
  if (state.mode !== config.mode || !state.executionIdentity || developmentHash(state.executionIdentity) !== developmentHash(developmentExecutionIdentity(config)))
    throw new Error('开发输入或模式/模型/端点执行身份发生漂移，或旧快照缺少身份');
}

/** 组织者合成批准只接受评测证据与规范正文散列，不能代替真实产品批准。 */
export function validateEvaluationSource(input: DevelopmentInput): void {
  if (input.source.kind !== 'evaluation') throw new Error('自动批准规则仅允许评测案例');
  if (input.source.evidence !== 'evaluation-input' || input.source.hash !== developmentHash(input.source.content))
    throw new Error('评测自动批准来源的类型、证据或正文hash不合法');
}

/** 校验授权与任务图。同一文件最近的上游写入者必须是当前写入任务的祖先。 */
export function validateArchitecture(plan: Architecture, input: DevelopmentInput, orderedPathHandoff = false): void {
  const ids = new Set(plan.tasks.map(
    // 依赖基于稳定任务ID，不基于自然语言角色说明。
    (task) => task.id,
  ));
  if (ids.size !== plan.tasks.length) throw new SyntaxError('任务ID重复');
  const owners = new Map<string, string>();
  const ancestors = new Map<string, Set<string>>();
  for (const task of plan.tasks) {
    if (!input.project.roles.includes(task.role)) throw new SyntaxError('方案使用未注册实现角色');
    const upstream = new Set<string>();
    for (const dependency of task.dependsOn) {
      const inherited = ancestors.get(dependency);
      if (!inherited) throw new SyntaxError('任务须按拓扑顺序排列，依赖不能缺失或成环');
      upstream.add(dependency);
      for (const id of inherited) upstream.add(id);
    }
    if (orderedPathHandoff && new Set(task.paths).size !== task.paths.length) throw new SyntaxError('同一任务重复声明写入路径');
    for (const path of task.paths) {
      const previous = owners.get(path);
      const authorized = canWriteProjectPath(input.project, path);
      if (!orderedPathHandoff && (!authorized || previous !== undefined)) throw new SyntaxError('方案文件责任越界或重复');
      if (!authorized) throw new SyntaxError('方案包含未授权写入路径');
      if (previous !== undefined && !upstream.has(previous)) throw new SyntaxError('共享文件写入任务缺少依赖顺序');
      owners.set(path, task.id);
    }
    ancestors.set(task.id, upstream);
  }
  if (!plan.blockers.length && input.project.planning !== 'agent' && owners.size !== input.project.writablePaths.length) throw new SyntaxError('方案遗漏文件责任');
}

/** 研发规划、候选写入和交付共用同一源码上界。 */
export function canWriteProjectPath(project: DevelopmentInput['project'], path: string) {
  if (!safePathSchema.safeParse(path).success || project.checkFiles.includes(path)) return false;
  if (project.executionProfile === cipProfile && !cipWritable(path)) return false;
  return project.writablePaths.includes(path) || !!(project.executionProfile && project.planning === 'agent' && project.writableRoots?.some(root => path.startsWith(`${root}/`)));
}
