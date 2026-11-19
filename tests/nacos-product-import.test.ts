/** 注册器只在模拟的本地 Nacos 上验证幂等、内容校验及拒绝覆盖。 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

test('本机注册可重复执行，同版本不同内容不覆盖', /** 通过真实进程和 HTTP 验证发布器边界。 */async () => {
  const directory = mkdtempSync(join(tmpdir(), 'nacos-import-'));
  const exportPath = join(directory, 'export');
  execFileSync(process.execPath, ['--import', 'tsx', 'scripts/prepare-nacos-product-skills.ts', exportPath, '1.1.0']);
  const manifest = JSON.parse(readFileSync(join(exportPath, 'manifest.json'), 'utf8'));
  manifest.skills = manifest.skills.slice(0, 1);
  writeFileSync(join(exportPath, 'manifest.json'), JSON.stringify(manifest));
  const prompts = new Map<string, { template: string; online: boolean }>();
  const skills = new Map<string, Buffer>();
  let writes = 0;
  const server = createServer(/** 模拟已认证的 Nacos 3.3 资源端点。 */async (request, response) => {
    const url = new URL(request.url!, 'http://localhost');
    const parts: Buffer[] = [];
    for await (const part of request) parts.push(Buffer.from(part));
    const body = Buffer.concat(parts);
    const form = new URLSearchParams(body.toString());
    response.setHeader('content-type', 'application/json');
    if (url.pathname.endsWith('/login')) { response.end(JSON.stringify({ accessToken: 'fixture' })); return; }
    if (url.pathname.endsWith('/client/ai/prompt')) { const name = url.searchParams.get('promptKey')!; const entry = prompts.get(name); if (!entry?.online) { response.writeHead(404).end(); return; } response.end(JSON.stringify({ code: 0, data: { promptKey: name, version: '1.1.0', template: entry.template } })); return; }
    if (url.pathname.endsWith('/admin/ai/prompt/version')) { response.end(JSON.stringify({ code: 0, data: { status: 'reviewed' } })); return; }
    if (url.pathname.endsWith('/admin/ai/prompt/publish')) { prompts.get(form.get('promptKey')!)!.online = true; writes++; response.end(JSON.stringify({ code: 0 })); return; }
    if (url.pathname.endsWith('/admin/ai/prompt')) { prompts.set(form.get('promptKey')!, { template: form.get('template')!, online: false }); writes++; response.end(JSON.stringify({ code: 0 })); return; }
    if (url.pathname.endsWith('/client/ai/skills')) { const archive = skills.get(url.searchParams.get('name')!); if (!archive) { response.writeHead(404).end(); return; } response.setHeader('x-nacos-skill-resolved-version', '1.1.0'); response.end(archive); return; }
    if (url.pathname.endsWith('/admin/ai/skills/upload')) {
      const multipart = await new Request('http://localhost/', { method: 'POST', headers: { 'content-type': request.headers['content-type']! }, body }).formData();
      const file = multipart.get('file') as File;
      skills.set(file.name.replace(/\.zip$/, ''), Buffer.from(await file.arrayBuffer())); writes++; response.end(JSON.stringify({ code: 0 })); return;
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
