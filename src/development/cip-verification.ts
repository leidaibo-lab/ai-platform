/** 为 HRM CIP 验证装配固定 Git 工程，不向候选暴露宿主环境。 */
import { execFileSync } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { cipGit, engineeringRevisionSchema, isCipRevision } from '../business-engineering/hrm-cip.js';
import { canWriteProjectPath, type DevelopmentInput } from './contracts.js';
import { dockerCheck } from './hrm-verification.js';

const dockerfile = `FROM node:24-bookworm-slim AS dependencies
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1 HUSKY=0 CI=1
RUN apt-get update && apt-get install --yes --no-install-recommends openssl ca-certificates git && rm -rf /var/lib/apt/lists/*
RUN npm install --global pnpm@12.9.1
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/api/package.json apps/api/package.json
COPY apps/web/package.json apps/web/package.json
COPY packages/shared/package.json packages/shared/package.json
RUN pnpm install --frozen-lockfile --ignore-scripts
FROM dependencies AS checked
COPY . .
ENV DATABASE_URL=postgresql://unused:unused@127.0.0.1:1/unused
RUN --network=none git init --quiet && git add -A && pnpm audit:drift && pnpm lint && pnpm exec tsc -p tsconfig.json
RUN --network=none pnpm --filter @cip/api generate && pnpm --filter @cip/api export:openapi && OPENAPI_INPUT=../api/node_modules/.tmp/openapi.json pnpm --filter @cip/web codegen
RUN --network=none pnpm --filter @cip/shared typecheck && pnpm --filter @cip/api typecheck:ci && pnpm --filter @cip/web typecheck:ci && pnpm --filter @cip/shared test && pnpm --filter @cip/api test:unit && pnpm --filter @cip/web test
FROM checked AS verified
RUN --network=none pnpm build
`;

/** 只从已批准的提交导出常规文件，随后叠加通过项目写入检查的候选变化。 */
function stageCip(root: string, project: DevelopmentInput['project'], files: Record<string, string>, directory: string) {
  const revision = engineeringRevisionSchema.parse(project.engineeringRevision);
  if (!isCipRevision(root, revision)) throw new Error('固定工程版本不匹配 CIP 执行档');
  const tree = cipGit(root, ['ls-tree', '-r', '-z', revision]).split('\0').filter(Boolean);
  if (!tree.length || tree.length > 2000 || tree.some(entry => !/^100(?:644|755) blob [a-f0-9]{40}\t[\p{L}a-zA-Z0-9_./()\[\]-]+$/u.test(entry) || /(?:^|\/)(?:\.env(?!\.example$)[^/]*|\.npmrc|[^/]+\.(?:pem|key))$/i.test(entry.split('\t')[1]!))) throw new Error('CIP 基线含不可导出的文件');
  const archive = execFileSync('git', ['--no-replace-objects', '-C', root, 'archive', '--format=tar', revision], { timeout: 20000, maxBuffer: 24 * 1024 * 1024 });
  execFileSync('tar', ['-xf', '-', '-C', directory], { input: archive, timeout: 15000 });
  for (const [path, body] of Object.entries(files)) {
    if (Object.hasOwn(project.files, path) && project.files[path] === body) continue;
    if (!canWriteProjectPath(project, path)) throw new Error('CIP 候选修改了受保护文件');
    const destination = join(directory, path);
    if (existsSync(destination) && !Object.hasOwn(project.files, path)) {
      if (readFileSync(destination, 'utf8') === body) continue;
      throw new Error('CIP 新增路径与已批准 Git 基线的现有文件冲突');
    }
    mkdirSync(dirname(destination), { recursive: true });
    writeFileSync(destination, body);
  }
}

