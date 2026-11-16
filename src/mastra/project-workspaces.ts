import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import type { Mastra } from '@mastra/core';
import { LocalFilesystem, Workspace, WORKSPACE_TOOLS } from '@mastra/core/workspace';
import type { PracticeConfig } from './config.js';
import { validateHrmRepository } from '../delivery/repository-assets.js';

/**
 * 工厂/薄适配器：框架拥有文件访问，实践仅定义材料边界和可重建产物。
 * ADR: docs/decisions/2026-11-06-mastra-project-workspaces.md
 */
export const recruitmentSourcePath = 'projects/pm-hrm-recruitment/sources';

/** 只启用四个原生读取工具；未来框架新增工具默认仍关闭。 */
export function createRecruitmentWorkspace(rootDir: string, sourceDirectory = resolve(rootDir, recruitmentSourcePath)) {
  return new Workspace({
    id: 'recruitment-sources', name: '招聘项目 · 业务资料（只读）',
    filesystem: new LocalFilesystem({ basePath: sourceDirectory, contained: true, readOnly: true }),
    tools: {
      enabled: false,
      [WORKSPACE_TOOLS.FILESYSTEM.READ_FILE]: { enabled: true },
      [WORKSPACE_TOOLS.FILESYSTEM.LIST_FILES]: { enabled: true },
      [WORKSPACE_TOOLS.FILESYSTEM.FILE_STAT]: { enabled: true },
      [WORKSPACE_TOOLS.FILESYSTEM.GREP]: { enabled: true },
    },
  });
}

/** 注册只供 Studio 使用的只读视图，不设置会被所有 Agent 继承的全局 Workspace。 */
export function registerProjectWorkspaceViews(mastra: Mastra, config: PracticeConfig): void {
  const views = [
    { id: 'evaluation-results', name: '研发评测 · 结果（只读）', directory: resolve(config.rootDir, '.data/evaluations') },
  ];
  if (config.hrmRepositoryRoot) {
    const repository = validateHrmRepository(config.hrmRepositoryRoot);
    views.push({ id: 'hrm-run-archives', name: 'HRM · 运行档案（状态投影，不可恢复）', directory: resolve(repository, 'product/catalog/runs') });
    for (const area of ['product', 'testSet', 'deploy']) views.push({ id: `hrm-${area.toLowerCase()}`, name: `HRM · ${area}（只读交付资产）`, directory: resolve(repository, area) });
  }
  for (const view of views) {
    mkdirSync(view.directory, { recursive: true });
    mastra.addWorkspace(new Workspace({
      id: view.id, name: view.name,
      filesystem: new LocalFilesystem({ basePath: view.directory, contained: true, readOnly: true }),
      tools: { enabled: false },
    }));
  }
}
