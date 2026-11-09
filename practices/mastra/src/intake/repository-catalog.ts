/** 已授权 HRM 仓库的只读目录；不接收浏览器文件路径作为宿主根目录。 */
import { execFileSync } from 'node:child_process';
import { lstatSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { validateHrmRepository } from '../delivery/asset-files.js';
import { developmentHash } from '../development/contracts.js';
const areas = [{ id: 'apps/web', title: '前端页面', role: 'frontend' }, { id: 'apps/api', title: '后端接口', role: 'backend' }, { id: 'packages/database', title: '数据库结构', role: 'infrastructure' }, { id: 'scripts', title: '工程脚本', role: 'infrastructure' }];
/** 只列普通源码文件，排除隐藏配置、凭据、依赖、产物与业务资料。 */
export function readRepositoryCatalog(directory?: string) {
  if (!directory) return { available: false as const, reason: '尚未关联开发仓库，请先配置项目仓库。' };
  const root = validateHrmRepository(directory);
  /** Git 仅提供版本元数据和文件名；不执行仓库脚本。 */
  function git(args: string[]) { return execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', maxBuffer: 1048576 }).trim(); }
  const branch = git(['branch', '--show-current']) || '当前提交';
  const revision = git(['rev-parse', 'HEAD']);
  const listed = git(['ls-files', '-z', '--cached', '--others', '--exclude-standard', '--', 'apps', 'packages', 'scripts', 'package.json', 'pnpm-workspace.yaml', 'pnpm-lock.yaml', 'README.md', 'AGENTS.md']);
  const files: { path: string; area: string; bytes: number; hash: string }[] = [];
  for (const path of new Set(listed.split('\0').filter(Boolean))) {
    const parts = path.split('/');
    if (!/^[a-zA-Z0-9_./-]+$/.test(path) || parts.some(/** 凭据与生成目录绝不进入清单或文件读取。 */part => part.startsWith('.') || /^(node_modules|dist|build|coverage|product|testSet|deploy)$/.test(part)) || /(?:secret|credential|private[-_]?key)/i.test(path) || !/\.(ts|tsx|js|jsx|mjs|json|css|md|yaml|yml|prisma|sql)$/.test(path)) continue;
    let current = root; let safe = true;
    for (const part of parts) { current = join(current, part); try { if (lstatSync(current).isSymbolicLink()) safe = false; } catch { safe = false; } if (!safe) break; }
    if (!safe) continue;
    const stat = lstatSync(current); if (!stat.isFile() || stat.size > 100000 || files.length >= 1500) continue;
    const content = readFileSync(current, 'utf8');
    files.push({ path, area: areas.find(/** 按实际目录关联业务模块。 */area => path.startsWith(`${area.id}/`))?.id ?? 'shared', bytes: stat.size, hash: developmentHash(content) });
  }
  files.sort(/** 稳定顺序用于版本绑定与查找。 */(a, b) => a.path.localeCompare(b.path));
  const manifestFile = files.find(/** 只有经过上面安全检查的普通package.json才读取。 */file => file.path === 'package.json');
  const manifest = manifestFile ? JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) : {};
  const checks = ['check', 'build', 'smoke'].filter(/** 只展示仓库真实登记的检查，不创造命令。 */key => typeof manifest.scripts?.[key] === 'string').map(/** 识别命令不等于已获准在隔离环境执行。 */key => ({ id: key, title: ({ check: '代码与类型检查', build: '应用构建验证', smoke: '页面、接口和数据库连通检查' } as Record<string, string>)[key], command: `pnpm ${key}`, ready: true, reason: '使用独立 Docker 候选及临时数据库执行' }));
  const catalog = { id: 'hrm', title: 'HRM 人资管理系统', branch, revision, modules: [...areas, { id: 'shared', title: '公共配置与说明', role: 'infrastructure' }].map(/** 模块数量由本次真实文件清单计算。 */area => ({ ...area, count: files.filter(/** 不把其他模块文件计入当前模块。 */file => file.area === area.id).length })), files, checks };
  let dockerReady = false;
  try { execFileSync('docker', ['--context', 'desktop-linux', 'info', '--format', '{{.ServerVersion}}'], { stdio: 'ignore', timeout: 3000 }); dockerReady = true; } catch { /* 没有隔离后端时不回退到宿主执行。 */ }
  const missingFiles = ['package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml', 'apps/web/package.json', 'apps/api/package.json', 'packages/database/package.json', 'scripts/smoke.mjs'].filter(/** 仅安全清单内的普通文件算作执行配置存在。 */path => !files.some(/** 复用已读取清单，避免绕过链接及大小检查。 */file => file.path === path));
  const preparationIssues = missingFiles.map(/** 逐项说明真实工程缺口，不把未建项目误报为版本错误。 */path => `缺少可读取的工程文件：${path}`);
  if (manifestFile && manifest.packageManager !== 'pnpm@10.6.0') preparationIssues.push('package.json 需要声明 packageManager 为 pnpm@10.6.0');
  if (manifestFile) for (const key of ['check', 'build', 'smoke']) if (typeof manifest.scripts?.[key] !== 'string' || !manifest.scripts[key].trim()) preparationIssues.push(`package.json 缺少固定检查脚本：${key}`);
  if (!dockerReady) preparationIssues.push('Docker Desktop 尚未就绪，请启动后重新检查');
  const executionReady = preparationIssues.length === 0;
  return { available: true as const, ...catalog, catalogHash: developmentHash(catalog), executionReady, preparationIssues, executionReason: executionReady ? '已接入独立 Docker 验证：类型检查、构建和临时页面/API/数据库连通检查。' : '可以先交给开发团队生成方案。以下工程准备项完成并重新确认项目后，才能批准实施。' };
}
