/** 脱敏诊断只记录固定代码和宿主schema字段，覆盖恶意字段名及cause。 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { z } from 'zod';
import { diagnoseOutput, OutputValidationError } from '../src/development/v2/output-diagnostic.js';

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
});
