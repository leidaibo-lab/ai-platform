/** 角色工作台回归：页面只是原生Agent版本的受控投影，不另存角色配置。 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { Mastra } from '@mastra/core';
import { createStudioApplicationOptions } from '../src/mastra/app.js';
import type { PracticeConfig } from '../src/mastra/config.js';
import { listRoleWorkbench, publishRoleWorkbench } from '../src/resources/workbench.js';

/** 用正式应用工厂启动独占Store，覆盖工作台与Run共用原生角色库存。 */
async function open(config: PracticeConfig) {
  const options = createStudioApplicationOptions(config);
  new Mastra(options);
  await options.storage.init();
  return { storage: options.storage, agents: options.agents };
}

test('角色工作台：发布只创建新的原生Agent版本，并拒绝陈旧或越权增强', /** 版本竞争不能覆盖已发布角色，也不能从页面添加新工具。 */ async () => {
  const directory = mkdtempSync(resolve(tmpdir(), 'role-workbench-'));
  const config: PracticeConfig = { rootDir: resolve('.'), mode: 'fixture', modelId: 'openai/fixture', port: 4111, databaseUrl: `file:${resolve(directory, 'run.db')}` };
  const app = await open(config);
  try {
    const before = await listRoleWorkbench(app.storage, config, app.agents);
    const role = before.roles.find(item => item.key === 'productAgent')!;
    const published = await publishRoleWorkbench(app.storage, config, app.agents, { agentId: role.agentId, baseVersionId: role.versionId, instructions: `${role.instructions}\n工作台增强说明`, model: { name: 'workbench-model', temperature: 0.3 }, tools: role.tools });
    assert.notEqual(published.versionId, role.versionId);
    const after = await listRoleWorkbench(app.storage, config, app.agents);
    const current = after.roles.find(item => item.agentId === role.agentId)!;
    assert.equal(current.versionId, published.versionId);
    assert.match(current.instructions, /工作台增强说明/);
    await assert.rejects(/** 陈旧页面不能覆盖新发布版本。 */() => publishRoleWorkbench(app.storage, config, app.agents, { agentId: role.agentId, baseVersionId: role.versionId, instructions: role.instructions, model: { name: role.model.name }, tools: role.tools }), /VERSION_CONFLICT/);
    await assert.rejects(/** 未登记工具不能随编辑请求进入Agent版本。 */() => publishRoleWorkbench(app.storage, config, app.agents, { agentId: role.agentId, baseVersionId: current.versionId, instructions: current.instructions, model: { name: current.model.name }, tools: [...current.tools, 'arbitraryShell'] }), /TOOL_UNKNOWN/);
  } finally { await app.storage.close(); rmSync(directory, { recursive: true, force: true }); }
});
