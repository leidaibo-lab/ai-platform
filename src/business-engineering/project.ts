/** 服务端授权的项目适配，从固定 Git 对象读取 SDD、候选与保护检查。 */
import { execFileSync } from 'node:child_process';
import { AsyncLocalStorage } from 'node:async_hooks';
import { realpathSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { validateRepository } from '../delivery/asset-files.js';
import type { AssetCorrelation } from '../delivery/asset-identity.js';
import { remoteSyncTargetSchema, type RemoteSyncTarget } from './project-target.js';
import { developmentHash, projectSchema } from '../development/contracts.js';
import type { PracticeConfig } from '../mastra/config.js';
import { adapterImplementationIdentity, parseProjectManifest } from './adapters.js';
import { assertDeliveryContractMatchesAdapter, defaultContractForAdapter, readProjectDeliveryContract } from './delivery-contract.js';
import { isAuthorizedProductRestart } from '../mastra/workflows/product-rework.js';

const hrmOrigin = 'https://github.com/leidaibo-lab/hrm.git';
const revisionSchema = z.string().regex(/^[a-f0-9]{40}$/);
export const engineeringProjectSchema = remoteSyncTargetSchema.extend({ revision: revisionSchema }).refine(
  /** 历史 HRM 使用原有执行档与档案格式。 */
  project => project.id !== 'hrm', 'hrm 是兼容项目标识',
);
export type EngineeringProject = z.infer<typeof engineeringProjectSchema>;

const projectScope = new AsyncLocalStorage<PracticeConfig>();
const rootProjectRun = new AsyncLocalStorage<{ workflowId: string; runId: string }>();

/** 校验服务端注册表；附加同步目标不能成为可执行项目。 */
export function registeredProjects(config: PracticeConfig): EngineeringProject[] {
  const projects = (config.engineeringProjects ?? (config.engineeringProject ? [config.engineeringProject] : [])).map(project => engineeringProjectSchema.parse(project));
  if ((!projects.length && config.engineeringProjects) || new Set(projects.map(project => project.id)).size !== projects.length) throw new Error('项目注册表为空或项目标识重复');
  if (config.engineeringProjects && config.engineeringProject) throw new Error('不能同时配置项目注册表和历史单项目');
  if (new Set(projects.map(project => realpathSync(project.root))).size !== projects.length) throw new Error('业务工程项目不能共享同一个仓库根目录');
  return projects;
}

/** CLI 与 Studio 共用环境项目配置；这里只读取显式项目 JSON，不读取或输出凭据。 */
export function configureEngineeringProjects(config: PracticeConfig, env: Record<string, string | undefined>): PracticeConfig {
  const values = env.MASTRA_ENGINEERING_PROJECTS ? z.array(engineeringProjectSchema).min(1).max(50).parse(JSON.parse(env.MASTRA_ENGINEERING_PROJECTS)) : undefined;
  const single = env.MASTRA_ENGINEERING_PROJECT ? engineeringProjectSchema.parse(JSON.parse(env.MASTRA_ENGINEERING_PROJECT)) : undefined;
  if (values && single) throw new Error('不能同时配置单项目与项目注册表');
  if (values) config.engineeringProjects = values.map(project => ({ ...project, root: resolve(config.rootDir, project.root) }));
  else if (single) {
    config.engineeringProject = { ...single, root: resolve(config.rootDir, single.root) };
    config.databaseUrl = `file:${resolve(dirname(fileURLToPath(config.databaseUrl)), 'projects', single.id, 'mastra.db')}`;
  }
  return config;
}

/** 按服务端 ID 生成不可变配置视图，注册表模式禁止默认选择首项。 */
export function selectProjectConfig(config: PracticeConfig, projectId?: string): PracticeConfig {
  const projects = registeredProjects(config);
  if (!config.engineeringProjects) {
    const expected = config.engineeringProject?.id ?? 'hrm';
    if (projectId && projectId !== expected) throw new Error('Run 的业务工程绑定已变化');
    return config;
  }
  const project = projects.find(project => project.id === projectId);
  if (!project) throw new Error('必须选择已登记业务工程项目');
  return Object.freeze({ ...config, engineeringProjects: undefined, engineeringProject: Object.freeze(project), projectRegistrySelection: true, hrmRepositoryRoot: undefined });
}

/** 只代理运行期项目字段，其余配置由原对象原样读取，禁止写入共享配置。 */
export function scopedProjectConfig(config: PracticeConfig): PracticeConfig {
  return new Proxy(config, {
    /** 当前异步调用内的项目选择不影响其他 Run。 */
    get(target, key, receiver) {
      const active = projectScope.getStore();
      if (active && (key === 'engineeringProject' || key === 'engineeringProjects' || key === 'hrmRepositoryRoot' || key === 'projectRegistrySelection')) return Reflect.get(active, key);
      return Reflect.get(target, key, receiver);
    },
    /** Workflow 配置是只读依赖，任何步骤都不能切换全局项目。 */
    set() { throw new Error('运行配置不可修改'); },
  });
}

/** 仅识别团队正式输入包装，不遍历模型正文或任意业务字段。 */
export function projectCorrelation(value: any): AssetCorrelation | undefined {
  if (Array.isArray(value)) return projectCorrelation(value[0]);
  if (!value || typeof value !== 'object') return undefined;
  return value.correlation ?? projectCorrelation(value.state) ?? projectCorrelation(value.development) ?? projectCorrelation(value.input) ?? projectCorrelation(value.approvedProduct);
}

/** 已保存初始化是项目恢复的权威来源；新输入不能覆盖原绑定。 */
export function snapshotProjectConfig(config: PracticeConfig, snapshot: any, options: { readOnly?: boolean } = {}): PracticeConfig {
  const initial = snapshot?.steps?.['initialize-team-run'] ?? snapshot?.context?.['initialize-team-run'] ?? snapshot?.steps?.['initialize-product-development'] ?? snapshot?.context?.['initialize-product-development'];
  const correlation = projectCorrelation(initial?.output);
  const input = snapshot?.payload ?? snapshot?.context?.input;
  if (config.engineeringProjects && !correlation && !options.readOnly) throw new Error('Run 缺少已冻结的业务工程绑定');
  const selected = selectProjectConfig(config, correlation?.projectId ?? input?.projectId);
  if (correlation || !options.readOnly) assertProjectCorrelation(selected, correlation, { allowEarlierRevision: options.readOnly && snapshot?.status === 'success' });
  return selected;
}

/** 异步上下文仅持有本步骤配置；审批、恢复与运行事实仍全部由 Mastra Store 保存。 */
export function withProjectConfig<T>(config: PracticeConfig, operation: () => T): T {
  return projectScope.run(config, operation);
}

/** 新 Run 和生命周期 Hook 共用同一绑定构造，root/origin 由摘要冻结而不公开宿主路径。 */
export function createProjectCorrelation(config: PracticeConfig, input: { projectId?: string; iterationId: string }, runId: string): AssetCorrelation {
  const selected = selectProjectConfig(config, input.projectId);
  const engineering = selected.engineeringProject;
  const loaded = engineering ? loadEngineeringProject(engineering) : undefined;
  const profile = loaded?.profile;
  const candidate = loaded?.candidate;
  const contract = candidate ? readProjectDeliveryContract(selected, undefined, defaultContractForAdapter(candidate)) : undefined;
  if (contract && candidate) assertDeliveryContractMatchesAdapter(contract.contract, candidate);
  return { projectId: engineering?.id ?? 'hrm', ...(engineering ? { engineeringBinding: engineeringBinding(engineering), engineeringRevision: engineering.revision, adapterId: profile!.adapterId, adapterProfileVersion: 'adapter-profile.v2' as const, adapterProfileHash: profile!.hash, deliveryContractVersion: 'project-delivery-contract.v1' as const, deliveryContractHash: contract!.hash } : {}), iterationId: input.iterationId, runId, workflowId: 'productDevelopmentWorkflow' };
}

/** 在原生图所有步骤外层装配 Run 作用域，覆盖嵌套、foreach、Studio start/resume/timeTravel。 */
export function bindProjectWorkflow<T extends { steps: Record<string, any>; stepGraph: any[]; createRun: (...args: any[]) => Promise<any>; mastra?: any }>(workflow: T, config: PracticeConfig, options: { workflowId?: string; initializeId?: string; validateSource?: (value: unknown, mastra: any) => Promise<void> } = {}): T {
  if (!config.engineeringProjects && !options.workflowId) return workflow;
  const workflowId = options.workflowId ?? 'product-development';
  const initializeId = options.initializeId ?? 'initialize-product-development';
  {
    const createRun = workflow.createRun;
    const guarded = new WeakSet<object>();
    const starting = new Set<string>();
    /** 原生入口在 Store 变更前校验项目，随后完整委托 Mastra 执行及持久化。 */
    workflow.createRun = async function (...args: any[]) {
      const run = await createRun.apply(this, args);
      if (guarded.has(run)) return run;
      guarded.add(run);
      for (const method of ['_start', '_resume', '_timeTravel', '_restart']) {
        if (typeof run[method] !== 'function') continue;
        const execute = run[method];
        /** stream、async start 与普通调用共用原生内部入口，不能绕过项目检查。 */
        run[method] = async function (request: any, ...rest: any[]) {
          if (method === '_start') {
            if (starting.has(run.runId)) throw new Error('该 Run 正在初始化，不能并发更换项目');
            starting.add(run.runId);
          }
          try {
            const store = await workflow.mastra?.getStorage()?.getStore('workflows');
            if (!store) throw new Error('Run 工程绑定校验缺少原生 Store');
            const snapshot = await store.loadWorkflowSnapshot({ workflowName: workflowId, runId: run.runId });
            const saved = projectCorrelation(snapshot?.context?.[initializeId]?.output);
            const original = snapshot?.context?.input;
            const supplied = projectCorrelation(request?.inputData);
            const target = typeof request?.step === 'string' ? request.step.split('.')[0] : Array.isArray(request?.step) ? request.step[0]?.id ?? request.step[0] : request?.step?.id;
            if (saved) {
              const selected = selectProjectConfig(config, saved.projectId);
              assertProjectCorrelation(selected, saved);
              if (method === '_start' || method === '_timeTravel' && target === initializeId) throw new Error('已经初始化的 Run 不能重新初始化或更换项目');
              if (request?.context?.[initializeId] || request?.context?.input || request?.nestedStepsContext?.[initializeId]) throw new Error('原生恢复不能覆盖 Run 初始化上下文');
              if (supplied && developmentHash(saved) !== developmentHash(supplied)) throw new Error('原生恢复输入与 Run 项目绑定不一致');
              if (request?.inputData?.projectId && request.inputData.projectId !== saved.projectId) throw new Error('不能更换已冻结的 Run 项目');
              if (options.workflowId) {
                if (request?.context || request?.nestedStepsContext) throw new Error('独立团队恢复不能覆盖保存的执行上下文');
                const initialized = snapshot?.context?.[initializeId]?.output;
                if (developmentHash(initialized?.teamRun?.input) !== developmentHash(original)) throw new Error('独立团队初始化输入已变化');
                await options.validateSource?.(initialized, workflow.mastra);
                if (method === '_timeTravel' && request?.inputData) {
                  const current = await (workflow as any).getWorkflowRunById(run.runId);
                  const path = typeof request.step === 'string' ? request.step : request.step?.map((item: any) => typeof item === 'string' ? item : item.id).join('.');
                  const entry = current?.steps?.[path];
                  if ((!entry || Array.isArray(entry) || developmentHash(entry.payload) !== developmentHash(request.inputData)) && !isAuthorizedProductRestart(run.runId, path, request.inputData)) throw new Error('独立团队只能从保存的检查点恢复');
                }
              }
            } else if (method === '_start') {
              selectProjectConfig(config, request?.inputData?.projectId);
              if (original?.projectId && developmentHash(original) !== developmentHash(request.inputData)) throw new Error('已有 Run 初始化输入不能替换');
            } else throw new Error('原生恢复缺少已冻结的 Run 工程绑定');
            return await execute.call(this, request, ...rest);
          } finally { if (method === '_start') starting.delete(run.runId); }
        };
      }
      return run;
    };
  }
  const visited = new Set<object>();
  /** 图与 steps 引用可能共享，逐对象只包装一次。 */
  function visit(step: any) {
    if (!step || typeof step !== 'object' || visited.has(step)) return;
    visited.add(step);
    if (typeof step.execute === 'function') {
      const execute = step.execute;
      /** 先建立项目作用域，再进入资产和执行作用域；任何漂移先于副作用拒绝。 */
      step.execute = async (context: any) => {
        const supplied = projectCorrelation(context.inputData);
        const input = context.getInitData?.() as { projectId?: string } | undefined;
        const inherited = projectScope.getStore();
        const initCorrelation = projectCorrelation(input);
        const store = await context.mastra?.getStorage()?.getStore('workflows');
        const inheritedRoot = rootProjectRun.getStore();
        let native = inheritedRoot ?? context.parentWorkflow ?? { workflowId: context.workflowId, runId: context.runId };
        let snapshot;
        if (config.engineeringProjects || options.workflowId) {
          for (let depth = 0; depth < 16; depth++) {
            snapshot = await store?.loadWorkflowSnapshot({ workflowName: native.workflowId, runId: native.runId });
            if (native.workflowId === workflowId) break;
            if (!snapshot?.parentWorkflow) {
              const root = await store?.loadWorkflowSnapshot({ workflowName: workflowId, runId: context.runId });
              if (!root) throw new Error('原生步骤缺少根 Run 来源');
              native = { workflowId, runId: context.runId };
              snapshot = root;
              break;
            }
            native = snapshot.parentWorkflow;
          }
          if (native.workflowId !== workflowId) throw new Error('原生项目来源层级无效');
        }
        const saved = projectCorrelation(snapshot?.context?.[initializeId]?.output);
        const correlation = saved ?? initCorrelation ?? supplied;
        if (initCorrelation && supplied && developmentHash(initCorrelation) !== developmentHash(supplied)) throw new Error('原生步骤的 Run 业务工程绑定与团队输入不一致');
        if (inherited?.engineeringProject && correlation && inherited.engineeringProject.id !== correlation.projectId) throw new Error('嵌套步骤不能切换 Run 项目');
        if (Array.isArray(context.inputData) && context.inputData.some((item: unknown) => { const owner = projectCorrelation(item); return owner && correlation && developmentHash(owner) !== developmentHash(correlation); })) throw new Error('并行步骤包含不同 Run 工程绑定');
        if (saved && supplied && developmentHash(saved) !== developmentHash(supplied)) throw new Error('原生步骤的 Run 业务工程绑定与初始化不一致');
        if (correlation && input?.projectId && correlation.projectId !== input.projectId) throw new Error('Run 初始化项目与步骤绑定不一致');
        if (saved && snapshot?.context?.input?.projectId && saved.projectId !== snapshot.context.input.projectId) throw new Error('Run 初始化项目已变化');
        const frozenId = saved?.projectId ?? snapshot?.context?.input?.projectId ?? input?.projectId;
        if (saved && step.id === initializeId && context.inputData.projectId !== saved.projectId) throw new Error('不能替换已冻结的 Run 项目');
        const selected = selectProjectConfig(config, frozenId ?? correlation?.projectId);
        if (correlation) assertProjectCorrelation(selected, correlation);
        else if (config.engineeringProjects && step.id !== initializeId && !step.steps) throw new Error('原生步骤缺少 Run 工程绑定');
        return rootProjectRun.run(native, () => withProjectConfig(selected, () => execute.call(step, context)));
      };
    }
    for (const child of Object.values(step.steps ?? {})) visit(child);
    for (const entry of step.stepGraph ?? []) visitEntry(entry);
  }
  /** 原生图里的普通、分支、循环和并行项都可能持有实际执行对象。 */
  function visitEntry(entry: any) {
    if (!entry || typeof entry !== 'object') return;
    if (entry.step?.execute) visit(entry.step);
    else visitEntry(entry.step);
    for (const value of Object.values(entry)) {
      if (Array.isArray(value)) for (const child of value) Array.isArray(child) ? child.forEach(visitEntry) : visitEntry(child);
    }
  }
  for (const step of Object.values(workflow.steps)) visit(step);
  for (const entry of workflow.stepGraph) visitEntry(entry);
  return workflow;
}

/** 主项目由宿主登记，远端同步字典中的附加目标不具备项目授权。 */
export function projectTarget(config: Pick<PracticeConfig, 'engineeringProject' | 'engineeringProjects' | 'hrmRepositoryRoot'>): RemoteSyncTarget | undefined {
  if (config.engineeringProjects) throw new Error('项目注册表必须按 Run 选择，不能默认使用首个项目');
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
  const loaded = correlation.adapterId || correlation.adapterProfileHash || correlation.deliveryContractVersion || correlation.deliveryContractHash
    ? loadEngineeringProject({ ...project, revision }) : undefined;
  if (correlation.adapterId || correlation.adapterProfileHash) {
    const profile = loaded!.profile;
    const hash = correlation.adapterProfileVersion === 'adapter-profile.v2' ? profile.hash : profile.legacyHash;
    if (correlation.adapterId !== profile.adapterId || correlation.adapterProfileHash !== hash) throw new Error('Run 的业务工程 Adapter 绑定已变化');
  }
  if (correlation.deliveryContractVersion || correlation.deliveryContractHash) {
    const contract = readProjectDeliveryContract(config, correlation.deliveryContractHash);
    if (correlation.deliveryContractVersion !== 'project-delivery-contract.v1' || contract.hash !== correlation.deliveryContractHash) throw new Error('Run 的项目交付契约绑定已变化');
    assertDeliveryContractMatchesAdapter(contract.contract, loaded!.candidate);
  }
}

const specPaths = { product: 'specs/product-sdd.md', development: 'specs/development-sdd.md', testing: 'specs/test-sdd.md' } as const;

/** 按目录层级列出 manifest 候选实际适用的项目规则，根规则始终优先。 */
function applicableInstructionPaths(paths: string[]) {
  const instructions = new Set(['AGENTS.md']);
  for (const path of paths) {
    const directories = path.split('/').slice(0, -1);
    for (let depth = 1; depth <= directories.length; depth++) instructions.add(`${directories.slice(0, depth).join('/')}/AGENTS.md`);
  }
  return [...instructions].sort(
    /** 父目录规则先于更具体的目录规则，同层保持确定顺序。 */
    (left, right) => left.split('/').length - right.split('/').length || left.localeCompare(right),
  );
}

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
  /** 可选规则不存在时跳过；存在但不是普通文件时拒绝静默绕过。 */
  function readOptionalInstruction(path: string) {
    const entry = git('ls-tree', project.revision, '--', path);
    if (!entry.trim()) return undefined;
    if (!/^100(?:644|755) blob /.test(entry)) throw new Error(`工程规则必须是普通文件 ${path}`);
    const body = read(path, 100000);
    if (body.includes('\0')) throw new Error(`工程规则不能包含二进制内容 ${path}`);
    return body;
  }
  return { project, read, readOptionalInstruction };
}

