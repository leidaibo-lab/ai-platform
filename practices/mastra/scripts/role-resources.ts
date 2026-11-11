/** 原生角色资源管理CLI；只使用独立实践Store，不操作业务Run与审批。 */
import { readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname, resolve } from 'node:path';
import { createPrivateKey, randomUUID, sign } from 'node:crypto';
import { LibSQLStore } from '@mastra/libsql';
import { LocalSkillSource, publishSkillFromSource } from '@mastra/core/workspace';
import { readConfig } from '../src/mastra/config.js';
import { createAgents } from '../src/mastra/agents/index.js';
import { ensureRoleCatalog, validateRoleTools } from '../src/resources/catalog.js';
import { publishRole, resolveRole, roleConfigSchema } from '../src/resources/native-store.js';
import { captureArtifact } from '../src/resources/artifact.js';
import { canonical, ResourceError } from '../src/resources/contracts.js';

/** 签名在发布端执行；私钥不进入应用环境、原生Store或输出。 */
async function main() {
  const [command, first, second, third] = process.argv.slice(2);
  if (command === 'sign') {
    if (!first || !second || !third) throw new Error('用法：sign <制品根目录> <Ed25519私钥文件> <新清单文件>');
    const key = createPrivateKey(readFileSync(resolve(second)));
    if (key.asymmetricKeyType !== 'ed25519') throw new ResourceError('SIGNATURE_INVALID');
    const manifest = captureArtifact(resolve(first), true);
    const signature = sign(null, Buffer.from(canonical(manifest)), key).toString('base64');
    writeFileSync(resolve(third), JSON.stringify({ manifest, signature }), { flag: 'wx', mode: 0o600 });
    console.log('可信制品清单已生成'); return;
  }
  const config = readConfig(); const storage = new LibSQLStore({ id: 'role-resource-management', url: config.databaseUrl });
  await storage.init();
  try {
    if (command === 'init') console.log(JSON.stringify(await ensureRoleCatalog(storage, config, createAgents(config)), null, 2));
    else if (command === 'show' && first) {
      const domain = await storage.getStore('agents'); const entity = await domain?.getById(first);
      const versionId = second ?? entity?.activeVersionId;
      if (!versionId) throw new ResourceError('VERSION_MISSING');
      console.log(JSON.stringify((await resolveRole(storage, first, versionId)).config, null, 2));
    } else if (command === 'publish-agent' && first && second) {
      const candidate = roleConfigSchema.parse(JSON.parse(readFileSync(resolve(second), 'utf8')));
      if (!first.startsWith('role-')) throw new ResourceError('ROLE_UNKNOWN');
      await validateRoleTools(first.slice(5), candidate, createAgents(config), config.rootDir);
      console.log(JSON.stringify(await publishRole(storage, first, candidate)));
    } else if (command === 'publish-skill' && first && second) {
      const path = resolve(second); const blobs = await storage.getStore('blobs'); const skills = await storage.getStore('skills');
      if (!blobs || !skills) throw new ResourceError('STORE_UNAVAILABLE');
      const source = await publishSkillFromSource(new LocalSkillSource({ basePath: dirname(path) }), basename(path), blobs);
      const existing = await skills.getById(first);
      let versionId: string;
      if (!existing) {
        await skills.create({ skill: { id: first, ...source.snapshot, tree: source.tree } });
        versionId = (await skills.getLatestVersion(first))!.id;
      } else {
        const latest = await skills.getLatestVersion(first); versionId = randomUUID();
        await skills.createVersion({ ...source.snapshot, tree: source.tree, id: versionId, skillId: first, versionNumber: (latest?.versionNumber ?? 0) + 1 });
      }
      await skills.update({ id: first, activeVersionId: versionId, status: 'published' });
      console.log(JSON.stringify({ skillId: first, pin: versionId }));
    } else throw new Error('用法：init | show <agentId> [versionId] | publish-agent <agentId> <JSON文件> | publish-skill <skillId> <Skill目录> | sign <根目录> <私钥文件> <新清单文件>');
  } finally { await storage.close(); }
}
await main();
