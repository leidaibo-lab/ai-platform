import test from 'node:test';
import assert from 'node:assert/strict';
import { Mastra } from '@mastra/core';
import { Agent } from '@mastra/core/agent';
import { createTool } from '@mastra/core/tools';
import { createStep, createWorkflow } from '@mastra/core/workflows';
import { LibSQLStore } from '@mastra/libsql';
import { MastraStorageExporter, Observability, SensitiveDataFilter } from '@mastra/observability';
import { MastraLanguageModelV2Mock } from '@mastra/core/test-utils/llm-mock';
import { z } from 'zod';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { createStudioApplicationOptions } from '../src/mastra/app.js';
import { readLocalTraceConfig } from '../src/mastra/config.js';
import { readIntake, respondIntake } from '../src/intake/service.js';
import { minimizePilotSpan, PilotMinimalTraceExporter } from '../src/evaluation/native-trace-policy.js';
import { evaluateProductAgentToolMock } from '../src/evaluation/product-agent-tool-mock.js';
import type { AnyExportedSpan } from '@mastra/core/observability';

/** 配置仅接受明确的布尔字符串，缺省时启用。 */
test('本地 Trace 配置默认开启并拒绝无效值', () => {
  assert.equal(readLocalTraceConfig({}), true);
  assert.equal(readLocalTraceConfig({ MASTRA_LOCAL_TRACE: 'false' }), false);
  assert.equal(readLocalTraceConfig({ MASTRA_LOCAL_TRACE: 'true' }), true);
  assert.throws(() => readLocalTraceConfig({ MASTRA_LOCAL_TRACE: 'on' }));
  assert.equal('observability' in createStudioApplicationOptions({ rootDir: resolve('.'), mode: 'fixture', modelId: 'openai/fixture', port: 4111, databaseUrl: 'file::memory:' }), false);
  assert.throws(() => createStudioApplicationOptions({ rootDir: resolve('.'), mode: 'fixture', modelId: 'openai/fixture', port: 4111, databaseUrl: 'libsql://example.invalid', localTrace: true }), /本机/);
  const exporter = new PilotMinimalTraceExporter();
  assert.equal('onLogEvent' in exporter, false);
  assert.equal('onMetricEvent' in exporter, false);
  assert.equal('onScoreEvent' in exporter, false);
  assert.equal('onFeedbackEvent' in exporter, false);
});

