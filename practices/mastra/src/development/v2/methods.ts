/** 固定方法资产 Adapter；启动时校验锁，实例持有快照，不在运行中更新资源。 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { loadGovernedSkill } from '../../mastra/agents/skills.js';
import { developmentHash } from '../contracts.js';

/** 只导入四个主题，完整原文仍由原生 skill_read 按需读取。 */
export function loadDevelopmentMethods(rootDir: string) {
  const root = resolve(rootDir, '../../.agents/skills/development');
  const lock = JSON.parse(readFileSync(resolve(rootDir, 'src/development/v2/method-lock.json'), 'utf8')) as Record<string, string>;
  for (const [path, expected] of Object.entries(lock)) {
    const actual = createHash('sha256').update(readFileSync(resolve(root, path))).digest('hex');
    if (actual !== expected) throw new Error('开发方法资产与来源锁不符');
  }
  const skills = {
    context: loadGovernedSkill(resolve(root, '..'), 'development/bmad-context'),
    task: loadGovernedSkill(resolve(root, '..'), 'development/bmad-task-handoff'),
    readiness: loadGovernedSkill(resolve(root, '..'), 'development/bmad-readiness'),
    review: loadGovernedSkill(resolve(root, '..'), 'development/bmad-code-review'),
  };
  return { hash: developmentHash(lock), skills };
}
export type DevelopmentMethods = ReturnType<typeof loadDevelopmentMethods>;
