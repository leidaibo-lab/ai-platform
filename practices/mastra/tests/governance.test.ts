/** 统一交接物与能力授权的纯契约回归；不需要模型、沙箱或外部凭据。 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { assertCapabilityGrant, createApprovalReceipt, createArtifact, createCapabilityGrant, createEvidenceRecord, createHumanGate, createTaskPlan, projectAgentRun } from '../src/resources/governance.js';

/** 授权必须由同一Run、产品版本及冻结范围共同绑定，字段排序不影响语义摘要。 */
test('能力授权冻结范围并拒绝跨Run、产品版本和摘要篡改', () => {
  const first = createCapabilityGrant({ runId: 'run-1', sourceArtifactHash: 'a'.repeat(64), approvalHash: 'b'.repeat(64), roles: ['backend', 'frontend'], writablePaths: ['src/b.ts', 'src/a.ts'], registeredChecks: ['test:smoke', 'syntax:src/a.ts'], maxCalls: 72, maxReworks: 1 });
  const reordered = createCapabilityGrant({ runId: 'run-1', sourceArtifactHash: 'a'.repeat(64), approvalHash: 'b'.repeat(64), roles: ['frontend', 'backend'], writablePaths: ['src/a.ts', 'src/b.ts'], registeredChecks: ['syntax:src/a.ts', 'test:smoke'], maxCalls: 72, maxReworks: 1 });
  assert.equal(first.hash, reordered.hash);
  assert.deepEqual(assertCapabilityGrant(first, 'run-1', 'a'.repeat(64)), first);
  assert.throws(() => assertCapabilityGrant(first, 'run-2', 'a'.repeat(64)), /不匹配/);
  assert.throws(() => assertCapabilityGrant({ ...first, writablePaths: ['src/other.ts'] }, 'run-1', 'a'.repeat(64)), /不匹配/);
});

/** 统一产物将正文、输出契约和引用证据纳入hash，TaskPlan只引用其稳定摘要。 */
test('统一产物与任务计划保留可追溯证据链', () => {
  const artifact = createArtifact({ id: 'plan:1', kind: 'task-plan', schemaVersion: 'plan.output.v1', content: '{"tasks":[]}', evidenceRefs: [{ id: 'invoke-1', kind: 'invocation', hash: 'c'.repeat(64) }] });
  const plan = createTaskPlan(artifact.hash, 'd'.repeat(64), ['task-2', 'task-1', 'task-1']);
  assert.equal(artifact.evidenceRefs[0]?.id, 'invoke-1');
  assert.deepEqual(plan.taskIds, ['task-1', 'task-2']);
  assert.notEqual(artifact.hash, createArtifact({ ...artifact, content: '{"tasks":[1]}' }).hash);
});

/** Gate、人工回执、外部证据与Run汇总均为持久化事实的只读结构化投影。 */
test('治理投影绑定Gate材料、回执与已保存Run状态', () => {
  const gate = createHumanGate({ runId: 'run-1', gateType: 'architecture', requiredArtifactHashes: ['a'.repeat(64)], gateHash: 'b'.repeat(64), status: 'open' });
  const receipt = createApprovalReceipt({ gate, decision: 'approve', actor: 'reviewer', payload: { hash: 'a'.repeat(64), decision: 'approve' }, bindingHashes: ['a'.repeat(64)] });
  const evidence = createEvidenceRecord({ kind: 'deployment-receipt', runId: 'run-1', sourceHash: 'c'.repeat(64), payloadHash: 'd'.repeat(64), refs: [] });
  const run = projectAgentRun({ runId: 'run-1', bundleHash: 'e'.repeat(64), state: { phase: 'implement', outcome: 'in-progress', calls: 2, maxCalls: 72, round: 1, input: { source: { hash: 'a'.repeat(64) }, scopeApproval: { capabilityGrant: { hash: 'f'.repeat(64) } } }, taskPlan: { hash: '1'.repeat(64) } } });
  assert.equal(receipt.gateId, gate.id);
  assert.equal(receipt.evidence.kind, 'approval-receipt');
  assert.equal(evidence.kind, 'deployment-receipt');
  assert.deepEqual(run.budget, { calls: 2, maxCalls: 72, reworks: 1 });
});
