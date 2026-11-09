/** 固定方法Adapter；验证原文许可，不执行上游宿主约定。 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { developmentHash } from '../development/contracts.js';
import { loadGovernedSkill } from '../mastra/agents/skills.js';
/** 原文和中文适配入口共同进入运行证据绑定。 */
export function loadBrowserMethod(root: string) {
  const shared = resolve(root, '../../.agents/skills');
  const relative = 'testing/gstack-browser-qa';
  const directory = resolve(shared, relative);
  const lock = JSON.parse(readFileSync(resolve(directory, 'references/source-lock.json'), 'utf8')) as { commit: string; files: Record<string, string> };
  if (lock.commit !== 'b6155921a564ba9ec2470fd2cb3894c05e2c2d13') throw new Error('浏览器方法来源版本不符');
  const hashes: Record<string, string> = {};
  for (const [file, expected] of Object.entries(lock.files)) {
    if (!['reporting.md', 'qa-patterns.md', 'LICENSE'].includes(file)) throw new Error('未知方法参考');
    const actual = createHash('sha256').update(readFileSync(resolve(directory, 'references', file))).digest('hex');
    if (actual !== expected) throw new Error('浏览器方法原文漂移');
    hashes[file] = actual;
  }
  if (Object.keys(hashes).length !== 3) throw new Error('方法参考缺失');
  hashes.entry = createHash('sha256').update(readFileSync(resolve(directory, 'SKILL.md'))).digest('hex');
  hashes.upstream = createHash('sha256').update(readFileSync(resolve(directory, 'references/upstream.md'))).digest('hex');
  return { skill: loadGovernedSkill(shared, relative), hash: developmentHash({ commit: lock.commit, hashes }) };
}
