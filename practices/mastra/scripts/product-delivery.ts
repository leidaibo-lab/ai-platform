/** 产品执行交接CLI；旧delivery命令保持提案语义。 */
import { createApplication } from '../src/mastra/app.js';
import { readConfig } from '../src/mastra/config.js';
import { productStatusV2, reviewProductV2, startProductV2 } from '../src/product-delivery-v2-service.js';

/** 每次重新装配同一原生存储，批准后只结束产品Run。 */
async function main(): Promise<void> {
  const [command, target, hash, decision, reviewer, comment] = process.argv.slice(2);
  if (!target || !['start', 'status', 'review'].includes(command)) throw new Error('仅支持start <需求> / status <runId> / review <runId> <hash> <approve|reject|rework> <reviewer> <comment>');
  const app = createApplication(readConfig());
  try {
    await app.storage.init();
    const result = command === 'start' ? await startProductV2(app, target) : command === 'status' ? await productStatusV2(app, target) : await reviewProductV2(app, target, { role: 'product', artifactHash: hash, decision, reviewer, comment });
    console.log(JSON.stringify(result, null, 2));
    if (result.status === 'failed') process.exitCode = 1;
  } finally { await app.storage.close(); }
}
// Provider错误统一脱敏，不打印配置和原始响应。
main().catch(() => { console.error('产品交接未完成；请核对命令、模式和当前产品版本。'); process.exitCode = 1; });
