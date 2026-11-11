/** 宿主登记的独立行为验收，不参与模型的实现输出。 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { validateTitle } from './src/title.mjs';

test('拒绝非文本输入且不修改对象', /** 核验类型边界和输入不变性。 */ () => {
  const object = Object.freeze({ title: '原文' });
  for (const value of [undefined, null, false, 1, [], object]) assert.deepEqual(validateTitle(value), { ok: false, error: 'TYPE' });
  assert.deepEqual(object, { title: '原文' });
});
test('拒绝空白和81字符', /** 核验去空白后的非法长度。 */ () => {
  for (const value of ['', '  ', '\t\n', 'x'.repeat(81), '😀'.repeat(81)]) assert.deepEqual(validateTitle(value), { ok: false, error: 'LENGTH' });
});
test('接受1和80码点、Unicode及去空白', /** 核验成功结果保留完整Unicode文本。 */ () => {
  for (const value of ['a', 'x'.repeat(80), '😀'.repeat(80), '  修复登录  ']) assert.deepEqual(validateTitle(value), { ok: true, title: value.trim() });
});
