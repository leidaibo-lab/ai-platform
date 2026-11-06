/**
 * 固定产品流程的配对测量适配：复用原生 Workflow 与逐步回调，不另建执行或评分引擎。
 * 本模块只接收业务输入；人工量表在脚本的导出/汇总阶段读取，不能进入模型上下文。
 */
import { createHash } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { Mastra } from '@mastra/core';
import { LibSQLStore } from '@mastra/libsql';
import { z } from 'zod';
import { createAgents } from './mastra/agents/index.js';
import type { ProductRole } from './mastra/agents/product-roles.js';
import type { PracticeConfig } from './mastra/config.js';
import { createDeliveryWorkflow, deliverySchema } from './mastra/workflows/delivery.js';
import { startDelivery } from './delivery-service.js';

export const inputsSchema = z.object({
  version: z.string().min(1),
  cases: z.array(z.object({ id: z.string().regex(/^[a-z-]+$/), source: z.string(), brief: z.string().min(1).max(12000) })).min(1),
});
export type Variant = 'without-skills' | 'with-skills';

/** 只保存白名单计量字段；缺失 token 是 null，不能当作零或复制模型请求/响应头。 */
export interface MeasuredStep {
  role: ProductRole; actualModel: string | null; configuredModel: string | null; finishReason: string;
  inputTokens: number | null; outputTokens: number | null; cachedInputTokens: number | null;
  calls: { name: string; skill: string | null; returned: boolean }[];
}
export interface TrialResult {
  status: 'ready-for-review' | 'failed'; runId: string | null; elapsedMs: number;
  failure: string | null; steps: MeasuredStep[];
  artifact: string | null; productWork: z.infer<typeof deliverySchema>['productWork'] | null;
}

/** 两组共享采样、输出、重试和超时；与每角色 24 步的正式流程上限一起记录。 */
export const evaluationModelSettings = {
  temperature: 0, maxOutputTokens: 4096, maxRetries: 0, timeout: { totalMs: 180000, stepMs: 90000 },
} as const;

/** 输入、提示和方法清单使用同一字节散列方式，供组织者核对控制变量。 */
export function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

/** 未报告、负数或非数值用 null 标识，避免供应商不完整 usage 被计作免费。 */
function token(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
}

/**
 * 单样本单组使用独立 Store，沿同一正式入口执行到产品人工暂停点，不恢复批准。
 * config.databaseUrl 必须由评测脚本分配，不允许使用既有业务库；异常仅保留固定分类。
 */
export async function runProductSkillTrial(config: PracticeConfig, variant: Variant, brief: string): Promise<TrialResult> {
  const steps: MeasuredStep[] = [];
  const storage = new LibSQLStore({ id: 'product-skill-evaluation', url: config.databaseUrl });
  const agents = createAgents(config, {
    skillsEnabled: variant === 'with-skills',
    // 原生执行选项保持角色工厂和正式 Workflow 不变，只增加同样的计量与预算。
    execution: (role) => ({
      modelSettings: evaluationModelSettings,
      // 逐个模型步骤汇总 usage；禁止保存 request、headers、原始错误和 provider metadata。
      onStepFinish: (event) => {
        const calls: MeasuredStep['calls'] = [];
        for (const call of event.toolCalls ?? []) {
          const args = call.payload.args as Record<string, unknown> | undefined;
          const selected = call.payload.toolName === 'skill' ? args?.name : call.payload.toolName === 'skill_read' ? args?.skillName : undefined;
          calls.push({
            name: call.payload.toolName, skill: typeof selected === 'string' ? selected : null,
            // returned 仅表示有工具结果，不宣称方法已被正确理解或提升质量。
            returned: (event.toolResults ?? []).some((result) => result.payload.toolCallId === call.payload.toolCallId),
          });
        }
        steps.push({
          role, actualModel: event.response?.modelId ?? null, configuredModel: event.model?.modelId ?? null,
          finishReason: event.finishReason ?? 'unknown', inputTokens: token(event.usage?.inputTokens),
          outputTokens: token(event.usage?.outputTokens), cachedInputTokens: token(event.usage?.cachedInputTokens), calls,
        });
      },
    }),
  });
  const deliveryWorkflow = createDeliveryWorkflow(agents, config.mode);
  new Mastra({ agents, workflows: { deliveryWorkflow }, storage, logger: false });
  const started = performance.now();
  let runId: string | null = null;
  try {
    await storage.init();
    const status = await startDelivery({ config, deliveryWorkflow }, brief);
    runId = status.runId;
    const snapshot = await deliveryWorkflow.getWorkflowRunById(runId);
    const product = snapshot?.steps?.['draft-product'];
    const work = product && !Array.isArray(product) && product.output ? deliverySchema.parse(product.output).productWork ?? null : null;
    const ready = status.status === 'suspended' && status.pending?.role === 'product';
    return { status: ready ? 'ready-for-review' : 'failed', runId, elapsedMs: Math.round(performance.now() - started),
      failure: ready ? null : 'workflow-did-not-reach-product-review', steps, artifact: status.pending?.artifact.content ?? null, productWork: work };
  } catch {
    return { status: 'failed', runId, elapsedMs: Math.round(performance.now() - started),
      failure: 'workflow-or-model-error', steps, artifact: null, productWork: null };
  } finally {
    await storage.close();
  }
}

