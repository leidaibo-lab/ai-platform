import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readModelConfig, resolveModelId } from '../src/mastra/config.js';

// 验证用户指定的三类模型及无角色默认值。
test('角色组使用指定模型，其他角色使用默认模型', () => {
  const config = readModelConfig({ MASTRA_MODEL: 'openai/gpt-5.6-sol', MASTRA_PRODUCT_MODEL: 'openai/gpt-6-luna', MASTRA_DEVELOPMENT_MODEL: 'openai/gpt-5.6-luna' });
  assert.equal(resolveModelId(config), 'openai/gpt-5.6-sol');
  assert.equal(resolveModelId(config, 'product'), 'openai/gpt-6-luna');
  assert.equal(resolveModelId(config, 'development'), 'openai/gpt-5.6-luna');
});

// 验证显式覆盖、清空覆盖及旧装配对象的兼容性。
test('环境覆盖优先，空覆盖和旧配置回退默认模型', () => {
  const config = readModelConfig({ MASTRA_MODEL: 'openai/custom', MASTRA_PRODUCT_MODEL: '', MASTRA_DEVELOPMENT_MODEL: 'openai/coder' });
  assert.equal(resolveModelId(config, 'product'), 'openai/custom');
  assert.equal(resolveModelId(config, 'development'), 'openai/coder');
  assert.equal(resolveModelId({ modelId: 'openai/legacy' }, 'development'), 'openai/legacy');
});

// 无效覆盖在装配前失败，不静默使用另一模型。
test('拒绝无效角色模型', () => {
  // 模拟不符合当前 OpenAI-compatible 配置契约的模型 ID。
  assert.throws(() => readModelConfig({ MASTRA_MODEL: 'openai/default', MASTRA_PRODUCT_MODEL: 'invalid' }));
});

// 缺省覆盖使用同一默认模型，真实模式缺少默认配置应及早报错。
test('角色未配置时回退，默认模型必填', () => {
  const config = readModelConfig({ MASTRA_MODEL: 'openai/default' });
  assert.equal(resolveModelId(config, 'product'), 'openai/default');
  assert.equal(resolveModelId(config, 'development'), 'openai/default');
  // 确认没有在解析层隐藏具体业务模型。
  assert.throws(() => readModelConfig({}));
});
