/** 固定方法资产 Adapter；启动时校验锁，实例持有快照，不在运行中更新资源。 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { loadGovernedSkill } from '../../mastra/agents/skills.js';
import type { InputV2 } from './contracts.js';
import { developmentHash } from '../contracts.js';

/** 装配开发方法，完整原文仍由原生 skill_read 按需读取。 */
export function loadDevelopmentMethods(rootDir: string) {
  const root = resolve(rootDir, '.agents/skills/development');
  const lock = JSON.parse(readFileSync(resolve(rootDir, 'src/development/v2/method-lock.json'), 'utf8')) as Record<string, string>;
  for (const [path, expected] of Object.entries(lock)) {
    const actual = createHash('sha256').update(readFileSync(resolve(root, path))).digest('hex');
    if (actual !== expected) throw new Error('开发方法资产与来源锁不符');
  }
  const skills = {
    context: loadGovernedSkill(resolve(root, '..'), 'development/bmad-context'),
    task: loadGovernedSkill(resolve(root, '..'), 'development/bmad-task-handoff'),
    readiness: loadGovernedSkill(resolve(root, '..'), 'development/bmad-readiness'),
    architectureDocument: loadGovernedSkill(resolve(root, '..'), 'development/architecture-document'),
    review: loadGovernedSkill(resolve(root, '..'), 'development/bmad-code-review'),
  };
  const hash = developmentHash(Object.fromEntries(Object.entries(lock).filter(([path]) => !path.startsWith('architecture-document/'))));
  const architectureHash = developmentHash(lock);
  /** 架构文档方法只绑定启用该格式的 Run。 */
  function hashFor(input: InputV2) { return input.architectureDocumentFormat ? architectureHash : hash; }
  return { hash, hashFor, skills };
}
export type DevelopmentMethods = ReturnType<typeof loadDevelopmentMethods>;
