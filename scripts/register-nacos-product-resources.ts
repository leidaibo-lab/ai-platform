/** 将经审查的导出包注册到本机 Nacos；不覆盖已存在的不同内容。 */
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';
import { readSkillZip } from '../src/mastra/nacos-resources.js';
import { validateSkillContent } from '@mastra/core/skills';

const root = resolve(process.argv[2] ?? '');
if (!process.argv[2] || process.argv[3] !== '--apply') throw new Error('用法：tsx scripts/register-nacos-product-resources.ts <审查后的导出目录> --apply');
const base = new URL(z.url().parse(process.env.NACOS_PUBLISH_URL));
if (base.hostname !== '127.0.0.1' || base.protocol !== 'http:' || base.username || base.password || base.pathname !== '/' || base.search || base.hash) throw new Error('本地导入器仅允许 127.0.0.1 HTTP 根地址');
/** 拒绝空发布配置，错误只包含变量名，保留密码原样。 */
function requiredPublishValue(name: string) {
  const value = process.env[name];
  if (!value?.trim()) throw new Error(`请在当前终端设置非空的 ${name}。浏览器登录不会设置发布脚本的环境变量。`);
  return value;
}

const namespace = requiredPublishValue('NACOS_PUBLISH_NAMESPACE');
const username = requiredPublishValue('NACOS_PUBLISH_USERNAME');
const password = requiredPublishValue('NACOS_PUBLISH_PASSWORD');
const digestSchema = z.string().regex(/^[0-9a-f]{64}$/);
const skillVersionSchema = z.string().regex(/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/);
const manifest = z.object({ version: z.string(), prompts: z.array(z.object({ name: z.string().regex(/^[a-z0-9-]+$/), version: z.string(), source: z.string(), sha256: digestSchema })), skills: z.array(z.object({ name: z.string().regex(/^[a-z0-9-]+$/), version: skillVersionSchema, archive: z.string().regex(/^[a-z0-9-]+\.zip$/), archiveSha256: digestSchema })) }).passthrough().parse(JSON.parse(readFileSync(join(root, 'manifest.json'), 'utf8')));

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
/** 比较完整正文、元数据和引用，识别 Nacos 对版本字段的同步。 */
async function verifySkillContent(name: string, version: string, local: Buffer, response: Response) {
  if (!response.ok) throw new Error(`Skill 读取失败：${name}@${version} HTTP ${response.status}`);
  const remote = Buffer.from(await response.arrayBuffer());
  if (remote.length > 1024 * 1024) throw new Error(`Skill 超过大小限制：${name}`);
  /** 分离由 Nacos 维护的发布版本与 Skill 自身的 metadata.version。 */
  const canonical = (value: Awaited<ReturnType<typeof readSkillZip>>) => {
    const parsed = validateSkillContent({ content: value.content });
    if (!parsed.valid || parsed.metadata?.name !== name) throw new Error(`Skill 内容无效：${name}`);
    const { version: releaseVersion, ...metadata } = parsed.metadata;
    return { releaseVersion, metadata, instructions: parsed.instructions, references: value.references };
  };
  const expected = canonical(await readSkillZip(local));
  const actual = canonical(await readSkillZip(remote));
  if (actual.releaseVersion !== undefined && actual.releaseVersion !== version) throw new Error(`Skill 正文版本不匹配：${name}@${version}`);
  const sourceMetadata = z.record(z.string(), z.unknown()).optional().parse(expected.metadata.metadata);
  const registryMetadata = z.record(z.string(), z.unknown()).optional().parse(actual.metadata.metadata);
  if (typeof sourceMetadata?.version === 'string' && registryMetadata?.version === version) {
    actual.metadata.metadata = { ...registryMetadata, version: sourceMetadata.version };
  }
  if (!isDeepStrictEqual(expected.metadata, actual.metadata)) throw new Error(`Skill 同版本元数据不一致：${name}@${version}`);
  if (expected.instructions !== actual.instructions) throw new Error(`Skill 同版本正文不一致：${name}@${version}`);
  if (!isDeepStrictEqual(expected.references, actual.references)) throw new Error(`Skill 同版本引用文件不一致：${name}@${version}`);
}

