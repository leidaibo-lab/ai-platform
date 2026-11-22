/** 导出只供审查的 Nacos 产品 Skill ZIP 与来源清单；不会访问网络或发布资源。 */
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { basename, join, relative, resolve } from 'node:path';
import { validateSkillContent } from '@mastra/core/skills';
import { z } from 'zod';
import { productSkillPath, productSkillSelectionSchema } from '../src/mastra/skills.js';

const root = resolve('nacos-resources/product/skills');
const versionSchema = z.string().regex(/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/);
const version = versionSchema.parse(process.argv[3]);
const outputArg = process.argv[2];
if (!outputArg) throw new Error('用法：tsx scripts/prepare-nacos-product-skills.ts <不存在的输出目录> <版本>');
const output = resolve(outputArg);
if (existsSync(output)) throw new Error('输出目录已存在，拒绝覆盖');
const bundleRoot = resolve('nacos-resources/product');
const alignmentSourceSchema = z.object({
  name: z.literal('product-pm-product-requirements-alignment'),
  repository: z.literal('https://gitlab.seakoi.net/seakoi/skills.git'),
  commit: z.string().regex(/^[a-f0-9]{40}$/),
  path: z.literal('product-pm/product-requirements-alignment'),
  files: z.record(z.string(), z.string().regex(/^[a-f0-9]{64}$/)),
});
const manifestContent: unknown = JSON.parse(readFileSync(join(bundleRoot, 'manifest.json'), 'utf8'));
const selection = productSkillSelectionSchema.parse(manifestContent);
const bundle = z.object({ schemaVersion: z.literal('nacos-product-bundle.v1'), version: z.string(), prompts: z.array(z.object({ name: z.string(), version: z.string(), path: z.string(), role: z.string() })), skillSources: z.array(z.object({ directory: z.string(), version: z.string(), name: z.string().optional(), namePrefix: z.string().optional() })), skillVersionOverrides: z.record(z.string().regex(/^[a-z0-9-]+$/), versionSchema).optional(), sourceLock: z.string(), alignmentSource: alignmentSourceSchema }).passthrough().parse(manifestContent);
if (bundle.version !== version || bundle.prompts.some(/** 每个候选 Prompt 版本必须与导出版本一致。 */prompt => prompt.version !== version)) throw new Error('导出版本与资源清单不一致');
const [suite, handoff] = bundle.skillSources;
if (bundle.sourceLock !== 'nacos-resources/product/skills/upstream-lock.json' || bundle.skillSources.length !== 2 || suite?.directory !== 'nacos-resources/product/skills/product-pm' || suite.namePrefix !== 'product-pm-' || suite.version !== version || handoff?.directory !== 'nacos-resources/product/skills/product/requirements-handoff' || handoff.name !== 'product-requirements-handoff' || handoff.version !== version) throw new Error('Skill 来源与导出器支持的治理范围不一致');
const sourceOnlyReferences = new Map([
  ['product-pm-catalog', 'references/shipping/independent-review/scripts/review.py'],
  ['product-pm-flow-ship-check', 'references/resources/scripts/review.py'],
]);

/** 计算文件和来源记录的 SHA-256。 */
function digest(content: Buffer | string) { return createHash('sha256').update(content).digest('hex'); }

/** 只遍历普通文件，拒绝链接和不受支持的 Skill 布局。 */
function filesIn(directory: string, prefix = ''): string[] {
  const result: string[] = [];
  for (const entry of readdirSync(join(directory, prefix), { withFileTypes: true }).sort(/** 固定文件顺序便于核查。 */(a, b) => a.name.localeCompare(b.name))) {
    const path = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isSymbolicLink()) throw new Error(`Skill 不允许符号链接：${path}`);
    if (entry.isDirectory()) {
      if (!prefix && entry.name !== 'references') throw new Error(`Skill 存在不支持的目录：${path}`);
      result.push(...filesIn(directory, path));
    } else if (entry.isFile()) {
      if (path !== 'SKILL.md' && !path.startsWith('references/')) throw new Error(`Skill 存在不支持的文件：${path}`);
      result.push(path);
    } else throw new Error(`Skill 存在非普通文件：${path}`);
  }
  return result;
}

