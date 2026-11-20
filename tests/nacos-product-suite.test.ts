/** 精简产品方法集打包及 Mastra/Nacos Adapter 端到端隔离验证。 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { loadNacosSnapshot, verifyNacosAccess } from '../src/mastra/nacos-resources.js';
import { createAgents } from '../src/mastra/agents/index.js';
import { readNacosConfig } from '../src/mastra/config.js';

test('6 项真实产品 Skill 包可全部通过版本读取、快照和原生 Agent 装配', /** 本地 HTTP 只模拟注册中心协议，不代表远端发布或质量审批。 */async () => {
  const directory = mkdtempSync(join(tmpdir(), 'nacos-product-suite-'));
  const destination = join(directory, 'export');
  const { version } = JSON.parse(readFileSync('nacos-resources/product/manifest.json', 'utf8')) as { version: string };
  execFileSync(process.execPath, ['--import', 'tsx', 'scripts/prepare-nacos-product-skills.ts', destination, version], { cwd: resolve('.') });
  const manifest = JSON.parse(readFileSync(join(destination, 'manifest.json'), 'utf8')) as {
    prompts: { name: string; version: string; source: string }[];
    alignmentSource: { name: string; commit: string; files: Record<string, string> };
    reviewerSkills: string[];
    skills: { name: string; version: string; archive: string; files: { path: string; sha256: string }[] }[];
  };
  const expectedSkills = ['product-pm-product-requirements-alignment', 'product-requirements-handoff', 'product-pm-create-prd', 'product-pm-user-stories', 'product-pm-test-scenarios', 'product-pm-strategy-red-team'];
  const expectedReviewerSkills = ['product-pm-product-requirements-alignment', 'product-requirements-handoff', 'product-pm-test-scenarios', 'product-pm-strategy-red-team'];
  assert.deepEqual(manifest.skills.map(/** 对照候选包中实际打包的资源。 */skill => skill.name), expectedSkills);
  assert.deepEqual(manifest.reviewerSkills, expectedReviewerSkills);
  const [manager, reviewer] = manifest.prompts;
  assert.ok(manager && reviewer);
  const alignment = manifest.alignmentSource;
  assert.equal(alignment.name, 'product-pm-product-requirements-alignment');
  assert.match(alignment.commit, /^[a-f0-9]{40}$/);
  const packages = new Map(manifest.skills.map(/** 显式映射资源名称及包，拒绝未知资源。 */skill => [skill.name, skill]));
  assert.deepEqual(Object.fromEntries(packages.get(alignment.name)!.files.map(/** 保留公司 Skill 的原始逐文件摘要。 */file => [file.path, file.sha256])), alignment.files);
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
    const bindings = JSON.parse(readFileSync(join(destination, 'runtime-bindings.json'), 'utf8'));
    const config = readNacosConfig({ ...bindings, NACOS_URL: `http://127.0.0.1:${address.port}`, NACOS_NAMESPACE: 'fixture', NACOS_USERNAME: 'fixture', NACOS_PASSWORD: 'fixture' });
    assert.ok(config);
    const snapshot = await loadNacosSnapshot(config);
    const frozenSkills = [snapshot.skill, ...(snapshot.additionalSkills ?? [])];
    assert.deepEqual(frozenSkills.map(/** 校验只有启用资源进入快照。 */skill => skill.name), expectedSkills);
    assert.ok(frozenSkills.every(/** 每项候选资源按清单版本冻结。 */skill => skill.version === version));
    for (const skill of frozenSkills) {
      const original = packages.get(skill.name)!;
      assert.deepEqual(Object.keys(skill.references).sort(), original.files.filter(/** 对照原文件，确保参考资料完整。 */file => file.path.startsWith('references/')).map(/** 适配器存储 references 相对路径。 */file => file.path.slice('references/'.length)).sort());
    }
    await verifyNacosAccess(config, snapshot);
    const agents = createAgents({ rootDir: resolve('.'), mode: 'fixture', databaseUrl: 'file::memory:', port: 4111, modelId: 'openai/fixture' }, { resources: snapshot, workspace: false });
    const managerSkills = await agents.productManagerAgent.listSkills();
    assert.deepEqual(managerSkills.map(/** 比较经理实际发现的集合。 */skill => skill.name).sort(), [...expectedSkills].sort());
    const reviewerSkills = await agents.productReviewerAgent.listSkills();
    assert.deepEqual(reviewerSkills.map(/** 比较审查角色实际发现的集合。 */skill => skill.name).sort(), [...expectedReviewerSkills].sort());
    const alignmentSkill = frozenSkills.find(/** 检查新方法的精确版本及正式写作参考。 */skill => skill.name === alignment.name);
    assert.equal(alignmentSkill?.version, manifest.prompts[0]!.version);
    assert.match(alignmentSkill?.references['delivery-writing.md'] ?? '', /面向用户的正式交付准则/);
    for (const prompt of [snapshot.prompt, snapshot.reviewerPrompt]) {
      assert.match(prompt?.content ?? '', /product-pm-product-requirements-alignment[^\n]+references\/delivery-writing\.md/);
    }
    const layout = frozenSkills.find(skill => skill.name === 'product-requirements-handoff')?.references['document-layout.md'];
    assert.match(layout ?? '', /状态流转用表格[\s\S]*处理结果按业务阶段分组[\s\S]*顺序流程用编号列表/);
    assert.match(layout ?? '', /产品规格任务[\s\S]*TASK-SKIP-ACTUAL-START[\s\S]*REQ-SKIP-ACTUAL-START/);
  } finally {
    await new Promise<void>(/** 关闭隔离服务。 */done => server.close(() => done()));
    rmSync(directory, { recursive: true, force: true });
  }
});
