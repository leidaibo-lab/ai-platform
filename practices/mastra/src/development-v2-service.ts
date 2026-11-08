/** v2原生存储服务，版本路由与批准验证均在resume前执行。 */
import { Mastra } from '@mastra/core';
import { LibSQLStore } from '@mastra/libsql';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { z } from 'zod';
import type { PracticeConfig } from './mastra/config.js';
import { DevelopmentExecution } from './development-execution.js';
import { developmentHash, recoveryReviewSchema, validateEvaluationSource } from './development/contracts.js';
import { createDevelopmentWorkflowV2 } from './mastra/workflows/development-v2.js';
import { approvalV2Schema, findingsHashV2, findingsReviewSchema, inputV2Schema, productWorkflowIdSchema, recoveryHashV2, stateV2Schema, type StateV2 } from './development/v2/contracts.js';
import { applyRecoveryDecision } from './development/v2/recovery-policy.js';
import { applyFindingsReview, assertApprovalV2, validateIdentityV2 } from './development/v2/gates.js';
import { loadDevelopmentMethods } from './development/v2/methods.js';
import type { GeneratorV2 } from './development/v2/agents.js';
import { deliverySchema } from './mastra/workflows/delivery.js';
import type { DeliveryContext } from './delivery-service.js';
import type { ProductV2Context } from './product-delivery-v2-service.js';
import { productDeliveryV2Schema } from './mastra/workflows/product-delivery-v2.js';
import { seedDevelopment } from './development-service.js';

export const runLocatorSchema = z.object({ runId: z.string().min(1), mode: z.enum(['fixture', 'live']), version: z.enum(['development-execution', 'development-execution-v2']).default('development-execution') });

/** 旧缺省只映射v1；未知版本拒绝，run.json只作定位，不提供批准事实。 */
export function readDevelopmentLocator(directory: string) {
  return runLocatorSchema.parse(JSON.parse(readFileSync(resolve(directory, 'run.json'), 'utf8')));
}

/** 只从已注册的allowlist工作流读取真实批准，不能信任客户端传入的正文和hash。 */
export async function approvedInputV2(app: DeliveryContext & ProductV2Context, runId: string, project: unknown, workflowId: unknown = 'product-delivery-v2') {
  const id = productWorkflowIdSchema.parse(workflowId);
  const workflow = id === 'product-delivery-v2' ? app.productDeliveryV2 : app.deliveryWorkflow;
  const snapshot = await workflow.getWorkflowRunById(runId);
  const step = snapshot?.steps?.['review-product'];
  if (!step || Array.isArray(step) || step.status !== 'success') throw new Error('产品版本未在指定Workflow中批准');
  const state = deliverySchema.parse(step.output);
  const artifact = state.artifacts.find(
    // 原生批准引用必须对应唯一产品稿。
    (item) => item.stage === 'product',
  );
  const approved = artifact && state.reviews.some(
    // 人工批准绑定产物版本，不能用其他阶段意见替代。
    (review) => review.role === 'product' && review.decision === 'approve' && review.artifactHash === artifact.hash,
  );
  if (!artifact || !approved || state.mode !== app.config.mode) throw new Error('产品版本未在当前模式下批准');
  if (id === 'product-delivery-v2' && (snapshot?.status !== 'success' || productDeliveryV2Schema.parse(snapshot.result).outcome !== 'product-approved-for-development')) throw new Error('产品v2尚未保存研发交接终态');
  return inputV2Schema.parse({ source: { kind: 'approved-product', workflowId: id, runId, hash: artifact.hash, content: artifact.content, evidence: artifact.evidence }, project, maxReworks: 1 });
}

/** 按固定目录装配v2；输入文件只是启动参数，后续必须与原生payload核对。 */
export function openDevelopmentV2(config: PracticeConfig, directory: string, evaluationPolicy = false, generate?: GeneratorV2) {
  if (existsSync(resolve(directory, 'run.json')) && readDevelopmentLocator(directory).version !== 'development-execution-v2') throw new Error('旧Run不能按v2恢复');
  const input = inputV2Schema.parse(JSON.parse(readFileSync(resolve(directory, 'input.json'), 'utf8')));
  if (evaluationPolicy) validateEvaluationSource(input);
  const execution = new DevelopmentExecution(resolve(directory, 'candidate'), input.project.writablePaths, input.project.checkFiles);
  const workflow = createDevelopmentWorkflowV2(config, execution, evaluationPolicy, generate);
  const storage = new LibSQLStore({ id: 'development-v2-store', url: `file:${resolve(directory, 'workflow.db')}` });
  const mastra = new Mastra({ workflows: { developmentWorkflowV2: workflow }, storage, logger: false });
  return { config, input, execution, workflow, storage, mastra, evaluationPolicy, methodsHash: loadDevelopmentMethods(config.rootDir).hash };
}
export type ApplicationV2 = ReturnType<typeof openDevelopmentV2>;

/** 原生状态投影区分v1/v2，不把旧交付升级为已评审。 */
export async function developmentStatusV2(app: ApplicationV2, runId: string) {
  const snapshot = await app.workflow.getWorkflowRunById(runId);
  if (!snapshot) throw new Error('v2开发Run不存在');
  return { workflowId: 'development-execution-v2' as const, runId, status: snapshot.status, result: snapshot.result ? stateV2Schema.parse(snapshot.result) : null, steps: snapshot.steps };
}

