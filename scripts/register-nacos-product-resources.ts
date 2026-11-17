/** 将经审查的导出包注册到本机 Nacos；不覆盖已存在的不同内容。 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { z } from 'zod';
import { readSkillZip } from '../src/mastra/nacos-resources.js';
import { validateSkillContent } from '@mastra/core/skills';

const root = resolve(process.argv[2] ?? '');
if (!process.argv[2] || process.argv[3] !== '--apply') throw new Error('用法：tsx scripts/register-nacos-product-resources.ts <审查后的导出目录> --apply');
const base = new URL(z.url().parse(process.env.NACOS_PUBLISH_URL));
if (base.hostname !== '127.0.0.1' || base.protocol !== 'http:' || base.username || base.password || base.pathname !== '/' || base.search || base.hash) throw new Error('本地导入器仅允许 127.0.0.1 HTTP 根地址');
const namespace = z.string().min(1).parse(process.env.NACOS_PUBLISH_NAMESPACE);
const username = z.string().min(1).parse(process.env.NACOS_PUBLISH_USERNAME);
const password = z.string().min(1).parse(process.env.NACOS_PUBLISH_PASSWORD);
const digestSchema = z.string().regex(/^[0-9a-f]{64}$/);
const manifest = z.object({ version: z.string(), prompts: z.array(z.object({ name: z.string().regex(/^[a-z0-9-]+$/), version: z.string(), source: z.string(), sha256: digestSchema })), skills: z.array(z.object({ name: z.string().regex(/^[a-z0-9-]+$/), version: z.string(), archive: z.string().regex(/^[a-z0-9-]+\.zip$/), archiveSha256: digestSchema })) }).passthrough().parse(JSON.parse(readFileSync(join(root, 'manifest.json'), 'utf8')));

/** 计算资源摘要，用于检测本地文件漂移。 */
function hash(value: string | Buffer) { return createHash('sha256').update(value).digest('hex'); }

/** 所有请求均限制时间并禁止重定向，避免泄露令牌。 */
async function request(path: string, init: RequestInit = {}) {
  return fetch(new URL(path, base), { ...init, redirect: 'error', signal: AbortSignal.timeout(15000) });
}

/** 检查服务端 JSON 响应，错误中不包含令牌或资源正文。 */
async function json(response: Response) {
  if (!response.ok) throw new Error(`Nacos 请求失败 HTTP ${response.status}`);
  const value: any = await response.json();
  if (value.code !== undefined && value.code !== 0) throw new Error(`Nacos 返回错误 code=${value.code}`);
  return value;
}

const login = await json(await request('/nacos/v3/auth/user/login', { method: 'POST', body: new URLSearchParams({ username, password }) }));
const token = z.string().min(1).parse(login.accessToken);
/** 通过已认证接口查询精确版本，404 明确表示不存在。 */
async function client(path: string, params: Record<string, string>) {
  return request(`${path}?${new URLSearchParams(params)}`, { headers: { accessToken: token } });
}
/** 用表单提交资源或发布请求。 */
async function post(path: string, params: Record<string, string>) {
  return json(await request(path, { method: 'POST', headers: { accessToken: token }, body: new URLSearchParams(params) }));
}
/** 在线读取并比较 Prompt；已存在但内容不同直接停止。 */
async function verifyPrompt(name: string, version: string, content: string) {
  const response = await client('/nacos/v3/client/ai/prompt', { namespaceId: namespace, promptKey: name, version });
  if (response.status === 404) return false;
  const value = await json(response);
  if (value.data?.promptKey !== name || value.data?.version !== version || value.data?.template !== content) throw new Error(`Prompt 同版本内容不一致：${name}`);
  return true;
}
/** 在线读取 Skill 并按正文及引用对比，避免 ZIP 元数据差异。 */
async function verifySkill(name: string, version: string, local: Buffer) {
  const response = await client('/nacos/v3/client/ai/skills', { namespaceId: namespace, name, version });
  if (response.status === 404) return false;
  if (!response.ok || response.headers.get('x-nacos-skill-resolved-version') !== version) throw new Error(`Skill 读取失败或版本不匹配：${name} HTTP ${response.status}`);
  const remote = Buffer.from(await response.arrayBuffer());
  if (remote.length > 1024 * 1024) throw new Error(`Skill 超过大小限制：${name}`);
  const a = await readSkillZip(local); const b = await readSkillZip(remote);
  /** Nacos 会规范化 frontmatter；比较 Mastra 实际解析的完整元数据、正文和引用。 */
  const canonical = (value: typeof a) => {
    const parsed = validateSkillContent({ content: value.content });
    if (!parsed.valid || parsed.metadata?.name !== name) throw new Error(`Skill 内容无效：${name}`);
    return JSON.stringify({ metadata: parsed.metadata, instructions: parsed.instructions, references: Object.fromEntries(Object.entries(value.references).sort(/** 按路径排序。 */([x], [y]) => x.localeCompare(y))) });
  };
  if (canonical(a) !== canonical(b)) throw new Error(`Skill 同版本内容不一致：${name}`);
  return true;
}

for (const prompt of manifest.prompts) {
  const source = resolve(prompt.source);
  if (!source.startsWith(`${resolve('nacos-resources/product/prompts')}/`)) throw new Error('Prompt 来源路径无效');
  const content = readFileSync(source, 'utf8');
  if (hash(content) !== prompt.sha256) throw new Error(`Prompt 与审查清单不符：${prompt.name}`);
  if (!(await verifyPrompt(prompt.name, prompt.version, content))) {
    await post('/nacos/v3/admin/ai/prompt', { namespaceId: namespace, promptKey: prompt.name, version: prompt.version, template: content });
    let online = false;
    for (let attempt = 0; attempt < 30; attempt++) {
      const detail = await json(await client('/nacos/v3/admin/ai/prompt/version', { namespaceId: namespace, promptKey: prompt.name, version: prompt.version }));
      const status = detail.data?.status;
      if (status === 'reviewed') await post('/nacos/v3/admin/ai/prompt/publish', { namespaceId: namespace, promptKey: prompt.name, version: prompt.version });
      if (await verifyPrompt(prompt.name, prompt.version, content)) { online = true; break; }
      if (status && !['reviewing', 'reviewed', 'online'].includes(status)) throw new Error(`Prompt 未通过 Nacos 审核：${prompt.name} ${status}`);
      await delay(1000);
    }
    if (!online) throw new Error(`Prompt 尚未上线：${prompt.name}`);
  }
  console.log(`已核验 Prompt：${prompt.name}@${prompt.version}`);
}
for (const skill of manifest.skills) {
  const archive = readFileSync(join(root, skill.archive));
  if (archive.length > 1024 * 1024 || hash(archive) !== skill.archiveSha256) throw new Error(`Skill 包与审查清单不符：${skill.name}`);
  if (!(await verifySkill(skill.name, skill.version, archive))) {
    const form = new FormData();
    form.set('namespaceId', namespace); form.set('targetVersion', skill.version); form.set('autoPublishIfNew', 'true');
    form.set('file', new Blob([new Uint8Array(archive)], { type: 'application/zip' }), skill.archive);
    await json(await request('/nacos/v3/admin/ai/skills/upload', { method: 'POST', headers: { accessToken: token }, body: form }));
    let online = false;
    for (let attempt = 0; attempt < 30; attempt++) {
      if (await verifySkill(skill.name, skill.version, archive)) { online = true; break; }
      await delay(1000);
    }
    if (!online) throw new Error(`Skill 尚未上线：${skill.name}`);
  }
  console.log(`已核验 Skill：${skill.name}@${skill.version}`);
}
