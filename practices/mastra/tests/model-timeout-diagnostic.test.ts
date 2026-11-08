/** 超时来源依赖真实SDK字段与HTTP/传输白名单，未知记录不按文案或耗时猜测。 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MastraTimeoutError } from '@mastra/core/loop';
import { classifyDevelopmentError, DevelopmentModelError } from '../src/development/errors.js';
import { developmentTimeoutPolicy, diagnoseModelFailure, modelCallDiagnosticSchema, describeModelCall } from '../src/development/v2/model-diagnostic.js';

test('开发角色步骤10分钟/总计30分钟，历史策略仍可读取', /** 角色预算是宿主固定策略，不能由模型扩大。 */() => {
  assert.deepEqual(developmentTimeoutPolicy('architect'), { version: 'development-timeout.v3', totalMs: 1800000, stepMs: 600000 });
  for (const role of ['context', 'readiness', 'frontend', 'backend', 'infrastructure', 'self-check', 'reviewer']) assert.deepEqual(developmentTimeoutPolicy(role), { version: 'development-timeout.v3', totalMs: 1800000, stepMs: 600000 });
});

for (const [timeoutType, source] of [['total', 'mastra-total'], ['step', 'mastra-step'], ['firstChunk', 'mastra-first-chunk']] as const) test(`真实SDK超时细项：${timeoutType}`, /** 不保留原异常上的请求正文、headers或动态属性。 */() => {
  const error = Object.assign(new MastraTimeoutError({ timeoutType, timeoutMs: 321 }), { request: 'synthetic-private', headers: { authorization: 'synthetic-private' } });
  assert.equal(classifyDevelopmentError(error), 'model-timeout');
  const detail = diagnoseModelFailure({ name: 'WrappedSDKError', cause: error });
  assert.deepEqual(detail, { source, triggerLimitMs: 321 }); assert.doesNotMatch(JSON.stringify(detail), /synthetic-private/);
});

for (const statusCode of [408, 504, 524]) test(`上游HTTP超时单独记录：${statusCode}`, /** 上游超时不能被写成本地5分钟触发。 */() => {
  const error = { name: 'AI_APICallError', statusCode, responseBody: 'synthetic-private', url: 'https://synthetic-private.invalid' };
  assert.equal(classifyDevelopmentError(error), 'model-timeout'); assert.deepEqual(diagnoseModelFailure(error), { source: 'upstream-http', httpStatus: statusCode });
  const wrapped = new DevelopmentModelError(classifyDevelopmentError(error), diagnoseModelFailure(error));
  assert.deepEqual(diagnoseModelFailure(wrapped), { source: 'upstream-http', httpStatus: statusCode }); assert.doesNotMatch(JSON.stringify(wrapped), /synthetic-private/);
});

test('连接/响应头/未知超时分别记录，外层Abort不掩盖明确来源', /** 不把中断或普通HTTP失败自动解释成本地时限。 */() => {
  assert.deepEqual(diagnoseModelFailure({ code: 'UND_ERR_CONNECT_TIMEOUT' }), { source: 'transport-connect', code: 'UND_ERR_CONNECT_TIMEOUT' });
  assert.deepEqual(diagnoseModelFailure({ code: 'UND_ERR_HEADERS_TIMEOUT' }), { source: 'transport-headers', code: 'UND_ERR_HEADERS_TIMEOUT' });
  assert.deepEqual(diagnoseModelFailure({ code: 'ETIMEDOUT' }), { source: 'transport-timeout', code: 'ETIMEDOUT' });
  assert.deepEqual(diagnoseModelFailure({ name: 'AbortError', cause: { statusCode: 524 } }), { source: 'upstream-http', httpStatus: 524 });
  assert.deepEqual(diagnoseModelFailure({ name: 'AbortError' }), { source: 'aborted' });
  assert.deepEqual(diagnoseModelFailure({ name: 'TimeoutError', message: 'after 90000ms synthetic-private' }), { source: 'unknown' });
  assert.deepEqual(diagnoseModelFailure({ name: 'MastraTimeoutError', timeoutType: 'step', timeoutMs: Infinity }), { source: 'mastra-step' });
  assert.equal(classifyDevelopmentError({ statusCode: 503 }), 'model-network');
});

test('诊断文案区分已配置预算与实际触发来源，格式不夹带未知字段', /** 上游HTTP524时展示配置，不宣称本地时限触发。 */() => {
  const call = modelCallDiagnosticSchema.parse({ version: 'development-call.v1', callIndex: 5, durationMs: 202000, recordedAt: '2026-11-08T10:00:00.000Z', policy: developmentTimeoutPolicy('architect'), failure: { source: 'upstream-http', httpStatus: 524, url: 'synthetic-private' }, request: 'synthetic-private' });
  const text = describeModelCall(call, 2); assert.match(text, /上游HTTP 524/); assert.match(text, /实际耗时202秒/); assert.match(text, /步骤600秒、Agent总计1800秒/); assert.doesNotMatch(text, /触发时限|synthetic-private/); assert.doesNotMatch(JSON.stringify(call), /synthetic-private/);
  assert.match(describeModelCall(call), /^最近一次尝试/); assert.doesNotMatch(describeModelCall(call), /第1次/);
});
