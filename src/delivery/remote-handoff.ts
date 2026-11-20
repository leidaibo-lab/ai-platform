import { promisify } from 'node:util';
/** Git Adapter：独立 index 与不可变提交隔离用户工作树；不实现另一套版本库。
 * ADR: docs/decisions/2026-11-08-mastra-remote-handoff.md
 */
import { execFile, execFileSync } from 'node:child_process';
import { randomUUID, createHash } from 'node:crypto';
import { existsSync, lstatSync, linkSync, unlinkSync, mkdirSync, readFileSync, writeFileSync, renameSync, rmSync, mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { z } from 'zod';
import { assetIdSchema, formalSpecificationPathPattern } from './asset-identity.js';

const uuidSchema = '[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}';
const mainRef = 'refs/heads/main';
export const remoteHandoffSchema = z.object({ version: z.literal('remote-handoff.v1'), branch: z.string().regex(new RegExp(`^(?:codex/workflow/[a-zA-Z0-9_-]{1,200}|run/[a-z0-9-]{2,48}-${uuidSchema})$`)), commit: z.string().regex(/^[a-f0-9]{40,64}$/), files: z.record(z.string(), z.string().regex(/^[a-f0-9]{64}$/)) });
export const repositoryRetrySchema = z.object({ repositoryRetry: z.string().regex(/^[a-f0-9]{64}$/) });
export const repositorySyncPauseSchema = z.object({ kind: z.literal('repository-sync'), mode: z.enum(['fixture', 'live']), retryKey: z.string().regex(/^[a-f0-9]{64}$/), stage: z.string(), reason: z.string() });
export type RemoteHandoff = z.infer<typeof remoteHandoffSchema>;

/** 正式 Spec 的版本绑定属于 Workflow 状态；Git 只保存不可变制品，不能反向充当审批事实。 */
export const formalSpecificationReceiptSchema = z.object({
  kind: z.enum(['requirements', 'product', 'development', 'testing']),
  handoff: remoteHandoffSchema,
  paths: z.array(z.string().regex(formalSpecificationPathPattern)).min(1).max(4),
  upstreamCommits: z.array(z.string().regex(/^[a-f0-9]{40,64}$/)).max(3),
});
export type FormalSpecificationReceipt = z.infer<typeof formalSpecificationReceiptSchema>;

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

/** 仅从已保存的 Run 标识生成可读分支片段，拒绝让客户端传入 Git ref。 */
export function runCapabilitySlug(value: string): string {
  const slug = value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48);
  return slug.length >= 2 ? slug : 'feature';
}

/** Run 分支同时保留主要能力与不可变 Run 身份，所有正式规格追加到此分支。 */
export function formalRunBranch(capability: string, runId: string): string {
  if (!new RegExp(`^${uuidSchema}$`).test(runId)) throw new Error('正式规格交接要求 UUID Run 标识');
  return `run/${runCapabilitySlug(capability)}-${runId}`;
}

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

/** 原子写入检查点，远端主分支推进后允许替换尚未发布的旧提交。 */
export function writeHandoffCache(path: string, value: string, replace = false): void {
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, value, { flag: 'wx', mode: 0o600 });
    if (replace) { renameSync(temporary, path); return; }
    try { linkSync(temporary, path); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST' || readHandoffCache(path) !== value) throw new Error('交接缓存冲突');
    }
  } finally { if (existsSync(temporary)) unlinkSync(temporary); }
}

