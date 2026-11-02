import assert from 'node:assert/strict';
import { createApplication } from '../src/mastra/app.js';
import { readConfig } from '../src/mastra/config.js';

/** 验证一次原生 Agent/工具调用；失败不打印可能含凭据的上游异常对象。 */
async function main() {
  if (process.argv.includes('--live')) process.env.MASTRA_MODE = 'live';
  const app = createApplication(readConfig());
  try {
    await app.storage.init();
    const result = await app.mastra.getAgent('minimalAgent').generate('请调用 practiceInfo，然后说明本实践范围。', { maxSteps: 3 });
    assert.ok(result.text.trim(), '缺少模型终答');
    assert.ok(result.toolResults.length > 0, '未观察到实际工具执行');
    console.log(JSON.stringify({ mode: app.config.mode, text: result.text, toolResults: result.toolResults }, null, 2));
  } finally {
    await app.storage.close();
  }
}
// 报告可操作的配置错误，其余失败仅提供类别，避免上游响应泄露秘密。
main().catch((error: unknown) => {
  console.error(error instanceof Error && error.message.startsWith('真实模型尚未配置') ? error.message : 'Mastra smoke 失败，请检查配置与本地测试。');
  process.exitCode = 1;
});
