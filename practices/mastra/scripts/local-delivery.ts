/** 无密钥本机示例入口；输出独占证据目录，失败以非零状态退出。 */
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runLocalExample } from '../examples/local-delivery/run.js';

const option = process.argv[2] ?? 'all';
if (!['all', 'success', 'health-failure'].includes(option) || process.argv.length > 3) throw new Error('用法：npm run example:local-delivery -- [all|success|health-failure]');
const parent = resolve(fileURLToPath(new URL('..', import.meta.url)), '.data/examples/local-delivery', new Date().toISOString().replace(/[:.]/g, '-'));
mkdirSync(parent, { recursive: true, mode: 0o700 });
try {
  for (const scenario of option === 'all' ? ['success', 'health-failure'] as const : [option as 'success' | 'health-failure']) {
    const directory = resolve(parent, scenario);
    const report = await runLocalExample(directory, scenario);
    console.log(JSON.stringify({ scenario, status: report.status, outcome: report.outcome, runId: report.runId, rollbackVerified: report.rollbackVerified, report: resolve(directory, 'report.json') }));
  }
} catch { console.error('本机闭环验证失败；证据目录：' + parent); process.exitCode = 1; }
