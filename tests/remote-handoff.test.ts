import { architectureDocumentPath } from '../src/development/v2/architecture-document.js';
/** 真实 Git 对象与本地 bare 远端回归，不向业务远端推送合成资料。 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, realpathSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { formalRunBranch, publishFormalSpecification, publishHandoff, publishReviewedCandidate, readHandoffFile } from '../src/delivery/remote-handoff.js';
import { createTaskContext, contextLimits } from '../src/delivery/task-context.js';
import { publishProductHandoff, verifyProductHandoff } from '../src/business-engineering/product-handoff.js';
import { productPaths, readProductDocuments, validateProductDraftPresentation } from '../src/business-engineering/product-documents.js';

test('待审双文档拒绝内部制作过程，业务发布门禁可保留', () => {
  assert.throws(() => validateProductDraftPresentation('# 需求文档\n本稿依据已读取 material-1-aabbccdd。\n# 产品规格\n'), /内部制作过程/);
  assert.throws(() => validateProductDraftPresentation('# 需求文档\n## 执行记录\n\n# 产品规格\n'), /内部制作过程/);
  assert.doesNotThrow(() => validateProductDraftPresentation('# 需求文档\n真实资料入口关闭，待书面制度确认后才能发布。\n# 产品规格\n'));
});
import { buildSuccessorBaseline } from '../src/intake/successor-run.js';
import { rehomeSpecifications } from '../src/team/runs.js';
import type { FormalSpecificationReceipt } from '../src/delivery/remote-handoff.js';

/** 创建独立工作树与 bare 远端；只使用合成文件。 */
function repositories(seedMain = true) {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'remote-handoff-')));
  const root = join(directory, 'repo'); const remote = join(directory, 'remote.git');
  /** 所有参数来自本测试，不打印用户Git配置。 */
  function git(args: string[]) { return execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim(); }
  execFileSync('git', ['init', '-b', 'main', root], { stdio: 'ignore' });
  execFileSync('git', ['init', '--bare', remote], { stdio: 'ignore' });
  git(['config', 'user.name', 'fixture']); git(['config', 'user.email', 'fixture@example.invalid']);
  writeFileSync(join(root, 'README.md'), 'baseline'); git(['add', 'README.md']); git(['commit', '-m', 'test(workflow): 基线']); git(['remote', 'add', 'origin', remote]);
  if (seedMain) git(['push', 'origin', 'main']);
  return { root, remote, directory, git };
}

test('独立团队重登记三份正式规格，远端部分拒绝后复用原提交', /** 使用本地 bare Git 验证交接重试和回执链。 */async () => {
  const f = repositories();
  try {
    const revision = f.git(['rev-parse', 'HEAD']);
    const sourceId = randomUUID();
    const targetId = randomUUID();
    const iteration = 'team-handoff';
    const source: FormalSpecificationReceipt[] = [];
    for (const kind of ['product', 'development', 'testing'] as const) {
      const path = `specs/${kind}-spec.md`;
      const handoff = await publishFormalSpecification(f.root, sourceId, iteration, { [path]: `${kind} 已确认规格\n` }, 'docs(spec): 保存测试规格', revision);
      source.push({ kind, paths: [path], handoff, upstreamCommits: source.map(/** 记录上游回执顺序。 */receipt => receipt.handoff.commit) });
    }
    const config = { rootDir: f.root, mode: 'live' as const, modelId: 'openai/synthetic' as const, port: 4111, databaseUrl: 'file::memory:', engineeringProject: { id: 'team-handoff', label: '本地 Git 验证', root: f.root, origin: f.remote, revision } };
    const branch = formalRunBranch(iteration, targetId);
    const ref = `refs/heads/${branch}`;
    const hook = join(f.remote, 'hooks/pre-receive');
    const [first] = source;
    const mismatched = { ...first!, handoff: { ...first!.handoff, files: { [first!.paths[0]!]: '0'.repeat(64) } } };
    await assert.rejects(rehomeSpecifications(config, [mismatched], targetId, iteration, revision), /交付内容散列不一致/);
    assert.equal(f.git(['ls-remote', '--refs', 'origin', ref]), '');
    // 允许创建分支，拒绝第二次推送，制造已经交付首份规格的部分失败。
    writeFileSync(hook, '#!/bin/sh\nread old new ref\ntest "$old" = 0000000000000000000000000000000000000000\n', { mode: 0o700 });
    await assert.rejects(rehomeSpecifications(config, source, targetId, iteration, revision), /远端同步失败/);
    const partial = f.git(['ls-remote', '--refs', 'origin', ref]).split(/\s/)[0];
    assert.match(partial!, /^[a-f0-9]{40}$/);
    rmSync(hook);
    const receipts = await rehomeSpecifications(config, source, targetId, iteration, revision);
    assert.equal(receipts[0]!.handoff.commit, partial);
    for (const [index, receipt] of receipts.entries()) {
      const [path] = receipt.paths;
      assert.equal(receipt.handoff.branch, branch);
      assert.deepEqual(receipt.upstreamCommits, receipts.slice(0, index).map(/** 目标回执只引用本分支的上游版本。 */upstream => upstream.handoff.commit));
      assert.equal(readHandoffFile(f.root, receipt.handoff, path!), readHandoffFile(f.root, source[index]!.handoff, path!));
    }
    assert.equal(f.git(['ls-remote', '--refs', 'origin', ref]).split(/\s/)[0], receipts[2]!.handoff.commit);
    assert.equal(f.git(['ls-remote', '--refs', 'origin', `refs/heads/${formalRunBranch(iteration, sourceId)}`]).split(/\s/)[0], source[2]!.handoff.commit);
    assert.deepEqual(await rehomeSpecifications(config, source, targetId, iteration, revision), receipts);
  } finally { rmSync(f.directory, { recursive: true, force: true }); }
});

