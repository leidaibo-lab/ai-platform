/**
 * 原生 LocalFilesystem/LocalSandbox 的最小适配器：宿主只暴露精确文件白名单，
 * 不可信代码仅在禁网、只读候选目录的 OS 沙箱中执行，检查命令由宿主固定。
 * ADR: docs/decisions/2026-11-06-mastra-development-execution.md
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { LocalFilesystem, LocalSandbox, type NativeSandboxConfig } from '@mastra/core/workspace';

/** 实际进程结果；退出码、超时和输出均来自原生沙箱，不采用模型自述。 */
export interface DevelopmentCheckResult {
  id: string;
  command: string;
  exitCode: number;
  processExitCode: number;
  stdout: string;
  stderr: string;
  durationMs: number;
  timedOut: boolean;
  stdoutTruncated: boolean;
  stderrTruncated: boolean;
}

/** 测试可缩短预算；运行入口只能使用或下调生产上限。 */
export interface DevelopmentExecutionLimits {
  testTimeoutMs?: number;
  commandTimeoutMs?: number;
}

/** 限制输出和文件大小，避免工具上下文无界增长。 */
const maxBytes = 262144;
const defaultTestTimeoutMs = 25000;
const defaultCommandTimeoutMs = 30000;

/** 只接受正整数且不高于生产预算，避免测试配置扩大执行窗口。 */
function boundedTimeout(value: number | undefined, fallback: number, name: string): number {
  const timeout = value ?? fallback;
  if (!Number.isInteger(timeout) || timeout < 1 || timeout > fallback) throw new Error(`${name}必须为1到${fallback}毫秒`);
  return timeout;
}

/** 生成 SBPL 字符串字面值；此值只写策略文件，不进入 shell。 */
function literal(value: string): string { return JSON.stringify(value); }

/** 构建 deny 优先的 macOS 策略；仅读取运行系统、Node 和当前候选目录。 */
function seatbeltPolicy(root: string, temporary: string, nodeDirectory: string, libraries: string[]): string {
  const readable = ['/usr', '/System', '/bin', '/sbin', '/dev', '/private/var/select', nodeDirectory, root, temporary];
  const excluded = readable.map(
    // allow-read 后补充排除式 deny，避免 macOS 对单独 allow-subpath 的兼容限制。
    (path) => `(require-not (subpath ${literal(path)}))`,
  ).join(' ');
  const libraryExclusions = libraries.map(
    // 只排除精确库文件，不开放包目录或Homebrew安装根目录。
    (path) => `(require-not (literal ${literal(path)}))`,
  ).join(' ');
  return [
    '(version 1)', '(deny default)', '(allow process-exec)', '(allow process-fork)',
    '(allow process-info* (target same-sandbox))', '(allow signal (target same-sandbox))',
    '(allow mach-lookup (global-name "com.apple.logd") (global-name "com.apple.system.logger"))',
    '(allow sysctl-read)', '(allow ipc-posix-shm)', '(allow ipc-posix-sem)',
    '(allow file-read*)',
    `(deny file-read-data (require-all ${excluded} ${libraryExclusions} (require-not (literal "/"))))`,
    `(deny file-read-xattr (require-all ${excluded} ${libraryExclusions} (require-not (literal "/"))))`,
    '(deny file-read* (regex #"(^|/)\\.env($|[./])"))',
    `(allow file-write* (subpath ${literal(temporary)}))`,
    '(allow file-write* (literal "/dev/null"))', '(allow file-ioctl (literal "/dev/null"))',
    '(deny network*)',
  ].join('\n');
}

/**
 * 从宿主Node的Mach-O加载命令解析传递依赖，仅返回现存的真实库文件。
 * 系统共享缓存已在策略内；rpath仅按Mach-O声明解析，不执行候选程序、不读取诊断报告或环境。
 */
