/** 为非执行阶段构建只读的 Run 快照 Workspace，禁止回退到未跟踪文件直读。 */
import { randomUUID } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { LocalFilesystem, Workspace, WORKSPACE_TOOLS, createWorkspaceTools } from '@mastra/core/workspace';

/** 快照只接受规范相对路径和文本文件，避免绝对路径、隐藏文件与 traversal。 */
function validateSnapshot(files: Record<string, string>) {
  const entries = Object.entries(files);
  if (!entries.length || entries.length > 300) throw new Error('阶段 Workspace 材料数量不合法');
  for (const [path, content] of entries) {
    if (!path || path.startsWith('/') || path.includes('\\') || path.split('/').some(part => !part || part === '..' || part.startsWith('.')) || Buffer.byteLength(content) > 262144) throw new Error('阶段 Workspace 材料路径或大小不合法');
  }
  return entries;
}

/** 复制兼容项目已授权的业务资料，拒绝链接和隐藏路径。 */
export function readAuthorizedProductSources(repositoryRoot?: string): Record<string, string> {
  if (!repositoryRoot) return {};
  const root = resolve(repositoryRoot, 'product/sources');
  if (!existsSync(root)) return {};
  const files: Record<string, string> = {};
  /** 只枚举授权根内的普通文件，限制材料总数和单文件大小。 */
  function visit(path: string, relative: string) {
    const stat = lstatSync(path);
    if (stat.isSymbolicLink()) throw new Error('产品资料不能包含符号链接');
    if (stat.isDirectory()) {
      for (const entry of readdirSync(path)) {
        if (entry.startsWith('.')) continue;
        visit(resolve(path, entry), relative ? `${relative}/${entry}` : entry);
      }
    } else if (stat.isFile()) {
      if (stat.size > 262144 || Object.keys(files).length >= 298) throw new Error('产品资料超过 Workspace 限制');
      files[`sources/${relative}`] = readFileSync(path, 'utf8');
    } else throw new Error('产品资料包含不支持的文件类型');
  }
  visit(root, '');
  return files;
}

/** 只将返回文本的原生读取结果视为成功读取。 */
export function hasWorkspaceRead(results: unknown, path: string): boolean {
  return Array.isArray(results) && results.some(item => item?.payload?.toolName === 'mastra_workspace_read_file' && item.payload.args?.path === path && typeof item.payload.result === 'string' && !item.payload.result.startsWith('Error:'));
}

/** 将宿主已授权快照复制到独占只读目录并返回原生 Workspace 读取工具。 */
export async function createStageWorkspace(id: string, name: string, files: Record<string, string>) {
  const entries = validateSnapshot(files);
  const root = mkdtempSync(resolve(tmpdir(), `mastra-${id.replace(/[^a-z0-9-]/gi, '-')}-`));
  let workspace: Workspace | undefined;
  try {
  for (const [path, content] of entries) {
    const target = resolve(root, path);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, content, { flag: 'wx', mode: 0o400 });
  }
  workspace = new Workspace({
    id: `${id}-${randomUUID()}`, name,
    filesystem: new LocalFilesystem({ basePath: root, contained: true, readOnly: true }),
    tools: { enabled: false,
      [WORKSPACE_TOOLS.FILESYSTEM.READ_FILE]: { enabled: true },
      [WORKSPACE_TOOLS.FILESYSTEM.LIST_FILES]: { enabled: true },
      [WORKSPACE_TOOLS.FILESYSTEM.FILE_STAT]: { enabled: true },
      [WORKSPACE_TOOLS.FILESYSTEM.GREP]: { enabled: true },
      [WORKSPACE_TOOLS.FILESYSTEM.WRITE_FILE]: { enabled: false },
      [WORKSPACE_TOOLS.FILESYSTEM.EDIT_FILE]: { enabled: false },
      [WORKSPACE_TOOLS.FILESYSTEM.APPLY_PATCH]: { enabled: false },
      [WORKSPACE_TOOLS.SANDBOX.EXECUTE_COMMAND]: { enabled: false },
    },
  });
    await workspace.init();
    const tools = await createWorkspaceTools(workspace);
    const activeWorkspace = workspace;
    return {
      workspace: activeWorkspace,
      tools,
      /** 阶段完成后销毁原生 Workspace 并清理独占快照。 */
      close: async () => { try { await activeWorkspace.destroy(); } finally { rmSync(root, { recursive: true, force: true }); } },
    };
  } catch (error) {
    await workspace?.destroy().catch(() => {});
    rmSync(root, { recursive: true, force: true });
    throw error;
  }
}
