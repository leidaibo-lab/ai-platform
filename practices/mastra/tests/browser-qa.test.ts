/** 真Chromium与原生Agent回归；不调用付费模型或业务远端。 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { runBrowserCase } from '../src/browser-qa/runner.js';
import { executeBrowserAgent } from '../src/browser-qa/agent.js';
import { loadBrowserMethod } from '../src/browser-qa/method.js';
import { developmentHash } from '../src/development/contracts.js';
import { validateBrowserEvidence, validateQualityReview } from '../src/delivery/testing.js';
import { qualityHash, qualityStateSchema } from '../src/delivery/contracts.js';
import type { BrowserRequest } from '../src/browser-qa/contracts.js';
import type { PracticeConfig } from '../src/mastra/config.js';
import { chromium } from 'playwright';
const config: PracticeConfig = { rootDir: resolve('.'), mode: 'fixture', modelId: 'openai/fixture', port: 4111, databaseUrl: 'file::memory:' };
const html = '<!doctype html><html><body><label>Name<input id="name"></label><button id="save" onclick="document.querySelector(\'#result\').textContent=document.querySelector(\'#name\').value">保存</button><p id="result">待输入</p></body></html>';
/** 合成批准输入只引用当前内存快照。 */
function request(): BrowserRequest { return { caseId: 'form', caseHash: 'a'.repeat(64), sourceHash: 'b'.repeat(64), methodHash: loadBrowserMethod(config.rootDir).hash, files: { 'page.html': html }, supported: true, browser: { entry: 'page.html', assets: [], actions: [{ action: 'fill', selector: '#name', value: '候选人' }, { action: 'click', selector: '#save', value: '' }], assertions: [{ selector: '#result', text: '候选人' }] } }; }
test('真实Chromium表单与截图，错误断言和外联均不能通过', /** 不用mock浏览器伪装执行证据。 */async () => {
  const input = request();
  const passed = await runBrowserCase(input);
  assert.equal(passed.status, 'passed', passed.reason); assert.ok(passed.screenshot);
  assert.equal(createHash('sha256').update(Buffer.from(passed.screenshot!.base64, 'base64')).digest('hex'), passed.screenshot!.sha256);
  const failed = await runBrowserCase({ ...input, browser: { ...input.browser, assertions: [{ selector: '#result', text: '错误预期' }] } });
  assert.equal(failed.status, 'failed'); assert.ok(failed.screenshot);
  const external = await runBrowserCase({ ...input, files: { 'page.html': html.replace('</body>', '<img src="https://example.invalid/probe"></body>') } });
  assert.equal(external.status, 'failed'); assert.ok(external.blockedRequests || external.consoleErrors.length);
  const blocked = await runBrowserCase({ ...input, supported: false }); assert.equal(blocked.status, 'blocked'); assert.equal(blocked.screenshot, null);
});
test('原生Agent实际加载Skill、读取原文并调用真实浏览器工具', /** 固定模型仅负责工具调用协议。 */async () => {
  const input = request();
  const evidence = await executeBrowserAgent(config, [input]);
  assert.ok(evidence.tools.includes('skill')); assert.ok(evidence.tools.includes('skill_read')); assert.ok(evidence.tools.includes('runBrowserCase'));
  assert.equal(evidence.receipts[0].status, 'passed', evidence.report); assert.ok(evidence.receipts[0].screenshot);
  const item = { id: input.caseId, method: 'browser', browser: input.browser, requirementRefs: ['R1'], checkRefs: [], expected: '姓名显示' };
  evidence.receipts[0].caseHash = developmentHash(item); evidence.hash = developmentHash(evidence.receipts);
  const state: any = { development: { checkpointHash: input.sourceHash }, quality: { plan: { browserMethodHash: evidence.methodHash }, approval: { cases: [item] }, sourceHash: input.sourceHash, browser: evidence, results: [{ caseId: input.caseId, status: 'passed', authority: 'browser-process' }] } };
  validateBrowserEvidence(state);
  const saved = structuredClone(evidence);
  state.quality.browser = undefined;
  assert.throws(/** 未执行不能凭模型文字通过。 */() => validateBrowserEvidence(state), /证据缺失/);
  state.quality.browser = evidence;
  evidence.receipts[0].screenshot!.base64 = Buffer.from('corrupt').toString('base64'); evidence.hash = developmentHash(evidence.receipts);
  assert.throws(/** 重算回执摘要不能掩盖截图损坏。 */() => validateBrowserEvidence(state), /截图证据损坏/);
  Object.assign(evidence, saved);
  state.quality.plan.browserMethodHash = 'd'.repeat(64);
  assert.throws(/** 方法升级需要重新批准与执行。 */() => validateBrowserEvidence(state), /漂移/);
  state.quality.plan.browserMethodHash = evidence.methodHash;
  state.quality.browser.receipts[0].sourceHash = 'c'.repeat(64); state.quality.browser.hash = developmentHash(evidence.receipts);
  assert.throws(/** 即使重算摘要也不能跨源码版本。 */() => validateBrowserEvidence(state), /漂移/);
  state.quality.browser.receipts[0].sourceHash = input.sourceHash; state.quality.browser.hash = developmentHash(evidence.receipts);
  assert.throws(/** 人工不能覆盖机器用例回执。 */() => validateQualityReview(state, { hash: 'a'.repeat(64), reviewer: 'human', comment: 'test', decision: 'pass', manualResults: [{ caseId: input.caseId, status: 'passed', evidence: '自述' }], findings: [] }), /人工测试结果/);
});
test('浏览器缺失时明确阻塞，不能跳过为通过', /** 故障注入验证环境缺失语义。 */async context => {
  context.mock.method(chromium, 'launch', /** 模拟运行环境没有可执行浏览器。 */async () => { throw new Error('missing executable'); });
  const result = await runBrowserCase(request());
  assert.equal(result.status, 'blocked'); assert.equal(result.screenshot, null);
});
test('旧质量证据hash保持兼容，可选浏览器字段不补写旧记录', /** 与旧摘要构造逐字段比较。 */() => {
  const quality = qualityStateSchema.parse({ status: 'pending', plan: null, approval: null, checks: [], results: [], sourceHash: null, reportHash: null, review: null });
  assert.equal(qualityHash({ quality } as any), developmentHash({ sourceHash: quality.sourceHash, plan: quality.plan, approval: quality.approval, checks: quality.checks, results: quality.results, review: quality.review }));
});
