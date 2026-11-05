import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createSkill, validateSkillContent } from '@mastra/core/skills';
import { z } from 'zod';

/** 产品复合任务共享有限预算；不把方法加载误作无限自主执行。 */
export const PRODUCT_MAX_STEPS = 24;

/**
 * 将公司两级目录适配为原生 inline Skill，参考资料仍由 Mastra skill_read 按需交付。
 * ADR: docs/decisions/2026-11-06-mastra-pm-skills.md
 * root/relativePath 由应用装配持有，不接受模型传入文件路径；读取失败直接中止启动。
 */
export function loadGovernedSkill(root: string, relativePath: string) {
  const dir = join(root, relativePath);
  const definition = validateSkillContent({ content: readFileSync(join(dir, 'SKILL.md'), 'utf8') });
  if (!definition.valid || !definition.metadata || !definition.instructions) {
    throw new Error(`Agent Skill 无效（${relativePath}）：${definition.errors.join('；')}`);
  }
  const references: Record<string, string> = {};
  /** 仅收集受版本管理的参考文本；拒绝符号链接及非普通文件，避免引入外部文件。 */
  function collect(path: string, prefix = '') {
    for (const entry of readdirSync(path, { withFileTypes: true })) {
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) collect(join(path, entry.name), relative);
      else if (entry.isFile()) references[relative] = readFileSync(join(path, entry.name), 'utf8');
      else throw new Error(`Skill 参考资料必须是普通文件：${relativePath}/${relative}`);
    }
  }
  // references 是可选目录，其他布局错误不静默降级。
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name !== 'references') continue;
    if (!entry.isDirectory()) throw new Error(`Skill references 必须是目录：${relativePath}`);
    collect(join(dir, entry.name));
  }
  return createSkill({
    name: z.string().parse(definition.metadata.name),
    description: z.string().parse(definition.metadata.description),
    instructions: definition.instructions,
    ...(definition.metadata.license ? { license: z.string().parse(definition.metadata.license) } : {}),
    metadata: z.record(z.string(), z.unknown()).parse(definition.metadata.metadata ?? {}),
    references,
  });
}

/** 从唯一实践根装配产品套件，稳定排序并拒绝目录名称与元数据不一致。 */
export function loadProductSkills(root: string) {
  const skills = [];
  for (const entry of readdirSync(join(root, 'product-pm'), { withFileTypes: true })) {
    if (!entry.isDirectory()) throw new Error(`product-pm 下必须是 Skill 目录：${entry.name}`);
    const skill = loadGovernedSkill(root, `product-pm/${entry.name}`);
    if (skill.name !== `product-pm-${entry.name}`) throw new Error(`Skill 名称与目录不符：${entry.name}`);
    skills.push(skill);
  }
  // 名称稳定排序便于原生发现与回归比较。
  return skills.sort((left, right) => left.name.localeCompare(right.name));
}
