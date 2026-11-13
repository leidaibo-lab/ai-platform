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

/** 仅宿主质量门构造的源码交付；基线和完整候选用于拒绝未经验证的合并。 */
export interface CodeHandoffInput {
  baselineCommit: string;
  baselineFiles: Record<string, string>;
  candidateFiles: Record<string, string>;
  allowedPaths: string[];
  sourceHash: string;
  qualityHash: string;
}

/** 对完整源码字节计算 Git blob 标识，保留原始换行。 */
function blobHash(root: string, text: string): string { return git(root, ['hash-object', '--stdin'], text); }

/** 解析 Git tree 的真实文件模式与对象，不从工作树或暂存区猜测。 */
function treeFiles(root: string, commit: string): Map<string, { mode: string; oid: string }> {
  const files = new Map<string, { mode: string; oid: string }>();
  for (const line of git(root, ['ls-tree', '-rz', commit]).split('\0')) {
    if (!line) continue;
    const match = /^(\d+) blob ([a-f0-9]+)\t(.+)$/.exec(line);
    if (match) files.set(match[3], { mode: match[1], oid: match[2] });
  }
  return files;
}

/** 源码路径独立于资料路径授权；隐藏目录、凭据名和 Git 路径表达式均拒绝。 */
function codePath(path: string): boolean {
  return /^[a-zA-Z0-9_./-]{1,200}$/.test(path) && !path.split('/').some(
    /** 任务声明不能把敏感文件变成普通交付。 */
    part => !part || part.startsWith('.') || /^(node_modules|dist|build|coverage|product|testSet|deploy)$/.test(part),
  ) && !/(?:secret|credential|private[-_]?key)/i.test(path);
}

/** 复用 Git 发布链写入实际源码；完整候选与质量版本进入幂等身份。 */
export async function publishCodeHandoff(root: string, runId: string, input: CodeHandoffInput): Promise<RemoteHandoff> {
  if (!/^[a-f0-9]{40,64}$/.test(input.baselineCommit) || !/^[a-f0-9]{64}$/.test(input.sourceHash) || !(/^[a-f0-9]{64}$/.test(input.qualityHash) || input.qualityHash === 'candidate'))
    throw new Error('非法源码交付版本');
  const baseline = treeFiles(root, input.baselineCommit);
  const files: Record<string, string> = {};
  const candidateHashes: Record<string, string> = {};
  for (const [path, content] of Object.entries(input.candidateFiles)) {
    if (!codePath(path)) throw new Error('非法源码交付路径');
    candidateHashes[path] = contentHash(content);
    const before = input.baselineFiles[path];
    const entry = baseline.get(path);
    if (before !== undefined && (!entry || !['100644', '100755'].includes(entry.mode) || entry.oid !== blobHash(root, before))) throw new Error('批准的项目基线与 Git 版本不一致');
    if (before === undefined && entry) throw new Error('新增源码在基线版本中已经存在');
    if (before !== content) {
      if (!input.allowedPaths.includes(path)) throw new Error('源码改动超出批准任务');
      files[path] = content;
    }
  }
  for (const path of Object.keys(input.baselineFiles)) if (!Object.hasOwn(input.candidateFiles, path)) throw new Error('源码交付不支持删除文件');
  if (!Object.keys(input.candidateFiles).length) throw new Error('源码候选为空');
  const evidencePath = `product/runs/${runId}/code/${input.sourceHash}/${input.qualityHash === 'candidate' ? 'candidate' : `quality-${input.qualityHash}`}.json`;
  files[evidencePath] = JSON.stringify({ version: 'code-publication.v2', status: input.qualityHash === 'candidate' ? 'candidate' : 'quality-attested', baselineCommit: input.baselineCommit, sourceHash: input.sourceHash, qualityHash: input.qualityHash === 'candidate' ? null : input.qualityHash, files: candidateHashes }, null, 2) + '\n';
  return publishFiles(root, runId, files, input);
}

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
  return publishFiles(root, runId, files);
}

