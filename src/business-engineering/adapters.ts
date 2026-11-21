/** 服务端固定项目适配注册表；manifest 只选择已登记能力，不提供命令。
 * ADR: docs/decisions/2026-11-21-unified-team-loop-and-project-adapters.md
 */
import { z } from 'zod';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, realpathSync } from 'node:fs';

const nodeSource = z.string().regex(/^src\/(?:[a-zA-Z0-9_-]+\/)*[a-zA-Z0-9_-]+\.mjs$/).max(200);
const nodeCheck = z.string().regex(/^test\/(?:[a-zA-Z0-9_-]+\/)*[a-zA-Z0-9_-]+\.test\.mjs$/).max(200);
const nodeManifest = z.object({ version: z.literal('node-test.v1'), sources: z.array(nodeSource).min(1).max(100), writable: z.array(nodeSource).min(1).max(40), checks: z.array(nodeCheck).min(1).max(20) }).strict();
const pythonSource = z.string().regex(/^src\/(?:[a-zA-Z0-9_-]+\/)*[a-zA-Z0-9_-]+\.py$/).max(200);
const pythonCheck = z.string().regex(/^tests\/(?:[a-zA-Z0-9_-]+\/)*test_[a-zA-Z0-9_-]+\.py$/).max(200);
const pythonManifest = z.object({ version: z.literal('python-unittest.v1'), sources: z.array(pythonSource).min(1).max(100), writable: z.array(pythonSource).min(1).max(40), checks: z.array(pythonCheck).min(1).max(20) }).strict();

const pythonTest = 'import importlib.util,sys,unittest; sys.path.insert(0,"src"); spec=importlib.util.spec_from_file_location("registered_test",sys.argv[1]); module=importlib.util.module_from_spec(spec); spec.loader.exec_module(module); suite=unittest.defaultTestLoader.loadTestsFromModule(module); result=unittest.TextTestRunner(verbosity=2).run(suite); sys.exit(0 if result.wasSuccessful() and result.testsRun > 0 else 1)';
const pythonCompile = 'import sys; compile(open(sys.argv[1],encoding="utf-8").read(),sys.argv[1],"exec")';

export type AdapterId = 'node-test.v1' | 'python-unittest.v1';
export interface AdapterCheck { id: string; runtime: 'node' | 'python'; args: string[]; command: string; test: boolean; path: string }

/** 从固定 Adapter 定义生成检查计划；路径只来自已校验候选。 */
export function adapterChecks(id: AdapterId, files: string[], checks: string[], timeoutMs: number): AdapterCheck[] {
  const python = id === 'python-unittest.v1';
  const sources = files.filter(path => path.startsWith('src/') && path.endsWith(python ? '.py' : '.mjs')).sort();
  return [...sources.map(path => python
    ? { id: `syntax:${path}`, runtime: 'python' as const, args: ['-I', '-B', '-c', pythonCompile, path], command: `python3 -I -B compile ${path}`, test: false, path }
    : { id: `syntax:${path}`, runtime: 'node' as const, args: ['--max-old-space-size=128', '--check', path], command: `node --max-old-space-size=128 --check ${path}`, test: false, path }),
  ...checks.map(path => python
    ? { id: `test:${path}`, runtime: 'python' as const, args: ['-I', '-B', '-c', pythonTest, path], command: `python3 -I -B unittest ${path}`, test: true, path }
    : { id: `test:${path}`, runtime: 'node' as const, args: ['--max-old-space-size=128', '--test', '--test-reporter=tap', `--test-timeout=${timeoutMs}`, path], command: `node --max-old-space-size=128 --test --test-reporter=tap --test-timeout=${timeoutMs} ${path}`, test: true, path })];
}

/** 记录实际解释器版本与程序摘要；仅执行宿主登记的解释器自检。 */
export function pythonIdentity() {
  const candidate = process.platform === 'darwin' && existsSync('/opt/homebrew/bin/python3') ? '/opt/homebrew/bin/python3' : '/usr/bin/python3';
  const executable = realpathSync(candidate);
  const version = execFileSync(executable, ['-I', '--version'], { encoding: 'utf8', timeout: 5000 }).trim();
  const sha256 = createHash('sha256').update(readFileSync(executable)).digest('hex');
  const root = realpathSync(execFileSync(executable, ['-I', '-c', 'import sys; print(sys.base_prefix)'], { encoding: 'utf8', timeout: 5000 }).trim());
  return { executable, version, sha256, root };
}

/** 计划模板和运行时共同参与冻结；实现变化或解释器变更使旧 Run 失败关闭。 */
export function adapterImplementationIdentity(id: AdapterId) {
  const template = adapterChecks(id, ['src/example.' + (id === 'python-unittest.v1' ? 'py' : 'mjs')], [id === 'python-unittest.v1' ? 'tests/test_example.py' : 'test/example.test.mjs'], 25000);
  const runtime = id === 'python-unittest.v1' ? pythonIdentity() : { version: process.version, executable: realpathSync(process.execPath), sha256: createHash('sha256').update(readFileSync(realpathSync(process.execPath))).digest('hex') };
  return { version: 'adapter-implementation.v1', template, runtime };
}

/** 固定解释器前后的摘要一致性；不依赖 Python 启动后的自述作为唯一依据。 */
export function runtimeDigest(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

/** 仅暴露固定注册的文件契约和展示元数据，不接受调用者覆盖执行计划。 */
const adapters = {
  'node-test.v1': {
    manifest: nodeManifest,
    checkCommand: (path: string) => `node --test ${path}`,
    executionReason: '使用隔离候选执行登记的 Node 检查。',
  },
  'python-unittest.v1': {
    manifest: pythonManifest,
    checkCommand: (path: string) => `python3 -I -B -m unittest ${path}`,
    executionReason: '使用隔离候选执行登记的 Python 标准库检查。',
  },
} as const;

/** 按 manifest 版本解析服务端登记适配器，未知版本直接拒绝。 */
export function parseProjectManifest(value: unknown) {
  const version = z.object({ version: z.string() }).parse(value).version;
  if (version !== 'node-test.v1' && version !== 'python-unittest.v1') throw new Error('未登记的项目 Adapter');
  const adapter = adapters[version];
  return { adapter, manifest: adapter.manifest.parse(value) };
}
