/** 可插拔自主策略与最小共享上下文回归；不调用模型或真实执行器。 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { leastPrivilegeContextSharePolicy, resolveContextSharePolicy, sharedContextRefSchema } from '../src/development/v2/context-share-policy.js';
import { defaultLoopPolicy, resolveLoopPolicy } from '../src/development/v2/loop-policy.js';
import { reworkDevelopmentV2 } from '../src/mastra/workflows/development-v2.js';

test('自主loop策略只按持久化失败事实区分环境与代码问题', /** 未知错误保持受控代码返工，不推导额外宿主权限。 */ () => {
  const state = {} as never;
  assert.equal(defaultLoopPolicy.classifyRepair({ state, failures: [{ id: 'environment:verification', stdout: '', stderr: 'Docker daemon unavailable', timedOut: false }] }), 'environment');
  assert.equal(defaultLoopPolicy.classifyRepair({ state, failures: [{ id: 'project:check', stdout: '', stderr: 'AssertionError', timedOut: false }] }), 'code');
  assert.throws(() => resolveLoopPolicy({ version: 'unversioned', classifyRepair: () => 'code' }), /策略无效/);
});

test('工作流返工入口将归因委托给注入策略，仍不改变既有返工范围', /** 注入策略只能影响记录分类，预算和任务选择继续由宿主状态门禁拥有。 */ () => {
  const state = { input: { autonomy: { version: 'autonomy.v1', maxNoProgress: 2 }, maxReworks: 3 }, verificationHistory: [], checks: [], checkpointHash: 'c'.repeat(64), repairHistory: [], plan: { tasks: [] }, codeReviews: [], round: 0, outcome: 'in-progress', completedTasks: [], route: 'all', phase: 'implement' } as never;
  const next = reworkDevelopmentV2(state, 'all', 'implement', { version: 'loop-policy.v1', classifyRepair: () => 'authorization' });
  assert.equal(next.repairHistory?.at(-1)?.kind, 'authorization');
});

test('共享上下文只给声明受众的结构化引用，不共享会话正文或跨角色私有记忆', /** 去重与稳定排序使恢复和评测结果可重现。 */ () => {
  const approval = sharedContextRefSchema.parse({ id: 'approved-plan', hash: 'a'.repeat(64), source: 'approval', audience: ['implementation', 'reviewer'], purpose: 'implement' });
  const repair = sharedContextRefSchema.parse({ id: 'repair-1', hash: 'b'.repeat(64), source: 'repair', audience: ['implementation'], purpose: 'repair' });
  const reviewer = leastPrivilegeContextSharePolicy.select({ audience: 'reviewer', available: [repair, approval, approval] });
  assert.deepEqual(reviewer, [approval]);
  assert.throws(() => sharedContextRefSchema.parse({ ...approval, audience: [], thought: 'private chain of thought' }), /Invalid|Unrecognized/);
  assert.throws(() => resolveContextSharePolicy({ version: 'context-share-policy.v1', select: undefined as never }), /策略无效/);
});