/** 以独立提交发布本次明确选择的资产；重试相同输入复用提交，push 后核实远端回执。 */
export async function publishHandoff(root: string, runId: string, files: Record<string, string>, options: { branch?: string; message?: string; baseCommit?: string } = {}): Promise<RemoteHandoff> {
  if (!/^[a-zA-Z0-9_-]{1,200}$/.test(runId) || !Object.keys(files).length) throw new Error('非法远端交付');
  const hashes: Record<string, string> = {};
  for (const [path, text] of Object.entries(files)) {
    if (!/^(product|testSet|deploy|specs)\/[a-zA-Z0-9_./-]+$/.test(path) || path.split('/').some(/** 禁止点段和隐藏路径。 */part => !part || part.startsWith('.'))) throw new Error('非法交付文件路径');
    hashes[path] = contentHash(text);
  }
  const origin = git(root, ['remote', 'get-url', '--all', 'origin']);
  if (origin.includes('\n') || git(root, ['remote', 'get-url', '--push', '--all', 'origin']) !== origin) throw new Error('远端推送地址与授权 origin 不一致');
  const branch = options.branch ?? `codex/workflow/${runId}`;
  remoteHandoffSchema.shape.branch.parse(branch);
  const cache = handoffCache(root);
  const message = options.message ?? 'docs(workflow): 保存角色交付资料\n';
  const baseCommit = options.baseCommit && z.string().regex(/^[a-f0-9]{40}$/).parse(options.baseCommit);
  const key = contentHash(JSON.stringify({ branch, files: hashes, message, baseCommit }));
  const receiptPath = join(cache, `${key}.json`);
  const ref = `refs/heads/${branch}`;
  const branchHead = (await networkGit(root, ['ls-remote', '--refs', 'origin', ref])).split(/\s/)[0];
  let mainHead: string | undefined;
  if (!branchHead) {
    mainHead = (await networkGit(root, ['ls-remote', '--refs', 'origin', mainRef])).split(/\s/)[0];
    if (!mainHead) throw new Error('远端 origin 缺少 main，无法创建交付分支');
    await networkGit(root, ['fetch', '--no-tags', '--no-write-fetch-head', '--refmap=', 'origin', mainHead]);
    if (baseCommit && baseCommit !== mainHead) throw new Error('Run 绑定的工程版本与远端 origin/main 不一致，无法创建交付分支');
  }
  const cached = existsSync(receiptPath) ? remoteHandoffSchema.parse(JSON.parse(readHandoffCache(receiptPath))) : undefined;
  let receipt = cached;
  if (!receipt || (mainHead && git(root, ['show', '-s', '--format=%P', receipt.commit]) !== mainHead)) {
    const parent = mainHead ?? branchHead;
    if (branchHead) await networkGit(root, ['fetch', '--no-tags', '--no-write-fetch-head', 'origin', ref]);
    const temporary = mkdtempSync(join(tmpdir(), 'workflow-index-'));
    try {
      const index = join(temporary, 'index');
      git(root, ['read-tree', parent], undefined, index);
      for (const [path, text] of Object.entries(files)) {
        const blob = git(root, ['hash-object', '-w', '--stdin'], text);
        git(root, ['update-index', '--add', '--cacheinfo', '100644', blob, path], undefined, index);
      }
      const tree = git(root, ['write-tree'], undefined, index);
      const commit = git(root, ['-c', 'user.name=Workflow', '-c', 'user.email=workflow@local.invalid', 'commit-tree', tree, '-p', parent], message);
      receipt = remoteHandoffSchema.parse({ version: 'remote-handoff.v1', branch, commit, files: hashes });
      // 本地保留对象可达性，即使网络失败也不会被正常 GC 回收。
      git(root, ['update-ref', `refs/workflow-handoffs/${key}`, commit]);
      writeHandoffCache(receiptPath, JSON.stringify(receipt), Boolean(cached));
    } finally { rmSync(temporary, { recursive: true, force: true }); }
  }
  if (receipt.branch !== branch || JSON.stringify(receipt.files) !== JSON.stringify(hashes)) throw new Error('交付回执与当前产物不一致');
  const remote = (await networkGit(root, ['ls-remote', '--refs', 'origin', ref])).split(/\s/)[0];
  if (remote !== receipt.commit) {
    let delivered = false;
    if (remote) {
      await networkGit(root, ['fetch', '--no-tags', '--no-write-fetch-head', 'origin', ref]);
      try { git(root, ['merge-base', '--is-ancestor', receipt.commit, remote]); delivered = true; } catch { /* 待推送的提交必须是快进。 */ }
    }
    if (!delivered) {
      if (mainHead) {
        await networkGit(root, ['push', '--porcelain', `--force-with-lease=${ref}:`, 'origin', `${receipt.commit}:${ref}`]);
      } else {
        if (!remote) throw new Error('交付分支已被删除，请重试资料同步');
        git(root, ['merge-base', '--is-ancestor', remote, receipt.commit]);
        await networkGit(root, ['push', '--porcelain', `--force-with-lease=${ref}:${remote}`, 'origin', `${receipt.commit}:${ref}`]);
      }
    }
    const observed = (await networkGit(root, ['ls-remote', '--refs', 'origin', ref])).split(/\s/)[0];
    if (observed !== receipt.commit) { await networkGit(root, ['fetch', '--no-tags', '--no-write-fetch-head', 'origin', ref]); git(root, ['merge-base', '--is-ancestor', receipt.commit, observed]); }
  }
  return receipt;
}

