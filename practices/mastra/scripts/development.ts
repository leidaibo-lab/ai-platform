/** 开发阶段独立CLI，方案批准后执行，交付后结束；不自动启动测试阶段。 */
import { parseArgs } from 'node:util';
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { relative, resolve } from 'node:path';
import { readConfig } from '../src/mastra/config.js';
import { createApplication } from '../src/mastra/app.js';
import { approvedInputV2, clarifyDevelopmentV2, developmentStatusV2, openDevelopmentV2, readDevelopmentLocator, recoverDevelopmentV2, reviewDevelopmentV2, resolveDevelopmentFindingsV2, runLocatorSchema } from '../src/development-v2-service.js';
import { approvedDevelopmentInput, clarifyDevelopment, developmentStatus, openDevelopment, recoverDevelopment, reviewDevelopment, seedDevelopment } from '../src/development-service.js';

/** 限制CLI运行目录，不允许任意仓库作为Agent执行环境。 */
function directory(root: string, value: string) {
  const path = resolve(root, value);
  const child = relative(resolve(root, '.data/development'), path);
  if (!child || child.startsWith('..') || child.startsWith('/')) throw new Error('开发目录须在.data/development/下');
  return path;
}
/** 人工命令只记录本地标签，不将其描述为认证身份。 */
async function main(): Promise<void> {
  const { values, positionals } = parseArgs({ allowPositionals: true, options: { dir: { type: 'string' }, from: { type: 'string' }, product: { type: 'string' }, manifest: { type: 'string' }, hash: { type: 'string' }, decision: { type: 'string' }, reviewer: { type: 'string' }, comment: { type: 'string' }, workflow: { type: 'string' }, 'product-workflow': { type: 'string' }, resolutions: { type: 'string' } } });
  const config = readConfig();
  if (!values.dir) throw new Error('缺少--dir');
  const path = directory(config.rootDir, values.dir);
  const version = positionals[0] === 'start'
    ? runLocatorSchema.shape.version.parse(values.workflow ?? 'development-execution-v2')
    : readDevelopmentLocator(positionals[0] === 'clarify' ? directory(config.rootDir, values.from ?? '') : path).version;
  if (values.workflow && values.workflow !== version) throw new Error('不能更换已保存Workflow版本');
  if (positionals[0] === 'start') {
    if (!values.product || !values.manifest) throw new Error('缺少产品Run或项目manifest');
    const app = createApplication(config);
    try {
      await app.storage.init();
      const project = JSON.parse(readFileSync(resolve(config.rootDir, values.manifest), 'utf8'));
      const input = version === 'development-execution-v2'
        ? await approvedInputV2(app, values.product, project, values['product-workflow'] ?? 'product-delivery-v2')
        : await approvedDevelopmentInput(app, values.product, project);
      mkdirSync(resolve(path, '..'), { recursive: true });
      seedDevelopment(path, input);
    } finally { await app.storage.close(); }
  }
  if (positionals[0] === 'clarify') {
    if (!values.from || !values.product || !values.comment) throw new Error('澄清需--from、已批准的新--product及--comment');
    const previousPath = directory(config.rootDir, values.from);
    const saved = readDevelopmentLocator(previousPath);
    if (saved.mode !== config.mode) throw new Error('不能跨模式澄清');
    if (version === 'development-execution-v2') {
      const previous = openDevelopmentV2(config, previousPath);
      const product = createApplication(config);
      try {
        await previous.storage.init(); await product.storage.init();
        mkdirSync(resolve(path, '..'), { recursive: true });
        await clarifyDevelopmentV2(previous, saved.runId, path, product, values.product, values.comment, values['product-workflow']);
      } finally { await previous.execution.close(); await previous.storage.close(); await product.storage.close(); }
    } else {
      const previous = openDevelopment(config, previousPath);
      const product = createApplication(config);
      try {
        await previous.storage.init();
        await product.storage.init();
        mkdirSync(resolve(path, '..'), { recursive: true });
        await clarifyDevelopment(previous, saved.runId, path, { productApp: product, productRunId: values.product }, values.comment);
      } finally { await previous.execution.close(); await previous.storage.close(); await product.storage.close(); }
    }
  }
  if (version === 'development-execution-v2') {
    const app = openDevelopmentV2(config, path);
    try {
      await app.storage.init();
      let runId: string;
      if (positionals[0] === 'start' || positionals[0] === 'clarify') {
        const run = await app.workflow.createRun(); runId = run.runId;
        writeFileSync(resolve(path, 'run.json'), JSON.stringify({ runId, mode: config.mode, version }), { flag: 'wx', mode: 0o600 });
        await run.start({ inputData: app.input });
      } else {
        const saved = readDevelopmentLocator(path);
        if (saved.mode !== config.mode) throw new Error('不能跨模式恢复');
        runId = saved.runId;
        const review = { hash: values.hash, decision: values.decision, reviewer: values.reviewer, comment: values.comment };
        if (positionals[0] === 'resolve') {
          if (!values.resolutions) throw new Error('发现裁决需要--resolutions JSON文件');
          await resolveDevelopmentFindingsV2(app, runId, { ...review, decisions: JSON.parse(readFileSync(resolve(config.rootDir, values.resolutions), 'utf8')) });
        } else if (positionals[0] === 'review') await reviewDevelopmentV2(app, runId, review);
        else if (positionals[0] === 'recover') await recoverDevelopmentV2(app, runId, review);
        else if (positionals[0] !== 'status') throw new Error('仅支持start/status/review/resolve/clarify/recover');
      }
      const status = await developmentStatusV2(app, runId);
      console.log(JSON.stringify(status, null, 2));
      if (status.status === 'failed') process.exitCode = 1;
      if (status.result?.delivery) writeFileSync(resolve(path, 'delivery.json'), JSON.stringify(status.result.delivery, null, 2), { mode: 0o600 });
    } finally { await app.execution.close(); await app.storage.close(); }
    return;
  }
  const app = openDevelopment(config, path);
  try {
    await app.storage.init();
    let runId: string;
    if (positionals[0] === 'start' || positionals[0] === 'clarify') {
      const run = await app.workflow.createRun();
      runId = run.runId;
      writeFileSync(resolve(path, 'run.json'), JSON.stringify({ runId, mode: config.mode, version }), { flag: 'wx', mode: 0o600 });
      await run.start({ inputData: app.input });
    } else {
      const saved = readDevelopmentLocator(path);
      if (saved.mode !== config.mode) throw new Error('不能跨模式恢复');
      runId = saved.runId;
      if (positionals[0] === 'review') await reviewDevelopment(app, runId, { hash: values.hash, decision: values.decision, reviewer: values.reviewer, comment: values.comment });
      else if (positionals[0] === 'recover') await recoverDevelopment(app, runId, { hash: values.hash, decision: values.decision, reviewer: values.reviewer, comment: values.comment });
      else if (positionals[0] !== 'status') throw new Error('仅支持start/status/review/clarify/recover');
    }
    const status = await developmentStatus(app, runId);
    console.log(JSON.stringify(status, null, 2));
    if (status.result?.delivery) writeFileSync(resolve(path, 'delivery.json'), JSON.stringify(status.result.delivery, null, 2), { mode: 0o600 });
  } finally { await app.execution.close(); await app.storage.close(); }
}
// 不打印原始provider异常、配置或凭据。
main().catch(() => { console.error('开发命令未完成；请检查批准版本、运行目录和已保存状态。'); process.exitCode = 1; });