/** 上传副本的顶层版本优先于方法自身版本，审查用原始 ZIP 保持原样。 */
async function buildSkillUpload(archive: Buffer, version: string) {
  const { content, references } = await readSkillZip(archive);
  const opening = /^(---\r?\n)([\s\S]*?)(\r?\n---(?:\r?\n|$))/;
  if (!opening.test(content)) throw new Error('Skill 缺少可写入发布版本的 frontmatter');
  const markdown = content.replace(opening, /** 统一声明顶层版本，并保留原始方法元数据。 */(_header, start: string, fields: string, end: string) =>
    `${start}version: ${version}\n${fields.replace(/^version:[^\r\n]*(?:\r?\n|$)/gm, '').trimEnd()}${end}`);
  const directory = mkdtempSync(join(tmpdir(), 'nacos-skill-upload-'));
  try {
    const files = { 'SKILL.md': markdown, ...Object.fromEntries(Object.entries(references).map(/** 恢复经 ZIP 适配器检查的引用路径。 */([path, text]) => [`references/${path}`, text])) };
    const source = join(directory, 'source');
    for (const [path, text] of Object.entries(files)) {
      const target = join(source, path);
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, text, { flag: 'wx' });
    }
    const target = join(directory, 'upload.zip');
    execFileSync('zip', ['-q', '-X', target, ...Object.keys(files)], { cwd: source });
    return readFileSync(target);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

/** 通过应用使用的接口确认精确版本已上线。 */
async function verifySkill(name: string, version: string, local: Buffer) {
  const response = await client('/nacos/v3/client/ai/skills', { namespaceId: namespace, name, version });
  if (response.status === 404) return false;
  if (response.ok && response.headers.get('x-nacos-skill-resolved-version') !== version) throw new Error(`Skill 客户端版本不匹配：${name}@${version}`);
  await verifySkillContent(name, version, local, response);
  return true;
}

/** 查询管理端的版本状态，区分尚未上传与尚未上线。 */
async function skillStatus(name: string, version: string) {
  const response = await client('/nacos/v3/admin/ai/skills', { namespaceId: namespace, skillName: name });
  if (response.status === 404) return undefined;
  const value = await json(response);
  const versions = z.array(z.object({ version: z.string(), status: z.string(), publishPipelineInfo: z.string().nullish() })).parse(value.data?.versions);
  const entry = versions.find(/** 只处理候选清单的精确版本。 */item => item.version === version);
  if (entry?.status === 'reviewed' && entry.publishPipelineInfo) {
    const review = z.object({ status: z.string() }).parse(JSON.parse(entry.publishPipelineInfo));
    if (review.status === 'REJECTED') throw new Error(`Nacos 发布审核拒绝了 ${name}@${version}，请在控制台查看审核结果。`);
  }
  return entry?.status;
}

/** 校验并通过正常的提审流程推进新版本或既有草稿。 */
async function publishSkill(name: string, version: string, archive: Buffer, filename: string) {
  const params = { namespaceId: namespace, skillName: name, version };
  let status = await skillStatus(name, version);
  if (status === undefined) {
    const form = new FormData();
    form.set('namespaceId', namespace);
    form.set('targetVersion', version);
    form.set('file', new Blob([new Uint8Array(await buildSkillUpload(archive, version))], { type: 'application/zip' }), filename);
    await json(await request('/nacos/v3/admin/ai/skills/upload', { method: 'POST', headers: { accessToken: token }, body: form }));
  }
  await verifySkillContent(name, version, archive, await client('/nacos/v3/admin/ai/skills/version/download', params));
  for (let attempt = 0; attempt < 30; attempt++) {
    if (await verifySkill(name, version, archive)) return;
    status = await skillStatus(name, version);
    if (status === 'draft') await post('/nacos/v3/admin/ai/skills/submit', params);
    else if (status === 'reviewed') await post('/nacos/v3/admin/ai/skills/publish', params);
    else if (status !== 'reviewing' && status !== 'online') throw new Error(`Skill 无法发布：${name}@${version}，状态 ${status ?? '未知'}`);
    if (await verifySkill(name, version, archive)) return;
    await delay(1000);
  }
  throw new Error(`Skill 尚未上线：${name}@${version}，最后状态 ${status ?? '未知'}`);
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
  if (!(await verifySkill(skill.name, skill.version, archive))) await publishSkill(skill.name, skill.version, archive, skill.archive);
  console.log(`已核验 Skill：${skill.name}@${skill.version}`);
}
