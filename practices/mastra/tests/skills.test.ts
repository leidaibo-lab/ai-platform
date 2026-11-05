import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { MastraLanguageModelV2Mock } from '@mastra/core/test-utils/llm-mock';
import { createAgents } from '../src/mastra/agents/index.js';
import { loadGovernedSkill, loadProductSkills } from '../src/mastra/agents/skills.js';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const skillsRoot = resolve(root, '.agents/skills');

/** 来源锁由导入器生成；每项拥有原始来源、解析后来源及完整参考文件散列。 */
interface SourceFile { repository: string; sourcePath: string; localPath: string; sha256: string }
interface LockedEntry {
  name: string; path: string; group: string; kind: 'skills' | 'commands'; sourcePath: string;
  sourceSha256: string; resolvedRepository: string; dependencies: string[]; files: SourceFile[];
}
const lock = JSON.parse(readFileSync(resolve(skillsRoot, 'upstream-lock.json'), 'utf8')) as {
  entries: LockedEntry[]; support: SourceFile[]; licenses: SourceFile[];
};

/** 创建正式产品角色，fixture 配置不会调用远程服务或读取 .env。 */
function agents() {
  return createAgents({ rootDir: root, mode: 'fixture', databaseUrl: 'file::memory:', port: 4111, modelId: 'openai/gpt-4o-mini' });
}

// 检查整个库存与每个实际资源，防止首页解析遗漏、迁移提示代替实现或附属文件丢失。
test('111项上游入口和解析后资源完整且符合来源锁', async () => {
  assert.equal(lock.entries.length, 111);
  const counts = { skills: 0, commands: 0 };
  const loaded = loadProductSkills(skillsRoot);
  const names = new Set(loaded.map(
    // 原生对象名称作为引用解析集合。
    (skill) => skill.name,
  ));
  assert.equal(loaded.length, 112);
  assert.equal(names.size, 112);
  const sources = new Set<string>();
  for (const entry of lock.entries) {
    counts[entry.kind]++;
    assert.ok(!sources.has(entry.sourcePath), `重复上游入口：${entry.sourcePath}`);
    sources.add(entry.sourcePath);
    assert.ok(names.has(entry.name));
    const skill = loaded.find(
      // 按来源锁匹配实际原生注册对象。
      (candidate) => candidate.name === entry.name,
    )!;
    assert.equal(skill.license, 'MIT');
    assert.ok(skill.metadata?.pattern);
    for (const dep of entry.dependencies) assert.ok(names.has(dep), `${entry.name} 依赖不存在：${dep}`);
    for (const file of entry.files) {
      const key = file.localPath.slice(`${entry.path}/references/`.length);
      assert.equal(skill.__referenceContents[key], readFileSync(resolve(skillsRoot, file.localPath), 'utf8'));
    }
    const original = entry.files.find(
      // 迁移项的原始散列对应迁移提示，其他项对应实际方法原文。
      (file) => file.repository === 'pm-skills' && file.sourcePath === entry.sourcePath,
    );
    assert.ok(original);
    assert.equal(original.sha256, entry.sourceSha256);
  }
  assert.deepEqual(counts, { skills: 69, commands: 42 });
  assert.equal(lock.entries.filter(
    // 只解析pm-ai-shipping的8个现有入口。
    (entry) => entry.resolvedRepository === 'product-engineering',
  ).length, 8);
  const allFiles = [...lock.entries.flatMap(
    // 汇总入口资源与支持方法、许可证进行同一字节校验。
    (entry) => entry.files,
  ), ...lock.support, ...lock.licenses];
  for (const file of allFiles) assert.equal(createHash('sha256').update(readFileSync(resolve(skillsRoot, file.localPath))).digest('hex'), file.sha256, file.localPath);
  const catalog = loaded.find(
    // 三个辅助方法归导航Skill持有，避免冒充额外上游入口。
    (skill) => skill.name === 'product-pm-catalog',
  )!;
  for (const file of lock.support) {
    const key = file.localPath.slice('product-pm/catalog/references/'.length);
    assert.equal(catalog.__referenceContents[key], readFileSync(resolve(skillsRoot, file.localPath), 'utf8'));
  }
});