test('新建正式和归档分支均以远端 main 为父提交', /** 构造互相分叉的本地 HEAD 和远端 main。 */async () => {
  const f = repositories();
  const runId = 'a84353b9-e22c-4ea9-b412-c6f28800c567';
  try {
    f.git(['commit', '--allow-empty', '-m', 'test(workflow): 推进远端主分支']);
    const mainHead = f.git(['rev-parse', 'HEAD']);
    f.git(['push', 'origin', 'main']);
    f.git(['switch', '-c', 'local-only', 'HEAD^']);
    f.git(['update-ref', 'refs/remotes/origin/main', 'HEAD']);
    f.git(['commit', '--allow-empty', '-m', 'test(workflow): 仅本地的提交']);
    const localHead = f.git(['rev-parse', 'HEAD']);
    const files = { 'specs/product-spec.md': '产品规格' };
    await assert.rejects(publishFormalSpecification(f.root, runId, 'inventory', files, 'docs(spec): 保存规格', localHead), /与远端 origin\/main 不一致/);
    assert.equal(f.git(['ls-remote', 'origin', `refs/heads/${formalRunBranch('inventory', runId)}`]), '');
    const formal = await publishFormalSpecification(f.root, runId, 'inventory', files, 'docs(spec): 保存规格', mainHead);
    const otherRunId = 'b84353b9-e22c-4ea9-b412-c6f28800c567';
    const other = await publishFormalSpecification(f.root, otherRunId, 'inventory', { 'specs/requirements.md': '另一项需求' }, 'docs(spec): 保存需求');
    const archive = await publishHandoff(f.root, runId, { 'product/run.md': '归档' });
    assert.notEqual(other.branch, formal.branch);
    assert.equal(f.git(['rev-parse', `${formal.commit}^`]), mainHead);
    assert.equal(f.git(['rev-parse', `${other.commit}^`]), mainHead);
    assert.equal(f.git(['ls-tree', '--name-only', other.commit, 'specs/product-spec.md']), '');
    assert.equal(f.git(['rev-parse', `${archive.commit}^`]), mainHead);
    assert.equal(f.git(['rev-parse', 'HEAD']), localHead);
  } finally { rmSync(f.directory, { recursive: true, force: true }); }
});

test('远端没有 main 时即使本地存在 main 也拒绝创建交付分支', /** 检查本地分支和缓存均无法绕过规则。 */async () => {
  const f = repositories(false);
  try {
    await assert.rejects(publishHandoff(f.root, 'run1', { 'product/run.md': '归档' }), /缺少 main/);
    assert.equal(f.git(['ls-remote', '--heads', 'origin']), '');
  } finally { rmSync(f.directory, { recursive: true, force: true }); }
});

test('首次推送失败后 main 推进，重试改用新的远端基线', /** 拒绝第一次推送并保留本地检查点。 */async () => {
  const f = repositories();
  try {
    const hook = join(f.remote, 'hooks/pre-receive');
    writeFileSync(hook, '#!/bin/sh\nexit 1\n', { mode: 0o700 });
    const files = { 'product/run.md': '归档' };
    await assert.rejects(publishHandoff(f.root, 'run1', files), /远端同步失败/);
    const rejected = f.git(['for-each-ref', '--format=%(objectname)', 'refs/workflow-handoffs/']);
    rmSync(hook);
    f.git(['commit', '--allow-empty', '-m', 'test(workflow): 推进主分支']);
    f.git(['push', 'origin', 'main']);
    const mainHead = f.git(['rev-parse', 'HEAD']);
    const receipt = await publishHandoff(f.root, 'run1', files);
    assert.notEqual(receipt.commit, rejected);
    assert.equal(f.git(['rev-parse', `${receipt.commit}^`]), mainHead);
    f.git(['commit', '--allow-empty', '-m', 'test(workflow): 再次推进主分支']);
    f.git(['push', 'origin', 'main']);
    assert.deepEqual(await publishHandoff(f.root, 'run1', files), receipt);
    const next = await publishHandoff(f.root, 'run1', { 'product/next.md': '续接' });
    assert.equal(f.git(['rev-parse', `${next.commit}^`]), receipt.commit);
  } finally { rmSync(f.directory, { recursive: true, force: true }); }
});

