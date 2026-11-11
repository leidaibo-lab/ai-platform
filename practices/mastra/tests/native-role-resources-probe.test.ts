import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { test } from 'node:test';
import { Agent } from '@mastra/core/agent';
import { Mastra } from '@mastra/core/mastra';
import { createSkill } from '@mastra/core/skills';
import { createTool } from '@mastra/core/tools';
import { createStep, createWorkflow } from '@mastra/core/workflows';
import { createMockModel } from '@mastra/core/test-utils/llm-mock';
import { LibSQLStore } from '@mastra/libsql';
import { z } from 'zod';

/** 使用内联方法、工具和固定模型装配同一个角色。 */
function role(version: string) {
  const skill = createSkill({ name: 'probe', description: '验证角色方法', instructions: `skill-content-${version}` });
  const tool = createTool({ id: 'probe-tool', description: `tool-${version}`, inputSchema: z.object({}), outputSchema: z.string(), execute: async () => `tool-result-${version}` });
  return new Agent({ id: 'probe-role', name: 'probe', instructions: '测试角色', model: createMockModel({ mockText: `model-${version}`, version: 'v2' }), skills: [skill], tools: { probe: tool } });
}

test('同一角色重装后采用新的 Skill、工具和模型', async () => {
  for (const version of ['old', 'new']) {
    const agent = role(version);
    assert.equal((await agent.getSkill('probe'))?.instructions, `skill-content-${version}`);
    assert.equal((await agent.listTools()).probe.description, `tool-${version}`);
    assert.equal((await agent.generate('测试')).text, `model-${version}`);
  }
});

test('工作流重装恢复时保留步骤数据但重新解析角色资源', async () => {
  const directory = mkdtempSync(resolve(tmpdir(), 'mastra-resource-probe-'));
  /** 创建同 ID 的 Workflow、Agent 和持久化 Store，模拟进程重装。 */
  async function open(version: string) {
    const agent = role(version);
    const schema = z.object({ original: z.string() });
    const step = createStep({ id: 'review', inputSchema: schema, outputSchema: z.object({ original: z.string(), skill: z.string(), tool: z.string(), model: z.string() }), suspendSchema: schema, resumeSchema: z.object({ proceed: z.boolean() }),
      execute: async ({ inputData, resumeData, suspend }) => {
        if (!resumeData) return suspend(inputData);
        const skill = await agent.getSkill('probe');
        const tools = await agent.listTools();
        return { original: inputData.original, skill: skill!.instructions, tool: tools.probe.description, model: (await agent.generate('测试')).text };
      } });
    const workflow = createWorkflow({ id: 'resource-probe', inputSchema: schema, outputSchema: z.object({ original: z.string(), skill: z.string(), tool: z.string(), model: z.string() }) }).then(step).commit();
    const storage = new LibSQLStore({ id: 'probe-store', url: `file:${resolve(directory, 'probe.db')}` });
    new Mastra({ storage, workflows: { workflow } });
    await storage.init();
    return { workflow, storage };
  }
  let app = await open('old');
  try {
    let run = await app.workflow.createRun();
    const runId = run.runId;
    const paused = await run.start({ inputData: { original: 'original-input' } });
    assert.equal(paused.status, 'suspended');
    await app.storage.close();
    app = await open('new');
    run = await app.workflow.createRun({ runId });
    const result = await run.resume({ step: 'review', resumeData: { proceed: true } });
    assert.equal(result.status, 'success');
    if (result.status !== 'success') throw new Error('恢复失败');
    assert.deepEqual(result.result, { original: 'original-input', skill: 'skill-content-new', tool: 'tool-new', model: 'model-new' });
  } finally {
    await app.storage.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('LibSQL 原生 Skill 版本按版本 ID 读取旧正文', async () => {
  const directory = mkdtempSync(resolve(tmpdir(), 'mastra-skill-version-'));
  const url = `file:${resolve(directory, 'versions.db')}`;
  let storage = new LibSQLStore({ id: 'versions', url });
  try {
    await storage.init();
    const skills = await storage.getStore('skills');
    assert.ok(skills);
    await skills.create({ skill: { id: 'probe-skill', name: 'probe-skill', description: '版本实验', instructions: 'old-content' } });
    const oldVersion = await skills.getLatestVersion('probe-skill');
    assert.ok(oldVersion);
    /** 将版本 ID 作为工作流输入，在恢复时通过原生存储解析。 */
    function buildWorkflow(store: LibSQLStore) {
      const schema = z.object({ skillVersion: z.string() });
      const step = createStep({ id: 'pinned-review', inputSchema: schema, suspendSchema: schema, resumeSchema: z.object({ proceed: z.boolean() }), outputSchema: z.object({ instructions: z.string() }),
        execute: async ({ inputData, resumeData, suspend }) => {
          if (!resumeData) return suspend(inputData);
          const domain = await store.getStore('skills');
          const skill = await domain!.getByIdResolved('probe-skill', { versionId: inputData.skillVersion });
          if (!skill) throw new Error('版本不可用');
          return { instructions: skill.instructions };
        } });
      return createWorkflow({ id: 'pinned-probe', inputSchema: schema, outputSchema: z.object({ instructions: z.string() }) }).then(step).commit();
    }
    let workflow = buildWorkflow(storage);
    new Mastra({ storage, workflows: { workflow } });
    let run = await workflow.createRun();
    const runId = run.runId;
    assert.equal((await run.start({ inputData: { skillVersion: oldVersion.id } })).status, 'suspended');
    await skills.createVersion({ id: 'version-new', skillId: 'probe-skill', versionNumber: 2, name: 'probe-skill', description: '版本实验', instructions: 'new-content' });
    await skills.update({ id: 'probe-skill', status: 'published', activeVersionId: 'version-new' });
    await storage.close();
    storage = new LibSQLStore({ id: 'versions', url });
    workflow = buildWorkflow(storage);
    new Mastra({ storage, workflows: { workflow } });
    await storage.init();
    const reopened = await storage.getStore('skills');
    assert.ok(reopened);
    assert.equal((await reopened.getByIdResolved('probe-skill', { versionId: oldVersion.id }))?.instructions, 'old-content');
    assert.equal((await reopened.getByIdResolved('probe-skill'))?.instructions, 'new-content');
    run = await workflow.createRun({ runId });
    const resumed = await run.resume({ step: 'pinned-review', resumeData: { proceed: true } });
    assert.equal(resumed.status, 'success');
    if (resumed.status !== 'success') throw new Error('恢复失败');
    assert.equal(resumed.result.instructions, 'old-content');
  } finally {
    await storage.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
