import test from 'node:test';
import assert from 'node:assert/strict';
import { splitMaterial, defaultChunkPolicy, chunkPolicySchema } from '../src/delivery/material-chunks.js';
import { createTaskContext } from '../src/delivery/task-context.js';

test('两种分片策略无丢失重叠，Unicode与长行可还原', /** 与全文比较验证原文位置，不把预览当摘要。 */() => {
  const text = ('批准规则🙂\n' + '很长一行'.repeat(300)).repeat(8);
  for (const strategy of ['paragraph', 'fixed'] as const) {
    const chunks = splitMaterial(text, { ...defaultChunkPolicy, strategy, chars: 99 });
    assert.equal(chunks.map(/** 用半开区间还原全文。 */c => text.slice(c.offset, c.end)).join(''), text);
    for (const c of chunks) { assert.ok(c.end - c.offset <= 99); assert.ok(!/[\uD800-\uDBFF]$/.test(text.slice(c.offset, c.end))); }
  }
  assert.deepEqual(splitMaterial(''), []);
  assert.throws(/** 配置不能注入任意策略实现。 */() => chunkPolicySchema.parse({ ...defaultChunkPolicy, strategy: 'custom-script' }));
});

test('分页定位跨边界关键词并读取精确正文，不泄露其他调用资料', /** 实际工具同一闭包确保定位和读取共享权限与预算。 */() => {
  const text = 'a'.repeat(2998) + '业务边界' + 'b'.repeat(50000);
  const c = createTaskContext({ source: text }); const id = c.manifest[0].id;
  const first = c.locate({ id }); assert.equal(first.items.length, 12); assert.notEqual(first.nextCursor, null);
  const second = c.locate({ id, cursor: first.nextCursor! }); assert.equal(second.items[0].offset, first.items.at(-1)!.end);
  const matches = c.locate({ id, query: '业务边界' }); assert.equal(matches.items[0].offset, 0);
  assert.equal(c.read({ id, offset: 2998, length: 4 }).content, '业务边界');
  assert.equal(c.locate({ id, query: '不存在的字面关键词' }).items.length, 0);
  assert.throws(/** 禁止将路径当资料ID。 */() => c.locate({ id: '/etc/passwd' }));
  assert.throws(/** 拒绝超出分页游标。 */() => c.locate({ id, cursor: 999 }));
  const other = createTaskContext({ source: '其他正文'.repeat(3000) });
  assert.throws(/** 当前调用不能使用其他调用的引用。 */() => other.locate({ id }));
  let exhausted = false;
  for (let i = 0; i < 100; i++) {
    try { c.locate({ id }); } catch { exhausted = true; break; }
  }
  assert.ok(exhausted); assert.throws(/** 目录超限也不能被工具吞掉后交付。 */() => c.assertBudget(), /预算/);
});