test('远端交付隔离用户index、保留历史、固定版本读取、幂等不回退', /** 核对实际bare远端内容。 */async () => {
  const f = repositories();
  try {
    writeFileSync(join(f.root, 'README.md'), 'user-staged'); f.git(['add', 'README.md']);
    const head = f.git(['rev-parse', 'HEAD']); const staged = f.git(['diff', '--cached']);
    const path = 'product/runs/run1/role/hash/product.md';
    const first = await publishHandoff(f.root, 'run1', { [path]: '第一版\n' });
    assert.equal(readHandoffFile(f.root, first, path), '第一版\n');
    assert.equal(f.git(['show', `${first.commit}:README.md`]), 'baseline');
    assert.equal(f.git(['rev-parse', 'HEAD']), head); assert.equal(f.git(['diff', '--cached']), staged);
    const next = await publishHandoff(f.root, 'run1', { 'testSet/runs/run1/test/hash/plan.md': '第二阶段' });
    assert.notEqual(first.commit, next.commit);
    assert.deepEqual(await publishHandoff(f.root, 'run1', { [path]: '第一版\n' }), first);
    assert.match(f.git(['ls-remote', 'origin', `refs/heads/${first.branch}`]), new RegExp(`^${next.commit}`));
    assert.throws(/** 未登记文件不能读取。 */() => readHandoffFile(f.root, first, 'README.md'));
    assert.throws(/** 不同散列不能伪造版本。 */() => readHandoffFile(f.root, { ...first, files: { [path]: '0'.repeat(64) } }, path));
    await assert.rejects(/** Run不能注入ref。 */() => publishHandoff(f.root, '../main', { [path]: 'bad' }));
    await assert.rejects(/** 点段不能逃逸。 */() => publishHandoff(f.root, 'run1', { 'product/../secret': 'bad' }));
  } finally { rmSync(f.directory, { recursive: true, force: true }); }
});

test('push失败后复用提交且禁止pushurl漂移', /** bare hook只用来注入远端拒绝。 */async () => {
  const f = repositories();
  try {
    const hook = join(f.remote, 'hooks/pre-receive'); writeFileSync(hook, '#!/bin/sh\nexit 1\n', { mode: 0o700 });
    const files = { 'product/runs/run2/role/hash/result.md': 'completed' };
    await assert.rejects(/** 远端拒绝不能返回成功回执。 */() => publishHandoff(f.root, 'run2', files), /远端同步失败/);
    const saved = f.git(['for-each-ref', '--format=%(objectname)', 'refs/workflow-handoffs/']);
    rmSync(hook);
    const receipt = await publishHandoff(f.root, 'run2', files); assert.equal(receipt.commit, saved);
    f.git(['config', 'remote.origin.pushurl', join(f.directory, 'elsewhere')]);
    await assert.rejects(/** pushurl不能扩张目标范围。 */() => publishHandoff(f.root, 'run2', files), /推送地址/);
  } finally { rmSync(f.directory, { recursive: true, force: true }); }
});

test('正式规格在同一能力 Run 分支追加，且拒绝客户端式路径或非法 Run 标识', /** 规格提交只使用本地 bare 远端。 */async () => {
  const f = repositories();
  const runId = 'a84353b9-e22c-4ea9-b412-c6f28800c567';
  try {
    const branch = formalRunBranch('招聘 流程!', runId);
    assert.equal(branch, `run/feature-${runId}`);
    const requirements = await publishFormalSpecification(f.root, runId, 'recruitment-workflow', {
      'specs/requirements.md': '# 已确认需求\n',
      'specs/manifest.json': '{"kind":"requirements"}\n',
    }, 'docs(spec): 提交已确认需求');
    const development = await publishFormalSpecification(f.root, runId, 'recruitment-workflow', {
      'specs/development-spec.md': '# 已确认开发 Spec\n',
    }, 'docs(spec): 提交已确认开发规格');
    assert.equal(requirements.branch, `run/recruitment-workflow-${runId}`);
    assert.equal(development.branch, requirements.branch);
    assert.notEqual(development.commit, requirements.commit);
    assert.equal(readHandoffFile(f.root, development, 'specs/development-spec.md'), '# 已确认开发 Spec\n');
    assert.match(f.git(['ls-remote', 'origin', `refs/heads/${requirements.branch}`]), new RegExp(`^${development.commit}`));
    assert.throws(() => formalRunBranch('x', 'not-a-uuid'));
    await assert.rejects(() => publishFormalSpecification(f.root, runId, 'feature', { 'product/escape.md': 'bad' }, 'docs(spec): bad'), /正式规格/);
  } finally { rmSync(f.directory, { recursive: true, force: true }); }
});