function nodeLibraries(node: string): string[] {
  const pending = [node];
  const visited = new Set<string>();
  const libraries = new Set<string>();
  while (pending.length) {
    const file = pending.pop()!;
    if (visited.has(file)) continue;
    if (visited.size >= 256) throw new Error('Node动态库依赖超出解析上限');
    visited.add(file);
    const output = execFileSync('/usr/bin/otool', ['-L', file], { encoding: 'utf8', timeout: 5000, maxBuffer: 262144 });
    // dylib的首项是自身LC_ID_DYLIB，不是待解析的加载依赖。
    for (const line of output.split('\n').slice(file === node ? 1 : 2)) {
      const match = line.match(/^\s+(.+) \(compatibility version /);
      if (!match) continue;
      let path = match[1];
      if (path.startsWith('@loader_path/')) path = resolve(dirname(file), path.slice('@loader_path/'.length));
      if (path.startsWith('@executable_path/')) path = resolve(dirname(node), path.slice('@executable_path/'.length));
      if (path.startsWith('@rpath/')) {
        const commands = execFileSync('/usr/bin/otool', ['-l', file], { encoding: 'utf8', timeout: 5000, maxBuffer: 1048576 });
        const candidates: string[] = [];
        for (const entry of commands.matchAll(/cmd LC_RPATH\n\s+cmdsize \d+\n\s+path (.+) \(offset \d+\)/g)) {
          let base = entry[1];
          if (base.startsWith('@loader_path/')) base = resolve(dirname(file), base.slice('@loader_path/'.length));
          if (base.startsWith('@executable_path/')) base = resolve(dirname(node), base.slice('@executable_path/'.length));
          if (isAbsolute(base)) candidates.push(resolve(base, path.slice('@rpath/'.length)));
        }
        const found = candidates.find(
          // 只选择加载命令声明且实际存在的候选，不扫描宿主目录。
          (candidate) => existsSync(candidate),
        );
        if (!found) throw new Error('Node动态库rpath无法解析');
        path = found;
      }
      if (!isAbsolute(path)) throw new Error('Node动态库含未支持的加载路径');
      if (path.startsWith('/usr/') || path.startsWith('/System/')) continue;
      path = realpathSync(path);
      if (!lstatSync(path).isFile()) throw new Error('Node动态库不是普通文件');
      libraries.add(path); pending.push(path);
    }
  }
  return [...libraries].sort();
}

/** Linux 仅绑定系统运行库、Node 与只读候选；不共享宿主网络或临时目录。 */
function bubblewrapPolicy(root: string, temporary: string, nodeDirectory: string): string[] {
  const args = ['--unshare-all', '--die-with-parent', '--new-session', '--proc', '/proc', '--dev', '/dev', '--tmpfs', '/tmp'];
  for (const path of ['/usr', '/bin', '/sbin', '/lib', '/lib64']) {
    if (existsSync(path)) args.push('--ro-bind', path, path);
  }
  for (const path of ['/etc/ld.so.cache', '/etc/ld.so.conf']) {
    if (existsSync(path)) args.push('--ro-bind', path, path);
  }
  if (!nodeDirectory.startsWith('/usr/')) args.push('--ro-bind', nodeDirectory, nodeDirectory);
  args.push('--ro-bind', root, root, '--bind', temporary, temporary, '--chdir', root);
  return args;
}

/**
 * 持有单个候选目录和沙箱生命周期。写入只经精确白名单，代码运行时目录只读。
 * 不支持的平台或缺少 OS 隔离后端直接失败，没有降级为宿主执行的路径。
 */
export class DevelopmentExecution {
  readonly root: string;
  readonly isolation: 'seatbelt' | 'bwrap';
  private readonly filesystem: LocalFilesystem;
  private readonly writablePaths: Set<string>;
  private readonly checkFiles: string[];
  private readonly sandbox: LocalSandbox;
  private readonly resources: string;
  private readonly testTimeoutMs: number;
  private readonly commandTimeoutMs: number;
  private closed = false;

  /** 绑定已存在候选目录；调用者负责只在独占运行目录建立脱敏输入。 */
  constructor(root: string, writablePaths: string[], checkFiles: string[], limits: DevelopmentExecutionLimits = {}) {
    this.testTimeoutMs = boundedTimeout(limits.testTimeoutMs, defaultTestTimeoutMs, 'Node测试超时');
    this.commandTimeoutMs = boundedTimeout(limits.commandTimeoutMs, defaultCommandTimeoutMs, '检查进程超时');
    const nodeMajor = Number(process.versions.node.split('.')[0]);
    if (!Number.isInteger(nodeMajor) || nodeMajor < 24) throw new Error('研发执行需要 Node.js 24 或更高版本');
    if (!isAbsolute(root) || !existsSync(root) || lstatSync(root).isSymbolicLink()) throw new Error('候选根目录必须为已存在的绝对真实目录');
    this.root = realpathSync(root);
    if (!lstatSync(this.root).isDirectory()) throw new Error('候选根路径不是目录');
    this.writablePaths = new Set();
    for (const path of writablePaths) this.writablePaths.add(this.validatePath(path));
    this.checkFiles = [];
    for (const path of checkFiles) {
      const safe = this.validatePath(path);
      if (this.writablePaths.has(safe)) throw new Error('研发检查文件不得进入写入白名单');
      this.checkFiles.push(safe);
    }
    const detected = LocalSandbox.detectIsolation();
    if (!detected.available || (detected.backend !== 'seatbelt' && detected.backend !== 'bwrap')) throw new Error('研发执行需要可用 OS 隔离后端，拒绝无隔离执行');
    this.isolation = detected.backend;
    const libraries = this.isolation === 'seatbelt' ? nodeLibraries(realpathSync(process.execPath)) : [];
    this.resources = realpathSync(mkdtempSync(resolve(tmpdir(), 'mastra-development-execution-')));
    const temporary = resolve(this.resources, 'tmp');
    mkdirSync(temporary);
    const nodeDirectory = dirname(realpathSync(process.execPath));
    const nativeSandbox: NativeSandboxConfig = { allowNetwork: false, readOnly: true };
    if (this.isolation === 'seatbelt') {
      const profile = resolve(this.resources, 'strict.sb');
      writeFileSync(profile, seatbeltPolicy(this.root, temporary, nodeDirectory, libraries), { mode: 0o600 });
      nativeSandbox.seatbeltProfilePath = profile;
    } else nativeSandbox.bwrapArgs = bubblewrapPolicy(this.root, temporary, nodeDirectory);
    this.filesystem = new LocalFilesystem({ basePath: this.root, contained: true });
    this.sandbox = new LocalSandbox({
      workingDirectory: this.root, isolation: this.isolation, nativeSandbox, timeout: this.commandTimeoutMs,
      env: { PATH: `${nodeDirectory}:/usr/bin:/bin`, TMPDIR: temporary, NODE_ENV: 'test', OPENSSL_CONF: '/dev/null' },
    });
  }

  /** 拒绝越界、隐藏文件和任何层级符号链接；路径不做宽松归一化。 */
  private validatePath(path: string): string {
    if (this.closed) throw new Error('研发执行环境已关闭');
    if (!path || isAbsolute(path) || path.includes('\\') || path.includes('\0')) throw new Error('非法候选路径');
    const parts = path.split('/');
    if (parts.some(
      // 不允许点段或隐藏文件；.env、.git 等不会进入模型可读视图。
      (part) => !part || part === '..' || part.startsWith('.'),
    )) throw new Error('候选路径包含禁止段');
    const absolute = resolve(this.root, path);
    const child = relative(this.root, absolute);
    if (child.startsWith(`..${sep}`) || isAbsolute(child)) throw new Error('候选路径越界');
    let cursor = this.root;
    for (const part of parts) {
      cursor = resolve(cursor, part);
      if (lstatSync(cursor, { throwIfNoEntry: false })?.isSymbolicLink()) throw new Error('候选路径包含符号链接');
    }
    return path;
  }

  /** 列出候选真实文件；不遍历符号链接或隐藏资源，最多 200 个文件。 */
  async listFiles(): Promise<string[]> {
    if (this.closed) throw new Error('研发执行环境已关闭');
    const paths: string[] = [];
    /** 用原生文件 provider 遍历，每个条目重新应用当前权限边界。 */
    const visit = async (directory: string): Promise<void> => {
      if (directory.split('/').length > 20) throw new Error('候选目录层级超过试点上限');
      for (const entry of await this.filesystem.readdir(directory)) {
        if (entry.name.startsWith('.')) continue;
        const path = directory ? `${directory}/${entry.name}` : entry.name;
        this.validatePath(path);
        if (entry.isSymlink) throw new Error('候选目录包含符号链接');
        if (entry.type === 'directory') await visit(path);
        else paths.push(path);
        if (paths.length > 200) throw new Error('候选文件数超过试点上限');
      }
    };
    await visit('');
    return paths.sort();
  }

  /** 读取单个脱敏候选文件，返回纯文本，不开放宿主绝对路径。 */
  async readFile(path: string): Promise<string> {
    const safe = this.validatePath(path);
    const value = await this.filesystem.readFile(safe, { encoding: 'utf8' });
    if (Buffer.byteLength(value) > maxBytes) throw new Error('候选文件过大');
    return String(value);
  }

  /** 写入架构批准的精确文件集合；公共 smoke 和隐藏验收不在白名单。 */
  async writeFile(path: string, content: string): Promise<void> {
    const safe = this.validatePath(path);
    if (!this.writablePaths.has(safe)) throw new Error('候选文件不在写入白名单');
    if (Buffer.byteLength(content) > maxBytes) throw new Error('候选文件过大');
    await this.filesystem.writeFile(safe, content, { recursive: true });
  }

  /** 对当前所有可读文件建立散列，用于绑定实际实现与检查结果。 */
  async snapshot(): Promise<Record<string, string>> {
    const result: Record<string, string> = Object.create(null);
    for (const path of await this.listFiles()) result[path] = createHash('sha256').update(await this.readFile(path)).digest('hex');
    return result;
  }

  /** 顺序运行固定 Node 语法检查和已登记 smoke，不接收模型 shell 字符串。 */
  async runChecks(): Promise<DevelopmentCheckResult[]> {
    const results: DevelopmentCheckResult[] = [];
    const before = await this.snapshot();
    const files = await this.listFiles();
    for (const path of files) {
      if (path.startsWith('src/') && path.endsWith('.mjs')) results.push(await this.run('syntax:' + path, ['--check', path]));
      if (results.at(-1) && results.at(-1)!.exitCode === 0 && (await this.snapshotHash()) !== developmentSnapshotHash(before)) throw new Error('语法检查期间候选源码发生变化');
    }
    for (const path of this.checkFiles) {
      this.validatePath(path);
      results.push(await this.run('test:' + path, ['--test', '--test-reporter=tap', `--test-timeout=${this.testTimeoutMs}`, path]));
      if ((await this.snapshotHash()) !== developmentSnapshotHash(before)) throw new Error('冒烟检查期间候选源码发生变化');
    }
    if (!results.length) throw new Error('没有可执行的研发检查');
    return results;
  }

  /** 为检查期间的漂移提供稳定比较值，避免把同一文件顺序差异当作变化。 */
  private async snapshotHash(): Promise<string> {
    return developmentSnapshotHash(await this.snapshot());
  }

  /** 宿主固定 argv 与有界时间/16 KiB输出预算，只返回实际进程证据。 */
  private async run(id: string, args: string[]): Promise<DevelopmentCheckResult> {
    if (this.closed) throw new Error('研发执行环境已关闭');
    const node = realpathSync(process.execPath);
    const argv = ['--max-old-space-size=128', ...args];
    const result = await this.sandbox.executeCommand!(node, argv, { timeout: this.commandTimeoutMs, maxRetainedBytes: 16384 });
    const isTest = id.startsWith('test:');
    const output = `${result.stdout}\n${result.stderr}`;
    const tests = isTest ? output.match(/^# tests\s+(\d+)\s*$/m)?.[1] : undefined;
    const passes = isTest ? output.match(/^# pass\s+(\d+)\s*$/m)?.[1] : undefined;
    const failures = isTest ? output.match(/^# fail\s+(\d+)\s*$/m)?.[1] : undefined;
    const executedTests = isTest ? [...output.matchAll(/^ok \d+ - ([^\r\n]+)$/gm)].filter(
      // Node会把没有运行test()便退出的文件记为文件级通过，必须排除这类占位记录。
      (entry) => ![args.at(-1), resolve(this.root, args.at(-1)!)].includes(entry[1]),
    ) : [];
    const summaryValid = !isTest || Boolean(tests && passes && Number(tests) > 0 && tests === passes && failures === '0' && executedTests.length > 0);
    const truncated = Boolean(result.stdoutTruncated || result.stderrTruncated);
    const evidenceError = result.timedOut || truncated || !summaryValid;
    return { id, command: `node ${argv.join(' ')}`, processExitCode: result.exitCode, exitCode: evidenceError ? (result.exitCode === 0 ? 1 : result.exitCode) : result.exitCode, stdout: result.stdout,
      stderr: `${result.stderr}${evidenceError ? `\n研发检查证据无效：${result.timedOut ? '超时' : truncated ? '输出超限' : '缺少具名测试执行记录'}` : ''}`, durationMs: result.executionTimeMs, timedOut: result.timedOut ?? false,
      stdoutTruncated: Boolean(result.stdoutTruncated), stderrTruncated: Boolean(result.stderrTruncated) };
  }

  /** 释放原生沙箱及独占临时数据；候选代码保留给研发交付与外部评测。 */
  async close(): Promise<void> {
    if (this.closed) return;
    try { await this.sandbox.destroy(); }
    finally {
      this.closed = true;
      rmSync(this.resources, { recursive: true, force: true });
    }
  }
}

/** 将文件散列对象转成稳定摘要，供检查前后漂移检测使用。 */
function developmentSnapshotHash(snapshot: Record<string, string>): string {
  return createHash('sha256').update(JSON.stringify(Object.entries(snapshot).sort())).digest('hex');
}