/** 从测试规格提交构建已放行候选。只更新同一 Run 分支，重试核对远端树。 */
export async function publishReviewedCandidate(root: string, specification: RemoteHandoff, candidate: Record<string, string>, writable: readonly string[], specPaths: readonly string[], baseline?: string) {
  const { branch, commit: parent } = remoteHandoffSchema.parse(specification);
  if (!branch.startsWith('run/')) throw new Error('交付要求正式 Run 分支');
  const origin = git(root, ['remote', 'get-url', '--all', 'origin']);
  if (origin.includes('\n') || git(root, ['remote', 'get-url', '--push', '--all', 'origin']) !== origin) throw new Error('交付远端地址不一致');
  const ref = `refs/heads/${branch}`;
  await networkGit(root, ['fetch', '--no-tags', 'origin', mainRef, ref]);
  const refs = await networkGit(root, ['ls-remote', '--refs', 'origin', mainRef, ref]);
  const heads = new Map(refs.split('\n').map(/** 按完整 ref 读取远端提交。 */line => { const [sha, name] = line.split('\t'); return [name, sha] as const; }));
  const mainCommit = heads.get(mainRef);
  const remote = heads.get(ref);
  if (!mainCommit || !remote) throw new Error('交付分支或 main 不存在');
  const mergeBase = git(root, ['merge-base', mainCommit, parent]);
  if (baseline && mergeBase !== baseline) throw new Error('候选工程基线与交付分支不一致');
  const allowed = new Set([...writable.filter(path => Object.hasOwn(candidate, path)), ...specPaths]);
  const temporary = mkdtempSync(join(tmpdir(), 'workflow-mr-index-'));
  try {
    const index = join(temporary, 'index');
    git(root, ['read-tree', parent], undefined, index);
    for (const [path, body] of Object.entries(candidate)) {
      if (!/^[a-zA-Z0-9_./()\[\]-]+$/.test(path) || path.split('/').some(part => !part || part.startsWith('.'))) throw new Error('候选文件路径无效');
      const entry = git(root, ['ls-tree', parent, '--', `:(literal)${path}`]);
      const match = /^(100644|100755) blob ([a-f0-9]+)\t/.exec(entry);
      if (entry && !match) throw new Error('交付候选必须为普通文件');
      const blob = git(root, ['hash-object', '-w', '--stdin'], body);
      if (match?.[2] === blob) continue;
      if (!writable.includes(path) || specPaths.includes(path)) throw new Error('候选与 Git 基线的受保护文件不一致');
      git(root, ['update-index', '--add', '--cacheinfo', match?.[1] ?? '100644', blob, path], undefined, index);
    }
    const tree = git(root, ['write-tree'], undefined, index);
    const changed = git(root, ['diff', '--name-only', '--no-renames', '-z', mergeBase, tree]).split('\0').filter(Boolean);
    if (!changed.length || changed.some(path => !allowed.has(path))) throw new Error('交付差异超出该 Run 的授权范围');
    if (remote !== parent) {
      if (git(root, ['rev-list', '--parents', '-n', '1', remote]) !== `${remote} ${parent}` || git(root, ['rev-parse', `${remote}^{tree}`]) !== tree) throw new Error('交付分支已发生漂移');
      return remote;
    }
    if (tree === git(root, ['rev-parse', `${parent}^{tree}`])) return parent;
    const commit = git(root, ['-c', 'user.name=Workflow', '-c', 'user.email=workflow@local.invalid', 'commit-tree', tree, '-p', parent], 'feat(delivery): 提交通过 QA 的候选源码\n');
    await networkGit(root, ['push', '--porcelain', '--no-follow-tags', '--recurse-submodules=no', `--force-with-lease=${ref}:${parent}`, 'origin', `${commit}:${ref}`]);
    if ((await networkGit(root, ['ls-remote', '--refs', 'origin', ref])).split(/\s/)[0] !== commit) throw new Error('交付分支已发生漂移');
    return commit;
  } finally { rmSync(temporary, { recursive: true, force: true }); }
}

/** 人工确认后发布正式规格；能力和提交标题均由宿主固定，不接受页面传值。 */
export async function publishFormalSpecification(root: string, runId: string, capability: string, files: Record<string, string>, message: string, baseCommit?: string): Promise<RemoteHandoff> {
  const iteration = assetIdSchema.parse(capability);
  if (!Object.keys(files).every(/** 产品路径必须与宿主登记的迭代标识匹配。 */path => formalSpecificationPathPattern.test(path) && (path.startsWith('specs/') || path.startsWith(`product/${iteration}/`)))) throw new Error('正式规格只能写入当前需求的受控路径');
  return publishHandoff(root, runId, files, { branch: formalRunBranch(capability, runId), message: `${message}\n`, baseCommit });
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
