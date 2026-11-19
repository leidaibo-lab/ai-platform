import assert from 'node:assert/strict';
import test from 'node:test';
import { createProductUnits } from '../src/development/v2/product-units.js';
import { developmentHash } from '../src/development/contracts.js';
import { compareAcceptanceRequirements, readAcceptanceRequirements } from '../src/development/v2/acceptance-requirements.js';


test('长产品稿按原文连续单元定位，保留全部非空行且不以300行阻断', () => {
  const source = ['# 招聘', '', ...Array.from({ length: 400 }, (_, i) => `- 规则 ${i + 1}`), '', '| 字段 | 规则 |', '| --- | --- |', '| 姓名 | 必填 |'].join('\n');
  const units = createProductUnits(source);
  assert.ok(units.length < 300);
  assert.deepEqual(units.flatMap(unit => unit.text.split('\n')), source.split('\n').filter(line => line.trim()));
  for (const unit of units) {
    assert.equal(unit.id, `product:L${unit.line}`);
    assert.equal(unit.hash, developmentHash(unit.text));
    assert.equal(unit.text.split('\n')[0], source.split('\n')[unit.line - 1]);
  }
  assert.deepEqual(createProductUnits(source), units);
});

test('标题、空行和超长单行保持可定位，不丢失正文', () => {
  const source = `# 标题\n正文\n\n${'长'.repeat(2000)}\n下一行\n## 验收\n通过`;
  const units = createProductUnits(source);
  assert.deepEqual(units.map(unit => unit.line), [1, 4, 5, 6]);
  assert.deepEqual(units.flatMap(unit => unit.text.split('\n')), source.split('\n').filter(Boolean));
});

test('稳定需求 ID 不受行移动影响，变更和删除只按历史用例的实际引用匹配', () => {
  const unchanged = '- REQ-UNCHANGED: 保留数据 | 验收: 原数据可读';
  const previous = readAcceptanceRequirements(['- REQ-CREATE: 创建条目 | 验收: 返回编号', unchanged, '- REQ-REMOVE: 删除条目 | 验收: 列表不再展示'].join('\n'));
  const next = readAcceptanceRequirements(['# 新位置', unchanged, '- REQ-CREATE: 创建条目 | 验收: 返回编号及时间', '- REQ-SEARCH: 查询条目 | 验收: 返回匹配结果'].join('\n'));
  const cases = [{ id: 'create', requirementRefs: ['REQ-CREATE'] }, { id: 'remove', requirementRefs: ['REQ-REMOVE'] }, { id: 'unchanged', requirementRefs: ['REQ-UNCHANGED'] }];
  const impact = compareAcceptanceRequirements({ hash: 'prior', requirements: previous }, { hash: 'next', requirements: next }, cases);
  assert.deepEqual(impact.changed, ['REQ-CREATE']);
  assert.deepEqual(impact.added, ['REQ-SEARCH']);
  assert.deepEqual(impact.removed, ['REQ-REMOVE']);
  assert.deepEqual(impact.affectedCaseIds, ['create', 'remove']);
  assert.deepEqual(impact.rerunCaseIds, ['create', 'unchanged']);
  assert.equal(compareAcceptanceRequirements({ hash: 'prior', requirements: createProductUnits('旧需求') }, { hash: 'next', requirements: next }, cases).mode, 'legacy-full');
});

test('无验收预期、重复 ID 或只有代码示例的产品稿无法成为稳定需求基线', () => {
  const item = '- REQ-TITLE: 校验标题 | 验收: 空白标题被拒绝';
  assert.throws(() => readAcceptanceRequirements(`${item}\n${item}`), /重复/);
  assert.throws(() => readAcceptanceRequirements('- REQ-TITLE: 校验标题'), /格式无效/);
  assert.throws(() => readAcceptanceRequirements(`\`\`\`md\n${item}\n\`\`\``), /须包含/);
});