const criterionSchema = z.object({ id: z.string(), severity: z.enum(['critical', 'major', 'minor']), criterion: z.string() });
export const rubricSchema = z.object({ version: z.string(), cases: z.record(z.string(), z.array(criterionSchema).min(1)) });
export const reviewSchema = z.array(z.object({
  sampleId: z.string(), caseId: z.string(), reviewer: z.string().nullable(),
  firstPass: z.boolean().nullable(), reviewSeconds: z.number().positive().nullable(),
  coverage: z.array(z.object({ id: z.string(), status: z.enum(['met', 'missing', 'incorrect']).nullable(), evidence: z.string() })),
  additionalDefects: z.array(z.object({ severity: z.enum(['critical', 'major', 'minor']), description: z.string().min(1) })),
}));
export type HumanReview = z.infer<typeof reviewSchema>[number];

/** 单价只接受显式提供的 USD/百万 token 与来源；不按模型别名猜测上游实际报价。 */
export const pricingSchema = z.object({
  source: z.string().min(1), date: z.iso.date(),
  models: z.record(z.string(), z.object({ input: z.number().nonnegative(), cachedInput: z.number().nonnegative(), output: z.number().nonnegative() })),
});
export type Pricing = z.infer<typeof pricingSchema>;

/** 完整人工审阅需覆盖全部量表且附依据；缺项不算零遗漏或通过。 */
export function reviewed(review: HumanReview | undefined, rubric: z.infer<typeof criterionSchema>[]): boolean {
  if (!review || !review.reviewer?.trim() || review.firstPass === null || review.reviewSeconds === null) return false;
  if (review.coverage.length !== rubric.length || new Set(review.coverage.map(
    // 重复评分项不能伪装成完整覆盖。
    (item) => item.id,
  )).size !== rubric.length) return false;
  for (const expected of rubric) {
    const item = review.coverage.find(
      // 以固定量表 ID 关联人工依据，不能新增或漏掉项目。
      (candidate) => candidate.id === expected.id,
    );
    if (!item?.status || !item.evidence.trim()) return false;
    if (review.firstPass && item.status !== 'met' && expected.severity !== 'minor') return false;
  }
  if (review.firstPass && review.additionalDefects.some(
    // 首次放行不能同时存在未解决的严重缺陷。
    (item) => item.severity !== 'minor',
  )) return false;
  return true;
}

/** 只汇总已报告 token；失败或 usage 缺失时 total 与费用标为不完整，保留已知下界。 */
export function usage(result: TrialResult, pricing?: Pricing) {
  let reportedInput = 0;
  let reportedOutput = 0;
  let complete = result.status === 'ready-for-review' && result.steps.length > 0;
  let estimatedUsd: number | null = pricing ? 0 : null;
  const models = new Set<string>();
  let modelsComplete = result.steps.length > 0;
  for (const step of result.steps) {
    reportedInput += step.inputTokens ?? 0;
    reportedOutput += step.outputTokens ?? 0;
    complete &&= step.inputTokens !== null && step.outputTokens !== null;
    if (step.actualModel) models.add(step.actualModel);
    else modelsComplete = false;
    const price = step.actualModel ? pricing?.models[step.actualModel] : undefined;
    // 缓存量未知且有差异单价时不能给出看似精确的金额。
    if (!price || step.inputTokens === null || step.outputTokens === null || (step.cachedInputTokens === null && price.input !== price.cachedInput)) estimatedUsd = null;
    if (estimatedUsd !== null && price && step.inputTokens !== null && step.outputTokens !== null) {
      const cached = step.cachedInputTokens ?? 0;
      if (cached > step.inputTokens) estimatedUsd = null;
      else estimatedUsd += ((step.inputTokens - cached) * price.input + cached * price.cachedInput + step.outputTokens * price.output) / 1000000;
    }
  }
  return { reportedInput, reportedOutput, complete, totalTokens: complete ? reportedInput + reportedOutput : null,
    estimatedUsd: complete ? estimatedUsd : null, models: [...models].sort(), modelsComplete };
}

/** 计划条目在开始前创建；未开始和失败不会从分母与组织者记录中消失。 */
export interface TrialEntry {
  sampleId: string; pairId: string; caseId: string; variant: Variant; result: TrialResult | null;
}

/**
 * 人工指标只纳入填写完整且无冲突的首稿审阅，主比较只用双方均完整的配对。
 * 无实际模型信息、模型漂移、失败或待审时不计算配对差值；小样本不提供发布判定。
 */
