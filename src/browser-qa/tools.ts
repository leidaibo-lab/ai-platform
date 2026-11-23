import { createTool } from '@mastra/core/tools';
import { z } from 'zod';
import { runBrowserCase } from './runner.js';
import type { BrowserRequest, BrowserReceipt } from './contracts.js';

/** 为当前批准用例装配工具，调用与回执仅属于本次执行。 */
export function createBrowserCaseTool(requests: BrowserRequest[], methodHash: string, headed: boolean | undefined, receipts: Map<string, BrowserReceipt>) {
  const attempted = new Set<string>();
  return createTool({ id: 'browser-case', description: '执行批准用例；动作和资源由宿主固定', inputSchema: z.object({ caseId: z.string() }).strict(),
    /** 模型只选择批准ID，不能修改目标、动作或断言。 */
    execute: async ({ caseId }) => {
      const request = requests.find(/** 精确匹配批准集合。 */item => item.caseId === caseId);
      if (!request || attempted.has(caseId) || request.methodHash !== methodHash) throw new Error('未知、重复或方法漂移的浏览器用例');
      attempted.add(caseId);
      const receipt = await runBrowserCase(request, headed); receipts.set(caseId, receipt);
      return { ...receipt, screenshot: receipt.screenshot ? { sha256: receipt.screenshot.sha256 } : null };
    },
  });
}
