/** 真实主链、本机HTTP和浏览器的闭环回归，不把固定模型当成业务质量证明。 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { runLocalExample } from '../examples/local-delivery/run.js';
import { localRelease } from '../examples/local-delivery/local-release.js';

for (const scenario of ['success', 'health-failure'] as const) {
  test('本机交付闭环：' + scenario, { timeout: 120000 }, /** 两条路径均实际执行，退出后端口必须释放。 */ async () => {
    const parent = mkdtempSync(resolve(tmpdir(), 'mastra-local-delivery-'));
    try {
      const report = await runLocalExample(resolve(parent, 'run'), scenario);
      assert.equal(report.status, 'passed'); assert.equal(report.cleanup, true); assert.equal(report.rollbackVerified, true);
      assert.ok(report.gates.length >= 8);
      assert.equal(report.outcome, scenario === 'success' ? 'fixture-completed' : 'rolled-back');
      const published = report.observations.find(/** 只检查真实发布后的观察。 */ item => item.phase === 'published')!.value;
      assert.equal(published.httpStatus, scenario === 'success' ? 200 : 503);
      if (scenario === 'success') assert.equal(published.observedDigest, report.artifact!.digest);
      assert.ok(report.quality?.browser?.receipts.every(/** 截图来自真实Chromium。 */ item => item.status === 'passed' && item.screenshot?.sha256));
      await assert.rejects(/** 退出后不能残留服务。 */ () => fetch(published.url, { signal: AbortSignal.timeout(1000) }));
    } finally { rmSync(parent, { recursive: true, force: true }); }
  });
}

test('制品漂移不能发布且非授权路径不可访问', /** 真实HTTP核验固定发布边界。 */ async () => {
  const environment = await localRelease();
  try {
    assert.throws(/** 修改字节却复用旧hash必须失败。 */ () => environment.deploy({ ...environment.previous, page: '被替换的页面' }), /制品摘要不匹配/);
    const response = await fetch(environment.origin + '/page.html');
    assert.equal(await response.text(), environment.previous.page);
    assert.equal((await fetch(environment.origin + '/not-allowed')).status, 404);
    assert.equal((await fetch(environment.origin + '/page.html', { method: 'POST' })).status, 404);
  } finally { await environment.close(); }
});
