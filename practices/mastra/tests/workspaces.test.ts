import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { Mastra } from '@mastra/core';
import type { AgentExecutionOptionsBase } from '@mastra/core/agent';
import { LibSQLStore } from '@mastra/libsql';
import { MastraLanguageModelV2Mock } from '@mastra/core/test-utils/llm-mock';
import { WORKSPACE_TOOLS } from '@mastra/core/workspace';
import { createApplication, type PracticeApplication } from '../src/mastra/app.js';
import { createAgents } from '../src/mastra/agents/index.js';
import { createDeliveryWorkflow } from '../src/mastra/workflows/delivery.js';
import { artifactDirectory, createRecruitmentWorkspace, exportProductArtifacts } from '../src/mastra/project-workspaces.js';
import { startDelivery, deliveryStatus } from '../src/delivery-service.js';
import { readProductDocument } from '../src/review-service.js';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));

/** 独立数据库与产物目录，不改变用户 live Run 或原始业务材料。 */
async function withApp(check: (app: PracticeApplication, directory: string) => Promise<void>): Promise<void> {
  const directory = mkdtempSync(resolve(tmpdir(), 'mastra-workspace-'));
  const app = createApplication({ rootDir: root, mode: 'fixture', databaseUrl: `file:${resolve(directory, 'workflow.db')}`, port: 4111, modelId: 'openai/gpt-4o-mini' });
  try {
    await app.storage.init();
    await check(app, directory);
  } finally {
    await app.mastra.shutdown();
    await app.storage.close();
    rmSync(directory, { recursive: true, force: true });
  }
}

// 验证物理文件约束，不能仅靠提示词或工具名称隐藏权限。
test('来源拒绝写入、越界路径、符号链接和评分答案，产品角色只持有来源 Workspace', async () => {
  // 使用虚构答案文件测试隔离，绝不读取真实凭据。
  await withApp(async (app, directory) => {
    const sources = resolve(directory, 'sources');
    mkdirSync(sources);
    writeFileSync(resolve(sources, 'brief.md'), '允许读取的原始材料');
    writeFileSync(resolve(directory, 'rubric.json'), '{"answer":"评分端答案"}');
    symlinkSync(resolve(directory, 'rubric.json'), resolve(sources, 'escape.json'));
    const workspace = createRecruitmentWorkspace(root, sources);
    const filesystem = workspace.filesystem!;
    assert.equal(String(await filesystem.readFile('brief.md')), '允许读取的原始材料');
    await assert.rejects(filesystem.writeFile('brief.md', '修改'));
    await assert.rejects(filesystem.readFile('../rubric.json'));
    await assert.rejects(filesystem.readFile('escape.json'));
    await assert.rejects(filesystem.readFile('rubric.json'));
    assert.equal(readFileSync(resolve(sources, 'brief.md'), 'utf8'), '允许读取的原始材料');
    for (const [id, agent] of Object.entries(app.agents)) {
      const own = await agent.getWorkspace();
      if (id.startsWith('product')) assert.equal(own?.id, 'recruitment-sources');
      else assert.equal(own, undefined);
    }
    assert.equal(app.mastra.getWorkspace(), undefined);
    const registered = app.mastra.listWorkspaces();
    for (const id of ['recruitment-sources', 'recruitment-artifacts', 'product-evaluations']) {
      assert.ok(registered[id]);
      assert.equal(registered[id].workspace.filesystem?.readOnly, true);
      assert.equal(registered[id].workspace.sandbox, undefined);
    }
  });
});

