/** 资产目录投影：按需读取完成清单，无全局可变索引或第二套流程数据库。 */
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { correlationSchema, type AssetCorrelation } from './asset-identity.js';
import { ensureAssetDirectory, safeAssetPath, validateHrmRepository } from './asset-files.js';

const hashSchema = z.string().regex(/^[a-f0-9]{64}$/);
export const assetManifestSchema = z.object({ schemaVersion: z.union([z.literal(1), z.literal(2)]), repository: z.string().url(), runId: z.string().regex(/^[a-zA-Z0-9_-]{1,200}$/), stage: z.string().regex(/^[a-zA-Z0-9_-]{1,200}$/), mode: z.enum(['fixture', 'live']), event: z.enum(['pending', 'completed']), projectionHash: hashSchema, authority: z.literal('workflow-export'), correlation: correlationSchema.optional(), createdAt: z.iso.datetime().optional(), files: z.record(z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,199}$/), hashSchema) });
const runRecordSchema = z.object({ schemaVersion: z.literal(1), correlation: correlationSchema, createdAt: z.iso.datetime(), briefHash: hashSchema });
export type AssetManifest = z.infer<typeof assetManifestSchema>;
/** 单个不可变阶段版本；path 为仓库相对清单路径，正文按需校验读取。 */
export interface CatalogAsset { id: string; path: string; area: string; manifest: AssetManifest }
/** 仓库投影目录；仅关联与文件版本，不承载流程状态或批准权。 */
export interface AssetCatalog { schemaVersion: 1; projectId: 'hrm'; generatedAt: string; authority: 'repository-projection'; runs: z.infer<typeof runRecordSchema>[]; assets: CatalogAsset[] }

/** 对原始字节求散列；不把业务批准散列当成文件完整性散列。 */
export function assetHash(value: string): string { return createHash('sha256').update(value).digest('hex'); }

/** 不可变记录允许同字节并发重试，冲突或符号链接必须明确失败。 */
export function writeImmutableFile(path: string, content: string): void {
  try { writeFileSync(path, content, { flag: 'wx', mode: 0o600 }); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
  if (lstatSync(path).isSymbolicLink() || !lstatSync(path).isFile() || readFileSync(path, 'utf8') !== content) throw new Error('资产文件冲突，拒绝覆盖');
}

/** 初始化时固定根 Run 归属；同 Run 的迭代漂移或原始输入漂移拒绝覆盖。 */
export function registerAssetRun(directory: string, value: AssetCorrelation, brief: string): void {
  const correlation = correlationSchema.parse(value);
  const root = validateHrmRepository(directory);
  const project = ensureAssetDirectory(root, 'product/catalog/projects/hrm');
  writeImmutableFile(join(project, 'project.json'), JSON.stringify({ schemaVersion: 1, projectId: 'hrm', repository: 'https://github.com/leidaibo-lab/hrm', authority: 'repository-projection' }, null, 2) + '\n');
  const iteration = ensureAssetDirectory(root, `product/catalog/projects/hrm/iterations/${correlation.iterationId}`);
  writeImmutableFile(join(iteration, 'iteration.json'), JSON.stringify({ schemaVersion: 1, projectId: 'hrm', iterationId: correlation.iterationId }, null, 2) + '\n');
  const run = ensureAssetDirectory(root, `product/catalog/runs/${correlation.runId}`);
  const file = join(run, 'run.json');
  const previous = existsSync(file) ? runRecordSchema.parse(JSON.parse(readFileSync(safeAssetPath(root, `product/catalog/runs/${correlation.runId}/run.json`), 'utf8'))) : undefined;
  if (previous && (JSON.stringify(previous.correlation) !== JSON.stringify(correlation) || previous.briefHash !== assetHash(brief))) throw new Error('Run 已绑定不同迭代或需求');
  const record = previous ?? { schemaVersion: 1, correlation, createdAt: new Date().toISOString(), briefHash: assetHash(brief) };
  // 并发初始化以首个写入记录的时间为准，业务绑定仍必须完全相同。
  try { writeFileSync(file, JSON.stringify(record, null, 2) + '\n', { flag: 'wx', mode: 0o600 }); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
  const saved = runRecordSchema.parse(JSON.parse(readFileSync(safeAssetPath(root, `product/catalog/runs/${correlation.runId}/run.json`), 'utf8')));
  if (JSON.stringify(saved.correlation) !== JSON.stringify(correlation) || saved.briefHash !== assetHash(brief)) throw new Error('Run 关联冲突');
}

/** 有界递归只读取普通目录；不跟随符号链接，不接受未完成版本。 */
function findManifests(root: string, relative: string, depth: number, budget: { entries: number }, paths: string[]): void {
  if (!existsSync(join(root, relative))) return;
  const directory = safeAssetPath(root, relative);
  if (!lstatSync(directory).isDirectory()) throw new Error('资产目录损坏');
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (++budget.entries > 25000) throw new Error('目录超过本地扫描预算，需升级索引');
    if (entry.isSymbolicLink()) throw new Error('资产目录含符号链接');
    if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,199}$/.test(entry.name)) throw new Error('资产名称无效');
    const child = `${relative}/${entry.name}`;
    if (depth > 0 && entry.isDirectory()) findManifests(root, child, depth - 1, budget, paths);
    else if (depth === 0 && entry.isFile() && entry.name === 'manifest.json') paths.push(child);
  }
}