/** 从同一 Git 版本构造目录视图、候选和三个角色的规格。 */
export function loadEngineeringProject(value: EngineeringProject) {
  const { project, read, readOptionalInstruction } = openEngineeringRevision(value);
  const { manifest, adapter } = parseProjectManifest(JSON.parse(read('specs/engineering.json', 16000)));
  const candidatePaths = [...manifest.sources, ...manifest.checks];
  if (new Set(candidatePaths).size !== candidatePaths.length) throw new Error('工程文件重复登记');
  const instructionEntries = applicableInstructionPaths(candidatePaths).flatMap(
    /** 只冻结固定提交中存在且适用于候选路径的目录规则。 */
    path => {
      const body = readOptionalInstruction(path);
      return body === undefined ? [] : [[path, body] as const];
    },
  );
  const instructionFiles = instructionEntries.map(([path]) => path);
  const sourceEntries = candidatePaths.map(/** 按 manifest 顺序冻结候选输入。 */path => [path, read(path, 100000)] as const);
  const files = Object.fromEntries([...instructionEntries, ...sourceEntries]);
  const candidate = projectSchema.parse({ id: project.id, ...(manifest.version === 'python-unittest.v1' ? { adapterId: manifest.version } : {}), files, instructionFiles, writablePaths: manifest.writable, checkFiles: manifest.checks, roles: ['backend'] });
  const specs = {
    product: read(specPaths.product, 24000),
    development: read(specPaths.development, 24000),
    testing: read(specPaths.testing, 24000),
  };
  const binding = engineeringBinding(project);
  const catalog = {
    available: true as const, id: project.id, title: project.label, branch: '固定提交', revision: project.revision,
    modules: [{ id: 'rules', title: '项目协作规则', role: 'backend', count: instructionFiles.length }, { id: 'src', title: '项目源码', role: 'backend', count: manifest.sources.length }, { id: 'test', title: '保护检查', role: 'backend', count: manifest.checks.length }],
    files: Object.keys(files).map(/** 只公开安全路径与完整性元数据。 */path => ({ path, area: instructionFiles.includes(path) ? 'rules' : path.startsWith('src/') ? 'src' : 'test', bytes: Buffer.byteLength(files[path]!), hash: developmentHash(files[path]) })),
    checks: manifest.checks.map(/** 命令由服务端登记的适配器固定，界面只展示登记检查。 */path => ({ id: `test:${path}`, title: path, command: adapter.checkCommand(path), ready: true, reason: '使用隔离候选执行' })),
    executionReady: true, preparationIssues: [], executionReason: adapter.executionReason, catalogHash: developmentHash({ binding, candidate }),
  };
  const profile = { adapterId: manifest.version, legacyHash: developmentHash({ adapterId: manifest.version, manifest }), hash: developmentHash({ adapterId: manifest.version, manifest, implementation: adapterImplementationIdentity(manifest.version) }) };
  return { candidate, catalog, specs, profile };
}

/** 仅为当前角色提供对应 SDD，包含固定版本以便追溯。 */
export function projectSpec(config: PracticeConfig, role: 'product' | 'development' | 'testing') {
  const project = config.engineeringProject;
  if (!project) return undefined;
  const path = specPaths[role];
  return { projectId: project.id, revision: project.revision, path, content: openEngineeringRevision(project).read(path, 24000) };
}
