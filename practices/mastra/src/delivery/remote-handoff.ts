import { promisify } from 'node:util';
/** Git Adapter：独立 index 与不可变提交隔离用户工作树；不实现另一套版本库。
 * ADR: docs/decisions/2026-11-08-mastra-remote-handoff.md
 */
import { execFile, execFileSync } from 'node:child_process';
import { randomUUID, createHash } from 'node:crypto';
import { existsSync, lstatSync, linkSync, unlinkSync, mkdirSync, readFileSync, writeFileSync, rmSync, mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { z } from 'zod';

export const remoteHandoffSchema = z.object({ version: z.literal('remote-handoff.v1'), branch: z.string().regex(/^codex\/workflow\/[a-zA-Z0-9_-]{1,200}$/), commit: z.string().regex(/^[a-f0-9]{40,64}$/), files: z.record(z.string(), z.string().regex(/^[a-f0-9]{64}$/)) });
export const repositoryRetrySchema = z.object({ repositoryRetry: z.string().regex(/^[a-f0-9]{64}$/) });
export const repositorySyncPauseSchema = z.object({ kind: z.literal('repository-sync'), mode: z.enum(['fixture', 'live']), retryKey: z.string().regex(/^[a-f0-9]{64}$/), stage: z.string(), reason: z.string() });
export type RemoteHandoff = z.infer<typeof remoteHandoffSchema>;

/** 资料读取边界只公开固定故障码，不泄露 Git 输出、路径或原文。 */
export class HandoffReadError extends Error {
  /** 故障码供生成 Adapter 分类，调用方不能用它绕过版本或散列检查。 */
  constructor(readonly code: 'HANDOFF_VERSION_UNAVAILABLE' | 'HANDOFF_HASH_MISMATCH' | 'HANDOFF_FILE_UNREGISTERED') {
    super(code === 'HANDOFF_VERSION_UNAVAILABLE' ? '交付版本不可读取' : code === 'HANDOFF_HASH_MISMATCH' ? '交付内容散列不一致' : '未登记的交付文件');
    this.name = 'HandoffReadError';
  }
}

/** 只生成内容标识，不接受任意路径作为缓存文件名。 */
export function contentHash(value: string): string { return createHash('sha256').update(value).digest('hex'); }

/** 固定参数调用 Git，关闭交互与 hook；失败不泄露命令输出或凭据。 */
function git(root: string, args: string[], input?: string, index?: string): string {
  try { return execFileSync('git', ['-C', root, '-c', 'core.hooksPath=/dev/null', ...args], { encoding: 'utf8', input, timeout: 60000, maxBuffer: 32 * 1024 * 1024, env: { ...process.env, GIT_TERMINAL_PROMPT: '0', ...(index ? { GIT_INDEX_FILE: index } : {}) }, stdio: ['pipe', 'pipe', 'pipe'] }).trim(); }
  catch { throw new Error('角色产物远端同步失败；生成检查点已保留，请恢复原失败节点重试同步'); }
}

/** 网络 Git 异步执行，远端超时期间仍可查询工作台和其他 Run。 */
async function networkGit(root: string, args: string[]): Promise<string> {
  try {
    const result = await promisify(execFile)('git', ['-C', root, '-c', 'core.hooksPath=/dev/null', ...args], { encoding: 'utf8', timeout: 60000, maxBuffer: 32 * 1024 * 1024, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } });
    return result.stdout.trim();
  } catch { throw new Error('角色产物远端同步失败；生成检查点已保留，请在工作台重试资料同步'); }
}

/** Git 私有目录保存可重试的生成结果，不将恢复缓存加入业务提交。 */
export function handoffCache(root: string): string {
  const directory = join(git(root, ['rev-parse', '--absolute-git-dir']), 'workflow-handoffs');
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  if (lstatSync(directory).isSymbolicLink() || !lstatSync(directory).isDirectory()) throw new Error('交接缓存必须是普通目录');
  return directory;
}

/** 私有检查点仅接受普通文件，拒绝符号链接。 */
export function readHandoffCache(path: string): string {
  if (lstatSync(path).isSymbolicLink() || !lstatSync(path).isFile()) throw new Error('交接缓存必须是普通文件');
  return readFileSync(path, 'utf8');
}

/** 同目录临时文件与原子硬链接发布检查点，进程中断不留下半截完成文件。 */
export function writeHandoffCache(path: string, value: string): void {
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, value, { flag: 'wx', mode: 0o600 });
    try { linkSync(temporary, path); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST' || readHandoffCache(path) !== value) throw new Error('交接缓存冲突');
    }
  } finally { if (existsSync(temporary)) unlinkSync(temporary); }
}