/** 开启观测并重装配后，仍以原生 Store 的暂停版本和审批数据恢复。 */
test('本地 Trace 不改变重启后的需求澄清恢复', async () => {
  const directory = mkdtempSync(resolve(tmpdir(), 'mastra-trace-recovery-'));
  const config = { rootDir: resolve('.'), mode: 'fixture' as const, modelId: 'openai/fixture' as const, port: 4111, databaseUrl: `file:${resolve(directory, 'workflow.db')}`, localTrace: true };
  let app = createStudioApplicationOptions(config);
  new Mastra({ ...app, logger: false });
  try {
    const run = await app.workflows.productDevelopmentWorkflow.createRun();
    const started = await run.start({ inputData: { brief: '合成恢复需求', iterationId: 'trace-recovery', guidedIntake: true } });
    assert.equal(started.status, 'suspended');
    const before = await readIntake(app.workflows.productDevelopmentWorkflow, run.runId);
    assert.ok(before.intake?.hash);
    await app.observability!.shutdown();
    await app.storage.close();
    app = createStudioApplicationOptions(config);
    new Mastra({ ...app, logger: false });
    const reply = { hash: before.intake.hash, action: 'refine' as const, reviewer: 'fixture', supplement: '', answers: [{ questionId: 'scope', selected: ['minimal'], custom: '' }] };
    const after = await respondIntake(app.workflows.productDevelopmentWorkflow, 'fixture', run.runId, reply);
    assert.equal(after.intake?.round, 2);
    await assert.rejects(respondIntake(app.workflows.productDevelopmentWorkflow, 'fixture', run.runId, reply));
  } finally {
    await app.observability?.shutdown();
    await app.storage.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

/** 主线显式启用后，隔离 Store 重开仍只包含最小化 Trace。 */
test('主线本地 Trace 显式启用并跨 Store 重开读取', async () => {
  const directory = mkdtempSync(resolve(tmpdir(), 'mastra-mainline-trace-'));
  const databaseUrl = `file:${resolve(directory, 'workflow.db')}`;
  const app = createStudioApplicationOptions({ rootDir: resolve('.'), mode: 'fixture', modelId: 'openai/fixture', port: 4111, databaseUrl, localTrace: true });
  assert.ok(app.observability);
  new Mastra({ ...app, logger: false });
  let reopened: LibSQLStore | undefined;
  let closed = false;
  try {
    const run = await app.workflows.productDevelopmentWorkflow.createRun();
    assert.equal((await run.start({ inputData: { brief: 'synthetic-mainline-private-marker', iterationId: 'mainline-trace', intakeMode: 'autofill' } })).status, 'suspended');
    await app.observability.flush();
    await app.observability.shutdown();
    await app.storage.close();
    closed = true;
    reopened = new LibSQLStore({ id: 'reopened-mainline-trace', url: databaseUrl });
    await reopened.init();
    const store = await reopened.getStore('observability');
    assert.ok(store);
    const traces = await store.listTraces({ filters: { runId: run.runId } });
    assert.ok(traces.spans.length);
    const records = await Promise.all(traces.spans.map(span => store.getTrace({ traceId: span.traceId })));
    assert.doesNotMatch(JSON.stringify(records), /synthetic-mainline-private-marker/);
    const complete = records.find(record => record?.spans.some(span => span.spanType === 'agent_run') && record.spans.some(span => span.spanType === 'tool_call'));
    assert.ok(complete, '产品 Workflow、Agent 和工具应在同一 Trace 中');
    const agents = complete.spans.filter(span => span.spanType === 'agent_run');
    /** 沿父节点检查工具确实属于当前 Agent，而不是仅共享 Trace ID。 */
    const descendsFrom = (span: typeof complete.spans[number], ancestorId: string) => {
      let parent = span.parentSpanId;
      const visited = new Set<string>();
      while (parent && !visited.has(parent)) {
        if (parent === ancestorId) return true;
        visited.add(parent);
        parent = complete.spans.find(item => item.spanId === parent)?.parentSpanId;
      }
      return false;
    };
    assert.ok(agents.some(agent => complete.spans.some(span => span.spanType === 'tool_call' && descendsFrom(span, agent.spanId))));
  } finally {
    if (!closed) { await app.observability.shutdown(); await app.storage.close(); }
    await reopened?.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

/** 验证合成 Workflow 的 trace 保存在隔离 Store 且敏感字段被过滤。 */
test('原生 Trace 写入隔离 Store 并过滤敏感字段', async () => {
  const storage = new LibSQLStore({ id: 'pilot-observability', url: ':memory:' });
  const observability = new Observability({ configs: { default: { serviceName: 'native-pilot', exporters: [new MastraStorageExporter()], spanOutputProcessors: [new SensitiveDataFilter()] } } });
  const schema = z.object({ password: z.string(), message: z.string() });
  const step = createStep({ id: 'fixture-step', inputSchema: schema, outputSchema: schema,
    /** 仅传递合成输入，不访问业务资源。 */
    execute: async ({ inputData }) => inputData,
  });
  const workflow = createWorkflow({ id: 'native-pilot-flow', inputSchema: schema, outputSchema: schema }).then(step).commit();
  new Mastra({ storage, observability, workflows: { workflow }, logger: false });
  try {
    await storage.init();
    const run = await workflow.createRun();
    const result = await run.start({ inputData: { password: 'synthetic-secret-value', message: 'fixture' } });
    assert.equal(result.status, 'success');
    await observability.flush();
    const store = await storage.getStore('observability');
    assert.ok(store);
    const traces = await store.listTraces({ filters: { runId: run.runId } });
    assert.ok(traces.spans.length > 0);
    const serialized = JSON.stringify(traces);
    assert.ok(!serialized.includes('synthetic-secret-value'));
    assert.ok(serialized.includes('[REDACTED]'));
  } finally { await observability.shutdown(); await storage.close(); }
});

/** 验证最小化策略与真实平台 fixture 工作流一起使用。 */
test('平台 fixture Trace 最小化后不保存需求正文', async () => {
  const directory = mkdtempSync(resolve(tmpdir(), 'mastra-minimal-trace-'));
  const app = createStudioApplicationOptions({ rootDir: resolve('.'), mode: 'fixture', modelId: 'openai/fixture', port: 4111, databaseUrl: `file:${resolve(directory, 'workflow.db')}` });
  const observability = new Observability({ configs: { default: { serviceName: 'native-platform-pilot', exporters: [new PilotMinimalTraceExporter()], logging: { enabled: false } } } });
  new Mastra({ ...app, observability, logger: false });
  try {
    const run = await app.workflows.productDevelopmentWorkflow.createRun();
    const result = await run.start({ inputData: { brief: 'synthetic-private-brief-marker', iterationId: 'trace-pilot', guidedIntake: true } });
    assert.equal(result.status, 'suspended');
    await observability.flush();
    const store = await app.storage.getStore('observability');
    assert.ok(store);
    const traces = await store.listTraces({ filters: { runId: run.runId } });
    assert.ok(traces.spans.length > 0);
    const records = await Promise.all(traces.spans.map(span => store.getTrace({ traceId: span.traceId })));
    assert.ok(!JSON.stringify(records).includes('synthetic-private-brief-marker'));
    assert.equal((await app.workflows.productDevelopmentWorkflow.getWorkflowRunById(run.runId))?.status, 'suspended');
  } finally {
    await observability.shutdown();
    await app.storage.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

/** 验证工具、异常、属性及预览均只通过允许字段导出。 */
test('最小化策略丢弃工具输入和错误等自由内容', () => {
  const marker = 'synthetic-sensitive-marker';
  const input = {
    id: '1234567890abcdef', traceId: '1234567890abcdef1234567890abcdef', name: marker, type: 'tool_call',
    startTime: new Date(), endTime: new Date(), isEvent: false, isRootSpan: true,
    input: { path: marker }, output: marker, errorInfo: { message: marker, stack: marker },
    attributes: { nested: marker }, metadata: { runId: 'not-a-uuid', note: marker },
    requestContext: { anything: marker }, inputPreview: marker, outputPreview: marker, errorPreview: marker,
    tags: [marker], links: [{ traceId: marker, spanId: marker }],
  } as unknown as AnyExportedSpan;
  const result = minimizePilotSpan(input);
  assert.ok(!JSON.stringify(result).includes(marker));
  assert.equal(result.metadata, undefined);
  assert.equal(result.type, input.type);
  assert.equal(input.name, marker);
});

/** 验证实际失败 Workflow 的错误正文不会写入试点 Trace。 */
test('最小化 Trace 不保存运行错误正文', async () => {
  const storage = new LibSQLStore({ id: 'pilot-error-trace', url: ':memory:' });
  const observability = new Observability({ configs: { default: { serviceName: 'native-pilot', exporters: [new PilotMinimalTraceExporter()], logging: { enabled: false } } } });
  const step = createStep({ id: 'error-fixture', inputSchema: z.string(), outputSchema: z.string(),
    /** 生成仅用于隔离测试的错误。 */
    execute: async () => { throw new Error('synthetic-error-secret-marker'); },
  });
  const workflow = createWorkflow({ id: 'error-flow', inputSchema: z.string(), outputSchema: z.string() }).then(step).commit();
  new Mastra({ storage, observability, workflows: { workflow }, logger: false });
  try {
    const run = await workflow.createRun();
    const result = await run.start({ inputData: 'synthetic-error-input-marker' });
    assert.equal(result.status, 'failed');
    await observability.flush();
    const store = await storage.getStore('observability');
    assert.ok(store);
    const traces = await store.listTraces({ filters: { runId: run.runId } });
    assert.ok(traces.spans.length);
    const records = await Promise.all(traces.spans.map(span => store.getTrace({ traceId: span.traceId })));
    assert.doesNotMatch(JSON.stringify(records), /synthetic-error-(secret|input)-marker/);
  } finally { await observability.shutdown(); await storage.close(); }
});

/** 过滤器故障时不能将原始 Trace 交给存储。 */
test('最小化导出异常时丢弃 Trace', async () => {
  const storage = new LibSQLStore({ id: 'pilot-fail-closed', url: ':memory:' });
  const exporter = new PilotMinimalTraceExporter(() => { throw new Error('synthetic-filter-error'); });
  const observability = new Observability({ configs: { default: { serviceName: 'native-pilot', exporters: [exporter], logging: { enabled: false } } } });
  const step = createStep({ id: 'fail-closed-step', inputSchema: z.string(), outputSchema: z.string(),
    /** 回显合成输入，验证失败时不会落库。 */
    execute: async ({ inputData }) => inputData,
  });
  const workflow = createWorkflow({ id: 'fail-closed-flow', inputSchema: z.string(), outputSchema: z.string() }).then(step).commit();
  new Mastra({ storage, observability, workflows: { workflow }, logger: false });
  try {
    const run = await workflow.createRun();
    assert.equal((await run.start({ inputData: 'synthetic-private-marker' })).status, 'success');
    await observability.flush();
    const store = await storage.getStore('observability');
    assert.ok(store);
    assert.equal((await store.listTraces({})).spans.length, 0);
  } finally { await observability.shutdown(); await storage.close(); }
});

/** 验证真实平台 fixture 工作流的 Trace 可按 Run 查询，并识别正文泄漏边界。 */
test('平台 fixture Trace 保留 Run 关联且默认过滤不移除自由文本', async () => {
  const directory = mkdtempSync(resolve(tmpdir(), 'mastra-trace-pilot-'));
  const app = createStudioApplicationOptions({ rootDir: resolve('.'), mode: 'fixture', modelId: 'openai/fixture', port: 4111, databaseUrl: `file:${resolve(directory, 'workflow.db')}` });
  const observability = new Observability({ configs: { default: { serviceName: 'native-platform-pilot', exporters: [new MastraStorageExporter()], spanOutputProcessors: [new SensitiveDataFilter()] } } });
  new Mastra({ ...app, observability, logger: false });
  try {
    const run = await app.workflows.productDevelopmentWorkflow.createRun();
    const result = await run.start({ inputData: { brief: 'synthetic-private-brief-marker', iterationId: 'trace-pilot', guidedIntake: true } });
    assert.equal(result.status, 'suspended');
    await observability.flush();
    const store = await app.storage.getStore('observability');
    assert.ok(store);
    const traces = await store.listTraces({ filters: { runId: run.runId } });
    assert.ok(traces.spans.length > 0);
    assert.ok(JSON.stringify(traces).includes('synthetic-private-brief-marker'));
    assert.equal((await app.workflows.productDevelopmentWorkflow.getWorkflowRunById(run.runId))?.status, 'suspended');
  } finally {
    await observability.shutdown();
    await app.storage.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

/** 根据固定响应请求指定工具，不调用真实模型。 */
function fixtureToolModel(toolName: string, observed: string[], args: Record<string, unknown> = {}) {
  return new MastraLanguageModelV2Mock({
    /** 收到工具结果后结束；否则请求固定工具。 */
    doGenerate: async ({ prompt }) => {
      const done = prompt.some(message => message.role === 'tool');
      if (done) observed.push(JSON.stringify(prompt.filter(message => message.role === 'tool')));
      return { content: done ? [{ type: 'text' as const, text: 'fixture-complete' }] : [{ type: 'tool-call' as const, toolCallId: 'fixture-call', toolName, input: JSON.stringify(args) }], finishReason: done ? 'stop' as const : 'tool-calls' as const, usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 }, warnings: [] };
    },
  });
}

/** 验证实际 Agent 工具参数和结果不会进入最小化 Trace。 */
test('最小化 Trace 不保存真实工具 Span 的合成输入与输出', async () => {
  const storage = new LibSQLStore({ id: 'pilot-tool-trace', url: ':memory:' });
  const observability = new Observability({ configs: { default: { serviceName: 'native-pilot', exporters: [new PilotMinimalTraceExporter()], logging: { enabled: false } } } });
  const tool = createTool({ id: 'sampleTool', description: '合成工具', inputSchema: z.object({ text: z.string() }), outputSchema: z.object({ value: z.string() }),
    /** 返回合成正文以验证导出过滤。 */
    execute: async () => ({ value: 'synthetic-tool-output-marker' }),
  });
  const observed: string[] = [];
  const agent = new Agent({ id: 'trace-tool-agent', name: 'fixture', instructions: '调用工具', model: fixtureToolModel('sampleTool', observed, { text: 'synthetic-tool-input-marker' }), tools: { sampleTool: tool } });
  new Mastra({ storage, observability, agents: { agent }, logger: false });
  try {
    await agent.generate('synthetic-agent-input-marker', { maxSteps: 3 });
    await observability.flush();
    const store = await storage.getStore('observability');
    assert.ok(store);
    const traces = await store.listTraces({});
    assert.ok(traces.spans.length);
    const records = await Promise.all(traces.spans.map(span => store.getTrace({ traceId: span.traceId })));
    const serialized = JSON.stringify(records);
    assert.match(serialized, /tool_call/i);
    assert.doesNotMatch(serialized, /synthetic-(tool-(input|output)|agent-input)-marker/);
    assert.ok(observed.some(value => value.includes('synthetic-tool-output-marker')));
  } finally { await observability.shutdown(); await storage.close(); }
});

/** 原生实验工具替身须拦截真实工具并拒绝未声明调用。 */
test('原生 Agent Experiment 使用替身并拒绝未声明工具', async () => {
  let calls = 0;
  const observed: string[] = [];
  const tool = createTool({ id: 'sampleTool', description: '合成工具', inputSchema: z.object({}), outputSchema: z.object({ value: z.string() }),
    /** 标记实际执行，实验中不应调用。 */
    execute: async () => { calls++; return { value: 'real' }; },
  });
  const agent = new Agent({ id: 'pilot-agent', name: 'pilot', instructions: '调用工具', model: fixtureToolModel('sampleTool', observed), tools: { sampleTool: tool } });
  const storage = new LibSQLStore({ id: 'pilot-experiments', url: ':memory:' });
  const mastra = new Mastra({ storage, agents: { 'pilot-agent': agent }, logger: false });
  try {
    await storage.init();
    const declared = await mastra.datasets.create({ id: 'pilot-declared', name: 'declared' });
    await declared.addItem({ input: 'fixture', toolMocks: [{ toolName: 'sampleTool', args: {}, output: { value: 'mock' } }] });
    const mocked = await declared.startExperiment({ targetType: 'agent', targetId: 'pilot-agent', unmockedToolPolicy: 'deny' });
    assert.equal(mocked.failedCount, 0);
    assert.equal(calls, 0);
    assert.ok(observed.some(value => value.includes('mock')));
    assert.equal(mocked.results[0]?.toolMockReport?.served.length, 1);
    assert.equal(mocked.results[0]?.toolMockReport?.liveCalls.length, 0);
    const denied = await mastra.datasets.create({ id: 'pilot-denied', name: 'denied' });
    await denied.addItem({ input: 'fixture' });
    const blocked = await denied.startExperiment({ targetType: 'agent', targetId: 'pilot-agent', unmockedToolPolicy: 'deny' });
    assert.equal(blocked.failedCount, 1);
    assert.equal(blocked.results[0]?.toolMockReport?.failure?.code, 'TOOL_MOCK_NOT_DECLARED');
    assert.equal(calls, 0);
  } finally { await storage.close(); }
});

/** 将原生工具替身应用于最小 Agent 的 fixture 评测。 */
test('最小 Agent 的 fixture Experiment 使用原生工具替身', async () => {
  const result = await evaluateProductAgentToolMock(resolve('.'));
  assert.equal(result.failedCount, 0);
  assert.deepEqual(result.served, ['practiceInfo']);
  assert.equal(result.liveCalls, 0);
  assert.equal(result.unconsumed, 0);
});
