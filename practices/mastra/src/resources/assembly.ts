/** 按Run版本装配原生Stored Agent；不从最新配置、任意URL或存储中的代码执行能力。 */
import { Mastra } from '@mastra/core/mastra';
import { MastraEditor } from '@mastra/editor';
import type { Agent } from '@mastra/core/agent';
import type { PracticeConfig } from '../mastra/config.js';
import { createNativeMemory } from '../mastra/context-memory.js';
import { practiceInfoTool } from '../mastra/tools/practice-info.js';
import { currentResources } from './scope.js';
import { resolveRole } from './native-store.js';
import { ResourceError } from './contracts.js';
import { isTaskContextToolset } from '../delivery/task-context.js';

/** 使用当前任务的工具闭包，存储配置只能选择其子集及已登记只读增强。 */
export async function assembleRole(original: Agent<any, any, any, any>, key: string, config: PracticeConfig) {
  const scope = currentResources(); if (!scope) return original;
  const pin = scope.binding.roles[key]; if (!pin) throw new ResourceError('ROLE_MISSING');
  const stored = await resolveRole(scope.storage, pin.agentId, pin.versionId);
  if (stored.hash !== pin.configHash) throw new ResourceError('CONFIG_DRIFT');
  const available = { ...await original.listTools(), practiceInfo: practiceInfoTool };
  for (const name of Object.keys(await original.listTools())) if (!(name in stored.config.tools)) throw new ResourceError('TOOL_MISSING');
  for (const name of Object.keys(stored.config.tools)) if (!(name in available)) throw new ResourceError('TOOL_MISSING');
  const workspace = await original.getWorkspace();
  const editor = new MastraEditor({ filesystems: { 'role-sources': { id: 'role-sources', name: '当前角色只读资料',
    /** 数据资料由已有只读Workspace拥有，不接受存储配置提供宿主路径。 */
    createFilesystem: () => { if (!workspace?.filesystem) throw new ResourceError('WORKSPACE_MISSING'); return workspace.filesystem; },
  } } });
  new Mastra({ storage: scope.storage, editor, tools: available });
  const agent = await editor.agent.getById(pin.agentId, { versionId: pin.versionId });
  if (!agent) throw new ResourceError('VERSION_MISSING');
  const actual = await agent.listTools();
  for (const name of Object.keys(stored.config.tools)) if (!actual[name]) throw new ResourceError('TOOL_MISSING');
  const model = config.mode === 'fixture' ? await original.getModel() : { id: `openai/${stored.config.model.name}` as const, apiKey: config.apiKey, ...(config.baseUrl ? { url: config.baseUrl } : {}) };
  if (config.mode === 'live') agent.__setMemory(createNativeMemory(model, scope.storage));
  const generate = agent.generate.bind(agent); const stream = agent.stream.bind(agent);
  const defaults = await agent.getDefaultOptions();
  /** 调用级选项不允许更换冻结模型；默认生成参数由版本最后覆盖。 */
  async function options(input: Record<string, unknown> = {}) {
    if (input.model) throw new ResourceError('MODEL_OVERRIDE');
    if (input.instructions || input.tools || (input.toolsets && !isTaskContextToolset(input.toolsets))) throw new ResourceError('RESOURCE_OVERRIDE');
    const fixed = Object.fromEntries(Object.entries(defaults?.modelSettings ?? {}).filter(/** 原生未设置字段不覆盖既有宿主限制。 */([, value]) => value !== undefined));
    return { ...input, model, modelSettings: { ...(input.modelSettings as object ?? {}), ...fixed } };
  }
  // 保留原生Agent实例及原生调用循环，仅约束可覆盖入口。
  agent.generate = (async (messages: any, input?: any) => generate(messages, await options(input))) as Agent['generate'];
  // 流式调用使用相同的冻结边界。
  agent.stream = (async (messages: any, input?: any) => stream(messages, await options(input))) as Agent['stream'];
  return agent;
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
