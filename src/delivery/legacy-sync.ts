/** 历史架构同步缓存的最小适配；不扫描目录或接受客户端提供结果。 */
import { join } from 'node:path';
import { stateV2Schema, type StateV2 } from '../development/v2/contracts.js';
import { developmentHash } from '../development/contracts.js';
import { contentHash, handoffCache, readHandoffCache } from './remote-handoff.js';

/** 只接受同输入、同源码、仅新增架构产物的未实施阻塞结果。 */
export function validateLegacyArchitectureResult(input: StateV2, value: unknown): StateV2 {
  const saved = stateV2Schema.parse(value);
  if (input.phase !== 'architecture' || input.plan || input.approvedHash || input.completedTasks.length || saved.phase !== 'assemble-team' || saved.outcome !== 'clarification-required' || !saved.plan?.blockers.length || saved.approvedHash || saved.completedTasks.length || saved.reviews.length || saved.delivery ||
    developmentHash(saved.input) !== developmentHash(input.input) || saved.checkpointHash !== input.checkpointHash || developmentHash(saved.executionIdentity) !== developmentHash(input.executionIdentity) || saved.methodBundleHash !== input.methodBundleHash || saved.mode !== input.mode || developmentHash(saved.context) !== developmentHash(input.context) || saved.calls <= input.calls || saved.calls > input.calls + 5 || saved.maxCalls !== input.maxCalls || saved.work.length !== input.work.length + 1 || developmentHash(saved.work.slice(0, -1)) !== developmentHash(input.work) || saved.work.at(-1)?.role !== 'architect') throw new Error('历史同步缓存不满足未实施架构恢复条件');
  return saved;
}

/** 缓存名由原生输入派生，读取失败必须关闭，不能退回模型重新生成。 */
export function readLegacyArchitectureResult(root: string, runId: string, input: StateV2): StateV2 {
  const value = JSON.parse(readHandoffCache(legacyArchitectureCachePath(root, runId, input)));
  return validateLegacyArchitectureResult(input, value.action === 'result' ? value.value : value);
}

/** 旧格式缓存仍由精确Run、阶段和输入散列定位，调用方不得遍历私有缓存目录。 */
export function legacyArchitectureCachePath(root: string, runId: string, input: StateV2): string {
  const key = contentHash(JSON.stringify({ runId, stage: 'architecture', input }, null, 2) + '\n');
  return join(handoffCache(root), `result-${key}.json`);
}
