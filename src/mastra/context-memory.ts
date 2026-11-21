import { methodPrompt } from './team-methods.js';
import type { TeamMethods } from './team-method-contracts.js';
/** 原生 Memory 工厂：只装配框架能力，不实现摘要、token 计算或消息裁剪。
 * ADR: docs/decisions/2026-11-09-mastra-native-context.md
 */
import { randomUUID } from 'node:crypto';
import { Memory } from '@mastra/memory';
import type { AgentConfig } from '@mastra/core/agent';
import type { MastraCompositeStore } from '@mastra/core/storage';

/** 每次角色调用独占线程；重试与跨 Run 不复用失败消息或其他角色的观察。 */
export function nativeInvocationMemory() {
  const id = randomUUID();
  return { thread: `invocation-${id}`, resource: `task-${id}` };
}

/** 观察器沿用角色模型和凭据；同步压缩完成后才继续，存储由宿主拥有并关闭。 */
export function createNativeMemory(model: NonNullable<AgentConfig['model']>, storage?: MastraCompositeStore, methods?: TeamMethods) {
  return new Memory({
    ...(storage ? { storage } : {}),
    options: {
      semanticRecall: false,
      workingMemory: { enabled: false },
      observationalMemory: {
        model,
        observation: {
          messageTokens: 24000, bufferTokens: false, blockAfter: 1,
          observeOnContextOverflow: true, maxRetries: 1, failurePolicy: 'abort',
          continuationHints: { suggestedResponse: false },
          modelSettings: { maxOutputTokens: 8000 },
          instruction: methodPrompt('mastra.context-memory.1', methods),
        },
        reflection: { observationTokens: 12000, modelSettings: { maxOutputTokens: 8000 }, instruction: methodPrompt('mastra.context-memory.2', methods) },
      },
    },
  });
}
