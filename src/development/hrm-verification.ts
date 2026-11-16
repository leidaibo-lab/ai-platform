/** Docker/Compose 固定验证Adapter；只运行脱敏候选，不挂宿主目录或Docker socket。 */
import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import type { DevelopmentCheckResult } from '../development-execution.js';
const dockerfile = `FROM node:24.19.0-bookworm-slim AS dependencies
ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
ENV NEXT_TELEMETRY_DISABLED=1
WORKDIR /app
RUN apt-get update && apt-get install --yes --no-install-recommends openssl ca-certificates && rm -rf /var/lib/apt/lists/*
RUN npm install --global pnpm@10.6.0
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/api/package.json apps/api/package.json
COPY apps/web/package.json apps/web/package.json
COPY packages/database/package.json packages/database/package.json
RUN pnpm install --frozen-lockfile
FROM dependencies AS checked
COPY . .
RUN --network=none pnpm check
FROM checked AS verified
ENV API_INTERNAL_URL=http://api:3001
RUN --network=none pnpm build
`;
/** 用实际进程退出、时长和有界日志形成证据，命令从宿主常量生成。 */
async function command(id: string, args: string[], cwd: string, timeoutMs: number): Promise<DevelopmentCheckResult> {
  const start = Date.now(); let stdout = ''; let stderr = ''; let truncated = false; let timedOut = false;
  return new Promise(/** 每个固定命令独立预算和结果。 */resolve => {
    const child = spawn('docker', ['--context', 'desktop-linux', ...args], { cwd, env: { PATH: process.env.PATH, HOME: process.env.HOME, DOCKER_CONFIG: process.env.DOCKER_CONFIG, NEXT_TELEMETRY_DISABLED: '1' }, stdio: ['ignore', 'pipe', 'pipe'] });
    /** 限制日志体积，不让候选输出耗尽宿主内存。 */
    function retain(chunk: Buffer, target: 'stdout' | 'stderr') { const text = chunk.toString(); if (target === 'stdout') stdout += text; else stderr += text; if (stdout.length + stderr.length > 200000) { truncated = true; stdout = stdout.slice(0, 100000); stderr = stderr.slice(0, 100000); } }
    child.stdout.on('data', /** 保留公开构建日志。 */chunk => retain(chunk, 'stdout')); child.stderr.on('data', /** 保留公开错误证据。 */chunk => retain(chunk, 'stderr'));
    const timer = setTimeout(/** 超时后停止Docker CLI，Compose资源在外层finally清理。 */() => { timedOut = true; child.kill('SIGKILL'); }, timeoutMs);
    child.on('error', /** Docker不可用作为明确失败，不回退宿主。 */error => { stderr += error.message; });
    child.on('close', /** 无效/截断证据不能通过质量门。 */code => { clearTimeout(timer); resolve({ id, command: `docker ${args.join(' ')}`, exitCode: code === 0 && !truncated && !timedOut ? 0 : code || 1, processExitCode: code ?? 1, stdout, stderr, timedOut, durationMs: Date.now() - start, stdoutTruncated: truncated, stderrTruncated: truncated }); });
  });
}
/** 只在独占临时目录构建源快照，check/build禁网，smoke只连隔离测试数据库。 */
export async function verifyHrm(files: Record<string, string>): Promise<DevelopmentCheckResult[]> {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'mastra-hrm-check-')));
  const project = `mastra-hrm-${randomUUID().slice(0, 8)}`;
  const digest = createHash('sha256').update(JSON.stringify(Object.entries(files).sort())).digest('hex').slice(0, 20);
  const image = `mastra-hrm-verified:${digest}`; const results: DevelopmentCheckResult[] = [];
  const composePath = join(directory, 'verification.compose.json');
  try {
    for (const [path, content] of Object.entries(files)) {
      if (!/^[a-zA-Z0-9_./-]+$/.test(path) || path.split('/').some(/** 拒绝点段、隐藏文件和路径逃逸。 */part => !part || part.startsWith('.'))) throw new Error('非法HRM验证文件');
      const destination = join(directory, path); mkdirSync(dirname(destination), { recursive: true }); writeFileSync(destination, content);
    }
    writeFileSync(join(directory, 'Verification.Dockerfile'), dockerfile);
    const dbUrl = 'postgresql://hrm:synthetic-only@db:5432/hrm';
    const base = { image, networks: ['verification'], cap_drop: ['ALL'], security_opt: ['no-new-privileges:true'], pids_limit: 200 };
    writeFileSync(composePath, JSON.stringify({ services: {
      db: { image: 'postgres:17-bookworm', environment: { POSTGRES_USER: 'hrm', POSTGRES_PASSWORD: 'synthetic-only', POSTGRES_DB: 'hrm' }, networks: ['verification'], tmpfs: ['/var/lib/postgresql/data'], mem_limit: '256m', healthcheck: { test: ['CMD-SHELL', 'pg_isready -U hrm -d hrm'], interval: '2s', timeout: '3s', retries: 30 } },
      api: { ...base, command: ['pnpm', '--filter', '@hrm/api', 'start'], environment: { DATABASE_URL: dbUrl }, depends_on: { db: { condition: 'service_healthy' } }, mem_limit: '512m', healthcheck: { test: ['CMD', 'node', '--input-type=module', '-e', "const r=await fetch('http://127.0.0.1:3001/api/health/ready');process.exit(r.ok?0:1)"], interval: '2s', timeout: '5s', retries: 30 } },
      web: { ...base, command: ['pnpm', '--filter', '@hrm/web', 'start'], depends_on: { api: { condition: 'service_healthy' } }, mem_limit: '768m', healthcheck: { test: ['CMD', 'node', '--input-type=module', '-e', "const r=await fetch('http://127.0.0.1:3000');process.exit(r.ok?0:1)"], interval: '2s', timeout: '5s', retries: 30 } },
      smoke: { ...base, command: ['node', 'scripts/smoke.mjs'], environment: { HRM_BASE_URL: 'http://web:3000' }, depends_on: { web: { condition: 'service_healthy' } }, mem_limit: '256m' },
    }, networks: { verification: { internal: true } } }));
    const check = await command('project:check', ['build', '--progress=plain', '--no-cache-filter', 'checked', '--target', 'checked', '-f', 'Verification.Dockerfile', '-t', `mastra-hrm-checked:${digest}`, '.'], directory, 600000); results.push(check); if (check.exitCode !== 0) return results;
    const build = await command('project:build', ['build', '--progress=plain', '--no-cache-filter', 'verified', '--target', 'verified', '-f', 'Verification.Dockerfile', '-t', image, '.'], directory, 600000); results.push(build); if (build.exitCode !== 0) return results;
    results.push(await command('project:smoke', ['compose', '-p', project, '-f', composePath, 'run', '--rm', 'smoke'], directory, 180000));
    return results;
  } finally {
    await command('cleanup', ['compose', '-p', project, '-f', composePath, 'down', '--volumes', '--remove-orphans', '--timeout', '5'], directory, 45000);
    rmSync(directory, { recursive: true, force: true });
  }
}
