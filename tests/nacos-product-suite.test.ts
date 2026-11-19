/** 完整产品方法集打包及 Mastra/Nacos Adapter 端到端隔离验证。 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { loadNacosSnapshot, verifyNacosAccess } from '../src/mastra/nacos-resources.js';
import { createAgents } from '../src/mastra/agents/index.js';

test('113 项真实产品 Skill 包可全部通过版本读取、快照和原生 Agent 装配', /** 本地 HTTP 只模拟注册中心协议，不代表远端发布或质量审批。 */async () => {
  const directory = mkdtempSync(join(tmpdir(), 'nacos-product-suite-'));
  const destination = join(directory, 'export');
  execFileSync(process.execPath, ['--import', 'tsx', 'scripts/prepare-nacos-product-skills.ts', destination, '1.1.0'], { cwd: resolve('.') });
  const manifest = JSON.parse(readFileSync(join(destination, 'manifest.json'), 'utf8')) as {
    prompts: { name: string; version: string; source: string }[];
    reviewerSkills: string[];
    skills: { name: string; version: string; archive: string; files: { path: string }[] }[];
  };
  assert.equal(manifest.skills.length, 113);
  const [manager, reviewer] = manifest.prompts;
  assert.ok(manager && reviewer);
  const packages = new Map(manifest.skills.map(/** 显式映射资源名称及包，拒绝未知资源。 */skill => [skill.name, skill]));
  const server = createServer(/** 通过回环地址提供导出的候选 Prompt 与 Skill。 */(request, response) => {
    const url = new URL(request.url!, 'http://localhost');
    if (url.pathname.endsWith('/login')) { response.end(JSON.stringify({ accessToken: 'fixture' })); return; }
    const prompt = manifest.prompts.find(item => item.name === url.searchParams.get('promptKey'));
    if (url.pathname.endsWith('/prompt') && prompt) {
      response.end(JSON.stringify({ code: 0, data: { promptKey: prompt.name, version: prompt.version, template: readFileSync(prompt.source, 'utf8') } }));
      return;
    }
    const resource = packages.get(url.searchParams.get('name') ?? '');
    if (url.pathname.endsWith('/skills') && resource) { response.setHeader('x-nacos-skill-resolved-version', resource.version); response.end(readFileSync(join(destination, resource.archive))); return; }
    response.writeHead(404).end();
  });
  await new Promise<void>(/** 只绑定本机随机端口。 */ready => server.listen(0, '127.0.0.1', ready));
  try {
    const address = server.address(); assert.ok(address && typeof address !== 'string');
    const [first, ...rest] = manifest.skills; assert.ok(first);
    const config = {
      url: `http://127.0.0.1:${address.port}`, namespace: 'fixture', username: 'fixture', password: 'fixture',
      promptName: manager.name, promptVersion: manager.version, reviewerPrompt: { name: reviewer.name, version: reviewer.version },
      skillName: first.name, skillVersion: first.version, reviewerSkills: manifest.reviewerSkills,
      additionalSkills: rest.map(/** 每项锁定名称和精确版本。 */skill => ({ name: skill.name, version: skill.version })),
    };
    const snapshot = await loadNacosSnapshot(config);
    const frozenSkills = [snapshot.skill, ...(snapshot.additionalSkills ?? [])];
    assert.equal(frozenSkills.length, 113);
    for (const skill of frozenSkills) {
      const original = packages.get(skill.name)!;
      assert.deepEqual(Object.keys(skill.references).sort(), original.files.filter(/** 对照原文件，确保参考资料完整。 */file => file.path.startsWith('references/')).map(/** 适配器存储 references 相对路径。 */file => file.path.slice('references/'.length)).sort());
    }
    await verifyNacosAccess(config, snapshot);
    const agents = createAgents({ rootDir: resolve('.'), mode: 'fixture', databaseUrl: 'file::memory:', port: 4111, modelId: 'openai/fixture' }, { resources: snapshot, workspace: false });
    assert.equal((await agents.productManagerAgent.listSkills()).length, 113);
    const reviewerSkills = await agents.productReviewerAgent.listSkills();
    assert.equal(reviewerSkills.length, manifest.reviewerSkills.length);
    assert.ok(reviewerSkills.some(/** 审查角色必须能发现与产品经理共用的版式 Skill。 */skill => skill.name === 'product-requirements-handoff'));
    const layout = frozenSkills.find(skill => skill.name === 'product-requirements-handoff')?.references['document-layout.md'];
    assert.match(layout ?? '', /状态流转用表格[\s\S]*处理结果按业务阶段分组[\s\S]*顺序流程用编号列表/);
  } finally {
    await new Promise<void>(/** 关闭隔离服务。 */done => server.close(() => done()));
    rmSync(directory, { recursive: true, force: true });
  }
});
