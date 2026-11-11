/** 完整生产Workflow对照；实验装配替换角色来源，审批/发布为合成数据，候选读写和检查真实执行。 */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { test } from 'node:test';
import { Mastra } from '@mastra/core/mastra';
import { LibSQLStore } from '@mastra/libsql';
import { createTool } from '@mastra/core/tools';
import { createWorkflow } from '@mastra/core/workflows';
import { MastraLanguageModelV2Mock } from '@mastra/core/test-utils/llm-mock';
import { z } from 'zod';
import { createAgents } from '../src/mastra/agents/index.js';
import { createAgentV2, generateV2, type GeneratorV2 } from '../src/development/v2/agents.js';
import { loadDevelopmentMethods } from '../src/development/v2/methods.js';
import { loadGovernedSkill } from '../src/mastra/agents/skills.js';
import { createProductDevelopmentWorkflow } from '../src/mastra/workflows/product-development.js';
import { editorConstructor, saveRole, saveSkill, requireTools } from './stored-role-probe-helpers.js';

const project = { id: 'resource-comparison', files: { 'src/a.mjs': 'export const initial=0;', 'src/b.mjs': 'export const initial=0;', 'check.mjs': 'import {test} from "node:test"; import assert from "node:assert/strict"; import {fixtureValue as a} from "./src/a.mjs"; import {fixtureValue as b} from "./src/b.mjs"; test("two modules",/** 检查两个真实模块。 */()=>{assert.equal(a(),1);assert.equal(b(),1)});' }, writablePaths: ['src/a.mjs', 'src/b.mjs'], checkFiles: ['check.mjs'], roles: ['frontend', 'backend'] };
const actor = { reviewer: 'evaluation-policy', comment: '合成实验决策，不代表业务批准或真实发布' };
const productKeys = ['productCoordinatorAgent', 'productClarificationAgent', 'productClosureAgent', 'productAgent'] as const;
type Pins = Record<string, { id: string; versionId: string }>;

/** 固定增强工具的不可变注册键；新发布不能替换旧实现。 */
function enhancement(version: number) {
  return createTool({ id: `enhancement-v${version}`, description: `只读增强证据v${version}`, inputSchema: z.object({}),
    /** 实际返回的标记必须由原生模型循环读到。 */
    execute: async () => ({ marker: `enhancement-v${version}` }),
  });
}

/** 先执行增强方法和工具，再继续原角色固定模型；不伪造工具结果或业务答案。 */
function enhancedModel(original: any, product: boolean, skillName: string) {
  const plan = product ? [{ name: 'skill', input: { name: skillName } }, { name: 'practiceInfo', input: {} }, { name: 'enhancement-v1', input: {} }] : [{ name: 'enhancement-v1', input: {} }];
  let index = 0;
  return new MastraLanguageModelV2Mock({
    /** 每次模型调用检查上一次的工具结果已进入上下文。 */
    doGenerate: async (options) => {
      if (index > 0) assert.ok(options.prompt.some(/** 工具消息必须由框架生成。 */message => message.role === 'tool'));
      const call = plan[index++];
      if (call) return { content: [{ type: 'tool-call' as const, toolCallId: `enhanced-${index}`, toolName: call.name, input: JSON.stringify(call.input) }], finishReason: 'tool-calls' as const, usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 }, warnings: [] };
      assert.ok(JSON.stringify(options.prompt).includes('enhancement-v1'));
      return original.doGenerate(options);
    },
  });
}

