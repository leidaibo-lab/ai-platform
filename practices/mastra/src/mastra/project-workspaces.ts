import { createHash } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Mastra } from '@mastra/core';
import { LocalFilesystem, Workspace, WORKSPACE_TOOLS } from '@mastra/core/workspace';
import type { PracticeConfig } from './config.js';
import type { Delivery } from './workflows/delivery.js';

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

/** 数据目录随原生库隔离，避免 fixture、live 和测试之间混写稿件。 */
export function artifactDirectory(config: PracticeConfig): string {
  if (config.databaseUrl === 'file::memory:') throw new Error('内存数据库没有 Workspace 产物目录');
  return resolve(dirname(fileURLToPath(config.databaseUrl)), 'workspace-artifacts');
}

/** 注册只供 Studio 使用的只读视图，不设置会被所有 Agent 继承的全局 Workspace。 */
export function registerProjectWorkspaceViews(mastra: Mastra, config: PracticeConfig): void {
  const views = [
    { id: 'recruitment-artifacts', name: '招聘实践 · 运行产物（只读副本）', directory: artifactDirectory(config) },
    { id: 'product-evaluations', name: '产品评测 · 结果与人工审阅（组织者只读）', directory: resolve(config.rootDir, '.data/evaluations') },
  ];
  for (const view of views) {
    mkdirSync(view.directory, { recursive: true });
    mastra.addWorkspace(new Workspace({
      id: view.id, name: view.name,
      filesystem: new LocalFilesystem({ basePath: view.directory, contained: true, readOnly: true }),
      tools: { enabled: false },
    }));
  }
}

/** 导出器只接收交付正文投影，不接收配置凭据、requestContext 或原始模型响应。 */
export type ProductExportInput = Pick<Delivery, 'brief' | 'mode' | 'artifacts' | 'productWork'>;

/** 文件内容使用字节 SHA-256 校验；与 Workflow 的业务版本 hash 含义不同。 */
function contentHash(content: string): string {
  return createHash('sha256').update(content).digest('hex');
}

/**
 * 导出产品草稿副本，manifest 最后写入作为完成标记；已完成副本只验证、不覆盖。
 * 未完成副本可重试修复；相同 Run/hash 的内容冲突会报错，不影响原生审批事实。
 */
export async function exportProductArtifacts(config: PracticeConfig, runId: string, state: ProductExportInput): Promise<string> {
  if (!/^[a-zA-Z0-9_-]{1,200}$/.test(runId)) throw new Error('非法 Run 标识');
  const artifact = state.artifacts.find(
    // 产品阶段唯一；不能导出后续提案来替代产品正文。
    (item) => item.stage === 'product',
  );
  if (!artifact || !/^[a-f0-9]{64}$/.test(artifact.hash)) throw new Error('找不到可导出的产品稿');
  const files: Record<string, string> = { 'brief.md': state.brief, 'product.md': artifact.content };
  for (const entry of state.productWork?.entries ?? []) files[`roles/${entry.role}.md`] = entry.content;
  const hashes: Record<string, string> = {};
  for (const [path, content] of Object.entries(files)) hashes[path] = contentHash(content);
  const manifest = JSON.stringify({
    version: 'product-workspace-export.v1', runId, productHash: artifact.hash, mode: state.mode,
    evidence: artifact.evidence, actualModel: null,
    note: '仅为可重建稿件副本；审批与运行事实以 Mastra Workflow 为准。未记录资料读取时点或实际响应模型。',
    files: hashes, productWork: state.productWork,
  }, null, 2) + '\n';
  const filesystem = new LocalFilesystem({ basePath: artifactDirectory(config), contained: true });
  const bundle = `${runId}/${artifact.hash}`;
  const manifestPath = `${bundle}/manifest.json`;
  const complete = await filesystem.exists(manifestPath);
  if (complete && String(await filesystem.readFile(manifestPath)) !== manifest) throw new Error('已有产物与本次投影不一致');
  for (const [path, content] of Object.entries(files)) {
    if (complete) {
      if (contentHash(String(await filesystem.readFile(`${bundle}/${path}`))) !== hashes[path]) throw new Error('已有产物完整性检查失败');
    } else await filesystem.writeFile(`${bundle}/${path}`, content, { recursive: true });
  }
  if (!complete) await filesystem.writeFile(manifestPath, manifest, { recursive: true });
  return bundle;
}
