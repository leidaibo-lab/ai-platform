/** Playwright Adapter；只服务批准快照，不读取宿主目录或个人会话。
 * ADR: docs/decisions/2026-11-09-mastra-gstack-browser-qa.md
 */
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { chromium, type Browser } from 'playwright';
import { browserCaseSchema, browserReceiptSchema, type BrowserRequest, type BrowserReceipt } from './contracts.js';
const contentTypes: Record<string, string> = { html: 'text/html', css: 'text/css', js: 'text/javascript', svg: 'image/svg+xml', json: 'application/json' };
/** 真实执行固定动作与文本断言；不可执行或证据不足时返回blocked。 */
export async function runBrowserCase(input: BrowserRequest): Promise<BrowserReceipt> {
  const started = Date.now();
  const receipt: BrowserReceipt = { version: 'browser-receipt.v1', caseId: input.caseId, caseHash: input.caseHash, sourceHash: input.sourceHash, methodHash: input.methodHash, status: 'blocked', reason: '', startedAt: new Date().toISOString(), durationMs: 0, steps: [], consoleErrors: [], blockedRequests: 0, screenshot: null };
  const spec = browserCaseSchema.parse(input.browser);
  if (!input.supported || !spec.entry.endsWith('.html')) { receipt.reason = '当前目标缺少同版本浏览器启动Adapter'; return receipt; }
  const files = new Map<string, string>();
  for (const path of [spec.entry, ...spec.assets]) {
    if (!Object.hasOwn(input.files, path) || !contentTypes[path.split('.').at(-1)!] || Buffer.byteLength(input.files[path]) > 100000) { receipt.reason = '候选资源缺失或格式不支持'; return receipt; }
    files.set('/' + path, input.files[path]);
  }
  const server = createServer(/** 仅交付显式资产，拒绝目录扫描与写请求。 */(request, response) => {
    const path = new URL(request.url ?? '/', 'http://localhost').pathname;
    const content = files.get(path);
    if (!['GET', 'HEAD'].includes(request.method ?? '') || content === undefined) { response.writeHead(404); response.end(); return; }
    response.writeHead(200, { 'Content-Type': contentTypes[path.split('.').at(-1)!] + '; charset=utf-8', 'Cache-Control': 'no-store', 'Content-Security-Policy': "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'none'; frame-src 'none'; worker-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'" });
    response.end(request.method === 'HEAD' ? undefined : content);
  });
  let browser: Browser | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let expired = false;
  try {
    await new Promise<void>(/** 绑定独占回环端口。 */(done, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', done); });
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('browser-target');
    const origin = 'http://127.0.0.1:' + address.port;
    const env: Record<string, string> = {};
    for (const key of ['PATH', 'HOME', 'TMPDIR', 'TEMP', 'TMP', 'SystemRoot', 'DISPLAY', 'XAUTHORITY']) if (process.env[key]) env[key] = process.env[key]!;
    browser = await chromium.launch({ channel: 'chromium', headless: true, timeout: 10000, env });
    const context = await browser.newContext({ serviceWorkers: 'block', acceptDownloads: false, viewport: { width: 1280, height: 800 } });
    timer = setTimeout(/** 总预算到期终止页面操作，不遗留后台测试。 */() => { expired = true; void context.close().catch(/** 关闭错误不覆盖原始失败。 */() => {}); }, 20000);
    await context.route('**/*', /** 仅允许本次服务和批准资产；防止任意外联。 */async route => {
      const request = route.request(); const url = new URL(request.url());
      if (url.origin !== origin || !files.has(url.pathname) || !['GET', 'HEAD'].includes(request.method())) { receipt.blockedRequests++; await route.abort(); }
      else await route.continue();
    });
    await context.routeWebSocket('**/*', /** 首版不开放实时服务。 */socket => { receipt.blockedRequests++; socket.close(); });
    const page = await context.newPage();
    page.setDefaultTimeout(1500); page.setDefaultNavigationTimeout(5000);
    page.on('console', /** 日志只是观察，限制数量和长度。 */message => { if (message.type() === 'error' && receipt.consoleErrors.length < 20) receipt.consoleErrors.push(message.text().slice(0, 500)); });
    page.on('pageerror', /** 异常只记录类别，避免透出堆栈。 */error => { if (receipt.consoleErrors.length < 20) receipt.consoleErrors.push('pageerror: ' + error.name); });
    context.on('page', /** 弹窗不拥有额外授权，立即关闭。 */popup => { if (popup !== page) { receipt.blockedRequests++; void popup.close().catch(/** 已关闭弹窗无需重试。 */() => {}); } });
    await page.goto(origin + '/' + spec.entry, { waitUntil: 'load' });
    receipt.steps.push({ action: 'open', selector: spec.entry, observed: '页面已加载' });
    for (const action of spec.actions) {
      if (expired) throw new Error('deadline');
      const locator = page.locator(action.selector);
      if (action.action === 'fill') { await locator.fill(action.value); if (await locator.inputValue() !== action.value) throw new Error('fill-mismatch'); } else await locator.click();
      receipt.steps.push({ action: action.action, selector: action.selector, observed: '动作已执行' });
    }
    receipt.status = 'passed';
    for (const assertion of spec.assertions) {
      if (expired) throw new Error('deadline');
      const locator = page.locator(assertion.selector);
      try { await locator.filter({ hasText: assertion.text }).waitFor({ state: 'visible', timeout: 1500 }); } catch { /* 未满足登记断言，继续截图留证。 */ }
      const visible = await locator.isVisible();
      const observed = visible ? (await locator.innerText()).slice(0, 2000) : '元素不可见';
      receipt.steps.push({ action: 'assert-text', selector: assertion.selector, observed });
      if (!visible || !observed.includes(assertion.text)) receipt.status = 'failed';
    }
    const screenshot = await page.screenshot({ type: 'png', timeout: 3000 });
    if (screenshot.length > 1000000) { receipt.status = 'blocked'; receipt.reason = '截图超出证据预算'; }
    else receipt.screenshot = { base64: screenshot.toString('base64'), sha256: createHash('sha256').update(screenshot).digest('hex') };
    if (receipt.consoleErrors.length || receipt.blockedRequests) { receipt.status = 'failed'; receipt.reason = '出现控制台错误或未批准请求'; }
    if (!receipt.reason) receipt.reason = receipt.status === 'passed' ? '登记文本断言通过；未覆盖其他业务行为' : '登记文本断言不符';
  } catch { receipt.status = 'blocked'; receipt.reason = '浏览器不可用、动作未完成或执行超时；未获得通过证据'; }
  finally {
    clearTimeout(timer);
    if (browser) await browser.close().catch(/** 关闭失败不覆盖已有观察。 */() => {});
    server.closeAllConnections();
    await new Promise<void>(/** 清理临时服务。 */done => server.close(/** 服务可能尚未监听。 */() => done()));
    receipt.durationMs = Date.now() - started;
  }
  return browserReceiptSchema.parse(receipt);
}
