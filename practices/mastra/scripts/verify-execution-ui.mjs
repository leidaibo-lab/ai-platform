/** 产品运行交互的隔离浏览器回归；需要本机4112前端和Chrome，不触及真实业务API。 */
import { createRequire } from 'node:module';
import assert from 'node:assert/strict';
const require = createRequire(new URL('../package.json', import.meta.url));
const { chromium } = require('playwright');
const browser = await chromium.launch({ headless: true, channel: 'chrome' });
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
let doc; let reads = 0; let cancelCount = 0; let releaseWrite;
const heldWrite = new Promise(/** 模拟长HTTP请求，取消前不返回。 */resolve => { releaseWrite = resolve; });
// 隔离所有业务API，不写入真实Run或调用模型。
await page.route('**/intake-api/runs**', /** 隔离API模拟重试、长连接与取消状态。 */async route => {
  const request = route.request(); const url = new URL(request.url());
  if (request.method() === 'POST' && url.pathname.endsWith('/cancel')) {
    cancelCount++; assert.equal(request.postDataJSON().token, doc.execution.token);
    doc = { ...doc, status: 'canceled', execution: { ...doc.execution, phase: 'canceling' } };
    await route.fulfill({ json: doc }); return;
  }
  if (request.method() === 'POST') {
    const input = request.postDataJSON(); const now = Date.now();
    doc = { runId: input.runId, brief: input.brief, mode: 'live', status: 'running', executionSettings: { maxAttempts: 2, totalMs: 1800000, stepMs: 600000, retryDelayMs: 1000, sdkRetries: 0, outputTokens: 16000 }, execution: { token: '11111111-1111-4111-8111-111111111111', role: 'clarification', startedAt: now - 600000, attemptStartedAt: now - 10000, lastActivityAt: now, attempt: 2, steps: 1, phase: 'generating', settled: false, failures: [{ attempt: 1, durationMs: 585100, recordedAt: new Date(now).toISOString(), kind: 'upstream', failure: { source: 'upstream-http', httpStatus: 524 } }] } };
    await heldWrite; await route.fulfill({ json: doc }); return;
  }
  if (url.pathname === '/intake-api/runs') { await route.fulfill({ json: { runs: doc ? [doc] : [] } }); return; }
  reads++; await route.fulfill({ json: doc });
});
try {
  await page.goto('http://127.0.0.1:4112/');
  await page.getByLabel('需求描述').fill('隔离浏览器取消回归');
  await page.getByRole('button', { name: '分析需求，形成初步方案' }).click();
  await page.getByRole('button', { name: '取消当前生成', exact: true }).waitFor({ timeout: 12000 });
  assert.ok(reads > 0, '写请求等待期间必须独立回读');
  assert.ok(await page.getByText(/HTTP 524/).count());
  await page.getByText('查看当前生效的超时与重试配置').click();
  assert.ok(await page.getByText(/输出上限 16000 tokens/).count());
  await page.getByRole('button', { name: '取消当前生成', exact: true }).click();
  await page.getByRole('button', { name: '继续等待', exact: true }).click();
  assert.equal(cancelCount, 0);
  await page.getByRole('button', { name: '取消当前生成', exact: true }).click();
  await page.getByRole('button', { name: '确认取消生成', exact: true }).click();
  await page.getByRole('heading', { name: /取消中，等待本地调用退出/ }).waitFor();
  assert.equal(cancelCount, 1);
  doc = { ...doc, execution: { ...doc.execution, settled: true, phase: 'stopped', lastActivityAt: Date.now() } }; releaseWrite();
  await page.getByRole('heading', { name: /本地执行已停止/ }).waitFor({ timeout: 12000 });
  await page.reload();
  await page.getByRole('heading', { name: /本地执行已停止/ }).waitFor();
  assert.equal(await page.getByRole('button', { name: '取消当前生成', exact: true }).count(), 0);
  await page.screenshot({ path: '/tmp/mastra-execution-cancel.png', fullPage: true });
  console.log(JSON.stringify({ passed: ['写等待期间独立轮询', '524重试明细', '只读有效配置', '二次确认返回不取消', '取消中与退出分离', '刷新保留服务端计时与终态'], reads, cancelCount, screenshot: '/tmp/mastra-execution-cancel.png' }));
} finally { releaseWrite?.(); await browser.close(); }
