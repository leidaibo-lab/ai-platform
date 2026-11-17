/** 在仅监听回环地址的临时 Nacos 实例验证公开 Client/Admin API。 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createSkill, validateSkillContent } from '@mastra/core/skills';
import { loadNacosSnapshot, verifyNacosAccess } from '../../src/mastra/nacos-resources.ts';

const base = process.env.NACOS_POC_URL;
const password = process.env.NACOS_POC_PASSWORD;
assert.ok(base && password, '需要指定临时 Nacos 地址及测试密码');
const address = new URL(base);
assert.equal(address.hostname, '127.0.0.1', 'PoC 只能访问本机测试实例');
const suffix = randomUUID().slice(0, 8);
const promptName = `poc-prompt-${suffix}`;
const skillName = `poc-skill-${suffix}`;
const mcpName = `poc-mcp-${suffix}`;
const otherNamespace = `poc-${suffix}`;

/** 执行 Nacos HTTP 请求；永不打印凭据或令牌。 */
async function request(path, { method = 'GET', token, params, body } = {}) {
  const url = new URL(path, base);
  if (method === 'GET' && params) url.search = new URLSearchParams(params).toString();
  const response = await fetch(url, { method, headers: { ...(token ? { accessToken: token } : {}), ...(params && method !== 'GET' ? { 'content-type': 'application/x-www-form-urlencoded' } : {}) }, ...(method !== 'GET' && (params || body) ? { body: body ?? new URLSearchParams(params) } : {}), signal: AbortSignal.timeout(15000) });
  const content = await response.text();
  let data;
  try { data = JSON.parse(content); } catch { data = null; }
  return { status: response.status, data, bytes: Buffer.byteLength(content) };
}

/** 校验统一响应，并只报告非敏感错误摘要。 */
function success(label, result) {
  assert.ok(result.status >= 200 && result.status < 300 && (result.data?.code === undefined || result.data.code === 0), `${label}: HTTP ${result.status}, code=${result.data?.code}, message=${result.data?.message}`);
  console.log(`PASS ${label}`);
  return result.data;
}

const login = await request('/nacos/v3/auth/user/login', { method: 'POST', params: { username: 'nacos', password } });
const token = login.data?.accessToken;
assert.ok(token, `管理员登录失败 HTTP ${login.status}`);
console.log('PASS 管理员登录');
success('创建隔离命名空间', await request('/nacos/v3/admin/core/namespace', { method: 'POST', token, params: { namespaceId: otherNamespace, namespaceName: otherNamespace } }));
const limitedUser = `poc-user-${suffix}`;
success('创建无授权用户', await request('/nacos/v3/auth/user', { method: 'POST', token, params: { username: limitedUser, password } }));
const limitedLogin = await request('/nacos/v3/auth/user/login', { method: 'POST', params: { username: limitedUser, password } });
const limitedToken = limitedLogin.data?.accessToken;
assert.ok(limitedToken, `测试用户登录失败 HTTP ${limitedLogin.status}`);

const anonymous = await request('/nacos/v3/client/ai/prompt', { params: { namespaceId: 'public', promptKey: promptName, version: '1.0.0' } });
assert.equal(anonymous.status, 403);
console.log('PASS 未认证 Prompt 查询被拒绝');

