/** 脱敏诊断只记录固定代码和宿主schema字段，覆盖恶意字段名及cause。 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { z } from 'zod';
import { diagnoseOutput, OutputValidationError } from '../src/development/v2/output-diagnostic.js';
import { assessmentOutputSchema, assertProjectInstructionsRead } from '../src/development/v2/agents.js';

// 任意错误消息及cause不进入持久化诊断。
test('输出诊断丢弃凭据、响应正文和动态属性名', /** 校验全部非白名单文本不出现在结果。 */() => {
  const secret = 'SECRET_SENTINEL';
  assert.deepEqual(diagnoseOutput(new Error(secret, { cause: { apiKey: secret } })), { stage: 'unknown', code: 'output-invalid' });
  const parsed = z.object({ tasks: z.array(z.object({ paths: z.array(z.string()).min(1) })) }).safeParse({ tasks: [{ paths: [] }] });
  assert.ok(!parsed.success); if (parsed.success) return;
  assert.deepEqual(diagnoseOutput(parsed.error), { stage: 'schema', code: 'schema-invalid', issues: [{ path: 'tasks.0.paths', code: 'too_small' }] });
  const dynamic = z.record(z.string(), z.number()).safeParse({ [secret]: secret });
  assert.ok(!dynamic.success); if (dynamic.success) return;
  assert.ok(!JSON.stringify(diagnoseOutput(dynamic.error)).includes(secret));
  const safe = new OutputValidationError({ stage: 'method', code: 'method-read-missing' });
  assert.equal(safe.cause, undefined); assert.equal(diagnoseOutput(safe).code, 'method-read-missing');
  assert.deepEqual(diagnoseOutput(new SyntaxError('报告遗漏需求或任务覆盖')), { stage: 'constraint', code: 'assessment-coverage-missing' });
  assert.deepEqual(diagnoseOutput(new SyntaxError('报告覆盖引用未知')), { stage: 'constraint', code: 'assessment-ref-unknown' });
});

test('就绪结构输出声明实际引用域和必要覆盖数量', /** 数量约束辅助模型，逐项完整性仍由独立宿主校验。 */() => {
  const state = { requirements: [{ id: 'product:L1' }, { id: 'product:L2' }], plan: { tasks: [{ id: 'task-1' }] }, input: { project: { files: { 'a.mjs': '' } } }, verificationRefs: ['check:a'] } as any;
  const schema = assessmentOutputSchema(state);
  const report = { verdict: 'PASS', findings: [], unchecked: [], resolutions: [] };
  assert.throws(/** 少于原文和任务数量不能通过结构校验。 */() => schema.parse({ ...report, coverageRefs: ['product:L1', 'task:task-1'] }));
  assert.throws(/** 模型不能引用宿主以外的内容。 */() => schema.parse({ ...report, coverageRefs: ['product:L1', 'product:L2', 'task:unknown'] }));
  assert.equal(schema.parse({ ...report, coverageRefs: ['product:L1', 'product:L2', 'task:task-1'] }).coverageRefs.length, 3);
});

test('项目规则缺少真实读取回执时拒绝进入规划', /** 工具事实而非模型自述决定是否完成开工规则读取。 */() => {
  assert.doesNotThrow(() => assertProjectInstructionsRead(['AGENTS.md', 'src/AGENTS.md'], ['src/a.mjs', 'AGENTS.md', 'src/AGENTS.md']));
  assert.throws(
    () => assertProjectInstructionsRead(['AGENTS.md', 'src/AGENTS.md'], ['AGENTS.md']),
    (error: unknown) => error instanceof OutputValidationError && error.diagnostic.code === 'project-instruction-read-missing',
  );
});
