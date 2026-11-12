/**
 * 自主 loop 的纯策略 Port：归因只使用已持久化的检查和评审事实，不能自行执行命令或改变批准范围。
 * ADR: docs/decisions/2026-11-12-mastra-pluggable-autonomy-context.md
 */
import type { StateV2 } from './contracts.js';

/** 可由宿主替换的返工归因；返回值必须落在既有 StateV2 契约，避免策略私自增加终态。 */
export type RepairKind = 'code' | 'environment' | 'business' | 'authorization';

/** 将当前已验证的失败事实交给策略，模型文字、环境变量和任意宿主输出不属于输入。 */
export interface LoopPolicyInput {
  state: StateV2;
  failures: ReadonlyArray<{ id: string; stdout: string; stderr: string; timedOut: boolean }>;
}

/** 把失败归到一个已有受控处理分支；不提供“继续”以外的执行权限。 */
export interface LoopPolicy {
  readonly version: string;
  classifyRepair(input: LoopPolicyInput): RepairKind;
}

/** 默认策略保留既有环境失败识别，且以失败关闭：未知情况按代码问题交给批准团队复评。 */
export const defaultLoopPolicy: LoopPolicy = {
  version: 'loop-policy.v1',
  /** 环境问题只允许在原登记检查环境重试，绝不推导出安装依赖或执行任意 shell 的权限。 */
  classifyRepair({ failures }) {
    return failures.some(item => item.id.startsWith('environment:') || /cannot connect to.*docker|docker daemon|ECONNREFUSED|ENOTFOUND|no space left|unable to.*(?:image|registry)/i.test(item.stderr + item.stdout))
      ? 'environment'
      : 'code';
  },
};

/** 策略可插拔但必须是同步、纯函数且版本化的；无效实现立即失败，不能悄悄放宽 loop。 */
export function resolveLoopPolicy(policy: LoopPolicy | undefined): LoopPolicy {
  const selected = policy ?? defaultLoopPolicy;
  if (!/^loop-policy\.v\d+$/.test(selected.version) || typeof selected.classifyRepair !== 'function') throw new Error('自主loop策略无效');
  return selected;
}