/** 使用内网服务运行数据库迁移和独立探针，不挂载宿主文件或端口。 */
function smokeServices(image: string) {
  const database = 'postgresql://cip:synthetic-only@db:5432/cip';
  const base = { image, networks: ['verification'], cap_drop: ['ALL'], security_opt: ['no-new-privileges:true'], pids_limit: 220 };
  const environment = { DATABASE_URL: database, REDIS_URL: 'redis://redis:6379', CREDENTIAL_MASTER_KEY: randomBytes(32).toString('base64') };
  return { services: {
    db: { image: 'pgvector/pgvector:pg16', networks: ['verification'], tmpfs: ['/var/lib/postgresql/data'], environment: { POSTGRES_USER: 'cip', POSTGRES_PASSWORD: 'synthetic-only', POSTGRES_DB: 'cip' }, healthcheck: { test: ['CMD', 'pg_isready', '-U', 'cip'], interval: '2s', timeout: '3s', retries: 25 } },
    redis: { image: 'redis:7-alpine', networks: ['verification'], healthcheck: { test: ['CMD', 'redis-cli', 'ping'], interval: '2s', timeout: '3s', retries: 25 } },
    api: { ...base, environment, depends_on: { db: { condition: 'service_healthy' }, redis: { condition: 'service_healthy' } }, command: ['sh', '-ec', 'pnpm --filter @cip/api exec prisma migrate deploy && exec pnpm --filter @cip/api start'], healthcheck: { test: ['CMD', 'node', '-e', "fetch('http://127.0.0.1:3011/readyz').then(r=>process.exit(r.ok?0:1))"], interval: '3s', timeout: '4s', retries: 30 } },
    web: { ...base, command: ['pnpm', '--filter', '@cip/web', 'start'] },
    smoke: { ...base, environment: { DATABASE_URL: database, TEST_DATABASE_URL: database }, depends_on: { api: { condition: 'service_healthy' }, web: { condition: 'service_started' } }, command: ['sh', '-ec', `pnpm --filter @cip/api exec vitest run src/__tests__/persistence.spec.ts && node -e 'async function probe(){for(let i=0;i<20;i++){try{if((await fetch("http://web:3000/login")).ok)return}catch{}await new Promise(r=>setTimeout(r,1000))}process.exitCode=1}probe()'`] },
  }, networks: { verification: { internal: true } } };
}

/** 运行登记的检查、构建和联通验证，任何失败都会阻断真实交付。 */
export async function verifyCip(root: string, project: DevelopmentInput['project'], files: Record<string, string>) {
  const directory = mkdtempSync(join(tmpdir(), 'mastra-cip-'));
  const checkout = join(directory, 'context');
  const name = `mastra-cip-${randomUUID().slice(0, 8)}`;
  const image = `${name}:verified`;
  const compose = join(directory, 'compose.json');
  const recipe = join(directory, 'Verification.Dockerfile');
  const results: Awaited<ReturnType<typeof dockerCheck>>[] = [];
  try {
    mkdirSync(checkout);
    stageCip(root, project, files, checkout);
    writeFileSync(recipe, dockerfile);
    const args = ['build', '--progress=plain', '-f', recipe];
    results.push(await dockerCheck('project:check', [...args, '--no-cache-filter', 'checked', '--target', 'checked', checkout], directory, 600000));
    if (results.at(-1)?.exitCode !== 0) return results;
    results.push(await dockerCheck('project:build', [...args, '--no-cache-filter', 'verified', '--target', 'verified', '-t', image, checkout], directory, 600000));
    if (results.at(-1)?.exitCode !== 0) return results;
    writeFileSync(compose, JSON.stringify(smokeServices(image)), { mode: 0o600 });
    results.push(await dockerCheck('project:smoke', ['compose', '-p', name, '-f', compose, 'run', '--rm', 'smoke'], directory, 240000));
    return results;
  } finally {
    if (existsSync(compose)) await dockerCheck('cleanup', ['compose', '-p', name, '-f', compose, 'down', '--volumes', '--remove-orphans', '--timeout', '5'], directory, 45000);
    rmSync(directory, { recursive: true, force: true });
  }
}
