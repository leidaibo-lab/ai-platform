/** 隔离验证 Adapter：原生存储负责版本，宿主只负责资源导入及完整性检查。非正式运行时。 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { MastraLanguageModelV2Mock } from '@mastra/core/test-utils/llm-mock';

/** 实验依赖独立安装，避免将验证中的 editor 引入正式应用依赖。 */
export async function editorConstructor() {
  const root = process.env.MASTRA_EDITOR_PROBE_ROOT;
  assert.ok(root, '请按 stored-role-validation.md 安装并设置 MASTRA_EDITOR_PROBE_ROOT');
  return (await import(pathToFileURL(resolve(root, 'node_modules/@mastra/editor/dist/index.js')).href)).MastraEditor;
}

/** 字节摘要供内容树和实验信任根使用。 */
export function sha(content: string | Buffer) { return createHash('sha256').update(content).digest('hex'); }

/** 导入真实 governed Skill，正文与参考文件都进入原生 blobs/tree，而非只保存 instructions 字段。 */
export async function saveSkill(storage: any, skill: any, suffix = '') {
  const skills = await storage.getStore('skills');
  const blobs = await storage.getStore('blobs');
  const content = `---\nname: ${skill.name}\ndescription: ${JSON.stringify(skill.description)}\n---\n\n${skill.instructions}${suffix}\n`;
  const files: Record<string, string> = { 'SKILL.md': content };
  for (const [path, body] of Object.entries(skill.__referenceContents ?? {})) files[`references/${path}`] = String(body);
  const entries: Record<string, { blobHash: string; size: number }> = {};
  for (const [path, body] of Object.entries(files)) {
    const blobHash = sha(body); const size = Buffer.byteLength(body);
    await blobs.put({ hash: blobHash, content: body, size, createdAt: new Date() });
    entries[path] = { blobHash, size };
  }
  const id = `${skill.name}-${sha(content).slice(0, 12)}`;
  await skills.create({ skill: { id, name: skill.name, description: skill.description, instructions: skill.instructions + suffix, tree: { entries } } });
  const version = await skills.getLatestVersion(id);
  return { id, versionId: version.id, body: skill.instructions + suffix };
}

/** 从现有角色导出职责与工具引用；模型身份固定，固定模型执行通过测试调用显式覆盖。 */
export async function saveRole(storage: any, agent: any, id: string, skill: any, enhanced = false, extraTools: Record<string, any> = {}) {
  const store = await storage.getStore('agents');
  const tools = { ...await agent.listTools(), ...extraTools };
  const toolRefs: Record<string, object> = {};
  for (const key of Object.keys(tools)) toolRefs[key] = {};
  const config = { name: id, instructions: String(await agent.getInstructions()), model: { provider: 'openai', name: enhanced ? 'probe-model-v2' : 'probe-model-v1', temperature: 0.2, topP: 0.8, maxCompletionTokens: 321 }, tools: toolRefs,
    ...(skill ? { workspace: { type: 'inline' as const, config: { name: `${id}-workspace` } } } : {}), skills: skill ? { [skill.id]: { pin: skill.versionId } } : {} };
  await store.create({ agent: { id, ...config } });
  const version = await store.getLatestVersion(id);
  await store.update({ id, status: 'published', activeVersionId: version.id });
  return { id, versionId: version.id, config, tools };
}

/** 固定模型只发出工具调用；真实工具结果必须进入下一步上下文后才输出。 */
export function toolScript(plan: { name: string; input: unknown; expected?: string }[], text = 'fixture完成') {
  let index = 0;
  return new MastraLanguageModelV2Mock({
    /** 验证上一步执行证据，而非直接伪造工具结果。 */
    doGenerate: async ({ prompt }) => {
      if (index > 0 && plan[index - 1]?.expected) assert.ok(JSON.stringify(prompt).includes(JSON.stringify(plan[index - 1].expected!).slice(1, -1)), `未读到工具证据：${plan[index - 1].name}`);
      const call = plan[index++];
      return { content: call ? [{ type: 'tool-call' as const, toolCallId: `probe-${index}`, toolName: call.name, input: JSON.stringify(call.input) }] : [{ type: 'text' as const, text }], finishReason: call ? 'tool-calls' as const : 'stop' as const, usage: { inputTokens: 12, outputTokens: 20, totalTokens: 32 }, warnings: [] };
    },
  });
}

/** Stored Agent 缺失工具会被原生解析器跳过；宿主必须在执行前显式拒绝不完整装配。 */
export async function requireTools(agent: any, expected: string[]) {
  const actual = await agent.listTools();
  for (const name of expected) assert.ok(actual[name], `固定工具不可用：${name}`);
  return actual;
}
