/** 实际 Git/bare 远端与原生暂停恢复，合成批准只用于验证交付协议。 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { Mastra } from '@mastra/core';
import { createWorkflow } from '@mastra/core/workflows';
import { LibSQLStore } from '@mastra/libsql';
import { DevelopmentExecution } from '../src/development-execution.js';
import { developmentHash } from '../src/development/contracts.js';
import { approvalHashV2, stateV2Schema } from '../src/development/v2/contracts.js';
import { createExecutionScope } from '../src/development/v2/execution-scope.js';
import { developmentNodeState, loadDevelopmentNodeCases } from '../src/evaluation/development-nodes.js';
import { createCodePublicationStep, publishQualifiedCode } from '../src/delivery/code-publication.js';
import { emptyQuality, lifecycleSchema, qualityHash, type Lifecycle } from '../src/delivery/contracts.js';
import { publishCodeHandoff } from '../src/delivery/remote-handoff.js';
import type { PracticeConfig } from '../src/mastra/config.js';

/** 建立合成源码基线、可执行代码与独立远端，生产路径无需依赖注入跳过 Git。 */
async function fixture() {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'code-publication-')));
  const root = join(directory, 'repo'), remote = join(directory, 'remote.git'), candidate = join(directory, 'candidate');
  /** 命令只含测试常量；原始内容用于核对换行与实际文件模式。 */
  function git(args: string[]) { return execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim(); }
  execFileSync('git', ['init', '-b', 'main', root], { stdio: 'ignore' });
  execFileSync('git', ['init', '--bare', remote], { stdio: 'ignore' });
  git(['config', 'user.name', 'fixture']); git(['config', 'user.email', 'fixture@example.invalid']);
  const origin = 'https://example.invalid/business.git';
  git(['remote', 'add', 'origin', origin]); git(['config', `url.${remote}.insteadOf`, origin]);
  const config: PracticeConfig = { rootDir: resolve('.'), mode: 'live', modelId: 'openai/synthetic', port: 4111, databaseUrl: `file:${join(directory, 'workflow.db')}`, remoteSyncTargets: [{ id: 'business', label: '测试远端', root, origin }] };
  const item = loadDevelopmentNodeCases(config.rootDir).cases.find(/** 复用正式用例要求与真实检查。 */c => c.id === 'backend-implement')!;
  for (const [path, content] of Object.entries(item.files)) { mkdirSync(dirname(join(root, path)), { recursive: true }); writeFileSync(join(root, path), content); mkdirSync(dirname(join(candidate, path)), { recursive: true }); writeFileSync(join(candidate, path), content); }
  git(['add', '.']); git(['update-index', '--chmod=+x', 'src/solution.mjs']); git(['commit', '-m', 'test(workflow): 合成源码基线']);
  const baseCommit = git(['rev-parse', 'HEAD']);
  const engine = new DevelopmentExecution(candidate, ['src/solution.mjs'], ['checks.mjs']);
  let dev = developmentNodeState(config, item, await engine.snapshot(), 'a'.repeat(64));
  dev.input.project.repository = { origin, baseCommit };
  dev.input.scopeApproval = { reviewer: 'fixture', comment: '合成协议批准', productHash: dev.input.source.hash };
  dev.readiness = { assessment: { verdict: 'PASS', findings: [], coverageRefs: ['product:L1'], unchecked: [], resolutions: [] }, sourceHash: dev.checkpointHash, planHash: dev.planHash!, checksHash: developmentHash([]), hash: 'b'.repeat(64) };
  dev = stateV2Schema.parse(dev);
  dev.approvalHash = approvalHashV2(dev);
  dev.approvedHash = dev.approvalHash;
  await engine.writeFile('src/solution.mjs', '/** 按类型、空白及 Unicode 码点检查标题。 */\nexport function validateTitle(value) { if (typeof value !== "string") return {ok:false,error:"TYPE"}; const title=value.trim(); return [...title].length>=1 && [...title].length<=80 ? {ok:true,title} : {ok:false,error:"LENGTH"}; }\n');
  dev.checks = await engine.runChecks();
  dev.checkpointHash = developmentHash(await engine.snapshot());
  dev.outcome = 'development-delivered';
  dev.delivery = { version: 'development-delivery.v2', productHash: dev.input.source.hash, planHash: dev.planHash!, approvalHash: dev.approvalHash, contextHash: 'a'.repeat(64), methodBundleHash: 'a'.repeat(64), readinessHash: dev.readiness!.hash, reviewHash: 'a'.repeat(64), sourceHash: dev.checkpointHash, files: await engine.snapshot(), checks: dev.checks, resolutions: [], limitations: ['合成测试'] };
  const state: Lifecycle = { version: 'delivery-lifecycle.v1', brief: '合成源码交付', development: dev, quality: { ...emptyQuality(), checks: dev.checks, status: 'passed', sourceHash: dev.checkpointHash, review: { reviewer: 'fixture', comment: '合成质量批准', hash: 'a'.repeat(64), decision: 'pass', manualResults: [], findings: [] } }, qualityHistory: [], developmentHistory: [], release: { plan: null, qualityHash: null, approval: null, hash: null, receipt: null, health: null, rollback: null, authority: 'local-human-report' }, outcome: 'in-progress', limitations: ['合成测试'] };
  state.quality.reportHash = qualityHash(state);
  return { directory, root, remote, candidate, engine, git, config, state };
}

