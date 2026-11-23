import { createTeamRunPolicy } from '../src/team/run-policy.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { repairProductPresentation } from '../src/mastra/workflows/product-manager.js';
import { describeProductFailure } from '../src/intake/product-failure.js';

const valid = '# 需求文档\n- REQ-LOGIN: 用户可登录 | 验收: 登录成功\n# 产品规格\n- TASK-LOGIN: 提供登录 | 需求: REQ-LOGIN\n';
const invalid = valid.replace('# 需求文档\n', '# 需求文档\n内部来源 material-1-aabbccdd\n');

test('产品稿内部痕迹触发一次定向修订并完整复验', async () => {
  const inputs: unknown[] = [];
  const result = await repairProductPresentation(async repair => { inputs.push(repair); return { text: repair ? valid : invalid }; }, true, createTeamRunPolicy());
  assert.equal(result.repairs, 1);
  assert.equal(result.result.text, valid);
  assert.match((inputs[1] as { finding: string }).finding, /第2行存在内部材料标识/);
  assert.equal((inputs[1] as { candidate: string }).candidate, invalid);
});

test('重复内部痕迹有界停止，安全诊断兼容历史错误', async () => {
  let calls = 0;
  await assert.rejects(repairProductPresentation(async () => { calls++; return { text: invalid }; }, true, createTeamRunPolicy()), /第2行存在内部材料标识/);
  assert.equal(calls, 2);
  assert.match(describeProductFailure({ message: '待审产品稿包含内部制作过程内容，须在写作阶段移出正式双文档' })!.reason, /内部制作过程/);
  assert.equal(describeProductFailure({ message: '待审产品稿包含内部制作过程内容：secret' }), undefined);
});

test('修订暴露新错误后继续修订并完整复验', async () => {
  let calls = 0;
  const result = await repairProductPresentation(async () => ({ text: ++calls === 1 ? invalid : calls === 2 ? valid.replace('需求: REQ-LOGIN', '需求: REQ-OTHER') : valid }), true, createTeamRunPolicy());
  assert.equal(calls, 3);
  assert.equal(result.repairs, 2);
  assert.deepEqual(result.history.map(item => item.outcome), ['rework', 'rework', 'passed']);
});

test('缺少可验收需求也能触发一次定向修订', async () => {
  let calls = 0;
  const result = await repairProductPresentation(async repair => { calls++; if (repair) assert.match(repair.finding, /1 至 100/); return { text: repair ? valid : '# 需求文档\n业务说明\n# 产品规格\n' }; }, true, createTeamRunPolicy());
  assert.equal(calls, 2);
  assert.equal(result.repairs, 1);
  assert.match(describeProductFailure({ message: '产品稿须包含 1 至 100 项带 REQ-ID 和验收预期的需求' })!.reason, /REQ-ID/);
});

test('不同候选持续失败时预算耗尽，保留每轮诊断', async () => {
  let calls = 0;
  await assert.rejects(repairProductPresentation(async () => ({ text: `${invalid}\n补充${++calls}` }), true, createTeamRunPolicy()), (error: any) => {
    assert.equal(error.productRepairHistory.length, 4);
    assert.equal(error.productRepairHistory.at(-1).outcome, 'budget-exhausted');
    assert.equal(new Set(error.productRepairHistory.map((item: any) => item.candidateHash)).size, 4);
    return true;
  });
  assert.equal(calls, 4);
});

test('历史 Run 未绑定策略时保持一次修订', async () => {
  let calls = 0;
  await assert.rejects(repairProductPresentation(async () => ({ text: `${invalid}\n${++calls}` }), true), /内部材料标识/);
  assert.equal(calls, 2);
});

test('网络失败后恢复沿用已完成修订与候选，不能刷新预算', async () => {
  let calls = 0;
  let checkpoint: any;
  await assert.rejects(repairProductPresentation(async () => {
    if (++calls === 3) throw new Error('synthetic transport interruption');
    return { text: `${invalid}\n候选${calls}` };
  }, true, createTeamRunPolicy()), (error: any) => {
    checkpoint = error.productRepairCheckpoint;
    assert.equal(checkpoint.history.length, 2);
    return true;
  });
  let resumed = 0;
  await assert.rejects(repairProductPresentation(async repair => {
    assert.match(repair!.candidate, /候选|恢复/);
    return { text: `${invalid}\n恢复${++resumed}` };
  }, true, createTeamRunPolicy(), checkpoint), (error: any) => {
    assert.equal(error.productRepairHistory.length, 4);
    assert.equal(error.productRepairHistory.at(-1).outcome, 'budget-exhausted');
    checkpoint = error.productRepairCheckpoint;
    return true;
  });
  assert.equal(resumed, 2);
  await assert.rejects(repairProductPresentation(async () => {
    throw new Error('不得再次调用模型');
  }, true, createTeamRunPolicy(), checkpoint), /预算已耗尽/);
});
