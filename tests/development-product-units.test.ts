import assert from 'node:assert/strict';
import test from 'node:test';
import { createProductUnits } from '../src/development/v2/product-units.js';
import { developmentHash } from '../src/development/contracts.js';

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
