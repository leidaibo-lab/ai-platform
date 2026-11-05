import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { test } from 'node:test';
import { Mastra } from '@mastra/core';
import type { AgentExecutionOptionsBase } from '@mastra/core/agent';
import { createStep, createWorkflow } from '@mastra/core/workflows';
import { MastraLanguageModelV2Mock } from '@mastra/core/test-utils/llm-mock';
import { createApplication, type PracticeApplication } from '../src/mastra/app.js';
import { startDelivery, reviewDelivery, deliveryStatus } from '../src/delivery-service.js';
import { readProductDocument } from '../src/review-service.js';
import { deliverySchema, reviewSchema, pendingSchema } from '../src/mastra/workflows/delivery.js';
import { maxProductReworks, productRoles } from '../src/mastra/workflows/product-contract.js';
import { productRoleProfiles } from '../src/mastra/agents/product-roles.js';

const practiceRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));

/** 角色与返工测试使用真实原生框架和独立数据库，不触碰用户 Run。 */
async function withProductApp(check: (app: PracticeApplication) => Promise<void>) {
  const dir = mkdtempSync(resolve(tmpdir(), 'mastra-product-'));
  const app = createApplication({ rootDir: practiceRoot, mode: 'fixture', databaseUrl: `file:${resolve(dir, 'test.db')}`, port: 4111, modelId: 'openai/gpt-4o-mini' });
  try {
    await app.storage.init();
    await check(app);
  } finally {
    await app.storage.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

/** 每次人工输入绑定当前可见的产品版本，默认动作是退回。 */
function decision(status: Awaited<ReturnType<typeof deliveryStatus>>, action = 'rework') {
  assert.ok(status.pending);
  return { role: status.pending.role, artifactHash: status.pending.artifact.hash, decision: action, reviewer: '测试产品', comment: '补充失败处理的验收条件，保留已有范围和长度规则。' };
}

// 区分真实工具执行事实和模型文字，验证四个角色各自可独立工作。
test('四个固定产品角色各自执行原生工具并持久化有序产物', async () => {
  // 同一暂停快照同时验证最终稿、角色证据以及没有下游越权执行。
  await withProductApp(async (app) => {
    for (const agent of [app.agents.productCoordinatorAgent, app.agents.productClarificationAgent, app.agents.productClosureAgent, app.agents.productAgent]) {
      const skills = await agent.listSkills();
      assert.equal(skills[0]?.name, 'product-requirements-handoff');
    }
    const status = await startDelivery(app, '固定角色标题校验');
    const document = await readProductDocument(app, status.runId);
    assert.deepEqual(document.productWork?.entries.map(
      // 角色顺序是流程契约，不能由模型自行重排。
      (entry) => entry.role,
    ), [...productRoles]);
    for (const entry of document.productWork!.entries) {
      assert.deepEqual(entry.toolNames, ['practiceInfo']);
      assert.equal(entry.modelSteps, 2);
      assert.ok(entry.content.length > 0);
    }
    assert.equal(document.artifact?.content, document.productWork!.entries.at(-1)!.content);
    assert.equal(document.canReview, true);
    assert.equal(document.canRework, true);
    assert.equal((await app.deliveryWorkflow.getWorkflowRunById(status.runId))?.steps?.['draft-development'], undefined);
  });
});

// 正式子流程必须把每个角色的Skill工具执行事实保存在对应产物中。
test('四角色通过原生Skill工具生成交付，产物保存后仍等待人工确认', async (context) => {
  // 注入确定性模型选择方法，实际读取和执行仍经正式Agent与Workflow。
  await withProductApp(async (app) => {
    const roleAgents = { coordinator: app.agents.productCoordinatorAgent, clarification: app.agents.productClarificationAgent, closure: app.agents.productClosureAgent, writing: app.agents.productAgent };
    for (const role of productRoles) {
      let current = 0;
      const selected = productRoleProfiles[role].preferredSkills[0];
      const plan = [
        { toolName: 'skill', input: { name: selected } },
        { toolName: 'skill_read', input: { skillName: selected, path: 'references/upstream.md' } },
        { toolName: 'skill', input: { name: 'product-requirements-handoff' } },
      ];
      const model = new MastraLanguageModelV2Mock({
        // 每个角色独立调用其方法、原文与交接检查，最后返回可区别的产物。
        doGenerate: async () => {
          const index = current++;
          const step = plan[index];
          return {
            content: step
              ? [{ type: 'tool-call' as const, toolCallId: `${role}-skill-${index}`, toolName: step.toolName, input: JSON.stringify(step.input) }]
              : [{ type: 'text' as const, text: `${role} 的确定性产品交付（不代表真实分析质量）。` }],
            finishReason: step ? 'tool-calls' as const : 'stop' as const,
            usage: { inputTokens: 10, outputTokens: 10, totalTokens: 20 }, warnings: [],
          };
        },
      });
      const generate = roleAgents[role].generate.bind(roleAgents[role]);
      context.mock.method(roleAgents[role], 'generate',
        // 仅替换模型并检查实际工具结果，保留原生执行与工作流传入预算。
        async (messages: Parameters<typeof generate>[0], options: AgentExecutionOptionsBase<unknown> & { structuredOutput?: never }) => {
          const result = await generate(messages, { ...options, model });
          assert.equal(result.toolResults.length, 3);
          for (const tool of result.toolResults) assert.doesNotMatch(JSON.stringify(tool.payload.result), /not found|Error executing/);
          return result;
        },
      );
    }
    const status = await startDelivery(app, '验证全角色产品方法交接');
    const document = await readProductDocument(app, status.runId);
    assert.equal(document.productWork?.entries.length, 4);
    for (const entry of document.productWork!.entries) {
      assert.equal(entry.modelSteps, 4);
      assert.deepEqual(entry.toolNames, ['skill', 'skill_read']);
      assert.ok(entry.content.startsWith(entry.role));
    }
    assert.equal(status.pending?.role, 'product');
    assert.equal(document.artifact?.content, document.productWork?.entries[3].content);
    assert.equal((await app.deliveryWorkflow.getWorkflowRunById(status.runId))?.steps?.['draft-development'], undefined);
  });
});

// 长工具链必须能穿过步骤输出校验并持久化，防止预算扩大后仍被旧六步契约拒绝。
test('角色超过六步的原生工具循环仍能保存并进入人工验收', async (context) => {
  // 仅替换模型响应，实际工具执行、步数统计和流程保存均由框架完成。
  await withProductApp(async (app) => {
    let calls = 0;
    const model = new MastraLanguageModelV2Mock({
      // 七次只读调用后输出正文，覆盖超过旧限制的真实执行链。
      doGenerate: async () => {
        const current = calls++;
        const isTool = current < 7;
        return {
          content: isTool
            ? [{ type: 'tool-call' as const, toolCallId: `long-product-${current}`, toolName: 'practiceInfo', input: '{}' }]
            : [{ type: 'text' as const, text: '产品闭环完成（确定性工具链回归）。' }],
          finishReason: isTool ? 'tool-calls' as const : 'stop' as const,
          usage: { inputTokens: 10, outputTokens: 10, totalTokens: 20 }, warnings: [],
        };
      },
    });
    const generate = app.agents.productClosureAgent.generate.bind(app.agents.productClosureAgent);
    context.mock.method(app.agents.productClosureAgent, 'generate',
      // 保留工作流传入的有限步数，仅注入本测试模型。
      async (messages: Parameters<typeof generate>[0], options: AgentExecutionOptionsBase<unknown> & { structuredOutput?: never }) => generate(messages, { ...options, model }),
    );
    const status = await startDelivery(app, '需要多步方法加载的闭环');
    const document = await readProductDocument(app, status.runId);
    assert.equal(document.productWork?.entries[2].modelSteps, 8);
    assert.deepEqual(document.productWork?.entries[2].toolNames, ['practiceInfo']);
    assert.equal(document.canReview, true);
    assert.equal(status.pending?.role, 'product');
  });
});

// 中间角色失败必须阻止写作、人工放行和下游生成。
test('产品闭环角色失败时不会形成可批准稿或进入开发', async (context) => {
  // 注入确定性角色故障，只检查执行边界，不把失败包装成质量结论。
  await withProductApp(async (app) => {
    context.mock.method(app.agents.productClosureAgent, 'generate',
      // 模拟工具或模型失败，交由原生 Workflow 保存失败状态。
      async () => { throw new Error('controlled-product-closure-failure'); },
    );
    const status = await startDelivery(app, '闭环角色故障');
    assert.equal(status.status, 'failed');
    assert.equal(status.pending, undefined);
    const snapshot = await app.deliveryWorkflow.getWorkflowRunById(status.runId);
    assert.equal(snapshot?.steps?.['review-product'], undefined);
    assert.equal(snapshot?.steps?.['draft-development'], undefined);
    const document = await readProductDocument(app, status.runId);
    assert.equal(document.artifact, undefined);
    assert.equal(document.canReview, false);
    await assert.rejects(reviewDelivery(app, status.runId, { role: 'product' }), /没有待审批/);
  });
});

// 退回是新的待审版本，旧稿和旧审阅保留，不继承批准。
test('退回保留原稿和反馈，新轮次重走四角色且旧 hash 无法批准', async () => {
  // 通过业务入口执行两轮，分别检查来源和人工关口。
  await withProductApp(async (app) => {
    const first = await startDelivery(app, '标题校验');
    const request = decision(first);
    const next = await reviewDelivery(app, first.runId, request);
    const source = await deliveryStatus(app, first.runId);
    const document = await readProductDocument(app, next.runId);
    assert.equal(source.result?.outcome, 'rework-requested');
    assert.equal(source.result?.artifacts[0].content, first.pending!.artifact.content);
    assert.deepEqual(source.result?.reviews, [request]);
    assert.equal(next.pending?.role, 'product');
    assert.notEqual(next.runId, first.runId);
    assert.notEqual(next.pending?.artifact.hash, first.pending!.artifact.hash);
    assert.deepEqual(document.reviews, []);
    assert.equal(document.productRework?.sourceRunId, first.runId);
    assert.equal(document.productRework?.sourceHash, first.pending!.artifact.hash);
    assert.equal(document.productRework?.feedback, request.comment);
    assert.equal(document.productRework?.round, 1);
    assert.equal(document.productWork?.entries.length, 4);
    const snapshot = await app.deliveryWorkflow.getWorkflowRunById(next.runId);
    const initialized = snapshot?.steps?.initialize;
    assert.ok(initialized && !Array.isArray(initialized));
    assert.equal(deliverySchema.parse(initialized.output).productRework?.sourceContent, first.pending!.artifact.content);
    assert.equal(snapshot?.steps?.['draft-development'], undefined);
    await assert.rejects(reviewDelivery(app, next.runId, { ...decision(next, 'approve'), artifactHash: first.pending!.artifact.hash }), /版本/);
    const approved = await reviewDelivery(app, next.runId, decision(next, 'approve'));
    assert.equal(approved.pending?.role, 'development');
  });
});

// 网络重试和服务重建只回读同一后继；不同意见不能覆盖已经保存的决定。
test('相同退回在重开应用后仍回读同一轮次，不同决定被拒绝', async () => {
  // 用同一文件数据库重新装配，排除进程内缓存提供的假幂等。
  await withProductApp(async (app) => {
    const first = await startDelivery(app, '可重试返工');
    const request = decision(first);
    const next = await reviewDelivery(app, first.runId, request);
    const reopened = createApplication(app.config);
    try {
      await reopened.storage.init();
      assert.equal((await reviewDelivery(reopened, first.runId, request)).runId, next.runId);
      assert.equal((await reopened.deliveryWorkflow.listWorkflowRuns({ page: 0, perPage: 20 })).total, 2);
      await assert.rejects(reviewDelivery(reopened, first.runId, { ...request, comment: '改为另一条意见' }), /已经保存/);
      await assert.rejects(reviewDelivery(reopened, first.runId, { ...request, decision: 'approve' }), /已经保存/);
      await assert.rejects(reviewDelivery({ ...reopened, config: { ...reopened.config, mode: 'live' } }, first.runId, request), /模式/);
    } finally {
      await reopened.storage.close();
    }
  });
});

// 人工退回已落库而后继尚未启动时，重试可以接续，且不重新消费旧暂停点。
test('退回事实落库后可单独接续后继，不再次恢复旧人工节点', async () => {
  // 直接原生恢复停在服务启动后继前，验证持久事实作为恢复依据。
  await withProductApp(async (app) => {
    const first = await startDelivery(app, '落库后接续');
    const request = decision(first);
    const run = await app.deliveryWorkflow.createRun({ runId: first.runId });
    await run.resume({ step: 'review-product', resumeData: request });
    assert.equal((await app.deliveryWorkflow.listWorkflowRuns({ page: 0, perPage: 20 })).total, 1);
    const next = await reviewDelivery(app, first.runId, request);
    assert.equal(next.pending?.role, 'product');
    assert.equal((await readProductDocument(app, next.runId)).productRework?.round, 1);
  });
});

// 次数上限和角色边界在恢复前校验，不能消耗合法人工暂停点。
test('三次返工上限与下游退回限制保留当前暂停点', async () => {
  // 实际走满允许轮数，然后核对越界和仍可批准。
  await withProductApp(async (app) => {
    let status = await startDelivery(app, '有界返工');
    for (let round = 1; round <= maxProductReworks; round++) {
      status = await reviewDelivery(app, status.runId, decision(status));
      assert.equal(status.pending?.productReworkRound, round);
    }
    const hash = status.pending!.artifact.hash;
    await assert.rejects(reviewDelivery(app, status.runId, decision(status)), /上限/);
    assert.equal((await deliveryStatus(app, status.runId)).pending?.artifact.hash, hash);
    assert.equal((await readProductDocument(app, status.runId)).canRework, false);
    const development = await reviewDelivery(app, status.runId, decision(status, 'approve'));
    await assert.rejects(reviewDelivery(app, development.runId, decision(development)), /只有产品/);
    assert.equal((await deliveryStatus(app, development.runId)).pending?.role, 'development');
  });
});

// 新进程可重复读取返工结果，并从新的产品暂停点继续。
test('返工与重试跨 OS 进程保留同一后继和人工版本', { timeout: 30000 }, () => {
  const dir = mkdtempSync(resolve(tmpdir(), 'mastra-product-process-'));
  /** fixture CLI 使用独立数据目录，子进程和父进程使用相同 Node。 */
  function cli(args: string[]) {
    return JSON.parse(execFileSync(process.execPath, ['--import', 'tsx', 'scripts/delivery.ts', ...args], {
      cwd: practiceRoot, env: { ...process.env, MASTRA_MODE: 'fixture', MASTRA_DATA_DIR: dir }, encoding: 'utf8', timeout: 15000,
    }));
  }
  try {
    const first = cli(['start', '进程间返工']);
    const args = ['review', first.runId, 'product', first.pending.artifact.hash, 'rework', '测试产品', '补充失败验收'];
    const next = cli(args);
    assert.equal(cli(args).runId, next.runId);
    assert.equal(cli(['status', next.runId]).pending.artifact.hash, next.pending.artifact.hash);
    assert.equal(cli(['review', next.runId, 'product', next.pending.artifact.hash, 'approve', '测试产品', '确认新版本']).pending.role, 'development');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// 生成一个原生旧单步骤快照，验证新增子流程没有破坏既有根人工暂停点。
test('旧单产品步骤的原生暂停快照可由新应用阅读并批准', async () => {
  // legacy 仅重现升级前的步骤标识与数据形状，仍由真实框架保存快照。
  await withProductApp(async (app) => {
    const legacySchema = deliverySchema.omit({ productWork: true, productRework: true });
    const initialize = createStep({
      id: 'initialize', inputSchema: legacySchema.pick({ brief: true }), outputSchema: legacySchema,
      // 旧初始状态没有产品角色和返工字段。
      execute: async ({ inputData }) => ({ ...inputData, mode: 'fixture' as const, artifacts: [], reviews: [], outcome: 'in-progress' as const }),
    });
    /** 旧草稿是普通步骤，刻意不使用本次新增的子 Workflow。 */
    function oldDraft(stage: 'product' | 'development') {
      return createStep({ id: `draft-${stage}`, inputSchema: legacySchema, outputSchema: legacySchema,
        // 固定正文用于旧版形状兼容，不评价模型。
        execute: async ({ inputData }) => ({ ...inputData, artifacts: [...inputData.artifacts, { stage, content: `旧版 ${stage} 正文`, hash: createHash('sha256').update(`old-${stage}`).digest('hex'), evidence: 'fixture' as const }] }),
      });
    }
    /** 旧人工关口只支持通过或结束，并使用相同根节点标识。 */
    function oldGate(stage: 'product' | 'development') {
      return createStep({ id: `review-${stage}`, inputSchema: legacySchema, outputSchema: legacySchema, suspendSchema: pendingSchema.omit({ productReworkRound: true }), resumeSchema: reviewSchema,
        // 第一次暂停保存旧 payload，恢复时只保存绑定版本的审阅。
        execute: async ({ inputData, resumeData, suspend }) => {
          if (!resumeData) return suspend({ role: stage, artifact: inputData.artifacts.at(-1)! });
          return { ...inputData, reviews: [...inputData.reviews, resumeData] };
        },
      });
    }
    const legacyWorkflow = createWorkflow({ id: 'product-delivery', inputSchema: legacySchema.pick({ brief: true }), outputSchema: legacySchema })
      .then(initialize).then(oldDraft('product')).then(oldGate('product')).then(oldDraft('development')).then(oldGate('development')).commit();
    new Mastra({ agents: app.agents, workflows: { deliveryWorkflow: legacyWorkflow }, storage: app.storage, logger: false });
    const run = await legacyWorkflow.createRun();
    await run.start({ inputData: { brief: '旧产品暂停点' } });
    const reopened = createApplication(app.config);
    try {
      await reopened.storage.init();
      const document = await readProductDocument(reopened, run.runId);
      assert.equal(document.artifact?.content, '旧版 product 正文');
      assert.equal(document.productWork, undefined);
      assert.equal(document.canReview, true);
      const status = await deliveryStatus(reopened, run.runId);
      const next = await reviewDelivery(reopened, run.runId, decision(status, 'approve'));
      assert.equal(next.pending?.role, 'development');
      assert.equal((await readProductDocument(reopened, run.runId)).artifact?.content, document.artifact?.content);
    } finally {
      await reopened.storage.close();
    }
  });
});
