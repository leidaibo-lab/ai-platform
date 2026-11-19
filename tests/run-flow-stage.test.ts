import assert from 'node:assert/strict';
import test from 'node:test';
import type { TimelineNode } from '../web/src/components/run-timeline-types.js';
import { nodeTeam, projectProductPhases, projectRunFlow, type RunFlowDocument } from '../web/src/components/run-flow-state.js';

/** 构造与服务端快照一致的步骤事实。 */
function step(id: string, stage: TimelineNode['stage'], status: TimelineNode['status']): TimelineNode {
  return { id, stage, status, kind: 'step', attempt: null, title: id, startedAt: null, endedAt: null, durationMs: null, tools: [], files: [] };
}

/** 将节点放入只读时间线。 */
function timeline(...nodes: TimelineNode[]) {
  return { nodes, startedAt: null, endedAt: null, durationMs: null, tools: [], files: [] };
}

test('产品团队包含初次需求澄清与后期业务澄清和修订稿审阅', () => {
  const initial = step('product-team.draft-product.guided-requirements', 'requirements', 'suspended');
  const revised = step('development-team.resolve-development-blockers.blocker-round.review-revised-product#2', 'development', 'suspended');
  assert.equal(nodeTeam(initial), 'product');
  assert.equal(nodeTeam(revised), 'product');
  const flow = projectRunFlow({ runId: '1', status: 'suspended', gate: { key: 'review-revised-product', title: '确认修订稿' }, timeline: timeline(revised) });
  assert.equal(flow.active, 'product');
  assert.equal(flow.businessReturn, true);
  assert.equal(flow.states.delivery, 'pending');
});

test('产品质量审查仍属产品团队，当前人工关口优先于历史运行节点', () => {
  const review = step('product-team.draft-product.review-product-quality', 'product', 'running');
  assert.equal(projectRunFlow({ runId: '1', status: 'running', step: 'guided-requirements', timeline: timeline(review) }).active, 'product');
  const flow = projectRunFlow({ runId: '1', status: 'suspended', gate: { key: 'confirm-project-scope', title: '确认范围' }, timeline: timeline(review) });
  assert.equal(flow.active, 'development');
});

test('QA 代码修复在研发节点高亮，MR 重试在独立交付节点高亮', () => {
  const repair = step('test-team.test-and-regression-cycle.qa-defect-repair.implement', 'testing', 'running');
  const flow = projectRunFlow({ runId: '1', status: 'running', timeline: timeline(repair) });
  assert.equal(flow.active, 'development');
  assert.equal(flow.qaRepair, true);
  const delivery = projectRunFlow({ runId: '1', status: 'suspended', gate: { key: 'submit-merge-request', title: '重试提交 MR' } });
  assert.equal(delivery.active, 'delivery');
  assert.equal(delivery.states.delivery, 'current');
});

test('阻塞终态不标为交付完成，已放行交付才完成四团队', () => {
  const testResult = step('test-team.test-and-regression-cycle.review-test-results', 'testing', 'completed');
  const blocked = projectRunFlow({ runId: '1', status: 'success', outcome: 'blocked', timeline: timeline(testResult) });
  assert.equal(blocked.states.testing, 'stopped');
  assert.equal(blocked.states.delivery, 'pending');
  assert.equal(projectRunFlow({ runId: '1', status: 'success', outcome: 'blocked', clarify: {} }).businessReturn, true);
  const done = projectRunFlow({ runId: '1', status: 'success', outcome: 'delivery-confirmed' });
  assert.deepEqual(Object.values(done.states), ['done', 'done', 'done', 'done']);
});

test('产品详情展示四步中文说明，容器和 Agent 不覆盖步骤状态', () => {
  const document: RunFlowDocument = { runId: '1', status: 'suspended', gate: { key: 'confirm-project-scope', title: '确认范围' }, timeline: timeline(
    step('product-team.draft-product.guided-requirements.requirements-round.confirm-requirements#2', 'requirements', 'completed'),
    step('product-team.draft-product.product-writing', 'product', 'completed'),
    step('product-team.draft-product.review-product-quality', 'product', 'completed'),
    { ...step('agent:writing', 'product', 'failed'), kind: 'agent' },
    step('product-team.review-product', 'product', 'completed'),
    step('product-team.draft-product', null, 'completed'),
  ) };
  const phases = projectProductPhases(document, projectRunFlow(document));
  assert.ok(phases.every(({ description }) => /[\u4e00-\u9fff]/.test(description)));
  assert.deepEqual(phases.map(({ phase, status }) => ({ phase, status })), [
    { phase: '对齐需求', status: 'completed' },
    { phase: '生成待审规格', status: 'completed' },
    { phase: '独立质量审查', status: 'completed' },
    { phase: '人工审批与交接', status: 'completed' },
  ]);
});

test('产品返工阶段以当前关口与失败证据为准', () => {
  const waiting: RunFlowDocument = { runId: '1', status: 'suspended', gate: { key: 'review-revised-product', title: '审阅修订稿' } };
  assert.equal(projectProductPhases(waiting, projectRunFlow(waiting))[3].status, 'suspended');
  const failed: RunFlowDocument = { runId: '1', status: 'failed', retry: { step: 'product-team.draft-product.product-writing', title: '产品稿写作' } };
  assert.equal(projectProductPhases(failed, projectRunFlow(failed))[1].status, 'failed');
});
