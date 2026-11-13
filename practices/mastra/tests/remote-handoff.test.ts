/** 真实 Git 对象与本地 bare 远端回归，不向业务远端推送合成资料。 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, realpathSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { publishHandoff, readHandoffFile } from '../src/delivery/remote-handoff.js';
import { createTaskContext, contextLimits } from '../src/delivery/task-context.js';

/** 创建独立工作树与 bare 远端；只使用合成文件。 */
function repositories() {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'remote-handoff-')));
  const root = join(directory, 'repo'); const remote = join(directory, 'remote.git');
  /** 所有参数来自本测试，不打印用户Git配置。 */
  function git(args: string[]) { return execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim(); }
  execFileSync('git', ['init', '-b', 'main', root], { stdio: 'ignore' });
  execFileSync('git', ['init', '--bare', remote], { stdio: 'ignore' });
  git(['config', 'user.name', 'fixture']); git(['config', 'user.email', 'fixture@example.invalid']);
  writeFileSync(join(root, 'README.md'), 'baseline'); git(['add', 'README.md']); git(['commit', '-m', 'test(workflow): 基线']); git(['remote', 'add', 'origin', remote]);
  return { root, remote, directory, git };
}

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
  const capped = context.read({ id, length: contextLimits.readChars + 1 });
  assert.equal(capped.content.length, contextLimits.readChars, '超长页请求必须收敛为服务端单页上限，并由nextOffset提示续读');
  assert.equal(capped.nextOffset, contextLimits.readChars);
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
    const generate = createStep({ id: 'product-coordinator', inputSchema: deliverySchema, outputSchema: deliverySchema,
      /** 合成角色仅计算一次正文，不能因网络故障重复。 */execute: async ({ inputData }) => { calls++; return { ...inputData, productWork: { version: 'product-graph.v1' as const, entries: [{ role: 'coordinator' as const, content: '合成角色正文', toolNames: [], modelSteps: 1 }] } }; },
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
    const payload = (paused.steps['product-coordinator'] as any).suspendPayload;
    assert.equal(payload.kind, 'repository-sync');
    const display = describeGate('product-coordinator', payload)!; assert.equal(display.key, 'retry-repository-sync');
    assert.throws(/** 旧同步版本不能恢复。 */() => validateGate('product-coordinator', payload, { gateHash: display.gateHash, data: { repositoryRetry: '0'.repeat(64) } }));
    const { readIntake } = await import('../src/intake/service.js');
    const view = await readIntake(flow as any, 'native-sync');
    assert.equal(view.mode, 'live'); assert.equal(view.gate?.key, 'retry-repository-sync');
    await storage.close();
    storage = new LibSQLStore({ id: 'remote-handoff-reopened', url: databaseUrl });
    flow = buildFlow();
    new Mastra({ workflows: { flow }, storage });
    run = await flow.createRun({ runId: 'native-sync' });
    rmSync(hook);
    const resumed = await run.resume({ resumeData: validateGate('product-coordinator', payload, { gateHash: display.gateHash, data: display.fixed }) });
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
