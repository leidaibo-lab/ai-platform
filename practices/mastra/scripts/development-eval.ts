/** 研发能力pilot：预登记全计划，逐例落盘；隐藏答案只进入外部judge。 */
import { readFileSync, writeFileSync, mkdirSync, renameSync } from 'node:fs';
import { resolve, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { parseArgs } from 'node:util';
import { developmentCasesSchema, developmentOracleSchema, runDevelopmentTrial, summarizeDevelopment, type DevelopmentTrial } from '../src/development-evaluation.js';
import { developmentExecutionIdentity, developmentHash } from '../src/development/contracts.js';
import { readConfig } from '../src/mastra/config.js';
import { developmentInstructions } from '../src/development/agents.js';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
/** 原子保存，已执行结果即使后续失败也保留。 */
function save(path: string, value: unknown): void {
  writeFileSync(path + '.tmp', JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
  renameSync(path + '.tmp', path);
}
/** 输出必须是本实践忽略目录内的新子目录。 */
function outputPath(value: string): string {
  const path = resolve(root, value);
  const child = relative(resolve(root, '.data/evaluations'), path);
  if (!child || child.startsWith('..') || child.startsWith('/')) throw new Error('评测输出须为.data/evaluations/下子目录');
  return path;
}
/** CLI只调用已有配置加载器处理凭据，不读取或打印.env正文。 */
async function main(): Promise<void> {
  const { values } = parseArgs({ options: { live: { type: 'boolean', default: false }, cases: { type: 'string' }, rounds: { type: 'string', default: '2' }, concurrency: { type: 'string', default: '1' }, out: { type: 'string' }, report: { type: 'string' } } });
  if (values.report) {
    const directory = outputPath(values.report);
    const trials = JSON.parse(readFileSync(resolve(directory, 'trials.json'), 'utf8')) as DevelopmentTrial[];
    const summary = summarizeDevelopment(trials);
    save(resolve(directory, 'report.json'), summary);
    console.log(JSON.stringify({ directory, ...summary }, null, 2));
    return;
  }
  const assets = resolve(root, 'evaluations/development');
  const inputs = developmentCasesSchema.parse(JSON.parse(readFileSync(resolve(assets, 'inputs.json'), 'utf8')));
  const oracle = developmentOracleSchema.parse(JSON.parse(readFileSync(resolve(assets, 'oracle.json'), 'utf8')));
  const rounds = Number(values.rounds);
  if (!Number.isInteger(rounds) || rounds < 1 || rounds > 3) throw new Error('评测轮数为1–3');
  const concurrency = Number(values.concurrency);
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 4) throw new Error('并发为1–4');
  const ids = values.cases?.split(',') ?? inputs.cases.map(
    // 默认完整24例；显式子集在manifest登记，不能冒充完整pilot。
    (item) => item.id,
  );
  const cases = inputs.cases.filter(
    // 选择只依赖显式ID，不能按已有结果挑选成功案例。
    (item) => ids.includes(item.id),
  );
  if (cases.length !== ids.length || new Set(ids).size !== ids.length) throw new Error('未知或重复案例');
  for (const item of cases) if (!oracle.cases[item.id]) throw new Error('隐藏验收缺失');
  const directory = outputPath(values.out ?? `.data/evaluations/development-${new Date().toISOString().replaceAll(/[:.]/g, '-')}`);
  mkdirSync(resolve(directory, '..'), { recursive: true });
  mkdirSync(directory, { mode: 0o700 });
  process.env.MASTRA_MODE = values.live ? 'live' : 'fixture';
  process.env.MASTRA_DATA_DIR = resolve(directory, 'configuration');
  const config = readConfig();
  const trials: DevelopmentTrial[] = [];
  for (let round = 1; round <= rounds; round++) for (const item of cases) trials.push({ id: `${item.id}-r${round}`, caseId: item.id, expectedOutcome: item.expectedOutcome, round, mode: config.mode, status: 'not-started', runId: null, elapsedMs: null, failure: null, state: null, hidden: null,
    review: { reviewer: null, dimensions: { traceability: null, architecture: null, correctness: null, evidence: null, securityData: null, reviewability: null }, evidence: {}, hardFailures: [], highDefects: [] } });
  const sourceHashes: Record<string, string> = {};
  for (const path of ['src/development-evaluation.ts', 'src/development-service.ts', 'src/development-execution.ts', 'src/development/agents.ts', 'src/development/contracts.ts', 'src/development/recovery.ts', 'src/development/errors.ts', 'src/mastra/config.ts', 'src/mastra/workflows/development.ts', 'scripts/development-eval.ts', 'package-lock.json']) sourceHashes[path] = developmentHash(readFileSync(resolve(root, path), 'utf8'));
  save(resolve(directory, 'manifest.json'), { version: 'development-evaluation.v1', createdAt: new Date().toISOString(), mode: config.mode, requestedModel: config.modelId, executionIdentity: developmentExecutionIdentity(config), gitRevision: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(), nodeVersion: process.version, selectedCases: ids, rounds, inputHash: developmentHash(inputs), oracleHash: developmentHash(oracle), rubricHash: developmentHash(readFileSync(resolve(assets, 'rubric.json'), 'utf8')), sourceHashes, instructions: developmentInstructions, maxStepsPerRole: 12, maxAutomaticRetriesPerRole: 1, sdkRetries: 0, processorRetries: 0, manualRecoveryInBenchmark: false, concurrency, approval: 'evaluation-policy (not human approval)', scope: '离线Node函数切片；不是Next/Nest/PostgreSQL整栈质量结论' });
  save(resolve(directory, 'trials.json'), trials);
  console.log(JSON.stringify({ directory, planned: trials.length, mode: config.mode }));
  let nextIndex = 0;
  /** 有界工作池只并行独立目录，各次结果仍同步原子落盘。 */
  async function worker(): Promise<void> {
    while (nextIndex < trials.length) {
    const index = nextIndex++;
    const trial = trials[index];
    trial.status = 'running';
    save(resolve(directory, 'trials.json'), trials);
    const item = cases.find(
      // 完整输入来自冻结计划，不因失败改写需求。
      (candidate) => candidate.id === trial.caseId,
    )!;
    trials[index] = await runDevelopmentTrial(config, resolve(directory, trial.id), item, oracle.cases[item.id], trial);
    save(resolve(directory, 'trials.json'), trials);
    save(resolve(directory, 'report.json'), summarizeDevelopment(trials));
    const result = trials[index];
    console.log(JSON.stringify({ id: trial.id, status: result.status, outcome: result.state?.outcome ?? null, hidden: result.hidden?.passed ?? null, elapsedMs: result.elapsedMs }));
    }
  }
  await Promise.all(Array.from({ length: concurrency },
    // 每个worker共享有界索引，不共享Workflow/Store或候选目录。
    () => worker(),
  ));
  console.log(JSON.stringify(summarizeDevelopment(trials), null, 2));
}
// 仅报告固定错误类别，避免SDK原始错误意外输出请求凭据。
main().catch(() => { console.error('研发评测未完成；请检查已保存计划、案例结果及环境前提。'); process.exitCode = 1; });
