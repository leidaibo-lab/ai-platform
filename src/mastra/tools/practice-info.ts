import { createTool } from '@mastra/core/tools';
import { z } from 'zod';

export const practiceInfoTool = createTool({
  id: 'practice-info',
  description: '读取本 Mastra 原生学习应用的固定范围，无网络或文件写入。',
  inputSchema: z.object({}),
  outputSchema: z.object({ framework: z.string(), scope: z.string(), deploymentExecuted: z.boolean() }),
  // 提供可验证的只读事实，避免模型将审批演示描述为实际发布。
  execute: async () => ({ framework: 'Mastra', scope: '独立原生应用与产研交接学习', deploymentExecuted: false }),
});