test('后继 Run 只从已确认回执导入固定 Git 规格，拒绝遗漏与散列漂移', /** 来源正文、ref 与 hash 都不能由页面替换。 */async () => {
  const f = repositories();
  const sourceRunId = 'a84353b9-e22c-4ea9-b412-c6f28800c567';
  try {
    const handoff = await publishFormalSpecification(f.root, sourceRunId, 'recruitment-workflow', { 'specs/product-spec.md': '# 产品基线\n' }, 'docs(spec): 提交已确认产品规格');
    const source = { brief: '旧需求', mode: 'live' as const, artifacts: [], reviews: [], outcome: 'in-progress' as const, correlation: { projectId: 'hrm' as const, iterationId: 'recruitment-workflow', runId: sourceRunId, workflowId: 'productDevelopmentWorkflow' as const }, formalSpecifications: [{ kind: 'product' as const, handoff, paths: ['specs/product-spec.md'], upstreamCommits: [] }] };
    const baseline = buildSuccessorBaseline(f.root, sourceRunId, source, ['product'], '补充重复投递规则');
    assert.equal(baseline.sourceRunId, sourceRunId);
    assert.equal(baseline.artifacts[0].content, '# 产品基线\n');
    assert.throws(() => buildSuccessorBaseline(f.root, sourceRunId, source, ['development'], '补充规则'), /不包含/);
    assert.throws(() => buildSuccessorBaseline(f.root, sourceRunId, { ...source, formalSpecifications: [{ ...source.formalSpecifications[0], handoff: { ...handoff, files: { 'specs/product-spec.md': '0'.repeat(64) } } }] }, ['product'], '补充规则'), /散列/);
  } finally { rmSync(f.directory, { recursive: true, force: true }); }
});

const moduleSelector = `# 需求文档

## 适用模块选择

- REQ-AM-OPTIONS: 启用的字典模块按值排序，上级节点不可选 | 验收: 全部停用时下拉框无可选项
- REQ-AM-CONFIRM: 选择模块后才能确定 | 验收: 确定时打开所选模块的产品分配穿梭框

### Scenario: 确定后进入穿梭框
- **WHEN** 用户选择模块后点击确定
- **THEN** 当前弹窗关闭，打开该模块的产品分配穿梭框

# 产品规格

- TASK-AM-OPTIONS: 交付模块字典下拉及空态 | 需求: REQ-AM-OPTIONS
- TASK-AM-ELIGIBILITY: 交付确定按钮与穿梭框跳转 | 需求: REQ-AM-CONFIRM`;

test('产品任务须在正文中覆盖有效需求', /** 拒绝不完整或不可追溯的待审稿。 */() => {
  assert.doesNotThrow(() => readProductDocuments(moduleSelector.replaceAll(' | 验收:', '；验收:').replaceAll(' | 需求:', '；需求:')));
  assert.throws(() => readProductDocuments(moduleSelector.replace(/- TASK-AM-ELIGIBILITY.*/, '')), /全部需求/);
  assert.throws(() => readProductDocuments(moduleSelector.replace('需求: REQ-AM-CONFIRM', '需求: REQ-AM-UNKNOWN')), /未知/);
  assert.throws(() => readProductDocuments(moduleSelector.replace('TASK-AM-ELIGIBILITY', 'TASK-AM-OPTIONS')), /重复/);
  assert.throws(() => readProductDocuments(moduleSelector.replace('需求: REQ-AM-CONFIRM', '需求: REQ-AM-CONFIRM, REQ-AM-CONFIRM')), /重复/);
  assert.throws(() => readProductDocuments(moduleSelector.replace(/(- TASK-AM-ELIGIBILITY.*)/, '```text\n$1\n```')), /全部需求/);
});

