/** 单次产品角色调用的只读工具结果复用：减少同参重复读取，不跨调用保存业务资料。 */
import { canonical } from './contracts.js';

type ExecutableTool = { execute?: (input: unknown, context: unknown) => Promise<unknown> };

/** 只允许复用产品角色已登记的纯读取工具；未知或可能有副作用的工具必须每次真实执行。 */
function reusableTool(name: string): boolean {
  return name === 'practiceInfo' || name === 'skill' || name === 'skill_read' || name === 'skill_search' || name === 'read' || name === 'locate' || name === 'handoff_read' || name === 'handoff_locate' || name === 'handoff.read' || name === 'handoff.locate' || ['mastra_workspace_read_file', 'mastra_workspace_list_files', 'mastra_workspace_file_stat', 'mastra_workspace_grep'].includes(name);
}

/** 为一次已装配角色安装内存复用包装器；成功结果按工具名和规范化入参缓存，失败立即移除。 */
export function reuseReadOnlyToolResults(tools: Record<string, unknown>): void {
  const results = new Map<string, Promise<unknown>>();
  for (const [name, candidate] of Object.entries(tools)) {
    const tool = candidate as ExecutableTool;
    if (!reusableTool(name) || !tool.execute) continue;
    const execute = tool.execute.bind(tool);
    /** 相同键并发或后续调用共享同一成功结果，避免重复读取相同固定资料。 */
    tool.execute = async (input: unknown, context: unknown) => {
      const key = `${name}:${canonical(input)}`;
      const cached = results.get(key);
      if (cached) return cached;
      const pending = execute(input, context);
      results.set(key, pending);
      try { return await pending; }
      catch (error) { results.delete(key); throw error; }
    };
  }
}