success('发布 Prompt', await request('/nacos/v3/admin/ai/prompt', { method: 'POST', token, params: { namespaceId: 'public', promptKey: promptName, version: '1.0.0', template: 'fixture prompt version 1' } }));
/** 等待异步审核，以状态证据判断是否允许后续读取。 */
async function waitForPrompt(namespace = 'public') {
  for (let attempt = 0; attempt < 30; attempt++) {
    const detail = await request('/nacos/v3/admin/ai/prompt/version', { token, params: { namespaceId: namespace, promptKey: promptName, version: '1.0.0' } });
    const state = detail.data?.data?.status;
    if (state !== 'reviewing') return state;
    await new Promise(resolve => setTimeout(resolve, 1000));
  }
  return 'reviewing';
}
const state = await waitForPrompt();
console.log('Prompt 审核后状态:', state);
if (state === 'reviewed') success('上线已审核 Prompt', await request('/nacos/v3/admin/ai/prompt/publish', { method: 'POST', token, params: { namespaceId: 'public', promptKey: promptName, version: '1.0.0' } }));
const prompt = success('按版本读取 Prompt', await request('/nacos/v3/client/ai/prompt', { token, params: { namespaceId: 'public', promptKey: promptName, version: '1.0.0' } }));
assert.equal(prompt.data?.template, 'fixture prompt version 1');
assert.equal(prompt.data?.version, '1.0.0');
const unauthorized = await request('/nacos/v3/client/ai/prompt', { token: limitedToken, params: { namespaceId: 'public', promptKey: promptName, version: '1.0.0' } });
assert.ok(unauthorized.status === 403 || unauthorized.status === 401, `未授权用户意外获得访问 HTTP ${unauthorized.status}`);
console.log(`PASS 无授权用户无法读取 Prompt (HTTP ${unauthorized.status})`);
const cross = await request('/nacos/v3/client/ai/prompt', { token, params: { namespaceId: otherNamespace, promptKey: promptName, version: '1.0.0' } });
assert.notEqual(cross.data?.data?.template, 'fixture prompt version 1');
console.log(`PASS 不同命名空间未读到原 Prompt (HTTP ${cross.status})`);
success('在另一命名空间发布同名 Prompt', await request('/nacos/v3/admin/ai/prompt', { method: 'POST', token, params: { namespaceId: otherNamespace, promptKey: promptName, version: '1.0.0', template: 'fixture prompt other namespace' } }));
const otherState = await waitForPrompt(otherNamespace);
if (otherState === 'reviewed') success('上线另一命名空间 Prompt', await request('/nacos/v3/admin/ai/prompt/publish', { method: 'POST', token, params: { namespaceId: otherNamespace, promptKey: promptName, version: '1.0.0' } }));
const otherPrompt = success('读取另一命名空间 Prompt', await request('/nacos/v3/client/ai/prompt', { token, params: { namespaceId: otherNamespace, promptKey: promptName, version: '1.0.0' } }));
assert.equal(otherPrompt.data?.template, 'fixture prompt other namespace');

const mcp = { name: mcpName, protocol: 'stdio', frontProtocol: 'stdio', versionDetail: { version: '1.0.0' }, localServerConfig: { command: 'node', args: ['fixture.mjs'] } };
success('发布 MCP 描述', await request('/nacos/v3/client/ai/mcp', { method: 'POST', token, params: { namespaceId: 'public', serverSpecification: JSON.stringify(mcp), createDraft: 'false' } }));
const mcpRead = success('按版本读取 MCP', await request('/nacos/v3/client/ai/mcp', { token, params: { namespaceId: 'public', mcpName, version: '1.0.0' } }));
assert.ok(JSON.stringify(mcpRead.data).includes(mcpName));
const deniedMcp = await request('/nacos/v3/client/ai/mcp', { token: limitedToken, params: { namespaceId: 'public', mcpName, version: '1.0.0' } });
assert.equal(deniedMcp.status, 403);
console.log('PASS 无授权用户无法读取 MCP');

