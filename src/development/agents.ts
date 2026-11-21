import { methodPrompt } from '../mastra/team-methods.js';
/** 开发角色工厂：原生 Agent 拥有工具循环，工具授权由执行 Adapter 与任务图约束。 */
import { Agent, type ToolsInput } from '@mastra/core/agent';
import { createTool } from '@mastra/core/tools';
import { z } from 'zod';
import { resolveModelId, type PracticeConfig } from '../mastra/config.js';
import type { DevelopmentExecution } from '../development-execution.js';
import { architectureSchema, type DevelopmentRole, type DevelopmentState } from './contracts.js';
import { MastraLanguageModelV2Mock } from '@mastra/core/test-utils/llm-mock';
import { noopLogger } from '@mastra/core/logger';
import { classifyDevelopmentError, DevelopmentModelError } from './errors.js';

export const developmentInstructions: Record<DevelopmentRole, string> = {
  architect: methodPrompt('development.agents.1', undefined),
  frontend: methodPrompt('development.agents.2', undefined),
  backend: methodPrompt('development.agents.3', undefined),
  infrastructure: methodPrompt('development.agents.4', undefined),
  'self-check': methodPrompt('development.agents.5', undefined),
};

/** fixture只验证原生控制流和真实工具，不评价模型推理或全栈代码质量。 */
function fixture(role: DevelopmentRole) {
  /** 从Mastra模型上下文递归提取由应用编码的单一JSON输入。 */
  function findInput(value: unknown): Record<string, any> | null {
    if (typeof value === 'string') {
      try {
        const parsed: unknown = JSON.parse(value);
        if (parsed && typeof parsed === 'object' && 'project' in parsed) return parsed as Record<string, any>;
      } catch { /* 普通提示片段不是应用JSON输入。 */ }
    }
    if (Array.isArray(value)) {
      for (const item of value) {
        const found = findInput(item);
        if (found) return found;
      }
    } else if (value && typeof value === 'object') {
      for (const item of Object.values(value)) {
        const found = findInput(item);
        if (found) return found;
      }
    }
    return null;
  }
  /** 返回Mastra兼容的固定模型结果；工具结果仍由注册工具实际执行。 */
  function modelResult(text: string, finishReason: 'stop' | 'tool-calls', tool?: { name: string; input: unknown }) {
    return {
      content: tool
        ? [{ type: 'tool-call' as const, toolCallId: `development-${role}-${tool.name}`, toolName: tool.name, input: JSON.stringify(tool.input) }]
        : [{ type: 'text' as const, text }],
      finishReason,
      usage: { inputTokens: 12, outputTokens: 20, totalTokens: 32 }, warnings: [],
    };
  }
  /** 架构fixture根据项目真实角色和白名单文件生成拓扑有序任务图。 */
  function architecture(prompt: unknown) {
    const input = findInput(prompt);
    const project = input?.project;
    if (!project || !Array.isArray(project.writablePaths) || !Array.isArray(project.roles))
      return modelResult(JSON.stringify({ summary: '项目输入缺失', coverage: [{ requirement: 'project', behavior: '等待有效项目定义', verification: '输入校验' }], contracts: '未创建任何实现任务', tasks: [], blockers: ['项目文件和角色输入缺失'], risks: [] }), 'stop');
    const tasks = project.writablePaths.map(
      // 每个白名单文件只有一个固定负责人，任务链使用显式前驱防止伪造并行。
      (path: string, index: number) => {
      const normalized = path.toLowerCase();
      const preferred = normalized.includes('frontend') || normalized.includes('/web/') || /\.(tsx|jsx|css)$/.test(normalized) ? 'frontend'
        : normalized.includes('docker') || normalized.includes('deploy') || normalized.includes('config') ? 'infrastructure' : 'backend';
      const assigned = project.roles.includes(preferred) ? preferred : project.roles[index % project.roles.length];
      return { id: `fixture-task-${index + 1}`, role: assigned, paths: [path], dependsOn: index ? [`fixture-task-${index}`] : [] };
      },
    );
    const requirement = typeof input.source?.content === 'string' ? input.source.content : '项目当前请求';
    return modelResult(JSON.stringify({
      summary: `fixture为${project.id}生成${tasks.length}个有序实现任务；仅验证任务图装配。`,
      coverage: [{ requirement, behavior: '实现任务按项目已声明文件和角色分配。', verification: `运行项目检查文件：${project.checkFiles.join(', ')}` }],
      contracts: '每个任务只负责其paths；检查文件保持只读；按依赖拓扑顺序串行执行。',
      tasks, blockers: [], risks: ['fixture不评价需求理解和架构质量'],
    }), 'stop');
  }
  /** 实现fixture依次读取当前文件，再调用真实受限写入工具。 */
  function implement(prompt: unknown) {
    const input = findInput(prompt);
    const path = Array.isArray(input?.taskPaths) ? input.taskPaths[0] : undefined;
    const serialized = JSON.stringify(prompt);
    const resultCount = (serialized.match(/tool-result/g) ?? []).length;
    if (!path) return modelResult('ARCHITECTURE_BLOCKER: 当前任务没有可写文件。', 'stop');
    if (resultCount === 0) return modelResult('', 'tool-calls', { name: 'readFile', input: { path } });
    if (resultCount === 1) return modelResult('', 'tool-calls', { name: 'writeFile', input: {
      path,
      content: '/** 固定fixture仅验证真实白名单写入，不代表业务实现。 */\nexport function fixtureValue() { return 1; }\n',
    } });
    return modelResult('fixture已按任务路径执行真实读取和写入。', 'stop');
  }
  /** 自检fixture先运行真实固定检查，然后只返回路由建议。 */
  function selfCheck(prompt: unknown) {
    const hasResult = JSON.stringify(prompt).includes('tool-result');
    const input = findInput(prompt);
    const route = input?.project?.roles?.[0] ?? 'human';
    return hasResult
      ? modelResult(JSON.stringify({ summary: 'fixture已读取真实检查结果', route }), 'stop')
      : modelResult('', 'tool-calls', { name: 'runChecks', input: {} });
  }
  return new MastraLanguageModelV2Mock({
    // 仅替换模型调用；所有文件和检查操作仍经真实原生工具。
    doGenerate: async (options) => role === 'architect' ? architecture(options.prompt)
      : role === 'self-check' ? selfCheck(options.prompt) : implement(options.prompt),
  });
}

