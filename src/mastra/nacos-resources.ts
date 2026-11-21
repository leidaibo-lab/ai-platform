/** Nacos AI Registry 的只读 Adapter；Run 快照是已解析内容，不保存凭据。
 * ADR: docs/decisions/2026-11-17-nacos-mastra-resources.md
 */
import { createHash } from 'node:crypto';
import { posix } from 'node:path';
import { fromBuffer, type Entry } from 'yauzl';
import { z } from 'zod';
import { validateSkillContent } from '@mastra/core/skills';
import { methodBindingsSchema, teamMethodsSchema, type MethodBindings, type TeamMethods } from './team-method-contracts.js';

const limit = 1024 * 1024;
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const resourceSchema = z.object({ name: z.string().min(1).max(200), version: z.string().min(1).max(100), sha256: digest, content: z.string().min(1).max(limit) }).strict();
const skillSchema = resourceSchema.extend({ references: z.record(z.string(), z.string().max(limit)) });
export const nacosSnapshotSchema = z.object({ schemaVersion: z.literal('nacos-product-resources.v1'), source: z.url(), namespace: z.string().min(1), prompt: resourceSchema, reviewerPrompt: resourceSchema.optional(), skill: skillSchema, additionalSkills: z.array(skillSchema).max(127).optional(), reviewerSkills: z.array(z.string().min(1).max(200)).max(128).optional(), methods: teamMethodsSchema.optional() }).strict();
export type NacosSnapshot = z.infer<typeof nacosSnapshotSchema>;
export interface NacosResourceConfig { url: string; namespace: string; username: string; password: string; promptName: string; promptVersion: string; skillName: string; skillVersion: string; reviewerPrompt?: { name: string; version: string }; additionalSkills?: { name: string; version: string }[]; reviewerSkills?: string[]; methods?: MethodBindings }

/** 仅投影资源版本和摘要，用于审批及对外交接，不包含正文或凭据。 */
export function nacosResourceIdentity(snapshot: NacosSnapshot) {
  /** 保留身份、精确版本与内容摘要。 */
  const ref = (resource: { name: string; version: string; sha256: string }) => ({ name: resource.name, version: resource.version, sha256: resource.sha256 });
  return { source: snapshot.source, namespace: snapshot.namespace, prompt: ref(snapshot.prompt), skill: ref(snapshot.skill), ...(snapshot.reviewerPrompt ? { reviewerPrompt: ref(snapshot.reviewerPrompt) } : {}), ...(snapshot.additionalSkills ? { additionalSkills: snapshot.additionalSkills.map(ref) } : {}), ...(snapshot.reviewerSkills ? { reviewerSkills: snapshot.reviewerSkills } : {}), ...(snapshot.methods ? { methods: { schemaVersion: snapshot.methods.schemaVersion, sha256: snapshot.methods.sha256 } } : {}) };
}

/** 为快照内容计算可重复的 SHA-256。 */
function hash(value: string | Buffer): string { return createHash('sha256').update(value).digest('hex'); }

/** 收集有界响应流；不信任远端 Content-Length。 */
async function bounded(response: Response): Promise<Buffer> {
  if (!response.ok || !response.body) throw new Error(`Nacos 请求失败（HTTP ${response.status}）`);
  const reader = response.body.getReader(); const chunks: Uint8Array[] = []; let size = 0;
  try {
    while (true) { const part = await reader.read(); if (part.done) break; size += part.value.byteLength; if (size > limit) throw new Error('Nacos 资源超过大小限制'); chunks.push(part.value); }
  } finally { await reader.cancel().catch(/** 读取结束后的取消不影响结果。 */() => {}); }
  return Buffer.concat(chunks);
}

