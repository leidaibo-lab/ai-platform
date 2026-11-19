/** HRM CIP 项目的固定版本装配与源码权限。 */
import { execFileSync } from 'node:child_process';
import { z } from 'zod';

export const cipProfile = 'hrm-cip-docker-v1' as const;
export const engineeringRevisionSchema = z.string().regex(/^[a-f0-9]{40}$/);
export const cipRoots = ['apps/api/src', 'apps/api/prisma', 'apps/web/app', 'apps/web/features', 'packages/shared/src'];
export const cipChecks = ['project:check', 'project:build', 'project:smoke'];
const modelPaths = [
  'AGENTS.md', 'package.json', 'apps/api/AGENTS.md', 'apps/web/AGENTS.md', 'apps/api/package.json', 'apps/web/package.json',
  'docs/index.md', 'docs/conventions/architecture.md', 'docs/conventions/authorization.md', 'docs/conventions/database.md',
  'docs/conventions/frontend.md', 'docs/conventions/contracts.md', 'docs/reference/verification.md',
  'apps/api/src/app.module.ts', 'apps/api/prisma/schema.prisma', 'apps/api/prisma/seed.ts',
  'apps/api/src/modules/iam/domain/permission-point.repository.ts', 'apps/api/src/modules/iam/application/permission.service.ts',
  'apps/api/src/modules/model-providers/model-providers.module.ts',
  'packages/shared/src/index.ts', 'packages/shared/src/permissions/index.ts', 'packages/shared/src/permissions/define.ts',
  'packages/shared/src/navigation/nodes.ts', 'packages/shared/src/navigation/index.ts', 'apps/web/app/(workspace)/layout.tsx',
];

/** 模型只能写业务源码和原生契约，平台设施及已有检查保持只读。 */
export function cipWritable(path: string) {
  return cipRoots.some(root => path.startsWith(`${root}/`)) &&
    !/\/(?:platform|pipeline|config|testing|generated|__snapshots__)\//.test(path) &&
    (!/(?:\/__tests__\/|\.(?:test|spec)\.)/.test(path) || /^apps\/(?:api\/src\/modules|web\/features)\/recruitment\//.test(path)) &&
    /\.(?:tsx?|prisma|sql)$/.test(path);
}

/** Git 操作仅访问宿主批准的仓库与普通提交。 */
export function cipGit(root: string, args: string[], maxBuffer = 1024 * 1024) {
  return execFileSync('git', ['--no-replace-objects', '-C', root, ...args], { encoding: 'utf8', timeout: 15000, maxBuffer, stdio: ['ignore', 'pipe', 'pipe'] });
}

/** 用提交中的工作区配置识别 CIP，旧 HRM 保留原执行档。 */
export function isCipRevision(root: string, revision: string) {
  engineeringRevisionSchema.parse(revision);
  try {
    const read = (path: string) => JSON.parse(cipGit(root, ['show', `${revision}:${path}`]));
    return read('package.json').packageManager === 'pnpm@12.9.1' && read('apps/api/package.json').name === '@cip/api' && read('apps/web/package.json').name === '@cip/web';
  } catch { return false; }
}

/** 从固定 Git blob 构造有限的模型候选，排除二进制、锁文件与隐藏文件。 */
export function cipModelFiles(root: string, revision: string) {
  engineeringRevisionSchema.parse(revision);
  const entries = cipGit(root, ['ls-tree', '-r', '-z', revision, '--', ...modelPaths]).split('\0');
  return Object.fromEntries(entries.flatMap(entry => {
    const match = /^100(?:644|755) blob ([a-f0-9]{40})\t([^\n]+)$/.exec(entry);
    if (!match || !modelPaths.includes(match[2]!)) return [];
    const body = cipGit(root, ['cat-file', 'blob', match[1]!], 100001);
    if (body.includes('\0') || Buffer.byteLength(body) > 100000) throw new Error('CIP 模型候选超出文件预算');
    return [[match[2]!, body]];
  }));
}
