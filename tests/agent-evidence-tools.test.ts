import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createCandidateQueryTools } from '../src/development/v2/query-tools.js';
import { createTaskContext } from '../src/delivery/task-context.js';
import { createExternalResearchTools } from '../src/mastra/tools/external-research.js';

/** 调用真实 Mastra 工具执行函数，模拟框架提供的调用上下文。 */
async function call(tool: any, input: unknown) { return tool.execute(input, {}); }

/** 为查询提供受控的可变候选快照。 */
function candidateFixture() {
  const files: Record<string, string> = { 'src/a.ts': 'export function value() { return value(); }\n' };
  const execution = { snapshot: async () => Object.fromEntries(Object.entries(files).map(([path, text]) => [path, createHash('sha256').update(text).digest('hex')])), readFile: async (path: string) => files[path] } as any;
  const state = { input: { project: { id: 'test-project', files: { 'src/a.ts': 'export function value() { return 1; }\n', 'src/deleted.ts': 'old\n' } } } } as any;
  return { files, execution, tools: createCandidateQueryTools(execution, state) };
}

test('候选 diff 按当前快照与冻结基线比较，支持删除及分页，拒绝未知路径', async () => {
  const { tools } = candidateFixture();
  const listing = await call(tools.candidateChanges, { cursor: 0 });
  assert.deepEqual(listing.changes.map((item: any) => [item.path, item.status]), [['src/a.ts', 'modified'], ['src/deleted.ts', 'deleted']]);
  const first = await call(tools.candidateDiff, { path: 'src/a.ts', offset: 0, length: 25 });
  assert.equal(first.changed, true); assert.equal(first.projectId, 'test-project'); assert.equal(first.content.length, 25); assert.equal(first.nextOffset, 25);
  await assert.rejects(call(tools.candidateDiff, { path: 'src/a.ts', offset: 25, length: 25 }), /身份/);
  assert.equal((await call(tools.candidateDiff, { path: 'src/a.ts', offset: 25, length: 25, candidateHash: first.candidateHash })).offset, 25);
  const all = await call(tools.candidateDiff, { path: 'src/a.ts', offset: 0, length: 6000 });
  assert.match(all.content, /-export function value\(\) \{ return 1; \}/); assert.match(all.content, /\+export function value\(\) \{ return value\(\); \}/);
  assert.match((await call(tools.candidateDiff, { path: 'src/deleted.ts', offset: 0, length: 6000 })).content, /\/dev\/null/);
  await assert.rejects(call(tools.candidateDiff, { path: '../outside', offset: 0, length: 10 }), /未知/);
});

test('代码结构查询解析语法并标注非语义引用，快照变化时拒绝', async () => {
  const { tools, execution } = candidateFixture();
  const result = await call(tools.codeStructure, { path: 'src/a.ts', identifier: 'value', cursor: 0 });
  assert.equal(result.matches.length, 2); assert.match(result.scope, /非|不保证/);
  const structure = await call(tools.codeStructure, { path: 'src/a.ts', cursor: 0 });
  assert.ok(structure.matches.some((item: any) => item.name === 'value'));
  let count = 0; execution.snapshot = async () => ({ 'src/a.ts': String(++count) });
  await assert.rejects(call(tools.codeStructure, { path: 'src/a.ts', cursor: 0 }), /发生变化/);
});

test('跨资料搜索分页且不读取其他调用的资料', () => {
  const first = createTaskContext({ a: ('甲needle乙'.repeat(3000)), b: ('丙needle丁'.repeat(3000)) });
  const other = createTaskContext({ secret: '私有资料'.repeat(3000) });
  const page = first.search({ query: 'needle' });
  assert.equal(page.items.length, 20); assert.ok(page.next);
  const next = first.search({ query: 'needle', ...page.next! });
  assert.notEqual(next.items[0].offset, page.items[0].offset);
  assert.equal(first.search({ query: '私有资料' }).items.length, 0);
  assert.equal(other.search({ query: 'needle' }).items.length, 0);
});

test('外部工具只读取本次搜索来源并限制调用，保留来源散列', async () => {
  const requests: string[] = [];
  const transport = (async (url: string | URL | Request) => { requests.push(String(url)); return new Response(JSON.stringify(String(url).endsWith('/search') ? { results: [{ url: 'https://example.com/a', title: '标题', content: '摘要' }, { url: 'http://localhost/private' }] } : { results: [{ url: 'https://example.com/a', raw_content: '正文' }] }), { status: 200 }); }) as typeof fetch;
  const tools = createExternalResearchTools('test-key', transport);
  await assert.rejects(call(tools.readPage, { url: 'https://example.com/a' }), /本次搜索/);
  const found = await call(tools.search, { query: '资料' }); assert.equal(found.results.length, 1);
  const page = await call(tools.readPage, { url: 'https://example.com/a' });
  assert.equal(page.content, '正文'); assert.equal(page.contentHash, createHash('sha256').update('正文').digest('hex'));
  await assert.rejects(call(tools.readPage, { url: 'https://example.com/other' }), /本次搜索/);
  for (let i = 0; i < 4; i++) await call(tools.search, { query: '资料' });
  await assert.rejects(call(tools.search, { query: '资料' }), /上限/);
  assert.ok(requests.every(url => url.startsWith('https://api.tavily.com/')));
});