/** 只读取 ZIP 中唯一 SKILL.md 与 references 文本；拒绝链接、越界和过大条目。 */
export async function readSkillZip(bytes: Buffer): Promise<{ content: string; references: Record<string, string> }> {
  return await new Promise((resolve, reject) => {
    fromBuffer(bytes, { lazyEntries: true, validateEntrySizes: true, strictFileNames: true }, (error, zip) => {
      if (error || !zip) { reject(new Error('Skill ZIP 无效')); return; }
      const files: Record<string, string> = Object.create(null); let size = 0; let count = 0;
      /** 对无效包统一失败并关闭读取。 */
      function fail() { zip!.close(); reject(new Error('Skill ZIP 内容不安全或无效')); }
      zip.on('error', fail);
      zip.on('entry', (entry: Entry) => {
        const name = entry.fileName;
        if (++count > 128 || name.includes('\\') || name.startsWith('/') || /[\x00-\x1f]/.test(name) || name.split('/').some(/** 不允许路径跳转与原型字段。 */part => part === '..' || part === '.' || part === '__proto__' || part === 'constructor' || part === 'prototype') || ((entry.externalFileAttributes >>> 16) & 0o170000) === 0o120000) { fail(); return; }
        if (/\/$/.test(name)) { zip.readEntry(); return; }
        if (entry.uncompressedSize > limit || (size += entry.uncompressedSize) > limit || files[name] !== undefined) { fail(); return; }
        zip.openReadStream(entry, (streamError, stream) => {
          if (streamError || !stream) { fail(); return; }
          const parts: Buffer[] = []; let received = 0;
          stream.on('data', (chunk: Buffer) => { received += chunk.length; if (received > entry.uncompressedSize || received > limit) { stream.destroy(); fail(); } else parts.push(chunk); });
          stream.on('error', fail);
          stream.on('end', () => { files[name] = Buffer.concat(parts).toString('utf8'); zip.readEntry(); });
        });
      });
      zip.on('end', () => {
        const candidates = Object.keys(files).filter(/** 限定根目录或单层 Skill 包。 */name => name === 'SKILL.md' || /^[^/]+\/SKILL\.md$/.test(name));
        if (candidates.length !== 1) { fail(); return; }
        const skillFile = candidates[0]!; const prefix = skillFile === 'SKILL.md' ? '' : `${posix.dirname(skillFile)}/`;
        const references: Record<string, string> = Object.create(null);
        for (const [name, value] of Object.entries(files)) {
          if (name === skillFile) continue;
          if (!name.startsWith(`${prefix}references/`)) { fail(); return; }
          references[name.slice(`${prefix}references/`.length)] = value;
        }
        resolve({ content: files[skillFile]!, references });
      });
      zip.readEntry();
    });
  });
}

/** 校验冻结内容及摘要；读取后不得重新从注册中心替换旧 Run 的内容。 */
export function validateNacosSnapshot(input: unknown): NacosSnapshot {
  const snapshot = nacosSnapshotSchema.parse(input);
  if (Buffer.byteLength(JSON.stringify(snapshot)) > 8 * limit) throw new Error('冻结资源超过总大小限制');
  for (const prompt of [snapshot.prompt, ...(snapshot.reviewerPrompt ? [snapshot.reviewerPrompt] : [])]) if (hash(prompt.content) !== prompt.sha256) throw new Error('冻结的 Nacos 资源摘要不匹配');
  const names = new Set<string>();
  for (const skill of [snapshot.skill, ...(snapshot.additionalSkills ?? [])]) {
    const skillValue = JSON.stringify({ content: skill.content, references: Object.fromEntries(Object.entries(skill.references).sort(([a], [b]) => a.localeCompare(b))) });
    if (hash(skillValue) !== skill.sha256) throw new Error('冻结的 Nacos 资源摘要不匹配');
    const definition = validateSkillContent({ content: skill.content });
    if (!definition.valid || !definition.metadata || definition.metadata.name !== skill.name || names.has(skill.name)) throw new Error('冻结的 Nacos Skill 无效或重复');
    names.add(skill.name);
  }
  if (snapshot.reviewerSkills && (new Set(snapshot.reviewerSkills).size !== snapshot.reviewerSkills.length || snapshot.reviewerSkills.some(/** 角色绑定只能选择冻结集合中的名称。 */name => !names.has(name)))) throw new Error('审查角色 Skill 绑定无效');
  if (snapshot.methods) {
    validateTeamMethods(snapshot.methods);
    if (snapshot.methods.source !== snapshot.source || snapshot.methods.namespace !== snapshot.namespace) throw new Error('团队方法目录与 Run 资源来源不一致');
  }
  return snapshot;
}

