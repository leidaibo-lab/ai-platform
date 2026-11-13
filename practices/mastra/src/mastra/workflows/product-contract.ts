import { z } from 'zod';
import { createHash } from 'node:crypto';
import { PRODUCT_MAX_STEPS } from '../agents/skills.js';
import { productGenerationSchema } from '../../delivery/product-generation-contract.js';
import { invocationEvidenceSchema } from '../../resources/projections.js';
import { roleExecutionSchema, productRoleExtensionSchema } from '../../diagnostics/role-execution.js';

export const productRoles = ['coordinator', 'clarification', 'closure', 'writing'] as const;
export const maxProductReworks = 3;

const diagnosticHash = z.string().regex(/^[a-f0-9]{64}$/);
const diagnosticRefSchema = z.object({ id: z.string().trim().min(1).max(200), hash: diagnosticHash }).strict();
const diagnosticToolSchema = z.object({
  name: z.string().trim().min(1).max(200),
  inputHash: diagnosticHash.optional(),
  returned: z.boolean(),
  repeated: z.boolean(),
  callCount: z.number().int().positive().max(80),
}).strict();

/** 角色阶段的可审计执行事实；不保存原始 prompt、工具正文或模型私有思维链。 */
export const productDiagnosticSchema = z.object({
  version: z.literal('product-diagnostic.v1'),
  phase: z.string().trim().min(1).max(100),
  objective: z.string().trim().min(1).max(1000),
  startedAt: z.iso.datetime(),
  completedAt: z.iso.datetime(),
  durationMs: z.number().int().nonnegative(),
  input: z.object({
    briefHash: diagnosticHash,
    sourceRefs: z.array(diagnosticRefSchema).max(100),
    priorRoles: z.array(z.enum(productRoles)).max(4),
    intakeRound: z.number().int().nonnegative(),
  }).strict(),
  model: z.object({
    modelId: z.string().trim().min(1).max(200).nullable(),
    attempts: z.number().int().positive().max(2),
    steps: z.number().int().nonnegative().max(PRODUCT_MAX_STEPS),
    finishReason: z.string().trim().min(1).max(100),
    inputTokens: z.number().int().nonnegative().nullable(),
    outputTokens: z.number().int().nonnegative().nullable(),
  }).strict(),
  tools: z.array(diagnosticToolSchema).max(80),
  output: z.object({
    contentHash: diagnosticHash,
    contentChars: z.number().int().positive().max(100000),
    headings: z.array(z.string().trim().min(1).max(300)).max(100),
    contract: z.string().trim().min(1).max(200),
  }).strict(),
  failures: z.array(z.object({
    attempt: z.number().int().positive().max(2),
    kind: z.string().trim().min(1).max(100),
    durationMs: z.number().int().nonnegative(),
    detail: z.string().trim().min(1).max(500),
  }).strict()).max(1),
  nextAction: z.string().trim().min(1).max(1000),
}).strict();
export type ProductDiagnostic = z.infer<typeof productDiagnosticSchema>;

/** 角色产物由原生子流程按顺序写入；工具名和步数只表达执行事实。 */
export const productWorkSchema = z.object({
  version: z.literal('product-graph.v1'),
  entries: z.array(z.object({
    role: z.enum(productRoles),
    content: z.string().trim().min(1).max(100000),
    toolNames: z.array(z.string().min(1)).max(30),
    modelSteps: z.number().int().min(1).max(PRODUCT_MAX_STEPS),
    // 需求梳理只交接固定五章目录；正文仍由角色模型生成并由后续角色展开。
    handoffSections: z.tuple([
      z.literal('已确认规则索引'), z.literal('核心对象与关系'), z.literal('状态与权限要点'),
      z.literal('异常规则索引'), z.literal('页面与验收待展开清单'),
    ]).optional(),
    // 旧产物不补造完成证据；后续产物记录正常结束及有界重试事实。
    generation: productGenerationSchema.optional(),
    // 新产品角色产物必须写入诊断事实；空 productWork 仅用于工作流初始化输入。
    diagnostic: productDiagnosticSchema.optional(),
    execution: roleExecutionSchema.optional(),
    extension: productRoleExtensionSchema.optional(),
    // 正式资源主链由宿主写入输入/输出/工具/版本证据，非资源旧入口不补造。
    invocation: invocationEvidenceSchema.optional(),
  })).max(4),
});
export type ProductWork = z.infer<typeof productWorkSchema>;

/** 返工依据仅从已保存审阅生成；来源正文不可被客户端替换。 */
export const productReworkSchema = z.object({
  sourceRunId: z.string().min(1).max(200),
  sourceHash: z.string().regex(/^[a-f0-9]{64}$/),
  sourceContent: z.string().trim().min(1).max(100000),
  reviewer: z.string().trim().min(1).max(100),
  feedback: z.string().trim().min(1).max(2000),
  round: z.number().int().min(1).max(maxProductReworks),
});
export type ProductRework = z.infer<typeof productReworkSchema>;

/** 同一来源版本永远映射同一个返工轮次，供执行和只读导航共同使用。 */
export function productReworkRunId(sourceRunId: string, sourceHash: string): string {
  return `product-rework-${createHash('sha256').update(`${sourceRunId}:${sourceHash}`).digest('hex').slice(0, 32)}`;
}
