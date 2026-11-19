/** 服务端授权的项目适配，从固定 Git 对象读取 SDD、候选与保护检查。 */
import { execFileSync } from 'node:child_process';
import { z } from 'zod';
import { validateRepository } from '../delivery/asset-files.js';
import { projectIdSchema, type AssetCorrelation } from '../delivery/asset-identity.js';
import { remoteSyncTargetSchema, type RemoteSyncTarget } from '../delivery/remote-sync-settings.js';
import { developmentHash, projectSchema } from '../development/contracts.js';
import type { PracticeConfig } from '../mastra/config.js';

const hrmOrigin = 'https://github.com/leidaibo-lab/hrm.git';
const revisionSchema = z.string().regex(/^[a-f0-9]{40}$/);
export const engineeringProjectSchema = remoteSyncTargetSchema.extend({ revision: revisionSchema }).refine(
  /** 历史 HRM 使用原有执行档与档案格式。 */
  project => project.id !== 'hrm', 'hrm 是兼容项目标识',
);
export type EngineeringProject = z.infer<typeof engineeringProjectSchema>;
const sourcePath = z.string().regex(/^src\/(?:[a-zA-Z0-9_-]+\/)*[a-zA-Z0-9_-]+\.mjs$/).max(200);
const checkPath = z.string().regex(/^test\/(?:[a-zA-Z0-9_-]+\/)*[a-zA-Z0-9_-]+\.test\.mjs$/).max(200);
const manifestSchema = z.object({
  version: z.literal('node-test.v1'),
  sources: z.array(sourcePath).min(1).max(100),
  writable: z.array(sourcePath).min(1).max(40),
  checks: z.array(checkPath).min(1).max(20),
}).strict();

/** 主项目由宿主登记，远端同步字典中的附加目标不具备项目授权。 */
export function projectTarget(config: Pick<PracticeConfig, 'engineeringProject' | 'hrmRepositoryRoot'>): RemoteSyncTarget | undefined {
  if (config.engineeringProject) {
    const { id, label, root, origin } = config.engineeringProject;
    return { id, label, root, origin };
  }
  return (config.hrmRepositoryRoot ? { id: 'hrm', label: 'HRM 项目仓库', root: config.hrmRepositoryRoot, origin: hrmOrigin } : undefined);
}

/** 校验绑定的真实仓库根及 origin。 */
export function projectRepositoryRoot(config: PracticeConfig) {
  const target = projectTarget(config);
  return target ? validateRepository(target.root, target.origin) : undefined;
}

/** 绑定项目、仓库和固定版本，避免重启后把旧 Run 装配到另一份工程。 */
export function engineeringBinding(project: EngineeringProject) {
  return developmentHash([project.id, project.origin, project.root, project.revision]);
}

/** 工作流在恢复或正式交接前检查 Store 中的归属。 */
export function assertProjectCorrelation(config: PracticeConfig, correlation: AssetCorrelation | undefined, options: { allowEarlierRevision?: boolean } = {}) {
  const project = config.engineeringProject;
  if (!project) {
    if (correlation && correlation.projectId !== 'hrm') throw new Error('Run 的业务工程绑定已变化');
    return;
  }
  const revision = options.allowEarlierRevision ? correlation?.engineeringRevision : project.revision;
  if (!revision || correlation?.projectId !== project.id || correlation.engineeringRevision !== revision || correlation.engineeringBinding !== engineeringBinding({ ...project, revision })) {
    throw new Error('Run 的业务工程绑定已变化');
  }
}

const specPaths = { product: 'specs/product-sdd.md', development: 'specs/development-sdd.md', testing: 'specs/test-sdd.md' } as const;

/** Git 参数由宿主和 manifest 白名单构建，正文只读取固定版本的普通 blob。 */
function openEngineeringRevision(value: EngineeringProject) {
  const project = engineeringProjectSchema.parse(value);
  const root = validateRepository(project.root, project.origin);
  /** 读取固定对象，禁止替换引用影响版本内容。 */
  function git(...args: string[]) {
    return execFileSync('git', ['--no-replace-objects', '-C', root, ...args], { encoding: 'utf8', maxBuffer: 102400, timeout: 5000, stdio: ['ignore', 'pipe', 'pipe'] });
  }
  if (git('cat-file', '-t', project.revision).trim() !== 'commit') throw new Error('工程版本必须是 Git commit');
  /** 只接受 Git 普通文件且限制正文容量。 */
  function read(path: string, maxBytes: number) {
    if (!/^100(?:644|755) blob /.test(git('ls-tree', project.revision, '--', path))) throw new Error(`工程版本中缺少普通文件 ${path}`);
    const body = git('show', `${project.revision}:${path}`);
    if (!body.trim() || Buffer.byteLength(body) > maxBytes) throw new Error(`工程文件为空或超出预算 ${path}`);
    return body;
  }
  return { project, read };
}

/** 从同一 Git 版本构造目录视图、候选和三个角色的规格。 */
export function loadEngineeringProject(value: EngineeringProject) {
  const { project, read } = openEngineeringRevision(value);
  const manifest = manifestSchema.parse(JSON.parse(read('specs/engineering.json', 16000)));
  const paths = [...manifest.sources, ...manifest.checks];
  if (new Set(paths).size !== paths.length) throw new Error('工程文件重复登记');
  const files = Object.fromEntries(paths.map(/** 按 manifest 顺序冻结候选输入。 */path => [path, read(path, 100000)]));
  const candidate = projectSchema.parse({ id: project.id, files, writablePaths: manifest.writable, checkFiles: manifest.checks, roles: ['backend'] });
  const specs = {
    product: read(specPaths.product, 24000),
    development: read(specPaths.development, 24000),
    testing: read(specPaths.testing, 24000),
  };
  const binding = engineeringBinding(project);
  const catalog = {
    available: true as const, id: project.id, title: project.label, branch: '固定提交', revision: project.revision,
    modules: [{ id: 'src', title: '项目源码', role: 'backend', count: manifest.sources.length }, { id: 'test', title: '保护检查', role: 'backend', count: manifest.checks.length }],
    files: paths.map(/** 只公开安全路径与完整性元数据。 */path => ({ path, area: path.startsWith('src/') ? 'src' : 'test', bytes: Buffer.byteLength(files[path]!), hash: developmentHash(files[path]) })),
    checks: manifest.checks.map(/** 命令由正文执行器固定，界面只展示登记检查。 */path => ({ id: `test:${path}`, title: path, command: `node --test ${path}`, ready: true, reason: '使用隔离候选执行' })),
    executionReady: true, preparationIssues: [], executionReason: '使用隔离候选执行登记的 Node 检查。', catalogHash: developmentHash({ binding, candidate }),
  };
  return { candidate, catalog, specs };
}

/** 仅为当前角色提供对应 SDD，包含固定版本以便追溯。 */
export function projectSpec(config: PracticeConfig, role: 'product' | 'development' | 'testing') {
  const project = config.engineeringProject;
  if (!project) return undefined;
  const path = specPaths[role];
  return { projectId: project.id, revision: project.revision, path, content: openEngineeringRevision(project).read(path, 24000) };
}
