/** 四项验证的真实角色纵切：固定模型只驱动控制流，角色指令、Skill 和工具使用项目实际实现。 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { Mastra } from '@mastra/core/mastra';
import { LibSQLStore } from '@mastra/libsql';
import { createStep, createWorkflow } from '@mastra/core/workflows';
import { z } from 'zod';
import { createTool } from '@mastra/core/tools';
import { createAgents } from '../src/mastra/agents/index.js';
import { createAgentV2 } from '../src/development/v2/agents.js';
import { loadDevelopmentMethods } from '../src/development/v2/methods.js';
import { loadGovernedSkill } from '../src/mastra/agents/skills.js';
import { editorConstructor, saveRole, saveSkill, requireTools, toolScript } from './stored-role-probe-helpers.js';

for (const role of ['product', 'context', 'backend'] as const) {
  test(`真实角色Stored Agent/Skill pin/发布切换/重装恢复：${role}`, /** 独立数据库和候选文件排除角色之间的内存状态共享。 */ async () => {
    const dir = mkdtempSync(resolve(tmpdir(), 'stored-real-role-'));
    const config = { rootDir: resolve('.'), mode: 'fixture' as const, modelId: 'openai/fixture' as const, port: 4111, databaseUrl: `file:${resolve(dir, 'store.db')}` };
    const candidate = resolve(dir, 'solution.mjs'); writeFileSync(candidate, 'export const original = 1;');
    const methods = loadDevelopmentMethods(config.rootDir);
    const skill = role === 'product' ? loadGovernedSkill(resolve('../../.agents/skills'), 'product/requirements-handoff') : methods.skills.context;
    const state: any = { input: { project: { files: { 'solution.mjs': 'export const original = 1;' }, roles: ['backend'] } }, requirements: [], verificationRefs: [] };
    const execution: any = {
      /** 真实文件读取；拒绝越界输入。 */
      readFile: async (path: string) => { assert.equal(path, 'solution.mjs'); return readFileSync(candidate, 'utf8'); },
      /** 真实文件写入；只有当前候选被授权。 */
      writeFile: async (path: string, body: string) => { assert.equal(path, 'solution.mjs'); writeFileSync(candidate, body); },
    };
    let pin: any;
    /** 每次调用重建工具闭包、Editor、Workflow 和 Store，不沿用旧 Agent。 */
    async function open(missing = false) {
      const original = role === 'product' ? createAgents(config, { workspace: false }).productAgent : createAgentV2(config, execution, role, state, ['solution.mjs'], methods);
      const tools: any = await original.listTools();
      if (missing) delete tools[role === 'product' ? 'practiceInfo' : 'readFile'];
      const Editor = await editorConstructor(); const editor = new Editor();
      const storage = new LibSQLStore({ id: 'stored-real-role', url: config.databaseUrl });
      const schema = z.object({ agentId: z.string(), agentVersionId: z.string(), expectedBody: z.string() });
      const output = z.object({ body: z.string(), model: z.string(), tools: z.array(z.string()), text: z.string() });
      const step = createStep({ id: 'approval', inputSchema: schema, outputSchema: output, suspendSchema: schema, resumeSchema: z.object({ proceed: z.boolean() }),
        /** 只用 Run 内版本读取资源；发布指针不参与旧 Run 恢复。 */
        execute: async ({ inputData, resumeData, suspend }) => {
          if (!resumeData) return suspend(inputData);
          const agent = await editor.agent.getById(inputData.agentId, { versionId: inputData.agentVersionId });
          assert.ok(agent);
          await requireTools(agent, role === 'product' ? ['practiceInfo'] : role === 'backend' ? ['readFile', 'writeFile'] : ['readFile']);
          assert.equal(await agent.getInstructions(), await original.getInstructions());
          const loaded = await agent.getSkill(skill.name);
          assert.equal(loaded.instructions, inputData.expectedBody);
          const settings = (await agent.getDefaultOptions()).modelSettings;
          assert.equal(settings.temperature, inputData.agentVersionId.endsWith('-v2') ? 0.9 : 0.2);
          assert.equal(settings.topP, inputData.agentVersionId.endsWith('-v2') ? 0.95 : 0.8);
          assert.equal(settings.maxOutputTokens, inputData.agentVersionId.endsWith('-v2') ? 654 : 321);
          const calls = [{ name: 'skill', input: { name: skill.name }, expected: inputData.expectedBody }];
          if (role === 'context') (calls as any).push({ name: 'skill_read', input: { skillName: skill.name, path: 'references/upstream.md' }, expected: inputData.agentVersionId.endsWith('-v2') ? 'NEW_REFERENCE' : 'BMAD' });
          (calls as any).push(role === 'product' ? { name: 'practiceInfo', input: {} } : { name: 'readFile', input: { path: 'solution.mjs' }, expected: 'original' });
          if (role === 'backend') (calls as any).push({ name: 'writeFile', input: { path: 'solution.mjs', content: '/** 验证原生工具写入。 */\nexport const enhanced = 2;' }, expected: 'solution.mjs' });
          const result = await agent.generate('执行当前角色验证任务', { model: toolScript(calls), maxSteps: 10 });
          const names = result.toolResults.map(/** 原生工具事实作为实际执行证据。 */(item: any) => item.payload.toolName);
          if (!inputData.agentVersionId.endsWith('-v2')) assert.ok(!JSON.stringify(result.toolResults).includes('NEW_REFERENCE'));
          for (const call of calls) assert.ok(names.includes(call.name));
          return { body: loaded.instructions, model: (await agent.getModel()).modelId, tools: names, text: result.text };
        },
      });
      const workflow = createWorkflow({ id: 'real-role-pin', inputSchema: schema, outputSchema: output }).then(step).commit();
      new Mastra({ storage, editor, tools, workflows: { workflow } }); await storage.init();
      return { original, editor, storage, workflow };
    }
    let app = await open();
    try {
      const oldSkill = await saveSkill(app.storage, skill);
      pin = await saveRole(app.storage, app.original, `stored-${role}`, oldSkill);
      let run = await app.workflow.createRun(); const runId = run.runId;
      const inputData = { agentId: pin.id, agentVersionId: pin.versionId, expectedBody: oldSkill.body };
      assert.equal((await run.start({ inputData })).status, 'suspended');
      const changedReferences = Object.fromEntries(Object.entries(skill.__referenceContents ?? {}).map(/** 同时改变参考文件，验证pin覆盖完整内容树。 */([path, content]) => [path, `${content}\nNEW_REFERENCE`]));
      const nextSkill = await saveSkill(app.storage, { ...skill, __referenceContents: changedReferences }, '\n新版增强标记');
      const skills = await app.storage.getStore('skills'); assert.ok(skills);
      const changedSkill: any = await skills.getByIdResolved(nextSkill.id, { versionId: nextSkill.versionId });
      const changedVersion = `skill-${role}-v2`;
      await skills.createVersion({ ...changedSkill, id: changedVersion, skillId: oldSkill.id, versionNumber: 2 });
      await skills.update({ id: oldSkill.id, status: 'published', activeVersionId: changedVersion });
      nextSkill.id = oldSkill.id; nextSkill.versionId = changedVersion;
      const store = await app.storage.getStore('agents'); assert.ok(store);
      const newId = `${role}-v2`;
      await store.createVersion({ ...pin.config, id: newId, agentId: pin.id, versionNumber: 2, model: { provider: 'openai', name: 'probe-model-v2', temperature: 0.9, topP: 0.95, maxCompletionTokens: 654 }, skills: { [nextSkill.id]: { pin: nextSkill.versionId } } });
      await store.update({ id: pin.id, status: 'published', activeVersionId: newId });
      await app.storage.close(); app = await open();
      run = await app.workflow.createRun({ runId });
      const resumed: any = await run.resume({ step: 'approval', resumeData: { proceed: true } });
      assert.equal(resumed.status, 'success', JSON.stringify(resumed));
      assert.equal(resumed.result.model, 'probe-model-v1'); assert.equal(resumed.result.body, oldSkill.body);
      if (role === 'backend') assert.match(readFileSync(candidate, 'utf8'), /enhanced = 2/);
      const current = await app.editor.agent.getById(pin.id, { status: 'published' });
      assert.equal((await current.getSkill(skill.name)).instructions, nextSkill.body);
      assert.equal((await current.getModel()).modelId, 'probe-model-v2');
      // 后续执行使用新配置；旧 Run 不会被发布指针带到新配置。
      writeFileSync(candidate, 'export const original = 1;');
      const nextRun = await app.workflow.createRun();
      assert.equal((await nextRun.start({ inputData: { ...inputData, agentVersionId: newId, expectedBody: nextSkill.body } })).status, 'suspended');
      const next: any = await nextRun.resume({ step: 'approval', resumeData: { proceed: true } });
      assert.equal(next.status, 'success', JSON.stringify(next)); assert.equal(next.result.model, 'probe-model-v2');
      const missingRun = await app.workflow.createRun(); const missingId = missingRun.runId;
      assert.equal((await missingRun.start({ inputData })).status, 'suspended');
      await app.storage.close(); app = await open(true);
      const failed = await (await app.workflow.createRun({ runId: missingId })).resume({ step: 'approval', resumeData: { proceed: true } });
      assert.equal(failed.status, 'failed');
    } finally { await app.storage.close(); rmSync(dir, { recursive: true, force: true }); }
  });
}