test('通过质量门的源码真实提交到远端、检出可运行，并隔离用户暂存区', /** 不用模型自报或JSON副本代替实际源码。 */async () => {
  const f = await fixture();
  try {
    writeFileSync(join(f.root, 'rules.md'), '用户尚未提交的规则'); f.git(['add', 'rules.md']);
    const staged = f.git(['diff', '--cached']); const head = f.git(['rev-parse', 'HEAD']);
    const result = await publishQualifiedCode(f.state, f.engine, f.root);
    const branch = `refs/heads/${result.receipt.branch}`;
    assert.match(f.git(['ls-remote', 'origin', branch]), new RegExp(`^${result.receipt.commit}`));
    assert.equal(f.git(['show', `${result.receipt.commit}:src/solution.mjs`]), (await f.engine.readFile('src/solution.mjs')).trim());
    assert.match(f.git(['ls-tree', result.receipt.commit, 'src/solution.mjs']), /^100755/);
    assert.equal(f.git(['diff', '--cached']), staged); assert.equal(f.git(['rev-parse', 'HEAD']), head);
    assert.notEqual(f.git(['show', `${result.receipt.commit}:rules.md`]), '用户尚未提交的规则');
    const checkout = join(f.directory, 'checkout'); execFileSync('git', ['clone', '--branch', result.receipt.branch, f.remote, checkout], { stdio: 'ignore' });
    execFileSync(process.execPath, ['--test', 'checks.mjs'], { cwd: checkout, stdio: 'pipe' });
    assert.deepEqual(await publishQualifiedCode(f.state, f.engine, f.root), result);
    const evidence = Object.keys(result.receipt.files).find(/** 交付清单绑定完整候选，便于远端独立核验。 */path => path.endsWith('.json'))!;
    const manifest = JSON.parse(f.git(['show', `${result.receipt.commit}:${evidence}`]));
    assert.deepEqual(manifest.files, { ...f.state.development.delivery!.files });
  } finally { await f.engine.close(); rmSync(f.directory, { recursive: true, force: true }); }
});

test('拒绝质量缺失、检查失败、候选漂移及批准后任务变更', /** 不合格输入不能产生远端提交。 */async () => {
  const f = await fixture();
  try {
    for (const change of [
      /** 修改批准后的任务不能继续借旧批准推代码。 */
      (s: Lifecycle) => { s.development.plan!.tasks[0].paths = ['checks.mjs']; },
      /** 自报通过不能覆盖失败的进程事实。 */
      (s: Lifecycle) => { s.quality.checks[0].exitCode = 1; s.quality.reportHash = qualityHash(s); },
      /** 旧质量记录不能配新源码。 */
      (s: Lifecycle) => { s.quality.sourceHash = '0'.repeat(64); },
    ]) { const state = structuredClone(f.state); change(state); await assert.rejects(publishQualifiedCode(state, f.engine, f.root)); }
    await f.engine.writeFile('src/solution.mjs', 'export const drift=1;');
    await assert.rejects(publishQualifiedCode(f.state, f.engine, f.root), /漂移/);
    assert.equal(f.git(['ls-remote', 'origin', 'refs/heads/codex/workflow/*']), '');
  } finally { await f.engine.close(); rmSync(f.directory, { recursive: true, force: true }); }
});

