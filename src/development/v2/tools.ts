import { createTool } from '@mastra/core/tools';
import { createWorkspaceTools } from '@mastra/core/workspace';
import type { ToolsInput } from '@mastra/core/agent';
import { z } from 'zod';
import type { ExecutionPort } from './execution-scope.js';
import type { RoleV2, StateV2 } from './contracts.js';
import type { MemberRuntime } from './agents.js';
import { createCandidateQueryTools } from './query-tools.js';

/** 按角色与运行时授权装配研发工具；执行边界由宿主提供。 */
export async function createDevelopmentTools(execution: ExecutionPort, role: RoleV2, state: StateV2, paths: string[], runtime?: MemberRuntime): Promise<ToolsInput> {
  const tools: ToolsInput = { ...createCandidateQueryTools(execution, state) };
  if (['frontend', 'backend', 'infrastructure'].includes(role) && !runtime?.delegate) tools.writeFile = createTool({ id: 'development-v2-write', description: '只写当前批准任务的精确路径', inputSchema: z.object({ path: z.string(), content: z.string().max(100000) }),
    // 双重白名单，不给模型任意文件或检查写权限。
    execute: async ({ path, content }) => { if (!paths.includes(path)) throw new Error('当前任务不可写该文件'); await execution.writeFile(path, content); return { written: path }; },
  });
  if (state.input.autonomy && ['frontend', 'backend', 'infrastructure'].includes(role)) tools.runChecks = createTool({ id: 'development-v2-check', description: '执行宿主登记的固定检查', inputSchema: z.object({}),
    // 模型不能提供 shell、argv 或检查替代品。
    execute: async () => ({ checks: await execution.runChecks() }),
  });
  if (runtime?.delegate) tools.delegateTask = createTool({ id: 'development-delegate-task', description: '在当前批准任务内委派给已登记实现角色；最多3次、不可递归、不可扩大路径', inputSchema: z.object({ role: z.enum(['frontend', 'backend', 'infrastructure']), goal: z.string().trim().min(1).max(2000), paths: z.array(z.string()).min(1) }),
    // 宿主回调校验角色、精确路径和预算，父成员不能自行写入或授予权限。
    execute: async (request) => runtime.delegate!(request),
  });
  tools.readCheckEvidence = createTool({ id: 'development-check-evidence', description: '按回执序号和检查ID分页读取当前研发状态中已保存的检查结果，不执行检查', inputSchema: z.object({ sequence: z.number().int().positive(), checkId: z.string().min(1), stream: z.enum(['stdout', 'stderr']), offset: z.number().int().nonnegative().default(0), length: z.number().int().min(1).max(4000).default(2000) }),
    /** 仅查询当前状态的真实回执，保留源码身份及输出截断事实。 */
    execute: async ({ sequence, checkId, stream, offset, length }) => {
      const record = state.verificationHistory?.find(item => item.sequence === sequence);
      const check = record?.checks.find(item => item.id === checkId);
      if (!record || !check) throw new Error('未知检查回执');
      const output = check[stream];
      if (offset > output.length) throw new Error('检查输出位置越界');
      const content = output.slice(offset, offset + length);
      return { sequence, sourceHash: record.sourceHash, purpose: record.purpose, checkId, exitCode: check.exitCode, processExitCode: check.processExitCode, timedOut: check.timedOut, stdoutTruncated: check.stdoutTruncated, stderrTruncated: check.stderrTruncated, stream, offset, content, nextOffset: offset + content.length < output.length ? offset + content.length : null };
    },
  });
  // 动态Agent不在Mastra注册表中，显式装配当前候选Workspace的只读工具。
  Object.assign(tools, await createWorkspaceTools(execution.workspace));
  return tools;
}
