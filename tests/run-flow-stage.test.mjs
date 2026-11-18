import assert from 'node:assert/strict';
import test from 'node:test';
import { getRunFlowStage } from '../web/src/components/RunFlowMini.js';

/** 构造与服务端快照一致的最小步骤事实。 */
function step(id, stage, status) {
  return { id, stage, status, kind: 'step', attempt: null, title: id, startedAt: null, endedAt: null, durationMs: null, tools: [], files: [] };
}
/** 将节点放入只读时间线。 */
function timeline(nodes) { return { nodes, startedAt: null, endedAt: null, durationMs: null, tools: [], files: [] }; }

test('运行中的产品质量审查覆盖过时的需求澄清步骤', () => {
  assert.equal(getRunFlowStage({ runId: '1', status: 'running', step: 'guided-requirements', timeline: timeline([step('product-team.draft-product.guided-requirements', 'requirements', 'completed'), step('product-team.draft-product.review-product-quality', 'product', 'running')]) }), 1);
});
test('当前人工关口不被历史运行节点覆盖', () => {
  assert.equal(getRunFlowStage({ runId: '1', status: 'suspended', gate: { key: 'confirm-project-scope', title: '确认范围' }, timeline: timeline([step('product-writing', 'product', 'running')]) }), 3);
});

test('产品质量审查失败时标记产品阶段而非需求阶段', () => {
  assert.equal(getRunFlowStage({ runId: '1', status: 'failed', timeline: timeline([step('product-team.draft-product.review-product-quality', 'product', 'failed')]) }), 1);
});
