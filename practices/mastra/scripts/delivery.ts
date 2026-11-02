import { createApplication } from '../src/mastra/app.js';
import { readConfig } from '../src/mastra/config.js';
import { deliveryStatus, startDelivery, reviewDelivery } from '../src/delivery-service.js';

/** 独立 CLI 每次重新装配应用，直接从 Mastra 数据库恢复人工交接点。 */
async function main() {
  const [command, target, role, artifactHash, decision, reviewer, comment] = process.argv.slice(2);
  if (!['start', 'status', 'review'].includes(command ?? '') || !target) {
    throw new Error('usage: delivery start <需求> | status <runId> | review <runId> <role> <hash> <approve|reject> <reviewer> <comment>');
  }
  const app = createApplication(readConfig());
  try {
    await app.storage.init();
    const result = command === 'start' ? await startDelivery(app, target)
      : command === 'status' ? await deliveryStatus(app, target)
        : await reviewDelivery(app, target, { role, artifactHash, decision, reviewer, comment });
    console.log(JSON.stringify(result, null, 2));
    if (result.status === 'failed') process.exitCode = 1;
  } finally {
    await app.storage.close();
  }
}
// 只输出已知的本地输入错误；不打印模型响应、请求对象或完整堆栈。
main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : '';
  const allowed = ['usage:', '真实模型尚未配置', '审批角色', '交接物版本', '当前 Run', '找不到'];
  // 仅放行固定本地错误前缀，其他异常使用统一脱敏提示。
  console.error(allowed.some((prefix) => message.startsWith(prefix)) ? message : '交接操作失败，请检查输入或运行 npm test。');
  process.exitCode = 1;
});
