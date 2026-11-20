/** 注册器只在模拟的本地 Nacos 上验证幂等、内容校验及拒绝覆盖。 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { readSkillZip } from '../src/mastra/nacos-resources.js';

test('本机注册可重复执行，同版本不同内容不覆盖', /** 通过真实进程和 HTTP 验证发布器边界。 */async () => {
  const directory = mkdtempSync(join(tmpdir(), 'nacos-import-'));
  const exportPath = join(directory, 'export');
  const { version } = JSON.parse(readFileSync('nacos-resources/product/manifest.json', 'utf8')) as { version: string };
  execFileSync(process.execPath, ['--import', 'tsx', 'scripts/prepare-nacos-product-skills.ts', exportPath, version]);
  const manifest = JSON.parse(readFileSync(join(exportPath, 'manifest.json'), 'utf8'));
  manifest.skills = manifest.skills.slice(0, 1);
  writeFileSync(join(exportPath, 'manifest.json'), JSON.stringify(manifest));
  const [candidate] = manifest.skills;
  const normalizedZip = join(directory, 'normalized.zip');
  execFileSync('unzip', ['-q', join(exportPath, candidate.archive), '-d', directory]);
  const folder = candidate.name.slice('product-pm-'.length);
  const skillFile = join(directory, folder, 'SKILL.md');
  const localMarkdown = readFileSync(skillFile, 'utf8');
  writeFileSync(skillFile, localMarkdown.replace(/^  version: .*$/m, `  version: ${version}`));
  execFileSync('zip', ['-qr', normalizedZip, folder], { cwd: directory });
  const normalizedArchive = readFileSync(normalizedZip);
  const prompts = new Map<string, { template: string; online: boolean }>();
  const skills = new Map<string, { archive: Buffer; status: string }>();
  let uploads = 0;
  let writes = 0;
  const server = createServer(/** 模拟已认证的 Nacos 3.3 资源端点。 */async (request, response) => {
    const url = new URL(request.url!, 'http://localhost');
    const parts: Buffer[] = [];
    for await (const part of request) parts.push(Buffer.from(part));
    const body = Buffer.concat(parts);
    const form = new URLSearchParams(body.toString());
    response.setHeader('content-type', 'application/json');
    if (url.pathname.endsWith('/login')) { response.end(JSON.stringify({ accessToken: 'fixture' })); return; }
    if (url.pathname.endsWith('/client/ai/prompt')) { const name = url.searchParams.get('promptKey')!; const entry = prompts.get(name); if (!entry?.online) { response.writeHead(404).end(); return; } response.end(JSON.stringify({ code: 0, data: { promptKey: name, version, template: entry.template } })); return; }
    if (url.pathname.endsWith('/admin/ai/prompt/version')) { response.end(JSON.stringify({ code: 0, data: { status: 'reviewed' } })); return; }
    if (url.pathname.endsWith('/admin/ai/prompt/publish')) { prompts.get(form.get('promptKey')!)!.online = true; writes++; response.end(JSON.stringify({ code: 0 })); return; }
    if (url.pathname.endsWith('/admin/ai/prompt')) { prompts.set(form.get('promptKey')!, { template: form.get('template')!, online: false }); writes++; response.end(JSON.stringify({ code: 0 })); return; }
    if (url.pathname.endsWith('/client/ai/skills')) {
      const entry = skills.get(url.searchParams.get('name')!);
      if (entry?.status !== 'online') { response.writeHead(404).end(); return; }
      response.setHeader('x-nacos-skill-resolved-version', version);
      response.end(entry.archive);
      return;
    }
    const skillName = url.searchParams.get('skillName') ?? form.get('skillName') ?? '';
    const skill = skills.get(skillName);
    if (url.pathname.endsWith('/admin/ai/skills')) {
      if (!skill) { response.writeHead(404).end(); return; }
      const rejected = skill.status === 'rejected';
      response.end(JSON.stringify({ code: 0, data: { versions: [{ version, status: rejected ? 'reviewed' : skill.status, publishPipelineInfo: rejected ? JSON.stringify({ status: 'REJECTED' }) : null }] } }));
      return;
    }
    if (url.pathname.endsWith('/admin/ai/skills/version/download')) {
      if (!skill || url.searchParams.get('version') !== version) { response.writeHead(404).end(); return; }
      response.end(skill.archive);
      return;
    }
    if (url.pathname.endsWith('/admin/ai/skills/submit') && skill?.status === 'draft' && form.get('version') === version) {
      skill.status = 'reviewed'; writes++; response.end(JSON.stringify({ code: 0 })); return;
    }
    if (url.pathname.endsWith('/admin/ai/skills/publish') && skill?.status === 'reviewed' && form.get('version') === version) {
      skill.status = 'online'; writes++; response.end(JSON.stringify({ code: 0 })); return;
    }
    if (url.pathname.endsWith('/admin/ai/skills/upload')) {
      const multipart = await new Request('http://localhost/', { method: 'POST', headers: { 'content-type': request.headers['content-type']! }, body }).formData();
      const file = multipart.get('file') as File;
      const name = file.name.replace(/\.zip$/, '');
      if (skills.has(name) || multipart.get('targetVersion') !== version || multipart.has('autoPublishIfNew')) { response.writeHead(409).end(); return; }
      const uploaded = await readSkillZip(Buffer.from(await file.arrayBuffer()));
      if (uploaded.content !== localMarkdown.replace(/^---\n/, `---\nversion: ${version}\n`)) { response.writeHead(400).end(); return; }
      skills.set(name, { archive: normalizedArchive, status: 'draft' });
      uploads++; writes++; response.end(JSON.stringify({ code: 0 })); return;
    }
    response.writeHead(404).end();
  });
  await new Promise<void>(/** 仅使用回环随机端口。 */ready => server.listen(0, '127.0.0.1', ready));
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  const port = address.port;
  /** 启动独立 CLI，以便服务端可以并行处理请求。 */
  async function run() {
    const processResult = spawn(process.execPath, ['--import', 'tsx', 'scripts/register-nacos-product-resources.ts', exportPath, '--apply'], { cwd: resolve('.'), env: { ...process.env, NACOS_PUBLISH_URL: `http://127.0.0.1:${port}`, NACOS_PUBLISH_NAMESPACE: 'fixture', NACOS_PUBLISH_USERNAME: 'fixture', NACOS_PUBLISH_PASSWORD: 'fixture' }, stdio: 'ignore' });
    return await new Promise<number | null>(/** 只读取退出状态。 */done => processResult.on('close', done));
  }
  try {
    assert.equal(await run(), 0);
    assert.equal(uploads, 1);
    assert.equal(skills.get(candidate.name)?.status, 'online');
    const entry = skills.get(candidate.name)!;
    entry.status = 'draft';
    assert.equal(await run(), 0);
    assert.equal(uploads, 1);
    assert.equal(entry.status, 'online');
    entry.status = 'rejected';
    const beforeRejection = writes;
    assert.notEqual(await run(), 0);
    assert.equal(writes, beforeRejection);
    entry.status = 'draft';
    const original = entry.archive;
    entry.archive = readFileSync(join(exportPath, 'product-requirements-handoff.zip'));
    const beforeConflict = writes;
    assert.notEqual(await run(), 0);
    assert.equal(writes, beforeConflict);
    entry.archive = original;
    entry.status = 'online';
    const prior = writes;
    assert.equal(await run(), 0);
    assert.equal(writes, prior);
    prompts.get('product-manager')!.template = '已被修改的内容';
    assert.notEqual(await run(), 0);
    assert.equal(writes, prior);
  } finally {
    await new Promise<void>(/** 关闭隔离服务。 */done => server.close(() => done()));
    rmSync(directory, { recursive: true, force: true });
  }
});
