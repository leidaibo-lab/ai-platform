/** 按Run版本装配原生Stored Agent；不从最新配置、任意URL或存储中的代码执行能力。 */
import { Agent, type AgentExecutionOptionsBase } from '@mastra/core/agent';
import { createTool } from '@mastra/core/tools';
import { Mastra } from '@mastra/core/mastra';
import { MastraEditor } from '@mastra/editor';
import type { PracticeConfig } from '../mastra/config.js';
import { createNativeMemory } from '../mastra/context-memory.js';
import { practiceInfoTool } from '../mastra/tools/practice-info.js';
import { resolveModelId } from '../mastra/config.js';
import { currentResources } from './scope.js';
import { resolveRole } from './native-store.js';
import { ResourceError } from './contracts.js';
import { isTaskContextToolset } from '../delivery/task-context.js';
import { LocalFilesystem } from '@mastra/core/workspace';
import { sourceSnapshotContentDirectory } from './source-snapshot.js';
import { reuseReadOnlyToolResults } from './readonly-tool-reuse.js';
import { CLARIFICATION_HANDOFF_CONVENTION } from '../intake/product-generation.js';

/** 解析调用期模型：仅当部署显式把冻结模型映射到当前角色组模型时才切换。 */
export function continuedRoleModel(config: PracticeConfig, key: string, frozenModelId: `openai/${string}`): `openai/${string}` {
  const continuedModelId = config.modelContinuations?.[frozenModelId];
  const expected = resolveModelId(config, key.startsWith('product') ? 'product' : 'development');
  return continuedModelId === expected ? continuedModelId : frozenModelId;
}

/** 需要收敛为交接执行器的产品角色；总产品统筹仍保留完整冻结角色。 */
const handoffRoleKeys = new Set(['productClarificationAgent', 'productClosureAgent', 'productAgent']);

/** 闭环与写作只消费同一调用已登记的上游资料；不重新开放角色Workspace与Skill发现，避免把已完成交接退化成资料搜集循环。 */
export function invocationRoleTools(key: string, tools: Record<string, unknown>): Record<string, unknown> {
  // handoff工具由调用参数的toolset单独注入，不能在此处过滤或替换。
  if (!handoffRoleKeys.has(key)) return tools;
  return Object.fromEntries(Object.entries(tools).filter(/** 仅保留宿主只读范围说明工具。 */([name]) => name === 'practiceInfo'));
}

/** 将冻结角色默认模型参数投影到新建 Agent；不复制调用期的工具、消息或内存选项。 */
function frozenDefaultOptions(defaults: Pick<AgentExecutionOptionsBase<unknown>, 'modelSettings' | 'maxSteps'>) {
  return {
    ...(defaults?.maxSteps === undefined ? {} : { maxSteps: defaults.maxSteps }),
    // Editor已将冻结模型的maxCompletionTokens映射成Mastra的maxOutputTokens。
    ...(defaults?.modelSettings ? { modelSettings: { ...defaults.modelSettings } } : {}),
  };
}

/** 基于冻结版本重建受限交接 Agent；不携带原角色 Skill、Workspace 或处理器。 */
async function createHandoffAgent(
  frozen: Agent<any, any, any, any>,
  key: string,
  stored: Awaited<ReturnType<typeof resolveRole>>,
  tools: Record<string, unknown>,
  model: Record<string, unknown>,
  storage: Parameters<typeof createNativeMemory>[1],
  mode: PracticeConfig['mode'],
) {
  const defaults = await frozen.getDefaultOptions();
  const handoffOutput = key === 'productClarificationAgent' ? `当confirmedIntake.ready为true时，仅按顺序输出五个Markdown二级章节：${CLARIFICATION_HANDOFF_CONVENTION.sections.join('、')}。每章写出有依据的规则或明确未知项，不重复写完整PRD。` : '';
  const instructions = `${stored.config.instructions}\n\n调用期执行边界（优先于上文的资料发现建议）：这是受限交接执行器。不得发现、加载或读取任何 Skill，不得调用 skill、skill_read、skill_search；不得使用或遍历 Workspace，不得调用任何 mastra_workspace_* 工具。当前只允许使用调用参数提供的 handoff.read、handoff.locate，以及已登记的 practiceInfo；上游材料只能通过 handoff 工具读取，资料足够时直接交付当前角色结果。${handoffOutput}`;
  const invocationAgent = new Agent({
    id: `${frozen.id}-${key}-handoff`,
    name: stored.config.name,
    instructions,
    model: model as any,
    tools: tools as any,
    ...(mode === 'live' ? { memory: createNativeMemory(model as any, storage) } : {}),
    defaultOptions: frozenDefaultOptions(defaults),
  });
  // 每次装配得到独立角色实例；复用结果不会跨Run、跨恢复或跨重试泄漏。
  reuseReadOnlyToolResults(tools);
  return invocationAgent;
}

