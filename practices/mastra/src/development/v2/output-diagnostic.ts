/** 输出校验的局部脱敏适配：只发布宿主固定代码和schema字段，不保存模型正文或原始异常。 */
import { z } from 'zod';

export const outputDiagnosticSchema = z.object({
  stage: z.enum(['structured-output', 'method', 'schema', 'json', 'constraint', 'unknown']),
  code: z.enum(['structured-output-invalid', 'method-load-missing', 'method-read-missing', 'schema-invalid', 'json-invalid', 'task-id-duplicate', 'role-unregistered', 'path-ownership-invalid', 'dependency-invalid', 'path-ownership-missing', 'requirement-ref-unknown', 'context-ref-unknown', 'check-ref-unregistered', 'requirement-ref-missing', 'output-invalid']),
  issues: z.array(z.object({ path: z.string().max(150), code: z.enum(['invalid_type', 'too_small', 'too_big', 'invalid_value', 'invalid_format', 'unrecognized_keys', 'custom', 'other']) })).max(12).optional(),
});
export type OutputDiagnostic = z.infer<typeof outputDiagnosticSchema>;

/** 固定诊断错误不附带cause、SDK请求、错误消息或模型输出。 */
export class OutputValidationError extends SyntaxError {
  /** 在抛出边界即规范化诊断，调用方不能夹带额外自由文本。 */
  constructor(readonly diagnostic: OutputDiagnostic) {
    super(`输出校验失败：${diagnostic.code}`);
    this.name = 'OutputValidationError';
    this.diagnostic = outputDiagnosticSchema.parse(diagnostic);
  }
}

const constraints: Record<string, OutputDiagnostic['code']> = {
  '任务ID重复': 'task-id-duplicate', '方案使用未注册实现角色': 'role-unregistered',
  '方案文件责任越界或重复': 'path-ownership-invalid', '任务须按拓扑顺序排列，依赖不能缺失或成环': 'dependency-invalid',
  '方案遗漏文件责任': 'path-ownership-missing', '任务引用未知需求或验收': 'requirement-ref-unknown',
  '任务引用未知上下文': 'context-ref-unknown', '任务引用未登记检查': 'check-ref-unregistered',
  '任务遗漏批准原文引用': 'requirement-ref-missing',
};
const fields = new Set(['summary', 'coverage', 'requirement', 'behavior', 'verification', 'contracts', 'tasks', 'id', 'role', 'paths', 'dependsOn', 'requirementRefs', 'acceptanceRefs', 'contextRefs', 'constraints', 'verificationRefs', 'blockers', 'risks', 'rules', 'refs', 'text', 'unknowns', 'verdict', 'findings', 'coverageRefs', 'unchecked', 'resolutions']);
const issueCodes = new Set(['invalid_type', 'too_small', 'too_big', 'invalid_value', 'invalid_format', 'unrecognized_keys', 'custom']);

/** 仅信任宿主异常类型与固定约束文案；不把Zod message/input或未知字段名写入证据。 */
export function diagnoseOutput(error: unknown): OutputDiagnostic {
  if (error instanceof OutputValidationError) return outputDiagnosticSchema.parse(error.diagnostic);
  if (error instanceof z.ZodError) return outputDiagnosticSchema.parse({ stage: 'schema', code: 'schema-invalid', issues: error.issues.slice(0, 12).map(
    /** 数值下标保留，动态属性统一遮蔽，禁止模型注入字段名泄露正文。 */
    (issue) => ({ path: issue.path.slice(0, 10).map(
      /** 仅保留有限schema字段及有界数组下标。 */
      (part) => typeof part === 'number' && Number.isInteger(part) && part >= 0 && part < 10000 ? String(part) : typeof part === 'string' && fields.has(part) ? part : '*',
    ).join('.').slice(0, 150), code: issueCodes.has(issue.code) ? issue.code : 'other' }),
  ) });
  if (error instanceof SyntaxError) {
    const code = Object.hasOwn(constraints, error.message) ? constraints[error.message] : undefined;
    return code ? { stage: 'constraint', code } : { stage: 'json', code: 'json-invalid' };
  }
  return { stage: 'unknown', code: 'output-invalid' };
}