/** 从三类产物完成标记构造统一清单，历史未关联版本保持未关联。 */
export function readAssetCatalog(directory: string): AssetCatalog {
  const root = validateHrmRepository(directory);
  const paths: string[] = [];
  const budget = { entries: 0 };
  for (const area of ['product', 'testSet', 'deploy']) findManifests(root, `${area}/runs`, 3, budget, paths);
  const assets: CatalogAsset[] = [];
  for (const path of paths.sort()) {
    const manifest = assetManifestSchema.parse(JSON.parse(readBoundedFile(safeAssetPath(root, path))));
    const parts = path.split('/');
    if (parts[2] !== manifest.runId || parts[3] !== manifest.stage || parts[4] !== manifest.projectionHash) throw new Error('产物目录与清单不一致');
    if (manifest.schemaVersion === 2 && (!manifest.createdAt || (manifest.correlation && manifest.correlation.runId !== manifest.runId))) throw new Error('产物关联无效');
    assets.push({ id: assetHash(path), path, area: parts[0], manifest });
  }
  const runs: AssetCatalog['runs'] = [];
  const runRoot = join(root, 'product/catalog/runs');
  if (existsSync(runRoot)) {
    for (const entry of readdirSync(safeAssetPath(root, 'product/catalog/runs'), { withFileTypes: true })) {
      if (runs.length >= 5000 || entry.isSymbolicLink() || !entry.isDirectory()) throw new Error('Run 目录无效或超过预算');
      const record = runRecordSchema.parse(JSON.parse(readBoundedFile(safeAssetPath(root, `product/catalog/runs/${entry.name}/run.json`))));
      if (entry.name !== record.correlation.runId) throw new Error('Run 目录关联不一致');
      runs.push(record);
    }
  }
  for (const asset of assets) {
    if (!asset.manifest.correlation) continue;
    const bound = runs.find(
      // 清单只接受初始化登记过的同一 Run 归属。
      (run) => run.correlation.runId === asset.manifest.runId,
    );
    if (!bound || JSON.stringify(bound.correlation) !== JSON.stringify(asset.manifest.correlation)) throw new Error('产物缺少匹配的 Run 关联');
  }
  return { schemaVersion: 1, projectId: 'hrm', generatedAt: new Date().toISOString(), authority: 'repository-projection', runs, assets };
}

/** 限定本地文本大小；目录、设备和大附件不直接送入浏览器。 */
function readBoundedFile(path: string): string {
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 8 * 1024 * 1024) throw new Error('产物不是受支持的文本文件');
  return readFileSync(path, 'utf8');
}

/** 读取仅限清单登记文件，下载前验证内容散列；不支持任意文件路径参数。 */
export function readCatalogFile(directory: string, asset: CatalogAsset, name: string): string {
  if (!Object.hasOwn(asset.manifest.files, name)) throw new Error('文件未在清单登记');
  const root = validateHrmRepository(directory);
  const content = readBoundedFile(safeAssetPath(root, `${asset.path.slice(0, -'manifest.json'.length)}${name}`));
  if (assetHash(content) !== asset.manifest.files[name]) throw new Error('产物完整性校验失败');
  return content;
}