test('负对照：固定Agent版本仍会解析宿主同名工具的新实现', /** 证明工具实现不能由Agent版本自动冻结，必须另有制品约束。 */ async () => {
  const dir = mkdtempSync(resolve(tmpdir(), 'stored-tool-drift-'));
  const config = { rootDir: resolve('.'), mode: 'fixture' as const, modelId: 'openai/fixture' as const, port: 4111, databaseUrl: `file:${resolve(dir, 'run.db')}` };
  const original = createAgents(config, { workspace: false }).productAgent;
  let storage = new LibSQLStore({ id: 'tool-drift', url: config.databaseUrl }); await storage.init();
  try {
    const role = await saveRole(storage, original, 'tool-drift-role', null);
    const store = await storage.getStore('agents'); assert.ok(store);
    await store.createVersion({ ...role.config, id: 'tool-config-v2', agentId: role.id, versionNumber: 2, tools: { practiceInfo: { description: '已保存的旧工具说明' } } });
    await storage.close(); storage = new LibSQLStore({ id: 'tool-drift', url: config.databaseUrl }); await storage.init();
    const Editor = await editorConstructor(); const editor = new Editor();
    const replacement = createTool({ id: 'same-id-new-implementation', description: '当前宿主说明', inputSchema: z.object({}),
      /** 故障注入：同一注册键指向另一个实现。 */
      execute: async () => ({ implementation: 'replacement' }),
    });
    new Mastra({ storage, editor, tools: { practiceInfo: replacement } });
    const agent = await editor.agent.getById(role.id, { versionId: 'tool-config-v2' });
    const tools = await agent.listTools(); assert.equal(tools.practiceInfo.description, '已保存的旧工具说明');
    const result = await agent.generate('工具实现漂移负对照', { model: toolScript([{ name: 'practiceInfo', input: {}, expected: 'replacement' }]), maxSteps: 4 });
    assert.equal(result.finishReason, 'stop'); assert.ok(JSON.stringify(result.toolResults).includes('replacement'));
  } finally { await storage.close(); rmSync(dir, { recursive: true, force: true }); }
});