test('增强前后完整主链对照，并在每个暂停点重装/切换发布版本', { timeout: 180000 }, /** 同一项目、相同固定业务答案，增强只改变资源装配和实际工具证据。 */ async () => {
  const results: any[] = [];
  for (const enhanced of [false, true]) {
    const dir = mkdtempSync(resolve(tmpdir(), 'full-chain-resources-'));
    const config = { rootDir: resolve('.'), mode: 'fixture' as const, modelId: 'openai/fixture' as const, port: 4111, databaseUrl: `file:${resolve(dir, 'run.db')}` };
    const methods = loadDevelopmentMethods(config.rootDir);
    const productSkill = loadGovernedSkill(resolve('../../.agents/skills'), 'product/requirements-handoff');
    const events: { role: string; version: string; tools: string[] }[] = [];
    let pins: Pins = {};
    /** 仅用于提取静态角色模板；实际执行必须绑定当前步骤的真实ExecutionPort。 */
    const seedState: any = { input: { project, source: { content: '仅提取角色模板' } }, requirements: [], verificationRefs: [] };
    /** 初始化原生版本，覆盖产品四角色、开发八角色和实现负责人。 */
    async function seed(storage: any) {
      const agents = createAgents(config, { workspace: false });
      const skillPins: any = {};
      skillPins.product = await saveSkill(storage, productSkill);
      for (const [key, skill] of Object.entries(methods.skills)) skillPins[key] = await saveSkill(storage, skill);
      for (const key of productKeys) pins[key] = await saveRole(storage, agents[key], key, skillPins.product, false, { 'enhancement-v1': enhancement(1) });
      for (const role of ['context', 'architect', 'readiness', 'reviewer', 'frontend', 'backend', 'infrastructure', 'self-check'] as const) {
        for (const parent of ['frontend', 'backend', 'infrastructure'].includes(role) ? [false, true] : [false]) {
          const key = `${role}-${parent ? 'parent' : 'leaf'}`;
          const runtime = parent ? { memberId: key, /** 提取模板时禁止实际委派。 */ delegate: async () => { throw new Error('模板不得执行'); } } : undefined;
          const agent = createAgentV2(config, {} as any, role, seedState, project.writablePaths, methods, runtime);
          const skillKey = role === 'context' ? 'context' : role === 'architect' ? 'task' : role === 'readiness' ? 'readiness' : role === 'reviewer' ? 'review' : null;
          pins[key] = await saveRole(storage, agent, key, skillKey ? skillPins[skillKey] : null, false, { 'enhancement-v1': enhancement(1) });
        }
      }
      // Run 只存身份引用，移除导入器的临时工具对象和配置副本。
      pins = Object.fromEntries(Object.entries(pins).map(/** 精简为可持久化版本绑定。 */([key, pin]) => [key, { id: pin.id, versionId: pin.versionId }]));
    }
    /** 工具闭包来自当前步骤，角色模板和Skill只能按Run记录版本读取。 */
    async function hydrate(storage: any, original: any, key: string) {
      const Editor = await editorConstructor(); const editor = new Editor();
      const tools = { ...await original.listTools(), 'enhancement-v1': enhancement(1), 'enhancement-v2': enhancement(2) };
      new Mastra({ storage, editor, tools });
      const agent = await editor.agent.getById(pins[key].id, { versionId: pins[key].versionId });
      assert.ok(agent); await requireTools(agent, Object.keys(await original.listTools()));
      assert.equal(await agent.getInstructions(), await original.getInstructions());
      assert.equal((await agent.getModel()).modelId, 'probe-model-v1');
      return agent;
    }
    /** 每次恢复从数据库快照读取版本绑定，再重建当前宿主；不读取最新发布指针。 */
    async function open(runId?: string) {
      const storage = new LibSQLStore({ id: 'full-chain-resources', url: config.databaseUrl }); await storage.init();
      if (enhanced && !runId) await seed(storage);
      if (runId) {
        const domain = await storage.getStore('workflows');
        const snapshot: any = await domain!.loadWorkflowSnapshot({ workflowName: 'resource-envelope', runId });
        assert.ok(snapshot); pins = snapshot.context.input.resources;
      }
      const agents = createAgents(config, { workspace: false, skillsEnabled: enhanced });
      if (enhanced) for (const key of productKeys) {
        const original = agents[key]; const hydrated = await hydrate(storage, original, key);
        /** 在模型边界显式使用固定模型；Stored配置的模型身份另行断言，不能冒充远程调用。 */
        original.generate = (async (messages: any, options: any) => {
          const output = await hydrated.generate(messages, { ...options, model: enhancedModel(await original.getModel(), true, productSkill.name) });
          events.push({ role: key, version: pins[key].versionId, tools: output.toolResults.map(/** 仅收集实际执行工具。 */(item: any) => item.payload.toolName) });
          return output;
        }) as any;
      }
      /** 原生开发Agent执行真实上下文/委派/文件/检查工具；保留原Workflow的状态和门禁。 */
      const generate: GeneratorV2 = enhanced ? async (...args) => {
        const [cfg, execution, role, state, paths, , roleMethods, runtime] = args;
        const original = createAgentV2(cfg, execution, role, state, paths, roleMethods, runtime);
        const key = `${role}-${runtime?.delegate ? 'parent' : 'leaf'}`;
        const agent = await hydrate(storage, original, key).catch(/** 实验保留被生产故障分类器收敛前的断言，便于定位装配错误。 */(error) => { console.error('实验装配失败', key, error); throw error; });
        const result = await agent.generate(JSON.stringify({ role, paths, source: state.input.source }), { model: enhancedModel(await original.getModel(), false, ''), maxSteps: 24 });
        assert.equal(result.finishReason, 'stop');
        const tools = result.toolResults.map(/** 工具证据由真实Mastra循环提供。 */(item: any) => item.payload.toolName);
        if (['context', 'architect', 'readiness', 'reviewer'].includes(role)) { assert.ok(tools.includes('skill')); assert.ok(tools.includes('skill_read')); }
        events.push({ role: key, version: pins[key].versionId, tools });
        return { role, round: state.round, text: result.text, tools, steps: result.steps.length, modelId: result.response?.modelId ?? null, inputTokens: result.usage?.inputTokens ?? null, outputTokens: result.usage?.outputTokens ?? null };
      } : generateV2;
      const production = createProductDevelopmentWorkflow(agents, config, generate);
      const input = z.object({ resources: z.record(z.string(), z.object({ id: z.string(), versionId: z.string() })), brief: z.string(), iterationId: z.string() });
      const workflow = createWorkflow({ id: 'resource-envelope', inputSchema: input, outputSchema: production.outputSchema })
        .map(/** 包装仅固定资源引用；业务链仍执行项目原Workflow。 */ async ({ inputData }) => { assert.deepEqual(inputData.resources, pins); return { brief: inputData.brief, iterationId: inputData.iterationId }; }).then(production).commit();
      new Mastra({ storage, workflows: { workflow } });
      return { storage, workflow };
    }
    let app = await open();
    try {
      let run = await app.workflow.createRun(); const runId = run.runId;
      let result: any = await run.start({ inputData: { resources: pins, brief: '固定fixture双模块工具链', iterationId: 'resource-comparison' } });
      const visited: string[] = []; let published = false;
      for (let count = 0; result.status === 'suspended' && count < 16; count++) {
        const path = result.suspended[0]; const id = path.at(-1); const p = result.steps[path[0]].suspendPayload;
        visited.push(id); let data: any;
        if (id === 'review-product') data = { ...actor, role: 'product', artifactHash: p.artifact.hash, decision: 'approve' };
        else if (id === 'confirm-project-scope') data = { ...actor, project, maxReworks: 1 };
        else if (id === 'approve-architecture') data = { ...actor, hash: p.hash, decision: 'approve' };
        else if (id === 'approve-test-cases') data = { ...actor, hash: p.plan.hash, decision: 'approve', cases: [{ id: 'automatic', requirementRefs: p.requirements.map(/** 引用批准原文。 */(r: any) => r.id), expected: '两个模块返回1', method: 'registered-check', checkRefs: p.registeredChecks }] };
        else if (id === 'review-test-results') data = { ...actor, hash: p.hash, decision: 'pass', manualResults: [], findings: [] };
        else if (id === 'approve-release-scope') data = { ...actor, hash: p.packageHash, decision: 'approve', scope: { environment: 'synthetic', artifactDigest: 'a'.repeat(64), artifactRef: 'synthetic://artifact', rollbackArtifactRef: 'synthetic://previous', healthChecks: [{ id: 'ready', expected: 'ready' }] } };
        else if (id === 'execute-release-externally') data = { releaseHash: p.releaseHash, sourceHash: p.sourceHash, artifactDigest: p.artifactDigest, environment: p.environment, status: 'succeeded', jobRef: 'synthetic://job', operator: 'fixture', finishedAt: '2026-11-11T00:00:00Z', notes: '合成回执未部署' };
        else if (id === 'verify-release-health') data = { releaseHash: p.releaseHash, deploymentReceiptHash: p.deploymentReceiptHash, operator: 'fixture', checks: [{ id: 'ready', status: 'passed', evidence: '合成健康结果', observedAt: '2026-11-11T00:00:00Z' }] };
        else assert.fail(`未预期暂停点 ${id}: ${JSON.stringify(p)}`);
        if (enhanced && !published) {
          const store = await app.storage.getStore('agents'); assert.ok(store);
          for (const pin of Object.values(pins)) {
            const old: any = await store.getByIdResolved(pin.id, { versionId: pin.versionId });
            const versionId = `${pin.id}-new`;
            await store.createVersion({ ...old, id: versionId, agentId: pin.id, versionNumber: 2, model: { provider: 'openai', name: 'probe-model-v2' }, tools: { 'enhancement-v2': {} } });
            await store.update({ id: pin.id, status: 'published', activeVersionId: versionId });
          }
          published = true;
        }
        await app.storage.close(); pins = {}; app = await open(runId);
        run = await app.workflow.createRun({ runId }); result = await run.resume({ step: path, resumeData: data });
      }
      assert.equal(result.status, 'success', JSON.stringify(result)); assert.equal(result.result.outcome, 'fixture-completed');
      assert.equal(result.result.quality.status, 'passed'); assert.equal(result.result.development.delegations.length, 2);
      assert.equal(visited.length, 8);
      if (enhanced) { assert.ok(events.length >= 12); for (const event of events) assert.ok(event.tools.includes('enhancement-v1'), event.role); }
      results.push({ enhanced, visited, sourceHash: result.result.development.checkpointHash, outcome: result.result.outcome, quality: result.result.quality.status, events });
    } finally { await app.storage.close(); rmSync(dir, { recursive: true, force: true }); }
  }
  assert.deepEqual(results[0].visited, results[1].visited); assert.equal(results[0].sourceHash, results[1].sourceHash);
  console.log(JSON.stringify({ comparison: results.map(/** 输出紧凑可归档结果。 */({ enhanced, visited, sourceHash, outcome, quality, events }) => ({ enhanced, visited, sourceHash, outcome, quality, storedRoleExecutions: events.length })) }));
});