test('新增文件进入真实路径，配置修改、删除、并发漂移与错误基线被拒绝', /** 验证写入边界和普通push冲突语义。 */async () => {
  const f = await fixture();
  try {
    const code = { baselineCommit: f.state.development.input.project.repository!.baseCommit, baselineFiles: f.state.development.input.project.files, candidateFiles: { ...f.state.development.input.project.files, 'src/new.mjs': 'export const value=1;\n' }, allowedPaths: ['src/new.mjs'], sourceHash: 'c'.repeat(64), qualityHash: 'd'.repeat(64) };
    const first = await publishCodeHandoff(f.root, 'new-code', code);
    assert.equal(f.git(['show', `${first.commit}:src/new.mjs`]), 'export const value=1;');
    await assert.rejects(publishCodeHandoff(f.root, 'bad-config', { ...code, candidateFiles: { ...code.candidateFiles, 'checks.mjs': 'process.exit(0)' } }), /批准任务/);
    const deleted = { ...code.candidateFiles }; delete (deleted as Record<string, string>)['rules.md'];
    await assert.rejects(publishCodeHandoff(f.root, 'deleted', { ...code, candidateFiles: deleted }), /删除/);
    await assert.rejects(publishCodeHandoff(f.root, 'bad-base', { ...code, baselineFiles: { ...code.baselineFiles, 'checks.mjs': '不同基线' } }), /基线/);
    await assert.rejects(publishCodeHandoff(f.root, 'new-code', { ...code, sourceHash: 'e'.repeat(64), candidateFiles: { ...code.candidateFiles, 'src/new.mjs': 'export const value=2;' } }), /漂移/);
    f.git(['checkout', '-b', 'unvalidated']);
    writeFileSync(join(f.root, 'unverified.mjs'), 'throw new Error("unverified");'); f.git(['add', 'unverified.mjs']); f.git(['commit', '-m', 'test(workflow): 注入未验证工程改动']);
    await assert.rejects(publishCodeHandoff(f.root, 'unverified', code), /未经本轮验证/);
    f.git(['checkout', 'main']);
    f.git(['config', 'remote.origin.pushurl', join(f.directory, 'wrong.git')]);
    await assert.rejects(publishCodeHandoff(f.root, 'redirect', code), /推送地址/);
  } finally { await f.engine.close(); rmSync(f.directory, { recursive: true, force: true }); }
});

test('原生暂停、关闭Store后重试同一源码提交，并在Store保存版本回执', /** bare远端拒绝注入失败，重试不能重新调用模型。 */async () => {
  const f = await fixture(); await f.engine.close();
  const registered = join(f.directory, 'registered');
  execFileSync('git', ['clone', f.root, registered], { stdio: 'ignore' });
  execFileSync('git', ['-C', registered, 'remote', 'set-url', 'origin', f.state.development.input.project.repository!.origin]);
  f.config.remoteSyncTargets![0].root = registered;
  let storage: LibSQLStore | undefined;
  /** 重装步骤与执行作用域，恢复只依赖持久化输入和候选。 */
  async function open() {
    storage = new LibSQLStore({ id: 'code-publish-test', url: f.config.databaseUrl });
    const scope = createExecutionScope(/** 每步独立执行器，不复用关闭对象。 */() => new DevelopmentExecution(f.candidate, ['src/solution.mjs'], ['checks.mjs']));
    const workflow = createWorkflow({ id: 'code-publish-test', inputSchema: lifecycleSchema, outputSchema: lifecycleSchema }).then(scope.bind(createCodePublicationStep(f.config, scope.port,
      /** 登记目录保留HTTPS校验；测试网络Adapter仅转到合成本地bare，Git发布仍真实执行。 */
      async (_root, runId, input) => publishCodeHandoff(f.root, runId, input)))).commit();
    new Mastra({ storage, workflows: { workflow }, logger: false }); await storage.init(); return { workflow };
  }
  try {
    const hook = join(f.remote, 'hooks/pre-receive'); writeFileSync(hook, '#!/bin/sh\nexit 1\n', { mode: 0o700 });
    let { workflow } = await open(); let run = await workflow.createRun(); const runId = run.runId;
    const failed = await run.start({ inputData: f.state }); assert.equal(failed.status, 'suspended');
    const payload = (failed as any).steps['publish-tested-code'].suspendPayload;
    const commit = f.git(['for-each-ref', '--format=%(objectname)', 'refs/workflow-handoffs/']); assert.ok(commit);
    await storage!.close(); rmSync(hook);
    ({ workflow } = await open()); run = await workflow.createRun({ runId });
    const success = await run.resume({ step: 'publish-tested-code', resumeData: { repositoryRetry: payload.retryKey } });
    assert.equal(success.status, 'success');
    const result = (success as any).result;
    assert.equal(result.codePublication.receipt.commit, commit);
    assert.equal(result.codePublication.sourceHash, f.state.development.checkpointHash);
    assert.equal(result.codePublication.qualityHash, f.state.quality.reportHash);
    assert.match(f.git(['ls-remote', 'origin', `refs/heads/${result.codePublication.receipt.branch}`]), new RegExp(`^${commit}`));
  } finally { await storage?.close(); rmSync(f.directory, { recursive: true, force: true }); }
});
