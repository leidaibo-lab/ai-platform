import { z } from 'zod';
import { createHash } from 'node:crypto';

const idPattern = /^REQ-[A-Z0-9]+(?:-[A-Z0-9]+)*$/;
export const requirementImpactSchema = z.object({
  previousProductHash: z.string(), productHash: z.string(),
  mode: z.enum(['stable-ids', 'legacy-full']),
  added: z.array(z.string()), changed: z.array(z.string()), removed: z.array(z.string()),
  affectedCaseIds: z.array(z.string()), rerunCaseIds: z.array(z.string()),
});
export type RequirementImpact = z.infer<typeof requirementImpactSchema>;

/** 从批准 Markdown 读取独立验收条目，行号仅用于定位。 */
export function readAcceptanceRequirements(content: string) {
  const ids = new Set<string>();
  const requirements: { id: string; line: number; text: string; hash: string }[] = [];
  let fence: string | undefined;
  for (const [index, line] of content.split(/\r?\n/).entries()) {
    const marker = line.match(/^\s{0,3}(`{3,}|~{3,})(.*)$/);
    if (marker) {
      if (!fence) fence = marker[1]!;
      else if (marker[1]!.startsWith(fence) && !marker[2]!.trim()) fence = undefined;
      continue;
    }
    if (fence || !/^\s*[-*+]\s+(?:\*\*)?REQ-/i.test(line)) continue;
    const item = line.match(/^\s*-\s+(REQ-[A-Z0-9-]+)\s*[:：]\s*(.+?)\s*\|\s*验收\s*[:：]\s*(.+?)\s*$/);
    if (!item || !idPattern.test(item[1]!) || item[1]!.length > 80 || !item[2]!.trim() || !item[3]!.trim()) throw new Error(`第 ${index + 1} 行的可验收需求格式无效`);
    const [, id, rule, expected] = item as [string, string, string, string];
    if (ids.has(id)) throw new Error(`可验收需求 ID 重复：${id}`);
    ids.add(id);
    const text = `${rule.trim()} | 验收: ${expected.trim()}`;
    requirements.push({ id, line: index + 1, text, hash: createHash('sha256').update(JSON.stringify(text)).digest('hex') });
  }
  if (!requirements.length || requirements.length > 100) throw new Error('产品稿须包含 1 至 100 项带 REQ-ID 和验收预期的需求');
  return requirements;
}

/** 比较已批准基线与待审稿，历史用例按实际保存的引用映射。 */
export function compareAcceptanceRequirements(
  previous: { hash: string; requirements: readonly { id: string; hash: string }[] },
  next: { hash: string; requirements: readonly { id: string; hash: string }[] },
  cases: readonly { id: string; requirementRefs: readonly string[] }[],
): RequirementImpact {
  const stable = [previous.requirements, next.requirements].every(items => items.length && items.every(item => idPattern.test(item.id)));
  const before = new Map(previous.requirements.map(item => [item.id, item.hash]));
  const after = new Map(next.requirements.map(item => [item.id, item.hash]));
  const added = stable ? [...after.keys()].filter(id => !before.has(id)) : [];
  const changed = stable ? [...after.keys()].filter(id => before.has(id) && before.get(id) !== after.get(id)) : [];
  const removed = stable ? [...before.keys()].filter(id => !after.has(id)) : [];
  const affected = new Set([...changed, ...removed]);
  return {
    previousProductHash: previous.hash, productHash: next.hash, mode: stable ? 'stable-ids' : 'legacy-full', added, changed, removed,
    affectedCaseIds: cases.filter(item => !stable || item.requirementRefs.some(ref => affected.has(ref))).map(item => item.id),
    rerunCaseIds: cases.filter(item => !stable || item.requirementRefs.some(ref => after.has(ref))).map(item => item.id),
  };
}