/** 所有人工resume共用相同的身份、输入和源码绑定检查。 */
async function pendingV2(app: ApplicationV2, runId: string, step: string): Promise<StateV2> {
  const status = await developmentStatusV2(app, runId);
  const pending = status.steps?.[`development-iteration-v2.${step}`] ?? (step === 'recover-development' ? Object.values(status.steps ?? {}).find(/** 新图故障在原阶段暂停，恢复状态由原生暂停载荷持有。 */value => !Array.isArray(value) && value.status === 'suspended' && value.suspendPayload?.recoveryState) : undefined);
  if (status.status !== 'suspended' || !pending || Array.isArray(pending) || pending.status !== 'suspended') throw new Error('v2没有对应待审暂停点');
  const state = stateV2Schema.parse(pending.suspendPayload?.recoveryState ?? pending.payload);
  validateIdentityV2(state, app.config, app.methodsHash);
  if (developmentHash(state.input) !== developmentHash(app.input)) throw new Error('v2开发输入发生漂移');
  if (state.checkpointHash !== developmentHash(await app.execution.snapshot())) throw new Error('v2源码检查点漂移');
  return state;
}

/** 方案批准仅恢复当前包；错误hash不消耗暂停点。 */
export async function reviewDevelopmentV2(app: ApplicationV2, runId: string, input: unknown) {
  const review = approvalV2Schema.parse(input);
  const state = await pendingV2(app, runId, 'approve-architecture');
  assertApprovalV2(state);
  if (review.hash !== state.approvalHash || review.resolutions.length) throw new Error('v2批准包版本或处理记录不匹配');
  const run = await app.workflow.createRun({ runId });
  return run.resume({ step: ['development-iteration-v2', 'approve-architecture'], resumeData: review });
}

/** 只恢复捕获失败的阶段；检查点包含完成任务与已有评审事实。 */
export async function recoverDevelopmentV2(app: ApplicationV2, runId: string, input: unknown) {
  const review = recoveryReviewSchema.parse(input);
  const state = await pendingV2(app, runId, 'recover-development');
  if (!state.recovery || state.recovery.hash !== review.hash || recoveryHashV2(state) !== review.hash) throw new Error('v2恢复版本不匹配');
  applyRecoveryDecision(state, review);
  const run = await app.workflow.createRun({ runId });
  const status = await developmentStatusV2(app, runId);
  const path = Object.entries(status.steps ?? {}).find(/** 恢复当前实际暂停点，不让调用方指定任意阶段。 */([, value]) => !Array.isArray(value) && value.status === 'suspended' && (value.suspendPayload?.recoveryState || value.suspendPayload?.hash === review.hash))?.[0];
  if (!path) throw new Error('v2故障暂停点已变化');
  return run.resume({ step: path.split('.'), resumeData: review });
}

/** 澄清创建新输入/Run；只继承候选与来源关系，不复制旧批准或重置旧Run。 */
export async function clarifyDevelopmentV2(app: ApplicationV2, runId: string, directory: string, product: DeliveryContext & ProductV2Context, productRunId: string, reason: string, productWorkflowId: unknown = 'product-delivery-v2') {
  const status = await developmentStatusV2(app, runId);
  const state = status.result;
  if (status.status !== 'success' || state?.outcome !== 'clarification-required' || state.input.source.kind !== 'approved-product') throw new Error('v2只有已保存业务澄清Run可以创建后继');
  validateIdentityV2(state, app.config, app.methodsHash);
  if (developmentHash(app.input) !== developmentHash(state.input) || state.checkpointHash !== developmentHash(await app.execution.snapshot())) throw new Error('v2澄清输入或源码漂移');
  const files: Record<string, string> = {};
  for (const path of Object.keys(state.input.project.files)) files[path] = await app.execution.readFile(path);
  const input = await approvedInputV2(product, productRunId, { ...state.input.project, files }, productWorkflowId);
  if (input.source.hash === state.input.source.hash) throw new Error('澄清必须使用新的批准产品版本');
  const next = inputV2Schema.parse({ ...input, maxReworks: state.input.maxReworks, continuation: { runId, sourceHash: state.input.source.hash, candidateHash: state.checkpointHash, reason, authority: 'approved-product-version' } });
  seedDevelopment(directory, next);
  return next;
}

/** 原生发现裁决暂停点；先做同样的硬校验，非法处理不会消耗暂停。 */
export async function resolveDevelopmentFindingsV2(app: ApplicationV2, runId: string, input: unknown) {
  const review = findingsReviewSchema.parse(input);
  const status = await developmentStatusV2(app, runId);
  const name = status.steps?.['development-iteration-v2.resolve-readiness'];
  const step = name && !Array.isArray(name) && name.status === 'suspended' ? 'resolve-readiness' : 'resolve-findings';
  const state = await pendingV2(app, runId, step);
  if (review.hash !== findingsHashV2(state)) throw new Error('v2发现裁决版本不匹配');
  applyFindingsReview(state, review);
  const run = await app.workflow.createRun({ runId });
  return run.resume({ step: ['development-iteration-v2', step], resumeData: review });
}
