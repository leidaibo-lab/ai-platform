/** 固定业务仓库与资产路径边界；读写均拒绝符号链接。 */
import { execFileSync } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, realpathSync } from 'node:fs';
import { join, resolve } from 'node:path';

/** 校验授权仓库及普通目录；不自动 clone、提交或推送。 */
export function validateHrmRepository(directory: string): string {
  const root = resolve(directory);
  if (lstatSync(root).isSymbolicLink() || !lstatSync(root).isDirectory() || realpathSync(root) !== root) throw new Error('HRM 仓库必须是普通真实目录');
  const origin = execFileSync('git', ['-C', root, 'remote', 'get-url', 'origin'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  if (!['https://github.com/leidaibo-lab/hrm', 'https://github.com/leidaibo-lab/hrm.git', 'git@github.com:leidaibo-lab/hrm.git'].includes(origin)) throw new Error('HRM origin 与用户指定仓库不一致');
  const top = execFileSync('git', ['-C', root, 'rev-parse', '--show-toplevel'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  if (top !== root) throw new Error('业务仓库路径必须指向 Git 根目录');
  for (const name of ['product', 'product/sources', 'testSet', 'deploy']) {
    const path = join(root, name);
    if (existsSync(path) && (lstatSync(path).isSymbolicLink() || !lstatSync(path).isDirectory())) throw new Error('资产根必须为普通目录');
  }
  return root;
}

/** 逐层拒绝符号链接，投影不能越过固定业务资产根。 */
export function ensureAssetDirectory(root: string, relative: string): string {
  let path = root;
  for (const part of relative.split('/')) {
    if (!part || part === '.' || part === '..' || !/^[a-zA-Z0-9_-]+$/.test(part)) throw new Error('非法资产目录');
    path = join(path, part);
    if (!existsSync(path)) {
      try { mkdirSync(path, { mode: 0o700 }); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
    }
    if (lstatSync(path).isSymbolicLink() || !lstatSync(path).isDirectory()) throw new Error('资产目录不是普通目录');
  }
  return path;
}

/** 只解析三个交付资产根内的普通文件/目录，不允许任意仓库路径。 */
export function safeAssetPath(root: string, relative: string): string {
  const parts = relative.split('/');
  if (!['product', 'testSet', 'deploy'].includes(parts[0]) || parts.some(
    // URL、点段、隐藏文件和跨平台路径分隔符均不能进入文件读取。
    (part) => !/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,199}$/.test(part) || part === '.' || part === '..',
  )) throw new Error('非法资产路径');
  let path = root;
  for (const part of parts) {
    path = join(path, part);
    if (lstatSync(path).isSymbolicLink()) throw new Error('资产路径不能包含符号链接');
  }
  return path;
}