/** 只给角色所需的最小工具，避免通用Workspace执行命令扩大权限。 */
export function createDevelopmentAgent(config: PracticeConfig, role: DevelopmentRole, execution: DevelopmentExecution, allowedPaths: string[]) {
  const readFile = createTool({ id: 'development-read', description: '读取本次候选项目内的普通文件。', inputSchema: z.object({ path: z.string() }),
    // 所有读取由 contained LocalFilesystem执行，未知/越界路径拒绝。
    execute: async ({ path }) => ({ content: await execution.readFile(path) }),
  });
  const writeFile = createTool({ id: 'development-write', description: '实际写入当前任务已批准的精确文件路径。', inputSchema: z.object({ path: z.string(), content: z.string().max(100000) }),
    // 角色白名单和Adapter白名单双重校验，不能修改其他角色文件或检查。
    execute: async ({ path, content }) => {
      if (!allowedPaths.includes(path)) throw new Error('不属于当前任务的文件');
      await execution.writeFile(path, content);
      return { written: path, bytes: Buffer.byteLength(content) };
    },
  });
  const runChecks = createTool({ id: 'development-check', description: '执行已声明的固定node语法检查和公开smoke，返回真实退出码。', inputSchema: z.object({}),
    // 执行清单固定且无任意shell参数，结果由Adapter收集。
    execute: async () => ({ checks: await execution.runChecks() }),
  });
  const tools: ToolsInput = { readFile };
  if (role === 'self-check') tools.runChecks = runChecks;
  else if (role !== 'architect') tools.writeFile = writeFile;
  const agent = new Agent({ id: `development-${role}`, name: `开发执行：${role}`, instructions: developmentInstructions[role] + methodPrompt('development.agents.6', undefined),
    model: config.mode === 'fixture' ? fixture(role) : { id: resolveModelId(config, 'development'), apiKey: config.apiKey, ...(config.baseUrl ? { url: config.baseUrl } : {}) }, maxRetries: 0, maxProcessorRetries: 0, tools,
  });
  agent.__setLogger(noopLogger);
  return agent;
}

/** 仅解析显式JSON或单一JSON代码块，不从混合正文中猜测控制决策。 */
export function parseDevelopmentJson(text: string): unknown {
  return JSON.parse(text.trim().replace(/^```(?:json)?\s*\n?/, '').replace(/\n?```$/, ''));
}

/** 为当前角色构造最小上下文，架构返工携带最近实现阻塞而非整个角色历史。 */
export function developmentPrompt(role: DevelopmentRole, state: DevelopmentState, paths: string[] = [], extra: unknown = null): string {
  const latest = state.work.at(-1);
  const blocker = role === 'architect' && state.route === 'architecture' && latest && ['frontend', 'backend', 'infrastructure'].includes(latest.role) && latest.text.includes('ARCHITECTURE_BLOCKER:')
    ? { role: latest.role, round: latest.round, text: latest.text.slice(latest.text.indexOf('ARCHITECTURE_BLOCKER:'), latest.text.indexOf('ARCHITECTURE_BLOCKER:') + 6000) } : null;
  return JSON.stringify({ source: state.input.source.content, project: state.input.project, approvedPlan: state.plan, round: state.round, taskPaths: paths, priorChecks: state.checks, implementationBlocker: blocker, extra });
}

/** 模型调用仅记录白名单用量/工具事实，避免保存凭据与原始错误。 */
export async function generateDevelopment(config: PracticeConfig, role: DevelopmentRole, execution: DevelopmentExecution, state: DevelopmentState, paths: string[] = [], extra: unknown = null) {
  const agent = createDevelopmentAgent(config, role, execution, paths);
  const prompt = developmentPrompt(role, state, paths, extra);
  const options = { maxSteps: 12, modelSettings: { maxOutputTokens: 6000, maxRetries: 0, timeout: { totalMs: 180000, stepMs: 90000 } } };
  const result = config.mode === 'live' && role === 'architect'
    ? await agent.generate(prompt, { ...options, structuredOutput: { schema: architectureSchema, errorStrategy: 'strict', logger: noopLogger } })
    : await agent.generate(prompt, options);
  if (result.finishReason === 'error') throw new DevelopmentModelError(classifyDevelopmentError(result.error));
  if (result.finishReason === 'suspended') throw new DevelopmentModelError('model-error');
  return { role, round: state.round, text: role === 'architect' && result.object ? JSON.stringify(result.object) : result.text, tools: result.toolResults.map(
    // 只记录原生工具结果名称，不能用提示声称替代实际调用。
    (item) => item.payload.toolName,
  ), steps: result.steps.length, modelId: result.response?.modelId ?? null, inputTokens: result.usage?.inputTokens ?? null, outputTokens: result.usage?.outputTokens ?? null };
}
