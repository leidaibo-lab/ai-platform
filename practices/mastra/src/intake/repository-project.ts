/** 从已授权仓库派生只读基线和项目权限上界，技术路径与实际团队由架构Agent决定。 */
import { constants, openSync, readFileSync, closeSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { readRepositoryCatalog } from './repository-catalog.js';
import { projectSchema, developmentHash } from '../development/contracts.js';
export const hrmWritableRoots = ['apps/web/app', 'apps/api/src', 'packages/database/src', 'packages/database/prisma'];
/** 仅从固定仓库和当前匹配清单读取，前端不能提供源码或宿主绝对路径。 */
export function assembleRepositoryProject(root: string | undefined, expected: string) {
  const catalog = readRepositoryCatalog(root);
  if (!root || !catalog.available || catalog.catalogHash !== expected) throw new Error('仓库版本已变化，请刷新后重新确认');
  if (!catalog.executionReady) throw new Error(catalog.executionReason);
  const files: Record<string, string> = {};
  if (catalog.files.length > 200) throw new Error('仓库超过当前候选文件预算，请先拆分项目');
  for (const file of catalog.files) {
    const full = join(root, file.path);
    if (realpathSync(full) !== full) throw new Error('仓库包含符号链接');
    const fd = openSync(full, constants.O_RDONLY | constants.O_NOFOLLOW);
    try { const text = readFileSync(fd, 'utf8'); if (developmentHash(text) !== file.hash) throw new Error('源码在确认期间发生变化'); files[file.path] = text; }
    finally { closeSync(fd); }
  }
  for (const name of ['pnpm-lock.yaml', 'pnpm-workspace.yaml', 'package.json', 'apps/web/package.json', 'apps/api/package.json', 'packages/database/package.json', 'scripts/smoke.mjs']) if (!(name in files)) throw new Error('HRM检查配置不完整');
  const writablePaths = Object.keys(files).filter(/** 只授权源码根；检查脚本、依赖与包管理配置保持只读。 */path => hrmWritableRoots.some(/** 根目录是宿主固定策略，不来自用户字符串或模型。 */root => path.startsWith(`${root}/`)));
  return projectSchema.parse({ id: 'hrm', files, writablePaths, checkFiles: Object.keys(files).filter(/** 非源码基线全部受保护，避免候选降低检查要求。 */path => !writablePaths.includes(path)), roles: ['frontend', 'backend', 'infrastructure'], executionProfile: 'hrm-pnpm-docker-v1', planning: 'agent', writableRoots: hrmWritableRoots });
}