test('新 Run 的产品双文档在本地远端发布、核验、修订并作为后续基线读取', /** 真 Git 交接使用本地 bare 远端。 */async () => {
  const f = repositories();
  const runId = 'c84353b9-e22c-4ea9-b412-c6f28800c597';
  const iterationId = 'applicable-module-selector';
  const { requirements, specification } = productPaths(iterationId);
  try {
    const baseline = f.git(['rev-parse', 'HEAD']);
    f.git(['push', 'origin', 'main']);
    const receipt = await publishProductHandoff(f.root, runId, iterationId, moduleSelector, baseline);
    assert.deepEqual(receipt.paths, [requirements, specification]);
    assert.match(readHandoffFile(f.root, receipt.handoff, requirements), /Scenario: 确定后进入穿梭框/);
    assert.match(readHandoffFile(f.root, receipt.handoff, specification), /^# 产品规格[\s\S]*TASK-AM-ELIGIBILITY/);
    assert.doesNotMatch(readHandoffFile(f.root, receipt.handoff, specification), /\*\*WHEN\*\*/);
    verifyProductHandoff(f.root, runId, iterationId, receipt, moduleSelector);
    assert.deepEqual(await publishProductHandoff(f.root, runId, iterationId, moduleSelector, baseline), receipt);
    assert.throws(() => verifyProductHandoff(f.root, runId, iterationId, { ...receipt, paths: [specification] }, moduleSelector), /缺少/);
    assert.throws(() => verifyProductHandoff(f.root, runId, iterationId, { ...receipt, handoff: { ...receipt.handoff, files: { ...receipt.handoff.files, [requirements]: '0'.repeat(64) } } }, moduleSelector), /散列/);
    await assert.rejects(() => publishFormalSpecification(f.root, runId, iterationId, { 'product/another/requirements.md': '越界' }, 'docs(spec): 保存需求'), /受控路径/);
    const revised = moduleSelector.replace('上级节点不可选', '上级节点置灰且不可选');
    const revisedReceipt = await publishProductHandoff(f.root, runId, iterationId, revised, baseline);
    assert.equal(f.git(['rev-parse', `${revisedReceipt.handoff.commit}^`]), receipt.handoff.commit);
    verifyProductHandoff(f.root, runId, iterationId, revisedReceipt, revised);
    assert.throws(() => verifyProductHandoff(f.root, runId, iterationId, revisedReceipt, moduleSelector), /批准版本/);
    const architecture = '# 开发架构文档\n\n## 影响范围\n\n适用模块选择。\n';
    const developmentFiles = { 'specs/development-spec.md': '开发规格\n', [architectureDocumentPath]: architecture };
    const development = await publishFormalSpecification(f.root, runId, iterationId, developmentFiles, 'docs(spec): 保存开发规格');
    assert.equal(readHandoffFile(f.root, development, architectureDocumentPath), architecture);
    const testing = await publishFormalSpecification(f.root, runId, iterationId, { 'specs/test-spec.md': '测试规格\n' }, 'docs(spec): 保存测试规格');
    const final = await publishReviewedCandidate(f.root, testing, {}, [], [...revisedReceipt.paths, ...Object.keys(developmentFiles), 'specs/test-spec.md'], baseline);
    assert.equal(final, testing.commit);
    assert.equal(f.git(['rev-parse', `${testing.commit}^`]), development.commit);
    assert.match(f.git(['show', `${final}:${requirements}`]), /上级节点置灰且不可选/);
    assert.equal(f.git(['ls-remote', 'origin', 'refs/heads/main']).split(/\s/)[0], baseline);
    const source = { brief: '适用模块选择', mode: 'live', artifacts: [], reviews: [], outcome: 'in-progress', correlation: { projectId: 'hrm', iterationId, runId, workflowId: 'productDevelopmentWorkflow' }, formalSpecifications: [revisedReceipt, { kind: 'development', paths: Object.keys(developmentFiles), handoff: development, upstreamCommits: [revisedReceipt.handoff.commit] }, { kind: 'testing', paths: ['specs/test-spec.md'], handoff: testing, upstreamCommits: [revisedReceipt.handoff.commit, development.commit] }] };
    const next = buildSuccessorBaseline(f.root, runId, source, ['product', 'development', 'testing'], '完善停用模块回显');
    assert.deepEqual(next.artifacts.map(item => item.path), [requirements, specification, ...Object.keys(developmentFiles), 'specs/test-spec.md']);
    assert.equal(next.artifacts.find(item => item.path === architectureDocumentPath)?.content, architecture);
  } finally { rmSync(f.directory, { recursive: true, force: true }); }
});

test('长材料折叠、按版本分段读取与调用隔离', /** 多语言测试避免仅按英文字符估算。 */() => {
  const text = '已批准验收条件一二三\n'.repeat(7000);
  const c = createTaskContext({ task: 'review', product: text, files: { 'a.ts': text }, history: [text], instruction: '保留权限边界' });
  assert.ok(Buffer.byteLength(c.prompt) < 24000); assert.equal(c.manifest.length, 3);
  const ref = c.manifest[0]; const a = c.read({ id: ref.id, length: 10 }); const b = c.read({ id: ref.id, offset: a.nextOffset!, length: 10 });
  assert.equal(a.content + b.content, text.slice(0, 20));
  assert.throws(/** 任意路径不授予读取权。 */() => c.read({ id: '/etc/passwd' }));
  const other = createTaskContext({ task: 'another', product: 'different'.repeat(1000) });
  assert.throws(/** 另一个调用不能读取该引用。 */() => other.read({ id: ref.id }));
  for (let i = 0; i < 30; i++) assert.ok(c.read({ id: ref.id }).content);
});

test('资料读取不受旧累计额度或档位限制，目录总量也不阻断任务', /** 大资料仍须通过合法引用分页读取，不能越权读取文件。 */() => {
  const text = 'x'.repeat(180000); const context = createTaskContext({ task: 'read', text }, true, undefined, 4);
  const id = context.manifest[0].id;
  let collected = '';
  for (let offset = 0; offset < text.length; offset += contextLimits.readChars) collected += context.read({ id, offset }).content;
  assert.equal(collected, text);
  assert.throws(/** 取消累计预算不扩大引用权限。 */() => context.read({ id: 'unknown' }));
  assert.throws(/** 单次返回仍使用分页边界。 */() => context.read({ id, length: contextLimits.readChars + 1 }));
  const many = createTaskContext(Object.fromEntries(Array.from({ length: 500 }, /** 合法大目录不再触发旧inlineBytes门槛。 */(_, i) => [`file-${i}`, text])));
  assert.equal(many.manifest.length, 500); assert.ok(Buffer.byteLength(many.prompt) > 24000);
  assert.equal('inputProcessors' in context.options, false);
  const other = createTaskContext({ task: 'read', text });
  assert.notDeepEqual(context.options.memory, other.options.memory);
});

test('原生暂停恢复：远端失败后只重试同步，不重新运行角色或跳过原审批', /** 真实Mastra Step + bare远端验证业务/同步两个暂停点。 */async () => {
  const { createStep, createWorkflow } = await import('@mastra/core/workflows');
  const { Mastra } = await import('@mastra/core');
  const { LibSQLStore } = await import('@mastra/libsql');
  const { z } = await import('zod');
  const { withRepositoryAssets } = await import('../src/delivery/repository-assets.js');
  const { deliverySchema } = await import('../src/mastra/workflows/delivery.js');
  const { describeGate, validateGate } = await import('../src/intake/gates.js');
  const f = repositories(); const archive = repositories(); let calls = 0;
  try {
    archive.git(['remote', 'set-url', 'origin', 'https://github.com/leidaibo-lab/hrm.git']);
    const hook = join(f.remote, 'hooks/pre-receive'); writeFileSync(hook, '#!/bin/sh\nexit 1\n', { mode: 0o700 });
    const config = { rootDir: archive.root, hrmRepositoryRoot: archive.root, mode: 'live' as const, databaseUrl: 'file::memory:', port: 4111, modelId: 'openai/synthetic' as const };
    const source = { brief: '合成交接', mode: 'live' as const, artifacts: [], reviews: [], outcome: 'in-progress' as const };
    /** 仅在测试中把授权仓库的文件投影传给本地bare远端，生产仍使用固定origin。 */
    const publisher = (_root: string, run: string, files: Record<string, string>) => publishHandoff(f.root, run, files);
    /** 重建所有原生节点，保证恢复不依赖旧Workflow对象的内存。 */
    function buildFlow() {
    const generate = createStep({ id: 'product-analysis', inputSchema: deliverySchema, outputSchema: deliverySchema,
      /** 合成阶段仅计算一次正文，不能因网络故障重复。 */execute: async ({ inputData }) => { calls++; return { ...inputData, productWork: { version: 'product-graph.v1' as const, entries: [{ role: 'analysis' as const, content: '合成阶段正文', toolNames: [], modelSteps: 1 }] } }; },
    });
    const gate = createStep({ id: 'review-product', inputSchema: deliverySchema, outputSchema: deliverySchema, resumeSchema: z.object({ decision: z.literal('approve') }), suspendSchema: z.object({ waitingForApproval: z.literal(true) }),
      /** 同步恢复不能替代显式业务批准。 */execute: async ({ inputData, resumeData, suspend }) => { if (!resumeData) return suspend({ waitingForApproval: true }); return inputData; },
    });
    return createWorkflow({ id: 'remote-handoff-native', inputSchema: deliverySchema, outputSchema: deliverySchema }).then(withRepositoryAssets(generate, config, publisher)).then(withRepositoryAssets(gate, config, publisher)).commit();
    }
    let flow = buildFlow();
    const databaseUrl = `file:${join(archive.directory, 'workflow.db')}`;
    let storage = new LibSQLStore({ id: 'remote-handoff-test', url: databaseUrl });
    new Mastra({ workflows: { flow }, storage });
    let run = await flow.createRun({ runId: 'native-sync' });
    const paused = await run.start({ inputData: source }); assert.equal(paused.status, 'suspended'); assert.equal(calls, 1);
    const payload = (paused.steps['product-analysis'] as any).suspendPayload;
    assert.equal(payload.kind, 'repository-sync');
    const display = describeGate('product-analysis', payload)!; assert.equal(display.key, 'retry-repository-sync');
    assert.throws(/** 旧同步版本不能恢复。 */() => validateGate('product-analysis', payload, { gateHash: display.gateHash, data: { repositoryRetry: '0'.repeat(64) } }));
    const { readIntake } = await import('../src/intake/service.js');
    const view = await readIntake(flow as any, 'native-sync');
    assert.equal(view.mode, 'live'); assert.equal(view.gate?.key, 'retry-repository-sync');
    await storage.close();
    storage = new LibSQLStore({ id: 'remote-handoff-reopened', url: databaseUrl });
    flow = buildFlow();
    new Mastra({ workflows: { flow }, storage });
    run = await flow.createRun({ runId: 'native-sync' });
    rmSync(hook);
    const resumed = await run.resume({ resumeData: validateGate('product-analysis', payload, { gateHash: display.gateHash, data: display.fixed }) });
    assert.equal(calls, 1); assert.equal(resumed.status, 'suspended');
    assert.equal((resumed.steps['review-product'] as any).suspendPayload.waitingForApproval, true);
    await assert.rejects(/** 不能拿同步恢复令牌绕过原始业务resumeSchema。 */() => flow.steps['review-product'].execute({ runId: 'native-sync', inputData: source, resumeData: { repositoryRetry: payload.retryKey } } as any), /不能替代业务审批/);
    const approved = await run.resume({ resumeData: { decision: 'approve' } }); assert.equal(approved.status, 'success'); assert.equal(calls, 1);
    await storage.close();
  } finally { rmSync(f.directory, { recursive: true, force: true }); rmSync(archive.directory, { recursive: true, force: true }); }
});

test('真实Agent调用仅收到目录，通过原生工具读取固定远端版本', /** 使用框架模型测试端口驱动两步工具循环，不替代工具结果。 */async () => {
  const { Agent } = await import('@mastra/core/agent');
  const { MastraLanguageModelV2Mock } = await import('@mastra/core/test-utils/llm-mock');
  const f = repositories();
  try {
    const path = 'product/runs/task/role/hash/product.md'; const body = '业务规则原文不可丢失\n'.repeat(1000);
    const receipt = await publishHandoff(f.root, 'task', { [path]: body });
    const context = createTaskContext({ task: '核对原文' }, true, { root: f.root, receipt });
    const reference = context.manifest.find(/** 精确绑定远端路径和commit。 */item => item.path === `remote:${path}`)!;
    assert.equal(reference.commit, receipt.commit);
    let calls = 0; let sawToolResult = false;
    const model = new MastraLanguageModelV2Mock({
      /** 第一步主动读登记ID，第二步检查框架传回的真实工具输出。 */
      doGenerate: async ({ prompt, tools }) => {
        calls++;
        const serialized = JSON.stringify(prompt); assert.ok(!serialized.includes(body));
        const tool = tools?.find(/** 不假设框架如何拼接toolset名称。 */item => item.type === 'function' && item.name.includes('read'));
        if (calls === 1) {
          assert.ok(tool && tool.type === 'function');
          return { content: [{ type: 'tool-call' as const, toolCallId: 'read-material', toolName: tool.name, input: JSON.stringify({ id: reference.id, offset: 0, length: 20 }) }], finishReason: 'tool-calls' as const, usage: { inputTokens: 10, outputTokens: 10, totalTokens: 20 }, warnings: [] };
        }
        sawToolResult = serialized.includes(body.slice(0, 10));
        return { content: [{ type: 'text' as const, text: '已核对登记原文' }], finishReason: 'stop' as const, usage: { inputTokens: 10, outputTokens: 10, totalTokens: 20 }, warnings: [] };
      },
    });
    const agent = new Agent({ id: 'handoff-reader', name: '交接读取回归', instructions: '只读资料', model });
    const result = await agent.generate(context.prompt, { ...context.options, maxSteps: 3 });
    assert.equal(result.text, '已核对登记原文'); assert.equal(calls, 2); assert.equal(sawToolResult, true);
  } finally { rmSync(f.directory, { recursive: true, force: true }); }
});

test('候选归档读取实际正文，散列快照只用于版本校验', /** 防止将Execution.snapshot的SHA256错误当成源码交付。 */async () => {
  const { createExecutionScope } = await import('../src/development/v2/execution-scope.js');
  const { inputV2Schema } = await import('../src/development/v2/contracts.js');
  const { developmentHash } = await import('../src/development/contracts.js');
  const { createStep } = await import('@mastra/core/workflows');
  const { z } = await import('zod');
  const { contentHash } = await import('../src/delivery/remote-handoff.js');
  const body = '/** 合成源码。 */\nexport const value = 1;\n';
  const files = { 'src/value.mjs': body, 'smoke.mjs': '/** 固定检查。 */\n' };
  const hashes = Object.fromEntries(Object.entries(files).map(/** 与执行器相同的字节SHA256。 */([path, value]) => [path, contentHash(value)]));
  const input = inputV2Schema.parse({ source: { kind: 'evaluation', runId: 'candidate-run', content: '合成需求', hash: developmentHash('合成需求'), evidence: 'evaluation-input' }, maxReworks: 0, project: { id: 'fixture', roles: ['backend'], writablePaths: ['src/value.mjs'], checkFiles: ['smoke.mjs'], files } });
  let closed = false;
  /** 仅替换执行器I/O，保留真实步骤装饰与归档正文选择。 */
  const scope = createExecutionScope(() => ({
    /** snapshot的契约是路径到散列。 */snapshot: async () => hashes,
    /** readFile才返回实际正文。 */readFile: async (path: string) => files[path as keyof typeof files],
    /** 每步作用域必须释放。 */close: async () => { closed = true; },
  } as any), true);
  const state = { version: 'development-state.v2', input, checkpointHash: developmentHash(hashes) };
  const step = createStep({ id: 'candidate', inputSchema: z.unknown(), outputSchema: z.unknown(),
    /** 返回原状态，让作用域装饰器捕获正文。 */execute: async () => state,
  });
  const result = await scope.bind(step).execute({ inputData: state } as any) as any;
  assert.deepEqual(result.repositoryCandidate, files); assert.equal(result.repositoryCandidate['src/value.mjs'], body); assert.equal(closed, true);
});

test('QA 候选只写 Run 分支并复用 MR，源 SHA 漂移时拒绝交付', async () => {
  const { openMergeRequest } = await import('../src/delivery/merge-request.js');
  const f = repositories();
  const previousPath = process.env.PATH;
  try {
    writeFileSync(join(f.root, 'candidate.mjs'), 'export const value = 1;\n');
    f.git(['add', 'candidate.mjs']);
    f.git(['commit', '-m', 'test(delivery): 准备候选基线']);
    const baseline = f.git(['rev-parse', 'HEAD']);
    f.git(['push', 'origin', 'main']);
    const runId = 'a84353b9-e22c-4ea9-b412-c6f28800c567';
    const spec = await publishFormalSpecification(f.root, runId, 'inventory', { 'specs/test-spec.md': '# 已批准测试\n' }, 'docs(spec): 保存测试规格', baseline);
    assert.equal(f.git(['rev-parse', `${spec.commit}^`]), baseline);
    const candidate = { 'candidate.mjs': 'export const value = 2;\n', 'README.md': 'baseline' };
    /** 提交同一份 QA 候选及固定授权。 */
    const publish = () => publishReviewedCandidate(f.root, spec, candidate, ['candidate.mjs'], ['specs/test-spec.md'], baseline);
    await assert.rejects(() => publishReviewedCandidate(f.root, spec, { ...candidate, 'README.md': '越权变更' }, ['candidate.mjs'], ['specs/test-spec.md'], baseline), /受保护文件/);
    await assert.rejects(() => publishReviewedCandidate(f.root, spec, { ...candidate, 'specs/test-spec.md': '覆盖已批准规格' }, ['candidate.mjs', 'specs/test-spec.md'], ['specs/test-spec.md'], baseline), /受保护文件/);
    const commit = await publish();
    assert.equal(await publish(), commit);
    assert.equal(f.git(['rev-parse', `${commit}^`]), spec.commit);
    assert.equal(f.git(['show', `${commit}:candidate.mjs`]), candidate['candidate.mjs'].trim());
    assert.equal(f.git(['ls-remote', 'origin', 'refs/heads/main']).split(/\s/)[0], baseline);
    assert.equal(f.git(['rev-parse', 'HEAD']), baseline);

    const repository = 'fixture/inventory';
    const pull = { number: 42, state: 'open', head: { ref: spec.branch, sha: commit, repo: { full_name: repository } }, base: { ref: 'main', sha: baseline, repo: { full_name: repository } } };
    // 替代 gh 只模拟远端已创建请求而客户端丢失 POST 响应。
    const created = join(f.directory, 'created');
    writeFileSync(join(f.directory, 'gh'), `#!/bin/sh
for arg in "$@"; do
  case "$arg" in
    POST)
      base_ok=; head_ok=
      for field in "$@"; do
        case "$field" in
          'base=main') base_ok=1 ;;
          'head=${spec.branch}') head_ok=1 ;;
        esac
      done
      test "$base_ok$head_ok" = 11 && test ! -e '${created}' || exit 97
      touch '${created}'; exit 1 ;;
    repos/*/pulls/42) printf '%s' '${JSON.stringify(pull)}'; exit 0 ;;
  esac
done
for arg in "$@"; do
  case "$arg" in
    GET) if test -e '${created}'; then printf '%s' '[{"number":42}]'; else printf '%s' '[]'; fi; exit 0 ;;
  esac
done
printf '%s' '${JSON.stringify(pull)}'
`, { mode: 0o700 });
    process.env.PATH = `${f.directory}:${previousPath ?? ''}`;
    const first = await openMergeRequest(repository, spec.branch, commit, 'a'.repeat(64), 'b'.repeat(64));
    assert.equal(first.number, 42);
    assert.deepEqual(await openMergeRequest(repository, spec.branch, commit, 'a'.repeat(64), 'b'.repeat(64)), first);
    await assert.rejects(() => openMergeRequest(repository, spec.branch, baseline, 'a'.repeat(64), 'b'.repeat(64)), /交付版本不一致/);
  } finally {
    if (previousPath === undefined) delete process.env.PATH;
    else process.env.PATH = previousPath;
    rmSync(f.directory, { recursive: true, force: true });
  }
});
