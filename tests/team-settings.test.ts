import { strict as assert } from 'node:assert';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { applyTeamModelSettings, readTeamSettings, writeTeamSettings } from '../src/mastra/team-settings.js';
import { teamConfigurationView } from '../src/intake/team-configuration-view.js';
import type { PracticeConfig } from '../src/mastra/config.js';

/** 验证默认、保存、重读和损坏输入均遵守单一设置来源。 */
test('团队配置持久化、校验和白名单视图', () => {
  const dir = mkdtempSync(join(tmpdir(), 'team-settings-'));
  try {
    const config: PracticeConfig = { rootDir: dir, mode: 'fixture', databaseUrl: `file:${join(dir, 'mastra.db')}`, port: 4111, modelId: 'openai/fixture', developmentContinuationLimit: 7, apiKey: 'secret-not-for-view' };
    assert.equal(readTeamSettings(config).developmentContinuationLimit, 7);
    assert.throws(() => writeTeamSettings(config, { version: 'team-settings.v1', developmentContinuationLimit: 73 }));
    assert.equal(readTeamSettings(config).developmentContinuationLimit, 7);
    writeTeamSettings(config, { version: 'team-settings.v1', developmentContinuationLimit: 3 });
    assert.equal(readTeamSettings(config).developmentContinuationLimit, 3);
    assert.doesNotMatch(JSON.stringify(teamConfigurationView(config)), /secret-not-for-view/);
    assert.equal(JSON.parse(readFileSync(join(dir, 'mastra.db.team-settings.json'), 'utf8')).developmentContinuationLimit, 3);
    writeFileSync(join(dir, 'mastra.db.team-settings.json'), '{invalid');
    assert.throws(() => readTeamSettings(config));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

/** 模型修改在进程重新装配时生效，并保留旧版设置兼容。 */
test('模型设置仅在重启装配时应用，拒绝非法标识', () => {
  const dir = mkdtempSync(join(tmpdir(), 'team-models-'));
  try {
    const config: PracticeConfig = { rootDir: dir, mode: 'live', databaseUrl: `file:${join(dir, 'mastra.db')}`, port: 4111, modelId: 'openai/old', roleModels: { development: 'openai/dev-old' }, developmentContinuationLimit: 4 };
    const models = { default: 'openai/new', product: null, development: 'openai/dev-new' };
    writeTeamSettings(config, { version: 'team-settings.v1', developmentContinuationLimit: 4, models });
    assert.equal(config.modelId, 'openai/old');
    assert.equal(applyTeamModelSettings(config).modelId, 'openai/new');
    assert.equal(applyTeamModelSettings(config).roleModels?.development, 'openai/dev-new');
    assert.equal(teamConfigurationView(config).models.active.default, 'openai/old');
    assert.equal(teamConfigurationView(config).models.pending.default, 'openai/new');
    assert.throws(() => writeTeamSettings(config, { version: 'team-settings.v1', developmentContinuationLimit: 4, models: { ...models, default: 'invalid' } }));
    assert.equal(readTeamSettings(config).models?.default, 'openai/new');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

/** 测试团队模型独立装配，旧配置仍沿用启动时默认模型。 */
test('测试团队模型独立于默认模型并兼容旧配置', () => {
  const dir = mkdtempSync(join(tmpdir(), 'team-testing-model-'));
  try {
    const config: PracticeConfig = { rootDir: dir, mode: 'live', databaseUrl: `file:${join(dir, 'mastra.db')}`, port: 4111, modelId: 'openai/old', roleModels: { product: 'openai/product' } };
    writeTeamSettings(config, { version: 'team-settings.v1', developmentContinuationLimit: 4, models: { default: 'openai/old', product: 'openai/product', development: null } });
    assert.equal(teamConfigurationView(config).models.pending.testing, 'openai/old');
    writeTeamSettings(config, { version: 'team-settings.v1', developmentContinuationLimit: 4, models: { default: 'openai/old', product: 'openai/product', development: 'openai/old', testing: 'openai/test' } });
    const applied = applyTeamModelSettings(config);
    assert.equal(applied.roleModels?.testing, 'openai/test');
    assert.equal(applied.roleModels?.product, 'openai/product');
    assert.equal(applied.roleModels?.development, 'openai/old');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
