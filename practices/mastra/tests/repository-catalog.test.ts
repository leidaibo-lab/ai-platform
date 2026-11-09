/** 已授权仓库目录只读关联与安全边界回归，不访问真实凭据。 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { readRepositoryCatalog } from '../src/intake/repository-catalog.js';
import { assembleRepositoryProject } from '../src/intake/repository-project.js';
import { createIntakeRoutes } from '../src/intake/routes.js';
import { Hono, type Handler } from 'hono';

test('仓库关联：真实分支/模块/文件/检查自动识别，隐藏文件与链接拒绝，内容变化使版本失效', /** 构造独占Git仓库，不运行仓库脚本。 */async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'hrm-catalog-')));
  /** 仅在本测试根内写入合成文件。 */
  function file(path: string, text: string) { const full = join(root, path); mkdirSync(join(full, '..'), { recursive: true }); writeFileSync(full, text); }
  try {
    execFileSync('git', ['init', '-b', 'main', root], { stdio: 'ignore' });
    execFileSync('git', ['-C', root, 'remote', 'add', 'origin', 'https://github.com/leidaibo-lab/hrm.git']);
    file('package.json', JSON.stringify({ name: 'hrm', scripts: { check: 'pnpm -r check', build: 'pnpm -r build', smoke: 'node scripts/smoke.mjs' } }));
    file('apps/web/src/page.tsx', 'export const page=1;'); file('apps/api/src/main.ts', 'export const api=1;'); file('packages/database/schema.prisma', '// synthetic'); file('apps/web/.env', 'synthetic-not-a-secret'); file('apps/web/node_modules/private.ts', 'synthetic');
    symlinkSync(join(root, 'apps/web/.env'), join(root, 'apps/web/src/link.ts'));
    execFileSync('git', ['-C', root, 'add', 'package.json']);
    execFileSync('git', ['-C', root, '-c', 'user.name=fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-m', 'test(hrm): 合成仓库'], { stdio: 'ignore' });
    const catalog = readRepositoryCatalog(root); assert.equal(catalog.available, true); if (!catalog.available) return;
    assert.equal(catalog.branch, 'main'); assert.equal(typeof catalog.executionReady, 'boolean'); assert.ok(catalog.checks.every(/** 检查能力由宿主固定配置，不再要求手工上传。 */check => check.ready));
    assert.deepEqual(catalog.checks.map(/** 只接受真实登记命令名称。 */check => check.id), ['check', 'build', 'smoke']);
    assert.ok(catalog.files.some(/** TSX源码正常进入清单。 */item => item.path === 'apps/web/src/page.tsx'));
    assert.ok(!catalog.files.some(/** 链接、依赖与.env都不能进入清单或读取。 */item => /\.env|node_modules|link\.ts/.test(item.path)));
    file('apps/web/src/page.tsx', 'export const page=2;');
    const changed = readRepositoryCatalog(root); assert.ok(changed.available && changed.catalogHash !== catalog.catalogHash);
    const router = new Hono(); for (const route of createIntakeRoutes({} as any, 'fixture', root)) if ('handler' in route) router.on(route.method, route.path, route.handler as Handler);
    const response = await router.request('/intake-api/project?directory=/etc'); assert.equal(response.status, 200); assert.equal(response.headers.get('cache-control'), 'no-store');
    const json = await response.json(); assert.equal(json.id, 'hrm'); assert.equal('root' in json, false); assert.equal('content' in json.files[0], false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('未配置或非授权仓库不能通过任意路径打开', /** 业务入口只能使用服务端预配置仓库。 */() => {
  assert.equal(readRepositoryCatalog().available, false);
  assert.throws(/** 当前平台仓库不是HRM授权源。 */() => readRepositoryCatalog(process.cwd()));
});

test('只有产品资料的项目可交接只读规划，具体工程缺口随快照保存且旧清单不能提交', /** 复现没有package.json和任何源码的实际关联仓库。 */() => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'hrm-preparation-')));
  try {
    execFileSync('git', ['init', '-b', 'main', root], { stdio: 'ignore' });
    execFileSync('git', ['-C', root, 'remote', 'add', 'origin', 'https://github.com/leidaibo-lab/hrm.git']);
    writeFileSync(join(root, 'README.md'), '# 合成产品资料仓库');
    execFileSync('git', ['-C', root, 'add', 'README.md']);
    execFileSync('git', ['-C', root, '-c', 'user.name=fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-m', 'test(hrm): 产品资料基线'], { stdio: 'ignore' });
    const catalog = readRepositoryCatalog(root); assert.ok(catalog.available); if (!catalog.available) return;
    assert.equal(catalog.executionReady, false); assert.equal(catalog.checks.length, 0);
    assert.ok(catalog.preparationIssues.includes('缺少可读取的工程文件：package.json'));
    assert.ok(!catalog.preparationIssues.some(/** 没有清单不能推断包管理器版本错误。 */issue => issue.includes('packageManager')));
    const project = assembleRepositoryProject(root, catalog.catalogHash);
    assert.deepEqual(project.writablePaths, []); assert.deepEqual(project.checkFiles, ['README.md']);
    assert.deepEqual(project.preparationIssues, catalog.preparationIssues); assert.equal(project.planning, 'agent');
    writeFileSync(join(root, 'package.json'), JSON.stringify({ packageManager: 'pnpm@10.6.0', scripts: { check: ' ', build: 'build' } }));
    assert.throws(/** 工程准备变化必须重新确认，不能沿用旧页面版本。 */() => assembleRepositoryProject(root, catalog.catalogHash), /版本已变化/);
    const changed = readRepositoryCatalog(root); assert.ok(changed.available); if (!changed.available) return;
    assert.ok(changed.preparationIssues.includes('package.json 缺少固定检查脚本：check'));
    assert.ok(changed.preparationIssues.includes('package.json 缺少固定检查脚本：smoke'));
  } finally { rmSync(root, { recursive: true, force: true }); }
});
