import { createApplication } from '../src/mastra/app.js';
import { readConfig } from '../src/mastra/config.js';
import { exportProductArtifacts } from '../src/mastra/project-workspaces.js';
import { readProductDocument, ReviewPageError } from '../src/review-service.js';

/** 从原生快照补导出历史稿件，不触发生成、恢复或人工确认。 */
async function main(): Promise<void> {
  const [command, runId, extra] = process.argv.slice(2);
  if (command !== 'export-run' || !runId || extra) throw new Error('usage: workspace export-run <runId>');
  const app = createApplication(readConfig());
  try {
    await app.storage.init();
    const document = await readProductDocument(app, runId);
    if (!document.artifact) throw new Error('找不到可导出的产品稿');
    const bundle = await exportProductArtifacts(app.config, runId, {
      brief: document.brief, mode: document.mode, artifacts: [document.artifact], productWork: document.productWork,
    });
    console.log(JSON.stringify({ workspace: 'recruitment-artifacts', bundle, workflowChanged: false }, null, 2));
  } finally {
    await app.mastra.shutdown();
    await app.storage.close();
  }
}

// 不打印框架异常或包含凭据的配置对象。
main().catch((error: unknown) => {
  console.error(error instanceof ReviewPageError ? error.message : 'Workspace 导出未完成；用法：npm run workspace -- export-run <runId>，请核对数据目录、Run 和文件权限。');
  process.exitCode = 1;
});
