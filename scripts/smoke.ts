import assert from 'node:assert/strict';
import { createAgents } from '../src/mastra/agents/index.js';
import { readConfig } from '../src/mastra/config.js';

/** 验证一次原生 Agent/工具调用；失败不打印可能含凭据的上游异常对象。 */
async function main() {
  // 默认固定模式，不因本机 .env 的 live 配置意外产生真实模型调用。
  process.env.MASTRA_MODE = process.argv.includes('--live') ? 'live' : 'fixture';
  // 本脚本只检查最小模型工具链，显式关闭无关的 Nacos 产品资源。
  process.env.NACOS_RESOURCES_ENABLED = 'false';
  const config = readConfig();
  // 最小 Agent 不依赖团队 Run 的 threadId，专门验证原生工具循环和模型配置边界。
  const result = await createAgents(config, { workspace: false }).minimalAgent.generate('请调用 practiceInfo，然后说明本实践范围。', { maxSteps: 3 });
  assert.ok(result.text.trim(), '缺少模型终答');
  assert.ok(result.toolResults.length > 0, '未观察到实际工具执行');
  console.log(JSON.stringify({ mode: config.mode, text: result.text, toolResults: result.toolResults }, null, 2));
}
// 报告可操作的配置错误，其余失败仅提供类别，避免上游响应泄露秘密。
main().catch((error: unknown) => {
  console.error(error instanceof Error && error.message.startsWith('真实模型尚未配置') ? error.message : 'Mastra smoke 失败，请检查配置与本地测试。');
  process.exitCode = 1;
});
