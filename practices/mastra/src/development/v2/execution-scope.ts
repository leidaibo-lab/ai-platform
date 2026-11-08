import { developmentHash } from '../contracts.js';
/** 按原生步骤装配执行环境，避免共享 Workflow 闭包绑定到某一个 Run。 */
import { AsyncLocalStorage } from 'node:async_hooks';
import type { Step } from '@mastra/core/workflows';
import { DevelopmentExecution } from '../../development-execution.js';
import { inputV2Schema, type InputV2 } from './contracts.js';

export type ExecutionPort = Pick<DevelopmentExecution, 'snapshot' | 'readFile' | 'writeFile' | 'runChecks'>;
export type ExecutionResolver = (input: InputV2) => DevelopmentExecution;

/** 从步骤已校验数据取得本轮输入；foreach 的空操作仍携带一份状态。 */
function executionInput(value: unknown): InputV2 {
  if (Array.isArray(value)) return executionInput(value[0]);
  const direct = inputV2Schema.safeParse(value);
  if (direct.success) return direct.data;
  if (value && typeof value === 'object' && 'state' in value) return executionInput(value.state);
  if (value && typeof value === 'object' && 'development' in value) return executionInput(value.development);
  if (value && typeof value === 'object' && 'input' in value) return inputV2Schema.parse(value.input);
  throw new Error('开发步骤没有绑定运行输入');
}

/** 原生步骤装饰器，仅在执行期持有 Adapter，每步结束即关闭临时沙箱。 */
export function createExecutionScope(resolve: ExecutionResolver, captureCandidate = false) {
  const local = new AsyncLocalStorage<DevelopmentExecution>();
  /** 所有 I/O 必须发生在本步骤的环境作用域内。 */
  function current() { const execution = local.getStore(); if (!execution) throw new Error('开发执行缺少步骤作用域'); return execution; }
  const port: ExecutionPort = {
    /** 读取本步骤候选快照。 */
    snapshot: () => current().snapshot(),
    /** 读取本步骤候选文件。 */
    readFile: (path) => current().readFile(path),
    /** 通过当前环境检查写入范围。 */
    writeFile: (path, content) => current().writeFile(path, content),
    /** 在当前环境运行固定检查。 */
    runChecks: () => current().runChecks(),
  };
  /** 保留原生 Step 的图和 schema，只包裹执行环境生命周期。 */
  function bind<T extends Step<any, any, any, any, any, any>>(step: T): T {
    const execute = step.execute;
    // 原生引擎仍负责持久化、暂停和恢复，装饰器不持有运行事实。
    step.execute = async (context) => {
      const execution = resolve(executionInput(context.inputData));
      try {
        return await local.run(execution,
          // 让异步工具链继承当前步骤环境，隔离同时运行的其他 Run。
          async () => {
            const result = await execute(context);
            if (captureCandidate && result && typeof result === 'object' && 'version' in result && result.version === 'development-state.v2') {
              const hashes = await execution.snapshot();
              if (developmentHash(hashes) !== result.checkpointHash) throw new Error('归档候选源码检查点漂移');
              const files: Record<string, string> = {};
              for (const path of Object.keys(hashes)) files[path] = await execution.readFile(path);
              if (developmentHash(await execution.snapshot()) !== result.checkpointHash) throw new Error('读取归档源码期间检查点漂移');
              return { ...result, repositoryCandidate: files };
            }
            return result;
          },
        );
      } finally { await execution.close(); }
    };
    return step;
  }
  return { port, bind };
}
