import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// 确认入库原文与固定上游摘要一致，避免方法来源静默漂移。
test('gstack 角色方法保留固定上游原文和许可', () => {
  const cases = [
    ['.agents/skills/development/gstack-engineering-review/references', { 'plan-eng-review/SKILL.md': 'upstream.md', LICENSE: 'LICENSE' }],
    ['.agents/skills/development/gstack-code-review/references', { 'review/SKILL.md': 'upstream.md', LICENSE: 'LICENSE' }],
    ['nacos-resources/product/skills/product-pm/gstack-discovery/references', { 'office-hours/SKILL.md': 'office-hours.md', 'plan-ceo-review/SKILL.md': 'plan-ceo-review.md', LICENSE: 'LICENSE' }],
  ] as const;
  for (const [directory, files] of cases) {
    const lock = JSON.parse(readFileSync(join(directory, 'source-lock.json'), 'utf8')) as { commit: string; files: Record<string, string> };
    assert.match(lock.commit, /^[a-f0-9]{40}$/);
    for (const [source, local] of Object.entries(files)) {
      assert.equal(createHash('sha256').update(readFileSync(join(directory, local))).digest('hex'), lock.files[source]);
    }
  }
});
