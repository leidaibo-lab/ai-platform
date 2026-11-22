import assert from 'node:assert/strict';
import test from 'node:test';
import { normalizeIndependentTeamRunInput } from '../src/team/independent-run-input.js';

test('normalizes the same team request to a stable versioned hash', () => {
  const value = { version: 'team-run-input.v1', teamId: 'product', projectId: 'hrm', source: { kind: 'new-requirement' }, payload: { teamId: 'product', brief: '完善申请流程' } };
  const first = normalizeIndependentTeamRunInput(value);
  const second = normalizeIndependentTeamRunInput(value);
  assert.equal(first.inputHash, second.inputHash);
  assert.equal(first.input.iterationId, 'unassigned');
  assert.equal(first.input.payload.teamId, 'product');
});

test('rejects cross-team payloads, incompatible sources, and client-supplied authority', () => {
  assert.throws(() => normalizeIndependentTeamRunInput({ version: 'team-run-input.v1', teamId: 'development', projectId: 'hrm', source: { kind: 'approved-product', runId: '2d09f1a6-8934-44d7-a628-79abcb410981', artifact: 'approved-product' }, payload: { teamId: 'product', brief: 'x' } }));
  assert.throws(() => normalizeIndependentTeamRunInput({ version: 'team-run-input.v1', teamId: 'delivery', projectId: 'hrm', source: { kind: 'prepared-input', packageId: 'manual-pass' }, payload: { teamId: 'delivery' } }));
  assert.throws(() => normalizeIndependentTeamRunInput({ version: 'team-run-input.v1', teamId: 'testing', projectId: 'hrm', source: { kind: 'development-delivery', runId: '2d09f1a6-8934-44d7-a628-79abcb410981', artifact: 'development-delivery' }, payload: { teamId: 'testing', approved: true, sourceHash: '0'.repeat(64) } }));
});