/** 使用当前任务的工具闭包，存储配置只能选择其子集及已登记只读增强。 */
export async function assembleRole(original: Agent<any, any, any, any>, key: string, config: PracticeConfig) {
  const scope = currentResources(); if (!scope) return original;
  const pin = scope.binding.roles[key]; if (!pin) throw new ResourceError('ROLE_MISSING');
  const stored = await resolveRole(scope.storage, pin.agentId, pin.versionId);
  if (stored.hash !== pin.configHash) throw new ResourceError('CONFIG_DRIFT');
  // 每个装配实例独占工具对象，不能把结果缓存包装器挂到模块级practiceInfo单例。
  const practiceInfo = createTool({ ...practiceInfoTool, execute: practiceInfoTool.execute });
  const available = { ...await original.listTools(), practiceInfo };
  for (const name of Object.keys(await original.listTools())) if (!(name in stored.config.tools)) throw new ResourceError('TOOL_MISSING');
  for (const name of Object.keys(stored.config.tools)) if (!(name in available)) throw new ResourceError('TOOL_MISSING');
  const workspace = await original.getWorkspace();
  const frozenSources = sourceSnapshotContentDirectory(config, scope.binding.runId);
  const editor = new MastraEditor({ filesystems: { 'role-sources': { id: 'role-sources', name: '当前角色只读资料',
    /** 产品资料只从Run快照读取；开发角色没有原始资料Workspace时仍保持既有受限闭包。 */
    createFilesystem: () => {
      if (!workspace?.filesystem) throw new ResourceError('WORKSPACE_MISSING');
      return new LocalFilesystem({ basePath: frozenSources, contained: true, readOnly: true });
    },
  } } });
  new Mastra({ storage: scope.storage, editor, tools: available });
  const agent = await editor.agent.getById(pin.agentId, { versionId: pin.versionId });
  if (!agent) throw new ResourceError('VERSION_MISSING');
  const actual = await agent.listTools();
  for (const name of Object.keys(stored.config.tools)) if (!actual[name]) throw new ResourceError('TOOL_MISSING');
  // 总产品统筹保留完整冻结能力，但同一装配实例内的成功只读结果仍应复用。
  if (key === 'productCoordinatorAgent') reuseReadOnlyToolResults(actual);
  const frozenModelId = `openai/${stored.config.model.name}` as const;
  // 仅部署环境逐项授权时，历史角色才能从冻结模型续接到当前角色组模型；否则保持原模型。
  const modelId = continuedRoleModel(config, key, frozenModelId);
  const model = config.mode === 'fixture' ? await original.getModel() : { id: modelId, apiKey: config.apiKey, ...(config.baseUrl ? { url: config.baseUrl } : {}) };
  const invocationTools = invocationRoleTools(key, actual);
  // 受限角色从冻结配置重建独立Agent；总产品统筹继续使用带Skill与Workspace的冻结原生Agent。
  const runtimeAgent = handoffRoleKeys.has(key)
    ? await createHandoffAgent(agent, key, stored, invocationTools, model as any, scope.storage, config.mode)
    : agent;
  if (config.mode === 'live' && !handoffRoleKeys.has(key)) runtimeAgent.__setMemory(createNativeMemory(model, scope.storage));
  const generate = runtimeAgent.generate.bind(runtimeAgent); const stream = runtimeAgent.stream.bind(runtimeAgent);
  const defaults = await runtimeAgent.getDefaultOptions();
  /** 调用级选项不允许更换冻结模型；默认生成参数由版本最后覆盖。 */
  async function options(input: Record<string, unknown> = {}) {
    if (input.model) throw new ResourceError('MODEL_OVERRIDE');
    if (input.instructions || input.tools || (input.toolsets && !isTaskContextToolset(input.toolsets))) throw new ResourceError('RESOURCE_OVERRIDE');
    const fixed = Object.fromEntries(Object.entries(defaults?.modelSettings ?? {}).filter(/** 原生未设置字段不覆盖既有宿主限制。 */([, value]) => value !== undefined));
    return { ...input, model, modelSettings: { ...(input.modelSettings as object ?? {}), ...fixed } };
  }
  // 保留原生Agent实例及原生调用循环，仅约束可覆盖入口。
  runtimeAgent.generate = (async (messages: any, input?: any) => generate(messages, await options(input))) as Agent['generate'];
  // 流式调用使用相同的冻结边界。
  runtimeAgent.stream = (async (messages: any, input?: any) => stream(messages, await options(input))) as Agent['stream'];
  return runtimeAgent;
}

/** 固定角色代理只在调用时装配，避免跨Run共享当前版本或执行器。 */
export function roleProxy<T extends Agent<any, any, any, any>>(original: T, key: string, config: PracticeConfig): T {
  return new Proxy(original, {
    /** 非生成方法仍委托原生对象；生成方法必须在Workflow资源作用域内解析版本。 */
    get(target, property) {
      if (property === 'generate' || property === 'stream') return /** 调用时解析，避免跨Run复用装配实例。 */ async (...args: any[]) => {
        if (!currentResources()) throw new ResourceError('BINDING_MISSING');
        const agent = await assembleRole(target, key, config);
        return (agent[property] as Function)(...args);
      };
      const value = Reflect.get(target, property, target); return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}
