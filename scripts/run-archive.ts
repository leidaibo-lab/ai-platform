import { resolve } from 'node:path';
import { readConfig } from '../src/mastra/config.js';
import { syncRunArchive } from '../src/delivery/run-archive.js';
import { configureEngineeringProjects, snapshotProjectConfig } from '../src/business-engineering/project.js';
import { LibSQLStore } from '@mastra/libsql';
/** 补推本地档案，不启动模型、恢复Run或改变审批状态。 */
async function main(): Promise<void> {
  const [command, runId, extra] = process.argv.slice(2);
  if (command !== 'sync' || !runId || extra) throw new Error('invalid arguments');
  let config = configureEngineeringProjects(readConfig(), process.env);
  if (!config.engineeringProject && !config.engineeringProjects) config.hrmRepositoryRoot = resolve(process.env.MASTRA_HRM_REPOSITORY ?? resolve(config.rootDir, '../hrm'));
  const storage = new LibSQLStore({ id: 'run-archive-reader', url: config.databaseUrl });
  let result;
  try {
    const store = await storage.getStore('workflows');
    if (config.engineeringProjects) config = snapshotProjectConfig(config, await store!.loadWorkflowSnapshot({ workflowName: 'product-development', runId }));
    result = await syncRunArchive(config, runId);
  } finally { await storage.close(); }
  console.log(JSON.stringify({ runId, archiveSync: result, workflowChanged: false }));
  if (result !== 'synced') process.exitCode = 1;
}
/** 仅暴露固定指引，不打印Git输出或配置。 */
main().catch(() => {
  console.error('运行档案补推未完成；请核对Run、live模式、服务端项目登记、产品阶段同步开关及Git认证。用法：npm run run:archive -- sync <RunId>');
  process.exitCode = 1;
});