/** 跨文件解析与局部同名符号使用隔离内存候选，不读取宿主项目。 */
test('候选语义引用跨文件解析并区分不同作用域的同名变量', async () => {
  const { tools, files } = candidateFixture();
  files['src/a.ts'] = 'export const value = 1;\nfunction other(value: number) { return value; }\n';
  files['src/b.ts'] = "import { value } from './a';\nconsole.log(value);\n";
  const result = await call(tools.codeReferences, { path: 'src/a.ts', line: 1, column: 14, cursor: 0 });
  assert.ok(result.matches.some((item: any) => item.path === 'src/b.ts' && item.line === 2));
  assert.equal(result.matches.some((item: any) => item.path === 'src/a.ts' && item.line === 2), false);
  assert.match(result.scope, /未加载/);
});

test('外部工具仅在显式配置的 live 产品生成尝试中装配', async () => {
  const { generateProductContent } = await import('../src/intake/product-generation.js');
  const observed: any[] = [];
  const agent = { generate: async (_prompt: string, options: any) => { observed.push(options.toolsets); return { text: '完成', finishReason: 'stop', steps: [{ text: '完成' }], toolResults: [] }; } } as any;
  await generateProductContent(agent, '合成', 'analysis', 'fixture', undefined, 0, undefined, undefined, undefined, undefined, 'fake-key');
  await generateProductContent(agent, '合成', 'analysis', 'live');
  await generateProductContent(agent, '合成', 'analysis', 'live', undefined, 0, undefined, undefined, undefined, undefined, 'fake-key');
  assert.equal(observed[0]?.external, undefined);
  assert.equal(observed[1]?.external, undefined);
  assert.ok(observed[2].external.search); assert.ok(observed[2].external.readPage);
  assert.equal(JSON.stringify(observed[2]).includes('fake-key'), false);
});

test('真实 Mastra 工具循环的外部回执可写入产品状态且不保存 URL 参数', async () => {
  const { Agent } = await import('@mastra/core/agent');
  const { MastraLanguageModelV2Mock } = await import('@mastra/core/test-utils/llm-mock');
  const { externalSourceReceipts } = await import('../src/intake/external-evidence.js');
  const { productWorkSchema } = await import('../src/mastra/workflows/product-contract.js');
  const transport = (async () => new Response(JSON.stringify({ results: [{ url: 'https://example.com/article?token=private', title: '文章', content: '合成摘要' }] }), { status: 200 })) as typeof fetch;
  let index = 0;
  const model = new MastraLanguageModelV2Mock({ doGenerate: async () => ({ content: index++ === 0 ? [{ type: 'tool-call' as const, toolCallId: 'call-1', toolName: 'external_search', input: JSON.stringify({ query: '合成检索词' }) }] : [{ type: 'text' as const, text: '完成' }], finishReason: index === 1 ? 'tool-calls' as const : 'stop' as const, usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 }, warnings: [] }) });
  const agent = new Agent({ id: 'external-receipt-test', name: '回执测试', model, instructions: '执行搜索' });
  const output = await agent.generate('合成', { toolsets: { external: createExternalResearchTools('synthetic', transport) }, maxSteps: 3 });
  const receipts = externalSourceReceipts(output.toolResults);
  assert.equal(receipts.length, 1); assert.equal(receipts[0].url, 'https://example.com/article'); assert.equal(receipts[0].kind, 'search');
  const restored = productWorkSchema.parse({ version: 'product-graph.v1', entries: [{ role: 'analysis', content: '完成', toolNames: ['external_search'], modelSteps: 2, externalSources: receipts }] });
  assert.deepEqual(restored.entries[0].externalSources, receipts);
  assert.doesNotMatch(JSON.stringify(restored), /private|合成检索词|合成摘要/);
});

test('外部来源回执拒绝失败结果并保留网页提取散列和历史兼容', async () => {
  const { externalSourceReceipts } = await import('../src/intake/external-evidence.js');
  const { productWorkSchema, productQualityReviewSchema } = await import('../src/mastra/workflows/product-contract.js');
  const result = { provider: 'tavily', url: 'https://example.com/a?secret=123', retrievedAt: '2026-11-23T00:00:00.000Z', contentHash: 'a'.repeat(64), truncated: true };
  const receipts = externalSourceReceipts([{ payload: { toolName: 'external_readPage', result } }, { payload: { toolName: 'external_readPage', isError: true, result } }]);
  assert.deepEqual(receipts, [{ provider: 'tavily', kind: 'page', url: 'https://example.com/a', retrievedAt: result.retrievedAt, contentHash: result.contentHash, truncated: true }]);
  assert.equal(productWorkSchema.parse({ version: 'product-graph.v1', entries: [] }).entries.length, 0);
  assert.equal(productQualityReviewSchema.parse({ version: 'product-quality-review.v1', agent: 'product-reviewer-agent', content: '历史审查', hash: 'b'.repeat(64), toolNames: [] }).externalSources, undefined);
});