// 通过模型请求 -> 原生工具 -> 工具结果 -> 终答证明文件确实可读取。
test('原生 Agent 实际读取 brief，Workflow 导出四角色与最终稿并保持人工暂停', async (context) => {
  // 仅替换模型响应；所有文件 I/O、Workflow 与持久化保持原生执行。
  await withApp(async (app) => {
    const agents = [app.agents.productCoordinatorAgent, app.agents.productClarificationAgent, app.agents.productClosureAgent, app.agents.productAgent];
    for (const agent of agents) {
      let turn = 0;
      const model = new MastraLanguageModelV2Mock({
        // 第一轮请求读取资料，第二轮断言真实工具结果已进入模型上下文。
        doGenerate: async (options) => {
          const names = (options.tools ?? []).map(
            // 原生白名单不允许写文件或执行命令。
            (tool) => tool.name,
          );
          assert.ok(names.includes(WORKSPACE_TOOLS.FILESYSTEM.READ_FILE));
          assert.ok(!names.includes(WORKSPACE_TOOLS.FILESYSTEM.WRITE_FILE));
          assert.ok(!names.includes(WORKSPACE_TOOLS.SANDBOX.EXECUTE_COMMAND));
          const first = turn++ === 0;
          if (!first) assert.ok(JSON.stringify(options.prompt).includes('候选人初筛'));
          return {
            content: first
              ? [{ type: 'tool-call' as const, toolCallId: 'read-brief', toolName: WORKSPACE_TOOLS.FILESYSTEM.READ_FILE, input: JSON.stringify({ path: 'brief.md' }) }]
              : [{ type: 'text' as const, text: '# 招聘稿\n依据 brief.md 的候选人初筛诉求；这是工具回归样例，未人工批准。' }],
            finishReason: first ? 'tool-calls' as const : 'stop' as const,
            usage: { inputTokens: 10, outputTokens: 10, totalTokens: 20 }, warnings: [],
          };
        },
      });
      const generate = agent.generate.bind(agent);
      context.mock.method(agent, 'generate',
        // 保留正式步骤输入与预算，只注入确定性模型。
        (messages: Parameters<typeof generate>[0], options: AgentExecutionOptionsBase<unknown> & { structuredOutput?: never }) => generate(messages, { ...options, model }),
      );
    }
    const status = await startDelivery(app, '请根据 Workspace 原始材料整理招聘需求');
    assert.equal(status.status, 'suspended');
    assert.equal(status.pending?.role, 'product');
    const document = await readProductDocument(app, status.runId);
    assert.equal(document.productWork?.entries.length, 4);
    for (const entry of document.productWork!.entries) assert.deepEqual(entry.toolNames, [WORKSPACE_TOOLS.FILESYSTEM.READ_FILE]);
    const bundle = resolve(artifactDirectory(app.config), status.runId, status.pending!.artifact.hash);
    assert.equal(readFileSync(resolve(bundle, 'product.md'), 'utf8'), document.artifact!.content);
    assert.ok(readFileSync(resolve(bundle, 'roles/coordinator.md'), 'utf8').includes('招聘稿'));
    const manifest = JSON.parse(readFileSync(resolve(bundle, 'manifest.json'), 'utf8'));
    assert.equal(manifest.mode, 'fixture');
    assert.equal(manifest.actualModel, null);
    assert.doesNotMatch(JSON.stringify(manifest), /apiKey|baseUrl|requestContext/);
    assert.equal((await app.deliveryWorkflow.getWorkflowRunById(status.runId))?.steps?.['draft-development'], undefined);
  });
});

// 文件是只读可重建副本，不能通过重复导出改写稿件或推进审批。
test('历史稿补导出幂等并检测篡改，非法 Run 路径被拒绝', async () => {
  // 从原生快照补导出与自动导出必须产生相同字节。
  await withApp(async (app) => {
    const status = await startDelivery(app, '导出产品提案');
    const document = await readProductDocument(app, status.runId);
    const state = { brief: document.brief, mode: document.mode, artifacts: [document.artifact!], productWork: document.productWork };
    const bundle = await exportProductArtifacts(app.config, status.runId, state);
    assert.equal(bundle, await exportProductArtifacts(app.config, status.runId, state));
    await assert.rejects(exportProductArtifacts(app.config, '../outside', state), /非法 Run/);
    writeFileSync(resolve(artifactDirectory(app.config), bundle, 'product.md'), '本地被篡改稿');
    await assert.rejects(exportProductArtifacts(app.config, status.runId, state), /完整性/);
    assert.equal((await deliveryStatus(app, status.runId)).pending?.artifact.content, document.artifact!.content);
  });
});

// 产物副本失败不能破坏 Workflow 人工关口或伪造成功交付。
test('导出失败仍保存人工暂停点，评测装配可明确禁用来源 Workspace', async () => {
  // 独立图注入失败导出器，避免真实目录权限依赖。
  await withApp(async (app, directory) => {
    const agents = createAgents(app.config, { workspace: false });
    const storage = new LibSQLStore({ id: 'export-failure', url: `file:${resolve(directory, 'failure.db')}` });
    const deliveryWorkflow = createDeliveryWorkflow(agents, 'fixture',
      // 模拟磁盘或文件权限失败；不接触用户目录。
      async () => { throw new Error('模拟导出失败'); },
    );
    const mastra = new Mastra({ agents, workflows: { deliveryWorkflow }, storage, logger: false });
    try {
      await storage.init();
      assert.equal(await agents.productAgent.getWorkspace(), undefined);
      const status = await startDelivery({ config: app.config, deliveryWorkflow }, '导出失败回归');
      assert.equal(status.status, 'suspended');
      assert.equal(status.pending?.role, 'product');
    } finally {
      await mastra.shutdown();
      await storage.close();
    }
  });
});
