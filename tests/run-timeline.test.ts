import assert from 'node:assert/strict';
import test from 'node:test';
import { projectRunTimeline, projectToolFacts, projectWorkflowActivity } from '../src/intake/run-timeline.js';

test('执行摘要只保留真实工具名和相对文件路径', () => {
  const facts = projectToolFacts([
    { payload: { toolName: 'readFile', args: { path: 'src/app.ts' } } },
    { payload: { toolName: 'readFile', args: { path: '../secrets.env' } } },
    { payload: { toolName: 'runChecks', args: {} } },
  ]);
  assert.deepEqual(facts.tools, ['readFile', 'runChecks']);
  assert.deepEqual(facts.files, ['src/app.ts']);
});

test('时间线使用 Mastra Step 时间并投影已完成 Agent 的工具文件事实', () => {
  const timeline = projectRunTimeline({
    status: 'success',
    createdAt: new Date(1_000),
    updatedAt: new Date(5_000),
    steps: {
      'product-team.draft-product.product-writing': {
        status: 'success',
        startedAt: 1_500,
        endedAt: 3_000,
        output: {
          productWork: {
            version: 'product-graph.v1',
            entries: [{
              role: 'writing',
              toolNames: ['skill_read', 'readFile'],
              files: ['docs/product.md'],
              modelSteps: 3,
              startedAt: new Date(1_600).toISOString(),
              endedAt: new Date(2_600).toISOString(),
              durationMs: 1_000,
            }],
          },
          hiddenReasoning: 'must never reach the browser',
        },
      },
    },
  });
  const step = timeline.nodes.find(node => node.kind === 'step');
  const agent = timeline.nodes.find(node => node.kind === 'agent');
  assert.equal(step?.durationMs, 1_500);
  assert.equal(agent?.durationMs, 1_000);
  assert.deepEqual(agent?.tools, ['skill_read', 'readFile']);
  assert.deepEqual(agent?.files, ['docs/product.md']);
  assert.deepEqual(timeline.tools, ['readFile', 'skill_read']);
  assert.deepEqual(timeline.files, ['docs/product.md']);
  assert.equal(JSON.stringify(timeline).includes('must never reach the browser'), false);
});

test('运行中节点保留累计耗时并不伪造结束时间', () => {
  const timeline = projectRunTimeline({
    status: 'running',
    createdAt: new Date(Date.now() - 2_000),
    steps: { 'development-team.development-execution': { status: 'running', startedAt: Date.now() - 1_000 } },
  });
  const node = timeline.nodes[0];
  assert.equal(node.status, 'running');
  assert.equal(node.endedAt, null);
  assert.ok((node.durationMs ?? 0) >= 900);
  assert.equal(timeline.endedAt, null);
});

test('Workflow 活动事件只投影安全的当前节点摘要', () => {
  const activity = projectWorkflowActivity('workflow-step-start', 'product-team.draft-product.product-writing', null, new Date(7_000).toISOString());
  assert.deepEqual(activity, {
    type: 'workflow-step',
    stepId: 'product-team.draft-product.product-writing',
    title: '产品稿写作',
    status: 'running',
    summary: '正在处理“产品稿写作”，整理当前阶段的公开执行事实。',
    occurredAt: new Date(7_000).toISOString(),
  });
  assert.equal(JSON.stringify(activity).includes('hiddenReasoning'), false);
});

test('步骤重试保留首轮标识并投影阶段和轮次', () => {
  const path = 'development-team.development-execution';
  const first = { status: 'failed', startedAt: 1000, endedAt: 2000 };
  const before = projectRunTimeline({ status: 'failed', steps: { [path]: first } });
  const after = projectRunTimeline({ status: 'running', steps: { [path]: [first, { status: 'running', startedAt: 3000 }] } });
  assert.equal(before.nodes[0].id, after.nodes[0].id);
  assert.deepEqual(after.nodes.map(node => [node.stage, node.attempt]), [['development', 1], ['development', 2]]);
});

test('Agent 标识不受其他已保存事实的插入顺序影响', () => {
  const entry = { role: 'writing', toolNames: [], modelSteps: 1, startedAt: '2026-01-01T00:00:00Z' };
  const snapshot = (entries: unknown[]) => ({ status: 'success', result: { productWork: { entries } } });
  const first = projectRunTimeline(snapshot([entry])).nodes.find(node => node.kind === 'agent');
  const second = projectRunTimeline(snapshot([{ role: 'analysis', toolNames: [], modelSteps: 1 }, entry])).nodes.find(node => node.title === first?.title);
  assert.equal(first?.id, second?.id);
  assert.equal(first?.stage, 'product');
});

test('产品质量审查节点归属产品阶段', () => {
  const timeline = projectRunTimeline({ status: 'running', steps: { 'product-team.draft-product.review-product-quality': { status: 'running', startedAt: 1000 } } });
  assert.equal(timeline.nodes[0].stage, 'product');
});