/** 以独立提交发布本次明确选择的资产；重试相同输入复用提交，push 后核实远端回执。 */
export async function publishHandoff(root: string, runId: string, files: Record<string, string>): Promise<RemoteHandoff> {
  if (!/^[a-zA-Z0-9_-]{1,200}$/.test(runId) || !Object.keys(files).length) throw new Error('非法远端交付');
  const hashes: Record<string, string> = {};
  for (const [path, text] of Object.entries(files)) {
    if (!/^(product|testSet|deploy)\/[a-zA-Z0-9_./-]+$/.test(path) || path.split('/').some(/** 禁止点段和隐藏路径。 */part => !part || part.startsWith('.'))) throw new Error('非法交付文件路径');
    hashes[path] = contentHash(text);
  }
  const origin = git(root, ['remote', 'get-url', '--all', 'origin']);
  if (origin.includes('\n') || git(root, ['remote', 'get-url', '--push', '--all', 'origin']) !== origin) throw new Error('远端推送地址与授权 origin 不一致');
  const branch = `codex/workflow/${runId}`;
  const cache = handoffCache(root);
  const key = contentHash(JSON.stringify({ branch, files: hashes }));
  const receiptPath = join(cache, `${key}.json`);
  let receipt: RemoteHandoff;
  if (existsSync(receiptPath)) receipt = remoteHandoffSchema.parse(JSON.parse(readHandoffCache(receiptPath)));
  else {
    const ref = `refs/heads/${branch}`;
    const remote = (await networkGit(root, ['ls-remote', '--refs', 'origin', ref])).split(/\s/)[0];
    let parent = git(root, ['rev-parse', 'HEAD']);
    if (remote) { await networkGit(root, ['fetch', '--no-tags', '--no-write-fetch-head', 'origin', ref]); parent = remote; }
    const temporary = mkdtempSync(join(tmpdir(), 'workflow-index-'));
    try {
      const index = join(temporary, 'index');
      git(root, ['read-tree', parent], undefined, index);
      for (const [path, text] of Object.entries(files)) {
        const blob = git(root, ['hash-object', '-w', '--stdin'], text);
        git(root, ['update-index', '--add', '--cacheinfo', '100644', blob, path], undefined, index);
      }
      const tree = git(root, ['write-tree'], undefined, index);
      const commit = git(root, ['-c', 'user.name=Workflow', '-c', 'user.email=workflow@local.invalid', 'commit-tree', tree, '-p', parent], 'docs(workflow): 保存角色交付资料\n');
      receipt = remoteHandoffSchema.parse({ version: 'remote-handoff.v1', branch, commit, files: hashes });
      writeHandoffCache(receiptPath, JSON.stringify(receipt));
      // 本地保留对象可达性，即使网络失败也不会被正常 GC 回收。
      git(root, ['update-ref', `refs/workflow-handoffs/${key}`, commit]);
    } finally { rmSync(temporary, { recursive: true, force: true }); }
  }
  if (receipt.branch !== branch || JSON.stringify(receipt.files) !== JSON.stringify(hashes)) throw new Error('交付回执与当前产物不一致');
  const ref = `refs/heads/${branch}`;
  const remote = (await networkGit(root, ['ls-remote', '--refs', 'origin', ref])).split(/\s/)[0];
  if (remote !== receipt.commit) {
    // 已经推进到后继提交时只验证祖先关系；拒绝强推或覆盖其他分支历史。
    let delivered = false;
    if (remote) {
      await networkGit(root, ['fetch', '--no-tags', '--no-write-fetch-head', 'origin', ref]);
      try { git(root, ['merge-base', '--is-ancestor', receipt.commit, remote]); delivered = true; } catch { /* 非祖先交给普通 push 拒绝。 */ }
    }
    if (!delivered) await networkGit(root, ['push', '--porcelain', 'origin', `${receipt.commit}:${ref}`]);
    const observed = (await networkGit(root, ['ls-remote', '--refs', 'origin', ref])).split(/\s/)[0];
    if (observed !== receipt.commit) { await networkGit(root, ['fetch', '--no-tags', '--no-write-fetch-head', 'origin', ref]); git(root, ['merge-base', '--is-ancestor', receipt.commit, observed]); }
  }
  return receipt;
}

/** 只读取回执登记的固定 commit 文件，并核对 SHA256，拒绝任意 Git 表达式。 */
export function readHandoffFile(root: string, value: RemoteHandoff, path: string): string {
  const receipt = remoteHandoffSchema.parse(value);
  if (!Object.hasOwn(receipt.files, path)) throw new HandoffReadError('HANDOFF_FILE_UNREGISTERED');
  // blob 保留原始换行；git 辅助函数只用于行式元数据。
  let content: string;
  try { content = execFileSync('git', ['-C', root, 'show', `${receipt.commit}:${path}`], { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, timeout: 10000, stdio: ['ignore', 'pipe', 'pipe'] }); }
  catch { throw new HandoffReadError('HANDOFF_VERSION_UNAVAILABLE'); }
  if (contentHash(content) !== receipt.files[path]) throw new HandoffReadError('HANDOFF_HASH_MISMATCH');
  return content;
}