/** 建立一次有界只读会话，凭据和令牌只留在调用闭包。 */
async function createNacosReader(config: NacosResourceConfig) {
  const base = new URL(config.url);
  if (!['http:', 'https:'].includes(base.protocol) || base.username || base.password || base.pathname !== '/' || base.search || base.hash) throw new Error('Nacos 地址无效');
  /** 所有请求均限制时长且禁止重定向，避免转发凭据。 */
  async function call(path: string, init: RequestInit = {}) { return fetch(new URL(path, base), { ...init, redirect: 'error', signal: AbortSignal.timeout(10000) }); }
  const login = await bounded(await call('/nacos/v3/auth/user/login', { method: 'POST', body: new URLSearchParams({ username: config.username, password: config.password }) }));
  const token = z.object({ accessToken: z.string().min(1) }).parse(JSON.parse(login.toString('utf8'))).accessToken;
  /** 以配置的 namespace 和精确版本读取资源。 */
  async function get(path: string, params: Record<string, string>) { const response = await call(`${path}?${new URLSearchParams(params)}`, { headers: { accessToken: token } }); return { bytes: await bounded(response), headers: response.headers }; }
  /** 查询并校验一个指定版本的 Prompt。 */
  async function getPrompt(ref: { name: string; version: string }) {
    const { bytes } = await get('/nacos/v3/client/ai/prompt', { namespaceId: config.namespace, promptKey: ref.name, version: ref.version });
    const value = z.object({ code: z.literal(0), data: z.object({ promptKey: z.string(), version: z.string(), template: z.string().min(1).max(limit) }) }).parse(JSON.parse(bytes.toString('utf8'))).data;
    if (value.promptKey !== ref.name || value.version !== ref.version) throw new Error('Nacos Prompt 版本不匹配');
    return { name: ref.name, version: ref.version, content: value.template, sha256: hash(value.template) };
  }
  /** 查询并验证一个指定版本的 Skill 包。 */
  async function getSkill(ref: { name: string; version: string }) {
    const { bytes, headers } = await get('/nacos/v3/client/ai/skills', { namespaceId: config.namespace, name: ref.name, version: ref.version });
    if (headers.get('x-nacos-skill-resolved-version') !== ref.version) throw new Error('Nacos Skill 版本不匹配');
    const skill = await readSkillZip(bytes);
    const value = JSON.stringify({ content: skill.content, references: Object.fromEntries(Object.entries(skill.references).sort(([a], [b]) => a.localeCompare(b))) });
    return { name: ref.name, version: ref.version, content: skill.content, references: skill.references, sha256: hash(value) };
  }
  return { getPrompt, getSkill, source: base.origin };
}

