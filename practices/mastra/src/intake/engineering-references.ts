/** 固定已授权仓库的只读工程证据；不执行仓库脚本或接收客户端路径。 */
import { execFileSync } from 'node:child_process';
import { constants, openSync, closeSync, readFileSync, lstatSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { validateHrmRepository } from '../delivery/asset-files.js';
/** 当前候选源码保持冻结，仅补仓库规则要求的文档及脱敏Git观察。 */
export function readEngineeringReferences(root?: string) {
  if (!root) return { files: {}, note: '未配置工程参考仓库，合成验证不代表真实资料已补齐。' };
  const directory = validateHrmRepository(root);
  /** 参数均为宿主常量，不读取.env或任意Git内容。 */
  function git(args: string[]) { return execFileSync('git', ['-C', directory, ...args], { encoding: 'utf8', maxBuffer: 1048576 }).trimEnd(); }
  const paths = git(['ls-files', '-z', '--', 'docs']).split('\0').filter(/** 只读文档allowlist，其他资料不进入候选。 */path => path === 'docs/delivery-assets.md' || /^docs\/decisions\/[a-zA-Z0-9_-]+\.md$/.test(path)).filter(/** 凭据类名称不进入参考材料。 */path => !/secret|credential|private[-_]?key/i.test(path));
  if (paths.length > 40) throw new Error('工程参考文档超过当前只读资料预算，需要开发侧筛选');
  const files: Record<string, string> = {}; let totalBytes = 0;
  for (const path of paths) {
    const full = join(directory, path); let cursor = directory;
    for (const part of path.split('/')) { cursor = join(cursor, part); if (lstatSync(cursor).isSymbolicLink()) throw new Error('工程资料不能包含符号链接'); }
    if (realpathSync(full) !== full || lstatSync(full).size > 100000 || (totalBytes += lstatSync(full).size) > 500000) throw new Error('工程资料超出读取边界');
    const fd = openSync(full, constants.O_RDONLY | constants.O_NOFOLLOW); try { files[path] = readFileSync(fd, 'utf8'); } finally { closeSync(fd); }
  }
  const observedAt = new Date().toISOString();
  const status = git(['status', '--porcelain=v1', '--untracked-files=normal', '--', 'apps', 'packages', 'scripts', 'docs', 'package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml']);
  const metadata = { authority: 'host-readonly-observation', observedAt, branch: git(['branch', '--show-current']), revision: git(['rev-parse', 'HEAD']), sourceStatus: status.split('\n').filter(/** 不把敏感文件名或不合法路径交给模型。 */line => /^[ MADRCU?!]{2} [a-zA-Z0-9_./-]+$/.test(line) && !/env|secret|credential|private[-_]?key/i.test(line)), statusIsFiltered: true, note: '仅观察固定Git状态，不执行git命令工具；候选源码仍以已授权快照为准，未自动同步宿主改动。' };
  files['engineering/repository-observation.json'] = JSON.stringify(metadata, null, 2);
  return { files, note: `已由宿主只读核对Git状态及${paths.length}份工程文档；代码版本${metadata.revision.slice(0, 12)}，观察时间${observedAt}。` };
}