const dir = mkdtempSync(join(tmpdir(), 'nacos-skill-poc-'));
const folder = join(dir, skillName);
mkdirSync(folder);
writeFileSync(join(folder, 'SKILL.md'), `---\nname: ${skillName}\ndescription: 只读合成测试方法\n---\n\n# 测试\n\n读取测试事实。\n`);
const archive = join(dir, 'skill.zip');
execFileSync('zip', ['-qr', archive, skillName], { cwd: dir });
const form = new FormData();
form.set('namespaceId', 'public');
form.set('targetVersion', '1.0.0');
form.set('autoPublishIfNew', 'true');
form.set('file', new Blob([readFileSync(archive)], { type: 'application/zip' }), 'skill.zip');
success('上传 Skill', await request('/nacos/v3/admin/ai/skills/upload', { method: 'POST', token, body: form }));
/** 等待 Skill 审核完成，保留已审核与已发布的区别。 */
async function waitForSkill() {
  for (let attempt = 0; attempt < 30; attempt++) {
    const detail = await request('/nacos/v3/admin/ai/skills', { token, params: { namespaceId: 'public', skillName } });
    const status = detail.data?.data?.versions?.find(item => item.version === '1.0.0')?.status;
    if (status && status !== 'reviewing') return status;
    await new Promise(resolve => setTimeout(resolve, 1000));
  }
  return 'unknown';
}
const skillState = await waitForSkill();
console.log('Skill 审核后状态:', skillState);
if (skillState === 'reviewed') success('上线已审核 Skill', await request('/nacos/v3/admin/ai/skills/publish', { method: 'POST', token, params: { namespaceId: 'public', skillName, version: '1.0.0' } }));
const skill = await fetch(new URL(`/nacos/v3/client/ai/skills?${new URLSearchParams({ namespaceId: 'public', name: skillName, version: '1.0.0' })}`, base), { headers: { accessToken: token }, signal: AbortSignal.timeout(15000) });
assert.equal(skill.status, 200, `Skill 下载失败 HTTP ${skill.status}`);
const skillBytes = Buffer.from(await skill.arrayBuffer());
assert.equal(skillBytes.subarray(0, 2).toString(), 'PK');
assert.equal(skill.headers.get('x-nacos-skill-resolved-version'), '1.0.0');
const downloaded = join(dir, 'download.zip');
writeFileSync(downloaded, skillBytes);
const paths = execFileSync('unzip', ['-Z1', downloaded], { encoding: 'utf8' }).trim().split('\n');
const skillPath = paths.find(path => path === 'SKILL.md' || path === `${skillName}/SKILL.md`);
assert.ok(skillPath, '下载包缺少 SKILL.md');
const content = execFileSync('unzip', ['-p', downloaded, skillPath], { encoding: 'utf8' });
assert.match(content, /读取测试事实/);
console.log(`PASS 按版本下载 Skill ZIP (${skillBytes.length} 字节)`);
const definition = validateSkillContent({ content });
assert.ok(definition.valid && definition.metadata && definition.instructions, `Mastra Skill 校验失败: ${definition.errors.join('；')}`);
const mastraSkill = createSkill({ name: definition.metadata.name, description: definition.metadata.description, instructions: definition.instructions });
assert.equal(mastraSkill.name, skillName);
console.log('PASS Nacos Skill 内容可装配为 Mastra 原生 Skill');
const deniedSkill = await fetch(new URL(`/nacos/v3/client/ai/skills?${new URLSearchParams({ namespaceId: 'public', name: skillName, version: '1.0.0' })}`, base), { headers: { accessToken: limitedToken }, signal: AbortSignal.timeout(15000) });
assert.equal(deniedSkill.status, 403);
console.log('PASS 无授权用户无法下载 Skill');
const adapterConfig = { url: base, namespace: 'public', username: 'nacos', password, promptName, promptVersion: '1.0.0', skillName, skillVersion: '1.0.0' };
const snapshot = await loadNacosSnapshot(adapterConfig);
assert.equal(snapshot.prompt.content, 'fixture prompt version 1');
await verifyNacosAccess(adapterConfig, snapshot);
console.log('PASS 主线 Adapter 从真实 Nacos 冻结并复核 Prompt 和 Skill');
success('下线原 Prompt', await request('/nacos/v3/admin/ai/prompt/offline', { method: 'POST', token, params: { namespaceId: 'public', promptKey: promptName, version: '1.0.0' } }));
const offline = await request('/nacos/v3/client/ai/prompt', { token, params: { namespaceId: 'public', promptKey: promptName, version: '1.0.0' } });
assert.notEqual(offline.data?.data?.template, 'fixture prompt version 1');
await assert.rejects(verifyNacosAccess(adapterConfig, snapshot));
console.log(`PASS 下线后客户端和 Adapter 均拒绝读取 (HTTP ${offline.status})`);
console.log('测试资源名称：', promptName, skillName, mcpName);
