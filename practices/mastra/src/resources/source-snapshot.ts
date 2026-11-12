/** 业务资料快照：冻结产品角色可读来源的字节，恢复不再读取可变工作树。 */
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import { bytesHash, resourceHash, ResourceError } from './contracts.js';
import type { PracticeConfig } from '../mastra/config.js';
import { recruitmentSourcePath } from '../mastra/project-workspaces.js';

export interface SourceSnapshot { version: 'source-snapshot.v1'; root: string; files: Record<string, { hash: string; bytes: number }>; hash: string }

/** 返回 Run 专属快照目录；调用方只能把它作为只读Workspace根目录使用。 */
export function sourceSnapshotDirectory(config: PracticeConfig, runId: string): string {
  return resolve(dirname(config.databaseUrl.replace(/^file:/, '')), 'resource-snapshots', runId);
}

/** 返回快照内的资料根，避免来源中的manifest.json与快照清单发生同名冲突。 */
export function sourceSnapshotContentDirectory(config: PracticeConfig, runId: string): string {
  return resolve(sourceSnapshotDirectory(config, runId), 'files');
}

/** 返回当前新 Run 的允许资料根；未绑定HRM时仍冻结实践自带的示例资料。 */
function sourceDirectory(config: PracticeConfig): string {
  return config.hrmRepositoryRoot ? resolve(config.hrmRepositoryRoot, 'product/sources') : resolve(config.rootDir, recruitmentSourcePath);
}

/** 递归读取普通资料文件，并拒绝所有链接、隐藏路径及目录外内容。 */
function collectFiles(root: string): SourceSnapshot['files'] {
  const files: SourceSnapshot['files'] = {};
  /** 目录名称按稳定顺序遍历，保证相同资料产生相同快照。 */
  function walk(current: string) {
    const stat = lstatSync(current);
    if (stat.isSymbolicLink()) throw new ResourceError('SOURCE_INTEGRITY');
    if (stat.isDirectory()) {
      for (const name of readdirSync(current).sort()) if (!name.startsWith('.')) walk(resolve(current, name));
      return;
    }
    if (!stat.isFile()) throw new ResourceError('SOURCE_INTEGRITY');
    const path = relative(root, current);
    if (!path || path.startsWith('..') || path.split('/').includes('..')) throw new ResourceError('SOURCE_INTEGRITY');
    const content = readFileSync(current);
    files[path] = { hash: bytesHash(content), bytes: content.byteLength };
  }
  if (existsSync(root)) walk(root);
  return files;
}

/** 复制固定业务资料目录并写入不可变清单；不读取隐藏文件、密钥或运行数据库。 */
export function captureSourceSnapshot(config: PracticeConfig, runId: string): SourceSnapshot {
  const target = sourceSnapshotDirectory(config, runId);
  const manifestPath = resolve(target, 'manifest.json');
  if (existsSync(manifestPath)) return JSON.parse(readFileSync(manifestPath, 'utf8')) as SourceSnapshot;
  const sourceRoot = sourceDirectory(config);
  const files = collectFiles(sourceRoot);
  const snapshot: SourceSnapshot = { version: 'source-snapshot.v1', root: config.hrmRepositoryRoot ? 'product/sources' : recruitmentSourcePath, files, hash: resourceHash(files) };
  mkdirSync(target, { recursive: true, mode: 0o700 });
  writeFileSync(manifestPath, JSON.stringify(snapshot), { flag: 'wx', mode: 0o600 });
  for (const path of Object.keys(files)) {
    const output = resolve(sourceSnapshotContentDirectory(config, runId), path);
    mkdirSync(dirname(output), { recursive: true, mode: 0o700 });
    writeFileSync(output, readFileSync(resolve(sourceRoot, path)), { flag: 'wx', mode: 0o600 });
  }
  return snapshot;
}

/** 恢复前校验清单、文件集合和每个字节摘要；绝不回读可变来源目录。 */
export function verifySourceSnapshot(config: PracticeConfig, runId: string, expectedHash: string): SourceSnapshot {
  const target = sourceSnapshotDirectory(config, runId);
  if (!existsSync(resolve(target, 'manifest.json'))) throw new ResourceError('SOURCE_INTEGRITY');
  const actual = JSON.parse(readFileSync(resolve(target, 'manifest.json'), 'utf8')) as SourceSnapshot;
  if (actual.version !== 'source-snapshot.v1' || actual.hash !== expectedHash || resourceHash(actual.files) !== expectedHash) throw new ResourceError('SOURCE_INTEGRITY');
  const copied = collectFiles(sourceSnapshotContentDirectory(config, runId));
  if (resourceHash(copied) !== resourceHash(actual.files)) throw new ResourceError('SOURCE_INTEGRITY');
  return actual;
}
