/** 示例专用静态发布Adapter；不执行候选Node代码，不连接外部部署平台。
 * ADR: docs/decisions/2026-11-09-mastra-local-delivery-example.md
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { chromium } from 'playwright';
import { browserCases, previousPage } from './scenario.js';

/** 静态制品由构建者持有；hash为真实UTF-8字节摘要，sourceHash关联候选。 */
export interface LocalArtifact { sourceHash: string; digest: string; page: string; }
/** 发布后的独立观察；失败必须保留HTTP状态或浏览器错误，不能补写通过。 */
export interface LocalObservation {
  url: string; observedAt: string; status: 'passed' | 'failed'; httpStatus: number;
  expectedDigest: string; observedDigest: string; heading: string | null;
  screenshot: string | null; screenshotHash: string | null; error: string | null;
}

/** 按实际交付字节摘要，避免把对象JSON散列误当制品摘要。 */
export function bytesHash(value: string | Buffer): string { return createHash('sha256').update(value).digest('hex'); }

/** 从通过质量门的候选构建单页静态制品；额外源码不进入HTTP服务。 */
export function buildArtifact(sourceHash: string, files: Record<string, string>): LocalArtifact {
  assert.match(sourceHash, /^[a-f0-9]{64}$/);
  const page = files['page.html'];
  assert.ok(typeof page === 'string' && page.length && Buffer.byteLength(page) <= 100000, '缺少有界页面制品');
  return { sourceHash, digest: bytesHash(page), page };
}

/** 启动回环静态环境；故障开关只用于真实503注入，不影响保存制品。 */
export async function localRelease() {
  const previous = buildArtifact('0'.repeat(64), { 'page.html': previousPage });
  let active = previous;
  let unavailable = false;
  const server = createServer(/** 仅固定页面GET/HEAD；拒绝所有额外路径与方法。 */ (request, response) => {
    if (!['/', '/page.html'].includes(request.url ?? '') || !['GET', 'HEAD'].includes(request.method ?? '')) { response.writeHead(404); response.end(); return; }
    response.writeHead(unavailable ? 503 : 200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'Content-Security-Policy': "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'none'; form-action 'none'; frame-src 'none'; worker-src 'none'; base-uri 'none'" });
    response.end(request.method === 'HEAD' ? undefined : unavailable ? '受控健康故障' : active.page);
  });
  await new Promise<void>(/** 独占随机回环端口，不覆盖用户服务。 */ (done, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', done); });
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const origin = 'http://127.0.0.1:' + address.port;

  /** 核对制品实际字节后切换；禁止旧摘要套用新页面。 */
  function deploy(artifact: LocalArtifact, failHealth = false) {
    assert.equal(bytesHash(artifact.page), artifact.digest, '制品摘要不匹配');
    active = { ...artifact }; unavailable = failHealth;
  }

  /** 读取真实已发布HTTP，再用隔离Chromium验证可见页面和交互。 */
  async function probe(artifact: LocalArtifact, screenshotPath: string, version: 'v0' | 'v1'): Promise<LocalObservation> {
    const observation: LocalObservation = { url: origin + '/page.html', observedAt: new Date().toISOString(), status: 'failed', httpStatus: 0, expectedDigest: artifact.digest, observedDigest: '', heading: null, screenshot: null, screenshotHash: null, error: null };
    let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
    try {
      const response = await fetch(observation.url, { signal: AbortSignal.timeout(5000), redirect: 'error' });
      const pageBytes = Buffer.from(await response.arrayBuffer());
      observation.httpStatus = response.status; observation.observedDigest = bytesHash(pageBytes);
      assert.equal(response.status, 200); assert.equal(observation.observedDigest, artifact.digest);
      const env: Record<string, string> = {};
      for (const key of ['PATH', 'HOME', 'TMPDIR', 'TEMP', 'TMP', 'SystemRoot']) if (process.env[key]) env[key] = process.env[key]!;
      browser = await chromium.launch({ channel: 'chromium', headless: true, timeout: 10000, env });
      const context = await browser.newContext({ serviceWorkers: 'block', acceptDownloads: false });
      let blocked = 0;
      await context.route('**/*', /** 禁止外联或访问本机其他服务。 */ async route => {
        if (route.request().url() !== observation.url || route.request().method() !== 'GET') { blocked++; await route.abort(); }
        else await route.continue();
      });
      await context.routeWebSocket('**/*', /** 静态示例不需要WebSocket。 */ socket => { blocked++; socket.close(); });
      const page = await context.newPage();
      context.on('page', /** 关闭未经批准的弹窗。 */ popup => { if (popup !== page) { blocked++; void popup.close().catch(/** 清理错误不覆盖已有失败。 */ () => {}); } });
      const errors: string[] = [];
      page.on('pageerror', /** 页面异常使健康检查失败。 */ error => errors.push(error.name));
      page.on('console', /** 控制台错误属于运行失败证据。 */ message => { if (message.type() === 'error') errors.push(message.type()); });
      page.setDefaultTimeout(2000); page.setDefaultNavigationTimeout(5000);
      const navigation = await page.goto(observation.url, { waitUntil: 'load' });
      assert.equal(navigation?.status(), 200); assert.equal(bytesHash(await navigation!.body()), artifact.digest);
      observation.heading = await page.locator('h1').innerText();
      assert.equal(observation.heading, '工单标题校验 ' + version);
      if (version === 'v1') {
        for (const item of [...browserCases(), { expected: '标题须为1–80个字符', browser: { actions: [{ action: 'fill', selector: '#title', value: 'x'.repeat(81) }, { action: 'click', selector: '#submit', value: '' }] } }]) {
          for (const action of item.browser.actions) {
            if (action.action === 'fill') await page.locator(action.selector).fill(action.value);
            else await page.locator(action.selector).click();
          }
          assert.equal(await page.locator('#result').innerText(), item.expected);
        }
      } else assert.equal(await page.locator('#result').innerText(), '上一版本已恢复');
      assert.equal(blocked, 0); assert.deepEqual(errors, []);
      const screenshot = await page.screenshot({ type: 'png', timeout: 3000 });
      writeFileSync(screenshotPath, screenshot);
      observation.screenshot = resolve(screenshotPath); observation.screenshotHash = bytesHash(screenshot); observation.status = 'passed';
    } catch (error) { observation.error = error instanceof Error ? error.name + ': ' + error.message.slice(0, 1000) : '本机HTTP或页面核验失败'; }
    finally { await browser?.close(); }
    return observation;
  }

  /** 幂等关闭当前示例拥有的连接，制品和报告留存。 */
  async function close() {
    server.closeAllConnections();
    await new Promise<void>(/** 等待端口释放。 */ done => server.close(/** 回调不改变观察结果。 */ () => done()));
  }
  return { previous, origin, deploy, probe, close };
}
