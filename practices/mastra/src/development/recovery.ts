/** 单角色文件检查点适配器；编排仍由原生 Workflow 持有，外部副作用不在恢复范围内。 */
import type { PracticeConfig } from '../mastra/config.js';
import type { DevelopmentExecution } from '../development-execution.js';
import { generateDevelopment } from './agents.js';
import { developmentHash, type DevelopmentRole, type DevelopmentState } from './contracts.js';

export type DevelopmentGenerator = typeof generateDevelopment;
type FaultKind = DevelopmentState['faults'][number]['kind'];

/** 只检查错误类型、状态和 code；从不把原始异常、请求正文或 URL 持久化。 */
export function classifyDevelopmentError(error: unknown): FaultKind {
  let current = error;
  for (let depth = 0; depth < 5 && current && typeof current === 'object'; depth++) {
    const value = current as { name?: unknown; code?: unknown; statusCode?: unknown; cause?: unknown };
    if (typeof value.name === 'string' && /timeout|abort/i.test(value.name)) return 'model-timeout';
    if (typeof value.code === 'string' && /^(ETIMEDOUT|UND_ERR_CONNECT_TIMEOUT|UND_ERR_HEADERS_TIMEOUT)$/.test(value.code)) return 'model-timeout';
    if (typeof value.code === 'string' && /^(ENOTFOUND|EAI_AGAIN|ECONNRESET|ECONNREFUSED|EPIPE|UND_ERR_SOCKET)$/.test(value.code)) return 'model-network';
    if (typeof value.statusCode === 'number' && (value.statusCode === 429 || value.statusCode >= 500)) return 'model-network';
    if (typeof value.name === 'string' && /Zod|SyntaxError|NoObjectGenerated|Invalid.*Output|TypeValidation/.test(value.name)) return 'invalid-output';
    current = value.cause;
  }
  return 'model-error';
}

/** 恢复确认绑定当前输入、方案、失败次数和文件检查点，旧确认不能重用。 */
export function developmentRecoveryHash(state: DevelopmentState, checkpointHash: string): string {
  return developmentHash({ input: state.input, mode: state.mode, planHash: state.planHash, approvedHash: state.approvedHash, completedTasks: state.completedTasks, faults: state.faults, recoveries: state.recoveries, checkpointHash });
}

/** 恢复精确白名单内的部分文件写入；任何额外漂移均失败关闭而非掩盖异常。 */
async function restoreCheckpoint(execution: DevelopmentExecution, before: Record<string, string>, contents: Record<string, string>): Promise<string> {
  const current = await execution.snapshot();
  for (const [path, content] of Object.entries(contents)) if (current[path] !== before[path]) await execution.writeFile(path, content);
  const checkpointHash = developmentHash(before);
  if (developmentHash(await execution.snapshot()) !== checkpointHash) throw new Error('角色失败后检查点无法完整恢复');
  return checkpointHash;
}

/**
 * 捕获模型失败并保存安全检查点。只有恢复校验成功的临时故障自动重试一次；
 * 已完成任务不会由此重放。parse 在调用内验证，使结构错误同样保留失败证据。
 */
export async function invokeDevelopment(config: PracticeConfig, role: DevelopmentRole, execution: DevelopmentExecution, input: DevelopmentState, paths: string[] = [], extra: unknown = null, generate: DevelopmentGenerator = generateDevelopment, validate?: (text: string) => void) {
  let state = input;
  const before = await execution.snapshot();
  const contents: Record<string, string> = {};
  for (const path of paths) contents[path] = await execution.readFile(path);
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const entry = await generate(config, role, execution, state, paths, extra);
      validate?.(entry.text);
      if (!paths.length && developmentHash(await execution.snapshot()) !== developmentHash(before)) throw new Error('只读角色修改了源码');
      return { state: { ...state, checkpointHash: developmentHash(await execution.snapshot()) }, entry };
    } catch (error) {
      const partialSourceHash = developmentHash(await execution.snapshot());
      const checkpointHash = await restoreCheckpoint(execution, before, contents);
      const kind = classifyDevelopmentError(error);
      const taskId = extra && typeof extra === 'object' && 'id' in extra && typeof extra.id === 'string' ? extra.id : null;
      state = { ...state, checkpointHash, faults: [...state.faults, { sequence: state.faults.length + 1, role, taskId, round: state.round, attempt, kind, partialSourceHash, checkpointHash, restored: true, usage: 'unknown' }] };
      if (attempt === 1 && (kind === 'model-timeout' || kind === 'model-network')) continue;
      const recovery = { hash: developmentRecoveryHash(state, checkpointHash), checkpointHash, role, taskId, kind };
      return { state: { ...state, recovery }, entry: null };
    }
  }
  throw new Error('有界角色调用没有返回状态');
}