export function summarize(entries: TrialEntry[], reviews: HumanReview[], rubric: z.infer<typeof rubricSchema>, pricing?: Pricing) {
  const reviewById = new Map<string, HumanReview>();
  for (const review of reviews) {
    if (reviewById.has(review.sampleId) || !entries.some(
      // 人工表必须属于当前运行，拒绝重复和跨案例拼接。
      (entry) => entry.sampleId === review.sampleId && entry.caseId === review.caseId,
    )) throw new Error('人工表存在重复或未知样本');
    reviewById.set(review.sampleId, review);
  }
  const measurements = entries.map(
    // 缺少生成结果和未审阅分别保留状态，不能隐式成为零值。
    (entry) => {
      const human = reviewById.get(entry.sampleId);
      const criteria = rubric.cases[entry.caseId];
      if (!criteria) throw new Error('案例缺少人工量表');
      const complete = entry.result?.status === 'ready-for-review' && reviewed(human, criteria);
      return { sampleId: entry.sampleId, pairId: entry.pairId, caseId: entry.caseId, variant: entry.variant,
        status: entry.result?.status ?? 'not-started', elapsedMs: entry.result?.elapsedMs ?? null,
        usage: entry.result ? usage(entry.result, pricing) : null, human: complete && human ? {
          firstPass: human.firstPass!, reviewSeconds: human.reviewSeconds!, criteria: criteria.length,
          // 遗漏与错误分别统计，不能把明确写错的规则算作已覆盖。
          missing: human.coverage.filter((item) => item.status === 'missing').length,
          // 错误规则与附加缺陷保留为独立质量信号。
          incorrect: human.coverage.filter((item) => item.status === 'incorrect').length,
          additionalDefects: human.additionalDefects.length,
        } : null };
    },
  );
  const groups = (['without-skills', 'with-skills'] as const).map(
    // 分组结果始终报告计划、生成失败、未开始与人工样本数。
    (variant) => {
      const items = measurements.filter(
        // 每个计划样本恰归属一组。
        (item) => item.variant === variant,
      );
      let ready = 0, failed = 0, evaluated = 0, passed = 0, missing = 0, incorrect = 0, criteria = 0, seconds = 0;
      let knownTokens = 0, cost: number | null = pricing ? 0 : null;
      let tokensComplete = true;
      for (const item of items) {
        if (item.status === 'ready-for-review') ready++;
        if (item.status === 'failed') failed++;
        knownTokens += (item.usage?.reportedInput ?? 0) + (item.usage?.reportedOutput ?? 0);
        tokensComplete &&= item.usage?.complete === true;
        if (item.usage?.estimatedUsd == null) cost = null;
        else if (cost !== null) cost += item.usage.estimatedUsd;
        if (!item.human) continue;
        evaluated++;
        passed += Number(item.human.firstPass); missing += item.human.missing; incorrect += item.human.incorrect;
        criteria += item.human.criteria; seconds += item.human.reviewSeconds;
      }
      return { variant, planned: items.length, ready, failed, notStarted: items.length - ready - failed,
        reviewed: evaluated, firstPassed: passed, firstPassRateAmongReviewed: evaluated ? passed / evaluated : null,
        missing: evaluated ? missing : null, incorrect: evaluated ? incorrect : null, checkedCriteria: criteria,
        omissionRate: criteria ? missing / criteria : null, meanReviewSeconds: evaluated ? seconds / evaluated : null,
        knownReportedTokens: knownTokens, totalTokens: tokensComplete ? knownTokens : null, estimatedUsd: cost };
    },
  );
  const pairs = [];
  for (const pairId of new Set(entries.map(
    // 配对标识包含案例和重复轮次。
    (entry) => entry.pairId,
  ))) {
    const a = measurements.find(
      // 基线始终是未挂载 Skill 的同一业务输入。
      (item) => item.pairId === pairId && item.variant === 'without-skills',
    );
    const b = measurements.find(
      // 实验组采用完整 Skill 包及调用指引。
      (item) => item.pairId === pairId && item.variant === 'with-skills',
    );
    const sameModel = a?.usage?.modelsComplete === true && b?.usage?.modelsComplete === true
      && a.usage.models.length === 1 && b.usage.models.length === 1 && a.usage.models[0] === b.usage.models[0];
    const generated = a?.status === 'ready-for-review' && b?.status === 'ready-for-review';
    const comparable = Boolean(sameModel && generated);
    pairs.push({ pairId, sameObservedModel: Boolean(sameModel), comparable,
      // 差值方向统一为 with - without；耗时、遗漏、成本下降为负，通过率提升为正。
      humanDelta: comparable && a?.human && b?.human ? {
        missing: b.human.missing - a.human.missing, incorrect: b.human.incorrect - a.human.incorrect,
        firstPass: Number(b.human.firstPass) - Number(a.human.firstPass), reviewSeconds: b.human.reviewSeconds - a.human.reviewSeconds,
      } : null,
      totalTokensDelta: comparable && a?.usage?.totalTokens != null && b?.usage?.totalTokens != null ? b.usage.totalTokens - a.usage.totalTokens : null,
      estimatedUsdDelta: comparable && a?.usage?.estimatedUsd != null && b?.usage?.estimatedUsd != null ? b.usage.estimatedUsd - a.usage.estimatedUsd : null,
    });
  }
  return { conclusion: 'observation-only; human review required; no release-quality claim', groups, pairs, measurements, pricing: pricing ?? null };
}