/** 每个模型步骤只有在前一步工具证据真实进入上下文后才继续；不模拟业务推理质量。 */
function scriptedModel(plan: { name: string; input: Record<string, unknown>; previous?: string }[]) {
  let index = 0;
  /** 同步/流式共用序列和证据断言，确保实际框架执行工具结果。 */
  function response(prompt: unknown) {
    const step = plan[index];
    if (step?.previous) assert.ok(JSON.stringify(prompt).includes(step.previous), `前一步结果缺少：${step.previous}`);
    const current = index++;
    return {
      content: step ? [{ type: 'tool-call' as const, toolCallId: `skill-test-${current}`, toolName: step.name, input: JSON.stringify(step.input) }]
        : [{ type: 'text' as const, text: '已读取真实注册方法与参考资料（确定性工具回归，未验证产品推理质量）。' }],
      finishReason: step ? 'tool-calls' as const : 'stop' as const,
      usage: { inputTokens: 10, outputTokens: 10, totalTokens: 20 }, warnings: [],
    };
  }
  return new MastraLanguageModelV2Mock({
    // 由原生Agent执行工具循环，不直接调用工具execute。
    doGenerate: async (options) => response(options.prompt),
    // Studio同样需要逐步工具结果和终答。
    doStream: async (options) => ({ stream: new ReadableStream({
      // 构造原生模型流协议；工具调度仍交给Mastra。
      start(controller) {
        const result = response(options.prompt);
        controller.enqueue({ type: 'stream-start', warnings: [] });
        const content = result.content[0];
        if (content.type === 'tool-call') controller.enqueue(content);
        else {
          controller.enqueue({ type: 'text-start', id: 'skills-text' });
          controller.enqueue({ type: 'text-delta', id: 'skills-text', delta: content.text });
          controller.enqueue({ type: 'text-end', id: 'skills-text' });
        }
        controller.enqueue({ type: 'finish', finishReason: result.finishReason, usage: result.usage });
        controller.close();
      },
    }) }),
  });
}

// 超过旧的3/6步预算，证明流程→方法→原文→嵌套资源的调用链可实际走完。
test('正式产品Agent原生多步加载流程、原子方法、嵌套参考与交接方法', async () => {
  const agent = agents().productAgent;
  const result = await agent.generate('根据提供的需求写PRD并检查风险；本测试只验证工具链', { model: scriptedModel([
    { name: 'skill', input: { name: 'product-pm-flow-write-prd' } },
    { name: 'skill_read', input: { skillName: 'product-pm-flow-write-prd', path: 'references/upstream.md' }, previous: 'product-pm-create-prd' },
    { name: 'skill', input: { name: 'product-pm-create-prd' }, previous: 'write-prd' },
    { name: 'skill_read', input: { skillName: 'product-pm-create-prd', path: 'references/upstream.md' }, previous: '精简产品需求文档' },
    { name: 'skill', input: { name: 'product-pm-code-review' }, previous: 'Who' },
    { name: 'skill_read', input: { skillName: 'product-pm-code-review', path: 'references/correctness-taxonomy.md' }, previous: '代码与状态正确性评审' },
    { name: 'skill', input: { name: 'product-requirements-handoff' }, previous: 'correctness' },
  ]) });
  assert.equal(result.toolResults.length, 7);
  assert.equal(result.steps.length, 8);
  assert.match(result.text, /确定性工具回归/);
  for (const tool of result.toolResults) assert.doesNotMatch(JSON.stringify(tool.payload.result), /not found|Error executing/);
});

// 嵌套参考在Studio流式入口仍可读取，并且任意路径没有宿主文件读取能力。
test('流式产品Agent可读shipping辅助参考，未知路径返回缺失且越界路径被拒绝', async () => {
  const result = await agents().productAgent.stream('检查可用辅助方法', { model: scriptedModel([
    { name: 'skill_read', input: { skillName: 'product-pm-catalog', path: 'references/shipping/test-harness/references/coverage-map.md' } },
    { name: 'skill_search', input: { query: 'coverage', skillNames: ['product-pm-catalog'], topK: 2 }, previous: 'coverage' },
    { name: 'skill_read', input: { skillName: 'product-pm-create-prd', path: '../../../../../package.json' }, previous: 'product-pm-catalog' },
    { name: 'skill_read', input: { skillName: 'missing-skill', path: 'references/upstream.md' }, previous: 'Invalid asset path' },
  ]) });
  await result.consumeStream();
  assert.match(await result.text, /确定性工具回归/);
  const toolResults = await result.toolResults;
  // 原生框架把越界操作记为tool-error，不加入成功toolResults；下一步Mock已检查错误进入模型上下文。
  assert.equal(toolResults.length, 3);
  assert.match(JSON.stringify(toolResults[0].payload.result), /coverage/);
  assert.match(JSON.stringify(toolResults[1].payload.result), /product-pm-catalog/);
  assert.match(JSON.stringify(toolResults[2].payload.result), /not found/);
});

// 结构错误应在启动暴露，不能静默丢掉部分上游能力。
test('损坏Skill正文或参考链接会明确失败', () => {
  const temp = mkdtempSync(resolve(tmpdir(), 'pm-skills-invalid-'));
  try {
    const dir = resolve(temp, 'product-pm/broken');
    mkdirSync(resolve(dir, 'references'), { recursive: true });
    writeFileSync(resolve(dir, 'SKILL.md'), '缺少frontmatter的损坏内容');
    // 从真实校验入口拒绝不含frontmatter的正文。
    assert.throws(() => loadGovernedSkill(temp, 'product-pm/broken'), /Agent Skill 无效/);
    writeFileSync(resolve(dir, 'SKILL.md'), readFileSync(resolve(skillsRoot, 'product-pm/create-prd/SKILL.md')));
    symlinkSync(resolve(root, 'package.json'), resolve(dir, 'references/linked.json'));
    // 参考目录中的链接不能变成任意宿主文件读取能力。
    assert.throws(() => loadGovernedSkill(temp, 'product-pm/broken'), /必须是普通文件/);
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});
