/** 严格角色DTO和调用证据回归：配置引用不等于模型可自行扩大输入或伪造输出版本。 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { assertInvocationEvidence, createInvocationEvidence, createRoleInvocation, roleInputSchemas } from '../src/resources/projections.js';
import { loadRuntimeResourceConfig } from '../src/resources/resource-config.js';

const hash = 'a'.repeat(64);
const config = loadRuntimeResourceConfig(process.cwd());
const resources: any = { roles: Object.fromEntries(config.roles.map(role => [role.id, { agentId: `role-${role.id}`, versionId: '00000000-0000-4000-8000-000000000000', configHash: hash, toolContractHash: hash }])), runId: 'contract-run' };

/** 全部固定角色必须在同一个注册表有输入/输出契约，避免配置只留字符串却没有执行约束。 */
test('十三个角色均有严格输入与输出契约登记', () => {
  assert.deepEqual(Object.keys(roleInputSchemas).sort(), config.roles.map(role => role.id).sort());
  for (const role of config.roles) assert.match(role.outputContract, /\.output\.v1$/);
});

/** 角色调用拒绝整状态与未知字段，输出证据固定同一输入和冻结bundle。 */
test('角色调用信封拒绝未知字段并核验输出证据的bundle', () => {
  const role = config.roles.find(item => item.id === 'product-coordinator')!;
  const payload = { brief: '验证严格DTO', sourceRefs: [{ id: 'source', hash }], intakeReady: true, confirmedIntake: { ready: true, round: 0, history: [] }, priorEntries: [], reworkFeedback: null };
  const invocation = createRoleInvocation({ runId: 'contract-run', roleId: 'product-coordinator', bundleHash: hash, inputContract: role.inputContract, payload, resources, config });
  assert.throws(() => createRoleInvocation({ runId: 'contract-run', roleId: 'product-coordinator', bundleHash: hash, inputContract: role.inputContract, payload: { ...payload, state: { secret: true } }, resources, config }), /Unrecognized key/);
  const evidence = createInvocationEvidence({ invocation, outputContract: role.outputContract, output: { content: '角色正文' }, tools: ['practiceInfo'], usage: { steps: 1, inputTokens: 3, outputTokens: 5, modelId: 'fixture' }, config });
  assert.equal(assertInvocationEvidence(evidence, hash, role.outputContract).inputHash, invocation.inputHash);
  assert.throws(() => assertInvocationEvidence(evidence, 'b'.repeat(64), role.outputContract), /冻结资源不匹配/);
});