/** 共用独立 index、缓存及普通 push；源码校验只由专用宿主入口启用。 */
async function publishFiles(root: string, runId: string, files: Record<string, string>, code?: CodeHandoffInput): Promise<RemoteHandoff> {
  if (!/^[a-zA-Z0-9_-]{1,200}$/.test(runId) || !Object.keys(files).length) throw new Error('非法远端交付');
  const hashes: Record<string, string> = {};
  for (const [path, text] of Object.entries(files)) {
    if (!(code && inputCodePath(code, path)) && (!/^(product|testSet|deploy)\/[a-zA-Z0-9_./-]+$/.test(path) || path.split('/').some(/** 禁止点段和隐藏路径。 */part => !part || part.startsWith('.')))) throw new Error('非法交付文件路径');
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
    const parentFiles = code ? treeFiles(root, parent) : undefined;
    if (code) assertCodeTree(root, parent, code);
    if (code) for (const [path, content] of Object.entries(code.candidateFiles)) {
      const entry = parentFiles!.get(path);
      const before = code.baselineFiles[path];
      if (entry && !['100644', '100755'].includes(entry.mode)) throw new Error('目标源码不是普通文件');
      if (!(entry?.oid === blobHash(root, content) || (before === undefined ? !entry : entry?.oid === blobHash(root, before)))) throw new Error('目标分支源码已漂移，拒绝覆盖');
    }
    const temporary = mkdtempSync(join(tmpdir(), 'workflow-index-'));
    try {
      const index = join(temporary, 'index');
      git(root, ['read-tree', parent], undefined, index);
      for (const [path, text] of Object.entries(files)) {
        const blob = git(root, ['hash-object', '-w', '--stdin'], text);
        git(root, ['update-index', '--add', '--cacheinfo', parentFiles?.get(path)?.mode ?? '100644', blob, path], undefined, index);
      }
      const tree = git(root, ['write-tree'], undefined, index);
      const commit = git(root, ['-c', 'user.name=Workflow', '-c', 'user.email=workflow@local.invalid', 'commit-tree', tree, '-p', parent], code ? 'feat(workflow): 提交通过独立测试的业务源码\n' : 'docs(workflow): 保存角色交付资料\n');
      receipt = remoteHandoffSchema.parse({ version: 'remote-handoff.v1', branch, commit, files: hashes });
      writeHandoffCache(receiptPath, JSON.stringify(receipt));
      // 本地保留对象可达性，即使网络失败也不会被正常 GC 回收。
      git(root, ['update-ref', `refs/workflow-handoffs/${key}`, commit]);
    } finally { rmSync(temporary, { recursive: true, force: true }); }
  }
  if (receipt.branch !== branch || JSON.stringify(receipt.files) !== JSON.stringify(hashes)) throw new Error('交付回执与当前产物不一致');
  if (code) {
    assertCodeTree(root, receipt.commit, code);
    const committed = treeFiles(root, receipt.commit);
    for (const [path, content] of Object.entries(code.candidateFiles)) if (committed.get(path)?.oid !== blobHash(root, content)) throw new Error('源码提交与完整候选不一致');
  }
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
  if (code) {
    const current = (await networkGit(root, ['ls-remote', '--refs', 'origin', ref])).split(/\s/)[0];
    await networkGit(root, ['fetch', '--no-tags', '--no-write-fetch-head', 'origin', ref]);
    assertCodeTree(root, current, code);
    const observed = treeFiles(root, current);
    for (const [path, content] of Object.entries(code.candidateFiles)) if (observed.get(path)?.oid !== blobHash(root, content)) throw new Error('远端源码与已验收候选不一致');
  }
  return receipt;
}

/** 内部发布器仅认可专用源码输入中登记的候选路径。 */
function inputCodePath(code: CodeHandoffInput, path: string): boolean { return Object.hasOwn(code.candidateFiles, path) && code.allowedPaths.includes(path) && codePath(path); }

/** 目标分支可追加资料，但未经本轮验证的工程变更不能混入源码提交。 */
function assertCodeTree(root: string, commit: string, code: CodeHandoffInput): void {
  git(root, ['merge-base', '--is-ancestor', code.baselineCommit, commit]);
  const baseline = treeFiles(root, code.baselineCommit);
  const current = treeFiles(root, commit);
  for (const path of Object.keys(code.candidateFiles)) if (current.has(path) && current.get(path)!.mode !== (baseline.get(path)?.mode ?? '100644')) throw new Error('目标分支源码文件模式漂移');
  const changed = git(root, ['diff-tree', '--no-commit-id', '--name-only', '-r', '-z', code.baselineCommit, commit]);
  for (const path of changed.split('\0')) if (path && !/^(product|testSet|deploy)\//.test(path) && !Object.hasOwn(code.candidateFiles, path)) throw new Error('目标分支包含未经本轮验证的工程改动');
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
