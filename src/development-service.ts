/** 独立研发执行评测装配；正式业务入口由 productDevelopmentWorkflow 负责。 */
import { Mastra } from '@mastra/core';
import { LibSQLStore } from '@mastra/libsql';
import { existsSync, mkdirSync, writeFileSync, readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import type { PracticeConfig } from './mastra/config.js';
import { DevelopmentExecution } from './development-execution.js';
import { createDevelopmentWorkflow } from './mastra/workflows/development.js';
import { developmentHash, developmentInputSchema, developmentReviewSchema, developmentStateSchema, recoveryReviewSchema, validateDevelopmentIdentity, validateEvaluationSource, type DevelopmentInput } from './development/contracts.js';
import { developmentRecoveryHash, type DevelopmentGenerator } from './development/recovery.js';

/** 新目录只复制显式输入，不复制仓库、配置或环境文件。 */
export function seedDevelopment(directory: string, input: DevelopmentInput): void {
  mkdirSync(directory, { mode: 0o700 });
  const candidate = resolve(directory, 'candidate');
  mkdirSync(candidate);
  for (const [path, content] of Object.entries(input.project.files)) {
    const destination = resolve(candidate, path);
    mkdirSync(resolve(destination, '..'), { recursive: true });
    writeFileSync(destination, content, { flag: 'wx', mode: 0o600 });
  }
  writeFileSync(resolve(directory, 'input.json'), JSON.stringify(input, null, 2), { flag: 'wx', mode: 0o600 });
}

/** 每个目录持有独立原生Store；评测自动批准只能由专用入口显式开启。 */
export function openDevelopment(config: PracticeConfig, directory: string, evaluationPolicy = false, generate?: DevelopmentGenerator) {
  if (existsSync(resolve(directory, 'run.json'))) {
    const saved = JSON.parse(readFileSync(resolve(directory, 'run.json'), 'utf8'));
    if (saved.version !== undefined && saved.version !== 'development-execution') throw new Error('非v1 Run不能按旧流程恢复');
  }
  const input = developmentInputSchema.parse(JSON.parse(readFileSync(resolve(directory, 'input.json'), 'utf8')));
  if (evaluationPolicy) validateEvaluationSource(input);
  const execution = new DevelopmentExecution(resolve(directory, 'candidate'), input.project.writablePaths, input.project.checkFiles);
  const workflow = createDevelopmentWorkflow(config, execution, evaluationPolicy, generate);
  const storage = new LibSQLStore({ id: 'development-execution-store', url: `file:${resolve(directory, 'workflow.db')}` });
  const mastra = new Mastra({ workflows: { developmentWorkflow: workflow }, storage, logger: false });
  return { input, workflow, execution, storage, mastra, config, evaluationPolicy };
}
export type DevelopmentApplication = ReturnType<typeof openDevelopment>;

/** 投影原生状态，保留嵌套步骤供CLI审阅，不保存平行审批状态。 */
export async function developmentStatus(app: DevelopmentApplication, runId: string) {
  const snapshot = await app.workflow.getWorkflowRunById(runId);
  if (!snapshot) throw new Error('开发Run不存在');
  return { runId, status: snapshot.status, result: snapshot.result ? developmentStateSchema.parse(snapshot.result) : null, steps: snapshot.steps };
}

/** 校验后恢复原生子流程暂停点；旧hash不会消耗暂停状态。 */
export async function reviewDevelopment(app: DevelopmentApplication, runId: string, input: unknown) {
  const review = developmentReviewSchema.parse(input);
  const status = await developmentStatus(app, runId);
  if (status.status !== 'suspended') throw new Error('当前开发Run没有待确认方案');
  const pending = status.steps?.['development-iteration.approve-architecture'];
  if (!pending || Array.isArray(pending) || pending.status !== 'suspended' || pending.suspendPayload?.hash !== review.hash)
    throw new Error('技术方案版本不匹配');
  const state = developmentStateSchema.parse(pending.payload);
  validateDevelopmentIdentity(state, app.config);
  if (developmentHash(app.input) !== developmentHash(state.input)) throw new Error('开发输入或执行配置发生漂移');
  if (state.planSourceHash !== developmentHash(await app.execution.snapshot())) throw new Error('批准前源码发生漂移');
  const run = await app.workflow.createRun({ runId });
  return run.resume({ step: ['development-iteration', 'approve-architecture'], resumeData: review });
}

/** 只恢复原生安全暂停点；先核对输入/模式/源码，错误请求不会消耗暂停。 */
export async function recoverDevelopment(app: DevelopmentApplication, runId: string, input: unknown) {
  const review = recoveryReviewSchema.parse(input);
  const status = await developmentStatus(app, runId);
  const pending = status.steps?.['development-iteration.recover-development'];
  if (status.status !== 'suspended' || !pending || Array.isArray(pending) || pending.status !== 'suspended') throw new Error('当前Run没有可接续故障');
  const state = developmentStateSchema.parse(pending.payload);
  if (!state.recovery || state.recovery.hash !== review.hash || pending.suspendPayload?.hash !== review.hash) throw new Error('恢复版本不匹配');
  if (state.mode !== app.config.mode || developmentHash(app.input) !== developmentHash(state.input)) throw new Error('恢复输入或模式发生漂移');
  validateDevelopmentIdentity(state, app.config);
  const checkpointHash = developmentHash(await app.execution.snapshot());
  if (checkpointHash !== state.recovery.checkpointHash || developmentRecoveryHash(state, checkpointHash) !== review.hash) throw new Error('恢复检查点发生漂移');
  const run = await app.workflow.createRun({ runId });
  return run.resume({ step: ['development-iteration', 'recover-development'], resumeData: review });
}

/** 评测澄清只允许复用显式登记的合成输入，不创建独立产品批准路径。 */
export type DevelopmentRevision = { evaluationSource: DevelopmentInput['source'] };

/**
 * 澄清后创建带来源链的新目录，不迁移旧方案批准或覆盖旧Run。
 * 产品新版本从原生批准事实派生；范围沿用旧manifest，技术方案重新确认。
 */
export async function clarifyDevelopment(app: DevelopmentApplication, runId: string, directory: string, revision: DevelopmentRevision, reason: string): Promise<DevelopmentInput> {
  const status = await developmentStatus(app, runId);
  const state = status.result;
  if (status.status !== 'success' || state?.outcome !== 'clarification-required') throw new Error('只有已保存的需求澄清Run可创建后续版本');
  if (state.mode !== app.config.mode || developmentHash(app.input) !== developmentHash(state.input)) throw new Error('澄清输入或模式发生漂移');
  validateDevelopmentIdentity(state, app.config);
  const candidateHash = developmentHash(await app.execution.snapshot());
  if (candidateHash !== state.planSourceHash) throw new Error('澄清候选源码发生漂移');
  const files: Record<string, string> = {};
  for (const path of Object.keys(app.input.project.files)) files[path] = await app.execution.readFile(path);
  const project = { ...app.input.project, files };
  let source: DevelopmentInput['source'];
  if (!app.evaluationPolicy || state.input.source.kind !== 'evaluation' || revision.evaluationSource.kind !== 'evaluation' || revision.evaluationSource.evidence !== 'evaluation-input' || revision.evaluationSource.hash !== developmentHash(revision.evaluationSource.content)) throw new Error('仅评测组织者入口允许合成需求修订');
  source = revision.evaluationSource;
  if (source.hash === state.input.source.hash) throw new Error('澄清必须提供新的已确认需求版本');
  const input = developmentInputSchema.parse({ source, project, maxReworks: state.input.maxReworks,
    continuation: { runId, sourceHash: state.input.source.hash, candidateHash, reason, authority: 'evaluation-revision' } });
  seedDevelopment(directory, input);
  return input;
}

/** 复制普通源码供外部评测，拒绝链接与特殊文件。 */
export function candidateSources(directory: string): Record<string, string> {
  const result: Record<string, string> = {};
  /** 只遍历显式candidate/src，不跟随符号链接。 */
  function visit(current: string, prefix: string): void {
    for (const item of readdirSync(current, { withFileTypes: true })) {
      const path = `${prefix}${item.name}`;
      if (item.isSymbolicLink()) throw new Error('候选源码包含符号链接');
      if (item.isDirectory()) visit(resolve(current, item.name), path + '/');
      else if (item.isFile() && path.endsWith('.mjs')) result[path] = readFileSync(resolve(current, item.name), 'utf8');
    }
  }
  visit(resolve(directory, 'candidate/src'), 'src/');
  return result;
}