/** 对冻结目录作递归稳定编码，避免键序影响跨进程身份。 */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(',')}}`;
  return JSON.stringify(value);
}

/** 验证每项正文、完整引用及目录绑定摘要，拒绝篡改和无效 Skill。 */
export function validateTeamMethods(input: unknown): TeamMethods {
  const value = teamMethodsSchema.parse(input);
  const { sha256, ...body } = value;
  if (Buffer.byteLength(JSON.stringify(value)) > 8 * limit || hash(canonical(body)) !== sha256) throw new Error('团队方法目录摘要不匹配或超过限制');
  for (const prompt of Object.values(value.prompts)) if (hash(prompt.content) !== prompt.sha256) throw new Error('团队 Prompt 摘要不匹配');
  for (const skill of Object.values(value.skills)) {
    if (Object.keys(skill.references).some(path => !path || path.includes('\\') || path.startsWith('/') || /[\x00-\x1f]/.test(path) || path.split('/').some(part => ['..', '.', '__proto__', 'constructor', 'prototype'].includes(part)))) throw new Error('团队 Skill 引用路径不安全');
    if (hash(JSON.stringify({ content: skill.content, references: Object.fromEntries(Object.entries(skill.references).sort(([a], [b]) => a.localeCompare(b))) })) !== skill.sha256) throw new Error('团队 Skill 摘要不匹配');
    const definition = validateSkillContent({ content: skill.content });
    if (!definition.valid || definition.metadata?.name !== skill.name) throw new Error('团队 Skill 声明无效');
  }
  return value;
}

/** 使用同一只读会话冻结全团队目录，逐项限制累计大小。 */
async function readTeamMethods(reader: Awaited<ReturnType<typeof createNacosReader>>, namespace: string, input: MethodBindings): Promise<TeamMethods> {
  const bindings = methodBindingsSchema.parse(input);
  const prompts: TeamMethods['prompts'] = {}; const skills: TeamMethods['skills'] = {};
  let size = 0;
  for (const [key, ref] of Object.entries(bindings.prompts)) {
    prompts[key] = await reader.getPrompt(ref); size += Buffer.byteLength(JSON.stringify(prompts[key]));
    if (size > 8 * limit) throw new Error('团队方法超过总大小限制');
  }
  for (const [key, ref] of Object.entries(bindings.skills)) {
    skills[key] = await reader.getSkill(ref); size += Buffer.byteLength(JSON.stringify(skills[key]));
    if (size > 8 * limit) throw new Error('团队方法超过总大小限制');
  }
  const body = { schemaVersion: 'nacos-team-methods.v1' as const, source: reader.source, namespace, prompts, skills };
  return validateTeamMethods({ ...body, sha256: hash(canonical(body)) });
}

/** 调用前只复核原目录中的精确版本，不采用新默认值或静默降级。 */
export async function verifyTeamMethods(config: NacosResourceConfig | undefined, input: TeamMethods): Promise<void> {
  const frozen = validateTeamMethods(input);
  if (!config || new URL(config.url).origin !== frozen.source) throw new Error('团队方法 Nacos 来源不可用');
  const ref = ({ name, version }: { name: string; version: string }) => ({ name, version });
  const bindings = methodBindingsSchema.parse({ prompts: Object.fromEntries(Object.entries(frozen.prompts).map(([key, value]) => [key, ref(value)])), skills: Object.fromEntries(Object.entries(frozen.skills).map(([key, value]) => [key, ref(value)])) });
  const current = await readTeamMethods(await createNacosReader({ ...config, namespace: frozen.namespace }), frozen.namespace, bindings);
  if (current.sha256 !== frozen.sha256) throw new Error('团队方法版本发生漂移');
}

/** 通过 Nacos Client API 获取指定版本，冻结可恢复的正文及参考资料。 */
export async function loadNacosSnapshot(config: NacosResourceConfig): Promise<NacosSnapshot> {
  const reader = await createNacosReader(config);
  const { getPrompt, getSkill } = reader;
  const prompt = await getPrompt({ name: config.promptName, version: config.promptVersion });
  const reviewerPrompt = config.reviewerPrompt ? await getPrompt(config.reviewerPrompt) : undefined;
  const skill = await getSkill({ name: config.skillName, version: config.skillVersion });
  const additionalSkills: Awaited<ReturnType<typeof getSkill>>[] | undefined = config.additionalSkills ? [] : undefined;
  let totalBytes = Buffer.byteLength(JSON.stringify({ prompt, reviewerPrompt, skill }));
  for (const ref of config.additionalSkills ?? []) {
    const item = await getSkill(ref);
    totalBytes += Buffer.byteLength(JSON.stringify(item));
    if (totalBytes > 8 * limit) throw new Error('冻结资源超过总大小限制');
    additionalSkills!.push(item);
  }
  const methods = config.methods ? await readTeamMethods(reader, config.namespace, config.methods) : undefined;
  return validateNacosSnapshot({ schemaVersion: 'nacos-product-resources.v1', source: reader.source, namespace: config.namespace, prompt, reviewerPrompt, skill, additionalSkills, reviewerSkills: config.reviewerSkills, ...(methods ? { methods } : {}) });
}

/** 每次调用前确认原版本仍可访问；授权撤销或版本漂移时失败关闭。 */
export async function verifyNacosAccess(config: NacosResourceConfig | undefined, snapshot: NacosSnapshot): Promise<void> {
  const frozen = validateNacosSnapshot(snapshot);
  if (!config || new URL(config.url).origin !== frozen.source) throw new Error('冻结资源的 Nacos 来源不可用');
  const current = await loadNacosSnapshot({ ...config, methods: undefined, namespace: frozen.namespace, promptName: frozen.prompt.name, promptVersion: frozen.prompt.version, reviewerPrompt: frozen.reviewerPrompt && { name: frozen.reviewerPrompt.name, version: frozen.reviewerPrompt.version }, skillName: frozen.skill.name, skillVersion: frozen.skill.version, additionalSkills: frozen.additionalSkills?.map(/** 恢复读取原冻结版本，而非当前默认配置。 */skill => ({ name: skill.name, version: skill.version })), reviewerSkills: frozen.reviewerSkills });
  if (current.prompt.sha256 !== frozen.prompt.sha256 || current.reviewerPrompt?.sha256 !== frozen.reviewerPrompt?.sha256 || current.skill.sha256 !== frozen.skill.sha256 || JSON.stringify(current.additionalSkills?.map(/** 依次核对全部方法摘要。 */skill => skill.sha256)) !== JSON.stringify(frozen.additionalSkills?.map(/** 按快照顺序比较。 */skill => skill.sha256))) throw new Error('Nacos 资源版本发生漂移');
  if (frozen.methods) await verifyTeamMethods(config, frozen.methods);
}
