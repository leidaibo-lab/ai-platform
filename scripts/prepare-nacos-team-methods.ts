/** 导出全团队方法待审候选；不读取凭据、不联网、不发布、不覆盖目录。 */
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { z } from 'zod';
import { teamPromptSources, teamSkillSources, defaultMethodBindings } from '../src/mastra/team-methods.js';
import { readSkillZip } from '../src/mastra/nacos-resources.js';
import { loadDevelopmentMethods } from '../src/development/v2/methods.js';
import { loadBrowserMethod } from '../src/browser-qa/method.js';

/** 资源散列用于人工审查及发布前漂移检测。 */
function hash(bytes: string | Buffer) { return createHash('sha256').update(bytes).digest('hex'); }

/** 只打包入口及 references，拒绝符号链接并保留来源锁与许可原文。 */
function skillFiles(directory: string, prefix = ''): string[] {
  if (lstatSync(join(directory, prefix)).isSymbolicLink()) throw new Error('Skill 目录不允许链接');
  const files: string[] = [];
  for (const entry of readdirSync(join(directory, prefix), { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const path = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (!prefix && !['SKILL.md', 'references'].includes(entry.name)) continue;
    if (entry.isSymbolicLink()) throw new Error('Skill 文件不允许链接');
    if (entry.isDirectory()) files.push(...skillFiles(directory, path));
    else if (entry.isFile()) files.push(path);
    else throw new Error('Skill 只允许普通文件');
  }
  return files;
}

/** 复用已治理的唯一源目录，输出可由本机注册器导入的通用清单。 */
export async function prepareTeamMethods(rootDir: string, outputDir: string, release: string) {
  const version = z.string().regex(/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/).parse(release);
  const root = resolve(rootDir); const output = resolve(outputDir);
  if (existsSync(output)) throw new Error('输出目录已存在，拒绝覆盖');
  loadDevelopmentMethods(root); loadBrowserMethod(root);
  mkdirSync(output, { mode: 0o700 });
  const prompts = Object.entries(teamPromptSources).map(([slot, prompt]) => {
    const source = join(output, `${prompt.name}.md`);
    writeFileSync(source, prompt.content, { flag: 'wx', mode: 0o600 });
    return { slot, name: prompt.name, version, source, origin: prompt.source, sha256: hash(prompt.content) };
  });
  const skills = [];
  for (const [slot, skill] of Object.entries(teamSkillSources)) {
    const directory = join(root, '.agents/skills', skill.path); const files = skillFiles(directory);
    const records = files.map(path => ({ path, sha256: hash(readFileSync(join(directory, path))), size: lstatSync(join(directory, path)).size }));
    if (!files.includes('SKILL.md') || files.length > 128 || records.reduce((total, file) => total + file.size, 0) > 1024 * 1024) throw new Error('Skill 超过资源限制');
    const archive = `${skill.name}.zip`;
    execFileSync('zip', ['-q', '-X', join(output, archive), ...files], { cwd: directory });
    const bytes = readFileSync(join(output, archive));
    if (bytes.length > 1024 * 1024) throw new Error('Skill ZIP 超过资源限制');
    await readSkillZip(bytes);
    skills.push({ slot, name: skill.name, version, source: directory, archive, archiveSha256: hash(bytes), files: records });
  }
  const manifest = { schemaVersion: 'nacos-team-method-export.v1', version, status: 'prepared-not-reviewed-or-published', prompts, skills };
  writeFileSync(join(output, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  writeFileSync(join(output, 'runtime-bindings.json'), JSON.stringify({ NACOS_TEAM_METHOD_VERSION: version, NACOS_TEAM_METHODS: JSON.stringify(defaultMethodBindings(version)) }, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  return manifest;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  if (!process.argv[2] || !process.argv[3]) throw new Error('用法：tsx scripts/prepare-nacos-team-methods.ts <不存在的输出目录> <版本>');
  const manifest = await prepareTeamMethods(process.cwd(), process.argv[2], process.argv[3]);
  console.log(`已准备 ${manifest.prompts.length} 个 Prompt、${manifest.skills.length} 个 Skill；未发布。`);
}