/** 生成一个 Skill 包和清单，原始参考文件仅作为数据保存。 */
function packageSkill(directory: string, expected: string) {
  if (lstatSync(directory).isSymbolicLink() || !lstatSync(directory).isDirectory()) throw new Error(`Skill 目录无效：${expected}`);
  const files = filesIn(directory).filter(/** 独立评审 CLI 仅作为仓库内的上游来源保存。 */path => path !== sourceOnlyReferences.get(expected));
  if (!files.includes('SKILL.md') || files.length > 128) throw new Error(`Skill 文件数量或入口无效：${expected}`);
  const definition = validateSkillContent({ content: readFileSync(join(directory, 'SKILL.md'), 'utf8') });
  if (!definition.valid || definition.metadata?.name !== expected) throw new Error(`Skill 名称或内容无效：${expected}`);
  const records = files.map(/** 保留每个原文的相对路径与内容摘要。 */path => ({ path, size: lstatSync(join(directory, path)).size, sha256: digest(readFileSync(join(directory, path))) }));
  const alignmentSource = bundle.alignmentSource;
  if (expected === alignmentSource.name && (
    records.length !== Object.keys(alignmentSource.files).length ||
    records.some(/** 公司方法正文及引用须逐字节匹配固定来源。 */record => alignmentSource.files[record.path] !== record.sha256)
  )) throw new Error(`公司 Skill 与来源清单不一致：${expected}`);
  if (records.reduce(/** 限制单包未压缩大小。 */(total, item) => total + item.size, 0) > 1024 * 1024) throw new Error(`Skill 超过适配器限制：${expected}`);
  const archive = join(output, `${expected}.zip`);
  const folder = basename(directory);
  execFileSync('zip', ['-q', '-X', archive, ...files.map(/** 按 Nacos 可识别目录打包。 */path => `${folder}/${path}`)], { cwd: resolve(directory, '..') });
  const bytes = readFileSync(archive);
  if (bytes.length > 1024 * 1024) throw new Error(`Skill ZIP 超过适配器限制：${expected}`);
  return { name: expected, version: bundle.skillVersionOverrides?.[expected] ?? version, source: relative(process.cwd(), directory), archive: basename(archive), archiveSha256: digest(bytes), files: records };
}

const sourceLockPath = join(root, 'upstream-lock.json');
const lockBytes = readFileSync(sourceLockPath);
const lock = z.object({ entries: z.array(z.object({ files: z.array(z.object({ localPath: z.string(), sha256: z.string() })) }).passthrough()), licenses: z.array(z.object({ localPath: z.string(), sha256: z.string() })) }).passthrough().parse(JSON.parse(lockBytes.toString('utf8')));
for (const entry of lock.entries) for (const file of entry.files) {
  const full = resolve(root, file.localPath);
  if (!full.startsWith(`${root}/`) || lstatSync(full).isSymbolicLink() || digest(readFileSync(full)) !== file.sha256) throw new Error(`来源锁校验失败：${file.localPath}`);
}
for (const license of lock.licenses) {
  const full = resolve(root, license.localPath);
  if (!full.startsWith(`${root}/`) || lstatSync(full).isSymbolicLink() || digest(readFileSync(full)) !== license.sha256) throw new Error(`许可文件校验失败：${license.localPath}`);
}
mkdirSync(output, { recursive: false, mode: 0o700 });
if (Object.keys(bundle.skillVersionOverrides ?? {}).some(/** 版本修订只用于已启用的资源。 */name => !selection.activeSkills.includes(name))) throw new Error('Skill 修订版本包含未启用的资源');
const skills = selection.activeSkills.map(/** 每项启用资源独立打包。 */name => packageSkill(join(root, productSkillPath(name)), name));
if (!skills.some(/** 公司需求对齐方法须实际导出。 */skill => skill.name === bundle.alignmentSource.name) || !selection.reviewerSkills.includes(bundle.alignmentSource.name)) {
  throw new Error('缺少公司需求对齐 Skill 或审查角色绑定');
}
const prompts = bundle.prompts.map(/** 读取候选 Prompt 并记录精确内容摘要。 */prompt => {
  const full = resolve(bundleRoot, prompt.path);
  if (!full.startsWith(`${bundleRoot}/prompts/`) || lstatSync(full).isSymbolicLink() || !lstatSync(full).isFile()) throw new Error('Prompt 路径无效');
  const bytes = readFileSync(full);
  return { ...prompt, source: relative(process.cwd(), full), size: bytes.length, sha256: digest(bytes) };
});
const manifest = { schemaVersion: 'nacos-product-skill-export.v1', version, status: 'prepared-not-reviewed-or-published', sourceLock: { path: relative(process.cwd(), sourceLockPath), sha256: digest(lockBytes) }, alignmentSource: bundle.alignmentSource, licenses: lock.licenses, prompts, reviewerSkills: selection.reviewerSkills, skills };
writeFileSync(join(output, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
const manager = prompts.find(/** 查找产品经理资源。 */prompt => prompt.role === 'product-manager');
const reviewer = prompts.find(/** 查找独立审查资源。 */prompt => prompt.role === 'product-reviewer');
if (!manager || !reviewer || !skills[0]) throw new Error('缺少产品角色资源');
const bindings = { NACOS_PROMPT_NAME: manager.name, NACOS_PROMPT_VERSION: manager.version, NACOS_REVIEW_PROMPT_NAME: reviewer.name, NACOS_REVIEW_PROMPT_VERSION: reviewer.version, NACOS_SKILL_NAME: skills[0].name, NACOS_SKILL_VERSION: skills[0].version, NACOS_ADDITIONAL_SKILLS: JSON.stringify(skills.slice(1).map(/** 其余方法按精确版本声明。 */skill => ({ name: skill.name, version: skill.version }))), NACOS_REVIEW_SKILLS: JSON.stringify(selection.reviewerSkills) };
writeFileSync(join(output, 'runtime-bindings.json'), `${JSON.stringify(bindings, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
console.log(`已准备 ${skills.length} 个 Skill，审查清单：${join(output, 'manifest.json')}`);
